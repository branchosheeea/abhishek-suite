"""Entry check for every desktop workspace: require_module("<key>") at the top of its __main__.

A workspace opens only with a valid NeraVeda session that includes it. It never signs in itself: without a
session it offers to open NeraVeda and exits. In local mode (sign-in not set up, not required) it opens as before.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from suite_services import actor
from suite_services.access.config import load_config
from suite_services.access.entitlements import MODULE_TITLES
from suite_services.access.session import SIGNED_IN_MODES, SessionStore

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MB_OK, MB_YESNO, MB_ICONINFORMATION, IDYES = 0x0, 0x4, 0x40, 6


def _message_box(text: str, title: str, flags: int) -> int:
    try:
        import ctypes
        return ctypes.windll.user32.MessageBoxW(None, text, title, flags | MB_ICONINFORMATION)
    except Exception:  # no GUI available: the message goes to stderr
        print(f"{title}: {text}", file=sys.stderr)
        return 0


def _open_neraveda() -> None:
    python = Path(sys.executable)
    windowless = python.with_name("pythonw.exe")
    launcher = PROJECT_ROOT / "launch_app.pyw"
    subprocess.Popen([str(windowless if windowless.is_file() else python), str(launcher)], cwd=str(PROJECT_ROOT),
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def check_module(key: str, now: float | None = None) -> tuple[bool, str]:
    """(allowed, reason). Sets the audit actor when allowed."""
    config = load_config()
    if config.local_mode:
        actor.set_current(None)
        return True, "local mode"
    session = SessionStore().load()
    current = time.time() if now is None else now
    if session is None or session.mode not in SIGNED_IN_MODES or not session.valid(current):
        return False, "signed-out"
    if key not in session.modules:
        return False, "no-access"
    actor.set_current(session.email, session.name)
    return True, session.email


def require_module(key: str) -> None:
    allowed, reason = check_module(key)
    if allowed:
        return
    title = MODULE_TITLES.get(key, "NeraVeda")
    if reason == "no-access":
        _message_box(f"You do not have access to {title}.\n\nAsk your NeraVeda admin if you need it.", "NeraVeda", MB_OK)
    elif _message_box(f"Sign in to NeraVeda first: {title} opens from the NeraVeda home screen.\n\nOpen NeraVeda now?", "NeraVeda", MB_YESNO) == IDYES:
        _open_neraveda()
    raise SystemExit(2)
