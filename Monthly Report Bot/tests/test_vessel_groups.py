"""Suite-wide vessel groups and the suite core schema v2 migration."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from suite_services import database, vessel_groups
from suite_services.database import connection, initialize


class GroupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        initialize(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_create_and_list(self):
        group_id = vessel_groups.save_group(self.root, "  Suezmax   East ", ["DHT COLT", "DHT IMPALA"], "Trial")
        groups = vessel_groups.groups(self.root)
        self.assertEqual([(g["id"], g["name"], g["vessels"]) for g in groups],
                         [(group_id, "Suezmax East", ["DHT COLT", "DHT IMPALA"])])

    def test_needs_name_and_two_vessels(self):
        with self.assertRaises(ValueError):
            vessel_groups.save_group(self.root, "", ["DHT COLT", "DHT IMPALA"])
        with self.assertRaises(ValueError):
            vessel_groups.save_group(self.root, "Solo", ["DHT COLT"])

    def test_unknown_vessel_rejected(self):
        with self.assertRaises(ValueError):
            vessel_groups.save_group(self.root, "Ghost", ["DHT COLT", "NOT A SHIP"])

    def test_name_unique_ignoring_case(self):
        vessel_groups.save_group(self.root, "Eastern", ["DHT COLT", "DHT IMPALA"])
        with self.assertRaises(ValueError):
            vessel_groups.save_group(self.root, "EASTERN", ["DHT COLT", "DHT PUMA"])

    def test_vessel_may_be_in_several_groups(self):
        vessel_groups.save_group(self.root, "A", ["DHT COLT", "DHT IMPALA"])
        vessel_groups.save_group(self.root, "B", ["DHT COLT", "DHT PUMA"])
        self.assertEqual(sum("DHT COLT" in g["vessels"] for g in vessel_groups.groups(self.root)), 2)

    def test_edit_replaces_members_and_records_history(self):
        group_id = vessel_groups.save_group(self.root, "A", ["DHT COLT", "DHT IMPALA"])
        vessel_groups.save_group(self.root, "A renamed", ["DHT PUMA", "DHT OPAL", "DHT COLT"], group_id=group_id)
        group = vessel_groups.groups(self.root)[0]
        self.assertEqual(group["name"], "A renamed")
        self.assertEqual(group["vessels"], ["DHT COLT", "DHT OPAL", "DHT PUMA"])
        history = vessel_groups.group_history(self.root, group_id)
        self.assertEqual([h["action"] for h in history], ["created", "updated"])
        self.assertEqual(history[1]["detail"]["old"]["vessels"], ["DHT COLT", "DHT IMPALA"])

    def test_archive_keeps_history_and_frees_the_name(self):
        group_id = vessel_groups.save_group(self.root, "A", ["DHT COLT", "DHT IMPALA"])
        vessel_groups.archive_group(self.root, group_id)
        self.assertEqual(vessel_groups.groups(self.root), [])
        self.assertEqual([h["action"] for h in vessel_groups.group_history(self.root, group_id)], ["created", "archived"])
        vessel_groups.save_group(self.root, "A", ["DHT COLT", "DHT PUMA"])  # name reusable after archiving


class CoreMigrationTests(unittest.TestCase):
    def test_v1_database_gets_group_tables_and_a_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            db = sqlite3.connect(root / "suite.sqlite3")
            db.executescript(database.SCHEMA)
            db.execute("INSERT INTO schema_migrations VALUES(1)")
            db.execute("INSERT INTO report_files(sha256,filename,archive_path,imported_at) VALUES('x','a.xlsx','a','2026')")
            db.execute("""INSERT INTO monthly_reports(file_id,report_type,report_version,source_status,validation_status,payload)
                          VALUES(1,'LO',1,'ok','PASS','{}')""")
            db.commit()
            db.close()
            initialize(root)
            self.assertEqual(len(list((root / "backups").glob("suite-before-core-v2-*.sqlite3.bak"))), 1)
            with connection(root) as db:
                self.assertEqual(db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM monthly_reports").fetchone()[0], 1)
                db.execute("SELECT * FROM vessel_groups").fetchall()
            initialize(root)  # idempotent: no second backup
            self.assertEqual(len(list((root / "backups").glob("suite-before-core-v2-*.sqlite3.bak"))), 1)

    def test_newer_database_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            initialize(root)
            with connection(root) as db, db:
                db.execute("INSERT INTO schema_migrations VALUES(3)")
            with self.assertRaises(RuntimeError):
                initialize(root)


if __name__ == "__main__":
    unittest.main()
