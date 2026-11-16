"""Fleet and vessel-group comparison for the three budget categories.

Every figure is built from the reports in use, vessel by vessel, then summed:
- a missing vessel-month is never zero; coverage (vessel-months reported) travels with every total;
- L/24h is the same figure as the vessel cards: the sheet's own rate, running-hours weighted over the period
  (analytics.weighted_rate). ME system oil and cylinder oil only; a month without rate or hours is left out;
- budget variance is year to date and comes from budget_performance, so a vessel's row always matches
  its own Budget Performance page; the fleet budget sums configured vessels only.
"""
from __future__ import annotations

from .analytics import period_months, weighted_rate  # noqa: F401  (period_months re-exported)
from .budget import (
    BUDGET_CATEGORIES, CATEGORY_GROUPS, ME_CYLINDER_OIL, ME_SYSTEM_OIL, _sub_quantity, budget_performance,
)

# The sheet reports one ME system-oil rate and one cylinder-oil rate (High + Low BN together).
CATEGORY_RATE_FIELD = {ME_SYSTEM_OIL: "rate", ME_CYLINDER_OIL: "cylinder_rate"}


def _vessel(report):
    return report.get("vessel") or report.get("data", {}).get("vessel")


def vessel_category(by_month, months, category):
    """One vessel, one category: litres per reported month, totals and the running-hour rate."""
    groups = CATEGORY_GROUPS[category]
    values, subs = {}, {group: 0.0 for group in groups}
    for month in months:
        report = by_month.get(month)
        if report is None:
            continue
        quantities = {group: _sub_quantity(report, group) for group in groups}
        if not any(present for _, present in quantities.values()):
            continue  # category not on this sheet
        if any(value is None for value, _ in quantities.values()):
            continue  # blank or invalid consumption: unknown, not zero
        litres = sum(value for value, _ in quantities.values())
        values[month] = litres
        for group, (value, _) in quantities.items():
            subs[group] += value
    reported = bool(values)
    rate = weighted_rate(by_month, months, CATEGORY_RATE_FIELD.get(category))
    return dict(
        by_month=values, months=sorted(values), total=round(sum(values.values()), 3) if reported else None,
        sub={group: round(value, 3) if reported else None for group, value in subs.items()},
        rate=rate["rate"], rate_months=len(rate["months"]), rate_flagged=rate["flagged"],
    )


def fleet_comparison(reports, vessels, end_month, months, basis_by_vessel, prices_by_vessel):
    """Per-vessel rows and fleet totals for the vessels in scope (all vessels, or a user group)."""
    window = period_months(end_month, months)
    year = int(end_month[:4])
    active = {}
    for report in reports:
        if report.get("is_active") and report.get("validation_status") != "FAIL" and report.get("month"):
            active.setdefault(_vessel(report), {})[report["month"]] = report

    rows = []
    for vessel in vessels:
        by_month = active.get(vessel, {})
        perf = budget_performance(reports, vessel, year, end_month, basis_by_vessel.get(vessel, []),
                                  prices_by_vessel.get(vessel, []))
        budget_rows = {row["category"]: row for row in perf["categories"]}
        categories = {}
        for category in BUDGET_CATEGORIES:
            figures = vessel_category(by_month, window, category)
            row = budget_rows[category]
            figures["budget"] = dict(
                configured=row["configured"], actual=row["actual"], adjusted=row["adjusted"],
                technical=row["technical"], percent=row["technical_percent"],
                covered=len(row["covered"]), months=len(row["months"]),
            )
            categories[category] = figures
        rows.append(dict(vessel=vessel, reported=[m for m in window if m in by_month], categories=categories))

    totals = {}
    for category in BUDGET_CATEGORIES:
        figures = [row["categories"][category] for row in rows]
        known = [f["total"] for f in figures if f["total"] is not None]
        sub = {}
        for group in CATEGORY_GROUPS[category]:
            parts = [f["sub"][group] for f in figures if f["sub"][group] is not None]
            sub[group] = round(sum(parts), 3) if parts else None
        monthly = []
        for month in window:
            parts = [f["by_month"][month] for f in figures if month in f["by_month"]]
            monthly.append(dict(month=month, total=round(sum(parts), 3) if parts else None, vessels=len(parts)))
        budgets = [f["budget"] for f in figures if f["budget"]["configured"] and f["budget"]["adjusted"] is not None]
        budget = None
        if budgets:
            actual = sum(b["actual"] for b in budgets)
            adjusted = sum(b["adjusted"] for b in budgets)
            budget = dict(vessels=len(budgets), actual=actual, adjusted=adjusted, technical=actual - adjusted,
                          percent=(actual - adjusted) / adjusted * 100 if adjusted else None)
        run = [(f["rate"], f["rate_months"]) for f in figures if f["rate"] is not None]
        totals[category] = dict(
            total=round(sum(known), 3) if known else None, sub=sub, monthly=monthly,
            vessels_reporting=len(known), vessel_months=sum(len(f["months"]) for f in figures),
            possible=len(rows) * len(window), budget=budget, rate_vessels=len(run),
        )
    return dict(months=window, year=year, end_month=end_month, vessels=rows, totals=totals)
