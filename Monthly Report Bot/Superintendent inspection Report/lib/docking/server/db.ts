// Digital Docking · Stage 1B: the local store. One SQLite file (Node's built-in node:sqlite) plus content-addressed
// folders for original workbooks and photos, all outside the source repository:
//   <data>/docking/docking.sqlite3   records
//   <data>/docking/originals/ab/<sha256>.xlsx, photos/ab/<sha256>.<ext>   immutable files, named by their hash
//   <data>/docking/staging/          files being written (cleared on open)
//   <data>/docking/backups/          see backup.ts
// <data> is DOCKING_DATA_DIR, else ABHISHEK_SUITE_DATA, else %LOCALAPPDATA%\AbhishekAutomationSuite (as the desktop suite).
//
// Rules enforced by the schema itself, not only by the code: source records (activities, photos, import attempts,
// annotations, audit) can never be changed or deleted; a submission can only change from current to superseded; one
// current submission per day and department; links between activities and jobs are history, never overwritten.

import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"

export const SCHEMA_VERSION = 2

export type Store = Readonly<{ db: DatabaseSync; root: string }>

export function dataRoot(): string {
  if (process.env.DOCKING_DATA_DIR) return process.env.DOCKING_DATA_DIR
  const suite = process.env.ABHISHEK_SUITE_DATA || join(process.env.LOCALAPPDATA || homedir(), "AbhishekAutomationSuite")
  return join(suite, "docking")
}

const IMMUTABLE = ["activities", "photos", "import_attempts", "annotations", "audit", "source_files", "job_links_history"]

const V1 = `
CREATE TABLE dockings(
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  vessel_id TEXT NOT NULL, vessel_name TEXT NOT NULL,
  yard TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', docking_type TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL, day0_date TEXT NOT NULL, arrival_time TEXT,
  planned_departure_date TEXT, status TEXT NOT NULL CHECK(status IN ('planned','active','completed','cancelled')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE days(
  id TEXT PRIMARY KEY, docking_id TEXT NOT NULL REFERENCES dockings(id),
  day_no INTEGER NOT NULL CHECK(day_no >= 0), report_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('expected','received','reviewed','no_report')),
  no_report_reason TEXT, updated_at TEXT NOT NULL,
  UNIQUE(docking_id, day_no), UNIQUE(docking_id, report_date)
) STRICT;

CREATE TABLE source_files(
  sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64), bytes INTEGER NOT NULL, stored_path TEXT NOT NULL,
  first_name TEXT NOT NULL, first_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_attempts(
  id TEXT PRIMARY KEY, docking_id TEXT REFERENCES dockings(id), sha256 TEXT, file_name TEXT NOT NULL,
  attempted_at TEXT NOT NULL, actor TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','rejected')), messages TEXT NOT NULL DEFAULT '[]',
  submission_id TEXT
) STRICT;

CREATE TABLE submissions(
  id TEXT PRIMARY KEY, docking_id TEXT NOT NULL REFERENCES dockings(id), day_id TEXT NOT NULL REFERENCES days(id),
  department TEXT NOT NULL CHECK(department IN ('deck','engine')),
  sha256 TEXT NOT NULL REFERENCES source_files(sha256), file_name TEXT NOT NULL,
  template TEXT NOT NULL, template_version INTEGER NOT NULL,
  received_via TEXT NOT NULL CHECK(received_via IN ('email','teams','other')),
  imported_by TEXT NOT NULL, imported_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('current','superseded')),
  supersedes_id TEXT REFERENCES submissions(id), correction_reason TEXT, validation TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX one_current_submission ON submissions(day_id, department) WHERE status = 'current';
CREATE TRIGGER submissions_only_supersede BEFORE UPDATE ON submissions
WHEN NOT (OLD.status = 'current' AND NEW.status = 'superseded') OR NEW.id IS NOT OLD.id OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.day_id IS NOT OLD.day_id OR NEW.department IS NOT OLD.department OR NEW.docking_id IS NOT OLD.docking_id
  OR NEW.validation IS NOT OLD.validation OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.imported_at IS NOT OLD.imported_at
BEGIN SELECT RAISE(ABORT, 'a submission can only be superseded'); END;
CREATE TRIGGER submissions_no_delete BEFORE DELETE ON submissions BEGIN SELECT RAISE(ABORT, 'submissions are never deleted'); END;

CREATE TABLE activities(
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), docking_id TEXT NOT NULL REFERENCES dockings(id),
  sheet TEXT NOT NULL, row_no INTEGER NOT NULL, row_ref TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '', performed_by TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', work_text TEXT NOT NULL, findings TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '', witnessed TEXT NOT NULL DEFAULT '',
  reading_ref TEXT NOT NULL DEFAULT '', photo_notes TEXT NOT NULL DEFAULT '', continues_ref TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '{}',
  UNIQUE(submission_id, sheet, row_no)
) STRICT;
CREATE INDEX activities_by_docking ON activities(docking_id);

CREATE TABLE photos(
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES submissions(id), docking_id TEXT NOT NULL REFERENCES dockings(id),
  activity_id TEXT REFERENCES activities(id), sheet TEXT NOT NULL, row_no INTEGER NOT NULL, cell TEXT NOT NULL,
  slot INTEGER, method TEXT NOT NULL, anchor TEXT NOT NULL, media_part TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER, format TEXT,
  stored_path TEXT, link_status TEXT NOT NULL CHECK(link_status IN ('linked','rejected')), reason TEXT NOT NULL DEFAULT '',
  CHECK((link_status = 'linked') = (activity_id IS NOT NULL AND slot IS NOT NULL))
) STRICT;
CREATE INDEX photos_by_activity ON photos(activity_id);

CREATE TABLE jobs(
  id TEXT PRIMARY KEY, docking_id TEXT NOT NULL REFERENCES dockings(id), job_no TEXT NOT NULL,
  department TEXT NOT NULL CHECK(department IN ('deck','engine')), seq INTEGER NOT NULL,
  title TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(docking_id, job_no), UNIQUE(docking_id, department, seq)
) STRICT;

-- Current link of each activity to a job; every link and unlink is also written to job_links_history.
CREATE TABLE job_links(
  activity_id TEXT PRIMARY KEY REFERENCES activities(id), job_id TEXT NOT NULL REFERENCES jobs(id),
  linked_by TEXT NOT NULL, linked_at TEXT NOT NULL
) STRICT;
CREATE TABLE job_links_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id TEXT NOT NULL, job_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('link','unlink')), actor TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TRIGGER job_links_same_docking BEFORE INSERT ON job_links
WHEN (SELECT docking_id FROM activities WHERE id = NEW.activity_id) IS NOT (SELECT docking_id FROM jobs WHERE id = NEW.job_id)
BEGIN SELECT RAISE(ABORT, 'an activity can only be linked to a job of the same docking'); END;

CREATE TABLE annotations(
  id TEXT PRIMARY KEY, docking_id TEXT NOT NULL REFERENCES dockings(id), entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('comment','query','correction')), body TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL, supersedes_id TEXT REFERENCES annotations(id)
) STRICT;
CREATE INDEX annotations_by_entity ON annotations(entity, entity_id);

CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, docking_id TEXT, before TEXT, after TEXT
) STRICT;
CREATE INDEX audit_by_docking ON audit(docking_id, id);
`

