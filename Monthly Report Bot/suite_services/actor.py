"""Who is acting, for audit records: the person signed in to NeraVeda, else the Windows user.

Light on purpose (no MSAL or MongoDB imports) so every workspace can use it.
"""
from __future__ import annotations

import getpass

_current: dict[str, str | None] = {"email": None, "name": None}


def set_current(email: str | None, name: str | None = None) -> None:
    _current["email"] = (email or "").strip().lower() or None
    _current["name"] = (name or "").strip() or None


def windows_user() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def current_actor() -> str:
    """The signed-in email, or the Windows user when nobody is signed in (local mode, tests)."""
    return _current["email"] or windows_user()


def current_name() -> str | None:
    return _current["name"]


def signed_in() -> bool:
    return _current["email"] is not None
