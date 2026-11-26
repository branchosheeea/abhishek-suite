"""Shared Guarantee Claim rules: the ONE place that decides due dates, overdue days, action age, intervention,
priority, closure candidates, ownership and the Next Best Action (Master Specification v2, sections 9-25 and 31).

Every screen uses these functions: the web Command Centre, Claim Register and Claim Inspector, and the NeraVeda
Home page. They are pure functions over the stored records (plain dicts); they never read the database, never
read email text and never change anything. Suggestions made from emails (gc_manager.suggest) are passed in and
are kept apart from verified facts: a suggestion can add a REVIEW reason, but it never changes the verified owner,
the due date, the age or the priority class.

Dates: date-only fields (follow-up, dispatch, delivery, attendance, guarantee, pending-since) are compared as
calendar dates with no timezone conversion; "today" is this PC's local date. Timestamps (status changes) are
turned into this PC's local date.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
import re

from .rules import LABELS

CLOSED_STATES = {"CLOSED", "CANCELLED"}
OFFICE = "SUPERINTENDENT"
NO_OWNER = "NONE"

# Who holds the action, as shown on screen (agreed 26 Nov 2026). Display only: the stored waiting_on values stay.
OWNER_GROUPS = {
    "SUPERINTENDENT": "Office", "VENDOR_MAKER": "Makers", "SUPPLIER": "Makers", "SERVICE_COMPANY": "Makers",
    "SHIPYARD": "Shipyard", "VESSEL": "Vessel", "CLASS": "Class", "MULTIPLE_PARTIES": "Multiple parties", "NONE": None,
}
OWNER_ORDER = ("Office", "Makers", "Shipyard", "Vessel", "Class", "Multiple parties")
OWNER_NAMES = {"SUPERINTENDENT": "your office", "VENDOR_MAKER": "the maker", "SUPPLIER": "the supplier",
               "SERVICE_COMPANY": "the service company", "SHIPYARD": "the shipyard", "VESSEL": "the vessel",
               "CLASS": "Class", "MULTIPLE_PARTIES": "several parties"}

# A commitment is still pending while the claim has not reached the stage that fulfils it.
COMMITMENTS = (
    ("promised_dispatch_date", "Dispatch", {"IN_TRANSIT", "AWAITING_ATTENDANCE", "RECTIFICATION_IN_PROGRESS", "AWAITING_VERIFICATION", "MONITORING", "CLOSURE_PROPOSED"}),
    ("expected_delivery_date", "Delivery", {"AWAITING_ATTENDANCE", "RECTIFICATION_IN_PROGRESS", "AWAITING_VERIFICATION", "MONITORING", "CLOSURE_PROPOSED"}),
    ("service_attendance_date", "Attendance", {"RECTIFICATION_IN_PROGRESS", "AWAITING_VERIFICATION", "MONITORING", "CLOSURE_PROPOSED"}),
)
SEVERITY = {"URGENT": 0, "HIGH": 1, "NORMAL": 2, "LOW": 3}  # the claim's own Priority field (controlled)

# Reason categories. ACTION (P1/P2) and FOLLOW_UP (P3) are verified conditions; RECORD (P4) is missing controlled
# data; REVIEW (P4) is evidence or a suggestion a person must look at. Only verified categories set the class.
ACTION, FOLLOW_UP, RECORD, REVIEW = "ACTION", "FOLLOW_UP", "RECORD", "REVIEW"
VERIFIED = {ACTION, FOLLOW_UP, RECORD}
REASON_LABEL = {
    "WARRANTY_CRITICAL": "Guarantee expiry imminent", "WARRANTY_WINDOW": "Guarantee expiry approaching",
    "COMMITMENT_MISSED": "Commitment missed", "OFFICE_ACTION_OVERDUE": "Office action overdue", "OFFICE_ACTION_DUE": "Office action due today",
    "FOLLOW_UP_OVERDUE": "Follow-up overdue", "FOLLOW_UP_DUE": "Follow-up due today", "RECORD_INCOMPLETE": "Record incomplete",
    "CLOSURE_CANDIDATE": "Closure candidate", "REVIEW_OFFICE_TRANSFER": "Owner change suggested", "REVIEW_CLOSURE_SUGGESTED": "Closure suggested",
    "REVIEW_EVIDENCE_CONFLICT": "Evidence conflict", "REVIEW_SUGGESTIONS": "Suggestions to review", "REVIEW_NEW_EVIDENCE": "New evidence",
}
OVERDUE_CODES = {"FOLLOW_UP_OVERDUE", "OFFICE_ACTION_OVERDUE", "COMMITMENT_MISSED"}
CLASS_LABEL = {1: "Urgent", 2: "Action needed", 3: "Follow up", 4: "Check"}

# The four plain groups of the Command Centre (user's choice, 26 Nov 2026; replaces the 7-panel layout of spec 8).
YOUR_TURN, WAITING, READY_TO_CLOSE, NOT_SET_UP = "YOUR_TURN", "WAITING", "READY_TO_CLOSE", "NOT_SET_UP"
GROUP_ORDER = (YOUR_TURN, WAITING, READY_TO_CLOSE, NOT_SET_UP)
GROUP_LABEL = {YOUR_TURN: "Your turn", WAITING: "Waiting on others", READY_TO_CLOSE: "Ready to close", NOT_SET_UP: "Not set up"}

# Next-action provenance (section 17): these four labels must never be confused.
CONTROLLED, REMINDER, SUGGESTED, NOT_ESTABLISHED = "CONTROLLED", "REMINDER", "SUGGESTED", "NOT_ESTABLISHED"


# ---- dates --------------------------------------------------------------------------------------------------------

def day(value):
    """A stored date-only value as a date, without any timezone shift; None when missing or not a date."""
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def local_day(stamp):
    """A stored timestamp (UTC or with an offset) as this PC's local calendar date."""
    if not stamp:
        return None
    text = str(stamp).replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return day(text)
    return moment.astimezone().date() if moment.tzinfo else moment.date()


