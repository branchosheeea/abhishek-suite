"""NeraVeda's own sign-in: an ID (the person's work email in the access list) and a password.

Stored per person in the access list, written only with an admin credential:
    users.password = {"verifier": {...}, "epoch": n, "temporary": bool, "set_at": iso, "set_by": email}
An admin sets a temporary password; the person must replace it at first sign-in.

The verifier holds no password. It is an Ed25519 public key whose private key is derived from the password with
scrypt (salted, memory-hard): checking a password = deriving the key again and comparing public keys.

People change their own password without an admin credential. A change is a record in `password_changes` (every PC
may only insert there) signed with the key derived from the OLD password. Any PC rebuilds the current password from
the admin-set one plus the chain of correctly signed changes. A record not signed by the current password's key is
ignored, so nobody can set another person's password, even with direct database access. An admin reset starts a new
epoch, which ends the old chain.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

ALG = "scrypt-ed25519"
#: scrypt cost for new passwords: 64 MB of memory and about 0.3 s per check on an office PC
COST = {"n": 2 ** 16, "r": 8, "p": 1}
MIN_LENGTH = 12
MAX_LENGTH = 256
MAX_CHAIN = 500
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"  # no 0/O, 1/l/I
_COMMON = {"password1234", "password12345", "passw0rd1234", "qwertyuiop12", "123456789012", "neraveda1234",
           "goodwood1234", "welcome12345", "changeme1234", "letmein12345", "abcdefghijkl", "qwertyuiopas"}


class PasswordError(ValueError):
    pass


def available() -> bool:
    try:
        _crypto()
        return True
    except PasswordError:
        return False


def _crypto():
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    except ImportError as error:
        raise PasswordError("Password sign-in needs the 'cryptography' package on this PC: "
                            "run  python -m pip install -r requirements.txt  with the Python NeraVeda uses.") from error
    return Ed25519PrivateKey, Ed25519PublicKey, InvalidSignature


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(str(text) + "=" * (-len(str(text)) % 4))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _normal(password: str) -> bytes:
    return unicodedata.normalize("NFKC", password or "").encode("utf-8")


def valid_verifier(verifier) -> bool:
    if not isinstance(verifier, dict) or verifier.get("alg") != ALG:
        return False
    try:
        n, r, p = int(verifier["n"]), int(verifier["r"]), int(verifier["p"])
        salt, pub = _unb64(verifier["salt"]), _unb64(verifier["pub"])
    except (KeyError, TypeError, ValueError):
        return False
    # Bounds keep a planted record from making every PC spend minutes or gigabytes on one check.
    return 2 ** 14 <= n <= 2 ** 18 and n & (n - 1) == 0 and 1 <= r <= 8 and 1 <= p <= 4 and 16 <= len(salt) <= 64 and len(pub) == 32


def _derive(password: str, verifier: dict):
    private_cls, _public_cls, _invalid = _crypto()
    n, r, p = int(verifier["n"]), int(verifier["r"]), int(verifier["p"])
    seed = hashlib.scrypt(_normal(password), salt=_unb64(verifier["salt"]), n=n, r=r, p=p, maxmem=256 * n * r + 2 ** 24, dklen=32)
    return private_cls.from_private_bytes(seed)


def _public(key) -> str:
    from cryptography.hazmat.primitives import serialization
    return _b64(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def new_verifier(password: str, cost: dict | None = None):
    """(verifier, private key) for a new password."""
    verifier = {"alg": ALG, **(cost or COST), "salt": _b64(secrets.token_bytes(16))}
    key = _derive(password, verifier)
    verifier["pub"] = _public(key)
    return verifier, key


def matches(password: str, verifier: dict):
    """The private key when the password is right, else None."""
    if not valid_verifier(verifier) or not password:
        return None
    key = _derive(password, verifier)
    return key if hmac.compare_digest(_public(key), verifier["pub"]) else None


def spend(password: str) -> None:
    """Take as long as a real check, so an unknown ID cannot be told from a known one by the response time."""
    n, r, p = COST["n"], COST["r"], COST["p"]
    hashlib.scrypt(_normal(password), salt=b"neraveda-no-such-id", n=n, r=r, p=p, maxmem=256 * n * r + 2 ** 24, dklen=32)


def problems(password: str, email: str = "") -> list[str]:
    """Why a new password is not accepted (empty when it is)."""
    text = password or ""
    found: list[str] = []
    if len(text) < MIN_LENGTH:
        found.append(f"Use at least {MIN_LENGTH} characters.")
    if len(text) > MAX_LENGTH:
        found.append(f"Use at most {MAX_LENGTH} characters.")
    if text and len(set(text)) < 5:
        found.append("Use more different characters.")
    local = (email or "").split("@")[0].lower()
    if len(local) >= 3 and local in text.lower():
        found.append("Do not include your ID in the password.")
    if text.lower() in _COMMON:
        found.append("This password is too common.")
    return found


def generate_temporary() -> str:
    """A random temporary password such as 'k7Qm-xR4t-9bWz-Hp3s' (about 90 bits)."""
    return "-".join("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(4))


def base_record(verifier: dict, *, temporary: bool, epoch: int, set_by: str) -> dict:
    """The users.password value an admin writes."""
    return {"verifier": verifier, "epoch": int(epoch), "temporary": bool(temporary), "set_at": _now(), "set_by": set_by}


def valid_record(record) -> bool:
    return isinstance(record, dict) and valid_verifier(record.get("verifier")) and isinstance(record.get("epoch", 0), int)


@dataclass(frozen=True)
class Current:
    """The password in force for a person after applying their own changes."""
    verifier: dict
    epoch: int
    seq: int
    temporary: bool

    @property
    def fingerprint(self) -> str:
        return f"{self.epoch}:{self.seq}:{self.verifier['pub']}"


def _payload(record: dict) -> bytes:
    fields = {k: record.get(k) for k in ("email", "epoch", "seq", "verifier", "prev", "at")}
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _signed_by(record: dict, public_b64: str) -> bool:
    _private_cls, public_cls, invalid = _crypto()
    try:
        public_cls.from_public_bytes(_unb64(public_b64)).verify(_unb64(record.get("sig", "")), _payload(record))
        return True
    except (invalid, ValueError, TypeError):
        return False


def change_record(email: str, current: Current, old_key, new_verifier_value: dict) -> dict:
    """A password change by the person, signed with the key from their current password."""
    record = {"email": email, "epoch": current.epoch, "seq": current.seq + 1, "verifier": new_verifier_value,
              "prev": current.verifier["pub"], "at": _now()}
    record["sig"] = _b64(old_key.sign(_payload(record)))
    return record


def resolve(email: str, record: dict | None, changes: Iterable[dict] = ()) -> Current | None:
    """The person's password now: the admin-set one, then each change signed by the password before it."""
    if not valid_record(record):
        return None
    current = Current(record["verifier"], int(record.get("epoch") or 0), 0, bool(record.get("temporary")))
    pool = [c for c in changes if isinstance(c, dict) and c.get("email") == email and c.get("epoch") == current.epoch]
    for _ in range(MAX_CHAIN):
        candidates = [c for c in pool
                      if c.get("seq") == current.seq + 1 and c.get("prev") == current.verifier["pub"]
                      and valid_verifier(c.get("verifier")) and _signed_by(c, current.verifier["pub"])]
        if not candidates:
            break
        chosen = min(candidates, key=lambda c: (str(c.get("at")), str(c.get("sig"))))  # same result on every PC
        current = Current(chosen["verifier"], current.epoch, current.seq + 1, False)
    return current


def state_label(current: Current | None) -> str:
    if current is None:
        return "not set"
    return "temporary" if current.temporary else "set"
