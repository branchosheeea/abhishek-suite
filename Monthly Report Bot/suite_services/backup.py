"""Daily backup of the suite database and its archived source workbooks (audit item P1-1).

The suite database (suite.sqlite3) holds Lub Oil Review, Guarantee Claim Manager, Critical Job Compliance and vessel
groups, and exists only on this PC. Once a day, when NeraVeda opens, a consistent copy is taken:

    <backups>/suite-daily/<stamp>/suite.sqlite3    online snapshot (sqlite backup API, safe while in use), checked
    <backups>/suite-daily/<stamp>/manifest.json    schema version, record counts, every archived workbook with its SHA-256
    <backups>/suite-daily/files/...                the archived workbooks (originals/), stored once and shared by all
                                                   snapshots, so each day only adds new files

<backups> is NERAVEDA_BACKUP_DIR, else <runtime root>/backups (on this PC, outside OneDrive). The newest 30 snapshots
are kept. A snapshot is written under a ".partial" name and renamed only when complete, so an interrupted backup never
looks like a good one. A restore goes only into an empty folder, never over the live data, and is checked against the
manifest. Digital Docking keeps its own backups (Superintendent inspection Report/lib/docking/server/backup.ts).

    python -m suite_services.backup run                     take a backup now
    python -m suite_services.backup list                    list the snapshots
    python -m suite_services.backup verify <snapshot>       check a snapshot
    python -m suite_services.backup restore <snapshot> <empty folder>
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys

from .storage import runtime_root

KEEP = 30
FOLDER = "suite-daily"
DATABASE = "suite.sqlite3"


def backup_dir(dest=None):
    if dest is not None:
        return Path(dest)
    base = os.environ.get("NERAVEDA_BACKUP_DIR")
    return (Path(base) if base else runtime_root() / "backups") / FOLDER


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _snapshots(dest):
    """Complete snapshots (those with a manifest), oldest first."""
    if not dest.is_dir():
        return []
    return sorted(p for p in dest.iterdir() if p.is_dir() and p.name != "files" and (p / "manifest.json").is_file())


def latest_backup_day(dest=None):
    snapshots = _snapshots(backup_dir(dest))
    return snapshots[-1].name[:10] if snapshots else ""


def _counts(database):
    db = sqlite3.connect(f"file:{Path(database).as_posix()}?mode=ro", uri=True)
    try:
        check = db.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"The database copy failed its integrity check: {check}")
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {t: db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
        version = db.execute("SELECT COALESCE(MAX(version),0) FROM schema_migrations").fetchone()[0] if "schema_migrations" in tables else 0
        return counts, version
    finally:
        db.close()


def _archived_files(root):
    """The archived source workbooks (originals/<ab>/<sha256>.<ext>), as paths relative to the root."""
    folder = Path(root) / "originals"
    if not folder.is_dir():
        return []
    return sorted(p.relative_to(root).as_posix() for p in folder.rglob("*") if p.is_file() and not p.name.startswith("tmp"))


def backup_suite(root=None, dest=None, keep=KEEP, now=None):
    """Take a snapshot. Returns its folder, or None when there is no suite database yet."""
    root = Path(root) if root is not None else runtime_root()
    database = root / DATABASE
    if not database.is_file():
        return None
    dest = backup_dir(dest)
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H-%M-%S")
    folder, partial = dest / stamp, dest / f"{stamp}.partial"
    if folder.exists():
        raise FileExistsError(f"A backup named {stamp} already exists.")
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)

    source = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=15)
    copy = sqlite3.connect(partial / DATABASE)
    try:
        source.backup(copy)
    finally:
        copy.close()
        source.close()
    counts, version = _counts(partial / DATABASE)

    files = []
    for relative in _archived_files(root):
        source_file = root / relative
        target = dest / "files" / relative
        if not (target.is_file() and target.stat().st_size == source_file.stat().st_size):
            sha = _sha256(source_file)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, target)
            if _sha256(target) != sha:
                raise RuntimeError(f"Backup stopped: the copy of {relative} does not match the original.")
        else:
            # Archived workbooks are named by their SHA-256; verify() re-reads every file.
            stem = Path(relative).stem
            sha = stem if re.fullmatch(r"[0-9a-f]{64}", stem) else _sha256(target)
        files.append({"path": relative, "sha256": sha})

    manifest = {"kind": "suite", "schema": version, "created_at": datetime.now(timezone.utc).isoformat(), "counts": counts, "files": files}
    (partial / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    partial.rename(folder)
    _prune(dest, keep)
    return folder


def _prune(dest, keep):
    """Keep the newest snapshots; remove files no kept snapshot refers to, and leftovers of interrupted backups."""
    snapshots = _snapshots(dest)
    for old in snapshots[: max(0, len(snapshots) - keep)]:
        shutil.rmtree(old, ignore_errors=True)
    for leftover in dest.glob("*.partial"):
        shutil.rmtree(leftover, ignore_errors=True)
    wanted = set()
    for snapshot in _snapshots(dest):
        manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
        wanted.update(f["path"] for f in manifest["files"])
    files = dest / "files"
    if files.is_dir():
        for path in files.rglob("*"):
            if path.is_file() and path.relative_to(files).as_posix() not in wanted:
                path.unlink()


def daily_backup(root=None, dest=None, now=None):
    """Take today's snapshot if there is none yet. Returns its folder, or None."""
    now = now or datetime.now(timezone.utc)
    if latest_backup_day(dest) == now.strftime("%Y-%m-%d"):
        return None
    return backup_suite(root, dest, now=now)


