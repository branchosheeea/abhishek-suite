"""Microsoft work-account sign-in (Entra ID) for the launcher.

Order: silent (cached account) → Windows broker (only when pymsalruntime is installed) → system browser → device code.
Scope: User.Read only (MSAL adds openid/profile/offline_access itself; reserved scopes must not be requested).
The MSAL token cache is DPAPI-protected (credentials/neraveda_msal_cache.bin); tokens never leave this module.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path

from suite_services import secure_store
from suite_services.access.config import AccessConfig, credentials_dir

SCOPES = ["User.Read"]
CACHE_PURPOSE = "msal cache"


class SignInError(RuntimeError):
    pass


@dataclass(frozen=True)
class Identity:
    email: str
    oid: str | None
    tid: str
    name: str


def broker_available() -> bool:
    return importlib.util.find_spec("pymsalruntime") is not None


class EntraSignIn:
    def __init__(self, config: AccessConfig, cache_path: Path | None = None, app_factory=None):
        if not (config.tenant_id and config.client_id):
            raise SignInError("Microsoft sign-in is not set up on this PC (tenant and client IDs are missing).")
        self.config = config
        self.cache_path = Path(cache_path) if cache_path else credentials_dir() / "neraveda_msal_cache.bin"
        self._factory = app_factory
        self._app = None
        self._cache = None

    # ── MSAL application and its protected cache ──
    def _load(self):
        if self._app is not None:
            return self._app
        import msal
        self._cache = msal.SerializableTokenCache()
        data = secure_store.read_protected(self.cache_path, CACHE_PURPOSE)
        if data:
            try:
                self._cache.deserialize(data.decode("utf-8"))
            except ValueError:
                pass  # a damaged cache only means signing in again
        factory = self._factory or msal.PublicClientApplication
        kwargs = {"authority": f"https://login.microsoftonline.com/{self.config.tenant_id}", "token_cache": self._cache}
        if broker_available():
            kwargs["enable_broker_on_windows"] = True
        self._app = factory(self.config.client_id, **kwargs)
        return self._app

    def _save(self) -> None:
        if self._cache is not None and getattr(self._cache, "has_state_changed", False):
            secure_store.write_protected(self.cache_path, self._cache.serialize().encode("utf-8"), CACHE_PURPOSE)

    def _identity(self, result: dict | None) -> Identity:
        if not result or "error" in result:
            detail = (result or {}).get("error_description") or (result or {}).get("error") or "no result"
            raise SignInError(f"Microsoft sign-in did not complete: {detail}")
        claims = result.get("id_token_claims") or {}
        tid = str(claims.get("tid") or "")
        if tid.lower() != str(self.config.tenant_id).lower():
            raise SignInError("This Microsoft account belongs to another organisation. Sign in with your company work account.")
        email = str(claims.get("preferred_username") or claims.get("email") or claims.get("upn") or "").strip().lower()
        if not email:
            raise SignInError("Microsoft sign-in returned no sign-in name.")
        return Identity(email=email, oid=claims.get("oid"), tid=tid, name=str(claims.get("name") or email))

    # ── flows ──
    def silent(self) -> Identity | None:
        app = self._load()
        accounts = app.get_accounts()
        if not accounts:
            return None
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if not result or "error" in result:
            return None
        self._save()
        return self._identity(result)

    def interactive(self, parent_window_handle: int | None = None) -> Identity:
        """Windows broker when installed, otherwise the system browser (MSAL listens on a local port)."""
        app = self._load()
        kwargs = {"prompt": "select_account", "timeout": 300}
        if parent_window_handle:
            kwargs["parent_window_handle"] = parent_window_handle
        result = app.acquire_token_interactive(SCOPES, **kwargs)
        self._save()
        return self._identity(result)

    def device_code(self, on_code) -> Identity:
        """For PCs where the browser sign-in cannot return to this computer. on_code(message) shows the code."""
        app = self._load()
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise SignInError(flow.get("error_description") or "Could not start device sign-in.")
        on_code(flow.get("message") or f"Go to {flow.get('verification_uri')} and enter {flow['user_code']}.")
        result = app.acquire_token_by_device_flow(flow)
        self._save()
        return self._identity(result)

    def sign_out(self) -> None:
        try:
            app = self._load()
            for account in app.get_accounts():
                app.remove_account(account)
        finally:
            secure_store.remove(self.cache_path)
            self._app = None
            self._cache = None