function immutableTriggers(): string {
  return IMMUTABLE.map((t) => `
CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} records cannot be changed'); END;
CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} records cannot be deleted'); END;`).join("\n")
}

// V2 (2026-11-22): the Daily Report to owners and the names of the people who act.
//   daily_reports    the Superintendent's working draft of one day's report (one per day; edited freely, never deleted)
//   report_versions  each issued version: the exact content, email text and PDF (stored under its hash); never changed
//   people           the name last seen for each signed-in account, so screens show names instead of e-mail addresses
const V2 = `
CREATE TABLE people(sub TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;

CREATE TABLE daily_reports(
  id TEXT PRIMARY KEY, docking_id TEXT NOT NULL REFERENCES dockings(id), day_id TEXT NOT NULL UNIQUE REFERENCES days(id),
  content TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER daily_reports_no_delete BEFORE DELETE ON daily_reports BEGIN SELECT RAISE(ABORT, 'daily reports are never deleted'); END;
CREATE TRIGGER daily_reports_fixed BEFORE UPDATE ON daily_reports
WHEN NEW.id IS NOT OLD.id OR NEW.docking_id IS NOT OLD.docking_id OR NEW.day_id IS NOT OLD.day_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.rev <> OLD.rev + 1
BEGIN SELECT RAISE(ABORT, 'a daily report keeps its day; each save raises its revision by one'); END;

CREATE TABLE report_versions(
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES daily_reports(id), docking_id TEXT NOT NULL REFERENCES dockings(id),
  day_id TEXT NOT NULL REFERENCES days(id), version INTEGER NOT NULL CHECK(version >= 1),
  content TEXT NOT NULL, email_text TEXT NOT NULL,
  pdf_sha256 TEXT NOT NULL CHECK(length(pdf_sha256) = 64), pdf_path TEXT NOT NULL, pdf_bytes INTEGER NOT NULL, file_name TEXT NOT NULL,
  photos INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', issued_by TEXT NOT NULL, issued_at TEXT NOT NULL,
  UNIQUE(day_id, version)
) STRICT;
CREATE TRIGGER report_versions_no_update BEFORE UPDATE ON report_versions BEGIN SELECT RAISE(ABORT, 'report_versions records cannot be changed'); END;
CREATE TRIGGER report_versions_no_delete BEFORE DELETE ON report_versions BEGIN SELECT RAISE(ABORT, 'report_versions records cannot be deleted'); END;
`

const MIGRATIONS: Record<number, string> = { 1: V1 + immutableTriggers(), 2: V2 }

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  }
}

function storedVersion(db: DatabaseSync): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  if (!exists) return 0
  return Number((db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v)
}

/** Open (creating or upgrading) the store. An upgrade of a store that holds data is preceded by a database backup. */
export async function openStore(root: string = dataRoot()): Promise<Store> {
  for (const dir of ["originals", "photos", "staging", "backups"]) mkdirSync(join(root, dir), { recursive: true })
  for (const leftover of readdirSync(join(root, "staging"))) rmSync(join(root, "staging", leftover), { force: true, recursive: true })
  const db = new DatabaseSync(join(root, "docking.sqlite3"), { timeout: 15000 })
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
  const version = storedVersion(db)
  if (version > SCHEMA_VERSION) {
    db.close()
    throw new Error(`This docking database was written by a newer NeraVeda (schema ${version}). Update NeraVeda before opening it.`)
  }
  if (version > 0 && version < SCHEMA_VERSION) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    await backup(db, join(root, "backups", `docking-before-schema-${SCHEMA_VERSION}-${stamp}.sqlite3`))
  }
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    tx(db, () => {
      if (v === 1) db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;")
      db.exec(MIGRATIONS[v])
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(v, new Date().toISOString())
    })
  }
  return { db, root }
}

export function closeStore(store: Store): void {
  if (store.db.isOpen) store.db.close()
}