def gc_sort_key(gc_number):
    digits = re.sub(r"\D", "", gc_number or "")
    return (int(digits) if digits else 10**9, gc_number or "")


def owner_group(waiting_on):
    return OWNER_GROUPS.get(waiting_on or NO_OWNER)


def is_open(claim):
    return claim.get("current_status") not in CLOSED_STATES


# ---- single rules (spec 31) -----------------------------------------------------------------------------------------

@dataclass
class Due:
    date: date
    source: str   # FOLLOW_UP_DATE | COMMITMENT | DEFAULT
    label: str


def pending_commitments(claim):
    """(label, date) for every recorded commitment the claim's stage has not yet fulfilled."""
    status = claim.get("current_status")
    return [(label, day(claim.get(key))) for key, label, fulfilled in COMMITMENTS
            if day(claim.get(key)) and status not in fulfilled]


def follow_up_due(claim, settings):
    """Spec 15 precedence: 1 explicit follow-up date, 2 earliest pending commitment, 3 the configured default
    after the confirmed pending-since date. None when none of these is recorded (shown as "Not established")."""
    explicit = day(claim.get("next_follow_up_date"))
    if explicit:
        return Due(explicit, "FOLLOW_UP_DATE", "Follow-up due date")
    commitments = pending_commitments(claim)
    if commitments:
        label, when = min(commitments, key=lambda c: c[1])
        return Due(when, "COMMITMENT", f"{label} date")
    since = day(claim.get("action_since"))
    if since and (claim.get("waiting_on") or NO_OWNER) != NO_OWNER:
        days = int((settings or {}).get("standard_followup_days", 7))
        return Due(since + timedelta(days=days), "DEFAULT", f"{days} days after pending since")
    return None


def overdue_days(due, today):
    """0 up to and including the due date (due today is NOT overdue); 1 on the next calendar day."""
    return max(0, (today - due).days) if due else 0


def current_action_age(claim, today):
    """Days since the action became pending with the verified owner (the confirmed action_since date).
    Never from creation, emails or updates; None (shown "Not established") when that date is not recorded."""
    since = day(claim.get("action_since"))
    if since is None or (claim.get("waiting_on") or NO_OWNER) == NO_OWNER:
        return None
    return max(0, (today - since).days)


