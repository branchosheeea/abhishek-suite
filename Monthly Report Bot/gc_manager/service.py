"""Guarantee Claim Manager helper for the NeraVeda web shell (reads since Phase 1; controlled changes since Phase 4).

The web shell's Node.js server starts this module as its own child process and talks to it over stdin/stdout,
one JSON object per line. There is no network port: only the parent that holds the pipes can reach it, and the
parent checks the NeraVeda session and the "gc" right before it sends anything (app/api/gc/*).

    request  {"id": <int|str>, "cmd": "<command>", "args": {...}}
    reply    {"id": ..., "ok": true, "result": ...}
             {"id": ..., "ok": false, "error": {"kind": "<kind>", "message": "<safe text>"}}
    event    {"event": "ready", "version": 1}  once, when the helper can answer

Error kinds: bad_request (unknown command, wrong or extra arguments, malformed line), validation (the claim rules
refused), not_found, conflict (the claim changed after the person loaded it), unavailable (the GC database could
not be opened), internal (details go to stderr only).

Outlook sync (Phase 5): when started by the NeraVeda web server with GC_AUTO_SYNC=1, the helper also syncs Outlook
in the background (gc_manager/sync.py SyncRunner), one sync at a time with the desktop window. sync.state, sync.run
and sync.sign_in let the page show the true state, start a sync, and show a Microsoft sign-in code.

Changes (Phase 4) all name the signed-in person ("actor", from the web server's session check) and, for a claim,
the claim's updated_at as the person saw it ("expected_updated_at"), so nobody silently overwrites a newer change.

Rules kept here:
- Only the commands in COMMANDS exist, each with a fixed argument list. Nothing from the request becomes SQL,
  a module name or a file path.
- The claim logic stays in Repository; this file only translates. Email bodies and raw message metadata are never
  sent (emails are returned without them), and nothing from a request or a reply is written to the log.
- The helper exits when stdin closes, so it cannot outlive the server that started it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from .repository import ConflictError

from . import views, web_actions
from .views import EMAIL_FIELDS  # noqa: F401  (the email columns the web may see)

PROTOCOL_VERSION = 1
MAX_LINE = 64 * 1024  # requests are small; anything larger is refused unread
MAX_TEXT = 200
MAX_OFFSET = 1_000_000
DIRECTIONS = ("INCOMING", "OUTGOING", "UNKNOWN")


class RequestError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


# ---- argument checking -------------------------------------------------------------------------------------------

def _int_id(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 2**53:
        raise RequestError("bad_request", f"{name} must be a positive whole number.")
    return value


def _text(value, name):
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise RequestError("bad_request", f"{name} must be text of at most {MAX_TEXT} characters.")
    return value.strip()


def _flag(value, name):
    if not isinstance(value, bool):
        raise RequestError("bad_request", f"{name} must be true or false.")
    return value


def _optional_id(value, name):
    return None if value is None else _int_id(value, name)


def _offset(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_OFFSET:
        raise RequestError("bad_request", f"{name} must be a whole number from 0 to {MAX_OFFSET}.")
    return value


def _direction(value, name):
    if value is None:
        return None
    if value not in DIRECTIONS:
        raise RequestError("bad_request", f"{name} must be one of {', '.join(DIRECTIONS)}.")
    return value


def _status(value, name):
    from .rules import STATUS
    if value is None or value == "All":
        return None
    if value not in STATUS:
        raise RequestError("bad_request", f"{name} is not a known claim status.")
    return value


def _choice(options):
    """A checker that accepts only one of a fixed list of words (or nothing)."""
    def check(value, name):
        if value is None:
            return None
        if value not in options:
            raise RequestError("bad_request", f"{name} must be one of {', '.join(options)}.")
        return value
    return check


def _owner(value, name):
    from .command import OWNER_ORDER
    return _choice((*OWNER_ORDER, "Not established"))(value, name)


MAX_LONG_TEXT = 2000
STAMP_LENGTH = 64


def _long_text(value, name):
    if not isinstance(value, str) or len(value) > MAX_LONG_TEXT:
        raise RequestError("bad_request", f"{name} must be text of at most {MAX_LONG_TEXT} characters.")
    return value


def _required_text(value, name):
    value = _text(value, name)
    if not value:
        raise RequestError("bad_request", f"{name} is required.")
    return value


def _stamp(value, name):
    if not isinstance(value, str) or not 0 < len(value) <= STAMP_LENGTH:
        raise RequestError("bad_request", f"{name} must be the claim's last-updated time as loaded.")
    return value


def _fields(value, name):
    """Claim fields a person may edit (Repository.EDITABLE): text values or null, nothing else."""
    from .repository import Repository
    if not isinstance(value, dict) or not value:
        raise RequestError("bad_request", f"{name} must be an object with at least one field.")
    unknown = sorted(set(value) - set(Repository.EDITABLE))
    if unknown:
        raise RequestError("bad_request", f"{name}: {unknown[0][:40]} cannot be edited.")
    for key, item in value.items():
        if item is not None and (not isinstance(item, str) or len(item) > MAX_LONG_TEXT):
            raise RequestError("bad_request", f"{key} must be text of at most {MAX_LONG_TEXT} characters.")
    return value


def _keys(value, name):
    if not isinstance(value, list) or len(value) > 50 or any(not isinstance(k, str) or not 0 < len(k) <= 400 for k in value):
        raise RequestError("bad_request", f"{name} must be a list of suggestion keys.")
    return value


def _optional_status(value, name):
    return None if value is None else _status(value, name)


def _write(function):
    """A change: done as the signed-in person passed by the web server; refusals keep their message."""
    def run(repo, actor, **args):
        from .repository import ConflictError
        repo.acting_as = actor
        try:
            return function(repo, **args)
        except ConflictError as error:
            raise RequestError("conflict", str(error)) from error
        except views.ViewError as error:
            raise RequestError(error.kind, str(error)) from error
        finally:
            repo.acting_as = None
    return run


def _detail(repo, claim_id):
    return views.claim_detail(repo, claim_id)


def _update(repo, claim_id, fields, reason, expected_updated_at):
    _claim_or_404(repo, claim_id)
    repo.update_claim(claim_id, expected_updated_at=expected_updated_at, reason=reason, **fields)
    return _detail(repo, claim_id)


def _set_status(repo, claim_id, status, reason, override, expected_updated_at):
    _claim_or_404(repo, claim_id)
    repo.set_status(claim_id, status, reason=reason, override=override, expected_updated_at=expected_updated_at)
    return _detail(repo, claim_id)


def _close(repo, claim_id, closure_date, reason, expected_updated_at):
    _claim_or_404(repo, claim_id)
    repo.close_claim(claim_id, closure_date, reason, expected_updated_at=expected_updated_at)
    return _detail(repo, claim_id)


def _reopen(repo, claim_id, status, reason, expected_updated_at):
    _claim_or_404(repo, claim_id)
    repo.reopen_claim(claim_id, status, reason, expected_updated_at=expected_updated_at)
    return _detail(repo, claim_id)


def _snooze(repo, claim_id, until, reason):
    _claim_or_404(repo, claim_id)
    repo.snooze(claim_id, until, reason)
    return _detail(repo, claim_id)


def _unsnooze(repo, claim_id):
    _claim_or_404(repo, claim_id)
    repo.clear_snooze(claim_id)
    return _detail(repo, claim_id)


def _review_resolve(repo, review_id, action, vessel_id, claim_id, register, link_matching, notes):
    open_ids = {r["id"] for r in repo.reviews(True)}
    if review_id not in open_ids:
        raise RequestError("conflict", "This email was already resolved (perhaps in the desktop window). Reload the Review Queue.")
    linked = repo.resolve_review(review_id, action, notes=notes, vessel_id=vessel_id, claim_id=claim_id, register=register, link_matching=link_matching)
    return {"resolved": True, "linked_emails": linked if isinstance(linked, int) and not isinstance(linked, bool) else (1 if action == "link" else 0)}


def _review_multiple(repo, review_id, claim_ids, notes):
    if review_id not in {r["id"] for r in repo.reviews(True)}:
        raise RequestError("conflict", "This email was already resolved. Reload the Review Queue.")
    repo.resolve_multiple_gc_review(review_id, claim_ids, notes)
    return {"resolved": True, "linked_emails": len(claim_ids)}


def _id_list(value, name):
    if not isinstance(value, list) or not 0 < len(value) <= 20:
        raise RequestError("bad_request", f"{name} must be a list of claim ids.")
    return [_int_id(v, name) for v in value]


def _mark_reviewed(repo):
    repo.mark_dashboard_reviewed(repo.actor)
    return {"reviewed": True}


_runner = None


def _sync_runner(repo, automatic=False):
    """The helper's one SyncRunner. Its thread uses its own Repository, never the request one."""
    global _runner
    if _runner is not None and _runner.root != repo.root:  # another data folder (tests): start afresh
        _runner.stop()
        _runner = None
    if _runner is None:
        from .repository import Repository
        from .sync import SyncRunner
        own = Repository(repo.root)
        _runner = SyncRunner(lambda: own, automatic=automatic)
        _runner.root = repo.root
        _runner.start()
    return _runner


