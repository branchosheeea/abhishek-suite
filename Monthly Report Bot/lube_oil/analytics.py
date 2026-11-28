"""Calendar-aware calculations. Missing months and quantities are never zeros."""
from __future__ import annotations
import calendar
from datetime import date
import math
from .parser import norm


# Locked display order (cards, charts, legends, tables, exports): ME system oil first.
PRIMARY_GROUPS = (
    "System oil · ME", "Cylinder oil · High TBN",
    "Cylinder oil · Low TBN", "System oil · AE",
)
OTHER_GROUPS = (
    "Hydraulic oil", "Gear oil", "Compressor oil", "Refrigeration oil",
    "Turbocharger oil", "Stern tube oil", "Grease", "Other oils",
)
GROUP_ORDER = PRIMARY_GROUPS + OTHER_GROUPS

# MECC = main engine crankcase oil consumption; C/C oil, crankcase oil and ME system oil are one category.
ME_SYSTEM_ALIASES = {"SYSTEM OIL M E", "MECC", "C C OIL", "CC OIL", "ME SYSTEM OIL", "M E SYSTEM OIL",
                     "MAIN ENGINE SYSTEM OIL", "ME CRANKCASE OIL", "MAIN ENGINE CRANKCASE OIL",
                     "MAIN ENGINE CRANKCASE OIL CONSUMPTION"}
AE_SYSTEM_ALIASES = {"SYSTEM OIL A E", "AECC", "AE SYSTEM OIL", "A E SYSTEM OIL", "GENERATOR OIL"}


def oil_group(category):
    """Map a workbook column heading to its reporting group."""
    text = norm(category)
    words = text.split()
    if text in ME_SYSTEM_ALIASES or "CRANKCASE" in words:
        return "System oil · ME"
    if text in AE_SYSTEM_ALIASES:
        return "System oil · AE"
    if text.startswith("CYL"):
        if "LOW" in words or "LTBN" in words:
            return "Cylinder oil · Low TBN"
        if "HIGH" in words or "HTBN" in words:
            return "Cylinder oil · High TBN"
        return "Other oils"
    if "GREASE" in words:
        # Wire-rope EAL is reported in litres; it stays under Other / EAL, never in grease.
        return "Grease"
    if text.startswith("HYDR"):
        return "Hydraulic oil"
    if "REFRIG" in text or text.startswith(("AC COMP", "A C COMP")):
        return "Refrigeration oil"
    if "GEAR" in words:
        return "Gear oil"
    if "COMPR" in text:
        return "Compressor oil"
    if "TURBO" in text:
        return "Turbocharger oil"
    if "STERN" in text:
        return "Stern tube oil"
    return "Other oils"


def group_unit(group):
    # Grease is reported by weight on most vessels; never add it to litres.
    return None if group == "Grease" else "L"


def _group_quantity(report, group=None, category=None):
    """Reported storage withdrawal for a group or one heading; any blank member makes it unavailable."""
    if report.get("validation_status") == "FAIL":
        return None, "invalid", "Report validation failed."
    members = [
        oil for oil in report.get("data", {}).get("inventory", [])
        if (norm(oil.get("category")) == norm(category) if category
            else oil_group(oil.get("category")) == group)
    ]
    if not members:
        return None, "grade_missing", "Not reported in this workbook."
    total = 0
    for oil in members:
        value = oil.get("withdrawal")
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value < 0):
            return None, "quantity_missing", f"{' '.join(str(oil.get('category')).split())} quantity is blank or invalid."
        total += value
    return round(total, 3), None, None


def month_shift(month, delta):
    y, m = map(int, month.split("-"))
    y, m = divmod(y * 12 + m - 1 + delta, 12)
    return f"{y:04}-{m + 1:02}"


def oil_for(report, category):
    return next((o for o in report["data"]["inventory"] if norm(o["category"]) == norm(category)), None)


def metric(report, engine, field):
    if report.get("validation_status") == "FAIL":
        return None
    entry = next((e for e in report["data"]["engines"] if e["engine"] == engine), None)
    if entry is None or any(i["code"] in ("hours:" + engine, "negative:" + engine + "." + field, "zero_hours:" + engine) for i in report["data"]["issues"]):
        return None
    if engine.startswith("AE") and field in ("rate", "implied_litres") and any(i["code"] == "ae_reconciliation" for i in report["data"]["issues"]):
        return None
    return entry.get(field)


# The vessel sheet's own L/24h figures (MAIN ENGINE column). AE system oil is pooled across generators: no single rate.
RATE_FIELD = {"System oil · ME": "rate", "Cylinder oil · High TBN": "cylinder_rate", "Cylinder oil · Low TBN": "cylinder_rate"}


def period_months(end_month, months):
    """Months ending at end_month. "YTD" runs from 1 January of end_month's year."""
    count = int(end_month[5:]) if months == "YTD" else int(months)
    return [month_shift(end_month, offset) for offset in range(1 - count, 1)]


def _rate_and_hours(report, field, single):
    """(sheet rate, ME hours, hours-above-month flag) for one month, or None when either input is unusable.

    Hours above the calendar month are kept in multi-month averages: consecutive reporting periods that overlap
    calendar months still add up to the true running time. Shown alone (single month) they stay hidden.
    """
    if report is None or report.get("validation_status") == "FAIL":
        return None
    entry = next((e for e in report["data"]["engines"] if e["engine"] == "ME"), None)
    codes = {i["code"] for i in report["data"].get("issues", [])}
    if entry is None or codes & {"zero_hours:ME", "negative:ME.hours", f"negative:ME.{field}"}:
        return None
    over = "hours:ME" in codes
    if single and over:
        return None
    rate, hours = entry.get(field), entry.get("hours")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (rate, hours)) or hours <= 0 or rate < 0:
        return None
    return rate, hours, over


def weighted_rate(by_month, months, field):
    """Running-hours-weighted L/24h over the period: sum(sheet rate x hours) / sum(hours).

    Equivalent to total litres x 24 / total running hours, using the sheet's own figures. A month without a usable
    rate or hours is left out (blank, never zero); the months used are returned so the gap is visible.
    """
    if field is None:
        return dict(rate=None, months=[], of=len(months), flagged=[])
    weighted = hours_total = 0.0
    used, flagged = [], []
    for month in months:
        got = _rate_and_hours(by_month.get(month), field, single=len(months) == 1)
        if got is None:
            continue
        rate, hours, over = got
        weighted += rate * hours
        hours_total += hours
        used.append(month)
        if over:
            flagged.append(month)
    return dict(rate=weighted / hours_total if hours_total else None, months=used, of=len(months), flagged=flagged)


