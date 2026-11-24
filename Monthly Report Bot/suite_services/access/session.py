"""The signed-in session and the single access object the launcher uses.

Session file: <runtime_root>/access/session.bin (DPAPI). It is valid while
    now < signed_in_at + session_hours            (12 h, then a silent re-sign-in)
    now < verified_at  + offline_grace_hours      (72 h without reaching the access list)
and is re-checked against the access list every refresh_minutes (15) while the launcher runs.

Local mode (sign-in not set up and not required by policy.json): the Windows user with every workspace, exactly
as before sign-in existed. Web workspaces still get signed tickets in local mode.

Two ways to sign in, both checked against the same access list: a Microsoft work account (when IT's app registration
is entered on this PC) and a NeraVeda ID + password (passwords.py), for people the admin has given a password.
"""
from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from suite_services import actor, secure_store
from suite_services.access import passwords, tickets
from suite_services.access.config import AccessConfig, access_dir, credentials_dir, load_config, read_secret
from suite_services.access.entitlements import MODULES, Grant, UserAccess, normalise_email
from suite_services.access.store import DEFAULT_POLICY

WRONG_PASSWORD = "The NeraVeda ID or password is not correct."
#: After this many wrong passwords on this PC, wait before the next try (doubling up to MAX_LOCK_SECONDS).
FREE_ATTEMPTS, FIRST_LOCK_SECONDS, MAX_LOCK_SECONDS, ATTEMPT_WINDOW_SECONDS = 5, 60, 15 * 60, 30 * 60

SESSION_PURPOSE = "session"
WEB_KEYS = ("sir", "evi")
#: Workspaces served by each web server: its tickets carry the person's rights to all of them (Digital Docking
#: runs in the same web shell as the Inspection Reports, key "sir"). Each page and API route checks its own.
SERVER_MODULES = {"sir": ("sir", "dd"), "evi": ("evi",)}
#: Environment variables each web workspace may receive from the protected store (Phase 5).
DB_VARS = {
    "sir": ("MONGODB_URI", "SIR_DNS_SERVERS"),
    "evi": ("EMISSIONS_MONGODB_URI", "EMISSIONS_SOURCE_WRITE_URI", "EMISSIONS_SOURCE_READ_URI", "EMISSIONS_DB", "EMISSIONS_DNS_SERVERS"),
}
#: The variable through which a web server receives NeraVeda's DNS servers (access settings) when its own is not set.
DNS_VARS = {"sir": "SIR_DNS_SERVERS"}


class AccessError(RuntimeError):
    pass


class NotSetUp(AccessError):
    """Sign-in is required here but this PC has no sign-in settings."""


class AccessDenied(AccessError):
    def __init__(self, message: str, email: str | None = None):
        super().__init__(message)
        self.email = email


class SessionExpired(AccessError):
    pass


class PasswordChangeRequired(AccessError):
    """The password is right but temporary: the person must choose their own to finish signing in."""


class PasswordRejected(AccessError):
    """The new password does not meet the rules."""


class TooManyAttempts(AccessError):
    pass


SIGNED_IN_MODES = ("entra", "password")