def _sync_state(repo):
    return _sync_runner(repo).state()


def _sync_run(repo, actor):
    return {**_sync_runner(repo).trigger(), "state": _sync_runner(repo).state()}


def _sync_sign_in(repo, actor):
    try:
        _sync_runner(repo).start_sign_in()
    except RuntimeError as error:  # Microsoft could not start a sign-in (network, app settings): say so plainly
        raise RequestError("unavailable", f"Microsoft sign-in could not start: {str(error)[:300]}") from error
    return _sync_runner(repo).state()


def _args(given, spec):
    """spec: {name: (checker, default)}; a default of ... means required."""
    if not isinstance(given, dict):
        raise RequestError("bad_request", "args must be an object.")
    extra = sorted(set(given) - set(spec))
    if extra:
        raise RequestError("bad_request", f"Unknown argument: {extra[0]}.")
    values = {}
    for name, (check, default) in spec.items():
        if name not in given:
            if default is ...:
                raise RequestError("bad_request", f"{name} is required.")
            values[name] = default
        else:
            values[name] = check(given[name], name)
    return values


# ---- commands (read-only) ----------------------------------------------------------------------------------------

def _claim_or_404(repo, claim_id):
    try:
        return repo.claim(claim_id)
    except ValueError as error:
        raise RequestError("not_found", str(error)) from error


