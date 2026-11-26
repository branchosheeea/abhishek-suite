"""Latest saved intelligence for the NeraVeda home page.

The home page summarises results each workspace has already fetched, processed and saved. It never contacts
MariApps, Outlook or vessels, never re-parses source files, and never writes to a workspace's data:
the shared database is opened read-only. Exceptions come from each workspace's own rules:

- Lub Oil Review: lube_oil.analytics.decision_brief on each vessel's latest sheet in use.
- Guarantee Claims: gc_manager.command.assess (the same claim rules as the web Command Centre) on the saved register.
- Critical Jobs: saved extraction runs (cjc_runs). Compliance assessments are not saved yet.
- Inspection Reports: a summary fetched from the web app's /api/inspections/summary and cached on disk.
- Emissions Validation: a summary fetched from its web app's /api/summary (latest completed run per session)
  and cached on disk. DNV items are counted as entered; nothing is presented as confirmed by Home.
- Digital Docking: a summary fetched from /api/docking/summary on the web shell's server and cached on disk; each
  docking's daily reports so far and the days whose report is missing.
- Vessel Report Centre: the last collection run, saved by the workspace when the run finishes.
- Inspection Reports also passes on what the browser last said about reports not in the cloud yet.
- Voyage Summary saves no results the home page can read.

Missing data is never reported as zero or "all clear". Each workspace is loaded independently, so one failure
leaves the others unaffected.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from suite_services.storage import runtime_root

ORDER = ("vessel", "oil", "voyage", "gc", "cjc", "sir", "evi", "dd")
NAMES = {
    "vessel": "Vessel Report Centre", "oil": "Lub Oil Review", "voyage": "Voyage Summary",
    "gc": "Guarantee Claims", "cjc": "Critical Jobs", "sir": "Superintendent Inspection",
    "evi": "Emissions Validation", "dd": "Digital Docking",
}
ACTION, REVIEW = "action", "review"
SEVERITY_LABEL = {ACTION: "Action required", REVIEW: "Review required"}



@dataclass
class Attention:
    severity: str
    vessel: str
    issue: str
    reason: str
    workspace: str
    period: str
    processed: str
    rank: tuple = ()
    target: str | None = None  # optional deep link inside the workspace (Inspection Reports only)


@dataclass
class Intel:
    """What the home page knows about one workspace.

    state: ok, partial, none (nothing processed yet), not_connected (no saved result Home can read),
    failed (latest processing failed) or error (saved results could not be read).
    headline/context/freshness are the three lines of the workspace card on the home page, and the attention
    items give its count. outcome/updated are a one-line summary kept for other uses; the home page does not show them.
    """
    key: str
    state: str
    headline: str
    context: str = ""
    freshness: str = ""
    outcome: str = ""
    updated: str = ""
    attention: list[Attention] = field(default_factory=list)


# ── Formatting ────────────────────────────────────────────────────────────────

def parse_time(value):
    """ISO text or epoch milliseconds -> local naive datetime (None if unknown)."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000)
        moment = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        return moment.astimezone().replace(tzinfo=None) if moment.tzinfo else moment
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def fmt_day(value, today=None):
    moment = value if isinstance(value, (date, datetime)) else parse_time(value)
    if moment is None:
        return ""
    today = today or date.today()
    return f"{moment.day} {moment:%b}" + ("" if moment.year == today.year else f" {moment.year}")


def fmt_time(value, today=None):
    moment = value if isinstance(value, datetime) else parse_time(value)
    return f"{fmt_day(moment, today)}, {moment:%H:%M}" if moment else ""


def fmt_month(month, short=False):
    try:
        return datetime.strptime(str(month)[:7] + "-01", "%Y-%m-%d").strftime("%b %Y" if short else "%B %Y")
    except ValueError:
        return str(month)


def fmt_iso_day(value, today=None):
    try:
        return fmt_day(date.fromisoformat(str(value)[:10]), today)
    except ValueError:
        return ""