@dataclass(frozen=True)
class Session:
    email: str
    name: str
    oid: str | None
    admin: bool
    modules: tuple[str, ...]
    mode: str  # "entra" (Microsoft) | "password" (NeraVeda ID and password) | "local"
    signed_in_at: float
    verified_at: float
    session_hours: float = DEFAULT_POLICY["session_hours"]
    grace_hours: float = DEFAULT_POLICY["offline_grace_hours"]
    refresh_minutes: float = DEFAULT_POLICY["refresh_minutes"]
    extra: dict = field(default_factory=dict, compare=False)
    #: password sessions: which password signed in (passwords.Current.fingerprint); a reset or change ends the session
    credential: str = ""

    @property
    def expires_at(self) -> float:
        return min(self.signed_in_at + self.session_hours * 3600, self.verified_at + self.grace_hours * 3600)

    def valid(self, now: float) -> bool:
        return self.mode == "local" or (bool(self.email) and now < self.expires_at)

    def to_json(self) -> bytes:
        data = asdict(self)
        data["modules"] = list(self.modules)
        return json.dumps(data).encode("utf-8")

    @staticmethod
    def from_json(raw: bytes) -> "Session | None":
        try:
            d = json.loads(raw.decode("utf-8"))
            return Session(
                email=str(d["email"]), name=str(d.get("name") or ""), oid=d.get("oid"), admin=bool(d.get("admin")),
                modules=tuple(m for m in d.get("modules") or [] if m in MODULES), mode=str(d.get("mode") or "entra"),
                signed_in_at=float(d["signed_in_at"]), verified_at=float(d["verified_at"]),
                session_hours=float(d.get("session_hours") or DEFAULT_POLICY["session_hours"]),
                grace_hours=float(d.get("grace_hours") or DEFAULT_POLICY["offline_grace_hours"]),
                refresh_minutes=float(d.get("refresh_minutes") or DEFAULT_POLICY["refresh_minutes"]),
                credential=str(d.get("credential") or ""),
            )
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            return None


class SessionStore:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else access_dir() / "session.bin"

    def load(self) -> Session | None:
        raw = secure_store.read_protected(self.path, SESSION_PURPOSE)
        return Session.from_json(raw) if raw else None

    def save(self, session: Session) -> None:
        secure_store.write_protected(self.path, session.to_json(), SESSION_PURPOSE)

    def clear(self) -> None:
        secure_store.remove(self.path)