def _view(function):
    """Run a views function; its ViewError becomes the matching reply kind."""
    def run(repo, **args):
        try:
            return function(repo, **args)
        except views.ViewError as error:
            raise RequestError(error.kind, str(error)) from error
    return run


def _vocabulary(_repo):
    from .rules import LABELS, STATUS, TRANSITIONS, WAITING_ON
    return {"statuses": list(STATUS), "labels": dict(LABELS), "waiting_on": list(WAITING_ON), "owner_labels": dict(OWNER_LABELS),
            "transitions": {status: sorted(TRANSITIONS[status]) for status in STATUS}}


# Names for the stored waiting_on values in the edit forms (the grouping on the dashboards is command.OWNER_GROUPS).
OWNER_LABELS = {"SUPERINTENDENT": "Office (superintendent)", "VENDOR_MAKER": "Maker / vendor", "SUPPLIER": "Supplier",
                "SERVICE_COMPANY": "Service company", "SHIPYARD": "Shipyard", "VESSEL": "Vessel", "CLASS": "Class",
                "MULTIPLE_PARTIES": "Multiple parties", "NONE": "Not established"}


def _ping(repo):
    from .repository import SCHEMA_VERSION
    return {"service": "gc", "protocol": PROTOCOL_VERSION, "schema": SCHEMA_VERSION, "read_only": False}


