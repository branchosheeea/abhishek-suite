"""Sign-in and access-list settings for this PC.

Non-secret values (tenant, client, database name, DNS servers) live in <runtime_root>/access/config.json; database
connection strings are DPAPI-protected files next to it. Environment variables override both (NERAVEDA_*), which
keeps tests and one-off checks simple.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

from suite_services import secure_store
from suite_services.storage import runtime_root

POLICY_FILE = Path(__file__).resolve().parent / "policy.json"
GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def access_dir() -> Path:
    return runtime_root() / "access"


def credentials_dir() -> Path:
    return runtime_root() / "credentials"


@dataclass(frozen=True)
class AccessConfig:
    tenant_id: str | None = None
    client_id: str | None = None
    db_name: str = "neraveda_access"
    dns_servers: tuple[str, ...] = ()
    reader_uri: str | None = None
    admin_uri: str | None = None
    #: from policy.json in the code folder: when true, local mode is not allowed
    required: bool = False

    @property
    def configured(self) -> bool:
        """Sign-in is set up: the access list can be read. Microsoft sign-in is optional on top (see `microsoft`)."""
        return bool(self.reader_uri)

    @property
    def microsoft(self) -> bool:
        """Microsoft sign-in is available on this PC (IT's app registration entered)."""
        return bool(self.configured and self.tenant_id and self.client_id)

    @property
    def local_mode(self) -> bool:
        """Sign-in not set up and not required: the suite behaves as before (Windows user, all modules)."""
        return not self.configured and not self.required


def policy_required(path: Path = POLICY_FILE) -> bool:
    try:
        return bool(json.loads(path.read_text(encoding="utf-8")).get("required", False))
    except (OSError, ValueError):
        # An unreadable policy file never weakens access: treat it as required.
        return True


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def load_config(env=None) -> AccessConfig:
    env = os.environ if env is None else env
    stored = _read_json(access_dir() / "config.json")
    dns = env.get("NERAVEDA_DNS_SERVERS") or stored.get("dns_servers") or ""
    if isinstance(dns, str):
        dns = [part.strip() for part in dns.split(",") if part.strip()]
    reader = env.get("NERAVEDA_ACCESS_URI") or _secret("reader_uri")
    admin = env.get("NERAVEDA_ACCESS_ADMIN_URI") or _secret("admin_uri")
    return AccessConfig(
        tenant_id=env.get("NERAVEDA_TENANT_ID") or stored.get("tenant_id") or None,
        client_id=env.get("NERAVEDA_CLIENT_ID") or stored.get("client_id") or None,
        db_name=env.get("NERAVEDA_ACCESS_DB") or stored.get("db_name") or "neraveda_access",
        dns_servers=tuple(dns),
        reader_uri=reader or None,
        admin_uri=admin or None,
        required=policy_required(),
    )


def validate_settings(tenant_id: str | None, client_id: str | None) -> None:
    """Both IDs, or neither (then this PC offers NeraVeda password sign-in only)."""
    if not tenant_id and not client_id:
        return
    for label, value in (("Tenant ID", tenant_id), ("Client ID", client_id)):
        if not GUID.match(value or ""):
            raise ValueError(f"{label} must be a GUID such as 00000000-0000-0000-0000-000000000000 (or leave both empty).")


def save_settings(tenant_id: str | None, client_id: str | None, dns_servers: list[str] | tuple[str, ...] = (), db_name: str = "neraveda_access") -> Path:
    validate_settings(tenant_id, client_id)
    path = access_dir() / "config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"tenant_id": tenant_id or None, "client_id": client_id or None, "dns_servers": list(dns_servers),
                                     "db_name": db_name}, indent=2), encoding="utf-8")
    os.replace(temporary, path)
    return path


# ── protected secrets (database connection strings) ─────────────────────────

SECRET_NAMES = ("reader_uri", "admin_uri", "db_sir", "db_evi")


def _secret_path(name: str) -> Path:
    if name not in SECRET_NAMES:
        raise ValueError(f"Unknown secret {name}.")
    return access_dir() / f"{name}.bin"


def _secret(name: str) -> str | None:
    data = secure_store.read_protected(_secret_path(name), f"access {name}")
    return data.decode("utf-8") if data else None


def save_secret(name: str, value: str) -> Path:
    path = _secret_path(name)
    secure_store.write_protected(path, value.encode("utf-8"), f"access {name}")
    return path


def read_secret(name: str) -> str | None:
    return _secret(name)


def remove_secret(name: str) -> None:
    secure_store.remove(_secret_path(name))
