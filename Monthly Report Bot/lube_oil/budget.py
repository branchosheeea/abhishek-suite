"""Budget performance for the three primary categories.

Quantity first, cost second:
  original allowance -> ME activity impact -> activity-adjusted expectation -> actual -> technical variance,
  then each quantity x the reference consumption price.

Cost exists only as a monetary representation of consumption. Receipts never create cost, zero
consumption is zero cost, and reference prices are not invoice, purchase or inventory values.
All inputs (budget basis, prices) are master data passed in by the caller; nothing here is vessel-specific.
"""
from __future__ import annotations
import calendar

from .analytics import AE_GROUP, ae_month_breakdown, month_shift, monthly_consumption, oil_group

ME_SYSTEM_OIL = "ME_SYSTEM_OIL"
ME_CYLINDER_OIL = "ME_CYLINDER_OIL"
AE_SYSTEM_OIL = "AE_SYSTEM_OIL"
BUDGET_CATEGORIES = (ME_SYSTEM_OIL, ME_CYLINDER_OIL, AE_SYSTEM_OIL)
CATEGORY_LABEL = {
    ME_SYSTEM_OIL: "ME System Oil",
    ME_CYLINDER_OIL: "ME Cylinder Oil · Total",
    AE_SYSTEM_OIL: "AE System Oil · Vessel total",
}
CATEGORY_GROUPS = {
    ME_SYSTEM_OIL: ("System oil · ME",),
    ME_CYLINDER_OIL: ("Cylinder oil · High TBN", "Cylinder oil · Low TBN"),
    AE_SYSTEM_OIL: (AE_GROUP,),
}
# Main-engine running hours drive these two. AE system oil never uses ME operating days.
ACTIVITY_DRIVEN = (ME_SYSTEM_OIL, ME_CYLINDER_OIL)
NOT_CONFIGURED = "BUDGET BASIS NOT CONFIGURED"


def budget_category(group):
    """Canonical budget category for a reporting group, or None for supporting lubricants (outside cost scope)."""
    return next((category for category, groups in CATEGORY_GROUPS.items() if group in groups), None)


def heading_category(heading):
    return budget_category(oil_group(heading))


def annual_allowance(basis):
    """Daily rate x applicable days. 425 L/day x 240 days, never x 365, when the approved basis is 240 days."""
    return basis["daily_budget_rate"] * basis["applicable_days_per_year"]


def _calendar_days(months):
    return sum(calendar.monthrange(*map(int, month.split("-")))[1] for month in months)


def period_allowance(basis, months):
    """Allowance for the reported months only.

    A full-year basis (365 days) accrues per calendar day. A part-year operating basis (e.g. 240 days)
    accrues pro rata by month, as in the reference LO Expense workbook (240 / 12 x months).
    """
    if basis["applicable_days_per_year"] >= 365:
        return basis["daily_budget_rate"] * _calendar_days(months)
    return annual_allowance(basis) * len(months) / 12


def budget_running_hours(basis, months):
    return basis["applicable_days_per_year"] / 12 * len(months) * 24


def activity_variance(basis, actual_hours, months):
    """Running-hour variance -> equivalent operating days -> litres at the approved daily rate."""
    budget_hours = budget_running_hours(basis, months)
    hours = actual_hours - budget_hours
    days = hours / 24
    return dict(actual_hours=actual_hours, budget_hours=budget_hours, hour_variance=hours,
                day_variance=days, quantity=days * basis["daily_budget_rate"])


def consumption_cost(quantity, price):
    """Consumed litres x reference price. Zero consumption is zero cost even without a price."""
    if quantity is None:
        return None
    if quantity == 0:
        return 0.0
    return None if price is None else quantity * price


def price_for(prices, category, group=None):
    """Grade-specific reference price first, then the category price."""
    rows = [p for p in prices if p["oil_category"] == category]
    exact = [p for p in rows if group and p.get("oil_grade") == group]
    general = [p for p in rows if not p.get("oil_grade")]
    chosen = (exact or general or [None])[-1]
    return chosen


