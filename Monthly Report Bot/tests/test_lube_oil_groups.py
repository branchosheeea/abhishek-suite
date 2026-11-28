"""Primary bulk grades and grouped secondary oils."""
import unittest

from lube_oil.analytics import group_monthly_trend, monthly_analysis, oil_group


def report(month, hydraulic, active=True, grease=5, steering=10):
    return dict(
        id=month, month=month, vessel="DHT COLT", is_active=active,
        confirmed_at="reviewed" if active else None, validation_status="PASS",
        data={"inventory": [
            dict(category="SYSTEM OIL M/E", grade="VERITAS 800", unit="L", withdrawal=2000, operating=1900, change_loss=0),
            dict(category="CYL.OIL HIGH TBN  100 / 70", grade="TARO ULTRA 100", unit="L", withdrawal=12000, operating=None),
            dict(category="HYDR. OIL STEER. GEAR", grade="RANDO HDZ 68", unit="L", withdrawal=steering, operating=None),
            dict(category="HYDR. OIL DECK CRANE", grade="RANDO HDZ 32", unit="L", withdrawal=hydraulic, operating=None),
            dict(category="GREASE", grade="MARFAK", unit=None, withdrawal=grease, operating=None),
            dict(category="WIRE  ROPES  EAL", grade="Navigrease Bio 2", unit="L", withdrawal=grease, operating=None),
        ], "engines": [], "issues": []},
    )


class OilGroupTests(unittest.TestCase):
    def test_observed_workbook_headings_map_to_groups(self):
        expected = {
            "CYL. OIL LOW TBN 40 / 25": "Cylinder oil · Low TBN",
            "CYL.OIL HIGH TBN  100 / 70": "Cylinder oil · High TBN",
            "CYL OIL HTBN": "Cylinder oil · High TBN",
            "SYSTEM OIL M/E": "System oil · ME",
            "SYSTEM OIL A/E": "System oil · AE",
            "HYDR. OIL STEER. GEAR": "Hydraulic oil",
            "HYDR OIL OTHERS": "Hydraulic oil",
            "GEAR OIL PURIFIER": "Gear oil",
            "COMPR.OIL": "Compressor oil",
            "SERVICE AIR COMPRESSOR": "Compressor oil",
            "A/C COMP": "Refrigeration oil",
            "REFRIGE-RATION  OIL": "Refrigeration oil",
            "TURBO CHARGER OIL": "Turbocharger oil",
            "STERN TUBE": "Stern tube oil",
            "RUDDER GREASE": "Grease",
            # Reported in litres: Other / EAL, never added to grease.
            "WIRE  ROPES  EAL": "Other oils",
            "SOMETHING NEW": "Other oils",
        }
        for heading, group in expected.items():
            with self.subTest(heading=heading):
                self.assertEqual(oil_group(heading), group)

    def test_primary_grades_lead_and_secondary_oils_are_grouped(self):
        reports = [report("2026-01", 20), report("2026-02", 30), report("2026-03", 40), report("2026-04", 60, active=False)]
        vessel = monthly_analysis(reports, "2026-04", windows=(3,))["vessels"][0]
        # Locked order: ME system oil, cylinder high BN, cylinder low BN, AE system oil.
        self.assertEqual([oil["group"] for oil in vessel["bulk_oils"][:2]],
                         ["System oil · ME", "Cylinder oil · High TBN"])
        self.assertTrue(all(oil["primary"] for oil in vessel["bulk_oils"][:2]))
        groups = {group["group"]: group for group in vessel["oil_groups"]}
        self.assertEqual(list(groups), ["Hydraulic oil", "Grease", "Other oils"])
        self.assertEqual(groups["Hydraulic oil"]["monthly_consumption"], 70)
        # Steering gear 10 L + deck crane 20/30/40 L in the prior three months.
        self.assertAlmostEqual(groups["Hydraulic oil"]["comparisons"][3]["average_consumption"], 40)
        self.assertAlmostEqual(groups["Hydraulic oil"]["comparisons"][3]["change_percent"], 75)
        self.assertIsNone(groups["Grease"]["unit"])

    def test_blank_heading_makes_group_unavailable_not_zero(self):
        reports = [report("2026-01", None), report("2026-02", 30)]
        vessel = monthly_analysis(reports, "2026-02", windows=(1,))["vessels"][0]
        hydraulic = next(group for group in vessel["oil_groups"] if group["group"] == "Hydraulic oil")
        self.assertEqual(hydraulic["comparisons"][1]["coverage"], 0)
        trend = group_monthly_trend(reports, reports[-1], "2026-01", "2026-02", group="Hydraulic oil")
        self.assertIsNone(trend["history"][0]["value"])
        self.assertEqual(trend["history"][0]["state"], "quantity_missing")
        self.assertIn("DECK CRANE", trend["history"][0]["reason"])

    def test_single_heading_trend_and_confirmed_baseline(self):
        reports = [report("2026-01", 20, steering=10), report("2026-02", 20, steering=30, active=False),
                   report("2026-03", 20, steering=40, active=False)]
        trend = group_monthly_trend(reports, reports[-1], "2026-01", "2026-03", category="HYDR. OIL STEER. GEAR")
        self.assertEqual([p["value"] for p in trend["history"]], [10, 30, 40])
        self.assertEqual(trend["average_consumption"], 10)
        self.assertEqual(trend["coverage"], 1)
        self.assertIsNone(trend["change_percent"])
        self.assertEqual(trend["reference_average_consumption"], 20)


