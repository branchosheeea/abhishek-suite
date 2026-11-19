"""The signed-in session and the single access object the launcher uses.

Session file: <runtime_root>/access/session.bin (DPAPI). It is valid while
    now < signed_in_at + session_hours            (12 h, then a silent re-sign-in)
    now < verified_at  + offline_grace_hours      (72 h without reaching the access list)
and is re-checked against the access list every refresh_minutes (15) while the launcher runs.

Local mode (sign-in not set up and not required by policy.json): the Windows user with every workspace, exactly
as before sign-in existed. Web workspaces still get signed tickets in local mode.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from suite_services import actor, secure_store
from suite_services.access import tickets
from suite_services.access.config import AccessConfig, access_dir, credentials_dir, load_config, read_secret
from suite_services.access.entitlements import MODULES, Grant, UserAccess
from suite_services.access.store import DEFAULT_POLICY

SESSION_PURPOSE = "session"
WEB_KEYS = ("sir", "evi")
#: Environment variables each web workspace may receive from the protected store (Phase 5).
DB_VARS = {
    "sir": ("MONGODB_URI",),
    "evi": ("EMISSIONS_MONGODB_URI", "EMISSIONS_SOURCE_WRITE_URI", "EMISSIONS_SOURCE_READ_URI", "EMISSIONS_DB", "EMISSIONS_DNS_SERVERS"),
}


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


@dataclass(frozen=True)
class Session:
    email: str
    name: str
    oid: str | None
    admin: bool
    modules: tuple[str, ...]
    mode: str  # "entra" | "local"
    signed_in_at: float
    verified_at: float
    session_hours: float = DEFAULT_POLICY["session_hours"]
    grace_hours: float = DEFAULT_POLICY["offline_grace_hours"]
    refresh_minutes: float = DEFAULT_POLICY["refresh_minutes"]
    extra: dict = field(default_factory=dict, compare=False)

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
        return self.last_error is not None and self.session is not None and self.session.mode == "entra"

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
        if stored is not None and stored.mode == "entra" and stored.valid(self.clock()):
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

    def try_silent(self) -> Session | None:
        if self.needs_setup:
            raise NotSetUp("Sign-in is required, but this PC has no sign-in settings. Ask your admin to run the NeraVeda setup.")
        identity = self._sign().silent()
        return self._establish(identity) if identity else None

    def sign_in(self, parent_window_handle: int | None = None) -> Session:
        if self.needs_setup:
            raise NotSetUp("Sign-in is required, but this PC has no sign-in settings. Ask your admin to run the NeraVeda setup.")
        return self._establish(self._sign().interactive(parent_window_handle))

    def sign_in_with_code(self, on_code) -> Session:
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
        policy = store.policy()
        now = self.clock()
        session = Session(
            email=person.email, name=person.name or identity.name, oid=identity.oid, admin=person.admin, modules=person.modules,
            mode="entra", signed_in_at=now, verified_at=now,
            session_hours=float(policy.get("session_hours", DEFAULT_POLICY["session_hours"])),
            grace_hours=float(policy.get("offline_grace_hours", DEFAULT_POLICY["offline_grace_hours"])),
            refresh_minutes=float(policy.get("refresh_minutes", DEFAULT_POLICY["refresh_minutes"])),
        )
        self.sessions.save(session)
        self.session = session
        self.last_error = None
        actor.set_current(session.email, session.name)
        return session

    def refresh(self) -> Session | None:
        """Re-read this person's rights. Offline: keep the session until the grace period ends."""
        if self.session is None or self.session.mode == "local":
            return self.session
        try:
            person = self._person(self._reader(), self.session.email, self.session.oid)
        except AccessDenied:
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
            if not self.local_mode and self.config.configured:
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
        return self.signed_in and self.session.mode == "entra" and self.session.admin

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
        return tickets.mint(self.web_secret(key), typ, key, s.email, name=s.name, adm=s.admin and s.mode == "entra",
                            grants=[Grant(key).to_document()] if key in s.modules else [], ttl=ttl, now=self.clock())

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
        """Database settings for a web workspace from the protected store, only for people with that workspace."""
        if key not in DB_VARS or not self.allows(key):
            return {}
        raw = read_secret(f"db_{key}")
        if not raw:
            return {}
        try:
            values = json.loads(raw)
        except ValueError:
            return {}
        return {k: str(v) for k, v in values.items() if k in DB_VARS[key] and v}
