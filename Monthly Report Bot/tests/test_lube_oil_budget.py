"""Budget basis, activity variance, AE classification and consumption-only cost (spec §18-§37, §53)."""
from pathlib import Path
import tempfile
import unittest

import lube_oil.analytics as analytics
import lube_oil.budget as budget
from lube_oil.analytics import ae_month_breakdown, oil_group
from lube_oil.budget import (
    AE_SYSTEM_OIL, ME_CYLINDER_OIL, ME_SYSTEM_OIL, NOT_CONFIGURED,
    activity_variance, annual_allowance, budget_category, budget_performance, consumption_cost, period_allowance,
)
from lube_oil.repository import Repository

COLT = "DHT COLT"
BASIS = [
    dict(budget_year=2026, oil_category=ME_CYLINDER_OIL, daily_budget_rate=425, applicable_days_per_year=240),
    dict(budget_year=2026, oil_category=ME_SYSTEM_OIL, daily_budget_rate=75, applicable_days_per_year=240),
    dict(budget_year=2026, oil_category=AE_SYSTEM_OIL, daily_budget_rate=15, applicable_days_per_year=365),
]
PRICES = [
    dict(budget_year=2026, oil_category=ME_CYLINDER_OIL, oil_grade=None, reference_price_per_litre=1.59, currency="USD"),
    dict(budget_year=2026, oil_category=ME_SYSTEM_OIL, oil_grade=None, reference_price_per_litre=1.18, currency="USD"),
    dict(budget_year=2026, oil_category=AE_SYSTEM_OIL, oil_grade=None, reference_price_per_litre=2.00, currency="USD"),
]


def report(month, me_hours=480.0, high=8000.0, low=400.0, me_all=1600.0, ae_routine=500.0, ae_loss=0.0,
           events=(), receipts=0.0, active=True, hydraulic=50.0):
    oils = [
        dict(category="SYSTEM OIL M/E", grade="TARO 30", unit="L", receipts=receipts, withdrawal=me_all,
             operating=me_all, change_loss=0.0, all_in=me_all, closing=30000.0),
        dict(category="CYL.OIL HIGH TBN 100 / 70", grade="TARO ULTRA 100", unit="L", receipts=receipts,
             withdrawal=high, closing=40000.0),
        dict(category="CYL. OIL LOW TBN 40 / 25", grade="TARO ULTRA 40", unit="L", receipts=0.0, withdrawal=low,
             closing=10000.0),
        dict(category="SYSTEM OIL A/E", grade="TARO 30 DP 40", unit="L", receipts=0.0, withdrawal=ae_routine,
             operating=ae_routine, change_loss=ae_loss, all_in=ae_routine + ae_loss, closing=8000.0),
        dict(category="HYDR. OIL STEER. GEAR", grade="RANDO HDZ 68", unit="L", withdrawal=hydraulic, closing=200.0),
    ]
    # The sheet's own L/24h figures, as the vessel's formulas produce them (routine ME system oil; High + Low cylinder).
    me_rate = me_all * 24 / me_hours if me_hours and me_all is not None else None
    cylinder_rate = (high + low) * 24 / me_hours if me_hours and None not in (high, low) else None
    engines = ([dict(engine="ME", hours=me_hours, rate=me_rate, cylinder_rate=cylinder_rate)]
               + [dict(engine=f"AE{i}", hours=400.0) for i in (1, 2, 3)])
    return dict(id=month, month=month, vessel=COLT, is_active=active, confirmed_at="x" if active else None,
                validation_status="PASS",
                data=dict(inventory=oils, engines=engines, issues=[], events=[dict(e) for e in events]))


def performance(reports, end="2026-01", basis=BASIS, prices=PRICES, year=2026):
    result = budget_performance(reports, COLT, year, end, basis, prices)
    return {row["category"]: row for row in result["categories"]}, result


class BudgetBasisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Repository(Path(self.temp.name))
        self.basis = {b["oil_category"]: b for b in self.repo.budget_basis(COLT, 2026)}

    def tearDown(self):
        self.temp.cleanup()

    def test_dht_colt_cylinder_rate_425(self):
        self.assertEqual(self.basis[ME_CYLINDER_OIL]["daily_budget_rate"], 425)

    def test_dht_colt_cylinder_days_240(self):
        self.assertEqual(self.basis[ME_CYLINDER_OIL]["applicable_days_per_year"], 240)

    def test_dht_colt_cylinder_annual_102000(self):
        self.assertEqual(self.basis[ME_CYLINDER_OIL]["annual_budget_quantity"], 102000)
        self.assertEqual(annual_allowance(self.basis[ME_CYLINDER_OIL]), 102000)
        self.assertNotEqual(annual_allowance(self.basis[ME_CYLINDER_OIL]), 425 * 365)

    def test_dht_colt_me_system_rate_75(self):
        self.assertEqual(self.basis[ME_SYSTEM_OIL]["daily_budget_rate"], 75)

    def test_dht_colt_me_system_days_240(self):
        self.assertEqual(self.basis[ME_SYSTEM_OIL]["applicable_days_per_year"], 240)

    def test_dht_colt_me_system_annual_18000(self):
        self.assertEqual(annual_allowance(self.basis[ME_SYSTEM_OIL]), 18000)

    def test_dht_colt_ae_rate_15(self):
        self.assertEqual(self.basis[AE_SYSTEM_OIL]["daily_budget_rate"], 15)

    def test_dht_colt_ae_days_365(self):
        self.assertEqual(self.basis[AE_SYSTEM_OIL]["applicable_days_per_year"], 365)

    def test_dht_colt_ae_annual_5475(self):
        self.assertEqual(annual_allowance(self.basis[AE_SYSTEM_OIL]), 5475)

    def test_budget_year_does_not_auto_roll_forward(self):
        self.assertEqual(self.repo.budget_basis(COLT, 2027), [])
        self.assertEqual(self.repo.reference_prices(COLT, 2027), [])
        _, result = performance([report("2027-01")], "2027-01", self.repo.budget_basis(COLT, 2027),
                                self.repo.reference_prices(COLT, 2027), 2027)
        self.assertEqual(result["status"], NOT_CONFIGURED)
        # Rows from another year are ignored even if handed in.
        rows, result = performance([report("2027-01")], "2027-01", BASIS, PRICES, 2027)
        self.assertEqual(result["status"], NOT_CONFIGURED)
        self.assertIsNone(rows[ME_CYLINDER_OIL]["original"])

    def test_source_traceability(self):
        for row in self.basis.values():
            self.assertIn("2026", row["source_reference"])
        prices = {p["oil_category"]: p for p in self.repo.reference_prices(COLT, 2026)}
        self.assertEqual(prices[ME_CYLINDER_OIL]["reference_price_per_litre"], 1.59)
        self.assertEqual(prices[ME_SYSTEM_OIL]["reference_price_per_litre"], 1.18)
        self.assertNotIn(AE_SYSTEM_OIL, prices)  # no AE price exists in the source workbook
        self.assertIn("LO Expense analysis", prices[ME_CYLINDER_OIL]["source_reference"])
        self.assertEqual(prices[ME_CYLINDER_OIL]["price_basis"], "Singapore")

    def test_price_change_is_versioned_not_overwritten(self):
        self.repo.set_reference_price(COLT, 2026, ME_CYLINDER_OIL, 1.65, "Test revision")
        current = {p["oil_category"]: p for p in self.repo.reference_prices(COLT, 2026)}
        self.assertEqual(current[ME_CYLINDER_OIL]["reference_price_per_litre"], 1.65)
        from suite_services.database import connection
        with connection(self.repo.root) as db:
            history = db.execute("SELECT reference_price_per_litre, effective_to FROM oil_consumption_reference_price "
                                 "WHERE oil_category=? ORDER BY id", (ME_CYLINDER_OIL,)).fetchall()
            audit = db.execute("SELECT COUNT(*) FROM master_data_audit").fetchone()[0]
        self.assertEqual([h[0] for h in history], [1.59, 1.65])
        self.assertIsNotNone(history[0][1])
        self.assertEqual(audit, 1)

    def test_comment_user_and_timestamp(self):
        self.repo.add_comment(COLT, "2026-YTD-2026-09", "AE1 complete sump-oil renewal.", "SUMP_RENEWAL", AE_SYSTEM_OIL)
        comment = self.repo.comments(COLT, "2026-YTD-2026-09")[0]
        self.assertTrue(comment["created_by"])
        self.assertTrue(comment["created_at"])
        self.assertEqual(comment["oil_category"], AE_SYSTEM_OIL)
        with self.assertRaises(ValueError):
            self.repo.add_comment(COLT, "2026-YTD-2026-09", "   ")


class RegisterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Repository(Path(self.temp.name))

    def tearDown(self):
        self.temp.cleanup()

    def test_register_lists_every_master_vessel_year_wise(self):
        rows = {r["vessel"]: r for r in self.repo.register(2026)}
        self.assertIn("DHT NOKOTA", rows)  # in the vessel master even without reports
        self.assertEqual(len(rows[COLT]["basis"]), 3)
        self.assertEqual(rows["DHT NOKOTA"]["basis"], {})
        self.assertEqual({r["vessel"]: r["basis"] for r in self.repo.register(2027)}[COLT], {})

    def test_basis_is_entered_per_year(self):
        self.repo.set_budget_basis(COLT, 2027, ME_CYLINDER_OIL, 430, 250, "2027 budget approval")
        self.assertEqual(self.repo.budget_basis(COLT, 2027)[0]["annual_budget_quantity"], 430 * 250)
        cylinder_2026 = next(b for b in self.repo.budget_basis(COLT, 2026) if b["oil_category"] == ME_CYLINDER_OIL)
        self.assertEqual(cylinder_2026["daily_budget_rate"], 425)

    def test_tank_register_add_edit_retire(self):
        tank_id = self.repo.save_tank(COLT, "LO-1", "Cyl oil storage tank (P)", "ME_CYLINDER_OIL_HIGH_BN", 60000, 55000,
                                      "Capacity plan", minimum_rob=5000)
        self.repo.save_tank(COLT, "LO-2", "Cyl oil storage tank (S)", "ME_CYLINDER_OIL_HIGH_BN", 40000, 38000, "Capacity plan")
        self.repo.save_tank(COLT, "LO-1", "Cyl oil storage tank (P)", "ME_CYLINDER_OIL_HIGH_BN", 60000, 56000,
                            "Capacity plan rev B", tank_id=tank_id)
        tanks = self.repo.tanks(COLT)
        self.assertEqual(sum(t["usable_capacity"] for t in tanks), 94000)
        fill = analytics.tank_fill(47000, tanks)
        self.assertAlmostEqual(fill["percent"], 50)
        self.assertEqual(fill["tanks"], 2)
        self.repo.retire_tank(COLT, tank_id, "Converted to other service")
        self.assertEqual([t["tank_identifier"] for t in self.repo.tanks(COLT)], ["LO-2"])
        self.assertEqual(len(self.repo.tanks(COLT, current_only=False)), 2)  # kept in history
        with self.assertRaises(ValueError):
            self.repo.save_tank(COLT, "LO-3", "Bad", "ME_SYSTEM_OIL", 100, 200, "x")  # usable > physical

    def test_tank_fill_unavailable_without_tanks_or_rob(self):
        self.assertIsNone(analytics.tank_fill(1000, []))
        self.assertIsNone(analytics.tank_fill(None, [dict(usable_capacity=100)]))

    def test_full_charge_parameter_is_versioned(self):
        self.assertIsNone(self.repo.parameter(COLT, "ME_SYSTEM_OIL_FULL_CHARGE"))
        self.repo.set_parameter(COLT, "ME_SYSTEM_OIL_FULL_CHARGE", 39800, "Chief engineer, Oct 2026 sheet")
        self.repo.set_parameter(COLT, "ME_SYSTEM_OIL_FULL_CHARGE", 40000, "Engine manual")
        self.assertEqual(self.repo.parameter(COLT, "ME_SYSTEM_OIL_FULL_CHARGE")["value"], 40000)
        history = self.repo.master_history()
        self.assertEqual(history[0]["record_key"], f"{COLT}|ME_SYSTEM_OIL_FULL_CHARGE")
        with self.assertRaises(ValueError):
            self.repo.set_parameter(COLT, "ME_SYSTEM_OIL_FULL_CHARGE", 40000, "  ")


