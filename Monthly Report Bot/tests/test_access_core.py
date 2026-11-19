"""NeraVeda sign-in and access rights: entitlements, tickets, the access list, sessions, sign-in and the module guard.

No Microsoft or database calls: MSAL and MongoDB are replaced by fakes; protected files go to a temporary folder.
"""
import json
import os
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from abhishek_automation_suite import TITLES, WORKSPACES
from suite_services import actor, home_intelligence
from suite_services.access import config as cfg
from suite_services.access import guard, tickets
from suite_services.access.config import AccessConfig
from suite_services.access.entitlements import (
    MODULE_TITLES, MODULES, Grant, UserAccess, allows, diff, from_document, normalise_email, to_document, would_leave_no_admin,
)
from suite_services.access.session import AccessDenied, AccessService, NotSetUp, Session, SessionExpired, SessionStore
from suite_services.access.signin import EntraSignIn, Identity, SignInError
from suite_services.access.store import ConflictError, LastAdminError, MemoryAccessStore

ROOT = Path(__file__).resolve().parents[1]
TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ENTRA = AccessConfig(tenant_id=TENANT, client_id=CLIENT, reader_uri="mongodb://reader", admin_uri="mongodb://admin")
SECRET = "f" * 64


class TempRuntime(unittest.TestCase):
    """Every test gets its own runtime folder, so no real session or secret is touched."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._env = patch.dict(os.environ, {"ABHISHEK_SUITE_DATA": self._tmp.name})
        self._env.start()
        actor.set_current(None)

    def tearDown(self):
        actor.set_current(None)
        self._env.stop()
        self._tmp.cleanup()


class EntitlementTests(unittest.TestCase):
    def test_module_keys_match_the_launcher_and_home(self):
        self.assertEqual(MODULES, tuple(w[0] for w in WORKSPACES))
        self.assertEqual(MODULES, tuple(home_intelligence.ORDER))
        self.assertEqual(MODULE_TITLES, TITLES)

    def test_allows_only_active_people_with_the_module(self):
        person = UserAccess("a@x.com").with_modules(["oil", "sir"])
        self.assertTrue(allows(person, "oil"))
        self.assertFalse(allows(person, "evi"))
        self.assertFalse(allows(replace(person, active=False), "oil"))
        self.assertFalse(allows(person, "unknown"))
        self.assertFalse(allows(None, "oil"))
        scoped = replace(person, grants=(Grant("oil", vessels=("9074729",)),))
        self.assertTrue(allows(scoped, "oil", vessel="9074729"))
        self.assertFalse(allows(scoped, "oil", vessel="1234567"))

    def test_documents_round_trip_and_unknown_grants_are_ignored(self):
        person = UserAccess("First.Last@X.com ", "First Last", admin=True).with_modules(["evi"])
        doc = to_document(replace(person, email="first.last@x.com"))
        doc["grants"].append({"module": "future-module", "role": "use"})
        doc["grants"].append({"module": "oil", "role": "approve"})
        back = from_document(doc)
        self.assertEqual((back.email, back.modules, back.admin), ("first.last@x.com", ("evi",), True))
        self.assertRaises(ValueError, normalise_email, "not an email")

    def test_diff_and_last_admin_protection(self):
        before = UserAccess("a@x.com").with_modules(["oil", "sir"])
        after = replace(before.with_modules(["oil", "evi"]), admin=True)
        self.assertEqual(diff(before, after), ["+evi", "-sir", "admin:false→true"])
        admin = UserAccess("boss@x.com", admin=True)
        self.assertTrue(would_leave_no_admin([admin], replace(admin, admin=False)))
        self.assertTrue(would_leave_no_admin([admin], replace(admin, active=False)))
        self.assertFalse(would_leave_no_admin([admin, UserAccess("two@x.com", admin=True)], replace(admin, admin=False)))


class TicketTests(unittest.TestCase):
    def test_round_trip_expiry_audience_and_tampering(self):
        token = tickets.mint(SECRET, "enter", "evi", "a@x.com", name="A", grants=[{"module": "evi", "role": "use"}], ttl=120, now=1000)
        claims = tickets.verify(SECRET, token, "enter", "evi", now=1100)
        self.assertEqual((claims["sub"], claims["grants"]), ("a@x.com", [{"module": "evi", "role": "use"}]))
        with self.assertRaisesRegex(tickets.TicketError, "expired"):
            tickets.verify(SECRET, token, "enter", "evi", now=1121)
        with self.assertRaisesRegex(tickets.TicketError, "audience"):
            tickets.verify(SECRET, token, "enter", "sir", now=1100)
        with self.assertRaisesRegex(tickets.TicketError, "audience"):
            tickets.verify(SECRET, token, "service", "evi", now=1100)
        head, body, mac = token.split(".")
        forged = json.loads(tickets.unb64url(body))
        forged["sub"] = "boss@x.com"
        with self.assertRaisesRegex(tickets.TicketError, "signature"):
            tickets.verify(SECRET, f"{head}.{tickets.b64url(json.dumps(forged).encode())}.{mac}", "enter", "evi", now=1100)
        with self.assertRaisesRegex(tickets.TicketError, "signature"):
            tickets.verify("e" * 64, token, "enter", "evi", now=1100)

    def test_shared_vectors_match_the_node_apps(self):
        vectors = json.loads((ROOT / "tests" / "fixtures" / "neraveda_ticket_vectors.json").read_text(encoding="utf-8"))
        for v in vectors["valid"]:
            claims = tickets.verify(vectors["secret"], v["token"], v["typ"], v["aud"], now=vectors["now"])
            self.assertEqual(claims["sub"], v["sub"])
        for v in vectors["invalid"]:
            with self.assertRaises(tickets.TicketError, msg=v["why"]):
                tickets.verify(vectors["secret"], v["token"], v["typ"], v["aud"], now=vectors["now"])


class StoreTests(unittest.TestCase):
    def test_create_update_conflict_audit_and_last_admin(self):
        store = MemoryAccessStore(db_user="neraveda_access_admin_test")
        by = {"email": "boss@x.com", "oid": None, "name": "Boss"}
        boss = store.bootstrap_admin("Boss@X.com", "Boss")
        self.assertEqual((boss.email, boss.admin, boss.modules, boss.rev), ("boss@x.com", True, MODULES, 1))
        self.assertRaisesRegex(Exception, "already exists", store.bootstrap_admin, "two@x.com", "Two")
        alice = store.save_user(by, UserAccess("alice@x.com", "Alice").with_modules(["oil"]), None, "new engineer")
        updated = store.save_user(by, alice.with_modules(["oil", "evi"]), alice.rev, "")
        self.assertEqual(updated.rev, 2)
        with self.assertRaises(ConflictError):
            store.save_user(by, alice.with_modules([]), alice.rev, "stale edit")
        with self.assertRaises(LastAdminError):
            store.save_user(by, replace(boss, admin=False), boss.rev, "")
        latest = store.audit(target="alice@x.com")[0]
        self.assertEqual((latest["action"], latest["changes"], latest["db_user"]), ("user.update", ["+evi"], "neraveda_access_admin_test"))
        self.assertEqual(store.audit()[-1]["action"], "user.create")


class FakeSignIn:
    def __init__(self, identity=None):
        self.identity = identity
        self.signed_out = False

    def silent(self):
        return self.identity

    def interactive(self, parent_window_handle=None):
        if self.identity is None:
            raise SignInError("cancelled")
        return self.identity

    def sign_out(self):
        self.signed_out = True


class SessionTests(TempRuntime):
    def service(self, store, identity=Identity("alice@x.com", "oid-1", TENANT, "Alice"), clock=None, config=ENTRA):
        self.now = [1_000_000.0]
        return AccessService(config, signin=FakeSignIn(identity), store_factory=lambda uri: store, sessions=SessionStore(), clock=clock or (lambda: self.now[0]))

    def test_local_mode_keeps_todays_behaviour(self):
        access = AccessService(AccessConfig(required=False), sessions=SessionStore())
        session = access.cached()
        self.assertEqual((session.mode, session.modules), ("local", MODULES))
        self.assertTrue(all(access.allows(m) for m in MODULES))
        self.assertFalse(access.is_admin)
        self.assertEqual(actor.current_actor(), actor.windows_user())

    def test_required_but_not_set_up_opens_nothing(self):
        access = AccessService(AccessConfig(required=True), sessions=SessionStore())
        self.assertIsNone(access.cached())
        self.assertTrue(access.needs_setup)
        self.assertRaises(NotSetUp, access.sign_in)

    def test_sign_in_stores_a_protected_session_used_by_the_next_start(self):
        store = MemoryAccessStore([UserAccess("alice@x.com", "Alice").with_modules(["oil", "evi"])])
        access = self.service(store)
        session = access.sign_in()
        self.assertEqual((session.email, session.modules), ("alice@x.com", ("oil", "evi")))
        self.assertTrue(access.allows("oil") and not access.allows("sir"))
        self.assertEqual(actor.current_actor(), "alice@x.com")
        raw = (Path(os.environ["ABHISHEK_SUITE_DATA"]) / "access" / "session.bin").read_bytes()
        self.assertNotIn(b"alice@x.com", raw)  # DPAPI-protected, not plain JSON
        again = self.service(store)
        self.assertEqual(again.cached().email, "alice@x.com")

    def test_unregistered_deactivated_and_mismatched_accounts_are_refused(self):
        store = MemoryAccessStore([UserAccess("bob@x.com", active=False), UserAccess("carol@x.com", oid="oid-carol")])
        with self.assertRaisesRegex(AccessDenied, "not registered") as caught:
            self.service(store).sign_in()
        self.assertEqual(caught.exception.email, "alice@x.com")
        with self.assertRaisesRegex(AccessDenied, "deactivated"):
            self.service(store, Identity("bob@x.com", None, TENANT, "Bob")).sign_in()
        with self.assertRaisesRegex(AccessDenied, "does not match"):
            self.service(store, Identity("carol@x.com", "someone-else", TENANT, "Carol")).sign_in()

    def test_refresh_applies_changes_works_offline_within_grace_then_expires(self):
        store = MemoryAccessStore([UserAccess("alice@x.com").with_modules(["oil"])])
        access = self.service(store)
        access.sign_in()
        store.users["alice@x.com"] = store.users["alice@x.com"].with_modules(["oil", "sir"])
        access.refresh()
        self.assertTrue(access.allows("sir"))

        class Down:
            def get_user(self, email):
                raise ConnectionError("Atlas unreachable")
        access._store_factory = lambda uri: Down()
        self.now[0] += 11 * 3600
        access.refresh()
        self.assertTrue(access.offline and access.allows("sir"))
        self.now[0] += 2 * 3600  # 13 h after sign-in: past the 12 h session
        with self.assertRaises(SessionExpired):
            access.refresh()
        self.assertFalse(access.signed_in)

    def test_removed_person_is_signed_out_at_the_next_refresh(self):
        store = MemoryAccessStore([UserAccess("alice@x.com").with_modules(["oil"])])
        access = self.service(store)
        access.sign_in()
        store.users["alice@x.com"] = replace(store.users["alice@x.com"], active=False)
        with self.assertRaises(AccessDenied):
            access.refresh()
        self.assertIsNone(SessionStore().load())

    def test_sessions_expire_after_twelve_hours_or_seventy_two_offline(self):
        s = Session("a@x.com", "A", None, False, ("oil",), "entra", signed_in_at=0, verified_at=0)
        self.assertTrue(s.valid(11 * 3600) and not s.valid(12 * 3600 + 1))
        old = replace(s, signed_in_at=0, verified_at=0, session_hours=1000)
        self.assertTrue(old.valid(71 * 3600) and not old.valid(72 * 3600 + 1))
        self.assertIsNone(Session.from_json(b"{not json"))

    def test_web_tickets_are_signed_for_one_workspace(self):
        store = MemoryAccessStore([UserAccess("alice@x.com", "Alice").with_modules(["evi"])])
        access = self.service(store, clock=time.time)
        access.sign_in()
        secret = access.web_secret("evi", rotate=True)
        self.assertEqual(access.web_secret("evi"), secret)
        url = access.web_entry_url("evi", 3001, "/sessions/abc")
        self.assertTrue(url.startswith("http://localhost:3001/api/auth/enter?t=nv1."))
        token = url.split("t=")[1].split("&")[0]
        claims = tickets.verify(secret, token, "enter", "evi")
        self.assertEqual((claims["sub"], claims["grants"]), ("alice@x.com", [{"module": "evi", "role": "use"}]))
        self.assertIn("next=%2Fsessions%2Fabc", url)
        service = tickets.verify(secret, access.service_headers("evi")["x-neraveda-service"], "service", "evi")
        self.assertEqual(service["exp"] - service["iat"], 60)
        self.assertNotEqual(access.web_secret("evi", rotate=True), secret)

    def test_database_settings_only_for_people_with_the_workspace(self):
        cfg.save_secret("db_evi", json.dumps({"EMISSIONS_MONGODB_URI": "mongodb://x", "PATH": "C:/evil"}))
        store = MemoryAccessStore([UserAccess("alice@x.com").with_modules(["evi"])])
        access = self.service(store)
        access.sign_in()
        self.assertEqual(access.db_env("evi"), {"EMISSIONS_MONGODB_URI": "mongodb://x"})
        self.assertEqual(access.db_env("sir"), {})

    def test_sign_out_clears_everything(self):
        store = MemoryAccessStore([UserAccess("alice@x.com").with_modules(["oil"])])
        access = self.service(store)
        access.sign_in()
        access.sign_out()
        self.assertTrue(access._signin.signed_out)
        self.assertIsNone(SessionStore().load())
        self.assertEqual(actor.current_actor(), actor.windows_user())


class FakeMsalApp:
    def __init__(self, client_id, **kwargs):
        self.client_id, self.kwargs = client_id, kwargs
        self.accounts = []
        self.requested = []

    def get_accounts(self):
        return self.accounts

    def acquire_token_silent(self, scopes, account):
        self.requested.append(("silent", scopes))
        return {"id_token_claims": {"tid": TENANT, "preferred_username": "Alice@X.com", "oid": "oid-1", "name": "Alice"}}

    def acquire_token_interactive(self, scopes, **kwargs):
        self.requested.append(("interactive", scopes, kwargs))
        return {"id_token_claims": {"tid": "99999999-0000-0000-0000-000000000000", "preferred_username": "x@other.com"}}

    def remove_account(self, account):
        self.accounts.remove(account)


class SignInTests(TempRuntime):
    def test_silent_needs_an_account_and_returns_the_identity(self):
        apps = []
        signin = EntraSignIn(ENTRA, app_factory=lambda cid, **kw: apps.append(FakeMsalApp(cid, **kw)) or apps[-1])
        self.assertIsNone(signin.silent())
        apps[0].accounts.append({"username": "alice"})
        identity = signin.silent()
        self.assertEqual((identity.email, identity.oid, identity.tid), ("alice@x.com", "oid-1", TENANT))
        self.assertEqual(apps[0].requested[0], ("silent", ["User.Read"]))  # never reserved scopes
        self.assertEqual(apps[0].kwargs["authority"], f"https://login.microsoftonline.com/{TENANT}")

    def test_accounts_from_another_tenant_are_refused(self):
        signin = EntraSignIn(ENTRA, app_factory=FakeMsalApp)
        with self.assertRaisesRegex(SignInError, "another organisation"):
            signin.interactive()

    def test_broker_is_used_only_when_installed(self):
        made = []
        with patch("suite_services.access.signin.broker_available", return_value=False):
            EntraSignIn(ENTRA, app_factory=lambda cid, **kw: made.append(kw) or FakeMsalApp(cid))._load()
        self.assertNotIn("enable_broker_on_windows", made[0])
        with patch("suite_services.access.signin.broker_available", return_value=True):
            EntraSignIn(ENTRA, app_factory=lambda cid, **kw: made.append(kw) or FakeMsalApp(cid))._load()
        self.assertTrue(made[1]["enable_broker_on_windows"])

    def test_not_set_up(self):
        self.assertRaises(SignInError, EntraSignIn, AccessConfig())


class GuardTests(TempRuntime):
    def save(self, **overrides):
        base = dict(email="alice@x.com", name="Alice", oid=None, admin=False, modules=("oil",), mode="entra", signed_in_at=time.time(), verified_at=time.time())
        SessionStore().save(Session(**{**base, **overrides}))

    def test_local_mode_opens_as_before(self):
        with patch("suite_services.access.guard.load_config", return_value=AccessConfig(required=False)):
            self.assertEqual(guard.check_module("oil"), (True, "local mode"))

    def test_session_required_and_module_checked(self):
        with patch("suite_services.access.guard.load_config", return_value=ENTRA):
            self.assertEqual(guard.check_module("oil"), (False, "signed-out"))
            self.save()
            self.assertEqual(guard.check_module("oil"), (True, "alice@x.com"))
            self.assertEqual(actor.current_actor(), "alice@x.com")
            self.assertEqual(guard.check_module("gc"), (False, "no-access"))
            self.save(signed_in_at=time.time() - 13 * 3600)
            self.assertEqual(guard.check_module("oil"), (False, "signed-out"))

    def test_refusal_explains_and_exits(self):
        with patch("suite_services.access.guard.load_config", return_value=ENTRA), \
                patch("suite_services.access.guard._message_box", return_value=7) as box, \
                patch("suite_services.access.guard._open_neraveda") as opener:
            with self.assertRaises(SystemExit) as stop:
                guard.require_module("oil")
        self.assertEqual(stop.exception.code, 2)
        self.assertIn("Sign in to NeraVeda first", box.call_args[0][0])
        opener.assert_not_called()

    def test_every_workspace_entry_point_calls_the_guard(self):
        entries = {"vessel": "vessel_report/__main__.py", "oil": "lube_oil/__main__.py", "voyage": "voyage_summary/__main__.py",
                   "gc": "gc_manager/__main__.py", "cjc": "Critical Jobs Compliance/__main__.py"}
        for key, path in entries.items():
            self.assertIn(f'require_module("{key}")', (ROOT / path).read_text(encoding="utf-8"), path)

    def test_policy_file_is_valid_and_unreadable_policy_means_required(self):
        json.loads(cfg.POLICY_FILE.read_text(encoding="utf-8"))
        self.assertTrue(cfg.policy_required(Path(self._tmp.name) / "missing.json"))


if __name__ == "__main__":
    unittest.main()