def warranty_exposure(vessel, settings, today):
    """Guarantee position for the claim's vessel; None when the expiry date is not recorded."""
    expiry = day((vessel or {}).get("guarantee_expiry_date"))
    if expiry is None:
        return None
    settings = settings or {}
    left = (expiry - today).days
    window = max(settings.get("guarantee_alert_days") or [90])
    critical = int(settings.get("guarantee_critical_days", 30))
    state = "EXPIRED" if left < 0 else "CRITICAL" if left <= critical else "WINDOW" if left <= window else "CLEAR"
    return {"expiry_date": expiry.isoformat(), "days_left": left, "state": state}


def closure_candidate(claim, settings, today):
    """Deterministic closure candidate from controlled facts only (status and how long it has been there).
    It never changes the status: a person still verifies and closes (spec 24)."""
    if not is_open(claim):
        return None
    status = claim.get("current_status")
    since = local_day(claim.get("last_status_change"))
    held = (today - since).days if since else None
    wait = int((settings or {}).get("verification_days", 5))
    if status == "CLOSURE_PROPOSED":
        return {"kind": "EVIDENCE_READY", "label": "Evidence ready for review", "text": "Closure is proposed; review the closure evidence."}
    if status == "MONITORING" and held is not None and held >= wait:
        return {"kind": "MONITORING_COMPLETE", "label": "Monitoring after repair", "text": f"Under monitoring for {held} days since the last status change."}
    if status == "AWAITING_VERIFICATION" and held is not None and held >= wait:
        return {"kind": "VERIFICATION_DUE", "label": "Repair awaiting verification", "text": f"Awaiting vessel verification for {held} days."}
    return None


# ---- assessment of one claim --------------------------------------------------------------------------------------

@dataclass
class Reason:
    code: str
    category: str
    klass: int
    text: str


@dataclass
class Assessment:
    claim_id: int
    gc_number: str
    open: bool
    owner: str | None            # verified owner group (None = not established)
    waiting_on: str
    pending_since: str | None
    age_days: int | None
    due: dict | None
    due_state: str | None        # OVERDUE | DUE_TODAY | UPCOMING | None
    overdue_days: int
    warranty: dict | None
    closure: dict | None
    reasons: list = field(default_factory=list)
    klass: int | None = None     # highest VERIFIED class; None when nothing needs intervention
    review: bool = False         # a review reason exists (shown as its own badge, never lowers the class)
    snoozed_until: str | None = None
    suggestions: list = field(default_factory=list)
    next_action: dict | None = None
    primary_action: str | None = None
    primary_target: str = "INSPECT"  # SETUP when the useful next step is the guided register set-up
    group: str | None = None     # YOUR_TURN / WAITING / READY_TO_CLOSE / NOT_SET_UP (open claims only)
    chips: list = field(default_factory=list)   # short plain facts: "Overdue 16 days", "Due 2 Dec"
    note: str | None = None      # what the emails suggest, in words, always ending "(check)"
    rank: tuple = ()

    @property
    def needs_intervention(self):
        return bool(self.reasons)

    def to_dict(self):
        data = asdict(self)
        data.pop("rank")
        data["needs_intervention"] = self.needs_intervention
        data["class_label"] = CLASS_LABEL.get(self.klass) if self.klass else None
        return data


def _fmt(d):
    return f"{d.day} {d.strftime('%b')}"