def period_rate(reports, vessel, end_month, months, group):
    """The card's L/24h for the selected period (latest month, 3/6/12/24 months or budget year to date)."""
    by_month = {
        r["month"]: r for r in reports
        if (r.get("vessel") or r.get("data", {}).get("vessel")) == vessel
        and r.get("is_active") and r.get("month")
    }
    return weighted_rate(by_month, period_months(end_month, months), RATE_FIELD.get(group))


def series(reports, engine="ME", field="rate", months=12, end=None):
    if not reports:
        return []
    end = end or max(r["month"] for r in reports)
    by_month = {r["month"]: r for r in reports}
    output = []
    for offset in range(-months + 1, 1):
        month = month_shift(end, offset)
        report = by_month.get(month)
        value = metric(report, engine, field) if report else None
        averages = {}
        for window in (3, 6, 12):
            group = [by_month.get(month_shift(month, d)) for d in range(-window + 1, 1)]
            valid = all(r and metric(r, engine, field) is not None for r in group)
            if not valid:
                averages[window] = None
            elif field in ("rate", "cylinder_rate"):
                hours = [metric(r, engine, "hours") for r in group]
                if any(h is None or h <= 0 for h in hours):
                    averages[window] = None
                else:
                    averages[window] = sum(metric(r, engine, field) * h for r, h in zip(group, hours)) / sum(hours)
            else:
                averages[window] = sum(metric(r, engine, field) for r in group) / window
        output.append(dict(month=month, value=value, averages=averages))
    return output


def _period_source(month_reports):
    active = [report for report in month_reports if report.get("is_active")]
    pending = [
        report for report in month_reports
        if not report.get("is_active") and not report.get("confirmed_at")
    ]
    if len(pending) == 1:
        return pending[0], "provisional"
    if len(pending) > 1:
        return None, "ambiguous"
    if len(active) == 1:
        return active[0], "confirmed"
    if len(active) > 1:
        return None, "ambiguous"
    return None, "missing"


def _confirmed_period_source(month_reports):
    active = [report for report in month_reports if report.get("is_active")]
    if len(active) == 1:
        return active[0], "confirmed"
    if len(active) > 1:
        return None, "ambiguous"
    pending = [
        report for report in month_reports
        if not report.get("is_active") and not report.get("confirmed_at")
    ]
    return None, "provisional_excluded" if pending else "missing"


def _oil_grade(report, category):
    oil = oil_for(report, category)
    return norm(oil.get("grade")) if oil and oil.get("grade") else None


def _cylinder_grade_signature(report):
    grades = set()
    for oil in report.get("data", {}).get("inventory", []):
        category = norm(oil.get("category"))
        if not oil.get("grade"):
            continue
        family = next(
            (label for label in ("HIGH TBN", "LOW TBN") if label in category),
            None,
        )
        if family:
            grades.add((family, norm(oil["grade"])))
    return tuple(sorted(grades))


def _bulk_consumption_field(oil):
    if norm(oil.get("category")) in ("SYSTEM OIL M E", "SYSTEM OIL A E"):
        return "operating", "System operating consumption"
    return "withdrawal", "Bulk storage withdrawal"


def _matched_inventory_oil(report, target):
    category = norm(target.get("category"))
    grade = norm(target.get("grade"))
    matches = [
        oil for oil in report.get("data", {}).get("inventory", [])
        if category
        and grade
        and norm(oil.get("category")) == category
        and norm(oil.get("grade")) == grade
        and oil.get("unit") == target.get("unit")
    ]
    return matches[0] if len(matches) == 1 else None


def _history_oil_value(report, target, field, source_state):
    if report is None:
        return None, source_state
    if report.get("validation_status") == "FAIL":
        return None, "invalid"
    match = _matched_inventory_oil(report, target)
    if match is None:
        return None, "grade_missing"
    value = match.get(field)
    if value is None:
        return None, "quantity_missing"
    return value, source_state


def consumption_trend_range(month, preset="3M", start=None, end=None):
    """Inclusive calendar-month buckets. Custom dates never invent daily readings."""
    if preset == "Custom":
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        if first > last:
            raise ValueError("The start date must be on or before the end date.")
        return first.strftime("%Y-%m"), last.strftime("%Y-%m")
    if preset not in ("1M", "3M", "6M", "12M"):
        raise ValueError("Choose 1M, 3M, 6M, 12M or Custom.")
    date.fromisoformat(month + "-01")
    return month_shift(month, 1 - int(preset[:-1])), month


def grade_daily_trend(reports, target, selected, start, end):
    """Litres per 24 running hours by grade; monthly accounting remains unchanged.

    Baselines use eligible months before the selected report within the range.
    Confirmed sources take precedence; pending revisions cannot replace them.
    Each point represents its full reporting month, including custom boundaries.
    """
    first, last = date.fromisoformat(start + "-01"), date.fromisoformat(end + "-01")
    count = (last.year - first.year) * 12 + last.month - first.month + 1
    if count < 1:
        raise ValueError("The start month must be on or before the end month.")
    vessel = selected.get("vessel") or selected.get("data", {}).get("vessel")
    grouped = {}
    for report in reports:
        if (report.get("vessel") or report.get("data", {}).get("vessel")) == vessel:
            grouped.setdefault(report.get("month"), []).append(report)
    field, basis = _bulk_consumption_field(target)

    def operating_hours(report, month):
        category = norm(target.get("category"))
        engines = report.get("data", {}).get("engines", [])
        if category == "SYSTEM OIL M E" or "CYL" in category:
            matches = [e for e in engines if e.get("engine") == "ME"]
            basis = "ME running hours" if "CYL" not in category else "ME running hours (workbook cylinder-rate basis)"
            if len(matches) != 1:
                return None, basis, "Matching ME hours are missing or ambiguous."
        elif category == "SYSTEM OIL A E":
            matches = [e for e in engines if e.get("engine", "").startswith("AE")]
            basis = "Combined AE running hours"
            if not matches or len({e["engine"] for e in matches}) != len(matches):
                return None, basis, "Matching AE hours are missing or ambiguous."
        else:
            return None, "No matching machinery-hour basis", "This oil category has no validated machinery-hour mapping."
        total = 0
        year, number = map(int, month.split("-"))
        maximum = calendar.monthrange(year, number)[1] * 24
        issues = {i["code"] for i in report.get("data", {}).get("issues", [])}
        for engine in matches:
            hours = engine.get("hours")
            if (isinstance(hours, bool) or not isinstance(hours, (int, float)) or not math.isfinite(hours)
                    or hours < 0 or hours > maximum or "hours:" + engine["engine"] in issues
                    or "zero_hours:" + engine["engine"] in issues):
                return None, basis, f"{engine['engine']} running hours are missing, invalid or require period review."
            total += hours
        if total <= 0:
            return None, basis, "Running hours are zero; a daily operating rate cannot be calculated."
        return total, basis, None

    def point(report, state, month):
        source_state = state
        quantity, state = _history_oil_value(report, target, field, state)
        if quantity is not None and (not isinstance(quantity, (int, float)) or isinstance(quantity, bool)
                                     or not math.isfinite(quantity) or quantity < 0):
            quantity, state = None, "invalid"
        hours, hours_basis, reason = operating_hours(report, month) if report else (None, "Unavailable", None)
        if quantity is not None and hours is None:
            state = "hours_unavailable"
        value = quantity / hours * 24 if quantity is not None and hours is not None else None
        return dict(month=month, value=value, quantity=quantity, hours=hours, hours_basis=hours_basis,
                    reason=reason, state=state, source_state=source_state)

    points, confirmed, reference = [], [], []
    for offset in range(count):
        month = month_shift(start, offset)
        candidates = grouped.get(month, [])
        source, state = _confirmed_period_source(candidates)
        if source is None and state != "ambiguous":
            source, state = _period_source(candidates)
        # Explicitly selected source is a preview, never silently made a baseline.
        if month == selected.get("month"):
            source = selected
            state = "confirmed" if selected.get("is_active") else "superseded" if selected.get("confirmed_at") else "provisional"
        item = point(source, state, month)
        points.append(item)
        if month < selected.get("month", ""):
            baseline, baseline_state = _confirmed_period_source(candidates)
            confirmed_point = point(baseline, baseline_state, month)
            if confirmed_point["value"] is not None:
                confirmed.append(confirmed_point)
            if item["value"] is not None:
                reference.append(item)

    def weighted(items):
        return sum(p["quantity"] for p in items) / sum(p["hours"] for p in items) * 24 if items else None

    current_state = "confirmed" if selected.get("is_active") else "superseded" if selected.get("confirmed_at") else "provisional"
    current = point(selected, current_state, selected["month"])
    average, reference_average = weighted(confirmed), weighted(reference)
    prior_count = sum(p["month"] < selected["month"] for p in points)
    def change(baseline, coverage):
        return (current["value"] / baseline - 1) * 100 if (current["value"] is not None and baseline not in (None, 0)
                and coverage == prior_count and prior_count > 0) else None
    return dict(history=points, current=current, basis=basis,
                average_consumption=average, coverage=len(confirmed), months=prior_count,
                reference_average_consumption=reference_average, reference_coverage=len(reference),
                reference_provisional_months=sum(p["state"] == "provisional" for p in reference),
                change_percent=change(average, len(confirmed)),
                reference_change_percent=change(reference_average, len(reference)))


