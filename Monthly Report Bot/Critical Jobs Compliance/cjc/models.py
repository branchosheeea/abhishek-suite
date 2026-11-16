"""Job Plan records and the evidence-based reconciliation of an extraction."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime

from .config import FilterProfile


class PortalError(RuntimeError):
    """The portal did not behave as verified; nothing should be trusted from this attempt."""


def parse_record_count(label: str | None) -> int | None:
    """'3,111 records found' -> 3111. None when the label is missing or unrecognised."""
    match = re.search(r"(\d[\d,]*)\s+records?\s+found", label or "", re.IGNORECASE)
    return int(match.group(1).replace(",", "")) if match else None


def portal_date(value) -> str:
    """Portal timestamps are UTC ('2026-09-15 16:00:00+00:00'); the grid shows the
    browser's local date. Convert the same way and return ISO 'YYYY-MM-DD' ('' if blank)."""
    if not value:
        return ""
    try:
        moment = datetime.fromisoformat(str(value).strip())
    except ValueError:
        return ""
    if moment.tzinfo is not None:
        try:
            moment = moment.astimezone()  # local machine zone == the browser's display zone
        except (OSError, OverflowError):
            # Sentinel dates (e.g. year 1 or 9999) are outside the OS clock; shift by today's offset.
            offset = datetime.now().astimezone().utcoffset()
            try:
                moment = (moment + offset - moment.utcoffset()).replace(tzinfo=None)
            except OverflowError:
                pass
    return moment.date().isoformat()


