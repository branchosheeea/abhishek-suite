"""Lub Oil import recovery (audit item P1-2): failed files can be read again, a re-read sheet that no longer passes is
taken out of use, and vessel names written differently in sheets can be mapped to a fleet vessel. Temporary folders."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from lube_oil import repository as repository_module
from lube_oil.parser import VERSION
from lube_oil.repository import Repository
from suite_services.database import connection
from tests.test_lube_oil_review import create_report

REAL_PARSE = repository_module.parse_workbook


def broken_parse(*_args, **_kwargs):
    raise ValueError("Unrecognised layout (simulated parser fault)")


def with_vessel(path, vessel):
    workbook = load_workbook(path)
    workbook.active["B1"] = vessel
    workbook.save(path)
    workbook.close()


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = Repository(self.root / "runtime")
        self.sheet = self.root / "january.xlsx"
        create_report(self.sheet)

    def tearDown(self):
        self.temp.cleanup()

    def test_corrected_date_is_a_new_import_and_duplicate_identifies_original(self):
        path = self.root / "DHT COLT NOVEMBER 2026.xlsx"
        create_report(path, reporting_date="25 NOVEMBER 2025")
        original = self.repo.import_file(path)
        self.assertIn("Filename suggests 2026-11", original["detail"])
        duplicate = self.repo.import_file(path)
        self.assertEqual(duplicate["status"], "Duplicate")
        self.assertEqual(duplicate["report_id"], original["report_id"])
        workbook = load_workbook(path)
        workbook.active["B2"] = "25 NOVEMBER 2026"
        workbook.save(path)
        workbook.close()
        corrected = self.repo.import_file(path)
        self.assertEqual(corrected["status"], "Imported")
        self.assertNotEqual(corrected["report_id"], original["report_id"])
        report = next(r for r in self.repo.reports() if r["id"] == corrected["report_id"])
        self.assertEqual(report["month"], "2026-11")
        self.assertFalse(any(i["code"] == "filename_period_mismatch" for i in report["data"]["issues"]))

    def test_import_refresh_selects_uploaded_report_instead_of_previous_month(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from lube_oil.ui import ReviewApp

        old = dict(id=24, month="2025-12", vessel="DHT LEOPARD", data={})
        new = dict(id=57, month="2025-11", vessel="DHT LEOPARD", data={})
        app = SimpleNamespace(
            vessel=Mock(), repo=Mock(), report_id=24, analysis_month="2025-12",
            change_vessel=Mock(),
        )
        app.vessel.get.return_value = "DHT LEOPARD"
        app.repo.reports.return_value = [old, new]
        ReviewApp.refresh(app, [dict(report_id=57, status="Imported")])
        self.assertEqual(app.report_id, 57)
        self.assertEqual(app.analysis_month, "2025-11")
        ReviewApp.refresh(app, [dict(status="Failed")])
        self.assertEqual(app.report_id, 57)

    def test_a_file_that_failed_can_be_imported_again(self):
        with patch.object(repository_module, "parse_workbook", broken_parse):
            self.assertEqual(self.repo.import_file(self.sheet)["status"], "Failed")
        self.assertEqual(len(self.repo.failures()), 1)
        again = self.repo.import_file(self.sheet)
        self.assertEqual(again["status"], "Imported", "before the fix this returned Duplicate for ever")
        self.assertIn("read again", again["detail"])
        self.assertEqual(self.repo.failures(), [], "no longer listed as needing attention")
        self.assertEqual(self.repo.import_file(self.sheet)["status"], "Duplicate", "a file that imported stays a duplicate")

    def test_a_failure_part_way_leaves_no_half_written_sheet(self):
        with patch.object(Repository, "_activate", side_effect=RuntimeError("simulated fault while activating")):
            self.assertEqual(self.repo.import_file(self.sheet)["status"], "Failed")
        self.assertEqual(self.repo.reports(), [])
        self.assertEqual(self.repo.import_file(self.sheet)["status"], "Imported")

    def test_files_that_failed_under_an_earlier_parser_are_read_again_at_start_up(self):
        with patch.object(repository_module, "parse_workbook", broken_parse):
            self.repo.import_file(self.sheet)
        self.assertEqual(self.repo.retry_failed_imports(), [], "same parser: not retried")
        with connection(self.repo.root) as db, db:
            db.execute("UPDATE processing_runs SET parser_version='0.9.0'")
        results = self.repo.retry_failed_imports()
        self.assertEqual([r["status"] for r in results], ["Imported"])
        self.assertTrue(self.repo.reports()[0]["is_active"])
        self.assertEqual(self.repo.failures(), [])
        self.assertEqual(self.repo.retry_failed_imports(), [])

    def test_a_sheet_in_use_that_fails_after_a_re_read_is_taken_out_of_use(self):
        self.repo.import_file(self.sheet)
        report = self.repo.reports()[0]
        self.assertTrue(report["is_active"])

        def failing_parse(path, name):
            payload = REAL_PARSE(path, name)
            payload["issues"].append(dict(code="anchor:x", title="Inventory row needs review", detail="", fields=[], severity="FAIL"))
            payload["validation_status"] = "FAIL"
            return payload

        with patch.object(repository_module, "parse_workbook", failing_parse):
            self.assertEqual(self.repo.reprocess_stale_reports(report_ids=[report["id"]]), 1)
        self.repo.activate_imported()
        after = self.repo.reports()[0]
        self.assertFalse(after["is_active"], "before the fix a failing sheet stayed in use")
        self.assertEqual(after["validation_status"], "FAIL")
        self.assertTrue(any(e["action"] == "withdrawn" for e in self.repo.audit(report["id"])))

    def test_a_vessel_name_written_differently_can_be_mapped(self):
        with_vessel(self.sheet, "M/T  dht colt")
        result = self.repo.import_file(self.sheet)
        self.assertEqual(result["status"], "Not usable")
        report = self.repo.reports()[0]
        self.assertIsNone(report["vessel_id"])
        self.assertTrue(any(i["code"] == "vessel_unknown" for i in report["data"]["issues"]))

        self.assertIn("DHT COLT", self.repo.vessel_names())
        self.assertEqual(self.repo.map_vessel_alias(report["data"]["vessel"], "DHT COLT"), 1)
        mapped = self.repo.reports()[0]
        self.assertEqual(mapped["vessel"], "DHT COLT")
        self.assertTrue(mapped["is_active"])
        self.assertFalse(any(i["code"] == "vessel_unknown" for i in mapped["data"]["issues"]))
        self.assertTrue(any(a["record_key"] == "M/T DHT COLT" for a in self.repo.master_history()))

        # Later sheets with the same name import straight away.
        february = self.root / "february.xlsx"
        create_report(february, actual_rob=90)
        with_vessel(february, "M/T DHT COLT")
        workbook = load_workbook(february)
        workbook.active["B2"] = "28/02/2026"
        workbook.save(february)
        self.assertEqual(self.repo.import_file(february)["status"], "Imported")

    def test_a_name_already_mapped_to_another_vessel_is_refused(self):
        self.repo.map_vessel_alias("M/T DHT COLT", "DHT COLT")
        with self.assertRaisesRegex(ValueError, "already mapped"):
            self.repo.map_vessel_alias("m/t dht colt", "DHT TIGER")
        with self.assertRaisesRegex(ValueError, "not a fleet vessel"):
            self.repo.map_vessel_alias("X", "NOT A SHIP")

    def test_the_parser_version_used_by_these_tests_is_current(self):
        self.assertTrue(VERSION)


if __name__ == "__main__":
    unittest.main()
