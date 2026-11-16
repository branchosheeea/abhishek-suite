import tempfile
import unittest
from pathlib import Path

from openpyxl import load_workbook

from generate_rh import (FIRST, create, monthly_hours, read_records, rollover,
                         save_new, sync, utilisation)


class Calculations(unittest.TestCase):
    def test_meter_cases(self):
        self.assertEqual(monthly_hours([100, 820, 1540, 1540, 1540, None, 1800]),
                         [720, 720, 0, 0, None, None])
        self.assertEqual(monthly_hours([100, 90, 'bad', -2, 10]), [-10, None, None, None])
        self.assertEqual(monthly_hours([0, 0, 1.5]), [0, 1.5])

    def test_continuous_and_low_use(self):
        self.assertIsNone(utilisation([720] * 12, 4))
        self.assertEqual(utilisation([720, 720, 720, 100, 100], 4), 'amber')
        self.assertIsNone(utilisation([720, 720, 720, 150, 150], 4))
        self.assertEqual(utilisation([200, 200, 200, 0, 0], 4), 'amber')

    def test_sporadic_zero(self):
        self.assertEqual(utilisation([10, 20, 30, 0, 0], 4), 'red')
        self.assertIsNone(utilisation([10, 20, 30, 0, 1], 4))
        self.assertIsNone(utilisation([0, 0, 0], 2))
        self.assertEqual(utilisation([0, 0, 0, 0, 0], 4), 'red')

    def test_history_excludes_missing_negative_and_future(self):
        self.assertIsNone(utilisation([720, None, -5, 0, 0], 4))
        self.assertIsNone(utilisation([720, 720, 720, None, 0], 4))
        self.assertIsNone(utilisation([720, 720, 720, -1, 0], 4))
        self.assertEqual(utilisation([20, 20, 20, 0, 0, 750, 750], 4), 'red')
        # A passage/port transition is a screening flag, not a compliance verdict.
        self.assertEqual(utilisation([740, 730, 720, 20, 30, 740], 4), 'amber')
        self.assertIsNone(utilisation([None, None, None, 10, 10, 0, 0], 6))


class Integrity(unittest.TestCase):
    def setUp(self):
        self.wb = create()
        self.ws = self.wb['RH_2026']
        for r in range(FIRST, self.ws.max_row + 1):
            for c in range(2, 15):
                self.ws.cell(r, c, 1000 * r + c)
        self.original = read_records(self.ws)

    def assert_readings_preserved(self):
        current = read_records(self.wb['RH_2026'])
        for ident, (_, readings) in self.original.items():
            self.assertEqual(current[ident][1], readings)

    def test_rename_sort_add_deactivate_delete(self):
        master = self.wb['Machinery_Master']
        master['A5'] = 'AAA Renamed Engine'
        master['B6'] = 'No'
        removed_id = master['C7'].value
        master.delete_rows(7)
        master.append(['ZZZ New Pump', 'Yes'])
        sync(self.wb, 2026)
        self.assert_readings_preserved()
        records = read_records(self.wb['RH_2026'])
        self.assertIn(removed_id, records)
        self.assertEqual(list(records.values())[-1], ('ZZZ New Pump', [None] * 13))
        names = [name for name, _ in records.values()]
        self.assertEqual(names, sorted(names, key=str.casefold))
        ws = self.wb['RH_2026']
        for r in range(FIRST, ws.max_row + 1):
            if ws.cell(r, 27).value == removed_id:
                self.assertTrue(ws.row_dimensions[r].hidden)
        # Repeated sync must be idempotent.
        sync(self.wb, 2026)
        self.assertEqual(records, read_records(self.wb['RH_2026']))

    def test_reactivate(self):
        master = self.wb['Machinery_Master']
        master['B5'] = 'No'
        sync(self.wb, 2026)
        master['B5'] = 'Yes'
        sync(self.wb, 2026)
        self.assert_readings_preserved()

    def test_duplicate_names_and_ids_rejected(self):
        master = self.wb['Machinery_Master']
        master['A6'] = '  main ENGINE  '
        with self.assertRaisesRegex(ValueError, 'Duplicate machinery'):
            sync(self.wb, 2026)
        master['A6'] = 'Unique name'
        master['C6'] = master['C5'].value
        with self.assertRaisesRegex(ValueError, 'ID'):
            sync(self.wb, 2026)

    def test_missing_operational_id_rejected(self):
        self.ws['AA5'] = None
        with self.assertRaisesRegex(ValueError, 'ID'):
            sync(self.wb, 2026)

    def test_rollover_preserves_source(self):
        old_formula = self.ws['O5'].value
        rollover(self.wb, 2026)
        self.assertEqual(read_records(self.wb['RH_2026']), self.original)
        self.assertEqual(self.ws['O5'].value, old_formula)
        for ident, (_, readings) in read_records(self.wb['RH_2027']).items():
            self.assertEqual(readings, [self.original[ident][1][-1]] + [None] * 12)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            rollover(self.wb, 2026)

    def test_roundtrip_formula_protection_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'test.xlsx'
            save_new(self.wb, path)
            loaded = load_workbook(path)
            self.assertEqual(read_records(loaded['RH_2026']), self.original)
            self.assertEqual(loaded['RH_2026']['O5'].value,
                '=IF(OR(B5="",C5=""),"",IF(AND(ISNUMBER(B5),ISNUMBER(C5)),IF(AND(B5>=0,C5>=0),C5-B5,"ERR"),"ERR"))')
            self.assertTrue(loaded['RH_2026']['O5'].protection.locked)
            self.assertFalse(loaded['RH_2026']['B5'].protection.locked)
            self.assertTrue(loaded['RH_2026'].protection.sheet)
            self.assertTrue(loaded.calculation.fullCalcOnLoad)
            self.assertEqual(loaded['Machinery_Master'].tables['tblMachinery'].ref, 'A4:C12')
            self.assertEqual(len(loaded['RH_2026'].conditional_formatting), 10)
            with self.assertRaises(FileExistsError):
                save_new(self.wb, path)


if __name__ == '__main__':
    unittest.main()