def _clip(text, limit=150):
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _plural(count, word, plural=None):
    return f"{count} {word if count == 1 else (plural or word + 's')}"


# ── Database access (read-only) ───────────────────────────────────────────────

def _open(root):
    database = Path(root) / "suite.sqlite3"
    if not database.is_file():
        return None
    db = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    return db


def _has(db, table):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


# ── Workspaces ────────────────────────────────────────────────────────────────

def _write_cache(path, summary):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
        json.dump(summary, handle)
        temporary = handle.name
    os.replace(temporary, path)


# ── Vessel Report Centre (last run, saved by the workspace) ───────────────────

def vessel_report_cache_path(root=None):
    return Path(root or runtime_root()) / "home" / "vessel_report_summary.json"


def vessel_report_intel(root=None, today=None):
    """The last collection run, as vessel_report/run_summary.py saved it when the run finished (audit P1-7)."""
    path = vessel_report_cache_path(root)
    if not path.is_file():
        return Intel("vessel", "not_connected", "No collection run saved yet",
                     "The next collection run will be shown here when it finishes",
                     outcome="No collection run saved yet")
    run = json.loads(path.read_text(encoding="utf-8"))
    finished = run.get("finishedAt")
    period = run.get("period") or {}
    period_text = f"{fmt_iso_day(period.get('from'), today)} to {fmt_iso_day(period.get('to'), today)}" if period.get("from") else ""
    vessels = run.get("vessels") or []
    problems = run.get("attention") or []
    items = [Attention(REVIEW, p.get("vessel") or "Vessel not recorded", f"{p.get('report') or 'Report'} needs attention",
                       _clip(p.get("error") or "The report could not be collected; see the run's results."), "vessel",
                       period_text, f"Run {fmt_day(finished, today)}", rank=(0, i))
             for i, p in enumerate(problems)]
    if run.get("fatal"):
        headline, state = "Last run stopped with an error", "failed"
    else:
        headline, state = f"Last run: {_plural(run.get('files', 0), 'file')} collected", "ok"
    context = " · ".join(x for x in (_plural(len(vessels), "vessel"), period_text, run.get("frequency") or "") if x)
    freshness = f"Run finished {fmt_time(finished, today)}" + (" · stopped before all reports" if run.get("stopped") else "")
    return Intel("vessel", state, headline, context, freshness,
                 outcome=f"{run.get('completed', 0)} of {run.get('jobs', 0)} reports processed · {_plural(len(problems), 'report')} need attention",
                 updated=f"Saved to {run.get('output', '')}", attention=items)


# ── Digital Docking (web app summary, cached) ─────────────────────────────────

def docking_cache_path(root=None):
    return Path(root or runtime_root()) / "home" / "docking_summary.json"


