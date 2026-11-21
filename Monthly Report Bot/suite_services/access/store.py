"""Central access list in MongoDB Atlas (database `neraveda_access`).

- users: one document per person (by lower-case sign-in email); never deleted, only deactivated.
- audit: append-only record of every change, with the authenticated database user (cannot be faked by edited code).
- meta:  {_id: "policy"} session and offline limits.
- password_changes: people's own password changes, each signed with their previous password (passwords.py).
Every PC reads with a read-only credential that may also add password changes (insert only); only admin PCs hold a
credential that can change people and rights (and none can delete), enforced by Atlas custom roles.
MemoryAccessStore has the same behaviour for tests.
"""
from __future__ import annotations

import socket
from dataclasses import replace
from datetime import datetime, timezone

from suite_services import actor as actor_module
from suite_services.access.entitlements import (
    MODULES, UserAccess, diff, from_document, normalise_email, snapshot, to_document, would_leave_no_admin,
)

DEFAULT_POLICY = {"session_hours": 12, "offline_grace_hours": 72, "refresh_minutes": 15}
APP_VERSION = "2026.11"


class AccessStoreError(RuntimeError):
    pass


class ConflictError(AccessStoreError):
    """Someone else changed the person since it was loaded."""


class LastAdminError(AccessStoreError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def client_info() -> dict:
    try:
        host = socket.gethostname()
    except OSError:
        host = "unknown"
    return {"host": host, "windows_user": actor_module.windows_user(), "app_version": APP_VERSION}


def summarise_privileges(privileges: list[dict], db_name: str, user: str | None) -> dict:
    """What a credential can do on the access list, from connectionStatus showPrivileges."""
    def actions_on(collection: str) -> set[str]:
        found: set[str] = set()
        for p in privileges:
            res = p.get("resource") or {}
            if res.get("anyResource") or res.get("cluster"):
                found |= set(p.get("actions") or []) if res.get("anyResource") else set()
                continue
            if res.get("db") in (db_name, "") and res.get("collection") in (collection, ""):
                found |= set(p.get("actions") or [])
        return found

    users_actions, audit_actions, change_actions = actions_on("users"), actions_on("audit"), actions_on("password_changes")
    can_write = bool({"insert", "update"} & users_actions)
    # Rewriting or removing password changes could undo someone's own change, so it counts as removing.
    can_remove = bool({"remove", "dropCollection", "dropDatabase"} & (users_actions | audit_actions | change_actions)) or "update" in change_actions
    audit_insert_only = "insert" in audit_actions and not ({"update", "remove"} & audit_actions)
    password_changes = "insert" in change_actions
    if not can_write and not can_remove:
        summary = "read-only for people and rights (enforced by the database); " + (
            "can record people's own password changes" if password_changes else "cannot record password changes (people cannot change their own password)")
    elif can_write and not can_remove and audit_insert_only:
        summary = "admin: can add and change people; cannot delete; audit is insert-only"
    else:
        summary = "WARNING: this credential can delete or rewrite access records — use the least-privilege roles"
    return {"user": user, "can_write": can_write, "can_remove": can_remove, "audit_insert_only": audit_insert_only,
            "password_changes": password_changes, "summary": summary}


def apply_dns_override(servers) -> None:
    """Use these DNS servers for MongoDB SRV lookups (the office DNS does not resolve Atlas SRV records)."""
    servers = [s for s in (servers or []) if s]
    if not servers:
        return
    import dns.resolver
    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = list(servers)
    dns.resolver.default_resolver = resolver


class _Base:
    db_user = "unknown"

    # implemented by subclasses
    def _users(self) -> list[UserAccess]: raise NotImplementedError
    def _find(self, email: str) -> UserAccess | None: raise NotImplementedError
    def _write(self, before: UserAccess | None, after: UserAccess, expected_rev: int | None, audit: dict) -> UserAccess: raise NotImplementedError

    def get_user(self, email: str) -> UserAccess | None:
        return self._find(normalise_email(email))

    def password_changes(self, email: str) -> list[dict]:
        raise NotImplementedError

    def add_password_change(self, record: dict) -> None:
        raise NotImplementedError

    def list_users(self) -> list[UserAccess]:
        return sorted(self._users(), key=lambda u: (not u.active, u.email))

    def save_user(self, by: dict, after: UserAccess, expected_rev: int | None, reason: str = "") -> UserAccess:
        """Create (expected_rev None) or update (expected_rev = rev as loaded) a person and audit it in one step."""
        after = replace(after, email=normalise_email(after.email))
        users = self._users()
        before = next((u for u in users if u.email == after.email), None)
        if expected_rev is None and before is not None:
            raise ConflictError(f"{after.email} already exists. Reload the list.")
        if expected_rev is not None and (before is None or before.rev != expected_rev):
            raise ConflictError(f"{after.email} was changed by someone else. Reload and try again.")
        if would_leave_no_admin(users, after):
            raise LastAdminError("At least one active admin must remain.")
        changes = diff(before, after)
        action = "user.create" if before is None else ("user.deactivate" if before.active and not after.active else "user.reactivate" if not before.active and after.active else "user.update")
        audit = {"at": now_iso(), "actor": by, "db_user": self.db_user, "action": action, "target": after.email,
                 "rev": (before.rev + 1) if before else 1, "before": snapshot(before), "after": snapshot(after),
                 "changes": changes, "reason": (reason or "")[:500], "client": client_info()}
        return self._write(before, after, expected_rev, audit)

    def bootstrap_admin(self, email: str, name: str, by: dict | None = None, password: dict | None = None) -> UserAccess:
        """The first admin, with every workspace; `password` (passwords.base_record) for sign-in without Microsoft."""
        if any(u.admin and u.active for u in self._users()):
            raise AccessStoreError("An admin already exists; add people from the Admin screen instead.")
        person = replace(UserAccess(email=normalise_email(email), name=name, active=True, admin=True).with_modules(MODULES), password=password)
        by = by or {"email": person.email, "oid": None, "name": name}
        existing = self._find(person.email)
        saved = self.save_user(by, replace(person, rev=existing.rev if existing else 0), existing.rev if existing else None, "bootstrap: first admin")
        return saved


class MemoryAccessStore(_Base):
    def __init__(self, users: list[UserAccess] | None = None, db_user: str = "memory"):
        self.db_user = db_user
        self.users: dict[str, UserAccess] = {u.email: u for u in (users or [])}
        self.audit_log: list[dict] = []
        self.changes: list[dict] = []
        self.meta = {"_id": "policy", **DEFAULT_POLICY}

    def _users(self):
        return list(self.users.values())

    def _find(self, email):
        return self.users.get(email)

    def password_changes(self, email):
        return [dict(c) for c in self.changes if c.get("email") == email]

    def add_password_change(self, record):
        self.changes.append(dict(record))

    def _write(self, before, after, expected_rev, audit):
        saved = replace(after, rev=(before.rev + 1) if before else 1)
        self.users[saved.email] = saved
        self.audit_log.append(audit)
        return saved

    def audit(self, limit: int = 200, target: str | None = None) -> list[dict]:
        rows = [a for a in self.audit_log if target is None or a["target"] == target]
        return list(reversed(rows))[:limit]

    def policy(self) -> dict:
        return dict(self.meta)

    def privileges(self) -> dict:
        return {"user": self.db_user, "can_write": True, "can_remove": False, "audit_insert_only": True, "password_changes": True,
                "summary": "memory store (tests)"}

    def ensure_indexes(self) -> None:
        pass


class AccessStore(_Base):
    """MongoDB Atlas store. pymongo is imported lazily so workspaces never load it."""

    def __init__(self, uri: str, db_name: str = "neraveda_access", dns_servers=(), timeout_ms: int = 8000):
        if not uri:
            raise AccessStoreError("No access-list connection string is configured on this PC.")
        try:
            apply_dns_override(dns_servers)
            from pymongo import MongoClient
        except ImportError as error:
            import sys
            raise AccessStoreError(
                f"Sign-in needs the 'pymongo' package for the Python NeraVeda runs on ({sys.executable}). "
                "In the Monthly Report Bot folder run:  <that python.exe> -m pip install -r requirements.txt") from error
        self._client = MongoClient(uri, serverSelectionTimeoutMS=timeout_ms, appname="neraveda-access", retryWrites=True)
        self._db = self._client[db_name]
        self._db_user_cache: str | None = None

    @property
    def db_user(self) -> str:  # type: ignore[override]
        if self._db_user_cache is None:
            status = self._db.command({"connectionStatus": 1})
            users = (status.get("authInfo") or {}).get("authenticatedUsers") or []
            self._db_user_cache = users[0]["user"] if users else "unauthenticated"
        return self._db_user_cache

    def close(self) -> None:
        self._client.close()

    def _users(self):
        out = []
        for doc in self._db.users.find({}, {"_id": 0}):
            try:
                out.append(from_document(doc))
            except (KeyError, ValueError):
                continue  # a malformed document never grants anything
        return out

    def _find(self, email):
        doc = self._db.users.find_one({"email": email}, {"_id": 0})
        return from_document(doc) if doc else None

    def password_changes(self, email):
        from suite_services.access.passwords import MAX_CHAIN
        return list(self._db.password_changes.find({"email": email}, {"_id": 0}).limit(MAX_CHAIN * 4))

    def add_password_change(self, record):
        self._db.password_changes.insert_one(dict(record))

    def _write(self, before, after, expected_rev, audit):
        stamp, by = audit["at"], audit["actor"].get("email")
        doc = to_document(after)
        with self._client.start_session() as session:
            with session.start_transaction():
                if before is None:
                    self._db.users.insert_one({**doc, "rev": 1, "created_at": stamp, "created_by": by, "updated_at": stamp, "updated_by": by}, session=session)
                else:
                    result = self._db.users.update_one(
                        {"email": after.email, "rev": expected_rev},
                        {"$set": {**doc, "updated_at": stamp, "updated_by": by}, "$inc": {"rev": 1}},
                        session=session,
                    )
                    if result.matched_count != 1:
                        raise ConflictError(f"{after.email} was changed by someone else. Reload and try again.")
                self._db.audit.insert_one(dict(audit), session=session)
        return self._find(after.email)

    def audit(self, limit: int = 200, target: str | None = None) -> list[dict]:
        query = {"target": target} if target else {}
        return list(self._db.audit.find(query, {"_id": 0}).sort("at", -1).limit(limit))

    def policy(self) -> dict:
        doc = self._db.meta.find_one({"_id": "policy"}) or {}
        return {**DEFAULT_POLICY, **{k: v for k, v in doc.items() if k in DEFAULT_POLICY}}

    def ensure_indexes(self) -> None:
        self._db.users.create_index("email", unique=True, name="email_unique")
        self._db.users.create_index("oid", unique=True, name="oid_unique", partialFilterExpression={"oid": {"$type": "string"}})
        self._db.audit.create_index([("target", 1), ("at", -1)], name="target_at")
        self._db.audit.create_index([("at", -1)], name="at")
        # Not unique: a planted record with the same number must never block someone's real change.
        self._db.password_changes.create_index([("email", 1), ("epoch", 1), ("seq", 1)], name="email_epoch_seq")
        if self._db.meta.find_one({"_id": "policy"}) is None:
            self._db.meta.insert_one({"_id": "policy", **DEFAULT_POLICY, "rev": 1, "updated_at": now_iso(), "updated_by": "bootstrap"})

    def bootstrap_admin(self, email, name, by=None, password=None):
        self.ensure_indexes()
        return super().bootstrap_admin(email, name, by, password)

    def privileges(self) -> dict:
        """What this credential can do, as reported by the database (not as the code assumes)."""
        status = self._db.command({"connectionStatus": 1, "showPrivileges": True})
        info = status.get("authInfo") or {}
        users = info.get("authenticatedUsers") or []
        return summarise_privileges(info.get("authenticatedUserPrivileges") or [], self._db.name, users[0]["user"] if users else None)