def _reasons(claim, due, state, late, warranty, closure, suggestions, unreviewed, settings, today):
    out = []
    owner = claim.get("waiting_on") or NO_OWNER
    who = OWNER_NAMES.get(owner, "the owner")
    if warranty and warranty["state"] == "CRITICAL":
        out.append(Reason("WARRANTY_CRITICAL", ACTION, 1, f"Guarantee expires in {warranty['days_left']} days ({_fmt(day(warranty['expiry_date']))})."))
    elif warranty and warranty["state"] == "WINDOW":
        out.append(Reason("WARRANTY_WINDOW", ACTION, 2, f"Guarantee expires in {warranty['days_left']} days ({_fmt(day(warranty['expiry_date']))})."))
    for label, when in pending_commitments(claim):
        if when < today:
            out.append(Reason("COMMITMENT_MISSED", ACTION, 2, f"{label} date {_fmt(when)} has passed (+{(today - when).days} days)."))
    if due and not (due.source == "COMMITMENT" and state == "OVERDUE"):  # a recorded date counts even without an owner
        if owner == OFFICE and state == "OVERDUE":
            out.append(Reason("OFFICE_ACTION_OVERDUE", ACTION, 2, f"Your office's action was due {_fmt(due.date)} (+{late} days)."))
        elif owner == OFFICE and state == "DUE_TODAY":
            out.append(Reason("OFFICE_ACTION_DUE", ACTION, 2, "Your office's action is due today."))
        elif state == "OVERDUE":
            out.append(Reason("FOLLOW_UP_OVERDUE", FOLLOW_UP, 3, f"Follow-up{' with ' + who if owner != NO_OWNER else ''} was due {_fmt(due.date)} (+{late} days)."))
        elif state == "DUE_TODAY":
            out.append(Reason("FOLLOW_UP_DUE", FOLLOW_UP, 3, f"Follow-up{' with ' + who if owner != NO_OWNER else ''} is due today."))
    missing = []
    if owner == NO_OWNER:
        missing.append("action owner")
    if not (claim.get("next_action") or "").strip():
        missing.append("next required action")
    if owner != NO_OWNER and not day(claim.get("action_since")):
        missing.append("pending-since date")
    if missing:
        out.append(Reason("RECORD_INCOMPLETE", RECORD, 4, "Not recorded: " + ", ".join(missing) + "."))
    if closure:
        out.append(Reason("CLOSURE_CANDIDATE", REVIEW, 4, closure["text"]))
    kinds = {s["kind"] for s in suggestions}
    if any(s["kind"] == "OWNER" and s["proposed"].get("waiting_on") == OFFICE for s in suggestions) and owner != OFFICE:
        out.append(Reason("REVIEW_OFFICE_TRANSFER", REVIEW, 4, "Action may now be with your office (suggestion, not verified)."))
    if "CLOSURE" in kinds:
        out.append(Reason("REVIEW_CLOSURE_SUGGESTED", REVIEW, 4, "An email suggests the claim can be closed (not verified)."))
    if "CONFLICT" in kinds:
        out.append(Reason("REVIEW_EVIDENCE_CONFLICT", REVIEW, 4, "Possible conflict in the evidence (see suggestions)."))
    others = len([s for s in suggestions if s["kind"] in {"OWNER", "PENDING_SINCE", "NEXT_ACTION", "STAGE", "LINK", "TITLE"}
                  and not (s["kind"] == "OWNER" and s["proposed"].get("waiting_on") == OFFICE)])
    if others:
        out.append(Reason("REVIEW_SUGGESTIONS", REVIEW, 4, f"{others} suggestion{'s' if others != 1 else ''} from emails to review."))
    if unreviewed:
        out.append(Reason("REVIEW_NEW_EVIDENCE", REVIEW, 4, f"{unreviewed} received email{'s' if unreviewed != 1 else ''} not reviewed yet."))
    return out


def _next_action(claim, assessment, suggestions):
    """Spec 17: the next move and where it comes from. A proposal is never labelled as an approved instruction."""
    text = (claim.get("next_action") or "").strip()
    if text:
        return {"kind": CONTROLLED, "label": "Agreed next step", "text": text}
    owner = claim.get("waiting_on") or NO_OWNER
    if assessment.due and assessment.due_state in {"OVERDUE", "DUE_TODAY"}:
        when = "is due today" if assessment.due_state == "DUE_TODAY" else f"was due {_fmt(day(assessment.due['date']))}"
        if owner == OFFICE:
            return {"kind": REMINDER, "label": "Reminder (from the due date)", "text": f"Your office's action {when}. Decide and record the next step."}
        return {"kind": REMINDER, "label": "Reminder (from the due date)", "text": f"Follow up with {OWNER_NAMES.get(owner, 'the party holding the action')}: the {assessment.due['label'].lower()} {when}."}
    proposal = next((s for s in suggestions if s["kind"] == "NEXT_ACTION"), None)
    if proposal:
        return {"kind": SUGGESTED, "label": "Suggested by email (not confirmed)", "text": proposal["proposed"]["next_action"], "suggestion_key": proposal["key"]}
    return {"kind": NOT_ESTABLISHED, "label": "No next step recorded",
            "text": "No reliable next action is recorded. Review the claim and record who holds the action and what happens next."}


