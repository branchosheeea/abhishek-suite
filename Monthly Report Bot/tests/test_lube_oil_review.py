import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook

from lube_oil.analytics import decision_brief, monthly_analysis, series
from lube_oil.exports import export_excel, export_pdf
from lube_oil.parser import parse_date, parse_reporting_month, parse_workbook
from lube_oil.repository import Repository
from suite_services.database import connection


def create_report(path, actual_rob=100, shortage=0, reporting_date=None):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "12 04 07 021"
    sheet["D1"] = "LUB OIL STOCK AND CONSUMPTION"
    sheet["A1"], sheet["B1"] = "VESSEL", "DHT COLT"
    sheet["A2"], sheet["B2"] = "MONTH", reporting_date or datetime(2026, 1, 31)
    sheet["A3"] = "SUMMARY"
    sheet["A4"], sheet["B4"], sheet["C4"] = "SYSTEM OIL M E", "HIGH TBN", "SYSTEM OIL A E"
    sheet["A5"], sheet["B5"], sheet["C5"] = "GRADE OF OIL", "TARO ULTRA 100", "TARO 30 DP40"
    for row, label, me, ae in (
        (6, "STOCK END OF LAST MONTH", 200, 200),
        (7, "RECEIVED DURING THE MONTH", 0, 0),
        (8, "CONSUMED DURING THIS MONTH", 100, 100),
        (9, "STOCK END OF THE MONTH", 100, 100),
        (10, "STOCK END OF LAST MONTH A", 5, 5),
        (11, "REPLENISHED TO SYSTEM FROM STORAGE TK B", 100, 100),
        (12, "STOCK END OF THIS MONTH C", 5, 5),
        (13, "CONSUMPTION THIS MONTH A B C D", 100, 100),
        (14, "SYSTEM CHANGE LOSS OF OIL E", 0, 0),
        (15, "TOTAL CONSUMPTION THIS MONTH D E F", 100, 100),
    ):
        sheet.cell(row, 1, label)
        sheet.cell(row, 2, me)
        sheet.cell(row, 3, ae)
    for row, label, me, ae in (
        (16, "HOURS RUN DURING THIS MONTH", 100, 100),
        (17, "SYSTEM OIL CONSUMPTION PER 24 HOURS", 24, 24),
        (18, "CYLINDER OIL CONSUMPTION PER 24 HOURS", 2, None),
        (19, "SYSTEM OIL IN SERVICE LAST CHANGE DATE", datetime(2025, 12, 15), datetime(2025, 12, 15)),
    ):
        sheet.cell(row, 1, label)
        sheet.cell(row, 2, me)
        if ae is not None:
            sheet.cell(row, 3, ae)
    sheet["B20"], sheet["C20"] = "Main Engine", "Aux Eng 1"
    sheet["A21"] = "REMARKS"
    sheet["A22"] = f"TARO ULTRA 100 ACTUAL ROB: {actual_rob} LTRS (SHORT BY {shortage})"
    workbook.save(path)
    workbook.close()