def group_monthly_trend(reports, selected, start, end, group=None, category=None):
    """Monthly reported withdrawal for a non-engine oil group or a single heading.

    These oils have no running-hour basis, so each point is litres per reporting month.
    """
    first, last = date.fromisoformat(start + "-01"), date.fromisoformat(end + "-01")
    count = (last.year - first.year) * 12 + last.month - first.month + 1
    if count < 1:
        raise ValueError("The start month must be on or before the end month.")
    vessel = selected.get("vessel") or selected.get("data", {}).get("vessel")
    grouped = {}
    for report in reports:
        if (report.get("vessel") or report.get("data", {}).get("vessel")) == vessel:
            grouped.setdefault(report.get("month"), []).append(report)

    def point(report, state, month):
        if report is None:
            return dict(month=month, value=None, quantity=None, hours=None, hours_basis="Reported monthly withdrawal",
                        reason=None, state=state, source_state=state)
        value, problem, reason = _group_quantity(report, group, category)
        return dict(month=month, value=value, quantity=value, hours=None, hours_basis="Reported monthly withdrawal",
                    reason=reason, state=problem or state, source_state=state)

    def state_of(report):
        return "confirmed" if report.get("is_active") else "superseded" if report.get("confirmed_at") else "provisional"

    points, confirmed, reference = [], [], []
    for offset in range(count):
        month = month_shift(start, offset)
        candidates = grouped.get(month, [])
        source, state = _confirmed_period_source(candidates)
        if source is None and state != "ambiguous":
            source, state = _period_source(candidates)
        if month == selected.get("month"):
            source, state = selected, state_of(selected)
        item = point(source, state, month)
        points.append(item)
        if month < selected.get("month", ""):
            baseline, baseline_state = _confirmed_period_source(candidates)
            confirmed_point = point(baseline, baseline_state, month)
            if confirmed_point["value"] is not None:
                confirmed.append(confirmed_point)
            if item["value"] is not None:
                reference.append(item)

    def mean(items):
        return sum(p["value"] for p in items) / len(items) if items else None

    current = point(selected, state_of(selected), selected["month"])
    average, reference_average = mean(confirmed), mean(reference)
    prior_count = sum(p["month"] < selected["month"] for p in points)

    def change(baseline, coverage):
        return (current["value"] / baseline - 1) * 100 if (current["value"] is not None and baseline not in (None, 0)
                and coverage == prior_count and prior_count > 0) else None
    return dict(history=points, current=current, basis="Reported monthly withdrawal",
                average_consumption=average, coverage=len(confirmed), months=prior_count,
                reference_average_consumption=reference_average, reference_coverage=len(reference),
                reference_provisional_months=sum(p["state"] == "provisional" for p in reference),
                change_percent=change(average, len(confirmed)),
                reference_change_percent=change(reference_average, len(reference)))


def _group_analysis(grouped, vessel, month, current, windows):
    inventory = current.get("data", {}).get("inventory", [])
    groups = sorted({oil_group(oil.get("category")) for oil in inventory} - set(PRIMARY_GROUPS),
                    key=GROUP_ORDER.index)
    output = []
    for group in groups:
        current_value, _, reason = _group_quantity(current, group)
        comparisons = {}
        for window in windows:
            prior_months = [month_shift(month, -offset) for offset in range(window, 0, -1)]
            confirmed_sources = [_confirmed_period_source(grouped.get((vessel, m), [])) for m in prior_months]
            reference_sources = [_period_source(grouped.get((vessel, m), [])) for m in prior_months]
            confirmed_values = [
                value for value in (_group_quantity(r, group)[0] for r, _ in confirmed_sources if r is not None)
                if value is not None
            ]
            reference_values = [
                (value, state) for r, state in reference_sources if r is not None
                for value in [_group_quantity(r, group)[0]] if value is not None
            ]
            average = sum(confirmed_values) / len(confirmed_values) if confirmed_values else None
            reference_average = (
                sum(value for value, _ in reference_values) / len(reference_values) if reference_values else None
            )
            complete = len(confirmed_values) == window
            reference_complete = len(reference_values) == window
            comparisons[window] = {
                "average_consumption": average,
                "coverage": len(confirmed_values),
                "months": window,
                "complete": complete,
                "change_percent": (
                    (current_value - average) / average * 100
                    if complete and current_value is not None and average not in (None, 0) else None
                ),
                "reference_average_consumption": reference_average,
                "reference_coverage": len(reference_values),
                "reference_complete": reference_complete,
                "reference_change_percent": (
                    (current_value - reference_average) / reference_average * 100
                    if reference_complete and current_value is not None
                    and reference_average not in (None, 0) else None
                ),
                "reference_provisional_months": sum(state == "provisional" for _, state in reference_values),
                "provisional_months_available": sum(
                    state == "provisional_excluded" for _, state in confirmed_sources
                ),
                "ambiguous_months": sum(state == "ambiguous" for _, state in confirmed_sources),
            }
        output.append({
            "group": group,
            "grades": [
                f"{' '.join(str(oil.get('category')).split())} · {oil.get('grade') or 'grade not stated'}"
                for oil in inventory if oil_group(oil.get("category")) == group
            ],
            "unit": group_unit(group),
            "monthly_consumption": current_value,
            "unavailable_reason": reason,
            "comparisons": comparisons,
        })
    return output


