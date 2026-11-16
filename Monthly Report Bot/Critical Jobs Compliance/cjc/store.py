"""Critical Job Compliance tables inside the shared suite database (prefix cjc_)."""
from __future__ import annotations

import getpass
import json
from datetime import date, datetime
from pathlib import Path

from suite_services import database
from suite_services.storage import runtime_root

from .models import JobPlan, Reconciliation

SCHEMA_VERSION = 1
SCHEMA = """
CREATE TABLE IF NOT EXISTS cjc_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cjc_runs(
 id INTEGER PRIMARY KEY,
 vessel_id INTEGER REFERENCES vessels(id),
 vessel_name TEXT NOT NULL,
 review_start TEXT NOT NULL,
 review_end TEXT NOT NULL,
 filter_profile TEXT NOT NULL,
 status TEXT NOT NULL,
 displayed_count INTEGER,
 extracted_count INTEGER,
 reconciled INTEGER NOT NULL DEFAULT 0,
 reconciliation TEXT,
 error TEXT,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 actor TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS cjc_runs_vessel ON cjc_runs(vessel_name, started_at);
CREATE TABLE IF NOT EXISTS cjc_job_plans(
 id INTEGER PRIMARY KEY,
 run_id INTEGER NOT NULL REFERENCES cjc_runs(id),
 job_plan_id TEXT NOT NULL,
 equipment_code TEXT, equipment_name TEXT, title TEXT, job_type TEXT, maintenance_type TEXT,
 frequency TEXT, discipline TEXT, last_done_date TEXT, next_due_date TEXT,
 last_done_hrs TEXT, next_due_hrs TEXT, since_last_done TEXT, remaining TEXT,
 critical_to_safety TEXT, risk_assessment TEXT, safety_level TEXT, priority TEXT,
 maintenance_cause TEXT, job_assigned TEXT, remark TEXT, vessel_object_id TEXT,
 raw_json TEXT NOT NULL,
 UNIQUE(run_id, job_plan_id));
"""

# Run states
RUNNING, VERIFIED, MISMATCH, FAILED, NOT_FOUND = "Running", "Verified", "Reconciliation failed", "Failed", "Vessel not found"

PLAN_FIELDS = ("job_plan_id", "equipment_code", "equipment_name", "title", "job_type", "maintenance_type",
               "frequency", "discipline", "last_done_date", "next_due_date", "last_done_hrs", "next_due_hrs",
               "since_last_done", "remaining", "critical_to_safety", "risk_assessment", "safety_level",
               "priority", "maintenance_cause", "job_assigned", "remark", "vessel_object_id")


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _actor():
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


class Store:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root else runtime_root()
        database.initialize(self.root)  # shared vessels table and suite migrations
        with database.connection(self.root) as db:
            db.executescript(SCHEMA)
            db.execute("INSERT OR IGNORE INTO cjc_schema_migrations VALUES(?,?)", (SCHEMA_VERSION, _now()))
            db.commit()

    def start_run(self, vessel: str, review_start: date, review_end: date, profile: dict) -> int:
        with database.connection(self.root) as db:
            row = db.execute("SELECT id FROM vessels WHERE name=?", (vessel,)).fetchone()
            cursor = db.execute(
                "INSERT INTO cjc_runs(vessel_id,vessel_name,review_start,review_end,filter_profile,status,"
                "started_at,actor) VALUES(?,?,?,?,?,?,?,?)",
                (row["id"] if row else None, vessel, review_start.isoformat(), review_end.isoformat(),
                 json.dumps(profile, sort_keys=True), RUNNING, _now(), _actor()))
            db.commit()
            return cursor.lastrowid

    def finish_run(self, run_id: int, plans: list[JobPlan], reconciliation: Reconciliation) -> str:
        """Save the population atomically. Rows are kept even when reconciliation fails,
        as evidence, but only Verified runs count as a population."""
        status = VERIFIED if reconciliation.passed else MISMATCH
        with database.connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM cjc_job_plans WHERE run_id=?", (run_id,))
                # Duplicate ids already fail reconciliation; keep the first occurrence as evidence.
                db.executemany(
                    f"INSERT OR IGNORE INTO cjc_job_plans(run_id,{','.join(PLAN_FIELDS)},raw_json) "
                    f"VALUES(?,{','.join('?' * len(PLAN_FIELDS))},?)",
                    [(run_id, *(getattr(plan, f) for f in PLAN_FIELDS), plan.raw_json()) for plan in plans])
                db.execute(
                    "UPDATE cjc_runs SET status=?,displayed_count=?,extracted_count=?,reconciled=?,"
                    "reconciliation=?,finished_at=? WHERE id=?",
                    (status, reconciliation.displayed_count, reconciliation.extracted_count,
                     int(reconciliation.passed), json.dumps(reconciliation.as_record()), _now(), run_id))
                db.commit()
            except Exception:
                db.rollback()
                raise
        return status

    def fail_run(self, run_id: int, error: str, status: str = FAILED):
        with database.connection(self.root) as db:
            db.execute("UPDATE cjc_runs SET status=?,error=?,finished_at=? WHERE id=?",
                       (status, error[:4000], _now(), run_id))
            db.commit()

    def runs(self, limit: int = 200) -> list[dict]:
        with database.connection(self.root) as db:
            return [dict(r) for r in db.execute(
                "SELECT id,vessel_name,review_start,review_end,status,displayed_count,extracted_count,reconciled,"
                "error,started_at,finished_at FROM cjc_runs ORDER BY id DESC LIMIT ?", (limit,))]

    def run(self, run_id: int) -> dict | None:
        with database.connection(self.root) as db:
            row = db.execute("SELECT * FROM cjc_runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["reconciliation"] = json.loads(data["reconciliation"]) if data["reconciliation"] else None
        data["filter_profile"] = json.loads(data["filter_profile"])
        return data

    def plans(self, run_id: int) -> list[dict]:
        with database.connection(self.root) as db:
            return [dict(r) for r in db.execute(
                f"SELECT {','.join(PLAN_FIELDS)} FROM cjc_job_plans WHERE run_id=? "
                "ORDER BY equipment_code, title, job_plan_id", (run_id,))]

    def mark_interrupted_runs(self):
        """Runs left 'Running' by a crash or forced close are not populations."""
        with database.connection(self.root) as db:
            db.execute("UPDATE cjc_runs SET status=?,error=COALESCE(error,'Interrupted before completion.'),"
                       "finished_at=COALESCE(finished_at,?) WHERE status=?", (FAILED, _now(), RUNNING))
            db.commit()