class LubeOilReviewTests(unittest.TestCase):
    def test_reporting_date_formats_used_by_vessel_workbooks_are_supported(self):
        self.assertEqual(parse_date("25th OCT 2026"), "2026-10-25")
        self.assertEqual(parse_date("25TH Sept 2026"), "2026-09-25")
        self.assertEqual(parse_date("25/10/26"), "2026-10-25")
        self.assertEqual(parse_reporting_month("OCT'26"), "2026-10")
        self.assertEqual(parse_reporting_month("October 2026"), "2026-10")
        self.assertEqual(
            parse_reporting_month(
                "DHT COLT LUB OIL STOCK AND CONSUMPTION REPORT OCTOBER 2026.xlsx",
                search=True,
            ),
            "2026-10",
        )

    def test_workbook_period_is_retained_and_filename_mismatch_is_flagged(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.xlsx"
            create_report(path, reporting_date="25 OCTOBER 2025")
            parsed = parse_workbook(
                path,
                source_name="DHT LEOPARD LUB OIL STOCK AND CONSUMPTION REPORT OCTOBER 2026.xlsx",
            )

        self.assertEqual(parsed["month"], "2025-10")
        mismatch = next(i for i in parsed["issues"] if i["code"] == "filename_period_mismatch")
        self.assertIn("Filename suggests 2026-10; workbook states 2025-10", mismatch["detail"])

    def test_equal_actual_and_book_rob_is_not_flagged_as_a_discrepancy(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.xlsx"
            create_report(path)
            report = parse_workbook(path)

        self.assertEqual(report["validation_status"], "PASS")
        self.assertEqual(report["inventory"][0]["actual_rob"], 100)
        self.assertFalse(any(issue["code"] == "actual:0" for issue in report["issues"]))

    def test_different_actual_and_book_rob_produces_a_supported_decision_brief(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.xlsx"
            create_report(path, actual_rob=80, shortage=20)
            parsed = parse_workbook(path)

        report = {"data": parsed, "is_active": False, "confirmed_at": None}
        brief = decision_brief(report)
        self.assertEqual(brief["headline"], "Reconcile stated stock before making a purchase decision")
        self.assertIn("book minus actual +20.0 L", brief["facts"][0])
        self.assertIn("not proof of physical loss", brief["rationale"])
        self.assertIn("Cost exposure is not estimated", brief["boundary"])
        self.assertIn("EXCLUDED FROM TRENDS", brief["source_state"])

    def test_confirmed_source_is_labelled_and_no_exception_does_not_claim_efficiency(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.xlsx"
            create_report(path)
            parsed = parse_workbook(path)

        brief = decision_brief({"data": parsed, "is_active": True, "confirmed_at": "2026-02-01"})
        self.assertEqual(brief["source_state"], "OFFICIAL REPORT IN USE")
        self.assertEqual(brief["headline"], "No priority exception detected in the parsed report")
        self.assertIn("not a finding that consumption is optimal", brief["rationale"])

    def test_import_is_used_immediately_and_newer_sheet_supersedes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "january.xlsx"
            create_report(first)
            repository = Repository(root / "runtime")

            imported = repository.import_file(first)
            self.assertEqual(imported["status"], "Imported")
            report_id = repository.reports()[0]["id"]
            self.assertTrue(repository.reports()[0]["is_active"])
            self.assertEqual(repository.import_file(first)["status"], "Duplicate")

            revised = root / "january_corrected.xlsx"
            create_report(revised, actual_rob=80, shortage=20)
            self.assertEqual(repository.import_file(revised)["status"], "Imported")
            revised_id = next(r["id"] for r in repository.reports() if r["filename"] == revised.name)

            reports = repository.reports()
            active = [r for r in reports if r["is_active"]]
            self.assertEqual([r["id"] for r in active], [revised_id])
            self.assertEqual(next(r for r in reports if r["id"] == revised_id)["supersedes_report_id"], report_id)
            self.assertTrue(any(event["action"] == "superseded" for event in repository.audit(report_id)))

    def test_earlier_unconfirmed_imports_are_activated_latest_first(self):
        from suite_services.database import connection
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, revised = root / "january.xlsx", root / "january_revised.xlsx"
            create_report(first)
            create_report(revised, actual_rob=80, shortage=20)
            repository = Repository(root / "runtime")
            repository.import_file(first)
            repository.import_file(revised)
            # Simulate reports imported while confirmation was still required.
            with connection(repository.root) as db, db:
                db.execute("UPDATE monthly_reports SET is_active=0, confirmed_at=NULL, supersedes_report_id=NULL")

            self.assertEqual(repository.activate_imported(), 1)
            self.assertEqual(repository.activate_imported(), 0)
            active = [r["filename"] for r in repository.reports() if r["is_active"]]
            self.assertEqual(active, [revised.name])

    def test_calendar_gap_remains_explicit(self):
        reports = [
            {"month": "2025-12", "data": {"engines": [{"engine": "ME", "hours": 100, "rate": 10}], "issues": []}},
            {"month": "2026-02", "data": {"engines": [{"engine": "ME", "hours": 100, "rate": 20}], "issues": []}},
        ]
        points = series(reports, months=3, end="2026-02")
        self.assertEqual([point["value"] for point in points], [10, None, 20])
        self.assertIsNone(points[-1]["averages"][3])

    def test_monthly_analysis_compares_each_vessel_with_prior_complete_windows(self):
        def monthly_report(vessel, month, rate, active=True, grade="TARO 100"):
            return {
                "vessel": vessel,
                "month": month,
                "is_active": active,
                "confirmed_at": "confirmed" if active else None,
                "filename": f"{vessel}-{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "vessel": vessel,
                    "inventory": [
                        {"category": "SYSTEM OIL M E", "grade": grade},
                    ],
                    "engines": [{
                        "engine": "ME", "hours": 100, "rate": rate,
                        "implied_litres": rate * 100 / 24,
                    }],
                    "issues": [],
                    "evidence": {},
                },
            }

        reports = [
            monthly_report("DHT COLT", "2026-01", 20),
            monthly_report("DHT COLT", "2026-02", 22),
            monthly_report("DHT COLT", "2026-03", 24),
            monthly_report("DHT COLT", "2026-04", 30, active=False),
            monthly_report("DHT OPAL", "2026-04", 40, active=False),
        ]
        result = monthly_analysis(reports, "2026-04")
        colt = next(v for v in result["vessels"] if v["vessel"] == "DHT COLT")
        opal = next(v for v in result["vessels"] if v["vessel"] == "DHT OPAL")
        three_month = colt["engines"][0]["comparisons"][3]

        self.assertEqual(colt["state"], "provisional")
        self.assertEqual(three_month["coverage"], 3)
        self.assertTrue(three_month["complete"])
        self.assertAlmostEqual(three_month["average_rate"], 22)
        self.assertAlmostEqual(three_month["change_percent"], (30 - 22) / 22 * 100)
        self.assertEqual(colt["engines"][0]["comparisons"][6]["coverage"], 3)
        self.assertFalse(colt["engines"][0]["comparisons"][6]["complete"])
        self.assertEqual(opal["state"], "provisional")
        self.assertEqual(opal["engines"][0]["comparisons"][3]["coverage"], 0)

    def test_monthly_analysis_excludes_mixed_oil_grades_from_baseline(self):
        def report(month, grade, rate, active):
            return {
                "vessel": "DHT COLT",
                "month": month,
                "is_active": active,
                "confirmed_at": "confirmed" if active else None,
                "filename": f"{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "inventory": [{"category": "SYSTEM OIL M E", "grade": grade}],
                    "engines": [{"engine": "ME", "hours": 100, "rate": rate}],
                    "issues": [],
                    "evidence": {},
                },
            }

        result = monthly_analysis([
            report("2026-03", "OIL A", 20, True),
            report("2026-04", "OIL B", 30, False),
        ], "2026-04")
        comparison = result["vessels"][0]["engines"][0]["comparisons"][3]
        self.assertEqual(comparison["coverage"], 0)
        self.assertIsNone(comparison["change_percent"])

    def test_monthly_analysis_does_not_use_pending_reports_as_history(self):
        reports = []
        for month, rate in (
            ("2026-01", 20),
            ("2026-02", 22),
            ("2026-03", 24),
            ("2026-04", 30),
        ):
            reports.append({
                "vessel": "DHT COLT",
                "month": month,
                "is_active": False,
                "confirmed_at": None,
                "filename": f"{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "inventory": [{"category": "SYSTEM OIL M E", "grade": "OIL A"}],
                    "engines": [{"engine": "ME", "hours": 100, "rate": rate}],
                    "issues": [],
                    "evidence": {},
                },
            })

        result = monthly_analysis(reports, "2026-04")
        comparison = result["vessels"][0]["engines"][0]["comparisons"][3]
        self.assertEqual(comparison["coverage"], 0)
        self.assertEqual(comparison["provisional_months_available"], 3)
        self.assertIsNone(comparison["change_percent"])
        self.assertEqual(comparison["reference_coverage"], 3)
        self.assertAlmostEqual(comparison["reference_average_rate"], 22)
        self.assertEqual(comparison["reference_provisional_months"], 3)
        self.assertAlmostEqual(
            comparison["reference_change_percent"], (30 - 22) / 22 * 100
        )

    def test_bulk_oil_analysis_compares_grade_specific_measures_and_pending_history(self):
        reports = []
        for month, system_operating, cylinder_withdrawal, active in (
            ("2026-01", 100, 50, True),
            ("2026-03", 300, 250, False),
            ("2026-04", 400, 350, False),
        ):
            reports.append({
                "id": month,
                "vessel": "DHT COLT",
                "month": month,
                "is_active": active,
                "confirmed_at": "confirmed" if active else None,
                "validation_status": "PASS",
                "data": {
                    "inventory": [
                        {
                            "category": "SYSTEM OIL M/E",
                            "grade": "TARO 100",
                            "unit": "L",
                            "operating": system_operating,
                            "withdrawal": system_operating + 10,
                            "change_loss": 5,
                        },
                        {
                            "category": "CYL. OIL HIGH TBN",
                            "grade": "TARO 100",
                            "unit": "L",
                            "withdrawal": cylinder_withdrawal,
                            "operating": None,
                        },
                    ],
                    "engines": [],
                    "issues": [],
                },
            })

        result = monthly_analysis(reports, "2026-04", windows=(3,))
        vessel = result["vessels"][0]
        system = next(
            oil for oil in vessel["bulk_oils"]
            if oil["category"] == "SYSTEM OIL M/E"
        )
        cylinder = next(
            oil for oil in vessel["bulk_oils"]
            if oil["category"] == "CYL. OIL HIGH TBN"
        )

        self.assertEqual(system["consumption_field"], "operating")
        self.assertEqual(system["monthly_consumption"], 400)
        self.assertAlmostEqual(system["comparisons"][3]["average_consumption"], 100)
        self.assertEqual(system["comparisons"][3]["coverage"], 1)
        self.assertIsNone(system["comparisons"][3]["change_percent"])
        self.assertAlmostEqual(
            system["comparisons"][3]["reference_average_consumption"], 200
        )
        self.assertEqual(
            system["comparisons"][3]["reference_provisional_months"], 1
        )
        self.assertEqual(system["comparisons"][3]["history"][-1]["state"], "provisional")
        self.assertEqual(system["comparisons"][3]["history"][1]["state"], "missing")

        self.assertEqual(cylinder["consumption_field"], "withdrawal")
        self.assertEqual(cylinder["monthly_consumption"], 350)
        self.assertAlmostEqual(
            cylinder["comparisons"][3]["average_consumption"], 50
        )
        self.assertEqual(cylinder["comparisons"][3]["coverage"], 1)

        changed_grade_reports = [dict(item) for item in reports]
        changed_current = dict(changed_grade_reports[-1])
        changed_data = dict(changed_current["data"])
        changed_inventory = [
            dict(item) for item in changed_data["inventory"]
        ]
        changed_inventory[0]["grade"] = "TARO 200"
        changed_data["inventory"] = changed_inventory
        changed_current["data"] = changed_data
        changed_grade_reports[-1] = changed_current
        changed = monthly_analysis(
            changed_grade_reports, "2026-04", windows=(3,),
        )["vessels"][0]
        changed_system = next(
            oil for oil in changed["bulk_oils"]
            if oil["category"] == "SYSTEM OIL M/E"
        )
        self.assertEqual(changed_system["comparisons"][3]["coverage"], 0)
        self.assertIsNone(changed_system["comparisons"][3]["change_percent"])

    def test_monthly_analysis_keeps_unconfirmed_consumption_reference_separate(self):
        reports = []
        for month, litres in (
            ("2026-01", 100),
            ("2026-02", 200),
            ("2026-03", 300),
            ("2026-04", 400),
        ):
            reports.append({
                "vessel": "DHT COLT",
                "month": month,
                "is_active": False,
                "confirmed_at": None,
                "filename": f"{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "inventory": [{
                            "category": "SYSTEM OIL M/E",
                        "grade": "OIL A",
                        "operating": litres,
                        "change_loss": 0,
                        "all_in": litres,
                        "unit": "L",
                    }, {
                            "category": "CYL. OIL HIGH TBN 100 / 70",
                            "grade": "TARO ULTRA 100",
                            "unit": "L",
                    }, {
                            "category": "CYL. OIL LOW TBN 40 / 25",
                            "grade": "TARO ULTRA 40",
                            "unit": "L",
                    }],
                    "engines": [{
                            "engine": "ME", "hours": 100, "rate": litres / 10,
                            "cylinder_rate": litres / 5,
                    }],
                    "issues": [],
                    "evidence": {},
                },
            })

        result = monthly_analysis(reports, "2026-04")
        vessel = result["vessels"][0]
        engine = vessel["engines"][0]["comparisons"][3]
        main_engine = vessel["engines"][0]
        cylinder = main_engine["cylinder_comparisons"][3]
        oil = vessel["oils"][0]["comparisons"][3]

        self.assertEqual(engine["coverage"], 0)
        self.assertIsNone(engine["average_rate"])
        self.assertIsNone(engine["change_percent"])
        self.assertEqual(engine["reference_coverage"], 3)
        self.assertEqual(engine["reference_provisional_months"], 3)
        self.assertAlmostEqual(engine["reference_average_rate"], 20)
        self.assertAlmostEqual(main_engine["cylinder_rate"], 80)
        self.assertEqual(cylinder["coverage"], 0)
        self.assertEqual(cylinder["reference_coverage"], 3)
        self.assertEqual(cylinder["reference_provisional_months"], 3)
        self.assertAlmostEqual(cylinder["reference_average_rate"], 40)
        self.assertEqual(oil["coverage"], 0)
        self.assertIsNone(oil["average_operating"])
        self.assertEqual(oil["reference_coverage"], 3)
        self.assertEqual(oil["reference_provisional_months"], 3)
        self.assertAlmostEqual(oil["reference_average_operating"], 200)

    def test_monthly_analysis_exports_to_pdf_and_excel(self):
        report = {
            "id": 1,
            "vessel": "DHT COLT",
            "month": "2026-04",
            "is_active": False,
            "confirmed_at": None,
            "filename": "colt.xlsx",
            "validation_status": "WARNING",
            "sha256": "abc",
            "data": {
                "vessel": "DHT COLT",
                "inventory": [{
                    "category": "SYSTEM OIL M/E",
                    "grade": "OIL A",
                    "unit": "L",
                    "operating": 250,
                    "withdrawal": 270,
                    "change_loss": 5,
                }],
                "engines": [{"engine": "ME", "hours": 100, "rate": 25}],
                "issues": [{
                    "code": "hours:ME", "severity": "WARNING",
                    "title": "Hours require review", "detail": "Check the period.",
                    "fields": ["ME.hours"],
                }],
                "evidence": {"ME.hours": {"sheet": "Sheet1", "cell": "B16"}},
            },
        }
        prior_reports = [
            {
                "vessel": "DHT COLT",
                "month": month,
                "is_active": False,
                "confirmed_at": None,
                "filename": f"{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "inventory": [{
                        "category": "SYSTEM OIL M/E",
                        "grade": "OIL A",
                        "operating": rate * 10,
                        "unit": "L",
                    }],
                    "engines": [{"engine": "ME", "hours": 100, "rate": rate}],
                    "issues": [],
                    "evidence": {},
                },
            }
            for month, rate in (
                ("2026-01", 20),
                ("2026-02", 22),
                ("2026-03", 24),
            )
        ]
        analysis = monthly_analysis([*prior_reports, report], "2026-04")
        with tempfile.TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "monthly.pdf"
            xlsx_path = Path(directory) / "monthly.xlsx"
            export_pdf(analysis, pdf_path)
            export_excel(analysis, xlsx_path)

            pdf_bytes = pdf_path.read_bytes()
            self.assertTrue(pdf_bytes.startswith(b"%PDF-1.4"))
            self.assertIn(b"Preliminary reference \\(includes pending\\)", pdf_bytes)
            self.assertIn(b"Grade consumption", pdf_bytes)
            workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
            try:
                self.assertEqual(workbook.sheetnames, [
                    "Fleet Summary", "Consumption Comparisons", "Findings and Evidence",
                ])
                trends = workbook["Consumption Comparisons"]
                self.assertEqual(trends["P1"].value, "Preliminary reference average")
                self.assertAlmostEqual(trends["P2"].value, 22)
                self.assertEqual(trends["S2"].value, 3)
                self.assertTrue(any(
                    row[3] == "Grade consumption · System operating consumption"
                    and row[5] == "OIL A"
                    for row in trends.iter_rows(min_row=2, values_only=True)
                ))
                findings = workbook["Findings and Evidence"]
                self.assertEqual(findings["H2"].value, "Sheet1!B16")
            finally:
                workbook.close()

    def test_repository_reprocesses_stale_archives_keeping_their_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report_path = root / "october.xlsx"
            create_report(report_path, reporting_date="OCT'26")
            repository = Repository(root / "runtime")
            repository.import_file(report_path)
            stored = repository.reports()[0]
            with connection(repository.root) as db:
                stale_payload = dict(stored["data"])
                stale_payload["parser_version"] = "1.1.0"
                stale_payload["month"] = None
                stale_payload["reporting_date"] = None
                db.execute(
                    "UPDATE monthly_reports SET month=NULL, reporting_date=NULL WHERE id=?",
                    (stored["id"],),
                )
                db.execute(
                    "UPDATE monthly_reports SET payload=? WHERE id=?",
                    (json.dumps(stale_payload), stored["id"]),
                )
                db.commit()

            self.assertEqual(repository.reprocess_stale_reports(), 1)
            refreshed = repository.reports()[0]
            self.assertEqual(refreshed["month"], "2026-10")
            self.assertTrue(refreshed["is_active"])
            self.assertEqual(refreshed["confirmed_at"], stored["confirmed_at"])
            self.assertEqual(refreshed["data"]["parser_version"], "1.3.0")


if __name__ == "__main__":
    unittest.main()
