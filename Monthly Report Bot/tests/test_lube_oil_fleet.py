"""Fleet and vessel-group comparison: coverage, running-hour rates and year-to-date budget."""
import unittest

from lube_oil.budget import AE_SYSTEM_OIL, ME_CYLINDER_OIL, ME_SYSTEM_OIL, budget_performance
from lube_oil.fleet import fleet_comparison, period_months
from test_lube_oil_budget import BASIS, PRICES, report

COLT, IMPALA, PUMA = "DHT COLT", "DHT IMPALA", "DHT PUMA"


def vessel_report(vessel, month, **kwargs):
    r = report(month, **kwargs)
    r["vessel"] = vessel
    return r


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.reports = [vessel_report(COLT, m) for m in ("2025-12", "2026-01", "2026-02", "2026-03")]
        self.reports += [vessel_report(IMPALA, "2026-03", me_all=1000.0, me_hours=240.0)]
        self.vessels = [COLT, IMPALA, PUMA]
        self.data = fleet_comparison(self.reports, self.vessels, "2026-03", "YTD", {COLT: BASIS}, {COLT: PRICES})
        self.rows = {row["vessel"]: row["categories"] for row in self.data["vessels"]}

    def test_ytd_window_starts_on_1_january(self):
        self.assertEqual(self.data["months"], ["2026-01", "2026-02", "2026-03"])
        self.assertEqual(period_months("2026-03", 6)[0], "2025-10")

    def test_missing_vessel_months_are_not_zero(self):
        puma = self.rows[PUMA][ME_SYSTEM_OIL]
        self.assertIsNone(puma["total"])
        self.assertIsNone(puma["rate"])
        self.assertEqual(puma["months"], [])
        march = self.data["totals"][ME_SYSTEM_OIL]["monthly"]
        self.assertEqual([m["vessels"] for m in march], [1, 1, 2])

    def test_coverage(self):
        totals = self.data["totals"][ME_SYSTEM_OIL]
        self.assertEqual((totals["vessel_months"], totals["possible"], totals["vessels_reporting"]), (4, 9, 2))
        self.assertEqual(totals["total"], 3 * 1600 + 1000)

    def test_rate_per_24h_running(self):
        self.assertAlmostEqual(self.rows[COLT][ME_SYSTEM_OIL]["rate"], 1600 / 480 * 24)
        self.assertAlmostEqual(self.rows[IMPALA][ME_SYSTEM_OIL]["rate"], 1000 / 240 * 24)
        self.assertIsNone(self.rows[COLT][AE_SYSTEM_OIL]["rate"])  # AE oil is not ME-driven

    def test_fleet_rate_equals_card_rate(self):
        from lube_oil.analytics import period_rate
        card = period_rate(self.reports, COLT, "2026-03", "YTD", "System oil · ME")
        self.assertAlmostEqual(self.rows[COLT][ME_SYSTEM_OIL]["rate"], card["rate"])

    def test_rate_skips_months_without_hours_but_total_keeps_them(self):
        reports = [vessel_report(COLT, "2026-01"), vessel_report(COLT, "2026-02", me_hours=None)]
        row = fleet_comparison(reports, [COLT], "2026-02", "YTD", {}, {})["vessels"][0]["categories"][ME_SYSTEM_OIL]
        self.assertEqual(row["total"], 3200)
        self.assertEqual(row["rate_months"], 1)
        self.assertAlmostEqual(row["rate"], 1600 / 480 * 24)

    def test_budget_only_for_configured_vessels(self):
        self.assertTrue(self.rows[COLT][ME_SYSTEM_OIL]["budget"]["configured"])
        self.assertFalse(self.rows[IMPALA][ME_SYSTEM_OIL]["budget"]["configured"])
        fleet = self.data["totals"][ME_SYSTEM_OIL]["budget"]
        self.assertEqual(fleet["vessels"], 1)
        self.assertEqual(fleet["actual"], 3 * 1600)  # Impala's litres are not set against Colt's allowance

    def test_vessel_row_matches_budget_performance_page(self):
        page = {r["category"]: r for r in budget_performance(self.reports, COLT, 2026, "2026-03", BASIS, PRICES)["categories"]}
        for category in (ME_SYSTEM_OIL, ME_CYLINDER_OIL, AE_SYSTEM_OIL):
            figures = self.rows[COLT][category]
            self.assertEqual(figures["budget"]["percent"], page[category]["technical_percent"])
            self.assertEqual(figures["total"], page[category]["actual"])

    def test_cylinder_keeps_high_low_split(self):
        cylinder = self.data["totals"][ME_CYLINDER_OIL]
        self.assertEqual(cylinder["sub"]["Cylinder oil · High TBN"], 4 * 8000)
        self.assertEqual(cylinder["sub"]["Cylinder oil · Low TBN"], 4 * 400)
        self.assertEqual(cylinder["total"], 4 * 8400)

    def test_no_basis_or_price_rolls_from_another_year(self):
        later = fleet_comparison(self.reports + [vessel_report(COLT, "2027-01")], [COLT], "2027-01", "YTD",
                                 {COLT: BASIS}, {COLT: PRICES})
        self.assertFalse(later["vessels"][0]["categories"][ME_SYSTEM_OIL]["budget"]["configured"])
        self.assertIsNone(later["totals"][ME_SYSTEM_OIL]["budget"])


if __name__ == "__main__":
    unittest.main()