def verify(snapshot):
    """Check a snapshot: the database copy's integrity and record counts, and every file's SHA-256. Returns the manifest."""
    snapshot = Path(snapshot)
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    counts, _version = _counts(snapshot / DATABASE)
    if counts != manifest["counts"]:
        raise RuntimeError("The database copy's record counts do not match the manifest.")
    for entry in manifest["files"]:
        path = snapshot.parent / "files" / entry["path"]
        if not path.is_file():
            raise RuntimeError(f"{entry['path']} is missing from the backup.")
        if _sha256(path) != entry["sha256"]:
            raise RuntimeError(f"{entry['path']} in the backup is damaged (hash mismatch).")
    return manifest


def restore(snapshot, target):
    """Restore a snapshot into an EMPTY folder (never over live data), checking it first and the result after."""
    snapshot, target = Path(snapshot), Path(target)
    if (target / DATABASE).exists():
        raise FileExistsError("The target folder already holds a suite database; restore only into an empty folder.")
    manifest = verify(snapshot)
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(snapshot / DATABASE, target / DATABASE)
    for entry in manifest["files"]:
        destination = target / entry["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(snapshot.parent / "files" / entry["path"], destination)
        if _sha256(destination) != entry["sha256"]:
            raise RuntimeError(f"Restore stopped: {entry['path']} did not copy correctly.")
    counts, _version = _counts(target / DATABASE)
    if counts != manifest["counts"]:
        raise RuntimeError("Restore check failed: the record counts differ from the backup.")
    return manifest


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    command = args[0] if args else "run"
    if command == "run":
        folder = backup_suite()
        print(f"Backup written: {folder}" if folder else "No suite database yet; nothing to back up.")
    elif command == "list":
        for snapshot in _snapshots(backup_dir()):
            print(snapshot)
    elif command == "verify" and len(args) == 2:
        manifest = verify(args[1])
        print(f"OK: {sum(manifest['counts'].values())} records in {len(manifest['counts'])} tables, {len(manifest['files'])} files.")
    elif command == "restore" and len(args) == 3:
        restore(args[1], args[2])
        print(f"Restored into {args[2]}. Check it, then close NeraVeda and swap the folders to use it.")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
