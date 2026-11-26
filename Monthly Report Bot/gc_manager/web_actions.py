"""Controlled changes from the NeraVeda web Command Centre (Phase 4).

Every change goes through Repository, the same authority the desktop GC Manager uses, so each one leaves the same
status history, Claim Story event and audit row. This file adds what only the web needs:

- Suggestions are looked up again here by their key (from the current emails), so the browser cannot invent a
  suggestion, a quote or an evidence email. Whether a person ACCEPTED a suggestion as proposed or CHANGED it is
  decided here by comparing the confirmed value with the proposal.
- The person acting is the signed-in NeraVeda user the web server passes with each request.
"""
from __future__ import annotations

from . import views
from .repository import ConflictError, _check_fresh

FIELD_OF = {"TITLE": "title", "OWNER": "waiting_on", "PENDING_SINCE": "action_since", "NEXT_ACTION": "next_action", "STAGE": "current_status"}
SETUP_FIELDS = ("title", "equipment_system", "waiting_on", "action_since", "next_action", "responsible_party_name", "next_follow_up_date")


def current_suggestions(repo, claim_id):
    """key -> suggestion for this claim, from its emails as they are now."""
    try:
        claim = repo.claim(claim_id)
    except ValueError as error:
        raise views.ViewError("not_found", str(error)) from error
    vessel = {"id": claim["vessel_id"], "name": claim["vessel_name"]}
    found = next((a for c, _e, a in views._assessed(repo, vessel)[0] if c["id"] == claim_id), None)
    return {s["key"]: s for s in (found.suggestions if found else [])}


def _decision(suggestion, status):
    return {k: suggestion[k] for k in ("key", "kind", "proposed", "evidence_email_id", "quote")} | {"status": status}


def _resolve(repo, claim_id, keys):
    known = current_suggestions(repo, claim_id)
    missing = [k for k in keys if k not in known]
    if missing:
        raise views.ViewError("validation", "A suggestion is no longer current (new emails or an earlier decision). Reload the claim.")
    return [known[k] for k in keys]


def setup(repo, claim_id, fields, status, used, rejected, expected_updated_at):
    """Guided set-up: confirm the record in one step. `used` are the suggestions the form was filled from."""
    try:
        _check_fresh(repo.claim(claim_id), expected_updated_at)  # a stale form is a conflict, before anything else
    except ConflictError:
        raise
    except ValueError as error:
        raise views.ViewError("not_found", str(error)) from error
    values = {k: fields[k] for k in SETUP_FIELDS if k in fields}
    decisions = []
    for s in _resolve(repo, claim_id, used):
        field = FIELD_OF.get(s["kind"])
        if field is None:
            raise views.ViewError("validation", f"A {s['kind'].lower()} suggestion is confirmed with its own button.")
        confirmed = status if field == "current_status" else values.get(field)
        proposed = next(iter(s["proposed"].values()))
        decisions.append(_decision(s, "ACCEPTED" if confirmed == proposed else "CHANGED"))
    decisions += [_decision(s, "REJECTED") for s in _resolve(repo, claim_id, rejected)]
    repo.confirm_setup(claim_id, values, status=status, decisions=decisions, expected_updated_at=expected_updated_at)
    return views.claim_detail(repo, claim_id)


def decide(repo, claim_id, key, decision, reason):
    """One suggestion on its own: dismiss any kind; accept an evidence link (links the email) or a conflict (noted)."""
    [s] = _resolve(repo, claim_id, [key])
    if decision == "ACCEPTED":
        if s["kind"] == "LINK":
            repo.link_email(s["proposed"]["email_id"], claim_id, reason or "Linked from an email suggestion: " + s["reason"])
        elif s["kind"] != "CONFLICT":
            raise views.ViewError("validation", "Confirm this suggestion in the record form (guided set-up or Edit record).")
    repo.record_suggestions(claim_id, [_decision(s, decision)])
    return views.claim_detail(repo, claim_id)