class DashboardTests(unittest.TestCase):
    def month_report(self, month, closing, withdrawal, active=True, change_loss=None):
        return dict(
            id=month, month=month, vessel="DHT COLT", is_active=active, confirmed_at="x" if active else None,
            validation_status="WARNING",
            data={"inventory": [
                dict(category="CYL.OIL HIGH TBN  100 / 70", grade="TARO ULTRA 100", unit="L", opening=closing + withdrawal,
                     receipts=0, withdrawal=withdrawal, closing=closing),
                dict(category="SYSTEM OIL A/E", grade="TARO 30", unit="L", opening=100, receipts=0, withdrawal=50,
                     closing=50, operating=40, change_loss=change_loss),
                dict(category="GEAR OIL", grade="MEROPA 220", unit="L", withdrawal=5),
            ], "engines": [], "issues": [],
                "events": [dict(engine="AE1", date=f"{month}-10", event_type="PROBABLE_RENEWAL")]},
        )

    def test_margin_gaps_and_inactive_reports(self):
        from lube_oil.analytics import dashboard
        reports = [self.month_report("2026-01", 9000, 1000), self.month_report("2026-03", 6000, 2000),
                   self.month_report("2026-02", 1, 1, active=False)]
        data = dashboard(reports, "DHT COLT", "2026-03", months=3)
        high = next(g for g in data["grades"] if g["group"] == "Cylinder oil · High TBN")
        self.assertEqual(data["coverage"], 2)
        self.assertEqual(high["closing_series"], [9000, None, 6000])
        self.assertEqual(high["closing"], 6000)
        self.assertEqual(high["opening"], 10000)
        self.assertEqual(high["withdrawn"], 3000)
        # A missing month blocks the 3-month average; with no budget rate there is no margin, not a guess.
        self.assertIsNone(high["margin"])
        self.assertEqual(high["status"], "No data")
        budgeted = dashboard(reports, "DHT COLT", "2026-03", months=3,
                             budget_monthly={"Cylinder oil · High TBN": 1500})
        high = next(g for g in budgeted["grades"] if g["group"] == "Cylinder oil · High TBN")
        self.assertAlmostEqual(high["margin"], 4)
        # Cylinder oil has no "Below minimum" band: 4 months is OK.
        self.assertEqual((high["margin_basis"], high["status"]), ("approved budget rate", "OK"))
        self.assertIsNone(high["reserve"])
        complete = dashboard(reports[:2] + [self.month_report("2026-02", 7000, 4000)], "DHT COLT", "2026-03", months=3)
        high = next(g for g in complete["grades"] if g["group"] == "Cylinder oil · High TBN")
        self.assertAlmostEqual(high["margin"], 6000 / ((1000 + 4000 + 2000) / 3))
        self.assertEqual(high["margin_basis"], "3-month normal average")
        self.assertEqual(high["status"], "Alarm")
        self.assertEqual(data["ae"]["operating"], [40, None, 40])
        self.assertEqual(data["ae"]["change_loss"], [None, None, None])
        self.assertEqual(data["ae"]["probable"], 2)
        gear = data["support"][0]
        self.assertEqual((gear["group"], gear["total"], gear["months"]), ("Gear oil", 10, 2))