def _bulk_oil_analysis(grouped, vessel, month, current, current_state, windows):
    output = []
    current_inventory = current.get("data", {}).get("inventory", [])
    for oil in current_inventory:
        if oil.get("unit") != "L" or not oil.get("grade"):
            continue
        field, basis = _bulk_consumption_field(oil)
        values_by_window = {}
        for window in windows:
            prior_months = [
                month_shift(month, -offset)
                for offset in range(window, 0, -1)
            ]
            confirmed_sources = [
                _confirmed_period_source(grouped.get((vessel, prior_month), []))
                for prior_month in prior_months
            ]
            reference_sources = [
                _period_source(grouped.get((vessel, prior_month), []))
                for prior_month in prior_months
            ]
            confirmed_values = []
            for report, _ in confirmed_sources:
                if report is None or report.get("validation_status") == "FAIL":
                    continue
                match = _matched_inventory_oil(report, oil)
                value = match.get(field) if match else None
                if value is not None:
                    confirmed_values.append(value)
            reference_values = []
            for report, source_state in reference_sources:
                if report is None or report.get("validation_status") == "FAIL":
                    continue
                match = _matched_inventory_oil(report, oil)
                value = match.get(field) if match else None
                if value is not None:
                    reference_values.append((value, source_state))

            average = (
                sum(confirmed_values) / len(confirmed_values)
                if confirmed_values else None
            )
            reference_average = (
                sum(value for value, _ in reference_values) / len(reference_values)
                if reference_values else None
            )
            current_value = oil.get(field)
            complete = len(confirmed_values) == window
            reference_complete = len(reference_values) == window
            change_percent = (
                (current_value - average) / average * 100
                if complete and current_value is not None and average not in (None, 0)
                else None
            )
            reference_change = (
                (current_value - reference_average) / reference_average * 100
                if reference_complete and current_value is not None
                and reference_average not in (None, 0)
                else None
            )

            history = []
            for prior_month, (report, source_state) in zip(prior_months, reference_sources):
                value, state = _history_oil_value(
                    report, oil, field, source_state,
                )
                history.append({
                    "month": prior_month,
                    "value": value,
                    "state": state,
                    "source_state": source_state,
                })
            history.append({
                "month": month,
                "value": current_value if current.get("validation_status") != "FAIL" else None,
                "state": (
                    current_state if current_value is not None
                    and current.get("validation_status") != "FAIL"
                    else "invalid" if current.get("validation_status") == "FAIL"
                    else "quantity_missing"
                ),
                "source_state": current_state,
            })
            values_by_window[window] = {
                "average_consumption": average,
                "coverage": len(confirmed_values),
                "months": window,
                "complete": complete,
                "change_percent": change_percent,
                "reference_average_consumption": reference_average,
                "reference_coverage": len(reference_values),
                "reference_complete": reference_complete,
                "reference_change_percent": reference_change,
                "reference_provisional_months": sum(
                    source_state == "provisional"
                    for _, source_state in reference_values
                ),
                "provisional_months_available": sum(
                    source_state == "provisional_excluded"
                    for _, source_state in confirmed_sources
                ),
                "ambiguous_months": sum(
                    source_state == "ambiguous"
                    for _, source_state in confirmed_sources
                ),
                "history": history,
            }

        group = oil_group(oil.get("category"))
        output.append({
            "group": group,
            "primary": group in PRIMARY_GROUPS,
            "category": oil.get("category"),
            "grade": oil.get("grade"),
            "unit": oil.get("unit"),
            "consumption_field": field,
            "consumption_basis": basis,
            "monthly_consumption": oil.get(field),
            "withdrawal": oil.get("withdrawal"),
            "operating": oil.get("operating"),
            "change_loss": oil.get("change_loss"),
            "all_in": oil.get("all_in"),
            "comparisons": values_by_window,
        })
    output.sort(key=lambda item: GROUP_ORDER.index(item["group"]))
    return output


