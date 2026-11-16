from datetime import datetime
from pathlib import Path
from threading import Event, get_ident
from unittest import TestCase

from vessel_report.core import BatchRequest, SessionInterrupted
from vessel_report.worker import SessionWorker


class LostSession:
    def __init__(self, on_state=None):
        self.owner = get_ident()
        self.calls = []
        self.reopens = []
        self.ready = False
        self.closed_on = None

    def download_report(self, vessel, report, *args, **kwargs):
        self.calls.append((vessel, report))
        if not self.ready:
            raise SessionInterrupted("browser", "fixture browser loss")
        return {"downloaded_files": []}

    def resume(self, reopen=False):
        self.reopens.append(reopen)
        if not reopen:
            raise SessionInterrupted("browser", "explicit reopen required")
        self.ready = True

    def pump(self):
        pass

    def close(self):
        self.closed_on = get_ident()


class RecoveryTests(TestCase):
    def test_browser_loss_requires_reopen_and_resumes_current_job(self):
        self.exercise(stop=False)

    def test_stop_while_paused_does_not_fail_or_start_remaining_jobs(self):
        self.exercise(stop=True)

    def exercise(self, stop):
        paused, finished = Event(), Event()
        events = []
        def emit(kind, **data):
            events.append((kind, data))
            if kind == "paused":
                paused.set()
            if kind == "finished":
                finished.set()
        worker = SessionWorker(emit, LostSession)
        request = BatchRequest(("DHT TAIGA", "DHT TIGER"), "Monthly", ("one",),
                               datetime(2026, 1, 1), datetime(2026, 10, 31), Path("."))
        try:
            worker.submit(request)
            self.assertTrue(paused.wait(3))
            session = worker.session
            self.assertEqual(session.calls, [("DHT TAIGA", "one")])
            if stop:
                worker.stop()
            else:
                worker.resume(reopen=True)
            self.assertTrue(finished.wait(3))
            self.assertIs(worker.session, session)
            if stop:
                self.assertEqual(len(session.calls), 1)
                self.assertEqual(session.reopens, [])
            else:
                self.assertEqual(session.reopens, [True])
                self.assertEqual(session.calls, [("DHT TAIGA", "one"),
                                                ("DHT TAIGA", "one"), ("DHT TIGER", "one")])
            self.assertEqual([d for k, d in events if k == "finished"][-1]["failed"], 0)
        finally:
            worker.shutdown()
            worker.thread.join(3)
            self.assertFalse(worker.thread.is_alive())
            self.assertEqual(worker.session.closed_on, worker.session.owner)