def display_date(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%d-%b-%Y") if iso else ""


def _text(value) -> str:
    return "" if value is None else " ".join(str(value).split())


@dataclass(frozen=True)
class JobPlan:
    job_plan_id: str
    equipment_code: str
    equipment_name: str
    title: str
    job_type: str
    maintenance_type: str
    frequency: str
    discipline: str
    last_done_date: str      # ISO local date
    next_due_date: str       # ISO local date
    last_done_hrs: str
    next_due_hrs: str
    since_last_done: str
    remaining: str
    critical_to_safety: str
    risk_assessment: str
    safety_level: str
    priority: str
    maintenance_cause: str
    job_assigned: str
    remark: str
    vessel_object_id: str
    raw: dict = field(compare=False, repr=False)

    @classmethod
    def from_portal(cls, row: dict) -> "JobPlan":
        number = lambda key: "" if row.get(key) in (None, "") else _text(row.get(key))
        return cls(
            job_plan_id=number("jobPlanId"),
            equipment_code=_text(row.get("equipmentCode")),
            equipment_name=_text(row.get("equipmentName")),
            title=_text(row.get("title")),
            job_type=_text(row.get("jobType")),
            maintenance_type=_text(row.get("maintenanceType")),
            frequency=_text(row.get("frequency")),
            discipline=_text(row.get("rank")),
            last_done_date=portal_date(row.get("lastDoneDate")),
            next_due_date=portal_date(row.get("nextDueDate")),
            last_done_hrs=number("lastDoneHrs"),
            next_due_hrs=number("nextDueHrs"),
            since_last_done=_text(row.get("daysOrHrsSinceDone")),
            remaining=_text(row.get("remainingDaysOrHrs")),
            critical_to_safety=_text(row.get("criticalSafety")),
            risk_assessment=_text(row.get("riskAnalysis")),
            safety_level=_text(row.get("safetyLevel")),
            priority=_text(row.get("priority")),
            maintenance_cause=_text(row.get("maintenanceCause")),
            job_assigned=_text(row.get("jobAssigned")),
            remark=_text(row.get("remark")),
            vessel_object_id=number("vesselObjectId"),
            raw=row,
        )

    def raw_json(self) -> str:
        return json.dumps(self.raw, sort_keys=True, default=str)


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


@dataclass
class Reconciliation:
    displayed_count: int | None
    extracted_count: int
    checks: list[Check]

    @property
    def passed(self) -> bool:
        return bool(self.checks) and all(check.passed for check in self.checks)

    def failures(self) -> list[Check]:
        return [check for check in self.checks if not check.passed]

    def as_record(self) -> dict:
        return dict(displayed_count=self.displayed_count, extracted_count=self.extracted_count,
                    passed=self.passed, checks=[asdict(check) for check in self.checks])


@dataclass
class Extraction:
    """Everything a run observed, as evidence for reconciliation."""
    vessel: str
    vessel_box_value: str
    tree_root: str
    selected_node: str
    count_label: str | None
    datasource_total: int | None
    rows: list[dict]
    dom_row_count: int
    read_payloads: list[dict]
    filter_readback: dict[str, str]
    sublevel_checked: bool
    overdue_checked: bool


def reconcile(extraction: Extraction, profile: FilterProfile) -> Reconciliation:
    """Every check must pass before the population is treated as complete."""
    checks: list[Check] = []
    add = lambda name, passed, detail: checks.append(Check(name, bool(passed), detail))
    displayed = parse_record_count(extraction.count_label)
    rows = extraction.rows
    count = len(rows)

    add("Vessel selected", extraction.vessel_box_value.strip() == extraction.vessel,
        f"Header vessel box shows '{extraction.vessel_box_value.strip()}'.")
    add("Equipment tree belongs to vessel", extraction.tree_root.strip() == extraction.vessel,
        f"Tree root is '{extraction.tree_root.strip()}'.")
    add("Equipment node selected", extraction.selected_node.strip() == profile.equipment_node,
        f"Selected node is '{extraction.selected_node.strip()}'.")

    wrong = {label: shown for label, shown in extraction.filter_readback.items()
             if shown != profile.option_for(label)}
    add("Filters read back as configured", not wrong and len(extraction.filter_readback) > 0,
        "All dropdowns match the profile." if not wrong else
        "; ".join(f"{label} shows '{shown}', expected '{profile.option_for(label)}'" for label, shown in wrong.items()))
    add("Checkboxes read back as configured",
        extraction.sublevel_checked == profile.show_sublevel and extraction.overdue_checked == profile.show_overdue,
        f"Show Sublevel = {extraction.sublevel_checked}, Show Overdue = {extraction.overdue_checked}.")

    payloads = extraction.read_payloads
    bad_payloads = [p for p in payloads
                    if any(p.get(key) != value for key, value in profile.expected_payload.items())]
    add("Portal received the filters", payloads and not bad_payloads,
        f"{len(payloads)} grid read request(s) observed"
        + ("; all carried the expected filters." if payloads and not bad_payloads else
           "; none observed." if not payloads else f"; {len(bad_payloads)} carried different filters."))
    equipment_ids = {p.get("equipId") for p in payloads}
    add("All pages used one equipment node", len(equipment_ids) == 1 and None not in equipment_ids
        and all(isinstance(e, int) and e > 0 for e in equipment_ids),
        f"Equipment ids requested: {sorted(map(str, equipment_ids)) or 'none'}.")

    final = (payloads[-1].get("gridServerOperations") or {}) if payloads else {}
    add("Population read without page boundaries",
        displayed is not None and final.get("page") == 1 and (final.get("pageSize") or 0) >= displayed,
        f"Final read: page {final.get('page')}, page size {final.get('pageSize')}, for {displayed} rows. "
        "(Portal paging is unstable across pages, so the full population must come from one read.)")

    add("Record count displayed", displayed is not None,
        f"Label: '{extraction.count_label}'." if extraction.count_label else "No 'records found' label.")
    add("Grid total matches displayed count", displayed is not None and extraction.datasource_total == displayed,
        f"Grid total {extraction.datasource_total} vs displayed {displayed}.")
    add("Extracted rows match displayed count", displayed is not None and count == displayed,
        f"Extracted {count} vs displayed {displayed}.")
    add("Rendered rows match displayed count", displayed is not None and extraction.dom_row_count == displayed,
        f"Rendered {extraction.dom_row_count} vs displayed {displayed}.")
    server_totals = {row.get("totalCount") for row in rows}
    add("Server total agrees", not rows or server_totals == {displayed},
        f"Row totalCount values: {sorted(map(str, server_totals)) or 'n/a'}.")

    ids = [row.get("jobPlanId") for row in rows]
    missing = sum(1 for value in ids if value in (None, "", 0))
    duplicates = count - len(set(ids))
    add("Job Plan ids unique and present", missing == 0 and duplicates == 0,
        f"{missing} missing, {duplicates} duplicate id(s).")

    vessels = {row.get("vesselObjectId") for row in rows}
    add("All rows from one vessel", len(vessels) <= 1, f"Vessel object ids: {sorted(map(str, vessels))}.")

    for key, value in profile.expected_row_values.items():
        off = [row for row in rows if _text(row.get(key)).upper() != value.upper()]
        add(f"Every row has {key} = {value}", not off,
            "All rows comply." if not off else f"{len(off)} row(s) differ, e.g. job plan {off[0].get('jobPlanId')}.")

    return Reconciliation(displayed, count, checks)