def _primary_action(assessment):
    """The specific verb for the row button (spec 21), from the most important reason. Verified conditions come
    first; next, a claim with no verified owner is set up before any email suggestion is looked at."""
    codes = [r.code for r in assessment.reasons]
    verified = {"COMMITMENT_MISSED", "OFFICE_ACTION_OVERDUE", "OFFICE_ACTION_DUE", "WARRANTY_CRITICAL", "WARRANTY_WINDOW",
                "FOLLOW_UP_OVERDUE", "FOLLOW_UP_DUE"}
    if "RECORD_INCOMPLETE" in codes and not verified & set(codes):
        return "Set up this claim" if assessment.waiting_on == NO_OWNER else "Complete record"
    for code, verb in (("COMMITMENT_MISSED", "Confirm attendance" if any("Attendance" in r.text for r in assessment.reasons) else "Chase commitment"),
                       ("OFFICE_ACTION_OVERDUE", "Act now"), ("OFFICE_ACTION_DUE", "Act now"), ("WARRANTY_CRITICAL", "Review exposure"),
                       ("WARRANTY_WINDOW", "Review exposure"), ("FOLLOW_UP_OVERDUE", "Prepare follow-up"), ("FOLLOW_UP_DUE", "Prepare follow-up"),
                       ("REVIEW_OFFICE_TRANSFER", "Review suggestion"), ("REVIEW_CLOSURE_SUGGESTED", "Verify closure"),
                       ("CLOSURE_CANDIDATE", "Verify closure"), ("REVIEW_EVIDENCE_CONFLICT", "Review evidence"),
                       ("RECORD_INCOMPLETE", "Complete record"), ("REVIEW_SUGGESTIONS", "Review suggestion"),
                       ("REVIEW_NEW_EVIDENCE", "Review evidence")):
        if code in codes:
            return verb
    return None


def assess(claim, *, settings=None, vessel=None, today=None, suggestions=(), unreviewed=0, snoozed_until=None):
    """Everything the screens show about one claim, from controlled facts. `suggestions` (gc_manager.suggest) and
    `unreviewed` (received emails not marked reviewed) only add REVIEW reasons."""
    today = today or date.today()
    settings = settings or {}
    open_ = is_open(claim)
    suggestions = list(suggestions) if open_ else []
    due = follow_up_due(claim, settings) if open_ else None
    late = overdue_days(due.date, today) if due else 0
    state = None if not due else "OVERDUE" if late else "DUE_TODAY" if due.date == today else "UPCOMING"
    warranty = warranty_exposure(vessel, settings, today)
    closure = closure_candidate(claim, settings, today) if open_ else None
    age = current_action_age(claim, today) if open_ else None
    reasons = _reasons(claim, due, state, late, warranty, closure, suggestions, unreviewed if open_ else 0, settings, today) if open_ else []
    verified = [r.klass for r in reasons if r.category in VERIFIED]
    snooze = snoozed_until if snoozed_until and day(snoozed_until) and day(snoozed_until) >= today else None
    result = Assessment(
        claim_id=claim["id"], gc_number=claim["gc_number"], open=open_, owner=owner_group(claim.get("waiting_on")),
        waiting_on=claim.get("waiting_on") or NO_OWNER, pending_since=claim.get("action_since") or None, age_days=age,
        due={"date": due.date.isoformat(), "source": due.source, "label": due.label} if due else None,
        due_state=state, overdue_days=late, warranty=warranty, closure=closure, reasons=reasons,
        klass=min(verified) if verified else (4 if reasons else None), review=any(r.category == REVIEW for r in reasons),
        snoozed_until=snooze, suggestions=suggestions)
    result.next_action = _next_action(claim, result, suggestions) if open_ else None
    result.primary_action = _primary_action(result)
    result.primary_target = "SETUP" if result.primary_action == "Set up this claim" else "INSPECT"
    result.group = work_group(result)
    result.chips = plain_chips(result, today)
    result.note = suggestion_note(result)
    # Spec 16 ordering inside a class: controlled severity, warranty proximity, overdue days, action age, then the
    # unreviewed developments, then the GC number as the final stable tie-breaker. Among the unreviewed developments,
    # a reply that appears to wait on your office comes first (longest waiting first), then the oldest other suggestion.
    # This only orders claims inside the same class: a suggestion never lifts a claim into a higher class.
    office_wait = max((s.get("age_days") or 0 for s in suggestions
                       if s["kind"] == "OWNER" and s["proposed"].get("waiting_on") == OFFICE and result.waiting_on != OFFICE), default=None)
    oldest_suggestion = max((s.get("age_days") or 0 for s in suggestions), default=0)
    result.rank = (result.klass or 9, SEVERITY.get(claim.get("priority") or "NORMAL", 2),
                   warranty["days_left"] if warranty and warranty["state"] in {"CRITICAL", "WINDOW"} else 10**6,
                   -late, -(age or 0), 0 if office_wait is not None else 1, -(office_wait or 0), -oldest_suggestion,
                   gc_sort_key(claim["gc_number"]))
    return result


