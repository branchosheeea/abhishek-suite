"""Views of the Guarantee Claim records for the NeraVeda web pages (read-only).

Phase 2 showed the stored facts. Phase 3 adds the shared rules (gc_manager.command: due, overdue, age, priority,
ownership, closure, Next Best Action) and the email suggestions (gc_manager.suggest). The Command Centre, the
Claim Register and the Claim Inspector all take their rule results from `_assessed`, so they cannot disagree.
Where a fact is not recorded the value is None, never a guess, so the page can say "Not recorded".
Vessel scope: the tracked vessels (Settings, empty = all) that have claims.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from suite_services.database import connection
from . import command, suggest
from .command import OWNER_GROUPS, OWNER_ORDER, owner_group  # noqa: F401  (display groups, shared with Home)
from .repository import tracked_ids
from .rules import LABELS, extract_gc_numbers

CLOSED_STATES = command.CLOSED_STATES
FOCUS = ("intervention", "office", "overdue", "closure", "suggestions", "incomplete",
         "your_turn", "waiting", "ready_to_close", "not_set_up")  # the last four are the Command Centre groups
GROUP_FOCUS = {"your_turn": command.YOUR_TURN, "waiting": command.WAITING, "ready_to_close": command.READY_TO_CLOSE,
               "not_set_up": command.NOT_SET_UP}
SORTS = ("gc", "priority")
SEARCH_LIMIT = 8

# Email columns the web may see. Bodies (sanitised_body), raw metadata and internal keys stay in the database.
EMAIL_FIELDS = ("id", "claim_id", "mailbox_folder", "direction", "subject", "sender_name", "sender_address", "message_datetime",
                "body_preview", "has_attachments", "reviewed_at", "imported_at", "vessel_match_type", "matched_vessel_id")
CORRESPONDENCE_PAGE = 50


class ViewError(ValueError):
    """A request the views cannot answer: kind is bad_request or not_found."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def email_view(row):
    view = {key: row.get(key) for key in EMAIL_FIELDS}
    view["has_attachments"] = bool(view["has_attachments"])
    for key, column in (("recipients", "recipients_json"), ("gc_numbers", "detected_gc_numbers_json")):
        try:
            view[key] = json.loads(row.get(column) or "[]")
        except ValueError:
            view[key] = []
    return view


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _like(text):
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ---- vessel scope -------------------------------------------------------------------------------------------------

def scope(repo):
    """Vessels this module shows: tracked (or all) vessels that have claims, by name."""
    vessels = repo.vessels(False)
    tracked = tracked_ids(repo.settings().get("tracked_vessels"), vessels)
    with connection(repo.root) as db:
        counts = {r[0]: r[1] for r in db.execute("SELECT vessel_id, COUNT(*) FROM gc_claims GROUP BY vessel_id")}
    shown = [{"id": v["id"], "name": v["name"], "claims": counts[v["id"]]} for v in vessels
             if v["id"] in counts and (tracked is None or v["id"] in tracked)]
    return {"vessels": shown, "tracked": list(repo.settings().get("tracked_vessels") or []), "all_vessels": tracked is None}


def _vessel(repo, vessel_id):
    vessels = scope(repo)["vessels"]
    if vessel_id is None:
        return vessels[0] if vessels else None
    found = next((v for v in vessels if v["id"] == vessel_id), None)
    if found is None:
        raise ViewError("not_found", "This vessel has no claims in the Guarantee Claim Manager, or is not tracked.")
    return found


# ---- rules for a vessel's claims (one place for every screen) -----------------------------------------------------