class SafetyMarginTests(unittest.TestCase):
    """ME system oil: (storage ROB - one full charge) / monthly routine use; one charge = 80% of sump capacity."""

    ROUTINE = {"2026-06": 2000, "2026-07": 2000, "2026-08": 2000, "2026-09": 0, "2026-10": 3500, "2026-11": 2000}

    def me_report(self, month, routine, closing, total="same"):
        return dict(
            id=month, month=month, vessel="DHT STALLION", is_active=True, validation_status="WARNING",
            data={"inventory": [dict(category="SYSTEM OIL M/E", grade="VERITAS 800 A MARINE 30", unit="L",
                                     operating=routine, change_loss=0, all_in=routine if total == "same" else total,
                                     withdrawal=routine, closing=closing)],
                  "engines": [], "issues": [], "events": []},
        )

    def me(self, closing=34700, capacity=42500, budget=None, routine=None):
        from lube_oil.analytics import dashboard
        routine = routine or self.ROUTINE
        # September's D+E total is blank on the real sheet; routine (D) is still 0.
        reports = [self.me_report(m, d, closing if m == "2026-11" else 40000, total=None if m == "2026-09" else "same")
                   for m, d in routine.items()]
        data = dashboard(reports, "DHT STALLION", "2026-11", months=6, me_sump_capacity=capacity,
                         budget_monthly=budget)
        return next(g for g in data["grades"] if g["group"] == "System oil · ME")

    def test_reserve_is_deducted_and_routine_rate_used(self):
        me = self.me()
        rate = 11500 / 6
        self.assertAlmostEqual(me["margin_rate"], rate)
        self.assertEqual(me["margin_basis"], "6-month normal average")
        self.assertEqual(me["reserve"], 34000)
        self.assertAlmostEqual(me["margin"], 700 / rate)
        self.assertEqual(me["status"], "Danger")
        self.assertAlmostEqual(me["minimum_rob"], 34000 + 4 * rate)
        self.assertAlmostEqual(me["order_to_minimum"], 34000 + 4 * rate - 34700)
        self.assertAlmostEqual(me["margin_days"], 700 / rate * 30.4)
        self.assertEqual(str(me["reserve_date"]), "2026-12-11")

    def test_bands(self):
        rate = 11500 / 6
        for months, status in ((4, "OK"), (3.99, "Below minimum"), (3, "Below minimum"), (2.99, "Alarm"),
                               (1, "Alarm"), (0.99, "Danger"), (-0.5, "Danger")):
            with self.subTest(months=months):
                self.assertEqual(self.me(closing=34000 + months * rate)["status"], status)

    def test_into_reserve_is_negative_and_danger(self):
        me = self.me(closing=30000)
        self.assertLess(me["margin"], 0)
        self.assertEqual(me["status"], "Danger")

    def test_no_sump_capacity_means_no_margin_and_no_alarm(self):
        me = self.me(capacity=None)
        self.assertIsNone(me["margin"])
        self.assertIsNone(me["reserve"])
        self.assertEqual(me["status"], "Sump capacity not set")

    def test_missing_routine_month_falls_back_to_budget(self):
        routine = dict(self.ROUTINE, **{"2026-10": None})
        me = self.me(routine=routine, budget={"System oil · ME": 1500})
        self.assertEqual(me["margin_basis"], "approved budget rate")
        self.assertAlmostEqual(me["margin"], 700 / 1500)

    def test_margin_status_without_reserve_for_other_grades(self):
        from lube_oil.analytics import margin_status
        self.assertEqual(margin_status(3.5, "Cylinder oil · High TBN"), "OK")
        self.assertEqual(margin_status(3.5, "System oil · ME"), "Below minimum")
        self.assertEqual(margin_status(None, "System oil · AE"), "No data")


if __name__ == "__main__":
    unittest.main()