COMMANDS = {
    # name: (argument spec, handler(repo, **args))
    "ping": ({}, _ping),
    "vocabulary": ({}, _vocabulary),
    "vessels.list": ({"active_only": (_flag, True)}, lambda repo, active_only: repo.vessels(active_only)),
    "claims.list": ({"search": (_text, ""), "status": (_status, None)}, lambda repo, search, status: repo.claims(search, status)),
    "claim.get": ({"claim_id": (_int_id, ...)}, lambda repo, claim_id: _claim_or_404(repo, claim_id)),
    "claim.emails": ({"claim_id": (_int_id, ...)},
                     lambda repo, claim_id: (_claim_or_404(repo, claim_id), [views.email_view(e) for e in repo.emails(claim_id)])[1]),
    # Web views: scoped to one tracked vessel (default: the first one with claims). Phase 3 adds the shared rules.
    "web.overview": ({"vessel_id": (_optional_id, None), "user": (_text, "")},
                     _view(lambda repo, vessel_id, user: views.overview(repo, vessel_id, user or None))),
    "web.register": ({"vessel_id": (_optional_id, None), "search": (_text, ""), "status": (_status, None),
                      "focus": (_choice(views.FOCUS), None), "owner": (_owner, None), "sort": (_choice(views.SORTS), "gc")},
                     _view(views.register)),
    "web.setup": ({"vessel_id": (_optional_id, None)}, _view(views.setup)),
    "web.search": ({"vessel_id": (_optional_id, None), "text": (_text, "")}, _view(views.search)),
    # Controlled changes (Phase 4). Each names the person; claim changes carry the updated_at the person saw.
    "claim.update": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "fields": (_fields, ...), "reason": (_text, ""),
                      "expected_updated_at": (_stamp, ...)}, _write(_update)),
    "claim.setup": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "fields": (_fields, ...), "status": (_optional_status, None),
                     "used": (_keys, []), "rejected": (_keys, []), "expected_updated_at": (_stamp, ...)},
                    _write(web_actions.setup)),
    "claim.status": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "status": (_status, ...), "reason": (_long_text, ""),
                      "override": (_flag, False), "expected_updated_at": (_stamp, ...)}, _write(_set_status)),
    "claim.close": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "closure_date": (_required_text, ...),
                     "reason": (_long_text, ...), "expected_updated_at": (_stamp, ...)}, _write(_close)),
    "claim.reopen": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "status": (_status, ...), "reason": (_long_text, ...),
                      "expected_updated_at": (_stamp, ...)}, _write(_reopen)),
    "claim.snooze": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "until": (_required_text, ...), "reason": (_long_text, ...)},
                     _write(_snooze)),
    "claim.unsnooze": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...)}, _write(_unsnooze)),
    "suggestion.decide": ({"actor": (_required_text, ...), "claim_id": (_int_id, ...), "key": (_required_text, ...),
                           "decision": (_choice(("ACCEPTED", "REJECTED")), ...), "reason": (_long_text, "")},
                          _write(web_actions.decide)),
    "review.mark": ({"actor": (_required_text, ...)}, _write(_mark_reviewed)),
    # Review Queue (unmatched emails), with the desktop's own resolution rules and audit.
    "review.resolve": ({"actor": (_required_text, ...), "review_id": (_int_id, ...), "action": (_choice(("link", "irrelevant")), ...),
                        "vessel_id": (_optional_id, None), "claim_id": (_optional_id, None), "register": (_flag, False),
                        "link_matching": (_flag, False), "notes": (_long_text, "")}, _write(_review_resolve)),
    "review.resolve_multiple": ({"actor": (_required_text, ...), "review_id": (_int_id, ...), "claim_ids": (_id_list, ...),
                                 "notes": (_long_text, ...)}, _write(_review_multiple)),
    # Outlook sync (Phase 5): the true state, "Sync now", and a Microsoft device sign-in shown on the page.
    "sync.state": ({}, _sync_state),
    "sync.run": ({"actor": (_required_text, ...)}, _sync_run),
    "sync.sign_in": ({"actor": (_required_text, ...)}, _sync_sign_in),
    "web.claim": ({"claim_id": (_int_id, ...)}, _view(views.claim_detail)),
    "web.correspondence": ({"vessel_id": (_optional_id, None), "search": (_text, ""), "direction": (_direction, None), "offset": (_offset, 0)},
                           _view(views.correspondence)),
    "web.reviews": ({"vessel_id": (_optional_id, None)}, _view(views.reviews)),
    "claim.timeline": ({"claim_id": (_int_id, ...)}, lambda repo, claim_id: (_claim_or_404(repo, claim_id), repo.timeline(claim_id))[1]),
    "claim.history": ({"claim_id": (_int_id, ...)}, lambda repo, claim_id: (_claim_or_404(repo, claim_id), repo.history(claim_id))[1]),
    "reviews.list": ({"open_only": (_flag, True)}, lambda repo, open_only: repo.reviews(open_only)),
    "sync.status": ({}, lambda repo: repo.sync_status()),
    "emails.summary": ({}, lambda repo: repo.email_summary()),
    "settings.get": ({}, lambda repo: repo.settings()),
}