def me_hours(report):
    """(hours, flag). Reported ME hours for the sheet's period.

    Hours above the calendar month are kept but flagged: the sheets' reporting periods need not align to
    calendar months, and consecutive periods still sum to the true running time. Negative or blank -> None.
    """
    if report.get("validation_status") == "FAIL":
        return None, None
    entry = next((e for e in report["data"].get("engines", []) if e.get("engine") == "ME"), None)
    hours = entry.get("hours") if entry else None
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or hours < 0:
        return None, None
    issue = next((i for i in report["data"].get("issues", []) if i.get("code") in ("hours:ME", "zero_hours:ME")), None)
    return float(hours), issue["title"] if issue else None


def _sub_quantity(report, group):
    """(value, present). A group absent from the sheet contributes nothing; a blank member makes it unknown."""
    present = any(oil_group(o.get("category")) == group for o in report["data"].get("inventory", []))
    return (monthly_consumption(report, group) if present else 0.0), present


def budget_performance(reports, vessel, year, end_month, basis_rows, price_rows, first_month=1):
    """Budget comparison for one vessel and one budget year, from reports in use.

    The budget year starts on 1 January, so the period is January to end_month (year to date).
    first_month narrows the start, e.g. to compare a single month with its own allowance.
    """
    year = int(year)
    if not end_month or int(end_month[:4]) != year:
        end_month = f"{year}-12"
    months = [f"{year}-{m:02}" for m in range(int(first_month), int(end_month[5:]) + 1)]
    by_month = {
        r["month"]: r for r in reports
        if (r.get("vessel") or r.get("data", {}).get("vessel")) == vessel
        and r.get("is_active") and r.get("validation_status") != "FAIL" and r.get("month")
    }
    # Never roll a basis or price forward from another year.
    basis_rows = [b for b in basis_rows if int(b["budget_year"]) == year]
    price_rows = [p for p in price_rows if int(p["budget_year"]) == year]
    reported = [m for m in months if m in by_month]
    rows = []
    for category in BUDGET_CATEGORIES:
        basis = next((b for b in basis_rows if b["oil_category"] == category), None)
        covered, missing, flagged, actual = [], [], [], 0.0
        subs = {group: 0.0 for group in CATEGORY_GROUPS[category]}
        hours = 0.0
        ae = dict(routine=0.0, confirmed=0.0, probable=0.0, unclassified=0.0, total=0.0, normal=0.0)
        for month in months:
            report = by_month.get(month)
            if report is None:
                missing.append((month, "No report in use"))
                continue
            values = {group: _sub_quantity(report, group) for group in CATEGORY_GROUPS[category]}
            if not any(present for _, present in values.values()):
                missing.append((month, "Category not on the sheet"))
                continue
            if any(value is None for value, _ in values.values()):
                missing.append((month, "Consumption blank or invalid"))
                continue
            month_hours, flag = me_hours(report) if category in ACTIVITY_DRIVEN else (0.0, None)
            if month_hours is None:
                missing.append((month, "ME running hours unavailable"))
                continue
            if flag:
                flagged.append((month, flag))
            if category == AE_SYSTEM_OIL:
                split = ae_month_breakdown(report, by_month.get(month_shift(month, -1)))
                if split["routine"] is None or split["change_loss"] is None or split["total"] is None:
                    missing.append((month, "AE routine or change/loss blank"))
                    continue
                for key in ae:
                    ae[key] += split[key]
            covered.append(month)
            hours += month_hours
            for group, (value, _) in values.items():
                subs[group] += value
            actual += sum(value for value, _ in values.values())

        price = price_for(price_rows, category)
        unit_price = price["reference_price_per_litre"] if price else None
        row = dict(
            category=category, label=CATEGORY_LABEL[category], basis=basis, configured=basis is not None,
            months=months, covered=covered, missing=missing, hour_flags=flagged,
            actual=round(actual, 3) if covered else None,
            price=price, unit_price=unit_price, currency=price["currency"] if price else None,
            activity_driven=category in ACTIVITY_DRIVEN,
        )
        row["sub"] = []
        for group, quantity in subs.items():
            sub_price = price_for(price_rows, category, group)
            sub_unit = sub_price["reference_price_per_litre"] if sub_price else None
            row["sub"].append(dict(group=group, actual=round(quantity, 3) if covered else None, unit_price=sub_unit,
                                   cost=consumption_cost(round(quantity, 3), sub_unit) if covered else None))
        if category == AE_SYSTEM_OIL:
            row["ae"] = {key: round(value, 3) for key, value in ae.items()} if covered else None
        if basis is None or not covered:
            row.update(annual=annual_allowance(basis) if basis else None, original=None, activity=None,
                       adjusted=None, technical=None, technical_percent=None, costs=None)
            rows.append(row)
            continue
        original = period_allowance(basis, covered)
        activity = activity_variance(basis, hours, covered) if category in ACTIVITY_DRIVEN else None
        adjusted = original + (activity["quantity"] if activity else 0)
        technical = actual - adjusted
        row.update(
            annual=annual_allowance(basis), original=original, activity=activity, adjusted=adjusted,
            technical=technical, technical_percent=technical / adjusted * 100 if adjusted else None,
        )
        if category == AE_SYSTEM_OIL:
            row["technical_normal"] = row["ae"]["normal"] - adjusted
        actual_cost = (sum(sub["cost"] for sub in row["sub"]) if all(sub["cost"] is not None for sub in row["sub"])
                       else None)
        costs = dict(
            original=consumption_cost(original, unit_price),
            activity=consumption_cost(activity["quantity"], unit_price) if activity else None,
            adjusted=consumption_cost(adjusted, unit_price),
            actual=actual_cost,
        )
        costs["technical"] = (costs["actual"] - costs["adjusted"]
                              if costs["actual"] is not None and costs["adjusted"] is not None else None)
        if category == AE_SYSTEM_OIL:
            costs.update({key: consumption_cost(row["ae"][key], unit_price)
                          for key in ("routine", "confirmed", "probable", "unclassified")})
        row["costs"] = costs
        rows.append(row)
    return dict(
        vessel=vessel, year=year, months=months, end_month=months[-1], reported=reported,
        configured=bool(basis_rows), status=None if basis_rows else NOT_CONFIGURED, categories=rows,
    )


