"""Suite-owned SQLite connection and first versioned schema."""
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
import shutil
import sqlite3
from report_catalog import VESSELS

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS vessels(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS vessel_aliases(alias TEXT PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id));
CREATE TABLE IF NOT EXISTS report_files(
 id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
 archive_path TEXT NOT NULL, imported_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_occurrences(
 id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES report_files(id),
 source_path TEXT NOT NULL, seen_at TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS processing_runs(
 id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES report_files(id),
 parser_version TEXT NOT NULL, state TEXT NOT NULL, error TEXT, processed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS monthly_reports(
 id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL UNIQUE REFERENCES report_files(id),
 vessel_id INTEGER REFERENCES vessels(id), report_type TEXT NOT NULL,
 month TEXT, reporting_date TEXT, report_version INTEGER NOT NULL,
 source_status TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0,
 supersedes_report_id INTEGER REFERENCES monthly_reports(id),
 validation_status TEXT NOT NULL, payload TEXT NOT NULL,
 confirmed_at TEXT, review_note TEXT,
 UNIQUE(vessel_id, report_type, month, report_version));
CREATE UNIQUE INDEX IF NOT EXISTS active_month ON monthly_reports(vessel_id, report_type, month) WHERE is_active=1;
CREATE TABLE IF NOT EXISTS audit_events(
 id INTEGER PRIMARY KEY, report_id INTEGER REFERENCES monthly_reports(id),
 action TEXT NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_notes(
 id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES monthly_reports(id),
 issue_code TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS budget_scenarios(
 id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES monthly_reports(id),
 payload TEXT NOT NULL, created_at TEXT NOT NULL);
"""

# v2: suite-wide vessel groups (user-defined sets of ships), shared by every module. Additive only.
SUITE_SCHEMA_VERSION = 2
GROUP_SCHEMA = """
CREATE TABLE IF NOT EXISTS vessel_groups(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS vessel_group_name ON vessel_groups(name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS vessel_group_members(
 group_id INTEGER NOT NULL REFERENCES vessel_groups(id), vessel_id INTEGER NOT NULL REFERENCES vessels(id),
 added_at TEXT NOT NULL, PRIMARY KEY(group_id, vessel_id));
CREATE TABLE IF NOT EXISTS vessel_group_history(
 id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES vessel_groups(id), action TEXT NOT NULL,
 detail TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
"""


def _stored_version(database):
    """(schema version, has monthly reports) read without taking a write lock; (0, False) for a new file."""
    if not database.exists():
        return 0, False
    reader = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in reader.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        version = (reader.execute("SELECT COALESCE(MAX(version),0) FROM schema_migrations").fetchone()[0]
                   if "schema_migrations" in tables else 0)
        reports = ("monthly_reports" in tables
                   and reader.execute("SELECT COUNT(*) FROM monthly_reports").fetchone()[0] > 0)
    finally:
        reader.close()
    return version, reports


@contextmanager
def connection(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / "suite.sqlite3", timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
    finally:
        db.close()


def initialize(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    database = root / "suite.sqlite3"
    version, has_reports = _stored_version(database)
    if version > SUITE_SCHEMA_VERSION:
        raise RuntimeError("This Suite database requires a newer application version.")
    if 0 < version < SUITE_SCHEMA_VERSION and has_reports:
        backups = root / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copy2(database, backups / f"suite-before-core-v{SUITE_SCHEMA_VERSION}-{datetime.now():%Y%m%d-%H%M%S}.sqlite3.bak")
    with connection(root) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            for statement in (SCHEMA + GROUP_SCHEMA).split(";"):
                if statement.strip():
                    db.execute(statement)
            for migration in range(1, SUITE_SCHEMA_VERSION + 1):
                db.execute("INSERT OR IGNORE INTO schema_migrations VALUES(?)", (migration,))
            for name in VESSELS:
                db.execute("INSERT OR IGNORE INTO vessels(name) VALUES(?)", (name,))
                db.execute("INSERT OR IGNORE INTO vessel_aliases SELECT ?,id FROM vessels WHERE name=?", (name, name))
            db.commit()
        except Exception:
            db.rollback()
            raise
