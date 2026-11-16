"""One long-lived thread owns the Playwright session and every browser call."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from queue import Empty, Queue
from threading import Event, Lock, Thread

from vessel_report.core import NoDataError, SessionInterrupted

from . import config
from .config import FilterProfile
from .models import JobPlan, reconcile
from .store import NOT_FOUND, Store


@dataclass(frozen=True)
class RunRequest:
    vessel: str
    review_start: date
    review_end: date
    profile: FilterProfile = config.CRITICAL_JOB_FILTERS

    def __post_init__(self):
        if not self.vessel:
            raise ValueError("Select a vessel.")
        if self.review_start > self.review_end:
            raise ValueError("The review start must be on or before the review end.")


class ExtractionWorker:
    """Events (kind, data) are delivered through `emit`, from the worker thread."""

    def __init__(self, emit, store: Store, session_factory=None):
        self.emit = emit
        self.store = store
        self.session_factory = session_factory
        self.commands: Queue = Queue()
        self.shutdown_event = Event()
        self.cancel_event = Event()
        self.busy = Event()
        self.closed = Event()
        self._lock = Lock()
        self.thread = None
        self.session = None

    # â”€â”€ UI-thread API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def submit(self, request: RunRequest):
        with self._lock:
            if self.shutdown_event.is_set() or self.busy.is_set():
                raise RuntimeError("A run is already in progress.")
            self.busy.set()
            self.cancel_event.clear()
            self.commands.put(("run", request))
            if self.thread is None:
                self.thread = Thread(target=self._run, name="CJC-MariApps-session", daemon=False)
                self.thread.start()

    def resume(self, reopen=False):
        self.commands.put(("reopen" if reopen else "resume", None))

    def show_sign_in(self):
        self.commands.put(("sign_in", None))

    def cancel(self):
        """Abandon a paused run (a run in progress finishes its current portal step first)."""
        self.cancel_event.set()
        self.commands.put(("cancel", None))

    def shutdown(self):
        self.shutdown_event.set()
        self.cancel_event.set()
        self.commands.put(("shutdown", None))
        if self.thread is None:
            self.closed.set()
            self.emit("worker_closed")

    # â”€â”€ Worker thread â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def _session_state(self, **data):
        self.emit("session", **data)

    def _wait_for_recovery(self, error: SessionInterrupted) -> bool:
        reason, message = error.reason, str(error)
        self.emit("paused", reason=reason, message=message)
        while not self.cancel_event.is_set():
            try:
                command, _ = self.commands.get(timeout=0.1)
            except Empty:
                self.session.pump()
                continue
            if command in {"shutdown", "cancel"}:
                return False
            if command not in {"resume", "reopen", "sign_in"}:
                continue
            try:
                if command == "sign_in":
                    self.session.show_sign_in()
                    continue
                self.session.resume(reopen=command == "reopen")
                self.emit("resumed")
                return True
            except SessionInterrupted as interrupted:
                reason, message = interrupted.reason, str(interrupted)
            except Exception as failure:
                message = f"Could not restore the session: {failure}"
            self.emit("paused", reason=reason, message=message)
        return False

    def _execute(self, request: RunRequest) -> dict:
        """Run one extraction and return the data for the 'finished' event."""
        run_id = self.store.start_run(request.vessel, request.review_start, request.review_end,
                                      request.profile.as_record())
        self.emit("started", run_id=run_id, vessel=request.vessel)
        log = lambda message: self.emit("log", message=message)
        try:
            while True:
                try:
                    extraction = self.session.extract_population(request.vessel, request.profile, on_progress=log)
                    break
                except SessionInterrupted as error:
                    if not self._wait_for_recovery(error):
                        self.store.fail_run(run_id, f"Stopped while paused: {error}")
                        return dict(run_id=run_id, status="Stopped", message=str(error))
            self.emit("stage", stage="reconcile")
            reconciliation = reconcile(extraction, request.profile)
            plans = [JobPlan.from_portal(row) for row in extraction.rows]
            self.emit("stage", stage="save")
            status = self.store.finish_run(run_id, plans, reconciliation)
            for check in reconciliation.failures():
                log(f"Reconciliation check failed - {check.name}: {check.detail}")
            log(f"Run {run_id}: {status}. Displayed {reconciliation.displayed_count}, "
                f"extracted {reconciliation.extracted_count}.")
            return dict(run_id=run_id, status=status, message="")
        except NoDataError as missing:
            self.store.fail_run(run_id, str(missing), NOT_FOUND)
            return dict(run_id=run_id, status=NOT_FOUND, message=str(missing))
        except Exception as error:
            self.store.fail_run(run_id, str(error))
            return dict(run_id=run_id, status="Failed", message=str(error))

    def _run(self):
        try:
            if self.session_factory is None:
                from .portal import JobOverviewSession
                self.session_factory = JobOverviewSession
            self.session = self.session_factory(on_state=self._session_state)
            while not self.shutdown_event.is_set():
                try:
                    command, payload = self.commands.get(timeout=0.1)
                except Empty:
                    self.session.pump()
                    continue
                if command == "shutdown":
                    break
                if command == "run":
                    try:
                        result = self._execute(payload)
                    except Exception as error:  # e.g. the database could not record the run
                        result = dict(run_id=None, status="Failed", message=str(error))
                    finally:
                        self.busy.clear()
                    self.emit("finished", **result)
                # resume/sign-in/cancel while idle have nothing to act on.
        except Exception as error:
            self.emit("fatal", message=f"Browser worker stopped: {error}")
        finally:
            try:
                if self.session is not None:
                    self.session.close()
            except Exception as error:
                self.emit("session", state="error", message=f"Browser cleanup: {error}")
            self.busy.clear()
            self.closed.set()
            self.emit("worker_closed")
