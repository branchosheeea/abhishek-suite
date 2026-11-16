import json
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import calendar
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http.server import HTTPServer

from openpyxl import Workbook

from dashboard import Handler, analytics, change, initial, validate
from workbook_import import extract_workbook, merge_workbook


def make_workbook(machines, annual):
    workbook = Workbook()
    master = workbook.active
    master.title = 'Machinery_Master'
    master.append(['Machinery register'])
    master.append(['Instructions'])
    master.append(['IDs'])
    master.append(['Machinery Name', 'Include in RH', '_Machinery_ID'])
    for machine in machines:
        master.append([machine['name'], 'Yes' if machine['active'] else 'No', machine['id']])

    for year, records in annual.items():
        sheet = workbook.create_sheet(f'RH_{year}')
        sheet.append([f'Machinery running hours — {year}'])
        sheet.append(['Instructions'])
        sheet.append(['Screening only'])
        sheet.append(
            ['Machinery Name', f'Meter @ 31 Dec {int(year)-1}']
            + [f'{calendar.month_abbr[m]} meter' for m in range(1, 13)]
            + [f'{calendar.month_abbr[m]} RH' for m in range(1, 13)]
            + ['_Machinery_ID']
        )
        for machine, readings in records:
            sheet.append([machine['name'], *readings, *(['=1'] * 12), machine['id']])
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


class WorkbookImportTests(unittest.TestCase):
    def setUp(self):
        self.data = initial()
        self.existing = self.data['machines'][0]
        self.new = dict(id='workbook-machine-1', name='Bilge Pump', active=True)
        self.records = [
            (self.existing, [100, 100, None] + [None] * 10),
            (self.new, [None, 0, 100] + [None] * 10),
        ]
        self.content = make_workbook([self.existing, self.new], {'2026': self.records})

    def test_extract_meter_inputs_only_and_preserve_missing_zero(self):
        extracted = extract_workbook(self.content, 'Running Hours.xlsx')
        self.assertEqual(extracted['years']['2026'][self.existing['id']][:3], [100, 100, None])
        self.assertEqual(extracted['years']['2026'][self.new['id']][:3], [None, 0, 100])
        self.assertEqual(extracted['filename'], 'Running Hours.xlsx')

    def test_additive_merge_preserves_conflicts_and_tracks_source(self):
        existing_data = deepcopy(self.data)
        existing_data['years']['2026'][self.existing['id']][0] = 90
        existing_data['years']['2026'][self.existing['id']][1] = 100
        extracted = extract_workbook(self.content, 'Running Hours.xlsx')
        merged, summary = merge_workbook(existing_data, extracted)
        self.assertEqual(summary['new_values'], 2)
        self.assertEqual(summary['identical_values'], 1)
        self.assertEqual(summary['total_conflicts'], 1)
        self.assertEqual(merged['years']['2026'][self.existing['id']][0], 90)
        self.assertEqual(merged['years']['2026'][self.new['id']][:3], [None, 0, 100])
        self.assertTrue(merged['workbook_sources']['2026'][self.new['id']][1])
        validate(merged)
        self.assertEqual(analytics(merged)['2026'][self.new['id']]['hours'][:2], [None, 100])

    def test_invalid_meter_and_template_are_rejected(self):
        bad_records = [(self.existing, [-1] + [None] * 12)]
        bad = make_workbook([self.existing], {'2026': bad_records})
        with self.assertRaisesRegex(ValueError, 'Invalid meter'):
            extract_workbook(bad, 'bad.xlsx')
        with self.assertRaisesRegex(ValueError, 'annual .xlsx'):
            extract_workbook(self.content, 'report.xls')
        with self.assertRaisesRegex(ValueError, 'readable Excel'):
            extract_workbook(b'not excel', 'report.xlsx')

    def test_imported_reading_correction_requires_a_note(self):
        extracted = extract_workbook(self.content, 'Running Hours.xlsx')
        merged, _ = merge_workbook(self.data, extracted)
        with self.assertRaisesRegex(ValueError, 'correction note'):
            change(merged, dict(type='monthly_entry', year='2026', month=0, engineer='Engineer',
                                entries=[dict(id=self.new['id'], begin=None, end=1, note='')]))
        corrected = change(merged, dict(type='monthly_entry', year='2026', month=0, engineer='Engineer',
                                        entries=[dict(id=self.new['id'], begin=None, end=1,
                                                      note='Corrected against signed log')]))
        validate(corrected)

    def test_http_preview_and_import_are_two_phase_and_back_up(self):
        with self.subTest('upload endpoint'):
            with self._server() as (base, root):
                headers = {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'X-Workbook-Name': 'Running%20Hours.xlsx',
                    'X-Data-Revision': '0',
                }
                request = Request(base + '/api/workbook-preview', data=self.content, headers=headers)
                with urlopen(request) as response:
                    preview = json.load(response)
                self.assertEqual(preview['preview']['new_values'], 4)
                self.assertEqual(json.loads((root / 'data.json').read_text())['revision'], 0)

                apply_headers = dict(headers, **{'X-Workbook-Fingerprint': preview['fingerprint']})
                request = Request(base + '/api/workbook-import', data=self.content, headers=apply_headers)
                with urlopen(request) as response:
                    applied = json.load(response)
                self.assertEqual(applied['data']['revision'], 1)
                self.assertEqual(len(list((root / 'dashboard_backups').glob('*.json'))), 1)

    def _server(self):
        test = self

        class RunningServer:
            def __enter__(self):
                self.tempdir = tempfile.TemporaryDirectory()
                test.addCleanup(self.tempdir.cleanup)
                root = Path(self.tempdir.name)
                self.data_patch = patch('dashboard.DATA', root / 'data.json')
                self.root_patch = patch('dashboard.ROOT', root)
                self.data_patch.start()
                self.root_patch.start()
                test.addCleanup(self.data_patch.stop)
                test.addCleanup(self.root_patch.stop)
                (root / 'data.json').write_text(json.dumps(initial()), encoding='utf-8')
                self.server = HTTPServer(('127.0.0.1', 0), Handler)
                self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
                self.worker.start()
                return f'http://127.0.0.1:{self.server.server_port}', root

            def __exit__(self, *_):
                self.server.shutdown()
                self.server.server_close()
                self.worker.join()

        return RunningServer()


if __name__ == '__main__':
    unittest.main()