class AliasTests(unittest.TestCase):
    def test_cc_oil_maps_to_me_system(self):
        self.assertEqual(oil_group("C/C OIL"), "System oil · ME")

    def test_mecc_maps_to_me_system(self):
        self.assertEqual(oil_group("MECC"), "System oil · ME")

    def test_me_crankcase_maps_to_me_system(self):
        self.assertEqual(oil_group("MAIN ENGINE CRANKCASE OIL"), "System oil · ME")
        self.assertEqual(oil_group("ME CRANKCASE OIL"), "System oil · ME")

    def test_system_oil_me_maps_to_me_system(self):
        for heading in ("SYSTEM OIL M/E", "ME SYSTEM OIL", "MAIN ENGINE SYSTEM OIL"):
            self.assertEqual(budget_category(oil_group(heading)), ME_SYSTEM_OIL)


class ActivityTests(unittest.TestCase):
    def test_reference_workbook_dht_colt_activity(self):
        """DHT Vessels - LO Expense analysis.xlsx, DHT Colt: 939 h over 4,320 h budget through September."""
        basis = BASIS[0]
        months = [f"2026-{m:02}" for m in range(1, 10)]
        result = activity_variance(basis, 5259, months)
        self.assertEqual(result["budget_hours"], 4320)
        self.assertAlmostEqual(result["day_variance"], 39.125)
        self.assertAlmostEqual(result["quantity"], 16628.125)
        self.assertAlmostEqual(consumption_cost(result["quantity"], 1.59), 26438.71875)
        mecc = activity_variance(BASIS[1], 5259, months)
        self.assertAlmostEqual(mecc["quantity"], 2934.375)
        self.assertAlmostEqual(consumption_cost(mecc["quantity"], 1.18), 3462.5625)
        self.assertEqual(period_allowance(basis, months), 76500)

    def test_additional_me_hours_create_activity_variance(self):
        rows, _ = performance([report("2026-01", me_hours=600)])
        cylinder = rows[ME_CYLINDER_OIL]
        self.assertAlmostEqual(cylinder["activity"]["hour_variance"], 120)
        self.assertAlmostEqual(cylinder["activity"]["day_variance"], 5)
        self.assertAlmostEqual(cylinder["activity"]["quantity"], 5 * 425)
        self.assertAlmostEqual(rows[ME_SYSTEM_OIL]["activity"]["quantity"], 5 * 75)

    def test_activity_variance_not_technical_variance(self):
        # Consumption exactly at the activity-adjusted level: all variance is activity, none technical.
        adjusted = 102000 / 12 + 5 * 425
        rows, _ = performance([report("2026-01", me_hours=600, high=adjusted - 400, low=400)])
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["technical"], 0)
        self.assertGreater(rows[ME_CYLINDER_OIL]["activity"]["quantity"], 0)

    def test_activity_adjusted_expected_consumption(self):
        rows, _ = performance([report("2026-01", me_hours=600)])
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["original"], 8500)
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["adjusted"], 8500 + 2125)

    def test_actual_above_adjusted_creates_efficiency_variance(self):
        rows, _ = performance([report("2026-01", me_hours=480, high=9600, low=400)])
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["technical"], 10000 - 8500)
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["costs"]["technical"], 1500 * 1.59)

    def test_ae_never_uses_me_days(self):
        rows, _ = performance([report("2026-01", me_hours=700)])
        self.assertIsNone(rows[AE_SYSTEM_OIL]["activity"])
        self.assertEqual(rows[AE_SYSTEM_OIL]["adjusted"], rows[AE_SYSTEM_OIL]["original"])

    def test_ae_15_lpd_is_vessel_level_not_per_engine(self):
        rows, _ = performance([report("2026-01")])
        self.assertEqual(rows[AE_SYSTEM_OIL]["original"], 15 * 31)

    def test_high_bn_plus_low_bn_rollup(self):
        rows, _ = performance([report("2026-01", high=8000, low=400)])
        cylinder = rows[ME_CYLINDER_OIL]
        self.assertEqual(cylinder["actual"], 8400)
        self.assertEqual([s["actual"] for s in cylinder["sub"]], [8000, 400])
        self.assertEqual(cylinder["original"], 8500)  # 425 L/day budget applies to the total, not to High BN