def monthly_analysis(reports, month, windows=(3, 6, 12)):
    """Compare each vessel's selected month with its own prior calendar history."""
    grouped = {}
    vessel_names = set()
    for report in reports:
        data = report.get("data", {})
        vessel = report.get("vessel") or data.get("vessel") or "Unresolved vessel"
        vessel_names.add(vessel)
        if report.get("month"):
            grouped.setdefault((vessel, report["month"]), []).append(report)

    output = []
    for vessel in sorted(vessel_names):
        current_candidates = grouped.get((vessel, month), [])
        current, current_state = _period_source(current_candidates)
        item = {
            "vessel": vessel,
            "month": month,
            "state": current_state,
            "candidate_count": len(current_candidates),
            "report": current,
            "brief": decision_brief(current) if current else None,
            "engines": [],
            "oils": [],
            "bulk_oils": [],
            "oil_groups": [],
            "inventory": current["data"].get("inventory", []) if current else [],
            "issues": current["data"].get("issues", []) if current else [],
            "windows": {},
        }

        if current:
            item["bulk_oils"] = _bulk_oil_analysis(
                grouped, vessel, month, current, current_state, windows,
            )
            item["oil_groups"] = _group_analysis(grouped, vessel, month, current, windows)
            engine_names = [engine["engine"] for engine in current["data"].get("engines", [])]
            for engine_name in engine_names:
                current_rate = metric(current, engine_name, "rate")
                category = "SYSTEM OIL A E" if engine_name.startswith("AE") else "SYSTEM OIL M E"
                current_grade = _oil_grade(current, category)
                comparisons = {}
                for window in windows:
                    prior_months = [month_shift(month, -offset) for offset in range(1, window + 1)]
                    sources = [
                        _confirmed_period_source(grouped.get((vessel, prior_month), []))
                        for prior_month in prior_months
                    ]
                    reference_sources = [
                        _period_source(grouped.get((vessel, prior_month), []))
                        for prior_month in prior_months
                    ]
                    valid = []
                    for report, source_state in sources:
                        if report is None or report.get("validation_status") == "FAIL":
                            continue
                        rate = metric(report, engine_name, "rate")
                        hours = metric(report, engine_name, "hours")
                        same_grade = (
                            current_grade is not None
                            and _oil_grade(report, category) == current_grade
                        )
                        if rate is not None and hours is not None and hours > 0 and same_grade:
                            valid.append((report, rate, hours, source_state))
                    reference_valid = []
                    for report, source_state in reference_sources:
                        if report is None or report.get("validation_status") == "FAIL":
                            continue
                        rate = metric(report, engine_name, "rate")
                        hours = metric(report, engine_name, "hours")
                        same_grade = (
                            current_grade is not None
                            and _oil_grade(report, category) == current_grade
                        )
                        if rate is not None and hours is not None and hours > 0 and same_grade:
                            reference_valid.append((rate, hours, source_state))
                    hours_total = sum(hours for _, _, hours, _ in valid)
                    average = (
                        sum(rate * hours for _, rate, hours, _ in valid) / hours_total
                        if hours_total > 0 else None
                    )
                    reference_hours = sum(hours for _, hours, _ in reference_valid)
                    reference_average = (
                        sum(rate * hours for rate, hours, _ in reference_valid)
                        / reference_hours
                        if reference_hours > 0 else None
                    )
                    complete = len(valid) == window
                    reference_complete = len(reference_valid) == window
                    percent_change = (
                        (current_rate - average) / average * 100
                        if complete and current_rate is not None and average not in (None, 0)
                        else None
                    )
                    reference_change = (
                        (current_rate - reference_average) / reference_average * 100
                        if reference_complete and current_rate is not None
                        and reference_average not in (None, 0)
                        else None
                    )
                    comparisons[window] = {
                        "average_rate": average,
                        "coverage": len(valid),
                        "months": window,
                        "complete": complete,
                        "change_percent": percent_change,
                        "reference_average_rate": reference_average,
                        "reference_coverage": len(reference_valid),
                        "reference_complete": reference_complete,
                        "reference_change_percent": reference_change,
                        "reference_provisional_months": sum(
                            source_state == "provisional"
                            for _, _, source_state in reference_valid
                        ),
                        "provisional_months_available": sum(
                            source_state == "provisional_excluded"
                            for _, source_state in sources
                        ),
                        "ambiguous_months": sum(
                            source_state == "ambiguous"
                            for _, source_state in sources
                        ),
                        "grade": current_grade,
                    }
                cylinder_rate = (
                    metric(current, engine_name, "cylinder_rate")
                    if engine_name == "ME" else None
                )
                cylinder_grade_basis = (
                    _cylinder_grade_signature(current)
                    if engine_name == "ME" else ()
                )
                cylinder_comparisons = {}
                if engine_name == "ME":
                    for window in windows:
                        prior_months = [
                            month_shift(month, -offset)
                            for offset in range(1, window + 1)
                        ]
                        confirmed_sources = [
                            _confirmed_period_source(grouped.get((vessel, prior_month), []))
                            for prior_month in prior_months
                        ]
                        reference_sources = [
                            _period_source(grouped.get((vessel, prior_month), []))
                            for prior_month in prior_months
                        ]
                        confirmed_values = []
                        for report, _ in confirmed_sources:
                            if (
                                report is None
                                or report.get("validation_status") == "FAIL"
                                or not cylinder_grade_basis
                                or _cylinder_grade_signature(report) != cylinder_grade_basis
                            ):
                                continue
                            rate = metric(report, engine_name, "cylinder_rate")
                            hours = metric(report, engine_name, "hours")
                            if rate is not None and hours is not None and hours > 0:
                                confirmed_values.append((rate, hours))
                        reference_values = []
                        for report, source_state in reference_sources:
                            if (
                                report is None
                                or report.get("validation_status") == "FAIL"
                                or not cylinder_grade_basis
                                or _cylinder_grade_signature(report) != cylinder_grade_basis
                            ):
                                continue
                            rate = metric(report, engine_name, "cylinder_rate")
                            hours = metric(report, engine_name, "hours")
                            if rate is not None and hours is not None and hours > 0:
                                reference_values.append((rate, hours, source_state))
                        confirmed_hours = sum(hours for _, hours in confirmed_values)
                        reference_hours = sum(hours for _, hours, _ in reference_values)
                        average = (
                            sum(rate * hours for rate, hours in confirmed_values) / confirmed_hours
                            if confirmed_hours > 0 else None
                        )
                        reference_average = (
                            sum(rate * hours for rate, hours, _ in reference_values)
                            / reference_hours if reference_hours > 0 else None
                        )
                        complete = len(confirmed_values) == window
                        reference_complete = len(reference_values) == window
                        cylinder_comparisons[window] = {
                            "average_rate": average,
                            "coverage": len(confirmed_values),
                            "months": window,
                            "complete": complete,
                            "change_percent": (
                                (cylinder_rate - average) / average * 100
                                if complete and cylinder_rate is not None and average not in (None, 0)
                                else None
                            ),
                            "reference_average_rate": reference_average,
                            "reference_coverage": len(reference_values),
                            "reference_complete": reference_complete,
                            "reference_change_percent": (
                                (cylinder_rate - reference_average) / reference_average * 100
                                if reference_complete and cylinder_rate is not None
                                and reference_average not in (None, 0)
                                else None
                            ),
                            "reference_provisional_months": sum(
                                source_state == "provisional"
                                for _, _, source_state in reference_values
                            ),
                            "provisional_months_available": sum(
                                source_state == "provisional_excluded"
                                for _, source_state in confirmed_sources
                            ),
                            "ambiguous_months": sum(
                                source_state == "ambiguous"
                                for _, source_state in confirmed_sources
                            ),
                        }
                item["engines"].append({
                    "engine": engine_name,
                    "hours": metric(current, engine_name, "hours"),
                    "rate": current_rate,
                    "cylinder_rate": cylinder_rate,
                    "cylinder_grade_basis": cylinder_grade_basis,
                    "cylinder_comparisons": cylinder_comparisons,
                    "implied_litres": metric(current, engine_name, "implied_litres"),
                    "comparisons": comparisons,
                })

            for oil in current["data"].get("inventory", []):
                if (
                    oil.get("unit") != "L"
                    or norm(oil.get("category")) not in ("SYSTEM OIL M E", "SYSTEM OIL A E")
                ):
                    continue
                comparisons = {}
                for window in windows:
                    prior_months = [
                        month_shift(month, -offset)
                        for offset in range(1, window + 1)
                    ]
                    sources = [
                        _confirmed_period_source(grouped.get((vessel, prior_month), []))
                        for prior_month in prior_months
                    ]
                    reference_sources = [
                        _period_source(grouped.get((vessel, prior_month), []))
                        for prior_month in prior_months
                    ]
                    values = []
                    category = oil.get("category")
                    grade = norm(oil.get("grade"))
                    for report, source_state in sources:
                        if (
                            not grade
                            or report is None
                            or report.get("validation_status") == "FAIL"
                        ):
                            continue
                        match = next(
                            (
                                candidate for candidate in report["data"].get("inventory", [])
                                if norm(candidate.get("category")) == norm(category)
                                and norm(candidate.get("grade")) == grade
                                and candidate.get("unit") == oil.get("unit")
                            ),
                            None,
                        )
                        if match is not None and match.get("operating") is not None:
                            values.append(match["operating"])
                    average = sum(values) / len(values) if values else None
                    reference_values = []
                    for report, source_state in reference_sources:
                        if (
                            not grade
                            or report is None
                            or report.get("validation_status") == "FAIL"
                        ):
                            continue
                        match = next(
                            (
                                candidate for candidate in report["data"].get("inventory", [])
                                if norm(candidate.get("category")) == norm(oil.get("category"))
                                and norm(candidate.get("grade")) == norm(oil.get("grade"))
                                and candidate.get("unit") == oil.get("unit")
                            ),
                            None,
                        )
                        if match is not None and match.get("operating") is not None:
                            reference_values.append((match["operating"], source_state))
                    reference_average = (
                        sum(value for value, _ in reference_values) / len(reference_values)
                        if reference_values else None
                    )
                    current_value = oil.get("operating")
                    complete = len(values) == window
                    reference_complete = len(reference_values) == window
                    change_percent = (
                        (current_value - average) / average * 100
                        if complete and current_value is not None and average not in (None, 0)
                        else None
                    )
                    reference_change = (
                        (current_value - reference_average) / reference_average * 100
                        if reference_complete and current_value is not None
                        and reference_average not in (None, 0)
                        else None
                    )
                    comparisons[window] = {
                        "average_operating": average,
                        "coverage": len(values),
                        "months": window,
                        "complete": complete,
                        "change_percent": change_percent,
                        "reference_average_operating": reference_average,
                        "reference_coverage": len(reference_values),
                        "reference_complete": reference_complete,
                        "reference_change_percent": reference_change,
                        "reference_provisional_months": sum(
                            source_state == "provisional"
                            for _, source_state in reference_values
                        ),
                        "grade": oil.get("grade"),
                        "provisional_months_available": sum(
                            source_state == "provisional_excluded"
                            for _, source_state in sources
                        ),
                        "ambiguous_months": sum(
                            source_state == "ambiguous"
                            for _, source_state in sources
                        ),
                    }
                item["oils"].append({
                    "category": oil.get("category"),
                    "grade": oil.get("grade"),
                    "unit": oil.get("unit"),
                    "operating": oil.get("operating"),
                    "change_loss": oil.get("change_loss"),
                    "all_in": oil.get("all_in"),
                    "comparisons": comparisons,
                })
        output.append(item)

    return {
        "month": month,
        "windows": tuple(windows),
        "vessels": output,
        "report_count": sum(len(grouped.get((vessel, month), [])) for vessel in vessel_names),
        "unresolved_count": sum(not report.get("month") for report in reports),
    }