def card_budget(reports, vessel, end_month, basis_rows, price_rows, detail_months=()):
    """Budget figures for the Overview cards.

    ytd: the same year-to-date comparison as the Budget Performance page (1 January to end_month),
    so the cards and that page always agree.
    monthly: each detail month against its own allowance (hours-adjusted for ME-driven categories),
    using that month's budget year only. A month in a year without a basis stays unconfigured.
    """
    year = int(end_month[:4])
    ytd = budget_performance(reports, vessel, year, end_month, basis_rows, price_rows)
    monthly = {}
    for month in detail_months:
        perf = budget_performance(reports, vessel, int(month[:4]), month, basis_rows, price_rows,
                                  first_month=int(month[5:]))
        monthly[month] = {row["category"]: row for row in perf["categories"]}
    return dict(year=year, months=ytd["months"], reported=ytd["reported"],
                categories={row["category"]: row for row in ytd["categories"]}, monthly=monthly)


def group_ytd_actual(row, group):
    """Year-to-date litres for one card: the category total, or the grade's share for cylinder oil."""
    if row is None or row["actual"] is None:
        return None
    if len(CATEGORY_GROUPS[row["category"]]) == 1:
        return row["actual"]
    return next((sub["actual"] for sub in row["sub"] if sub["group"] == group), None)