def handle(repo, message, init_error=None):
    """One request object → one reply object. Never raises."""
    request_id = message.get("id") if isinstance(message, dict) else None
    if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
        request_id = None
    try:
        if not isinstance(message, dict) or request_id is None:
            raise RequestError("bad_request", "A request needs an id (number or text).")
        command = message.get("cmd")
        if command not in COMMANDS:
            raise RequestError("bad_request", "Unknown command.")
        if repo is None:
            raise RequestError("unavailable", init_error or "The Guarantee Claim database could not be opened.")
        spec, handler = COMMANDS[command]
        return {"id": request_id, "ok": True, "result": handler(repo, **_args(message.get("args", {}), spec))}
    except RequestError as error:
        return {"id": request_id, "ok": False, "error": {"kind": error.kind, "message": str(error)}}
    except ConflictError as error:
        return {"id": request_id, "ok": False, "error": {"kind": "conflict", "message": str(error)}}
    except ValueError as error:  # the claim rules' own refusals carry messages meant for the user
        return {"id": request_id, "ok": False, "error": {"kind": "validation", "message": str(error)}}
    except Exception:
        print(f"[gc-helper] {message.get('cmd') if isinstance(message, dict) else '?'} failed:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {"id": request_id, "ok": False, "error": {"kind": "internal", "message": "Internal error. Details are in the server log."}}


def _protocol_streams():
    """The reply stream is a private copy of the original stdout; afterwards anything printed (by this code or a
    library, from Python or C) goes to stderr, so it can never corrupt the message stream."""
    replies = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    requests = open(sys.stdin.fileno(), "rb", buffering=0, closefd=False)
    return requests, replies


def _read_lines(stream):
    """Yield complete request lines (bytes); an oversized line is replaced by None after skipping it."""
    pending = b""
    oversized = False
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            yield None if oversized or len(line) > MAX_LINE else line
            oversized = False
        if len(pending) > MAX_LINE:
            pending, oversized = b"", True


def serve(data_root=None):
    requests, replies = _protocol_streams()

    def send(obj):
        replies.write(json.dumps(obj, ensure_ascii=True, default=str) + "\n")
        replies.flush()

    repo, init_error = None, None
    try:
        from .repository import Repository
        repo = Repository(data_root)
    except Exception as error:
        init_error = str(error) if isinstance(error, RuntimeError) else None
        print("[gc-helper] could not open the GC database:", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
    send({"event": "ready", "version": PROTOCOL_VERSION, "available": repo is not None})
    if repo is not None and os.environ.get("GC_AUTO_SYNC") == "1":
        try:
            _sync_runner(repo, automatic=True)  # background Outlook sync while this web server runs
        except Exception:
            print("[gc-helper] background Outlook sync could not start:", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
    for line in _read_lines(requests):
        if line is None:
            send({"id": None, "ok": False, "error": {"kind": "bad_request", "message": "Request is too large."}})
            continue
        if not line.strip():
            continue
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            send({"id": None, "ok": False, "error": {"kind": "bad_request", "message": "Request is not valid JSON."}})
            continue
        send(handle(repo, message, init_error))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Guarantee Claim Manager helper for the NeraVeda web shell (stdin/stdout JSON lines)")
    parser.add_argument("--data-root", type=Path, help="Override the Suite data directory (tests)")
    args = parser.parse_args(argv)
    return serve(args.data_root)


if __name__ == "__main__":
    sys.exit(main())
