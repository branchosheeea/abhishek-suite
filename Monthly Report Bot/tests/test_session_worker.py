import time
import unittest
from datetime import datetime
from pathlib import Path

from vessel_report.core import BatchRequest, SessionInterrupted
from vessel_report.worker import SessionWorker


class FakeSession:
    launches = 0
    downloads = []

    def __init__(self, on_state=None):
        type(self).launches += 1
        self.on_state = on_state
        self.closed = False

    def download_report(self, vessel, report, frequency, start, end, **kwargs):
        type(self).downloads.append((vessel, report))
        return {"downloaded_files": [f"{vessel}-{report}.pdf"]}

    def pump(self):
        return None

    def close(self):
        self.closed = True


class PausingSession(FakeSession):
    pauses = 0

    def download_report(self, vessel, report, frequency, start, end, **kwargs):
        if type(self).pauses == 0:
            type(self).pauses += 1
            raise SessionInterrupted("auth", "sign in required")
        return super().download_report(vessel, report, frequency, start, end, **kwargs)

    def resume(self, reopen=False):
        return None

    def show_sign_in(self):
        return None


class WorkerTests(unittest.TestCase):
    def setUp(self):
        FakeSession.launches = 0
        FakeSession.downloads = []
        self.events = []
        self.worker = SessionWorker(lambda kind, **data: self.events.append((kind, data)), FakeSession)
        self.request = BatchRequest(("DHT LEOPARD", "DHT IMPALA"), "Monthly", ("one",),
            datetime(2026, 10, 1), datetime(2026, 10, 31), Path("output"))

    def tearDown(self):
        self.worker.shutdown()
        self.worker.thread and self.worker.thread.join(timeout=3)

    def wait_finished(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not any(kind == "finished" for kind, _ in self.events):
            time.sleep(0.01)
        self.assertTrue(any(kind == "finished" for kind, _ in self.events))

    def test_batches_and_retries_reuse_one_session(self):
        self.worker.submit(self.request)
        self.wait_finished()
        self.worker.submit(self.request)
        # The same worker thread handles a consecutive batch.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and sum(kind == "finished" for kind, _ in self.events) < 2:
            time.sleep(0.01)
        self.assertEqual(FakeSession.launches, 1)
        self.assertEqual(len(FakeSession.downloads), 4)

    def test_shutdown_closes_session_on_worker_thread(self):
        self.worker.submit(self.request)
        self.wait_finished()
        session = self.worker.session
        self.worker.shutdown()
        self.worker.thread.join(timeout=3)
        self.assertTrue(session.closed)
        self.assertTrue(self.worker.closed.is_set())

    def test_auth_pause_resumes_current_job(self):
        PausingSession.pauses = 0
        worker = SessionWorker(lambda kind, **data: self.events.append((kind, data)), PausingSession)
        worker.submit(self.request)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not any(kind == "paused" for kind, _ in self.events):
            time.sleep(0.01)
        self.assertTrue(any(kind == "paused" for kind, _ in self.events))
        worker.resume()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not any(kind == "finished" for kind, _ in self.events):
            time.sleep(0.01)
        self.assertTrue(any(kind == "resumed" for kind, _ in self.events))
        self.assertEqual([call for call in PausingSession.downloads if call[0] == "DHT LEOPARD"],
                         [("DHT LEOPARD", "one")])
        worker.shutdown()
        worker.thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