# ---- views over many claims -----------------------------------------------------------------------------------------

def ranked(assessments):
    """Open claims that need intervention, most important first (deterministic)."""
    return sorted((a for a in assessments if a.open and a.needs_intervention), key=lambda a: a.rank)


def next_best(assessments):
    """Spec 22: a snoozed claim gives way only to an unsnoozed claim of equal or higher priority."""
    queue = ranked(assessments)
    if not queue:
        return None
    first = queue[0]
    if first.snoozed_until:
        alternative = next((a for a in queue if not a.snoozed_until and a.klass <= first.klass), None)
        return alternative or first
    return first


def ownership_summary(assessments):
    """Spec 23: verified owner only, open claims only; overdue = an overdue follow-up or missed commitment."""
    rows = {name: {"owner": name, "open": 0, "overdue": 0, "oldest_days": None} for name in OWNER_ORDER}
    not_established = 0
    for a in assessments:
        if not a.open:
            continue
        if a.owner is None:
            not_established += 1
            continue
        row = rows[a.owner]
        row["open"] += 1
        if any(r.code in OVERDUE_CODES for r in a.reasons):
            row["overdue"] += 1
        if a.age_days is not None:
            row["oldest_days"] = max(row["oldest_days"] or 0, a.age_days)
    return {"groups": [rows[name] for name in OWNER_ORDER], "not_established": not_established}


def headline(assessments):
    """Spec 9: counts behind the operational headline, with the breakdown kept discoverable."""
    open_ = [a for a in assessments if a.open]
    need = [a for a in open_ if a.needs_intervention]
    def top(a):
        if a.klass in (1, 2):
            return "verified_action"
        if a.klass == 3:
            return "follow_up"
        if any(r.category == RECORD for r in a.reasons):
            return "record_incomplete"
        return "review_only"
    breakdown = {"verified_action": 0, "follow_up": 0, "record_incomplete": 0, "review_only": 0}
    for a in need:
        breakdown[top(a)] += 1
    return {
        "need_intervention": len(need), "breakdown": breakdown,
        "with_office": sum(1 for a in open_ if a.waiting_on == OFFICE),
        "closure_candidates": sum(1 for a in open_ if a.closure),
        "closure_suggestions": sum(1 for a in open_ if any(s["kind"] == "CLOSURE" for s in a.suggestions)),
        "owner_suggestions": sum(1 for a in open_ if any(s["kind"] == "OWNER" for s in a.suggestions)),
        "snoozed": sum(1 for a in open_ if a.snoozed_until),
    }


def closure_control(assessments):
    """Spec 24: deterministic candidates and email suggestions are separate populations."""
    candidates = [a for a in assessments if a.open and a.closure]
    groups = {}
    for a in candidates:
        groups.setdefault(a.closure["label"], 0)
        groups[a.closure["label"]] += 1
    suggested = [a for a in assessments if a.open and not a.closure and any(s["kind"] == "CLOSURE" for s in a.suggestions)]
    return {"candidates": len(candidates), "by_kind": [{"label": k, "count": v} for k, v in groups.items()],
            "candidate_claims": [a.claim_id for a in candidates],
            "suggestions": len(suggested), "suggestion_claims": [a.claim_id for a in suggested]}


def status_label(status):
    return LABELS.get(status, status)


