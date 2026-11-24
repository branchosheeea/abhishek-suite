"""The last collection run, saved for the NeraVeda home page (audit P1-7).

Before, run results lived only in the window and were lost when it closed, so Home said "Not connected". When a run
finishes, a small summary is written to <runtime root>/home/vessel_report_summary.json: period, vessels, reports,
counts, and the reports that need attention. Home reads it (suite_services/home_intelligence.vessel_report_intel).
No file paths of downloaded attachments and no portal data beyond what the window already showed.
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import tempfile

from suite_services.storage import runtime_root


def summary_path(root=None):
    return Path(root or runtime_root()) / "home" / "vessel_report_summary.json"


def _day(value):
    return value.date().isoformat() if isinstance(value, datetime) else str(value)[:10]


def build_run_summary(request, results, finished, fatal=False, now=None):
    """The summary of a finished run. request: core.BatchRequest; results: the window's result dicts (vessel, report,
    status, paths, error); finished: the run's "finished" event (completed, files, failed, stopped)."""
    attention = [
        {"vessel": r["vessel"], "report": r["report"], "status": r["status"], "error": (r.get("error") or "")[:300]}
        for r in results if r.get("status") == "Needs attention"
    ]
    return {
        "finishedAt": (now or datetime.now()).isoformat(timespec="seconds"),
        "period": {"from": _day(request.start), "to": _day(request.end)},
        "frequency": request.frequency,
        "vessels": list(dict.fromkeys(job.vessel for job in request.jobs)),
        "reports": list(dict.fromkeys(job.report for job in request.jobs)),
        "jobs": len(request.jobs),
        "completed": int(finished.get("completed", 0)),
        "files": int(finished.get("files", 0)),
        "failed": int(finished.get("failed", 0)),
        "stopped": bool(finished.get("stopped")),
        "fatal": bool(fatal),
        "output": str(request.output),
        "attention": attention,
    }


def save_run_summary(summary, root=None):
    path = summary_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, suffix=".tmp") as handle:
        json.dump(summary, handle)
        temporary = handle.name
    os.replace(temporary, path)
    return path