# Safety margin (company rule, 2026-11-26): months of normal consumption held in storage above any reserve.
# ME system oil keeps one full charge (80% of the ME sump capacity) as a reserve that is never counted as stock,
# plus at least ME_MINIMUM_MONTHS of consumption. Below ALARM_MONTHS raise an alarm; below DANGER_MONTHS store now.
FULL_CHARGE_FRACTION = 0.8
ME_MINIMUM_MONTHS = 4
ALARM_MONTHS = 3
DANGER_MONTHS = 1
DAYS_PER_MONTH = 30.4
ME_GROUP = "System oil · ME"
AE_GROUP = "System oil · AE"


def _group_field(report, group, field):
    """Sum one field over a group's headings; any blank heading makes the month unavailable."""
    if report is None:
        return None
    members = [o for o in report["data"].get("inventory", []) if oil_group(o.get("category")) == group]
    values = [o.get(field) for o in members]
    if not members or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        return None
    return round(sum(values), 3)


def consumption_field(group):
    """System oils: the sheet's total consumption (D+E, routine plus change/loss). Cylinder oils: storage withdrawal."""
    return "all_in" if group.startswith("System") else "withdrawal"


def monthly_consumption(report, group):
    return _group_field(report, group, consumption_field(group))


def ae_month_breakdown(report, previous=None):
    """Split one month's AE system oil into routine use and change/loss, classified only from the sheet's evidence.

    Change/loss counts as a confirmed sump renewal only when the sheet records a confirmed AE renewal
    in this or the prior month that the prior report did not already carry. Probable renewals stay
    classified as probable and are never excluded from normal consumption automatically.
    """
    if report is None:
        return None
    routine = _group_field(report, AE_GROUP, "operating")
    total = _group_field(report, AE_GROUP, "all_in")
    loss = _group_field(report, AE_GROUP, "change_loss")
    if loss is None and total is not None and routine is not None:
        loss = round(total - routine, 3)  # the sheet's own D+E total implies E
    month = report["month"]
    earlier = {(e.get("engine"), e.get("date")) for e in (previous or {}).get("data", {}).get("events", [])}
    events = [
        e for e in report["data"].get("events", [])
        if str(e.get("engine", "")).startswith("AE")
        and (e.get("date") or month)[:7] in (month, month_shift(month, -1))
        and (e.get("engine"), e.get("date")) not in earlier
    ]
    if not loss:
        kind = None
    elif any(e["event_type"] == "CONFIRMED_RENEWAL" for e in events):
        kind = "CONFIRMED_SUMP_RENEWAL"
    elif any(e["event_type"] == "PROBABLE_RENEWAL" for e in events):
        kind = "PROBABLE_SUMP_RENEWAL"
    else:
        kind = "UNCLASSIFIED_LOSS"
    confirmed = loss if kind == "CONFIRMED_SUMP_RENEWAL" else 0
    return dict(
        month=month, routine=routine, change_loss=loss, total=total, classification=kind,
        confirmed=confirmed if loss is not None else None,
        probable=loss if kind == "PROBABLE_SUMP_RENEWAL" else 0,
        unclassified=loss if kind == "UNCLASSIFIED_LOSS" else 0,
        normal=None if total is None or loss is None else round(total - confirmed, 3),
        engines=sorted({e["engine"] for e in events}), events=events,
    )


def tank_fill(storage_rob, tanks):
    """Storage ROB ÷ usable operational capacity of the group's current tanks. Sump/system quantity is never storage."""
    usable = sum(t["usable_capacity"] for t in tanks if t.get("usable_capacity"))
    if storage_rob is None or not tanks or usable <= 0:
        return None
    return dict(percent=storage_rob / usable * 100, usable=usable, tanks=len(tanks),
                minimum_rob=sum(t["minimum_rob"] for t in tanks if t.get("minimum_rob") is not None) or None)