class ReportControlTests(unittest.TestCase):
    def test_missing_month_not_zero(self):
        rows, result = performance([report("2026-01"), report("2026-03")], "2026-03")
        cylinder = rows[ME_CYLINDER_OIL]
        self.assertEqual(cylinder["covered"], ["2026-01", "2026-03"])
        self.assertIn(("2026-02", "No report in use"), cylinder["missing"])
        self.assertEqual(cylinder["actual"], 16800)
        self.assertEqual(cylinder["original"], 102000 * 2 / 12)  # the missing month adds no allowance either

    def test_missing_month_not_interpolated(self):
        rows, _ = performance([report("2026-01"), report("2026-03")], "2026-03")
        self.assertEqual(rows[ME_SYSTEM_OIL]["actual"], 3200)
        blank = report("2026-02", me_all=None)
        blank["data"]["inventory"][0]["all_in"] = None
        rows, _ = performance([report("2026-01"), blank], "2026-02")
        self.assertIn(("2026-02", "Consumption blank or invalid"), rows[ME_SYSTEM_OIL]["missing"])
        self.assertEqual(rows[ME_SYSTEM_OIL]["actual"], 1600)

    def test_superseded_report_not_used(self):
        rows, _ = performance([report("2026-01", high=1, active=False)])
        self.assertIsNone(rows[ME_CYLINDER_OIL]["actual"])


class AETests(unittest.TestCase):
    def test_confirmed_sump_renewal_detection(self):
        month = report("2026-06", ae_routine=740, ae_loss=1350,
                       events=[dict(engine="AE1", date="2026-06-09", event_type="CONFIRMED_RENEWAL")])
        split = ae_month_breakdown(month)
        self.assertEqual(split["classification"], "CONFIRMED_SUMP_RENEWAL")
        self.assertEqual(split["confirmed"], 1350)

    def test_probable_renewal_not_automatically_excluded(self):
        month = report("2026-04", ae_routine=910, ae_loss=1300,
                       events=[dict(engine="AE3", date="2026-04-08", event_type="PROBABLE_RENEWAL")])
        split = ae_month_breakdown(month)
        self.assertEqual(split["classification"], "PROBABLE_SUMP_RENEWAL")
        self.assertEqual(split["normal"], 2210)

    def test_old_event_repeated_in_sheet_is_not_reclassified(self):
        month = report("2026-02", ae_routine=325, ae_loss=2500,
                       events=[dict(engine="AE3", date="2025-12-05", event_type="CONFIRMED_RENEWAL")])
        self.assertEqual(ae_month_breakdown(month)["classification"], "UNCLASSIFIED_LOSS")

    def test_all_in_ae_consumption(self):
        rows, _ = performance(self._reports(), "2026-02")
        self.assertEqual(rows[AE_SYSTEM_OIL]["actual"], 500 + 740 + 1350)
        self.assertEqual(rows[AE_SYSTEM_OIL]["ae"]["total"], 2590)

    def test_normal_operating_ae_consumption(self):
        rows, _ = performance(self._reports(), "2026-02")
        self.assertEqual(rows[AE_SYSTEM_OIL]["ae"]["normal"], 2590 - 1350)

    def test_sump_renewal_separate_from_routine(self):
        rows, _ = performance(self._reports(), "2026-02")
        ae = rows[AE_SYSTEM_OIL]["ae"]
        self.assertEqual((ae["routine"], ae["confirmed"]), (1240, 1350))

    def test_sump_renewal_has_consumption_cost(self):
        rows, _ = performance(self._reports(), "2026-02")
        costs = rows[AE_SYSTEM_OIL]["costs"]
        self.assertAlmostEqual(costs["confirmed"], 1350 * 2.0)
        self.assertAlmostEqual(costs["routine"], 1240 * 2.0)
        self.assertAlmostEqual(costs["actual"], 2590 * 2.0)

    @staticmethod
    def _reports():
        return [report("2026-01"), report("2026-02", ae_routine=740, ae_loss=1350,
                                          events=[dict(engine="AE1", date="2026-02-09", event_type="CONFIRMED_RENEWAL")])]