class AccessService:
    """Everything the launcher needs about who is signed in and what they may open."""

    def __init__(self, config: AccessConfig | None = None, *, signin=None, store_factory=None, sessions: SessionStore | None = None, clock=time.time):
        self.config = config or load_config()
        self.sessions = sessions or SessionStore()
        self.clock = clock
        self._signin = signin
        self._store_factory = store_factory
        self.session: Session | None = None
        self.last_error: str | None = None
        self._failures: list[float] = []

    @classmethod
    def from_config(cls) -> "AccessService":
        return cls(load_config())

    # ── mode and state ──
    @property
    def local_mode(self) -> bool:
        return self.config.local_mode

    @property
    def needs_setup(self) -> bool:
        return not self.config.configured and not self.config.local_mode

    @property
    def signed_in(self) -> bool:
        return self.session is not None and self.session.valid(self.clock())

    @property
    def offline(self) -> bool:
        return self.last_error is not None and self.session is not None and self.session.mode in SIGNED_IN_MODES

    @property
    def signin_methods(self) -> dict[str, bool]:
        """Which sign-in methods this PC offers."""
        return {"microsoft": self.config.microsoft, "password": self.config.configured}

    @property
    def password_user(self) -> bool:
        """Signed in with a NeraVeda password (so "Change password" applies)."""
        return self.signed_in and self.session.mode == "password"

    @property
    def user_label(self) -> str:
        if self.session is None:
            return ""
        return self.session.name or self.session.email

    def _local_session(self) -> Session:
        now = self.clock()
        user = actor.windows_user()
        return Session(email=user, name=user, oid=None, admin=False, modules=MODULES, mode="local", signed_in_at=now, verified_at=now)

    def cached(self) -> Session | None:
        """A usable session without any network call, or None (then the sign-in panel is shown)."""
        if self.local_mode:
            self.session = self._local_session()
            actor.set_current(None)
            return self.session
        if self.needs_setup:
            return None
        stored = self.sessions.load()
        if stored is not None and stored.mode in SIGNED_IN_MODES and stored.valid(self.clock()):
            self.session = stored
            actor.set_current(stored.email, stored.name)
            return stored
        return None

    # ── sign-in ──
    def _sign(self):
        if self._signin is None:
            from suite_services.access.signin import EntraSignIn
            self._signin = EntraSignIn(self.config)
        return self._signin

    def _reader(self):
        if self._store_factory is not None:
            return self._store_factory(self.config.reader_uri)
        from suite_services.access.store import AccessStore
        return AccessStore(self.config.reader_uri, self.config.db_name, self.config.dns_servers)

    def _require_setup(self, microsoft: bool = False) -> None:
        if self.needs_setup or not self.config.configured:
            raise NotSetUp("Sign-in is required, but this PC has no sign-in settings. Ask your admin to run the NeraVeda setup.")
        if microsoft and not self.config.microsoft:
            raise NotSetUp("Microsoft sign-in is not set up on this PC. Sign in with your NeraVeda ID and password.")

    def try_silent(self) -> Session | None:
        if self.needs_setup:
            raise NotSetUp("Sign-in is required, but this PC has no sign-in settings. Ask your admin to run the NeraVeda setup.")
        if not self.config.microsoft:
            return None  # nothing to try without Microsoft sign-in: the person types ID and password
        identity = self._sign().silent()
        return self._establish(identity) if identity else None

    def sign_in(self, parent_window_handle: int | None = None) -> Session:
        self._require_setup(microsoft=True)
        return self._establish(self._sign().interactive(parent_window_handle))

    def sign_in_with_code(self, on_code) -> Session:
        self._require_setup(microsoft=True)
        return self._establish(self._sign().device_code(on_code))

    def _person(self, store, email: str, oid: str | None) -> UserAccess:
        person = store.get_user(email)
        if person is None:
            raise AccessDenied(f"{email} is not registered in NeraVeda. Ask an admin to add this exact sign-in name.", email)
        if not person.active:
            raise AccessDenied(f"{email} has been deactivated in NeraVeda. Ask an admin if this is a mistake.", email)
        if person.oid and oid and person.oid != oid:
            raise AccessDenied("This Microsoft account does not match the account registered for this sign-in name. Ask an admin.", email)
        return person

    def _establish(self, identity) -> Session:
        store = self._reader()
        person = self._person(store, identity.email, identity.oid)
        return self._start(store, person, "entra", identity.oid, identity.name)

    def _start(self, store, person: UserAccess, mode: str, oid: str | None, name: str, credential: str = "") -> Session:
        policy = store.policy()
        now = self.clock()
        session = Session(
            email=person.email, name=person.name or name, oid=oid, admin=person.admin, modules=person.modules,
            mode=mode, signed_in_at=now, verified_at=now,
            session_hours=float(policy.get("session_hours", DEFAULT_POLICY["session_hours"])),
            grace_hours=float(policy.get("offline_grace_hours", DEFAULT_POLICY["offline_grace_hours"])),
            refresh_minutes=float(policy.get("refresh_minutes", DEFAULT_POLICY["refresh_minutes"])),
            credential=credential,
        )
        self.sessions.save(session)
        self.session = session
        self.last_error = None
        actor.set_current(session.email, session.name)
        return session

    # ── NeraVeda ID and password ──
    def _check_attempts(self) -> None:
        now = self.clock()
        self._failures = [t for t in self._failures if now - t < ATTEMPT_WINDOW_SECONDS]
        extra = len(self._failures) - FREE_ATTEMPTS
        if extra >= 0:
            wait = min(MAX_LOCK_SECONDS, FIRST_LOCK_SECONDS * 2 ** extra) - (now - self._failures[-1])
            if wait > 0:
                raise TooManyAttempts(f"Too many wrong passwords on this PC. Try again in {math.ceil(wait)} seconds.")

    def _current_password(self, store, person: UserAccess | None):
        if person is None or not person.password:
            return None
        return passwords.resolve(person.email, person.password, store.password_changes(person.email))

    def _record_change(self, store, email: str, current, key, new_password: str):
        """Write the person's own change (signed with the old password) and return the password now in force."""
        found = passwords.problems(new_password, email)
        if passwords.matches(new_password, current.verifier) is not None:
            found.append("Choose a password different from the current one.")
        if found:
            raise PasswordRejected(" ".join(found))
        verifier, _key = passwords.new_verifier(new_password)
        store.add_password_change(passwords.change_record(email, current, key, verifier))
        now_current = passwords.resolve(email, store.get_user(email).password, store.password_changes(email))
        if now_current is None or now_current.verifier.get("pub") != verifier["pub"]:
            raise AccessError("Your password was changed at the same moment on another PC. Sign in again with the newest password.")
        return now_current

    def sign_in_with_password(self, email: str, password: str, new_password: str | None = None) -> Session:
        """Sign in with the NeraVeda ID (work email) and password. A temporary password needs `new_password`."""
        self._require_setup()
        self._check_attempts()
        try:
            email = normalise_email(email)
        except ValueError:
            self._failures.append(self.clock())
            raise AccessDenied(WRONG_PASSWORD) from None
        store = self._reader()
        person = store.get_user(email)
        current = self._current_password(store, person)
        if current is None:
            passwords.spend(password)  # same time as a real check
        key = passwords.matches(password, current.verifier) if current is not None else None
        if key is None:  # the same answer, after the same time, for an unknown ID, no password and a wrong password
            self._failures.append(self.clock())
            raise AccessDenied(WRONG_PASSWORD)
        self._failures.clear()
        if not person.active:
            raise AccessDenied(f"{email} has been deactivated in NeraVeda. Ask an admin if this is a mistake.", email)
        if current.temporary and not new_password:
            raise PasswordChangeRequired("This is a temporary password. Choose your own password to finish signing in.")
        if new_password:
            current = self._record_change(store, email, current, key, new_password)
        return self._start(store, person, "password", None, person.name or email, current.fingerprint)

    def change_password(self, old_password: str, new_password: str) -> None:
        if not self.password_user:
            raise AccessError("Change password applies to NeraVeda passwords. Microsoft passwords are changed with Microsoft.")
        store = self._reader()
        person = store.get_user(self.session.email)
        current = self._current_password(store, person)
        key = passwords.matches(old_password, current.verifier) if current is not None else None
        if key is None:
            raise AccessDenied("Your current password is not correct.")
        current = self._record_change(store, person.email, current, key, new_password)
        self.session = replace(self.session, credential=current.fingerprint, verified_at=self.clock())
        self.sessions.save(self.session)

    def refresh(self) -> Session | None:
        """Re-read this person's rights. Offline: keep the session until the grace period ends."""
        if self.session is None or self.session.mode == "local":
            return self.session
        try:
            store = self._reader()
            person = self._person(store, self.session.email, self.session.oid)
            if self.session.mode == "password":
                current = self._current_password(store, person)
                if current is None:
                    raise AccessDenied(f"Password sign-in has been removed for {person.email}. Ask your admin.", person.email)
                if current.fingerprint != self.session.credential:
                    raise SessionExpired("Your NeraVeda password was changed or reset. Sign in again.")
        except (AccessDenied, SessionExpired):
            self.sessions.clear()
            self.session = None
            actor.set_current(None)
            raise
        except Exception as error:  # network or database: keep working offline within the grace period
            self.last_error = str(error)
            if not self.session.valid(self.clock()):
                self.sessions.clear()
                self.session = None
                raise SessionExpired("NeraVeda could not check your access for too long. Sign in again when online.") from error
            return self.session
        self.session = replace(self.session, admin=person.admin, modules=person.modules, name=person.name or self.session.name, verified_at=self.clock())
        self.sessions.save(self.session)
        self.last_error = None
        return self.session

    def sign_out(self) -> None:
        try:
            if self.session is not None and self.session.mode == "entra" and self.config.microsoft:
                self._sign().sign_out()
        finally:
            self.sessions.clear()
            self.session = None
            actor.set_current(None)

    # ── rights ──
    def allows(self, key: str) -> bool:
        return self.signed_in and key in self.session.modules

    @property
    def is_admin(self) -> bool:
        return self.signed_in and self.session.mode in SIGNED_IN_MODES and self.session.admin

    @property
    def can_administer(self) -> bool:
        return self.is_admin and bool(self.config.admin_uri)

    def admin_store(self):
        if not self.can_administer:
            raise AccessDenied("This PC is not set up for administration.")
        if self._store_factory is not None:
            return self._store_factory(self.config.admin_uri)
        from suite_services.access.store import AccessStore
        return AccessStore(self.config.admin_uri, self.config.db_name, self.config.dns_servers)

    def acting_as(self) -> dict:
        s = self.session
        return {"email": s.email if s else actor.windows_user(), "oid": s.oid if s else None, "name": s.name if s else None}

    # ── web workspaces ──
    def _secret_path(self, key: str) -> Path:
        if key not in WEB_KEYS:
            raise ValueError(key)
        return credentials_dir() / f"web_{key}.bin"

    def web_secret(self, key: str, rotate: bool = False) -> str:
        """Per-server-run secret shared with that web server (rotated whenever the launcher starts it)."""
        path = self._secret_path(key)
        if not rotate:
            current = secure_store.read_protected(path, f"web {key}")
            if current:
                return current.decode("ascii")
        secret = tickets.new_secret()
        secure_store.write_protected(path, secret.encode("ascii"), f"web {key}")
        return secret

    def _mint(self, key: str, typ: str, ttl: int) -> str:
        if not self.signed_in:
            raise SessionExpired("Sign in to NeraVeda first.")
        s = self.session
        return tickets.mint(self.web_secret(key), typ, key, s.email, name=s.name, adm=s.admin and s.mode in SIGNED_IN_MODES,
                            grants=[Grant(m).to_document() for m in SERVER_MODULES[key] if m in s.modules], ttl=ttl, now=self.clock())

    def web_entry_url(self, key: str, port: int, path: str) -> str:
        path = path if path.startswith("/") else f"/{path}"
        query = urllib.parse.urlencode({"t": self._mint(key, "enter", 120), "next": path})
        return f"http://localhost:{port}/api/auth/enter?{query}"

    def service_headers(self, key: str) -> dict[str, str]:
        return {"x-neraveda-service": self._mint(key, "service", 60)}

    def _call(self, key: str, port: int, path: str, method: str = "GET") -> int | None:
        request = urllib.request.Request(f"http://localhost:{port}{path}", method=method, data=b"{}" if method == "POST" else None,
                                         headers={**self.service_headers(key), "x-neraveda-request": "1", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except (urllib.error.URLError, OSError):
            return None

    def server_accepts(self, key: str, port: int) -> bool:
        """Whether the running server was started with this launcher's current secret."""
        return self._call(key, port, "/api/auth/session") == 200

    def revoke_web(self, key: str, port: int) -> None:
        if self.signed_in:
            self._call(key, port, "/api/auth/revoke", "POST")

    def db_env(self, key: str) -> dict[str, str]:
        """Database settings for a web workspace from the protected store, only for people with that workspace.
        The Inspection Reports server also gets NeraVeda's DNS servers for MongoDB SRV lookups (the office resolver
        does not answer them) unless its own setting says otherwise."""
        if key not in DB_VARS or not self.allows(key):
            return {}
        raw = read_secret(f"db_{key}")
        try:
            values = json.loads(raw) if raw else {}
        except ValueError:
            values = {}
        env = {k: str(v) for k, v in values.items() if k in DB_VARS[key] and v} if isinstance(values, dict) else {}
        dns_var = DNS_VARS.get(key)
        if dns_var and dns_var not in env and self.config.dns_servers:
            env[dns_var] = ",".join(self.config.dns_servers)
        return env