def margin_status(margin, group=None, reserve_known=True):
    """Safety-margin band. ME system oil also has a "Below minimum" band (company minimum is 4 months)."""
    if group == ME_GROUP and not reserve_known:
        return "Sump capacity not set"
    if margin is None:
        return "No data"
    if margin < DANGER_MONTHS:
        return "Danger"
    if margin < ALARM_MONTHS:
        return "Alarm"
    if group == ME_GROUP and margin < ME_MINIMUM_MONTHS:
        return "Below minimum"
    return "OK"


def _month_end(month):
    year, number = int(month[:4]), int(month[5:7])
    following = date(year + number // 12, number % 12 + 1, 1)
    return date.fromordinal(following.toordinal() - 1)


def dashboard(reports, vessel, end_month, months=12, budget_monthly=None, me_sump_capacity=None):
    """Overview figures for one vessel from the reports in use. Gaps stay None, never zero.

    budget_monthly: optional {group: approved budget litres per month}, the last-resort safety-margin rate.
    me_sump_capacity: ME sump capacity in litres; one full charge (80%) is held back as the ME system oil reserve.
    """
    window = [month_shift(end_month, offset) for offset in range(1 - months, 1)]
    vessel_months = {
        report["month"]: report for report in reports
        if (report.get("vessel") or report.get("data", {}).get("vessel")) == vessel
        and report.get("is_active") and report.get("validation_status") != "FAIL"
        and report.get("month") and report["month"] <= end_month
    }
    by_month = {month: report for month, report in vessel_months.items() if month in window}
    in_use = [by_month.get(month) for month in window]
    latest = by_month[max(by_month)] if by_month else None
    first = by_month[min(by_month)] if by_month else None
    budget_monthly = budget_monthly or {}

    def available(values):
        return [v for v in values if v is not None]

    def normal_consumption(group, month):
        report = vessel_months.get(month)
        if group == ME_GROUP:
            # Routine use (column D) only: a one-off sump change/loss is what the reserve charge is there for.
            return _group_field(report, group, "operating")
        if group == AE_GROUP:
            split = ae_month_breakdown(report, vessel_months.get(month_shift(month, -1)))
            return split and split["normal"]
        return monthly_consumption(report, group)

    grades = []
    for group in PRIMARY_GROUPS:
        if latest is None or not any(oil_group(o.get("category")) == group for o in latest["data"].get("inventory", [])):
            continue
        used = [monthly_consumption(r, group) for r in in_use]
        withdrawn = [_group_field(r, group, "withdrawal") for r in in_use]
        closing_series = [_group_field(r, group, "closing") for r in in_use]
        received = available(_group_field(r, group, "receipts") for r in in_use)
        closing = _group_field(latest, group, "closing")
        last12 = available(monthly_consumption(vessel_months.get(month_shift(end_month, -i)), group) for i in range(12))
        # Safety-margin rate hierarchy: clean 6-month, then 3-month normal average, then the approved budget rate.
        margin_rate, margin_basis = None, None
        for span in (6, 3):
            values = [normal_consumption(group, month_shift(end_month, -i)) for i in range(span)]
            if all(v is not None for v in values):
                margin_rate, margin_basis = sum(values) / span, f"{span}-month normal average"
                break
        if margin_rate is None and budget_monthly.get(group):
            margin_rate, margin_basis = budget_monthly[group], "approved budget rate"
        is_me = group == ME_GROUP
        reserve = round(me_sump_capacity * FULL_CHARGE_FRACTION, 3) if is_me and me_sump_capacity else None
        reserve_known = not is_me or reserve is not None
        margin = margin_days = reserve_date = minimum_rob = order_to_minimum = None
        if closing is not None and margin_rate and reserve_known:
            margin = (closing - (reserve or 0)) / margin_rate
            margin_days = margin * DAYS_PER_MONTH
            reserve_date = date.fromordinal(_month_end(latest["month"]).toordinal() + math.floor(margin_days))
        if is_me and reserve is not None and margin_rate:
            minimum_rob = reserve + ME_MINIMUM_MONTHS * margin_rate
            order_to_minimum = max(0.0, minimum_rob - closing) if closing is not None else None
        rate_field = RATE_FIELD.get(group)
        rates = [metric(r, "ME", rate_field) if r and rate_field else None for r in in_use]
        average12 = sum(last12) / len(last12) if last12 else None
        details = []
        for month, report, value, rate in zip(window, in_use, used, rates):
            note = None
            if group == AE_GROUP and report:
                split = ae_month_breakdown(report, vessel_months.get(month_shift(month, -1)))
                note = {"CONFIRMED_SUMP_RENEWAL": "Confirmed sump renewal", "PROBABLE_SUMP_RENEWAL": "Probable sump renewal",
                        "UNCLASSIFIED_LOSS": "Unclassified change/loss"}.get(split["classification"])
            # Trend only: budget comparisons are year to date and live in budget.card_budget.
            trend = (value - average12) / average12 * 100 if value is not None and average12 else None
            details.append(dict(month=month, value=value, rate=rate, note=note, trend=trend,
                                status=report["validation_status"] if report else "Missing report"))
        grade = " / ".join(
            " ".join(str(o.get("grade") or "").split()) for o in latest["data"].get("inventory", [])
            if oil_group(o.get("category")) == group and o.get("grade")
        ) or "Grade not stated"
        grades.append(dict(
            group=group, grade=grade, closing=closing, margin=margin, margin_basis=margin_basis, margin_rate=margin_rate,
            margin_days=margin_days, reserve_date=reserve_date, reserve=reserve, minimum_rob=minimum_rob,
            order_to_minimum=order_to_minimum,
            consumption=round(sum(available(used)), 3) if available(used) else None,
            consumption_months=len(available(used)), used_series=used, closing_series=closing_series,
            latest_used=used[-1], latest_rate=rates[-1], average12=average12, average12_months=len(last12),
            details=details,
            opening=_group_field(first, group, "opening"),
            received=round(sum(received), 3) if received else None,
            withdrawn=round(sum(available(withdrawn)), 3) if available(withdrawn) else None,
            status=margin_status(margin, group, reserve_known),
        ))

    events, seen = [], set()
    for month, report in zip(window, in_use):
        for event in (report or {}).get("data", {}).get("events", []):
            key = (event.get("engine"), event.get("date") or month)
            if event.get("engine", "").startswith("AE") and key not in seen:
                seen.add(key)
                events.append(dict(event, month=month))

    support = []
    present = {
        oil_group(o.get("category")) for r in in_use if r for o in r["data"].get("inventory", [])
    } - set(PRIMARY_GROUPS)
    for group in sorted(present, key=GROUP_ORDER.index):
        series = [_group_quantity(r, group)[0] if r else None for r in in_use]
        headings = sorted({
            " ".join(str(o.get("category")).split()) for r in in_use if r
            for o in r["data"].get("inventory", []) if oil_group(o.get("category")) == group
        })
        support.append(dict(
            group=group, headings=headings, unit=group_unit(group), series=series,
            total=round(sum(available(series)), 3) if available(series) else None,
            months=len(available(series)),
        ))

    return dict(
        vessel=vessel, months=window, coverage=len(by_month), latest=latest, grades=grades,
        ae=dict(
            operating=[_group_field(r, AE_GROUP, "operating") for r in in_use],
            change_loss=[_group_field(r, AE_GROUP, "change_loss") for r in in_use],
            split=[ae_month_breakdown(r, vessel_months.get(month_shift(m, -1))) for m, r in zip(window, in_use)],
            confirmed=sum(e["event_type"] == "CONFIRMED_RENEWAL" for e in events),
            probable=sum(e["event_type"] == "PROBABLE_RENEWAL" for e in events),
            events=events,
        ),
        support=support,
    )


def continuity(reports):
    by_month = {r["month"]: r for r in reports}
    issues = []
    for month, current in sorted(by_month.items()):
        previous = by_month.get(month_shift(month, -1))
        if previous is None:
            continue
        prior = {(norm(o["category"]), norm(o["grade"])): o for o in previous["data"]["inventory"]}
        for oil in current["data"]["inventory"]:
            old = prior.get((norm(oil["category"]), norm(oil["grade"])))
            if old and old["closing"] is not None and oil["opening"] is not None and abs(old["closing"] - oil["opening"]) > 0.1:
                issues.append(dict(code="continuity:" + oil["id"], title="Opening stock differs from prior closing", detail=f"{month} · {oil['grade']}: previous {old['closing']:,.1f}; opening {oil['opening']:,.1f}.", severity="WARNING", fields=[f"oil.{oil['id']}.opening"], report=current))
    return issues


def decision_brief(report):
    """Translate a report's validated evidence into a bounded management action."""
    data = report["data"]
    issues = data.get("issues", [])
    significant = [i for i in issues if not i["code"].startswith(("missing:", "unit:"))]
    source_state = (
        "OFFICIAL REPORT IN USE"
        if report["is_active"]
        else "SUPERSEDED BY A NEWER SHEET · HISTORICAL ONLY"
        if report.get("confirmed_at")
        else "NOT USABLE · EXCLUDED FROM TRENDS"
    )
    stock_differences = []
    stock_unavailable = []
    for oil in data.get("inventory", []):
        actual = oil.get("actual_rob")
        book = oil.get("closing")
        if actual is None:
            continue
        if book is None:
            stock_unavailable.append(oil)
        elif abs(book - actual) > 0.1:
            stock_differences.append((oil, book - actual))

    # priority: the branch order below (1 = most urgent); None when no priority exception was found.
    failed = [i for i in significant if i["severity"] == "FAIL"]
    if failed:
        priority = 1
        issue = failed[0]
        headline = "Resolve report integrity issues before using its figures"
        action = "Ask the vessel to correct the affected labels or values and resubmit the sheet, then import it."
        rationale = issue["detail"]
        value = "Prevents unsupported figures from entering confirmed operating and purchasing reviews."
        facts = []
    elif stock_differences:
        priority = 2
        headline = "Reconcile stated stock before making a purchase decision"
        action = "Verify physical stock and the report's book basis; record a reviewed usable ROB before using this figure for replenishment."
        rationale = "The vessel-stated actual ROB and the report's book closing stock do not agree."
        value = "Protects replenishment decisions from relying on unreconciled stock."
        facts = [
            f"{oil['grade'] or oil['category']}: book {oil['closing']:,.1f} L; "
            f"vessel-stated actual {oil['actual_rob']:,.1f} L; "
            f"book minus actual {difference:+,.1f} L."
            for oil, difference in stock_differences
        ]
    elif stock_unavailable:
        priority = 3
        headline = "Verify stock basis before using ROB for purchasing"
        action = "Confirm the book closing figure against physical stock, then record reviewed usable ROB."
        rationale = "A vessel-stated actual quantity is present, but a comparable book closing quantity is unavailable."
        value = "Avoids treating an incomplete stock comparison as a purchasing input."
        facts = [f"{oil['grade'] or oil['category']}: book closing is unavailable." for oil in stock_unavailable]
    elif any(i["code"].startswith(("hours:", "zero_hours:")) or i["code"] == "ae_reconciliation" for i in significant):
        priority = 4
        relevant = next(i for i in significant if i["code"].startswith(("hours:", "zero_hours:")) or i["code"] == "ae_reconciliation")
        headline = "Validate operating data before comparing consumption"
        action = "Check the reporting period, machinery hours and pooled-versus-individual AE basis before using this month in efficiency or budget comparisons."
        rationale = relevant["detail"]
        value = "Keeps operating-rate comparisons grounded in reconciled hours and consumption."
        facts = []
    elif any(i["code"].startswith("system_balance:") for i in significant):
        priority = 5
        relevant = next(i for i in significant if i["code"].startswith("system_balance:"))
        headline = "Reconcile system movements before classifying consumption or loss"
        action = "Check storage withdrawal, replenishment, system quantity movement and recorded change/loss against the source report."
        rationale = relevant["detail"]
        value = "Prevents storage movements from being mislabeled as engine consumption or physical loss."
        facts = []
    elif any(i["code"].startswith("renewal:") for i in significant):
        priority = 6
        relevant = next(i for i in significant if i["code"].startswith("renewal:"))
        headline = "Confirm renewal evidence before adjusting the operating baseline"
        action = "Verify the engine, date and quantity from maintenance or vessel records; keep the quantity unknown until confirmed."
        rationale = relevant["detail"]
        value = "Avoids mixing renewal oil into normal operating consumption or a purchase forecast."
        facts = []
    elif significant:
        priority = 7
        relevant = significant[0]
        headline = "Check the reported exception for this month"
        action = "Inspect the cited source cells and remarks, and follow up with the vessel if needed."
        rationale = relevant["detail"]
        value = "Makes the monthly decision traceable to its source evidence."
        facts = []
    else:
        priority = None
        headline = "No priority exception detected in the parsed report"
        action = "No follow-up needed beyond routine monitoring."
        rationale = "This is not a finding that consumption is optimal or that the report is error-free."
        value = "Keeps the monthly picture evidence-led without overstating what this report establishes."
        facts = []

    if stock_differences:
        rationale += " Reported quantity differences are not proof of physical loss."
    boundary = "Cost exposure is not estimated because no reviewed oil price was supplied."
    return {
        "source_state": source_state,
        "headline": headline,
        "action": action,
        "rationale": rationale,
        "business_value": value,
        "facts": facts,
        "boundary": boundary,
        "priority": priority,
    }

