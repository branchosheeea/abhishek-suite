"""Who may use which workspace. Pure: no I/O.

v1: a person either may use a workspace or not ("use"), plus an Admin flag for managing people. The shape already
carries a role and a vessel scope, so view/edit/approve roles and per-vessel rights can be added without a redesign.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Iterable

#: Workspace keys, in launcher order (abhishek_automation_suite.WORKSPACES).
MODULES: tuple[str, ...] = ("vessel", "oil", "voyage", "gc", "cjc", "sir", "evi")
MODULE_TITLES: dict[str, str] = {
    "vessel": "Vessel Report Centre", "oil": "Lub Oil Consumption Review", "voyage": "Voyage Summary",
    "gc": "Guarantee Claim Manager", "cjc": "Critical Job Compliance", "sir": "Superintendent Inspection Report",
    "evi": "DNV Emissions Validation",
}
ROLES: tuple[str, ...] = ("use",)


def normalise_email(email: str) -> str:
    text = (email or "").strip().lower()
    if not text or "@" not in text or len(text) > 254 or any(c.isspace() for c in text):
        raise ValueError(f"'{email}' is not a valid sign-in name (e.g. first.last@company.com).")
    return text


@dataclass(frozen=True)
class Grant:
    module: str
    role: str = "use"
    #: "*" = all vessels; later a tuple of IMO numbers
    vessels: str | tuple[str, ...] = "*"

    def to_document(self) -> dict:
        doc: dict = {"module": self.module, "role": self.role}
        if self.vessels != "*":
            doc["scope"] = {"vessels": list(self.vessels)}
        return doc

    @staticmethod
    def from_document(doc: dict) -> "Grant | None":
        module = doc.get("module")
        role = doc.get("role", "use")
        if module not in MODULES or role not in ROLES:
            return None  # unknown modules/roles from a newer version are ignored, never widened
        scope = (doc.get("scope") or {}).get("vessels", "*")
        return Grant(module, role, "*" if scope == "*" else tuple(str(v) for v in scope))


@dataclass(frozen=True)
class UserAccess:
    email: str
    name: str = ""
    active: bool = True
    admin: bool = False
    grants: tuple[Grant, ...] = ()
    oid: str | None = None
    note: str = ""
    rev: int = 0
    meta: dict = field(default_factory=dict, compare=False)
    #: NeraVeda password set by an admin (passwords.base_record), or None: Microsoft sign-in only
    password: dict | None = field(default=None, compare=False)

    @property
    def modules(self) -> tuple[str, ...]:
        have = {g.module for g in self.grants}
        return tuple(m for m in MODULES if m in have)

    def with_modules(self, modules: Iterable[str]) -> "UserAccess":
        wanted = [m for m in MODULES if m in set(modules)]
        return replace(self, grants=tuple(Grant(m) for m in wanted))


def allows(access: UserAccess | None, module: str, action: str = "use", vessel: str | None = None) -> bool:
    if access is None or not access.active or module not in MODULES:
        return False
    for g in access.grants:
        if g.module != module or g.role != action:
            continue
        if g.vessels == "*" or vessel is None or vessel in g.vessels:
            return True
    return False


def from_document(doc: dict) -> UserAccess:
    grants = tuple(g for g in (Grant.from_document(x) for x in doc.get("grants") or []) if g is not None)
    return UserAccess(
        email=normalise_email(doc["email"]),
        name=str(doc.get("name") or ""),
        active=bool(doc.get("active", False)),
        admin=bool(doc.get("admin", False)),
        grants=grants,
        oid=doc.get("oid") or None,
        note=str(doc.get("note") or ""),
        rev=int(doc.get("rev") or 0),
        meta={k: doc.get(k) for k in ("created_at", "created_by", "updated_at", "updated_by") if k in doc},
        password=_password(doc.get("password")),
    )


def _password(value) -> dict | None:
    """A well-formed password record, else None (a malformed record never allows a sign-in)."""
    if not isinstance(value, dict) or not isinstance(value.get("verifier"), dict) or not value["verifier"].get("pub"):
        return None
    return dict(value)


def to_document(access: UserAccess) -> dict:
    return {
        "email": normalise_email(access.email),
        "name": access.name,
        "active": access.active,
        "admin": access.admin,
        "grants": [g.to_document() for g in access.grants],
        "oid": access.oid,
        "note": access.note,
        "password": access.password,
        "v": 1,
    }


def password_state(access: UserAccess | None) -> dict | None:
    """What the audit records about a password: never the verifier."""
    if access is None or not access.password:
        return None
    return {"epoch": access.password.get("epoch", 0), "temporary": bool(access.password.get("temporary")),
            "set_at": access.password.get("set_at"), "set_by": access.password.get("set_by")}


def snapshot(access: UserAccess | None) -> dict | None:
    """The part of a person's rights recorded in the audit (before / after)."""
    if access is None:
        return None
    return {"active": access.active, "admin": access.admin, "grants": [g.to_document() for g in access.grants],
            "password": password_state(access)}


def diff(before: UserAccess | None, after: UserAccess) -> list[str]:
    """Human-readable changes, e.g. ['+oil', '-sir', 'admin:false→true']."""
    out: list[str] = []
    old = set(before.modules) if before else set()
    new = set(after.modules)
    out += [f"+{m}" for m in MODULES if m in new - old]
    out += [f"-{m}" for m in MODULES if m in old - new]
    if before is None or before.admin != after.admin:
        out.append(f"admin:{str(before.admin).lower() if before else 'none'}→{str(after.admin).lower()}")
    if before is None or before.active != after.active:
        out.append(f"active:{str(before.active).lower() if before else 'none'}→{str(after.active).lower()}")
    if before is not None and before.name != after.name:
        out.append("name")
    if before is not None and before.oid != after.oid:
        out.append("oid")
    old_pw, new_pw = password_state(before), password_state(after)
    if new_pw and (not old_pw or old_pw["epoch"] != new_pw["epoch"]):
        out.append("password:temporary" if new_pw["temporary"] else "password:set")
    elif old_pw and not new_pw:
        out.append("password:removed")
    return out


def would_leave_no_admin(users: Iterable[UserAccess], after: UserAccess) -> bool:
    """True when saving `after` leaves no active admin."""
    remaining = [u for u in users if u.email != after.email and u.active and u.admin]
    return not remaining and not (after.active and after.admin)
