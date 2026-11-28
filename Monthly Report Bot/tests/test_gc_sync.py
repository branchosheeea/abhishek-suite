"""Phase 5 tests: Outlook sync ownership (Master Specification v2, section 38 #34 one scheduler / one sync at a time,
#35 no fabricated success, #23 unsupported or failed sync never shows success; section 0.3 truthful sign-in state)."""
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from gc_manager import service
from gc_manager.repository import Repository
from gc_manager.sync import SIGN_IN_NEEDED, SyncBusy, SyncRunner, is_running, recently_synced, run_sync, sync_lock

GRAPH_ON = {"AZURE_CLIENT_ID": "c", "AZURE_TENANT_ID": "t", "GC_GRAPH_ENABLED": "true", "GC_LOCAL_USER_NAME": "tester"}


class FakeAdapter:
    def __init__(self, outcome=None, gate=None):
        self.outcome = outcome if outcome is not None else {"added": 2, "inbox": 5, "sentitems": 1}
        self.gate = gate
        self.calls = []

    def sync(self, repo, prompt=None, interactive=True):
        self.calls.append(interactive)
        if self.gate:
            self.gate.wait(5)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        patcher = patch.dict(os.environ, GRAPH_ON)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = Repository(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_34_only_one_sync_at_a_time(self):
        with sync_lock(self.repo.root):
            self.assertTrue(is_running(self.repo.root))
            with self.assertRaises(SyncBusy):
                run_sync(self.repo, FakeAdapter())
        self.assertFalse(is_running(self.repo.root))  # released afterwards
        self.assertEqual(run_sync(self.repo, FakeAdapter())["added"], 2)

    def test_lock_is_released_when_the_holder_process_dies(self):
        code = ("import sys,time; sys.path.insert(0, sys.argv[2]); from gc_manager.sync import sync_lock\n"
                "with sync_lock(sys.argv[1]):\n    print('locked', flush=True); time.sleep(60)")
        holder = subprocess.Popen([sys.executable, "-c", code, str(self.repo.root), str(Path(__file__).resolve().parents[1])], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            self.assertTrue(is_running(self.repo.root))
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()
        for _ in range(50):  # Windows releases a dead process's locks shortly after it exits
            if not is_running(self.repo.root):
                break
            time.sleep(0.1)
        self.assertFalse(is_running(self.repo.root))  # a crashed program cannot leave a stale lock

    def test_35_failure_never_shows_success(self):
        with self.assertRaises(RuntimeError):
            run_sync(self.repo, FakeAdapter(RuntimeError("Microsoft Graph returned HTTP 503")))
        summary = self.repo.sync_summary()
        self.assertIsNone(summary["last_success_at"])
        self.assertIn("HTTP 503", summary["last_error"])
        run_sync(self.repo, FakeAdapter())
        summary = self.repo.sync_summary()
        self.assertIsNotNone(summary["last_success_at"])
        self.assertIsNone(summary["last_error"])
        self.assertEqual(summary["last_added"], 2)

    def test_runner_syncs_in_the_background_without_a_window_and_never_signs_in_by_itself(self):
        clock = [0.0]
        adapter = FakeAdapter()
        runner = SyncRunner(lambda: self.repo, lambda repo: adapter, automatic=False, clock=lambda: clock[0])
        self.assertFalse(runner.tick())  # not due yet (first delay)
        clock[0] += SyncRunner.FIRST_DELAY
        self.assertTrue(runner.tick())
        self.assertEqual(adapter.calls, [False])  # interactive=False: an automatic sync never starts a sign-in
        clock[0] += 60
        self.assertFalse(runner.tick())  # the next one waits for the interval
        clock[0] += 5 * 60
        self.assertFalse(runner.tick())  # due, but a sync finished less than 5 minutes ago... (just now) -> skipped
        self.assertEqual(len(adapter.calls), 1)

    def test_runner_waits_for_a_person_when_sign_in_is_needed(self):
        self.repo.sync_attempt(f"{SIGN_IN_NEEDED}. Choose Sync Outlook Now.")
        adapter = FakeAdapter()
        runner = SyncRunner(lambda: self.repo, lambda repo: adapter, automatic=False, clock=lambda: 10**6)
        self.assertFalse(runner.tick())
        self.assertEqual(adapter.calls, [])
        self.assertTrue(runner.state()["sign_in_needed"])

    def test_runner_respects_a_recent_sync_by_the_desktop_window(self):
        run_sync(self.repo, FakeAdapter())
        self.assertTrue(recently_synced(self.repo, 5))
        later = datetime.now(timezone.utc) + timedelta(minutes=6)
        self.assertFalse(recently_synced(self.repo, 5, now=later))

    def test_sync_now_from_the_page_runs_once_and_reports_running(self):
        gate = threading.Event()
        adapter = FakeAdapter(gate=gate)
        runner = SyncRunner(lambda: self.repo, lambda repo: adapter, automatic=False)
        self.assertTrue(runner.trigger()["started"])
        self.assertEqual(runner.trigger(), {"started": False, "reason": "A sync is already running."})
        self.assertTrue(runner.state()["running"])
        gate.set()
        for _ in range(100):
            if not runner.running:
                break
            time.sleep(0.05)
        self.assertFalse(runner.state()["running"])
        self.assertIsNotNone(runner.state()["last_success_at"])

    def test_not_configured_is_said_plainly(self):
        with patch.dict(os.environ, {"GC_GRAPH_ENABLED": "false"}):
            runner = SyncRunner(lambda: self.repo, lambda repo: FakeAdapter(), automatic=False)
            self.assertEqual(runner.trigger(), {"started": False, "reason": "Outlook is not set up on this PC."})
            with self.assertRaisesRegex(ValueError, "not set up"):
                runner.start_sign_in()
            self.assertFalse(runner.state()["enabled"])

    def test_device_sign_in_code_is_shown_then_cleared(self):
        done = threading.Event()

        class Adapter(FakeAdapter):
            def begin_device_sign_in(self):
                return {"user_code": "ABCD-1234", "verification_uri": "https://microsoft.com/devicelogin", "expires_in": 900}

            def finish_device_sign_in(self, flow):
                done.wait(5)

        adapter = Adapter()
        runner = SyncRunner(lambda: self.repo, lambda repo: adapter, automatic=False)
        state = runner.start_sign_in()
        self.assertEqual((state["state"], state["user_code"]), ("WAITING", "ABCD-1234"))
        done.set()
        for _ in range(100):  # the sign-in finishes in the background, then a sync runs
            if runner.public_sign_in()["state"] == "DONE" and adapter.calls and not runner.running:
                break
            time.sleep(0.05)
        after = runner.public_sign_in()
        self.assertEqual((after["state"], after["user_code"]), ("DONE", None))  # the code is not kept once used
        self.assertIn(False, adapter.calls)  # a sync ran after the sign-in

    def test_helper_commands(self):
        ask = lambda cmd, **args: service.handle(self.repo, {"id": 1, "cmd": cmd, "args": args})
        state = ask("sync.state")["result"]
        self.assertEqual((state["enabled"], state["configured"], state["running"]), (True, True, False))
        self.assertIn("actor", ask("sync.run")["error"]["message"])
        with patch("gc_manager.sync.make_adapter", lambda repo: FakeAdapter()):
            self.assertTrue(ask("sync.run", actor="me@x.com")["result"]["started"])
            for _ in range(100):  # the sync runs in the background; let it finish before the folder is removed
                if not service._runner.running:
                    break
                time.sleep(0.05)
        self.assertIsNotNone(ask("sync.state")["result"]["last_success_at"])
        service._runner = None


class RollbackTests(unittest.TestCase):
    """Phase 6: going back to the code before the web Command Centre keeps every record."""

    def test_prepare_backs_up_and_marks_version_2_and_the_new_code_restores_it(self):
        import sqlite3
        from gc_manager import rollback
        from gc_manager.repository import SCHEMA_VERSION
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"GC_LOCAL_USER_NAME": "tester"}):
            repo = Repository(folder)
            vessel = next(v["id"] for v in repo.vessels() if v["name"] == "DHT IMPALA")
            claim = repo.create_claim(vessel, "GC-014")
            repo.update_claim(claim, waiting_on="SHIPYARD", next_action="Await report")
            self.assertEqual(rollback.main(["--data-root", folder]), 1)  # without --yes nothing happens
            backup = rollback.prepare(folder)
            self.assertTrue(backup.is_file())
            db = sqlite3.connect(Path(folder) / "suite.sqlite3")
            try:
                self.assertEqual(db.execute("SELECT MAX(version) FROM gc_schema_migrations").fetchone()[0], 2)
                self.assertEqual(db.execute("SELECT waiting_on, next_action FROM gc_claims").fetchall(), [("SHIPYARD", "Await report")])
            finally:
                db.close()
            Repository(folder)  # the current code again: marker back, data kept
            db = sqlite3.connect(Path(folder) / "suite.sqlite3")
            try:
                self.assertEqual(db.execute("SELECT MAX(version) FROM gc_schema_migrations").fetchone()[0], SCHEMA_VERSION)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
