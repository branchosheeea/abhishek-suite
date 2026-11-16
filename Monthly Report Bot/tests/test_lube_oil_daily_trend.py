"""Daily trend semantics are independent of the source's monthly accounting."""
import unittest
from lube_oil.analytics import consumption_trend_range, grade_daily_trend


def report(month, quantity, active=True, category="CYL. OIL HIGH TBN", grade="TARO 100", vessel="DHT COLT", hours=240):
    return dict(id=month, month=month, vessel=vessel, is_active=active,
                confirmed_at="reviewed" if active else None, validation_status="PASS",
                data={"inventory": [dict(category=category, grade=grade, unit="L", withdrawal=quantity,
                                         operating=quantity / 2 if quantity is not None else None)],
                      "engines": [dict(engine="ME", hours=hours)], "issues": []})


class DailyTrendTests(unittest.TestCase):
    def test_presets_include_current_month_and_exact_month_count(self):
        for preset, start in (("1M", "2026-01"), ("3M", "2025-11"), ("6M", "2025-08"), ("12M", "2025-02")):
            self.assertEqual(consumption_trend_range("2026-01", preset), (start, "2026-01"))

    def test_custom_date_validation_and_month_bucket_boundaries(self):
        self.assertEqual(consumption_trend_range("2026-03", "Custom", "2024-02-15", "2024-03-05"), ("2024-02", "2024-03"))
        for start, end in (("2026-02-30", "2026-03-01"), ("2026-03-02", "2026-03-01")):
            with self.assertRaises(ValueError):
                consumption_trend_range("2026-03", "Custom", start, end)

    def test_running_hour_rates_and_weighted_confirmed_baseline(self):
        reports = [report("2024-01", 100, hours=240), report("2024-02", 400, hours=480), report("2024-03", 300, active=False)]
        result = grade_daily_trend(reports, reports[-1]["data"]["inventory"][0], reports[-1], "2024-01", "2024-03")
        self.assertEqual([p["value"] for p in result["history"]], [10, 20, 30])
        self.assertEqual(result["history"][1]["hours"], 480)
        self.assertAlmostEqual(result["average_consumption"], 500 / 720 * 24)
        self.assertEqual(result["coverage"], 2)
        self.assertEqual(result["history"][-1]["state"], "provisional")
        self.assertEqual(reports[-1]["data"]["inventory"][0]["withdrawal"], 300)

    def test_system_oils_use_operating_not_storage_withdrawal(self):
        selected = report("2026-04", 600, category="SYSTEM OIL M/E")
        result = grade_daily_trend([selected], selected["data"]["inventory"][0], selected, "2026-04", "2026-04")
        self.assertEqual(result["current"]["value"], 30)
        self.assertEqual(len(result["history"]), 1)
        self.assertIsNone(result["average_consumption"])

    def test_gaps_invalid_values_wrong_grade_and_vessel_do_not_become_zero(self):
        selected = report("2026-06", 0)
        prior = [report("2026-01", -100), report("2026-02", 100, grade="OTHER"),
                 report("2026-03", 100, vessel="OTHER VESSEL"), report("2026-04", float("nan"))]
        result = grade_daily_trend(prior + [selected], selected["data"]["inventory"][0], selected, "2026-01", "2026-06")
        self.assertEqual([p["value"] for p in result["history"]], [None, None, None, None, None, 0])
        self.assertIsNone(result["average_consumption"])

    def test_confirmed_baseline_survives_pending_revision_and_duplicate_pending_is_gap(self):
        active, pending = report("2026-01", 310), report("2026-01", 3100, False)
        feb1, feb2 = report("2026-02", 280, False), report("2026-02", 560, False)
        selected = report("2026-03", 930, False)
        result = grade_daily_trend([active, pending, feb1, feb2, selected], selected["data"]["inventory"][0], selected, "2026-01", "2026-03")
        self.assertEqual([p["value"] for p in result["history"]], [31, None, 93])
        self.assertEqual(result["history"][1]["state"], "ambiguous")
        self.assertEqual(result["average_consumption"], 31)

    def test_failed_report_excluded_and_pending_reference_labelled(self):
        jan, feb, selected = report("2026-01", 310, False), report("2026-02", 280), report("2026-03", 930)
        feb["validation_status"] = "FAIL"
        result = grade_daily_trend([jan, feb, selected], selected["data"]["inventory"][0], selected, "2026-01", "2026-03")
        self.assertIsNone(result["average_consumption"])
        self.assertEqual(result["reference_average_consumption"], 31)
        self.assertEqual(result["reference_provisional_months"], 1)
        self.assertIsNone(result["history"][1]["value"])

    def test_pooled_ae_uses_combined_hours_not_engine_average_or_calendar(self):
        selected = report("2026-03", 1200, category="SYSTEM OIL A/E")
        selected["data"]["engines"] = [dict(engine="AE1", hours=300), dict(engine="AE2", hours=100), dict(engine="AE3", hours=0)]
        target = selected["data"]["inventory"][0]
        result = grade_daily_trend([selected], target, selected, "2026-03", "2026-03")
        self.assertEqual(result["current"]["hours"], 400)
        self.assertEqual(result["current"]["value"], 36)
        selected["data"]["engines"][2]["hours"] = None
        self.assertIsNone(grade_daily_trend([selected], target, selected, "2026-03", "2026-03")["current"]["value"])

    def test_missing_zero_negative_and_impossible_hours_are_unavailable(self):
        for hours in (None, 0, -1, float("nan"), 745, True):
            with self.subTest(hours=hours):
                selected = report("2026-03", 1200, hours=hours)
                result = grade_daily_trend([selected], selected["data"]["inventory"][0], selected, "2026-03", "2026-03")
                self.assertIsNone(result["current"]["value"])
                self.assertEqual(result["current"]["state"], "hours_unavailable")

    def test_unmapped_oil_does_not_borrow_me_hours(self):
        selected = report("2026-03", 100, category="HYDRAULIC OIL")
        result = grade_daily_trend([selected], selected["data"]["inventory"][0], selected, "2026-03", "2026-03")
        self.assertIsNone(result["current"]["value"])
        self.assertIn("no validated", result["current"]["reason"])

    def test_operating_rate_is_independent_of_calendar_month_length(self):
        reports = [report("2026-02", 240), report("2026-03", 240)]
        result = grade_daily_trend(reports, reports[-1]["data"]["inventory"][0], reports[-1], "2026-02", "2026-03")
        self.assertEqual([p["value"] for p in result["history"]], [24, 24])
        self.assertEqual(result["change_percent"], 0)


if __name__ == "__main__":
    unittest.main()