DEVELOPMENT_ORDER = ("ACTION REQUIRED", "REVIEW REQUIRED", "MATERIAL UPDATE", "INFORMATIONAL")
SUGGESTION_HEADLINES = {
    "CLOSURE": "Closure may be possible", "CONFLICT": "Possible evidence conflict",
    "LINK": "An email may also concern this claim", "STAGE": "The claim stage may have moved",
}


def developments(history, assessments, since):
    """Spec 19: meaningful changes since `since` (a date), not unread emails, one entry per claim with its points.
    Controlled changes come from the status history; email-based points are REVIEW REQUIRED suggestions and never
    say that a change happened."""
    by_id = {a.claim_id: a for a in assessments}
    points = []
    for row in history:
        when = local_day(row.get("changed_at"))
        a = by_id.get(row.get("claim_id"))
        if a is None or when is None or when < since:
            continue
        base = {"claim_id": a.claim_id, "date": when.isoformat(), "source": "Claim history", "verified": True, "text": row.get("reason") or ""}
        previous, new = row.get("previous_waiting_on"), row.get("new_waiting_on")
        if not row.get("previous_status"):
            points.append({**base, "category": "INFORMATIONAL", "title": "Claim registered"})
        elif previous != new and new == OFFICE:
            points.append({**base, "category": "ACTION REQUIRED", "title": "Action passed to your office"})
        elif row.get("source") == "REOPENED":
            points.append({**base, "category": "MATERIAL UPDATE", "title": "Claim reopened"})
        elif row.get("previous_status") != row.get("new_status"):
            points.append({**base, "category": "MATERIAL UPDATE", "title": f"Status: {status_label(row.get('new_status'))}"})
        elif previous != new:
            points.append({**base, "category": "MATERIAL UPDATE", "title": f"Action now with {OWNER_NAMES.get(new, 'nobody recorded')}"})
    for a in assessments:
        for s in a.suggestions:
            when = day(s.get("evidence_date"))
            if s["kind"] in {"PENDING_SINCE", "NEXT_ACTION", "TITLE"} or when is None or when < since:
                continue
            if s["kind"] == "OWNER":
                target = s["proposed"].get("waiting_on")
                title = "Action may have transferred to your office" if target == OFFICE else f"Action may now be with {OWNER_NAMES.get(target, 'another party')}"
            else:
                title = SUGGESTION_HEADLINES.get(s["kind"], "Suggestion to review")
            points.append({"claim_id": a.claim_id, "date": when.isoformat(), "source": "Email suggestion", "verified": False,
                           "category": "REVIEW REQUIRED", "title": title, "text": s["reason"], "suggestion_key": s["key"]})
    order = lambda p: (DEVELOPMENT_ORDER.index(p["category"]), -day(p["date"]).toordinal())
    groups = {}
    for p in sorted(points, key=order):
        groups.setdefault(p["claim_id"], []).append(p)
    items = []
    for claim_id, group in groups.items():
        top = group[0]  # the most important point (category first, then newest)
        items.append({"claim_id": claim_id, "gc_number": by_id[claim_id].gc_number, "category": top["category"],
                      "date": max(p["date"] for p in group), "verified": all(p["verified"] for p in group),
                      "title": top["title"], "text": top["text"], "source": top["source"],
                      "points": [{k: p[k] for k in ("category", "title", "text", "date", "verified")} for p in group[1:]
                                 if p["category"] != "INFORMATIONAL"]})
    items.sort(key=lambda i: (DEVELOPMENT_ORDER.index(i["category"]), -day(i["date"]).toordinal(), gc_sort_key(i["gc_number"])))
    counts = {c: sum(1 for i in items if i["category"] == c) for c in DEVELOPMENT_ORDER}
    return {"since": since.isoformat(), "items": items, "counts": counts, "points": len(points)}



# ---- plain groups and words (Command Centre since 26 Nov 2026) ------------------------------------------------------

def work_group(a):
    """Where an open claim sits on the Command Centre. Verified facts decide, except Ready to close, which also takes
    an email saying the claim can be closed (shown as "check", never as closed)."""
    if not a.open:
        return None
    if any(r.code == "RECORD_INCOMPLETE" for r in a.reasons):
        return NOT_SET_UP
    if a.closure or any(s["kind"] == "CLOSURE" for s in a.suggestions):
        return READY_TO_CLOSE
    return YOUR_TURN if a.waiting_on == OFFICE else WAITING


