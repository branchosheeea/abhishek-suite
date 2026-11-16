"""Card L/24h follows the selected period: hours-weighted sheet rates; a missing month is blank, never zero."""
import unittest

from lube_oil.analytics import period_rate, weighted_rate
from test_lube_oil_budget import COLT, report

ME, HIGH, LOW, AE = "System oil · ME", "Cylinder oil · High TBN", "Cylinder oil · Low TBN", "System oil · AE"


def flag(r, code):
    r["data"]["issues"].append(dict(code=code, title=code))
    return r


class PeriodRateTests(unittest.TestCase):
    def setUp(self):
        # Oct: 2,400 L over 600 h (96 L/24h). Sep: 1,000 L over 200 h (120 L/24h). Aug: 1,600 L over 480 h (80 L/24h).
        self.reports = [report("2026-08"), report("2026-09", me_all=1000.0, me_hours=200.0),
                        report("2026-10", me_all=2400.0, me_hours=600.0)]

    def test_latest_month_is_the_sheet_figure(self):
        result = period_rate(self.reports, COLT, "2026-10", 1, ME)
        self.assertAlmostEqual(result["rate"], 96.0)
        self.assertEqual((result["months"], result["of"]), (["2026-10"], 1))

    def test_three_months_is_hours_weighted_not_a_simple_mean(self):
        result = period_rate(self.reports, COLT, "2026-10", 3, ME)
        self.assertAlmostEqual(result["rate"], (2400 + 1000 + 1600) * 24 / (600 + 200 + 480))  # 93.75
        self.assertNotAlmostEqual(result["rate"], (96 + 120 + 80) / 3)

    def test_ytd_runs_from_january(self):
        result = period_rate(self.reports, COLT, "2026-10", "YTD", ME)
        self.assertEqual(result["of"], 10)
        self.assertEqual(result["months"], ["2026-08", "2026-09", "2026-10"])

    def test_missing_month_is_left_out_not_zero(self):
        reports = [self.reports[0], self.reports[2]]  # no September sheet
        result = period_rate(reports, COLT, "2026-10", 3, ME)
        self.assertAlmostEqual(result["rate"], (2400 + 1600) * 24 / (600 + 480))
        self.assertEqual((len(result["months"]), result["of"]), (2, 3))

    def test_blank_rate_or_hours_left_out(self):
        self.reports[1]["data"]["engines"][0]["rate"] = None
        self.reports[0]["data"]["engines"][0]["hours"] = None
        result = period_rate(self.reports, COLT, "2026-10", 3, ME)
        self.assertAlmostEqual(result["rate"], 96.0)
        self.assertEqual(result["months"], ["2026-10"])

    def test_nothing_usable_is_blank(self):
        result = period_rate([report("2026-10", me_hours=None)], COLT, "2026-10", 3, ME)
        self.assertIsNone(result["rate"])

    def test_zero_hours_month_left_out(self):
        flag(self.reports[1], "zero_hours:ME")
        self.assertEqual(period_rate(self.reports, COLT, "2026-10", 3, ME)["months"], ["2026-08", "2026-10"])

    def test_hours_above_calendar_month_kept_in_averages_hidden_alone(self):
        flag(self.reports[2], "hours:ME")
        alone = period_rate(self.reports, COLT, "2026-10", 1, ME)
        self.assertIsNone(alone["rate"])
        three = period_rate(self.reports, COLT, "2026-10", 3, ME)
        self.assertEqual(len(three["months"]), 3)
        self.assertEqual(three["flagged"], ["2026-10"])

    def test_cylinder_cards_share_the_sheet_total_rate(self):
        high = period_rate(self.reports, COLT, "2026-10", 3, HIGH)
        low = period_rate(self.reports, COLT, "2026-10", 3, LOW)
        self.assertAlmostEqual(high["rate"], low["rate"])
        self.assertAlmostEqual(high["rate"], 3 * 8400 * 24 / (600 + 200 + 480))

    def test_ae_has_no_single_rate(self):
        self.assertIsNone(period_rate(self.reports, COLT, "2026-10", 3, AE)["rate"])

    def test_failed_report_left_out(self):
        self.reports[1]["validation_status"] = "FAIL"
        self.assertEqual(len(weighted_rate({r["month"]: r for r in self.reports}, ["2026-08", "2026-09", "2026-10"],
                                           "rate")["months"]), 2)


if __name__ == "__main__":
    unittest.main()
