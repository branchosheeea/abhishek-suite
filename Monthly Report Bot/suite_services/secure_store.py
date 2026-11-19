"""Small secrets and session files protected with Windows DPAPI for the current Windows user.

Same protection as the Outlook token cache (gc_manager/outlook.py): readable only by this Windows account on this
PC. It protects against other Windows users and copied files, not against the account owner.

Windows' crypt32 is called directly (ctypes), so no extra package is needed: the NeraVeda shortcut runs on the
installed Python, which may not have pywin32. The blobs are the same as win32crypt.CryptProtectData makes with the
same entropy, so files written either way can be read either way.
"""
from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from pathlib import Path

CRYPTPROTECT_UI_FORBIDDEN = 0x1


class SecureStoreError(RuntimeError):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


_API = None


def _api():
    global _API
    if os.name != "nt":
        raise SecureStoreError("Protected storage is available only on Windows.")
    if _API is None:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        protect_fn, unprotect_fn, free_fn = crypt32.CryptProtectData, crypt32.CryptUnprotectData, kernel32.LocalFree
        protect_fn.argtypes = [ctypes.POINTER(_Blob), wintypes.LPCWSTR, ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p,
                               wintypes.DWORD, ctypes.POINTER(_Blob)]
        unprotect_fn.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p,
                                 wintypes.DWORD, ctypes.POINTER(_Blob)]
        protect_fn.restype = unprotect_fn.restype = wintypes.BOOL
        free_fn.argtypes, free_fn.restype = [ctypes.c_void_p], ctypes.c_void_p
        _API = (protect_fn, unprotect_fn, free_fn)
    return _API


def _blob(data: bytes) -> tuple[_Blob, object]:
    """A DATA_BLOB over a copy of `data`; keep the returned buffer alive while the blob is used."""
    buffer = ctypes.create_string_buffer(data, max(len(data), 1))
    return _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def _call(fn, data: bytes, purpose: str, *description) -> bytes:
    protect_fn, unprotect_fn, free_fn = _api()
    source, _keep_source = _blob(data)
    entropy, _keep_entropy = _blob(purpose.encode("utf-8"))
    result = _Blob()
    function = protect_fn if fn == "protect" else unprotect_fn
    if not function(ctypes.byref(source), *(description or (None,)), ctypes.byref(entropy), None, None,
                    CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(result)):
        raise SecureStoreError(f"Windows could not {'protect' if fn == 'protect' else 'unlock'} the data ({purpose}); "
                               f"error {ctypes.get_last_error()}.")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        free_fn(ctypes.cast(result.pbData, ctypes.c_void_p))


def protect(data: bytes, purpose: str) -> bytes:
    return _call("protect", data, purpose, f"NeraVeda {purpose}")


def unprotect(blob: bytes, purpose: str) -> bytes:
    return _call("unprotect", blob, purpose)


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