def plain_chips(a, today):
    """Short facts for a row, each with a tone for colour (the words carry the meaning on their own)."""
    chips = []
    for r in a.reasons:
        if r.code == "COMMITMENT_MISSED":
            chips.append({"text": r.text.replace(" has passed", " passed").rstrip("."), "tone": "danger"})
    if a.due_state == "OVERDUE" and not chips:
        chips.append({"text": f"Overdue {a.overdue_days} day{'s' if a.overdue_days != 1 else ''}", "tone": "danger"})
    elif a.due_state == "DUE_TODAY":
        chips.append({"text": "Due today", "tone": "warn"})
    elif a.due_state == "UPCOMING" and a.due:
        chips.append({"text": f"Due {_fmt(day(a.due['date']))}", "tone": "muted"})
    if a.warranty and a.warranty["state"] in {"CRITICAL", "WINDOW"}:
        chips.append({"text": f"Guarantee ends in {a.warranty['days_left']} days", "tone": "danger" if a.warranty["state"] == "CRITICAL" else "warn"})
    if a.closure:
        chips.append({"text": a.closure["label"], "tone": "info"})
    if a.snoozed_until:
        chips.append({"text": f"Snoozed until {_fmt(day(a.snoozed_until))}", "tone": "muted"})
    return chips


def suggestion_note(a):
    """The most useful email suggestion, in words, marked "(check)": it is never a confirmed fact."""
    def who(s):  # "the vessel" -> "The vessel"
        author = s.get("evidence_author") or "a sender"
        return author[0].upper() + author[1:]
    def when(s):
        d = day(s.get("evidence_date"))
        return f" {_fmt(d)}" if d else ""
    by_kind = {}
    for s in a.suggestions:
        by_kind.setdefault(s["kind"], s)
    owner = by_kind.get("OWNER")
    if owner and owner["proposed"].get("waiting_on") == OFFICE and a.waiting_on not in (OFFICE, NO_OWNER):
        return f"{who(owner)} replied{when(owner)}: may be your turn (check)"
    if "CLOSURE" in by_kind:
        return f"{who(by_kind['CLOSURE'])} wrote{when(by_kind['CLOSURE'])} that it can be closed (check)"
    if owner and a.waiting_on not in (NO_OWNER,) and owner["proposed"].get("waiting_on") != a.waiting_on:
        return f"May now be with {OWNER_NAMES.get(owner['proposed'].get('waiting_on'), 'someone else')} (check)"
    if "CONFLICT" in by_kind:
        return f"Possible typing error: {by_kind['CONFLICT']['proposed'].get('mentioned')} in an email (check)"
    if "LINK" in by_kind:
        return "Another email may also belong to this claim (check)"
    return None


STAGE_PROGRESS = {  # how far along the claim life a stage is, for the progress bar (display only)
    "DRAFT": 5, "SUBMITTED": 15, "INFO_REQUIRED": 20, "UNDER_REVIEW": 25, "DISPUTED": 25, "ACCEPTED": 35, "REMEDY_AGREED": 45,
    "AWAITING_SUPPLY": 55, "IN_TRANSIT": 65, "AWAITING_ATTENDANCE": 70, "RECTIFICATION_IN_PROGRESS": 75,
    "AWAITING_VERIFICATION": 85, "MONITORING": 90, "CLOSURE_PROPOSED": 95, "CLOSED": 100, "CANCELLED": 100,
}


def display_group(a):
    """(group, confirmed) for the dashboard. A confirmed record decides. Without a verified owner, the claim is placed
    where its emails point (closure email, or whose turn it is), always shown as "from emails" until confirmed."""
    if not a.open:
        return None, True
    if a.group != NOT_SET_UP:
        return a.group, True
    if a.waiting_on != NO_OWNER:  # owner confirmed, other facts missing
        return (YOUR_TURN if a.waiting_on == OFFICE else WAITING), True
    kinds = {}
    for s in a.suggestions:
        kinds.setdefault(s["kind"], s)
    if "CLOSURE" in kinds:
        return READY_TO_CLOSE, False
    owner = kinds.get("OWNER")
    if owner:
        return (YOUR_TURN if owner["proposed"].get("waiting_on") == OFFICE else WAITING), False
    return NOT_SET_UP, False
