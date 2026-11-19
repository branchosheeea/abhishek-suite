"""A stand-in for AccessService in launcher tests: no Microsoft, no database, predictable web URLs."""
from __future__ import annotations

from suite_services.access.entitlements import MODULES


class FakeAccess:
    def __init__(self, modules=MODULES, admin: bool = False, signed_in: bool = True, local_mode: bool = False,
                 can_administer: bool | None = None, accepts: bool = True, email: str = "tester@example.com", name: str = "Test User",
                 store=None, methods=None, password: str | None = None, temporary: bool = False, password_user: bool = False):
        self.store = store
        self.signin_methods = dict(methods or {"microsoft": True, "password": password is not None})
        self.password = password
        self.temporary = temporary
        self._password_user = password_user
        self.modules = tuple(modules)
        self.admin = admin
        self._signed_in = signed_in
        self.local_mode = local_mode
        self._can_administer = admin if can_administer is None else can_administer
        self.accepts = accepts
        self.email = email
        self.name = name
        self.needs_setup = False
        self.offline = False
        self.last_error = None
        self.calls: list[tuple] = []

    # state
    def cached(self):
        return self if self._signed_in else None

    def try_silent(self):
        return self.cached()

    def sign_in(self, parent_window_handle=None):
        self._signed_in = True
        return self

    def sign_in_with_code(self, on_code):
        on_code("Go to https://microsoft.com/devicelogin and enter TEST-CODE")
        return self.sign_in()

    def sign_in_with_password(self, email, password, new_password=None):
        from suite_services.access.session import WRONG_PASSWORD, AccessDenied, PasswordChangeRequired
        self.calls.append(("password", email, bool(new_password)))
        if self.password is None or password != self.password:
            raise AccessDenied(WRONG_PASSWORD)
        if self.temporary and not new_password:
            raise PasswordChangeRequired("This is a temporary password. Choose your own password to finish signing in.")
        if new_password:
            self.password, self.temporary = new_password, False
        self._signed_in = self._password_user = True
        return self

    def change_password(self, old_password, new_password):
        from suite_services.access.session import AccessDenied
        self.calls.append(("change_password",))
        if old_password != self.password:
            raise AccessDenied("Your current password is not correct.")
        self.password = new_password

    @property
    def password_user(self):
        return self._signed_in and self._password_user

    def refresh(self):
        self.calls.append(("refresh",))
        return self if self._signed_in else None

    def sign_out(self):
        self.calls.append(("sign_out",))
        self._signed_in = False

    @property
    def signed_in(self):
        return self._signed_in

    @property
    def user_label(self):
        return self.name

    def allows(self, key):
        return self._signed_in and key in self.modules

    @property
    def is_admin(self):
        return self._signed_in and self.admin

    @property
    def can_administer(self):
        return self._signed_in and self._can_administer

    def acting_as(self):
        return {"email": self.email, "oid": None, "name": self.name}

    def admin_store(self):
        if self.store is None:
            from suite_services.access.store import MemoryAccessStore
            self.store = MemoryAccessStore()
        return self.store

    # web
    def web_secret(self, key, rotate=False):
        self.calls.append(("web_secret", key, rotate))
        return "0" * 64

    def web_entry_url(self, key, port, path):
        path = path if path.startswith("/") else f"/{path}"
        return f"http://localhost:{port}/api/auth/enter?t=test&next={path}"

    def service_headers(self, key):
        return {"x-neraveda-service": "test"}

    def server_accepts(self, key, port):
        return self.accepts

    def revoke_web(self, key, port):
        self.calls.append(("revoke_web", key, port))

    def db_env(self, key):
        return {}
