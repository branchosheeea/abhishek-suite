"""Prepare the Suite database for the GC Manager code from before the web Command Centre (rollback, Phase 6).

The Command Centre added schema version 3 (two claim columns and three tables, all additive). Older code refuses a
database marked newer than itself ("requires a newer application version"), so going back needs one step: remove the
version-3 marker. The added columns and tables stay and older code ignores them; nothing else is changed or deleted.
Running the current code again puts the marker back.

    python -m gc_manager.rollback --yes [--data-root PATH]

A copy of the database is saved in backups/ first. Run it only with NeraVeda closed, and only when you have decided
to go back to the older code.
"""
from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import sqlite3
import sys

from suite_services.storage import runtime_root

OLD_SCHEMA = 2


def prepare(root=None):
    """Back up, then mark the GC schema as version 2. Returns the backup path."""
    root = Path(root) if root else runtime_root()
    database = root / "suite.sqlite3"
    if not database.is_file():
        raise FileNotFoundError(f"No Suite database at {database}.")
    backups = root / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    target = backups / f"suite-before-gc-rollback-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite3.bak"
    source = sqlite3.connect(database, timeout=15)
    try:
        copy = sqlite3.connect(target)
        try:
            source.backup(copy)
        finally:
            copy.close()
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("The database failed its integrity check; nothing was changed.")
        with source:
            source.execute("DELETE FROM gc_schema_migrations WHERE version > ?", (OLD_SCHEMA,))
    finally:
        source.close()
    return target


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare the database for the GC Manager code before the web Command Centre.")
    parser.add_argument("--data-root", type=Path, help="Suite data folder (default: the normal one)")
    parser.add_argument("--yes", action="store_true", help="confirm: NeraVeda is closed and you want to go back")
    args = parser.parse_args(argv)
    if not args.yes:
        print("Nothing changed. Close NeraVeda, then run again with --yes to prepare the database for the older code.")
        return 1
    backup = prepare(args.data_root)
    print(f"Done. Backup saved: {backup}. The older GC Manager code can open the database now.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