def fetch_docking_summary(port, root=None, timeout=15, headers=None):
    """Read the Digital Docking summary from the web shell's server (it also serves Inspection Reports) while it is
    running, and cache it with the fetch time."""
    request = urllib.request.Request(f"http://localhost:{port}/api/docking/summary", headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        summary = json.loads(response.read().decode("utf-8"))
    if not isinstance(summary.get("dockings"), list):
        raise ValueError("Unexpected docking summary format.")
    summary["fetchedAt"] = datetime.now().isoformat(timespec="seconds")
    _write_cache(docking_cache_path(root), summary)
    return summary


def docking_intel(root=None, today=None):
    """Each docking's daily reports so far, and the days whose report is missing (audit P1-7)."""
    path = docking_cache_path(root)
    if not path.is_file():
        return Intel("dd", "not_connected", "Summary not loaded yet", "Loads while Digital Docking is open",
                     outcome="Open the workspace to load its summary")
    summary = json.loads(path.read_text(encoding="utf-8"))
    fetched = summary.get("fetchedAt")
    freshness = f"Summary fetched {fmt_time(fetched, today)}"
    dockings = summary.get("dockings") or []
    if not dockings:
        return Intel("dd", "none", "No docking recorded", "Create a docking to follow its daily reports", freshness,
                     outcome="No docking")
    items = []
    for d in dockings:
        missing = d.get("missingDays") or []
        if d.get("status") == "active" and missing:
            shown = ", ".join(str(n) for n in missing[:6]) + ("…" if len(missing) > 6 else "")
            items.append(Attention(
                REVIEW, d.get("vessel") or "Vessel not recorded", f"{_plural(len(missing), 'daily report')} not received",
                f"Day {shown} of {d.get('code')}: no file and no 'no report' reason recorded.", "dd",
                f"Day 0 {fmt_iso_day(d.get('day0'), today)}", f"Summary fetched {fmt_day(fetched, today)}",
                rank=(0, -len(missing)), target=f"docking/{d.get('id')}"))
    current = [d for d in dockings if d.get("status") == "active"] or [d for d in dockings if d.get("status") == "planned"] or dockings
    latest = max(current, key=lambda d: d.get("day0") or "")
    so_far = latest.get("daysSoFar") or 0
    status = {"active": "In dock", "planned": "Planned", "completed": "Completed"}.get(latest.get("status"), latest.get("status") or "")
    context = (f"{latest.get('code')} · {status} · {latest.get('received', 0)} of {_plural(so_far, 'day')} received, "
               f"{latest.get('reviewed', 0)} reviewed")
    return Intel("dd", "ok", f"Latest: {latest.get('vessel')}", context, freshness,
                 outcome=f"{_plural(latest.get('jobs', 0), 'job')} · latest report {fmt_iso_day(latest.get('latestReportDate'), today) or 'none yet'}",
                 updated=f"Summary fetched {fmt_day(fetched, today)}", attention=items)


def voyage_intel(root=None, today=None):
    return Intel("voyage", "not_connected", "Not connected to Home",
                 "Reads the noon report each time it opens; nothing is saved",
                 outcome="No saved voyage summary yet")


def lube_intel(root, today=None):
    from lube_oil.analytics import decision_brief  # the module's own priority rules

    db = _open(root)
    if db is None or not _has(db, "monthly_reports"):
        return Intel("oil", "none", "Not yet processed", "No Lub Oil sheets have been imported",
                     outcome="No sheets imported yet")
    try:
        rows = db.execute(
            """SELECT r.id, r.month, r.payload, r.is_active, r.confirmed_at, f.imported_at,
                      COALESCE(v.name, '') AS vessel
               FROM monthly_reports r JOIN report_files f ON f.id = r.file_id
               LEFT JOIN vessels v ON v.id = r.vessel_id
               WHERE r.is_active = 1 AND r.report_type = 'lub_oil_stock_consumption' AND r.month IS NOT NULL""").fetchall()
        processed = db.execute("SELECT MAX(processed_at) FROM processing_runs").fetchone()[0]
        # Files whose latest processing attempt failed and that never produced a report.
        failures = db.execute(
            """SELECT p.processed_at, p.error FROM processing_runs p
               WHERE p.state = 'Failed'
                 AND NOT EXISTS (SELECT 1 FROM monthly_reports m WHERE m.file_id = p.file_id)
                 AND p.id = (SELECT MAX(q.id) FROM processing_runs q WHERE q.file_id = p.file_id)""").fetchall()
    finally:
        db.close()

    processed_text = f"Processed {fmt_time(processed, today)}" if processed else "Processing time not recorded"
    if not rows:
        context = "No vessel sheet is in use for analysis"
        if failures:
            context += f"; {_plural(len(failures), 'file')} could not be imported"
        return Intel("oil", "failed" if failures else "none", "Not yet processed", context,
                     processed_text if processed else "", outcome="No sheet in use yet",
                     attention=_lube_failure_items(failures, today))

    latest_month = max(r["month"] for r in rows)
    in_latest = sum(1 for r in rows if r["month"] == latest_month)
    newest = {}
    for row in rows:
        key = row["vessel"] or f"report {row['id']}"
        if key not in newest or row["month"] > newest[key]["month"]:
            newest[key] = row

    items = []
    for vessel, row in newest.items():
        brief = decision_brief({"data": json.loads(row["payload"]), "is_active": bool(row["is_active"]),
                                "confirmed_at": row["confirmed_at"]})
        priority = brief.get("priority")
        if priority is None:
            continue
        items.append(Attention(
            ACTION if priority == 1 else REVIEW, vessel, brief["headline"], _clip(brief["rationale"]), "oil",
            f"{fmt_month(row['month'])} sheet", f"Imported {fmt_day(row['imported_at'], today)}",
            rank=(priority, -int(row["month"].replace("-", "")), vessel)))
    flagged = len(items)
    items += _lube_failure_items(failures, today)

    outcome = (f"{flagged} of {_plural(len(newest), 'vessel')}: review action in latest sheet" if flagged
               else f"No priority exception in the latest sheet of {_plural(len(newest), 'vessel')}")
    updated = f"Processed {fmt_day(processed, today)}" if processed else "Processing time not recorded"
    if failures:
        updated += f" · {_plural(len(failures), 'file')} not imported"
    # Failed files may not be Lub Oil sheets at all, so they are reported as their own attention item
    # rather than marking the dataset partial.
    return Intel("oil", "ok", f"{fmt_month(latest_month)} sheets",
                 f"{_plural(in_latest, 'vessel sheet')} in use for {fmt_month(latest_month, short=True)}",
                 processed_text, outcome=outcome, updated=updated, attention=items)


def _lube_failure_items(failures, today):
    if not failures:
        return []
    reasons = Counter(_clip(str(f["error"] or "Unknown error").split(":", 1)[-1], 90) for f in failures)
    days = sorted(filter(None, (parse_time(f["processed_at"]) for f in failures)))
    span = ""
    if days:
        span = fmt_day(days[0], today)
        if days[-1].date() != days[0].date():
            span += f" – {fmt_day(days[-1], today)}"
    return [Attention(REVIEW, "Vessel not identified", f"{_plural(len(failures), 'source file')} could not be imported",
                      reasons.most_common(1)[0][0], "oil", f"Import attempts {span}".strip(), "Not imported",
                      rank=(8,))]


def gc_intel(root, today=None):
    from gc_manager import command  # the shared claim rules (Command Centre, Register, Inspector and Home)
    from gc_manager.repository import tracked_ids, tracked_sql

    today = today or date.today()
    db = _open(root)
    if db is None or not _has(db, "gc_claims"):
        return Intel("gc", "none", "Register not created", "No claims have been registered",
                     outcome="No claims registered yet")
    try:
        settings = {r["key"]: json.loads(r["value"]) for r in db.execute("SELECT key, value FROM gc_settings")}
        claims = [dict(r) for r in db.execute(
            """SELECT c.*, v.name AS vessel_name,
                      (SELECT h.changed_at FROM gc_status_history h WHERE h.claim_id = c.id ORDER BY h.id DESC LIMIT 1) AS last_status_change
               FROM gc_claims c JOIN vessels v ON v.id = c.vessel_id""")]
        vessels = {r["vessel_id"]: dict(r) for r in db.execute("SELECT * FROM gc_vessel_details")}
        snoozes = ({r[0]: r[1] for r in db.execute("SELECT claim_id, MAX(snoozed_until) FROM gc_snoozes WHERE cleared_at IS NULL GROUP BY claim_id")}
                   if _has(db, "gc_snoozes") else {})
        updated = db.execute(
            "SELECT MAX(t) FROM (SELECT MAX(updated_at) t FROM gc_claims UNION ALL SELECT MAX(changed_at) FROM gc_status_history)").fetchone()[0]
        imported = db.execute("SELECT MAX(imported_at) FROM gc_emails").fetchone()[0]
        tracked = tracked_ids(settings.get("tracked_vessels"), db.execute("SELECT id, name FROM vessels").fetchall())
        open_reviews = db.execute(
            "SELECT review_type, COUNT(*) n FROM gc_review_queue WHERE status = 'OPEN' "
            f"AND {tracked_sql('suggested_vessel_id', tracked)} GROUP BY review_type").fetchall()
    finally:
        db.close()

    items, not_set_up = [], {}
    for claim in claims:
        result = command.assess(claim, settings=settings, vessel=vessels.get(claim["vessel_id"], {}), today=today,
                                snoozed_until=snoozes.get(claim["id"]))
        verified = [r for r in result.reasons if r.category in (command.ACTION, command.FOLLOW_UP)]
        if not verified:
            if any(r.code == "RECORD_INCOMPLETE" for r in result.reasons):
                not_set_up[claim["vessel_name"]] = not_set_up.get(claim["vessel_name"], 0) + 1
            continue
        title = (claim.get("title") or claim.get("equipment_system") or "").strip()
        action = result.klass <= 2 or any(r.code in command.OVERDUE_CODES for r in verified)
        items.append(Attention(
            ACTION if action else REVIEW, claim["vessel_name"],
            f"{claim['gc_number']}{' · ' + title if title else ''}: {command.REASON_LABEL.get(verified[0].code, verified[0].code)}",
            _clip(" ".join(r.text for r in verified)), "gc", f"Register as of {fmt_day(updated, today)}", f"Rules applied {fmt_day(today, today)}",
            rank=(0 if action else 1, *result.rank)))
    for vessel_name, count in sorted(not_set_up.items()):
        items.append(Attention(
            REVIEW, vessel_name, f"{_plural(count, 'claim')} not set up yet",
            "No verified action owner or next required action is recorded; use the guided set-up in Guarantee Claims",
            "gc", f"Register as of {fmt_day(updated, today)}", f"Rules applied {fmt_day(today, today)}", rank=(3,)))
    flagged = len(items) - len(not_set_up)
    review_total = sum(r["n"] for r in open_reviews)
    if review_total:
        ambiguous = all(r["review_type"] == "AMBIGUOUS_VESSEL" for r in open_reviews)
        items.append(Attention(
            REVIEW, "Vessel not confirmed" if ambiguous else "Several vessels",
            f"{_plural(review_total, 'Outlook email')} awaiting review",
            "Vessel could not be matched automatically" if ambiguous else "Not matched to a claim automatically",
            "gc", f"Outlook import {fmt_day(imported, today)}" if imported else "Outlook import", "Review queue", rank=(2,)))

    imported_text = f"Outlook emails imported {fmt_day(imported, today)}" if imported else "No Outlook import recorded"
    register_text = f"Register updated {fmt_time(updated, today)}" if updated else "Register update time not recorded"
    if not claims:
        return Intel("gc", "none", "No claims registered", imported_text, register_text,
                     outcome="No claims registered yet", attention=items)
    open_claims = sum(1 for c in claims if c["current_status"] not in {"CLOSED", "CANCELLED"})
    outcome = (f"{_plural(flagged, 'claim')} flagged by follow-up rules" if flagged
               else "No claim flagged by follow-up rules")
    return Intel("gc", "ok", _plural(open_claims, "open claim"), imported_text, register_text, outcome=outcome,
                 updated=(f"Register updated {fmt_day(updated, today)} · rules applied today" if updated
                          else "Rules applied today"), attention=items)


def cjc_intel(root, today=None):
    db = _open(root)
    if db is None or not _has(db, "cjc_runs"):
        return Intel("cjc", "none", "Not yet processed", "No critical job extraction has been saved",
                     outcome="No extraction saved yet")
    try:
        runs = [dict(r) for r in db.execute(
            "SELECT id, vessel_name, review_start, review_end, status, extracted_count, error, started_at, finished_at "
            "FROM cjc_runs ORDER BY id DESC")]
    finally:
        db.close()
    if not runs:
        return Intel("cjc", "none", "Not yet processed", "No critical job extraction has been saved",
                     outcome="No extraction saved yet")

    latest = runs[0]
    window = f"{fmt_iso_day(latest['review_start'], today)} – {fmt_iso_day(latest['review_end'], today)}"
    finished = latest["finished_at"] or latest["started_at"]
    items, seen = [], set()
    for run in runs:  # newest first: the latest run per vessel decides
        if run["vessel_name"] in seen:
            continue
        seen.add(run["vessel_name"])
        if run["status"] in {"Reconciliation failed", "Failed", "Vessel not found"}:
            items.append(Attention(
                REVIEW, run["vessel_name"], f"Critical job extraction: {run['status'].lower()}",
                _clip(run["error"] or "The extracted population did not verify, so it is not used."), "cjc",
                f"Window {fmt_iso_day(run['review_start'], today)} – {fmt_iso_day(run['review_end'], today)}",
                f"Run {fmt_day(run['finished_at'] or run['started_at'], today)}", rank=(1, -run["id"])))

    if latest["status"] == "Verified":
        state, headline = "ok", f"{latest['vessel_name']} · population verified"
        outcome = f"{_plural(latest['extracted_count'] or 0, 'critical job plan')} verified"
    elif latest["status"] == "Running":
        state, headline, outcome = "partial", f"{latest['vessel_name']} · extraction in progress", "Extraction in progress"
    else:
        state, headline, outcome = "failed", f"{latest['vessel_name']} · {latest['status'].lower()}", "Latest extraction did not verify"
    count = latest["extracted_count"]
    context = f"{_plural(count, 'job plan')} · window {window}" if count is not None else f"Window {window}"
    return Intel("cjc", state, headline, context,
                 f"Processed {fmt_time(finished, today)} · compliance not yet assessed", outcome=outcome,
                 updated=f"Processed {fmt_day(finished, today)} · compliance assessment not saved yet",
                 attention=items)


# ── Superintendent Inspection Report (web app summary, cached) ─────────────────

def sir_cache_path(root=None):
    return Path(root or runtime_root()) / "home" / "inspections_summary.json"


def fetch_inspection_summary(port, root=None, timeout=15, headers=None):
    """Read the web app's summary while its server is running and cache it with the fetch time.
    headers carries the launcher's short-lived service ticket (the app refuses unauthenticated requests)."""
    request = urllib.request.Request(f"http://localhost:{port}/api/inspections/summary", headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        summary = json.loads(response.read().decode("utf-8"))
    if not isinstance(summary.get("reports"), list):
        raise ValueError("Unexpected inspection summary format.")
    summary["fetchedAt"] = datetime.now().isoformat(timespec="seconds")
    path = sir_cache_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
        json.dump(summary, handle)
        temporary = handle.name
    os.replace(temporary, path)
    return summary


def _inspection_day(report):
    return report.get("dateFrom") or report.get("dateTo") or ""


def _device_items(summary, today=None):
    """What the browser last said about its own copy (audit P1-7): reports not in the cloud yet, and reports waiting
    for a decision (changed elsewhere, or changes refused because the report is approved)."""
    device = summary.get("device") or {}
    items = []
    when = f"As reported by the browser {fmt_time(device.get('at'), today)}" if device.get("at") else ""
    if device.get("pending"):
        items.append(Attention(
            REVIEW, "This PC's browser", f"{_plural(device['pending'], 'report')} only on this device",
            "Not in the cloud yet, so not in the daily backup either. Open Inspection Reports while online to sync them.",
            "sir", "", when, rank=(1, 0), target="inspections"))
    decisions = (device.get("conflicts") or 0) + (device.get("locked") or 0)
    if decisions:
        items.append(Attention(
            REVIEW, "This PC's browser", f"{_plural(decisions, 'report')} waiting for your decision",
            "Changed on another device, or changed after approval. Open the report to choose what to keep; nothing is synced until then.",
            "sir", "", when, rank=(1, 1), target="inspections"))
    return items


def sir_intel(root=None, today=None):
    path = sir_cache_path(root)
    if not path.is_file():
        return Intel("sir", "not_connected", "Summary not loaded yet",
                     "Loads while Inspection Reports is open (cloud-synced reports only)",
                     outcome="Open the workspace to load its summary")
    summary = json.loads(path.read_text(encoding="utf-8"))
    fetched = summary.get("fetchedAt")
    reports = summary.get("reports") or []
    device_items = _device_items(summary, today)
    if not reports:
        pending = (summary.get("device") or {}).get("pending") or 0
        return Intel("sir", "none", "No reports synced",
                     f"{_plural(pending, 'report')} only on this device" if pending else "No report has been synced to the cloud",
                     f"Summary fetched {fmt_time(fetched, today)}",
                     outcome="No cloud-synced reports", updated=f"Summary fetched {fmt_day(fetched, today)}", attention=device_items)

    latest = max(reports, key=lambda r: (_inspection_day(r), r.get("updatedAt") or 0))
    vessel = latest.get("vessel") or "Untitled inspection"
    inspected = fmt_iso_day(_inspection_day(latest), today)
    status = "Signed off" if latest.get("signedOff") else f"Draft · {latest.get('progress', 0)}% complete"
    open_items = len(latest.get("actionRequired") or [])
    items = []
    for report in reports:
        flagged = report.get("actionRequired") or []
        if not flagged:
            continue
        day = fmt_iso_day(_inspection_day(report), today)
        items.append(Attention(
            ACTION, report.get("vessel") or "Untitled inspection",
            f"{_plural(len(flagged), 'condition item')} rated Action required",
            _clip("; ".join(flagged)), "sir", f"Inspection {day}" if day else "Inspection date not entered",
            f"Report saved {fmt_day(report.get('updatedAt'), today)}",
            rank=(0, -(report.get("updatedAt") or 0)), target=f"inspections/report?id={report.get('id')}"))
    # Report completion and findings are separate: a signed-off report can still carry Action-required
    # items, and the form has no closure field, so closure is never implied.
    rated = f"{latest.get('ratedCount', 0)} of {latest.get('itemCount', 0)} condition items rated"
    context = f"{'Inspected ' + inspected if inspected else 'Inspection date not entered'} · {status}"
    items.extend(device_items)
    return Intel("sir", "ok", f"Latest: {vessel}", context,
                 f"Summary fetched {fmt_time(fetched, today)} · finding closure not tracked",
                 outcome=f"{status} · {_plural(open_items, 'item')} rated Action required",
                 updated=f"{rated} · report saved {fmt_day(latest.get('updatedAt'), today)}", attention=items)


# ── DNV Emissions Validation (web app summary, cached) ────────────────────────

def evi_cache_path(root=None):
    return Path(root or runtime_root()) / "home" / "emissions_summary.json"


def fetch_emissions_summary(port, root=None, timeout=15, headers=None):
    """Read the Emissions Validation summary while its server is running and cache it with the fetch time."""
    request = urllib.request.Request(f"http://localhost:{port}/api/summary", headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        summary = json.loads(response.read().decode("utf-8"))
    if not isinstance(summary.get("sessions"), list):
        raise ValueError("Unexpected emissions summary format.")
    summary["fetchedAt"] = datetime.now().isoformat(timespec="seconds")
    path = evi_cache_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
        json.dump(summary, handle)
        temporary = handle.name
    os.replace(temporary, path)
    return summary


def _evi_period(session):
    period = session.get("period") or {}
    return f"{period.get('from')} to {period.get('to')}" if period.get("from") else "Period not set"


def evi_intel(root=None, today=None):
    path = evi_cache_path(root)
    if not path.is_file():
        return Intel("evi", "not_connected", "Summary not loaded yet", "Loads while Emissions Validation is open",
                     outcome="Open the workspace to load its summary")
    summary = json.loads(path.read_text(encoding="utf-8"))
    fetched = summary.get("fetchedAt")
    freshness = f"Summary fetched {fmt_time(fetched, today)}"
    if not summary.get("configured"):
        return Intel("evi", "none", "Storage not configured", "Set EMISSIONS_MONGODB_URI for the workspace", freshness,
                     outcome="Storage not configured")
    sessions = summary.get("sessions") or []
    validated = [s for s in sessions if s.get("run")]
    if not validated:
        return Intel("evi", "none", "Not yet validated",
                     "No validation session has a completed run" if sessions else "No validation session yet", freshness,
                     outcome="No completed validation run", updated=f"Summary fetched {fmt_day(fetched, today)}")
    latest = max(validated, key=lambda s: s["run"].get("finishedAt") or "")
    counts = latest["run"].get("summary") or {}
    items = []
    for s in validated:
        c = s["run"].get("summary") or {}
        if c.get("errors"):
            items.append(Attention(
                REVIEW, s.get("vessel") or "Unnamed vessel", f"{_plural(c['errors'], 'validation error')} to investigate",
                _clip(f"{c.get('dnvReproduced', 0)} of {c.get('dnv', 0)} DNV item(s) independently reproduced; "
                      f"{c.get('dnvUnresolved', 0)} unresolved. Findings are diagnostic, not confirmed reporting errors."),
                "evi", _evi_period(s), f"Validated {fmt_day(s['run'].get('finishedAt'), today)}",
                rank=(0, -(c.get("errors") or 0)), target=f"sessions/{s.get('id')}"))
    context = (f"{_evi_period(latest)} · {_plural(counts.get('errors', 0), 'error')}, "
               f"{_plural(counts.get('warnings', 0), 'warning')}")
    return Intel("evi", "ok", f"Latest: {latest.get('vessel') or 'Unnamed vessel'}", context, freshness,
                 outcome=f"{_plural(counts.get('dnv', 0), 'DNV item')}: {counts.get('dnvReproduced', 0)} reproduced, "
                         f"{counts.get('dnvUnresolved', 0)} unresolved",
                 updated=f"Validated {fmt_day(latest['run'].get('finishedAt'), today)} · original files never modified",
                 attention=items)


# ── Assembly ──────────────────────────────────────────────────────────────────

PROVIDERS = {
    "vessel": vessel_report_intel, "oil": lube_intel, "voyage": voyage_intel,
    "gc": gc_intel, "cjc": cjc_intel, "sir": sir_intel, "evi": evi_intel, "dd": docking_intel,
}


def no_access(key):
    """A workspace this person may not use: nothing of it is read or shown."""
    return Intel(key, "no_access", "No access", outcome="No access")


def load_all(root=None, today=None, providers=None, allowed=None):
    """Load every workspace independently; a failing workspace becomes an error state, never a crash.
    With allowed (a predicate on the workspace key), workspaces the person may not use are not read at all."""
    root = Path(root) if root else runtime_root()
    result = {}
    for key, provider in (providers or PROVIDERS).items():
        if allowed is not None and not allowed(key):
            result[key] = no_access(key)
            continue
        try:
            result[key] = provider(root, today)
        except Exception as error:  # isolate the failure to this workspace
            result[key] = Intel(key, "error", "Could not read saved results",
                                _clip(f"{type(error).__name__}: {error}", 120), outcome="Saved results unavailable")
    return result


def top_attention(intel, limit=4):
    """Most severe first; within a severity, alternate between workspaces so one does not fill the list.
    Returns (shown items, hidden count per workspace)."""
    pool = [item for key in ORDER if key in intel for item in intel[key].attention]
    ordered = []
    for severity in (ACTION, REVIEW):
        queues = {key: sorted((i for i in pool if i.severity == severity and i.workspace == key), key=lambda i: i.rank)
                  for key in ORDER}
        while any(queues.values()):
            for key in ORDER:
                if queues[key]:
                    ordered.append(queues[key].pop(0))
    return ordered[:limit], dict(Counter(item.workspace for item in ordered[limit:]))
