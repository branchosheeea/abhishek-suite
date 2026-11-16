"""One long-lived thread owns the Playwright session and all browser calls."""
from queue import Queue, Empty
from threading import Event, Lock, Thread

from .core import SessionInterrupted, run_batch


class SessionWorker:
    def __init__(self, emit, session_factory=None):
        self.emit = emit
        self.session_factory = session_factory
        self.commands = Queue()
        self.stop_event = Event()
        self.shutdown_event = Event()
        self.busy = Event()
        self.closed = Event()
        self._lock = Lock()
        self.thread = None
        self.session = None

    def submit(self, request):
        with self._lock:
            if self.shutdown_event.is_set() or self.busy.is_set():
                raise RuntimeError("The browser worker is busy or closing.")
            self.busy.set()
            self.stop_event.clear()
            self.commands.put(("batch", request))
            if self.thread is None:
                self.thread = Thread(target=self._run, name="MariApps-session", daemon=False)
                self.thread.start()

    def stop(self):
        self.stop_event.set()

    def resume(self, reopen=False):
        self.commands.put(("reopen" if reopen else "resume", None))

    def show_sign_in(self):
        self.commands.put(("sign_in", None))

    def shutdown(self):
        self.shutdown_event.set()
        self.stop_event.set()
        self.commands.put(("shutdown", None))
        if self.thread is None:
            self.closed.set()
            self.emit("worker_closed")

    def _session_state(self, **data):
        self.emit("session", **data)

    def _batch_event(self, kind, **data):
        if kind == "finished":
            self.busy.clear()
        self.emit(kind, **data)

    def _recover(self, error, job, receipts, completed, files):
        reason, message = error.reason, str(error)
        self.emit("paused", reason=reason, message=message, vessel=job.vessel,
                  report=job.report, completed=completed, files=files)
        while not self.stop_event.is_set() and not self.shutdown_event.is_set():
            try:
                command, _payload = self.commands.get(timeout=0.1)
            except Empty:
                self.session.pump()
                continue
            if command == "shutdown":
                return False
            if command not in {"resume", "reopen", "sign_in"}:
                continue
            try:
                if command == "sign_in":
                    self.session.show_sign_in()
                    continue
                self.session.resume(reopen=command == "reopen")
                self.emit("resumed", vessel=job.vessel, report=job.report)
                return True
            except SessionInterrupted as interrupted:
                reason, message = interrupted.reason, str(interrupted)
            except Exception as failure:
                message = f"Could not restore the session: {failure}"
            self.emit("paused", reason=reason, message=message, vessel=job.vessel,
                      report=job.report, completed=completed, files=files)
        return False

    def _run(self):
        try:
            if self.session_factory is None:
                from .downloader import ReportSession
                self.session_factory = ReportSession
            self.session = self.session_factory(on_state=self._session_state)
            while not self.shutdown_event.is_set():
                try:
                    command, payload = self.commands.get(timeout=0.1)
                except Empty:
                    self.session.pump()
                    continue
                if command == "shutdown":
                    break
                if command == "batch":
                    run_batch(payload, self._batch_event, self.stop_event,
                              downloader=self.session.download_report, recover=self._recover)
                # Commands from an already-finished pause have no effect when idle.
        except Exception as error:
            self.emit("fatal", message=f"Browser worker stopped: {error}")
            if self.busy.is_set():
                self._batch_event("finished", stopped=True, completed=0, files=0, failed=0)
        finally:
            try:
                if self.session is not None:
                    self.session.close()
            except Exception as error:
                self.emit("session", state="error", message=f"Browser cleanup: {error}")
            self.busy.clear()
            self.closed.set()
            self.emit("worker_closed")