def _table_exists(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _assessed(repo, vessel, today=None):
    """Claims of the vessel with their emails, suggestions and shared-rule assessment. Bodies stay in here."""
    today = today or date.today()
    settings = repo.settings()
    claims = [c for c in repo.claims() if c["vessel_id"] == vessel["id"]]
    emails = {c["id"]: [] for c in claims}
    decided, snoozes = set(), {}
    with connection(repo.root) as db:
        # The same emails as Repository.emails(claim), for all the vessel's claims in one read (oldest first).
        for row in db.execute("""SELECT x.claim_key, e.* FROM (
                SELECT e.id email_id, e.claim_id claim_key FROM gc_emails e JOIN gc_claims c ON c.id = e.claim_id WHERE c.vessel_id = ?
                UNION SELECT l.email_id, l.claim_id FROM gc_email_claim_links l JOIN gc_claims c ON c.id = l.claim_id WHERE c.vessel_id = ?) x
                JOIN gc_emails e ON e.id = x.email_id ORDER BY e.message_datetime, e.id""", (vessel["id"], vessel["id"])):
            email = dict(row)
            emails[email.pop("claim_key")].append(email)
        if _table_exists(db, "gc_suggestions"):
            decided = {r[0] for r in db.execute("SELECT suggestion_key FROM gc_suggestions WHERE status <> 'OPEN'")}
        if _table_exists(db, "gc_snoozes"):
            snoozes = {r[0]: r[1] for r in db.execute(
                "SELECT claim_id, MAX(snoozed_until) FROM gc_snoozes WHERE cleared_at IS NULL GROUP BY claim_id")}
    found = suggest.for_vessel(claims, emails, settings, today, decided)
    details = repo.vessel(vessel["id"])
    result = []
    for claim in claims:
        since = command.day(claim.get("action_since"))
        unreviewed = sum(1 for e in emails[claim["id"]] if e.get("direction") == "INCOMING" and not e.get("reviewed_at")
                         and (since is None or (command.local_day(e.get("message_datetime")) or since) >= since))
        result.append((claim, emails[claim["id"]], command.assess(
            claim, settings=settings, vessel=details, today=today, suggestions=found.get(claim["id"], []),
            unreviewed=unreviewed, snoozed_until=snoozes.get(claim["id"]))))
    return result, settings, details


SUGGESTION_KIND = {"TITLE": "Title", "OWNER": "Action owner", "PENDING_SINCE": "Pending since", "NEXT_ACTION": "Next required action", "STAGE": "Claim stage",
                   "CLOSURE": "Closure", "LINK": "Evidence link", "CONFLICT": "Evidence conflict"}


def _proposal_text(s):
    value = s["proposed"]
    kind = s["kind"]
    if kind == "OWNER":
        return owner_group(value["waiting_on"]) or "Not established"
    if kind == "TITLE":
        return value["title"]
    if kind == "PENDING_SINCE":
        return value["action_since"]
    if kind == "NEXT_ACTION":
        return value["next_action"]
    if kind == "STAGE":
        return LABELS.get(value["current_status"], value["current_status"])
    if kind == "CLOSURE":
        return "Close the claim (after you verify)"
    if kind == "LINK":
        return "Link this email to the claim"
    return f"{value.get('mentioned')} may be a typing error"


def _suggestion_view(s):
    view = {k: s[k] for k in ("key", "kind", "proposed", "reason", "quote", "evidence_email_id", "evidence_date",
                              "evidence_subject", "evidence_direction", "evidence_author")}
    view.update(kind_label=SUGGESTION_KIND.get(s["kind"], s["kind"]), proposal=_proposal_text(s))
    return view


def _assessment_view(a):
    data = a.to_dict()
    data["suggestions"] = len(a.suggestions)
    data["suggestion_kinds"] = sorted({s["kind"] for s in a.suggestions})
    # What the emails suggest for the empty title and owner, so a list can show them marked "suggested".
    title = next((s["proposed"]["title"] for s in a.suggestions if s["kind"] == "TITLE"), None)
    owner = next((owner_group(s["proposed"]["waiting_on"]) for s in a.suggestions if s["kind"] == "OWNER"), None)
    data["suggested"] = {"title": title, "owner": owner}
    return data


# ---- claims -------------------------------------------------------------------------------------------------------

def _claim_row(claim, email_count, assessment=None):
    row = {
        "id": claim["id"], "gc_number": claim["gc_number"], "vessel_id": claim["vessel_id"], "vessel_name": claim["vessel_name"],
        "title": claim["title"] or None, "equipment_system": claim["equipment_system"] or None,
        "status": claim["current_status"], "status_label": LABELS.get(claim["current_status"], claim["current_status"]),
        "open": claim["current_status"] not in CLOSED_STATES,
        "waiting_on": claim["waiting_on"], "owner": owner_group(claim["waiting_on"]),
        "responsible_party": claim["responsible_party_name"] or None,
        "next_follow_up_date": claim["next_follow_up_date"] or None,
        "promised_dispatch_date": claim["promised_dispatch_date"] or None,
        "expected_delivery_date": claim["expected_delivery_date"] or None,
        "service_attendance_date": claim["service_attendance_date"] or None,
        "next_action": (claim.get("next_action") or "").strip() or None, "action_since": claim.get("action_since") or None,
        "priority": claim["priority"], "updated_at": claim["updated_at"],
        "last_incoming_email": claim.get("last_incoming_email"), "last_outgoing_email": claim.get("last_outgoing_email"),
        "emails": email_count,
    }
    if assessment is not None:
        row["assessment"] = _assessment_view(assessment)
    return row


def _email_counts(repo, claim_ids):
    if not claim_ids:
        return {}
    marks = ",".join("?" * len(claim_ids))
    with connection(repo.root) as db:
        rows = db.execute(f"""SELECT c.id, COUNT(DISTINCT e.id) FROM gc_claims c
            LEFT JOIN gc_email_claim_links l ON l.claim_id = c.id
            LEFT JOIN gc_emails e ON e.claim_id = c.id OR e.id = l.email_id
            WHERE c.id IN ({marks}) GROUP BY c.id""", list(claim_ids))
        return {r[0]: r[1] for r in rows}


def _focused(a, focus, owner):
    if owner and (a.owner or "Not established") != owner:
        return False
    if focus in GROUP_FOCUS:
        return a.group == GROUP_FOCUS[focus]
    if focus == "intervention":
        return a.needs_intervention
    if focus == "office":
        return a.waiting_on == command.OFFICE
    if focus == "overdue":
        return any(r.code in command.OVERDUE_CODES for r in a.reasons)
    if focus == "closure":
        return bool(a.closure) or any(s["kind"] == "CLOSURE" for s in a.suggestions)
    if focus == "suggestions":
        return bool(a.suggestions)
    if focus == "incomplete":
        return any(r.code == "RECORD_INCOMPLETE" for r in a.reasons)
    return True


def register(repo, vessel_id=None, search="", status=None, focus=None, owner=None, sort="gc"):
    vessel = _vessel(repo, vessel_id)
    if vessel is None:
        return {"vessel": None, "claims": []}
    numbers = extract_gc_numbers(search) if search else []
    wanted = {c["id"] for c in repo.claims("" if numbers else search, status)}
    rows = [(c, a) for c, _e, a in _assessed(repo, vessel)[0]
            if c["id"] in wanted and (not numbers or c["gc_number"] in numbers) and _focused(a, focus, owner)]
    counts = _email_counts(repo, [c["id"] for c, _a in rows])
    order = (lambda pair: pair[1].rank) if sort == "priority" else (lambda pair: command.gc_sort_key(pair[0]["gc_number"]))
    claims = [_claim_row(c, counts.get(c["id"], 0), a) for c, a in sorted(rows, key=order)]
    return {"vessel": vessel, "claims": claims, "focus": focus, "owner": owner, "sort": sort}


def _follow_up_review(claim, a, suggestions):
    """Spec 28: a draft for a due or overdue external follow-up. NeraVeda prepares; the user edits and sends it
    from Outlook. It is never sent or recorded as sent."""
    if not a.due or a.due_state not in {"OVERDUE", "DUE_TODAY"} or a.waiting_on in {command.OFFICE, command.NO_OWNER}:
        return None
    subject = claim["title"] or claim["equipment_system"] or ""
    last = next((s for s in suggestions if s["kind"] in {"OWNER", "PENDING_SINCE", "NEXT_ACTION"}), None)
    since = command.day(a.pending_since)
    draft = (f"Dear Sir/Madam,\n\nWith reference to {claim['gc_number']}{' - ' + subject if subject else ''} for {claim['vessel_name']}, "
             "we have not yet received your response" + (f" to our email of {command._fmt(since)}" if since else "") + ".\n\n"
             "Please advise the current status and the expected date for the next step.\n\nThank you and best regards,")
    return {"objective": f"Get a response from {command.OWNER_NAMES.get(a.waiting_on, 'the owner')} on the pending action.",
            "last_position": last["quote"] if last else None, "draft": draft}


def claim_detail(repo, claim_id):
    try:
        claim = repo.claim(claim_id)
    except ValueError as error:
        raise ViewError("not_found", str(error)) from error
    vessel_ref = {"id": claim["vessel_id"], "name": claim["vessel_name"]}
    found = next(((c, e, a) for c, e, a in _assessed(repo, vessel_ref)[0] if c["id"] == claim_id), None)
    full, raw_emails, assessment = found if found else (claim, repo.emails(claim_id), None)
    row = _claim_row(full, 0, assessment)
    emails = [email_view(e) for e in raw_emails]
    row["emails"] = len(emails)
    row.update(defect_description=claim["defect_description"] or None, date_reported=claim["date_reported"] or None,
               date_submitted=claim["date_submitted"] or None, rectification_date=claim["rectification_date"] or None,
               closure_date=claim["closure_date"] or None, notes=claim["notes"] or None, assigned_to=claim["assigned_to"] or None,
               reopened_count=claim["reopened_count"], created_at=claim["created_at"], created_by=claim["created_by"])
    vessel = repo.vessel(claim["vessel_id"])
    suggestions = assessment.suggestions if assessment else []
    return {
        "claim": row,
        "vessel": {"id": claim["vessel_id"], "name": claim["vessel_name"],
                   "guarantee_start_date": vessel.get("guarantee_start_date") or None, "guarantee_expiry_date": vessel.get("guarantee_expiry_date") or None},
        "story": [e for e in repo.timeline(claim_id) if e["event_type"] != "EMAIL"],
        "history": repo.history(claim_id),
        "emails": emails,
        "suggestions": [_suggestion_view(s) for s in suggestions],
        "follow_up_review": _follow_up_review(full, assessment, suggestions) if assessment else None,
    }


def setup(repo, vessel_id=None):
    """The guided register set-up (Suggestion Review): each open claim with what is recorded and what the emails
    suggest, with the quoted sentence. Read-only until confirming is switched on (Phase 4)."""
    vessel = _vessel(repo, vessel_id)
    if vessel is None:
        return {"vessel": None, "claims": [], "totals": {}}
    items, totals = [], {}
    for claim, emails, a in _assessed(repo, vessel)[0]:
        if not a.open:
            continue
        for s in a.suggestions:
            totals[s["kind"]] = totals.get(s["kind"], 0) + 1
        items.append({"claim": _claim_row(claim, len(emails), a), "suggestions": [_suggestion_view(s) for s in a.suggestions]})
    items.sort(key=lambda i: command.gc_sort_key(i["claim"]["gc_number"]))
    return {"vessel": vessel, "claims": items, "totals": totals}


def search(repo, vessel_id=None, text=""):
    """Ctrl+K: claims (GC number in any form, title, equipment) and correspondence (subject, sender, kept text)."""
    vessel = _vessel(repo, vessel_id)
    text = (text or "").strip()
    if vessel is None or not text:
        return {"vessel": vessel, "claims": [], "emails": [], "email_total": 0, "equipment": []}
    claims = register(repo, vessel["id"], search=text)["claims"][:SEARCH_LIMIT]
    mail = correspondence(repo, vessel["id"], search=text)
    lowered = text.casefold()
    equipment = sorted({c["equipment_system"] for c in repo.claims() if c["vessel_id"] == vessel["id"]
                        and c["equipment_system"] and lowered in c["equipment_system"].casefold()})[:SEARCH_LIMIT]
    return {"vessel": vessel, "claims": claims, "emails": mail["emails"][:SEARCH_LIMIT], "email_total": mail["total"], "equipment": equipment}


# ---- correspondence and reviews -----------------------------------------------------------------------------------

def correspondence(repo, vessel_id=None, search="", direction=None, offset=0):
    vessel = _vessel(repo, vessel_id)
    if vessel is None:
        return {"vessel": None, "emails": [], "total": 0, "offset": 0, "page": CORRESPONDENCE_PAGE}
    where = ["(c.vessel_id = ? OR lc.vessel_id = ? OR (e.claim_id IS NULL AND e.matched_vessel_id = ?))"]
    args = [vessel["id"]] * 3
    if direction:
        where.append("e.direction = ?")
        args.append(direction)
    if search:
        numbers = extract_gc_numbers(search)
        if numbers:  # GC001, GC-001 and GC 001 find the same claim; the stored numbers are not changed
            where.append("(" + " OR ".join("e.detected_gc_numbers_json LIKE ?" for _ in numbers) + ")")
            args += [_like(f'"{n}"') for n in numbers]
        else:
            where.append("(e.subject LIKE ? ESCAPE '\\' OR e.sender_name LIKE ? ESCAPE '\\' OR e.sender_address LIKE ? ESCAPE '\\' OR e.sanitised_body LIKE ? ESCAPE '\\')")
            args += [_like(search)] * 4
    base = f"""FROM gc_emails e
        LEFT JOIN gc_claims c ON c.id = e.claim_id
        LEFT JOIN gc_email_claim_links l ON l.email_id = e.id
        LEFT JOIN gc_claims lc ON lc.id = l.claim_id
        WHERE {' AND '.join(where)}"""
    with connection(repo.root) as db:
        total = db.execute(f"SELECT COUNT(DISTINCT e.id) {base}", args).fetchone()[0]
        rows = [dict(r) for r in db.execute(
            f"""SELECT DISTINCT e.*, COALESCE(c.gc_number, lc.gc_number) claim_gc_number, COALESCE(c.id, lc.id) linked_claim_id {base}
                ORDER BY e.message_datetime DESC, e.id DESC LIMIT ? OFFSET ?""", args + [CORRESPONDENCE_PAGE, offset])]
    emails = []
    for row in rows:
        view = email_view(row)
        view["claim"] = {"id": row["linked_claim_id"], "gc_number": row["claim_gc_number"]} if row["linked_claim_id"] else None
        emails.append(view)
    return {"vessel": vessel, "emails": emails, "total": total, "offset": offset, "page": CORRESPONDENCE_PAGE}


def reviews(repo, vessel_id=None):
    """Open review items for the vessel, and those whose vessel could not be told (shown separately)."""
    vessel = _vessel(repo, vessel_id)
    if vessel is None:
        return {"vessel": None, "items": []}
    items = []
    for r in repo.reviews(True):
        if r["suggested_vessel_id"] not in (vessel["id"], None):
            continue
        try:
            numbers = json.loads(r.get("detected_gc_numbers_json") or "[]")
        except ValueError:
            numbers = []
        items.append({"id": r["id"], "type": r["review_type"], "reason": r["reason"], "created_at": r["created_at"],
                      "vessel_known": r["suggested_vessel_id"] is not None, "email_id": r["email_id"], "subject": r["subject"],
                      "direction": r["direction"], "body_preview": r["body_preview"], "gc_numbers": numbers})
    with connection(repo.root) as db:
        when = {r[0]: r[1] for r in db.execute(
            f"SELECT id, message_datetime FROM gc_emails WHERE id IN ({','.join('?' * len(items)) or 'NULL'})", [i["email_id"] for i in items])}
    for item in items:
        item["message_datetime"] = when.get(item["email_id"])
    items.sort(key=lambda i: (i["message_datetime"] or ""), reverse=True)
    return {"vessel": vessel, "items": items}


# ---- overview -----------------------------------------------------------------------------------------------------

def _sync(repo):
    settings = repo.settings()
    rows = repo.sync_status()
    run = next((r for r in rows if r["folder_name"] == "sync"), None)
    folders = [r for r in rows if r["folder_name"] != "sync"]
    return {
        "enabled": bool(settings.get("graph_enabled")), "configured": bool(settings.get("graph_configured")),
        "last_attempt_at": run["last_attempt_at"] if run else None, "last_error": run["last_error"] if run else None,
        "last_folder_read_at": max((r["last_success_at"] for r in folders if r["last_success_at"]), default=None),
        "folders": len(folders), "folders_with_errors": sum(1 for r in folders if r["last_error"]),
    }


def _review_marks(repo, user):
    """Last review times for one person (spec 20). None until that person has reviewed (recorded from Phase 4)."""
    if not user:
        return None
    with connection(repo.root) as db:
        if not _table_exists(db, "gc_review_marks"):
            return None
        row = db.execute("SELECT reviewed_at FROM gc_review_marks WHERE user_name = ? AND scope = 'dashboard' AND scope_key = ''", (user,)).fetchone()
        return row[0] if row else None


def _group_row(claim, a, today):
    """One claim as a dashboard card, in plain words. Without a confirmed record the card shows what the emails say,
    marked as such, with the exact values a one-click Confirm would save (the same guided set-up write)."""
    group, confirmed = command.display_group(a)
    by_kind = {}
    for s in a.suggestions:
        by_kind.setdefault(s["kind"], s)
    value = lambda kind, field: by_kind[kind]["proposed"][field] if kind in by_kind else None
    owner_code = a.waiting_on if a.waiting_on != command.NO_OWNER else value("OWNER", "waiting_on")
    since = a.pending_since or (None if confirmed else value("PENDING_SINCE", "action_since"))
    status = claim["current_status"] if confirmed or "STAGE" not in by_kind else value("STAGE", "current_status")
    next_step = (claim.get("next_action") or "").strip() or value("NEXT_ACTION", "next_action")
    row = {
        "claim_id": claim["id"], "gc_number": claim["gc_number"], "group": group, "confirmed": confirmed,
        "title": claim["title"] or value("TITLE", "title"), "title_suggested": not claim["title"] and "TITLE" in by_kind,
        "with": command.owner_group(owner_code) if owner_code else None, "since": since,
        "days": (today - command.day(since)).days if command.day(since) else None,
        "next_step": next_step, "next_step_suggested": not (claim.get("next_action") or "").strip() and bool(next_step),
        "stage": LABELS.get(status, status), "progress": command.STAGE_PROGRESS.get(status, 0),
        "chips": a.chips if confirmed else [], "note": a.note,
        "overdue": confirmed and (a.due_state == "OVERDUE" or any(r.code in command.OVERDUE_CODES for r in a.reasons)),
        "close_source": ("RECORD" if a.closure else "EMAIL") if group == command.READY_TO_CLOSE else None,
        "confirm": None,
    }
    if confirmed and not (claim.get("next_action") or "").strip():
        row["chips"] = row["chips"] + [{"text": "Next step not recorded", "tone": "muted"}]
    if not confirmed and owner_code and since and next_step:
        keys = [by_kind[k]["key"] for k in ("TITLE", "OWNER", "PENDING_SINCE", "NEXT_ACTION", "STAGE") if k in by_kind]
        row["confirm"] = {"fields": {"title": row["title"], "waiting_on": owner_code, "action_since": since, "next_action": next_step},
                          "status": status if status != claim["current_status"] else None, "used": keys, "rejected": [],
                          "expected_updated_at": claim["updated_at"]}
    return row


def _groups(assessed, developments):
    today = date.today()
    rows = {g: [] for g in command.GROUP_ORDER}
    for claim, _e, a in sorted(assessed, key=lambda t: t[2].rank):
        if a.open:
            row = _group_row(claim, a, today)
            rows[row["group"]].append(row)
    for group in (command.YOUR_TURN, command.WAITING):  # confirmed first; then overdue first, longest waiting first
        rows[group].sort(key=lambda r: (not r["confirmed"], not r["overdue"], -(r["days"] or 0)))
    rows[command.READY_TO_CLOSE].sort(key=lambda r: (r["close_source"] != "RECORD", not r["confirmed"]))
    waiting_by = {}
    for r in rows[command.WAITING]:
        waiting_by[r["with"]] = waiting_by.get(r["with"], 0) + 1
    by_id = {c["id"]: c for c, _e, _a in assessed}
    new = [{"claim_id": d["claim_id"], "gc_number": d["gc_number"], "title": by_id[d["claim_id"]]["title"] or None}
           for d in developments["items"] if d["category"] != "INFORMATIONAL"]
    return {
        "order": list(command.GROUP_ORDER),
        "labels": dict(command.GROUP_LABEL),
        "counts": {g: len(rows[g]) for g in command.GROUP_ORDER},
        "unconfirmed": {g: sum(1 for r in rows[g] if not r["confirmed"]) for g in command.GROUP_ORDER},
        "overdue": sum(1 for g in command.GROUP_ORDER for r in rows[g] if r["overdue"]),
        "confirmed_total": sum(1 for g in command.GROUP_ORDER for r in rows[g] if r["confirmed"]),
        "rows": rows,
        "waiting_by": [{"with": k, "count": v} for k, v in sorted(waiting_by.items(), key=lambda kv: -kv[1])],
        "whats_new": new,
    }


def _brief(claim, a):
    """One claim as the Command Centre shows it (Next Best Action and the attention rows)."""
    return {"claim_id": claim["id"], "gc_number": claim["gc_number"], "title": claim["title"] or None,
            "equipment_system": claim["equipment_system"] or None, "status_label": LABELS.get(claim["current_status"], claim["current_status"]),
            "assessment": _assessment_view(a)}


def overview(repo, vessel_id=None, user=None):
    context = scope(repo)
    vessel = _vessel(repo, vessel_id)
    result = {"today": date.today().isoformat(), "scope": context, "vessel": vessel, "sync": _sync(repo)}
    if vessel is None:
        return result
    today = date.today()
    assessed, settings, details = _assessed(repo, vessel, today)
    assessments = [a for _c, _e, a in assessed]
    by_id = {c["id"]: c for c, _e, _a in assessed}
    counts = _email_counts(repo, list(by_id))
    claims = [_claim_row(c, counts.get(c["id"], 0)) for c, _e, _a in assessed]
    open_claims = [c for c in claims if c["open"]]
    statuses = {}
    for c in claims:
        statuses.setdefault(c["status"], {"status": c["status"], "label": c["status_label"], "count": 0})["count"] += 1
    recorded = lambda *keys: sum(1 for c in open_claims if any(not _blank(c[k]) for k in keys))
    review_items = reviews(repo, vessel["id"])["items"]
    review_types = {}
    for item in review_items:
        review_types[item["type"]] = review_types.get(item["type"], 0) + 1
    latest = max((c["last_incoming_email"] or "" for c in claims), default="") or None
    ownership = command.ownership_summary(assessments)

    queue = command.ranked(assessments)
    best = command.next_best(assessments)
    others = [a for a in queue if a is not best]
    reviewed_at = _review_marks(repo, user)
    since = command.local_day(reviewed_at) if reviewed_at else today - timedelta(days=int(settings.get("developments_days", 14)))
    with connection(repo.root) as db:
        ids = list(by_id)
        history = [dict(r) for r in db.execute(
            f"SELECT * FROM gc_status_history WHERE claim_id IN ({','.join('?' * len(ids)) or 'NULL'}) ORDER BY changed_at, id", ids)]
    developments = command.developments(history, assessments, since)

    result.update(
        claims={"total": len(claims), "open": len(open_claims), "closed": sum(1 for c in claims if c["status"] == "CLOSED"),
                "cancelled": sum(1 for c in claims if c["status"] == "CANCELLED"), "by_status": sorted(statuses.values(), key=lambda s: -s["count"])},
        ownership={"groups": ownership["groups"], "not_established": ownership["not_established"]},
        recorded={"open": len(open_claims), "owner": len(open_claims) - ownership["not_established"], "title": recorded("title"),
                  "equipment": recorded("equipment_system"), "follow_up_date": recorded("next_follow_up_date"),
                  "commitment_date": recorded("promised_dispatch_date", "expected_delivery_date", "service_attendance_date"),
                  "next_action": recorded("next_action"), "action_since": recorded("action_since")},
        guarantee={"start_date": details.get("guarantee_start_date") or None, "expiry_date": details.get("guarantee_expiry_date") or None},
        correspondence={"linked_emails": sum(c["emails"] for c in claims), "latest_incoming": latest},
        reviews={"open": len(review_items), "vessel_unknown": sum(1 for i in review_items if not i["vessel_known"]),
                 "by_type": [{"type": k, "count": v} for k, v in sorted(review_types.items(), key=lambda kv: -kv[1])]},
        headline=command.headline(assessments),
        next_best=_brief(by_id[best.claim_id], best) if best else None,
        attention={"items": [_brief(by_id[a.claim_id], a) for a in others[:3]], "total": len(others)},
        developments={"since": developments["since"], "since_review": reviewed_at is not None, "counts": developments["counts"], "points": developments["points"],
                      "items": developments["items"][:6]},
        closure=command.closure_control(assessments),
        groups=_groups(assessed, developments),
        review_state={"last_dashboard_review_at": reviewed_at, "user_known": bool(user)},
        settings={"standard_followup_days": settings.get("standard_followup_days"), "verification_days": settings.get("verification_days"),
                  "developments_days": settings.get("developments_days")},
    )
    return result
