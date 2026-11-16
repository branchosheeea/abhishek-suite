"""Deterministic V1 compliance rules for Critical Job executions.

Rules confirmed by the user (16-Nov-2026):
- A critical job completed even one day after its due date needs a postponement that the
  vessel requested and the office approved. "Auto Approved By Vessel" is not office approval.
- The postponement must be requested on or before the due date it postpones; a request made
  after the job was already overdue is non-compliant. The job must be done by the approved
  new due date.
- Every critical job needs the office approval email attached. Recognised by file name;
  any attached e-mail file (.msg/.eml) also counts as the office approval.
- Every critical job needs its Risk Assessment attached (recognised by file name).
Missing or unverifiable evidence never passes: it fails or goes to human review.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import date

from .models import display_date, portal_date

PASS, FAIL, REVIEW, NA, INFO = "Pass", "Fail", "Review", "N/A", "Info"
COMPLIANT, NON_COMPLIANT, HUMAN_REVIEW = "Compliant", "Non-compliant", "Human review"

# File-name recognition, built from real attachment names on IMPALA, AMAZON and BRONCO.
OFFICE_NAME = re.compile(r"con+cur+[ae]nce|office\s*(approval|approved|consent)", re.IGNORECASE)
EMAIL_EXT = (".msg", ".eml")
RA_NAME = re.compile(
    r"(^|[^a-z])[a-z]{2,6}-[a-z]?ra-\d{2,4}"      # DIMP-ERA-2026-057, DBRO-ERA-2026-112
    r"|risk\s*assess"                            # Risk Assessment
    r"|(^|[^a-z])r\.?a(?=[^a-z]|$)",             # "RA" as a separate word
    re.IGNORECASE)
CWP_NAME = re.compile(r"(^|[^a-z])cwp(?=[^a-z]|$)|permit\s*to\s*work|work\s*permit|(^|[^a-z])ptw(?=[^a-z]|$)",
                      re.IGNORECASE)
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".heic", ".bmp", ".gif")


def classify(file_name: str) -> list[str]:
    name = (file_name or "").strip()
    lower = name.lower()
    kinds = []
    if OFFICE_NAME.search(name):
        kinds.append("office")
    if lower.endswith(EMAIL_EXT):
        kinds.append("email")
    if RA_NAME.search(name):
        kinds.append("ra")
    if CWP_NAME.search(name):
        kinds.append("cwp")
    if lower.endswith(PHOTO_EXT):
        kinds.append("photo")
    return kinds or ["other"]


def _text(value) -> str:
    return "" if value is None else " ".join(str(value).split())


def _flag(value) -> bool:
    return _text(value).upper() in {"Y", "YES", "TRUE", "1"}


@dataclass(frozen=True)
class Attachment:
    file_name: str
    mime: str
    size: str

    @property
    def kinds(self) -> list[str]:
        return classify(self.file_name)


@dataclass(frozen=True)
class Postponement:
    job_order_no: str
    job_plan_id: str
    due: str            # ISO local date being postponed
    new_due: str
    requested_on: str
    status: str         # APPROVED / REJECTED / PENDING
    approved_on: str
    auto_by_vessel: bool
    reason: str
    comments: str

    @classmethod
    def from_portal(cls, row: dict) -> "Postponement":
        return cls(job_order_no=_text(row.get("jobOrderNo")), job_plan_id=_text(row.get("jobPlanId")),
                   due=portal_date(row.get("dueDate")), new_due=portal_date(row.get("newDueDate")),
                   requested_on=portal_date(row.get("postPonedOn")), status=_text(row.get("approvalStatus")).upper(),
                   approved_on=portal_date(row.get("approvedOn")), auto_by_vessel=_flag(row.get("autoApdFrmVsl")),
                   reason=_text(row.get("reason")), comments=_text(row.get("comments")))

    def describe(self) -> str:
        who = "auto-approved by vessel" if self.auto_by_vessel else self.status.lower()
        return (f"requested {display_date(self.requested_on) or '?'}: due {display_date(self.due) or '?'} → "
                f"{display_date(self.new_due) or '?'}, {who}"
                + (f" {display_date(self.approved_on)}" if self.approved_on else "")
                + (f". Reason: {self.reason}" if self.reason else "")
                + (f". Office: {self.comments}" if self.comments else ""))


@dataclass
class Execution:
    job_order_no: str
    job_order_id: str
    job_plan_id: str
    title: str
    equipment_code: str
    equipment_name: str
    frequency: str
    done_date: str          # ISO local date (job end date)
    due_date: str           # current due date on the Job Order
    original_due_date: str  # due date before any postponement
    status: str
    approved_by: str
    approved_date: str
    done_by: str
    overdue_reason: str
    job_report: str
    attachment_count: int
    raw: dict = field(repr=False, default_factory=dict)

    @classmethod
    def from_portal(cls, row: dict) -> "Execution":
        due = portal_date(row.get("dueDate"))
        original = portal_date(row.get("originalDueDate"))
        if not original or original.startswith("0001"):
            original = due
        try:
            count = int(row.get("attachmentCount") or 0)
        except (TypeError, ValueError):
            count = 0
        interval, unit = _text(row.get("interval")), _text(row.get("frequencyName"))
        return cls(job_order_no=_text(row.get("jobOrderNo")), job_order_id=_text(row.get("jobOrderId") or row.get("id")),
                   job_plan_id=_text(row.get("jobplanId") or row.get("jobPlanId")), title=_text(row.get("jobTitle")),
                   equipment_code=_text(row.get("equipmentCode")), equipment_name=_text(row.get("equipmentName")),
                   frequency=f"{interval} {unit}".strip(), done_date=portal_date(row.get("jobEndDate")),
                   due_date=due, original_due_date=original, status=_text(row.get("jobStatus")).upper(),
                   approved_by=_text(row.get("approvedBy")), approved_date=portal_date(row.get("approvedDate")),
                   done_by=_text(row.get("doneBy")), overdue_reason=_text(row.get("overdueReason")),
                   job_report=_text(row.get("jobReport")), attachment_count=count, raw=row)


@dataclass(frozen=True)
class RuleResult:
    rule: str
    status: str
    detail: str


@dataclass
class Assessment:
    execution: Execution
    attachments: list[Attachment] | None       # None = could not be retrieved
    postponements: list[Postponement]
    results: list[RuleResult]
    verdict: str
    days_late: int | None

    def result(self, rule: str) -> RuleResult | None:
        return next((r for r in self.results if r.rule == rule), None)

    def issues(self) -> list[str]:
        return [f"{r.rule}: {r.detail}" for r in self.results if r.status in (FAIL, REVIEW)]

    def as_record(self) -> dict:
        return dict(results=[asdict(r) for r in self.results],
                    attachments=None if self.attachments is None else [asdict(a) | {"kinds": a.kinds} for a in self.attachments],
                    postponements=[asdict(p) for p in self.postponements])


R_TIME = "Completed by due date"
R_POSTPONE = "Postponement"
R_CE = "Chief Engineer approval"
R_OFFICE = "Office approval attached"
R_RA = "Risk Assessment attached"
R_CWP = "CWP attached"
R_EVIDENCE = "Attachments retrieved"
RULES = (R_TIME, R_POSTPONE, R_CE, R_OFFICE, R_RA, R_EVIDENCE)


def _days(later: str, earlier: str) -> int:
    return (date.fromisoformat(later) - date.fromisoformat(earlier)).days


def _postponement_rule(execution: Execution, baseline_due: str, postponements: list[Postponement]):
    """(status, detail, covering new due date or '') for a job completed after its due date."""
    done = execution.done_date
    office = [p for p in postponements if p.status == "APPROVED" and not p.auto_by_vessel and p.new_due]
    auto = [p for p in postponements if p.auto_by_vessel]
    others = [p for p in postponements if p.status in ("PENDING", "REJECTED")]
    if not postponements:
        return FAIL, "No postponement request found for this Job Order.", ""
    if not office:
        reasons = []
        if auto:
            reasons.append(f"{len(auto)} auto-approved by vessel (not office approval)")
        if others:
            reasons.append(", ".join(sorted({p.status.lower() for p in others})))
        return FAIL, "No office-approved postponement (" + "; ".join(reasons) + "). " + \
            " | ".join(p.describe() for p in postponements), ""
    late_requests = [p for p in office if p.requested_on and p.due and p.requested_on > p.due]
    missing_dates = [p for p in office if not p.requested_on or not p.due]
    covering = max(p.new_due for p in office)
    detail = " | ".join(p.describe() for p in sorted(office, key=lambda p: p.new_due))
    if late_requests:
        p = late_requests[0]
        return FAIL, (f"Postponement requested {display_date(p.requested_on)}, after the due date "
                      f"{display_date(p.due)} had passed. " + detail), covering
    if missing_dates:
        return REVIEW, "Postponement request or due date not recorded; cannot confirm it was raised in time. " + detail, covering
    if done > covering:
        return FAIL, (f"Done {display_date(done)}, after the approved new due date {display_date(covering)}. " + detail), covering
    return PASS, "Vessel request approved by office, raised before the due date, job done by the new due date. " + detail, covering


def assess(execution: Execution, attachments: list[Attachment] | None,
           postponements: list[Postponement]) -> Assessment:
    results: list[RuleResult] = []
    add = lambda rule, status, detail: results.append(RuleResult(rule, status, detail))
    mine = [p for p in postponements if p.job_order_no == execution.job_order_no]

    # Timeliness against the due date before any postponement.
    candidates = [d for d in (execution.original_due_date, execution.due_date, *[p.due for p in mine]) if d]
    baseline = min(candidates) if candidates else ""
    days_late = None
    if not execution.done_date or not baseline:
        add(R_TIME, REVIEW, "Done date or due date missing in Job History.")
        add(R_POSTPONE, REVIEW, "Cannot assess without both dates.")
    else:
        days_late = _days(execution.done_date, baseline)
        if days_late <= 0:
            add(R_TIME, PASS, f"Done {display_date(execution.done_date)}, due {display_date(baseline)}"
                + (f" ({-days_late} day(s) early)." if days_late < 0 else " (on the due date)."))
            add(R_POSTPONE, NA, "Not needed: completed by the due date.")
        else:
            status, detail, covering = _postponement_rule(execution, baseline, mine)
            late = f"Done {display_date(execution.done_date)}, {days_late} day(s) after due {display_date(baseline)}"
            if status == PASS:
                add(R_TIME, PASS, f"{late}, within the approved postponement to {display_date(covering)}.")
            else:
                add(R_TIME, FAIL if status == FAIL else REVIEW,
                    f"{late} without a valid postponement."
                    + (f" Overdue reason given: {execution.overdue_reason}" if execution.overdue_reason else ""))
            add(R_POSTPONE, status, detail)

    # Chief Engineer approval of the completed job.
    if "NOT APPROVED" in execution.status:
        add(R_CE, FAIL, f"Job status is {execution.status}.")
    elif "chief engineer" in execution.approved_by.lower():
        add(R_CE, PASS, f"Approved by {execution.approved_by} on {display_date(execution.approved_date) or '?'}.")
    elif execution.approved_by:
        add(R_CE, REVIEW, f"Approved by {execution.approved_by}, not the Chief Engineer.")
    else:
        add(R_CE, FAIL, "No approval recorded.")

    # Attachment evidence.
    if attachments is None:
        add(R_EVIDENCE, REVIEW, "The attachment list could not be retrieved from MariApps.")
        for rule in (R_OFFICE, R_RA):
            add(rule, REVIEW, "Attachments not retrieved.")
        add(R_CWP, INFO, "Attachments not retrieved.")
    else:
        mixed = len(attachments) != execution.attachment_count
        if mixed:
            add(R_EVIDENCE, REVIEW, f"Listed {len(attachments)} file(s) but the Job Order shows "
                                    f"{execution.attachment_count}; Job Plan documents may be included.")
        else:
            add(R_EVIDENCE, PASS, f"{len(attachments)} file(s) listed, matching the Job Order count.")

        def evidence(rule, wanted, label):
            found = [a.file_name for a in attachments if set(a.kinds) & wanted]
            if not found:
                add(rule, FAIL, f"No {label} found among {len(attachments)} attachment(s).")
            elif mixed:
                add(rule, REVIEW, f"Found '{found[0]}', but it may be a Job Plan document (count mismatch).")
            else:
                add(rule, PASS, "Found: " + "; ".join(found))
        evidence(R_OFFICE, {"office", "email"}, "office approval / concurrence file or e-mail")
        evidence(R_RA, {"ra"}, "Risk Assessment file")
        cwp = [a.file_name for a in attachments if "cwp" in a.kinds]
        add(R_CWP, INFO, ("Found: " + "; ".join(cwp)) if cwp else "No CWP file recognised (not part of the verdict).")

    statuses = {r.status for r in results}
    verdict = NON_COMPLIANT if FAIL in statuses else HUMAN_REVIEW if REVIEW in statuses else COMPLIANT
    return Assessment(execution, attachments, mine, results, verdict, days_late)


def summarise(assessments: list[Assessment], plan_ids: set[str], plans_overdue: list[str]) -> dict:
    counts = {v: sum(1 for a in assessments if a.verdict == v) for v in (COMPLIANT, NON_COMPLIANT, HUMAN_REVIEW)}
    covered = {a.execution.job_plan_id for a in assessments}
    return dict(executions=len(assessments), **{k.lower().replace(" ", "_").replace("-", "_"): v for k, v in counts.items()},
                plans=len(plan_ids), plans_with_execution=len(covered & plan_ids),
                plans_without_execution=sorted(plan_ids - covered), plans_overdue_now=plans_overdue)


def dumps(value) -> str:
    return json.dumps(value, sort_keys=True, default=str)
