"""Small secrets and session files protected with Windows DPAPI for the current Windows user.

Same protection as the Outlook token cache (gc_manager/outlook.py): readable only by this Windows account on this
PC. It protects against other Windows users and copied files, not against the account owner.
"""
from __future__ import annotations

import os
from pathlib import Path


class SecureStoreError(RuntimeError):
    pass


def _crypt():
    if os.name != "nt":
        raise SecureStoreError("Protected storage is available only on Windows.")
    try:
        import win32crypt
    except ImportError as error:  # pragma: no cover - pywin32 is a suite requirement
        raise SecureStoreError("pywin32 is required for protected storage.") from error
    return win32crypt


def protect(data: bytes, purpose: str) -> bytes:
    return _crypt().CryptProtectData(data, f"NeraVeda {purpose}", purpose.encode("utf-8"), None, None, 0)


def unprotect(blob: bytes, purpose: str) -> bytes:
    try:
        _description, clear = _crypt().CryptUnprotectData(blob, purpose.encode("utf-8"), None, None, 0)
    except SecureStoreError:
        raise
    except Exception as error:
        raise SecureStoreError(f"Could not unlock protected data ({purpose}).") from error
    return clear


def write_protected(path, data: bytes, purpose: str) -> None:
    """Atomically replace `path` with the DPAPI-protected data."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(protect(data, purpose))
    os.replace(temporary, path)


def read_protected(path, purpose: str) -> bytes | None:
    """The clear data, or None when the file is missing or cannot be unlocked by this Windows user."""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        return unprotect(path.read_bytes(), purpose)
    except (SecureStoreError, OSError):
        return None


def remove(path) -> None:
    Path(path).unlink(missing_ok=True)