class CostTests(unittest.TestCase):
    def test_zero_consumption_zero_cost(self):
        self.assertEqual(consumption_cost(0, None), 0)
        self.assertEqual(consumption_cost(0, 1.59), 0)

    def test_receipt_without_consumption_zero_cost(self):
        rows, _ = performance([report("2026-01", high=0, low=0, receipts=20000)])
        self.assertEqual(rows[ME_CYLINDER_OIL]["costs"]["actual"], 0)

    def test_consumption_without_receipt_has_cost(self):
        rows, _ = performance([report("2026-01", high=5000, low=0, receipts=0)])
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["costs"]["actual"], 5000 * 1.59)

    def test_consumption_cost_equals_quantity_times_reference_price(self):
        rows, _ = performance([report("2026-01", me_all=1600)])
        self.assertAlmostEqual(rows[ME_SYSTEM_OIL]["costs"]["actual"], 1600 * 1.18)
        self.assertAlmostEqual(rows[ME_SYSTEM_OIL]["costs"]["original"], 1500 * 1.18)

    def test_activity_cost_from_activity_quantity(self):
        rows, _ = performance([report("2026-01", me_hours=600)])
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["costs"]["activity"], 2125 * 1.59)

    def test_efficiency_cost_from_efficiency_quantity(self):
        rows, _ = performance([report("2026-01", me_hours=600, high=11000, low=0)])
        cylinder = rows[ME_CYLINDER_OIL]
        self.assertAlmostEqual(cylinder["costs"]["technical"], cylinder["technical"] * 1.59)

    def test_grade_specific_prices_sum_for_cylinder_total(self):
        prices = PRICES + [dict(budget_year=2026, oil_category=ME_CYLINDER_OIL, oil_grade="Cylinder oil · Low TBN",
                                reference_price_per_litre=2.0, currency="USD")]
        rows, _ = performance([report("2026-01", high=8000, low=400)], prices=prices)
        self.assertAlmostEqual(rows[ME_CYLINDER_OIL]["costs"]["actual"], 8000 * 1.59 + 400 * 2.0)

    def test_missing_price_is_pending_not_zero(self):
        rows, _ = performance([report("2026-01")], prices=[])
        self.assertIsNone(rows[ME_CYLINDER_OIL]["costs"]["actual"])

    def test_supporting_lubricants_excluded_from_primary_cost(self):
        self.assertIsNone(budget_category("Hydraulic oil"))
        light, heavy = performance([report("2026-01", hydraulic=10)])[0], performance([report("2026-01", hydraulic=9999)])[0]
        for category in (ME_SYSTEM_OIL, ME_CYLINDER_OIL, AE_SYSTEM_OIL):
            self.assertEqual(light[category]["actual"], heavy[category]["actual"])


