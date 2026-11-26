"""Outlook sync ownership (Phase 5): one sync at a time, true status, and a background runner for the web helper.

- `sync_lock(root)`: an operating-system file lock in the Suite data folder. The desktop GC Manager and the web
  helper both take it, so two syncs never run together. Windows releases it by itself if a program stops or
  crashes, so a stale lock cannot block syncing.
- `run_sync(...)`: the one way to sync. It records the attempt, the error or the finish time
  (Repository.sync_attempt / sync_finished), so the screens never show a success that did not happen.
- `SyncRunner`: lives in the web helper. Every `graph_sync_interval_minutes` (Settings, default 5) it syncs
  without any window open, unless a sync finished recently (for example in the desktop window). "Sync now" and
  the Microsoft sign-in can be started from the web page; the sign-in code is kept in memory only, never logged.

Graph access is unchanged: the same app registration, read-only Mail.Read, and the same encrypted token cache.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import threading
import time

LOCK_FILE = "gc_outlook_sync.lock"
SIGN_IN_NEEDED = "Microsoft sign-in needed"


class SyncBusy(RuntimeError):
    """Another program on this PC is syncing Outlook right now."""


@contextmanager
def sync_lock(root):
    path = Path(root) / LOCK_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise SyncBusy("An Outlook sync is already running on this PC.") from error
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def is_running(root):
    """True while some program holds the sync lock."""
    try:
        with sync_lock(root):
            return False
    except SyncBusy:
        return True


def token_path(repo):
    return Path(repo.root) / "credentials" / "gc_msal_cache.bin"


def make_adapter(repo):
    from .outlook import ReadOnlyGraphAdapter
    return ReadOnlyGraphAdapter(os.getenv("AZURE_CLIENT_ID"), os.getenv("AZURE_TENANT_ID"), token_path(repo))


def run_sync(repo, adapter=None, prompt=None, interactive=False):
    """Sync once under the lock. Records the attempt, then either the finish (with the count) or the error."""
    adapter = adapter or make_adapter(repo)
    with sync_lock(repo.root):
        repo.sync_attempt()
        try:
            result = adapter.sync(repo, prompt=prompt, interactive=interactive)
        except Exception as error:
            repo.sync_attempt(str(error) or error.__class__.__name__)
            raise
        repo.sync_finished(result)
        return result


def recently_synced(repo, minutes, now=None):
    """True when a sync (by any program) finished less than `minutes` ago."""
    last = repo.sync_summary().get("last_success_at")
    if not last:
        return False
    try:
        finished = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        return False
    now = now or datetime.now(timezone.utc)
    return (now - finished).total_seconds() < minutes * 60


class SyncRunner:
    """Background Outlook sync for the web helper (one per helper process)."""

    FIRST_DELAY = 30    # seconds after the helper starts, so the web server is up first
    TICK = 15           # how often the runner checks whether a sync is due

    def __init__(self, repo_factory, adapter_factory=None, automatic=True, clock=time.monotonic):
        self.repo_factory = repo_factory
        self.adapter_factory = adapter_factory or (lambda repo: make_adapter(repo))  # looked up at sync time
        self.automatic = automatic
        self.clock = clock
        self._lock = threading.Lock()
        self.running = False
        self.last_result = None
        self.busy_elsewhere = False
        self.sign_in = None        # {"user_code", "verification_uri", "expires_at", "state", "error"}; memory only
        self.next_at = clock() + self.FIRST_DELAY
        self._stop = threading.Event()
        self._thread = None

    # ---- background loop ----------------------------------------------------------------------------------------
    def start(self):
        if self.automatic and self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="gc-outlook-sync", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.wait(self.TICK):
            try:
                self.tick()
            except Exception:  # the loop must survive anything; the error is already recorded by run_sync
                pass

    def tick(self):
        """Start a sync when one is due. Skips quietly when Outlook is not set up, a sign-in is needed (only a person
        can do that), or a sync finished recently in another program."""
        if self.running or self.clock() < self.next_at:
            return False
        repo = self.repo_factory()
        settings = repo.settings()
        interval = max(1, int(settings.get("graph_sync_interval_minutes", 5)))
        self.next_at = self.clock() + interval * 60
        if not (settings.get("graph_enabled") and settings.get("graph_configured")):
            return False
        if (repo.sync_summary().get("last_error") or "").startswith(SIGN_IN_NEEDED):
            return False
        if recently_synced(repo, interval):
            return False
        self._run(repo)
        return True

    # ---- actions from the web page ------------------------------------------------------------------------------
    def trigger(self):
        """Sync now (in the background). Returns at once; the page follows the state."""
        repo = self.repo_factory()
        settings = repo.settings()
        if not (settings.get("graph_enabled") and settings.get("graph_configured")):
            return {"started": False, "reason": "Outlook is not set up on this PC."}
        with self._lock:
            if self.running:
                return {"started": False, "reason": "A sync is already running."}
            self.running = True
        threading.Thread(target=self._run, args=(repo, True), name="gc-outlook-sync-now", daemon=True).start()
        return {"started": True}

    def _run(self, repo, claimed=False):
        if not claimed:
            with self._lock:
                if self.running:
                    return
                self.running = True
        try:
            self.busy_elsewhere = False
            self.last_result = run_sync(repo, self.adapter_factory(repo), interactive=False)
        except SyncBusy:
            self.busy_elsewhere = True
        except Exception:
            pass  # recorded in the database by run_sync; shown as "sync failed" with the message
        finally:
            with self._lock:
                self.running = False

    def start_sign_in(self):
        """Begin a Microsoft device sign-in. The code is shown on the page; when the person completes it, a sync runs."""
        repo = self.repo_factory()
        settings = repo.settings()
        if not (settings.get("graph_enabled") and settings.get("graph_configured")):
            raise ValueError("Outlook is not set up on this PC.")
        current = self.sign_in
        if current and current["state"] == "WAITING" and current["expires_at"] > time.time():
            return self.public_sign_in()
        adapter = self.adapter_factory(repo)
        flow = adapter.begin_device_sign_in()
        self.sign_in = {"user_code": flow["user_code"], "verification_uri": flow.get("verification_uri") or "https://microsoft.com/devicelogin",
                        "expires_at": time.time() + int(flow.get("expires_in") or 900), "state": "WAITING", "error": None}

        def finish():
            try:
                adapter.finish_device_sign_in(flow)
                self.sign_in = {**self.sign_in, "state": "DONE", "user_code": None}
                repo.sync_attempt(None)  # clears "sign-in needed"
                self.trigger()
            except Exception as error:
                self.sign_in = {**self.sign_in, "state": "FAILED", "user_code": None, "error": str(error) or "Sign-in did not complete."}

        threading.Thread(target=finish, name="gc-outlook-sign-in", daemon=True).start()
        return self.public_sign_in()

    def public_sign_in(self):
        s = self.sign_in
        if not s:
            return None
        if s["state"] == "WAITING" and s["expires_at"] <= time.time():
            s = self.sign_in = {**s, "state": "EXPIRED", "user_code": None}
        return {"state": s["state"], "user_code": s["user_code"] if s["state"] == "WAITING" else None,
                "verification_uri": s["verification_uri"], "expires_in": max(0, int(s["expires_at"] - time.time())), "error": s["error"]}

    def state(self):
        repo = self.repo_factory()
        settings = repo.settings()
        summary = repo.sync_summary()
        error = summary.get("last_error")
        running_here = self.running
        return {
            "enabled": bool(settings.get("graph_enabled")), "configured": bool(settings.get("graph_configured")),
            "automatic": self.automatic, "interval_minutes": max(1, int(settings.get("graph_sync_interval_minutes", 5))),
            "running": running_here or is_running(repo.root), "running_here": running_here,
            "last_attempt_at": summary.get("last_attempt_at"), "last_success_at": summary.get("last_success_at"),
            "last_added": summary.get("last_added"), "last_error": error,
            "sign_in_needed": bool(error and error.startswith(SIGN_IN_NEEDED)),
            "next_in_seconds": max(0, int(self.next_at - self.clock())) if self.automatic else None,
            "sign_in": self.public_sign_in(),
        }
