import subprocess
import tempfile
import time
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import _paths  # noqa: F401

from vessel_report.core import NoDataError, SessionInterrupted

from cjc.config import CRITICAL_JOB_FILTERS
from cjc.models import JobPlan, reconcile
from cjc.store import FAILED, MISMATCH, NOT_FOUND, RUNNING, VERIFIED, Store
from cjc.worker import ExtractionWorker, RunRequest
from test_models import extraction, row


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name))

    def tearDown(self):
        self.folder.cleanup()

    def test_verified_run_round_trip(self):
        run_id = self.store.start_run("DHT IMPALA", date(2026, 10, 1), date(2026, 10, 31),
                                      CRITICAL_JOB_FILTERS.as_record())
        rows = [row(i, 3) for i in (3, 1, 2)]
        result = reconcile(extraction(rows), CRITICAL_JOB_FILTERS)
        status = self.store.finish_run(run_id, [JobPlan.from_portal(r) for r in rows], result)
        self.assertEqual(status, VERIFIED)
        run = self.store.run(run_id)
        self.assertEqual((run["displayed_count"], run["extracted_count"], run["reconciled"]), (3, 3, 1))
        self.assertIsNotNone(run["vessel_id"])
        self.assertEqual(run["filter_profile"]["selects"]["Critical to Safety"], "YES")
        self.assertEqual(run["review_start"], "2026-10-01")
        self.assertEqual([p["job_plan_id"] for p in self.store.plans(run_id)], ["1", "2", "3"])

    def test_mismatch_keeps_rows_as_evidence_but_not_verified(self):
        run_id = self.store.start_run("DHT IMPALA", date(2026, 10, 1), date(2026, 10, 31), {})
        rows = [row(1, 2), row(1, 2)]  # duplicate id
        result = reconcile(extraction(rows), CRITICAL_JOB_FILTERS)
        self.assertEqual(self.store.finish_run(run_id, [JobPlan.from_portal(r) for r in rows], result), MISMATCH)
        self.assertEqual(len(self.store.plans(run_id)), 1)
        self.assertEqual(self.store.run(run_id)["reconciled"], 0)

    def test_interrupted_runs_are_marked_failed(self):
        run_id = self.store.start_run("DHT IMPALA", date(2026, 10, 1), date(2026, 10, 31), {})
        self.assertEqual(self.store.run(run_id)["status"], RUNNING)
        Store(Path(self.folder.name)).mark_interrupted_runs()
        self.assertEqual(self.store.run(run_id)["status"], FAILED)


class FakeSession:
    def __init__(self, outcomes, on_state=None):
        self.outcomes = list(outcomes)
        self.resumed = 0
        self.closed = False

    def extract_population(self, vessel, profile, on_progress=None):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def resume(self, reopen=False):
        self.resumed += 1

    def show_sign_in(self):
        pass

    def pump(self):
        time.sleep(0.01)

    def close(self):
        self.closed = True


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name))
        self.events = []

    def tearDown(self):
        self.folder.cleanup()

    def run_worker(self, outcomes, on_pause=None):
        session = FakeSession(outcomes)
        worker = ExtractionWorker(lambda kind, **data: self.events.append((kind, data)), self.store,
                                  session_factory=lambda on_state: session)
        worker.submit(RunRequest("DHT IMPALA", date(2026, 10, 1), date(2026, 10, 31)))
        deadline = time.monotonic() + 10
        paused_handled = False
        while time.monotonic() < deadline and not any(k == "finished" for k, _ in self.events):
            if on_pause and not paused_handled and any(k == "paused" for k, _ in self.events):
                on_pause(worker)
                paused_handled = True
            time.sleep(0.02)
        worker.shutdown()
        worker.thread.join(5)
        self.assertTrue(session.closed)
        return session, next(d for k, d in self.events if k == "finished")

    def test_successful_run_is_verified_and_saved(self):
        _, finished = self.run_worker([extraction([row(1, 2), row(2, 2)])])
        self.assertEqual(finished["status"], VERIFIED)
        self.assertEqual(len(self.store.plans(finished["run_id"])), 2)

    def test_sign_in_pause_then_resume_retries_the_run(self):
        outcomes = [SessionInterrupted("auth", "Sign in"), extraction([row(1, 1)])]
        session, finished = self.run_worker(outcomes, on_pause=lambda worker: worker.resume())
        self.assertEqual(session.resumed, 1)
        self.assertEqual(finished["status"], VERIFIED)

    def test_cancel_while_paused_records_stopped_run(self):
        _, finished = self.run_worker([SessionInterrupted("browser", "Edge closed")],
                                      on_pause=lambda worker: worker.cancel())
        self.assertEqual(finished["status"], "Stopped")
        self.assertEqual(self.store.run(finished["run_id"])["status"], FAILED)

    def test_unknown_vessel_is_reported(self):
        _, finished = self.run_worker([NoDataError("Vessel 'DHT ORYX' was not found in the portal vessel list.")])
        self.assertEqual(finished["status"], NOT_FOUND)

    def test_review_period_must_be_ordered(self):
        with self.assertRaises(ValueError):
            RunRequest("DHT IMPALA", date(2026, 11, 1), date(2026, 10, 1))


class LauncherLinkTests(unittest.TestCase):
    def test_suite_launches_this_module_folder(self):
        from abhishek_automation_suite import PROJECT_ROOT, _project_python, start_critical_job_compliance
        with patch("abhishek_automation_suite.subprocess.Popen") as popen:
            process = start_critical_job_compliance()
        self.assertIs(process, popen.return_value)
        popen.assert_called_once_with(
            [_project_python(PROJECT_ROOT), str(PROJECT_ROOT / "Critical Jobs Compliance")],
            cwd=str(PROJECT_ROOT), creationflags=subprocess.CREATE_NO_WINDOW)

    def test_missing_module_is_reported(self):
        from abhishek_automation_suite import start_critical_job_compliance
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                start_critical_job_compliance(Path(folder))


if __name__ == "__main__":
    unittest.main()