class YearToDateTests(unittest.TestCase):
    """The budget year starts on 1 January; the Overview cards use the Budget Performance figures."""

    def setUp(self):
        self.reports = [report(m) for m in ("2025-11", "2025-12", "2026-01", "2026-02", "2026-03")]
        self.reports[3] = report("2026-02", me_hours=600.0)

    def test_ytd_starts_on_1_january(self):
        rows, result = performance(self.reports, end="2026-03")
        self.assertEqual(result["months"], ["2026-01", "2026-02", "2026-03"])
        self.assertEqual(rows[ME_SYSTEM_OIL]["actual"], 3 * 1600)

    def test_ytd_in_january_is_one_month(self):
        _, result = performance(self.reports, end="2026-01")
        self.assertEqual(result["months"], ["2026-01"])

    def test_cards_match_budget_performance(self):
        rows, _ = performance(self.reports, end="2026-03")
        cards = budget.card_budget(self.reports, COLT, "2026-03", BASIS, PRICES)
        for category in (ME_SYSTEM_OIL, ME_CYLINDER_OIL, AE_SYSTEM_OIL):
            for key in ("actual", "adjusted", "technical", "technical_percent"):
                self.assertEqual(cards["categories"][category][key], rows[category][key])
        cylinder = cards["categories"][ME_CYLINDER_OIL]
        self.assertEqual(budget.group_ytd_actual(cylinder, "Cylinder oil · High TBN"), 3 * 8000)
        self.assertEqual(budget.group_ytd_actual(cylinder, "Cylinder oil · Low TBN"), 3 * 400)
        self.assertEqual(budget.group_ytd_actual(cards["categories"][ME_SYSTEM_OIL], "System oil · ME"), 3 * 1600)

    def test_bar_month_against_its_own_hours_adjusted_allowance(self):
        cards = budget.card_budget(self.reports, COLT, "2026-03", BASIS, PRICES, detail_months=["2026-02"])
        month = cards["monthly"]["2026-02"][ME_SYSTEM_OIL]
        self.assertEqual(month["months"], ["2026-02"])
        # 75 L/day x 240/12 days = 1,500 L, plus 120 extra hours = 5 days x 75 = 375 L.
        self.assertAlmostEqual(month["adjusted"], 1875)
        self.assertEqual(month["actual"], 1600)

    def test_bar_month_in_unconfigured_year_is_not_budgeted(self):
        cards = budget.card_budget(self.reports, COLT, "2026-03", BASIS, PRICES, detail_months=["2025-12"])
        month = cards["monthly"]["2025-12"][ME_SYSTEM_OIL]
        self.assertFalse(month["configured"])
        self.assertIsNone(month["adjusted"])

    def test_missing_basis_ytd_is_none_not_zero(self):
        cards = budget.card_budget(self.reports, COLT, "2026-03", [], [])
        row = cards["categories"][ME_SYSTEM_OIL]
        self.assertIsNone(row["adjusted"])
        self.assertEqual(budget.group_ytd_actual(row, "System oil · ME"), 3 * 1600)


class ScopeTests(unittest.TestCase):
    SOURCES = [Path(analytics.__file__), Path(budget.__file__)]

    def text(self):
        return "\n".join(path.read_text(encoding="utf-8").lower() for path in self.SOURCES)

    def test_no_procurement_cost_logic(self):
        self.assertFalse(hasattr(analytics, "purchase_scenario"))
        for word in ("supplier", "invoice_allocation", "purchase_cost", "inventory_value"):
            self.assertNotIn(word, self.text())

    def test_no_price_variance(self):
        self.assertNotIn("price_variance", self.text())

    def test_no_fifo_or_weighted_average(self):
        for word in ("fifo", "lifo", "weighted_average_cost"):
            self.assertNotIn(word, self.text())

    def test_no_240_250_260_scenarios(self):
        for word in ("scenario", "250-day", "260-day", "sensitivity"):
            self.assertNotIn(word, self.text())


if __name__ == "__main__":
    unittest.main()
