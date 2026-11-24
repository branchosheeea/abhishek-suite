"""Daily backup of the suite database (suite_services.backup, audit item P1-1). Temporary folders only."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from suite_services import backup
from suite_services.database import connection, initialize
from suite_services.storage import archive_file

DAY = datetime(2026, 11, 24, 8, 0, tzinfo=timezone.utc)


class SuiteBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root, self.dest = base / "data", base / "backups"
        initialize(self.root)
        workbook = base / "Lub oil DHT COLT.xlsx"
        workbook.write_bytes(b"workbook bytes")
        self.sha, _ = archive_file(workbook, self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_snapshot_is_consistent_checked_and_complete(self):
        folder = backup.backup_suite(self.root, self.dest, now=DAY)
        manifest = backup.verify(folder)
        self.assertEqual(folder.name, "2026-11-24T08-00-00")
        self.assertEqual(manifest["counts"]["vessels"], 24)
        self.assertEqual([f["sha256"] for f in manifest["files"]], [self.sha])
        self.assertFalse(list(self.dest.glob("*.partial")))

    def test_daily_backup_runs_once_a_day(self):
        self.assertIsNotNone(backup.daily_backup(self.root, self.dest, now=DAY))
        self.assertIsNone(backup.daily_backup(self.root, self.dest, now=DAY + timedelta(hours=3)))
        self.assertIsNotNone(backup.daily_backup(self.root, self.dest, now=DAY + timedelta(days=1)))

    def test_nothing_to_do_without_a_suite_database(self):
        self.assertIsNone(backup.backup_suite(Path(self.temp.name) / "empty", self.dest, now=DAY))

    def test_files_are_stored_once_and_old_snapshots_pruned(self):
        for day in range(5):
            backup.backup_suite(self.root, self.dest, keep=3, now=DAY + timedelta(days=day))
        snapshots = backup._snapshots(self.dest)
        self.assertEqual([s.name[:10] for s in snapshots], ["2026-11-26", "2026-11-27", "2026-11-28"])
        self.assertEqual(len([p for p in (self.dest / "files").rglob("*") if p.is_file()]), 1)

    def test_restore_goes_only_into_an_empty_folder_and_matches(self):
        with connection(self.root) as db:
            db.execute("INSERT INTO vessels(name) VALUES('DHT NEWBUILD')")
            db.commit()
        folder = backup.backup_suite(self.root, self.dest, now=DAY)
        with self.assertRaises(FileExistsError):
            backup.restore(folder, self.root)
        target = Path(self.temp.name) / "restored"
        backup.restore(folder, target)
        db = sqlite3.connect(target / "suite.sqlite3")
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM vessels").fetchone()[0], 25)
        finally:
            db.close()
        restored = next((target / "originals").rglob("*.xlsx"))
        self.assertEqual(hashlib.sha256(restored.read_bytes()).hexdigest(), self.sha)

    def test_damage_is_detected(self):
        folder = backup.backup_suite(self.root, self.dest, now=DAY)
        stored = next((self.dest / "files").rglob("*.xlsx"))
        stored.write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "damaged"):
            backup.verify(folder)

    def test_an_interrupted_backup_is_never_taken_as_a_good_one(self):
        (self.dest / "2026-11-23T08-00-00.partial").mkdir(parents=True)
        self.assertEqual(backup.latest_backup_day(self.dest), "")
        backup.backup_suite(self.root, self.dest, now=DAY)
        self.assertFalse(list(self.dest.glob("*.partial")), "leftovers are removed")
        manifest = json.loads((self.dest / "2026-11-24T08-00-00" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["kind"], "suite")


if __name__ == "__main__":
    unittest.main()
