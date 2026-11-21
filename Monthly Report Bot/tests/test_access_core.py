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
from suite_services.access import guard, passwords, tickets
from suite_services.access.config import AccessConfig
from suite_services.access.entitlements import (
    MODULE_TITLES, MODULES, Grant, UserAccess, allows, diff, from_document, normalise_email, snapshot, to_document,
    would_leave_no_admin,
)
from suite_services.access.session import (
    WRONG_PASSWORD, AccessDenied, AccessService, NotSetUp, PasswordChangeRequired, PasswordRejected, Session, SessionExpired,
    SessionStore, TooManyAttempts,
)
from suite_services.access.signin import EntraSignIn, Identity, SignInError
from suite_services.access.store import ConflictError, LastAdminError, MemoryAccessStore, summarise_privileges

ROOT = Path(__file__).resolve().parents[1]
TENANT = "11111111-2222-3333-4444-555555555555"
CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
ENTRA = AccessConfig(tenant_id=TENANT, client_id=CLIENT, reader_uri="mongodb://reader", admin_uri="mongodb://admin")
PASSWORD_ONLY = AccessConfig(reader_uri="mongodb://reader")  # a PC without IT's Microsoft registration
SECRET = "f" * 64
FAST = {"n": 2 ** 14, "r": 8, "p": 1}  # the lowest accepted scrypt cost keeps the tests quick


class FastPasswords:
    def setUp(self):
        super().setUp()
        self._cost = patch.dict(passwords.COST, FAST)
        self._cost.start()

    def tearDown(self):
        self._cost.stop()
        super().tearDown()


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

    def test_passwords_are_audited_by_state_never_by_value(self):
        record = {"verifier": {"pub": "PUBLIC-KEY", "salt": "SALT"}, "epoch": 1, "temporary": True,
                  "set_at": "2026-11-19T10:00:00Z", "set_by": "boss@x.com"}
        before = UserAccess("a@x.com")
        after = replace(before, password=record)
        self.assertEqual(diff(before, after), ["password:temporary"])
        self.assertEqual(diff(after, replace(after, password={**record, "epoch": 2})), ["password:temporary"])
        self.assertEqual(diff(after, replace(after, password=None)), ["password:removed"])
        self.assertEqual(diff(after, replace(after, name="")), [])  # unchanged password, no entry
        self.assertNotIn("PUBLIC-KEY", json.dumps(snapshot(after)))
        self.assertTrue(snapshot(after)["password"]["temporary"])
        self.assertEqual(from_document(to_document(after)).password["epoch"], 1)
        self.assertIsNone(from_document({**to_document(after), "password": {"junk": 1}}).password)


class PasswordTests(FastPasswords, unittest.TestCase):
    def test_verifier_checks_the_password_and_holds_none_of_it(self):
        verifier, _key = passwords.new_verifier("correct horse battery")
        self.assertIsNotNone(passwords.matches("correct horse battery", verifier))
        self.assertIsNone(passwords.matches("correct horse batterz", verifier))
        self.assertIsNone(passwords.matches("", verifier))
        self.assertEqual(set(verifier), {"alg", "n", "r", "p", "salt", "pub"})
        self.assertNotIn("horse", json.dumps(verifier))
        self.assertNotEqual(passwords.new_verifier("correct horse battery")[0]["pub"], verifier["pub"])  # salted
        self.assertFalse(passwords.valid_verifier({**verifier, "n": 2 ** 22}))  # a planted record cannot demand huge memory

    def test_rules_and_temporary_passwords(self):
        self.assertTrue(passwords.problems("short"))
        self.assertIn("Do not include your ID in the password.", passwords.problems("alice-is-great-2026", "alice@x.com"))
        self.assertTrue(passwords.problems("aaaaaaaaaaaaaaaa"))
        self.assertTrue(passwords.problems("Password1234"))
        self.assertEqual(passwords.problems("Harbour lights 42!", "alice@x.com"), [])
        temporary = passwords.generate_temporary()
        self.assertRegex(temporary, r"^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$")
        self.assertEqual(passwords.problems(temporary, "alice@x.com"), [])

    def test_only_a_change_signed_with_the_current_password_counts(self):
        v1, k1 = passwords.new_verifier("first password 1")
        base = passwords.base_record(v1, temporary=True, epoch=1, set_by="boss@x.com")
        current = passwords.resolve("alice@x.com", base)
        self.assertTrue(current.temporary)
        v2, k2 = passwords.new_verifier("second password 2")
        change = passwords.change_record("alice@x.com", current, k1, v2)
        # Someone with database access plants their own password for Alice, signed with their own key.
        vx, kx = passwords.new_verifier("attacker password")
        planted = passwords.change_record("alice@x.com", current, kx, vx)
        resolved = passwords.resolve("alice@x.com", base, [planted, change])
        self.assertEqual((resolved.verifier["pub"], resolved.temporary, resolved.seq), (v2["pub"], False, 1))
        # Replaying the first change after a second one changes nothing.
        v3, _k3 = passwords.new_verifier("third password 3")
        change2 = passwords.change_record("alice@x.com", resolved, k2, v3)
        self.assertEqual(passwords.resolve("alice@x.com", base, [change, change2, dict(change)]).verifier["pub"], v3["pub"])
        # A record edited after signing, one for another person, or one from before an admin reset is ignored.
        self.assertEqual(passwords.resolve("alice@x.com", base, [{**change, "verifier": vx}]).seq, 0)
        self.assertEqual(passwords.resolve("bob@x.com", base, [change]).seq, 0)
        reset = passwords.base_record(v1, temporary=True, epoch=2, set_by="boss@x.com")
        self.assertEqual(passwords.resolve("alice@x.com", reset, [change, change2]).seq, 0)


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

    def test_permission_summary_for_reader_admin_and_too_broad_credentials(self):
        def p(collection, *actions):
            return {"resource": {"db": "neraveda_access", "collection": collection}, "actions": list(actions)}
        reader = summarise_privileges([p("users", "find"), p("meta", "find"), p("password_changes", "find", "insert")], "neraveda_access", "ro")
        self.assertEqual((reader["can_write"], reader["can_remove"], reader["password_changes"]), (False, False, True))
        self.assertIn("read-only for people and rights", reader["summary"])
        admin = summarise_privileges([p("users", "find", "insert", "update"), p("meta", "find", "insert", "update"),
                                      p("audit", "find", "insert"), p("password_changes", "find", "insert")], "neraveda_access", "adm")
        self.assertIn("admin:", admin["summary"])
        broad = summarise_privileges([p("users", "find"), p("password_changes", "find", "insert", "update")], "neraveda_access", "x")
        self.assertTrue(broad["can_remove"])  # rewriting password changes could undo someone's own change
        self.assertIn("WARNING", broad["summary"])


class ConfigTests(TempRuntime):
    def test_a_pc_can_be_set_up_without_microsoft(self):
        cfg.save_settings(None, None, ["8.8.8.8"])
        cfg.save_secret("reader_uri", "mongodb://reader")
        c = cfg.load_config({})
        self.assertEqual((c.configured, c.microsoft, c.local_mode), (True, False, False))
        self.assertRaises(ValueError, cfg.save_settings, TENANT, None)  # both IDs or neither
        cfg.save_settings(TENANT, CLIENT)
        self.assertTrue(cfg.load_config({}).microsoft)


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


class PasswordSessionTests(FastPasswords, TempRuntime):
    def setUp(self):
        super().setUp()
        self.now = [1_000_000.0]

    def person(self, email="alice@x.com", password="Temp-Pass-1234", temporary=True, **fields):
        verifier, _key = passwords.new_verifier(password)
        return replace(UserAccess(email, "Alice", **fields).with_modules(["oil"]),
                       password=passwords.base_record(verifier, temporary=temporary, epoch=1, set_by="boss@x.com"))

    def service(self, store, config=PASSWORD_ONLY):
        return AccessService(config, store_factory=lambda uri: store, sessions=SessionStore(), clock=lambda: self.now[0])

    def test_a_pc_without_microsoft_offers_password_sign_in_only(self):
        access = self.service(MemoryAccessStore())
        self.assertEqual(access.signin_methods, {"microsoft": False, "password": True})
        self.assertFalse(access.local_mode)
        self.assertIsNone(access.try_silent())
        self.assertRaisesRegex(NotSetUp, "Microsoft sign-in is not set up", access.sign_in)
        self.assertEqual(AccessService(ENTRA, sessions=SessionStore()).signin_methods, {"microsoft": True, "password": True})
        self.assertRaises(NotSetUp, AccessService(AccessConfig(required=False), sessions=SessionStore()).sign_in_with_password, "a@x.com", "x")

    def test_a_temporary_password_must_be_replaced_then_only_the_new_one_works(self):
        store = MemoryAccessStore([self.person()])
        access = self.service(store)
        with self.assertRaises(PasswordChangeRequired):
            access.sign_in_with_password("Alice@X.com", "Temp-Pass-1234")
        self.assertIsNone(SessionStore().load())  # no session until the person has chosen a password
        with self.assertRaisesRegex(PasswordRejected, "at least 12"):
            access.sign_in_with_password("alice@x.com", "Temp-Pass-1234", "short")
        with self.assertRaisesRegex(PasswordRejected, "different"):
            access.sign_in_with_password("alice@x.com", "Temp-Pass-1234", "Temp-Pass-1234")
        session = access.sign_in_with_password("alice@x.com", "Temp-Pass-1234", "Harbour lights 42!")
        self.assertEqual((session.mode, session.modules), ("password", ("oil",)))
        self.assertTrue(access.password_user and access.allows("oil") and not access.is_admin)
        self.assertEqual(actor.current_actor(), "alice@x.com")
        self.assertEqual((len(store.changes), store.audit_log), (1, []))  # the person's own change needs no admin write
        again = self.service(store)
        with self.assertRaisesRegex(AccessDenied, "not correct"):
            again.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        self.assertEqual(again.sign_in_with_password("alice@x.com", "Harbour lights 42!").email, "alice@x.com")
        self.assertEqual(self.service(store).cached().mode, "password")  # the next start uses the stored session

    def test_unknown_id_and_wrong_password_get_the_same_answer_and_attempts_are_limited(self):
        store = MemoryAccessStore([self.person(temporary=False), UserAccess("microsoft-only@x.com")])
        access = self.service(store)
        for email, password in (("nobody@x.com", "x"), ("microsoft-only@x.com", "x"), ("alice@x.com", "wrong"),
                                ("not an id", "x"), ("alice@x.com", "wrong again")):
            with self.assertRaises(AccessDenied) as caught:
                access.sign_in_with_password(email, password)
            self.assertEqual(str(caught.exception), WRONG_PASSWORD)
        with self.assertRaisesRegex(TooManyAttempts, "Try again in 60 seconds"):
            access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        self.now[0] += 61
        self.assertEqual(access.sign_in_with_password("alice@x.com", "Temp-Pass-1234").mode, "password")

    def test_a_deactivated_person_is_told_only_after_the_right_password(self):
        store = MemoryAccessStore([self.person(temporary=False, active=False)])
        with self.assertRaisesRegex(AccessDenied, "deactivated"):
            self.service(store).sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        with self.assertRaisesRegex(AccessDenied, "not correct"):
            self.service(store).sign_in_with_password("alice@x.com", "wrong")

    def test_an_admin_reset_or_removal_ends_the_session_at_the_next_check(self):
        store = MemoryAccessStore([self.person(temporary=False)])
        access = self.service(store)
        access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        access.refresh()
        self.assertTrue(access.signed_in)
        verifier, _key = passwords.new_verifier("New-Temp-5678x")
        store.users["alice@x.com"] = replace(store.users["alice@x.com"], password=passwords.base_record(verifier, temporary=True, epoch=2, set_by="boss@x.com"))
        with self.assertRaisesRegex(SessionExpired, "changed or reset"):
            access.refresh()
        self.assertIsNone(SessionStore().load())
        access.sign_in_with_password("alice@x.com", "New-Temp-5678x", "Harbour lights 42!")
        store.users["alice@x.com"] = replace(store.users["alice@x.com"], password=None)
        with self.assertRaisesRegex(AccessDenied, "removed"):
            access.refresh()

    def test_changing_the_password_needs_the_current_one(self):
        store = MemoryAccessStore([self.person(temporary=False)])
        access = self.service(store)
        access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        with self.assertRaisesRegex(AccessDenied, "current password"):
            access.change_password("wrong", "Harbour lights 42!")
        access.change_password("Temp-Pass-1234", "Harbour lights 42!")
        access.refresh()  # this PC's session follows its own change
        self.assertTrue(access.signed_in)
        self.assertEqual(self.service(store).sign_in_with_password("alice@x.com", "Harbour lights 42!").mode, "password")

    def test_a_planted_change_does_not_let_someone_else_in(self):
        store = MemoryAccessStore([self.person(temporary=False)])
        current = passwords.resolve("alice@x.com", store.users["alice@x.com"].password)
        verifier, key = passwords.new_verifier("attacker chosen pw")
        store.add_password_change(passwords.change_record("alice@x.com", current, key, verifier))
        with self.assertRaises(AccessDenied):
            self.service(store).sign_in_with_password("alice@x.com", "attacker chosen pw")
        self.assertEqual(self.service(store).sign_in_with_password("alice@x.com", "Temp-Pass-1234").mode, "password")

    def test_web_shell_tickets_carry_every_workspace_that_server_hosts(self):
        store = MemoryAccessStore([replace(self.person(temporary=False), grants=()).with_modules(["dd", "evi"])])
        access = self.service(store, AccessConfig(reader_uri="mongodb://reader"))
        access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        grants = lambda key: [g["module"] for g in tickets.verify(
            access.web_secret(key, rotate=True), access.service_headers(key)["x-neraveda-service"], "service", key, now=self.now[0])["grants"]]
        self.assertEqual(grants("sir"), ["dd"])  # Digital Docking runs in the Inspection Reports web shell
        self.assertEqual(grants("evi"), ["evi"])
        self.assertEqual(MODULE_TITLES["dd"], "Digital Docking")

    def test_password_admins_administer_and_get_admin_tickets(self):
        store = MemoryAccessStore([replace(self.person(temporary=False), admin=True)])
        access = self.service(store, AccessConfig(reader_uri="mongodb://reader", admin_uri="mongodb://admin"))
        access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        self.assertTrue(access.is_admin and access.can_administer)
        secret = access.web_secret("sir", rotate=True)
        claims = tickets.verify(secret, access.service_headers("sir")["x-neraveda-service"], "service", "sir", now=self.now[0])
        self.assertTrue(claims["adm"])
        access.sign_out()  # no Microsoft call for a password session
        self.assertIsNone(SessionStore().load())

    def test_an_admin_pc_reset_replaces_a_forgotten_password_and_is_audited(self):
        store = MemoryAccessStore([replace(self.person(temporary=False), admin=True)])
        access = self.service(store)
        access.sign_in_with_password("alice@x.com", "Temp-Pass-1234")
        access.change_password("Temp-Pass-1234", "Harbour lights 42!")  # her own change, then forgotten
        by = {"email": "admin-pc:someone", "oid": None, "name": "reset-password command"}
        store.reset_password(by, "Alice@X.com", passwords.new_verifier("Fresh start 2026!")[0], temporary=False, reason="forgot")
        self.assertEqual(store.users["alice@x.com"].password["epoch"], 2)  # a new epoch: her earlier change no longer counts
        with self.assertRaisesRegex(SessionExpired, "changed or reset"):
            access.refresh()
        for old in ("Temp-Pass-1234", "Harbour lights 42!"):
            with self.assertRaisesRegex(AccessDenied, "not correct"):
                self.service(store).sign_in_with_password("alice@x.com", old)
        self.assertEqual(self.service(store).sign_in_with_password("alice@x.com", "Fresh start 2026!").mode, "password")
        entry = store.audit_log[-1]
        self.assertEqual((entry["action"], entry["changes"], entry["reason"], entry["actor"]["email"]),
                         ("user.update", ["password:set"], "forgot", "admin-pc:someone"))
        self.assertNotIn("verifier", json.dumps(entry))
        with self.assertRaisesRegex(Exception, "not in the access list"):
            store.reset_password(by, "nobody@x.com", passwords.new_verifier("Fresh start 2026!")[0], temporary=False, reason="")

    def test_the_reset_password_command(self):
        from suite_services.access import __main__ as cli
        store = MemoryAccessStore([replace(self.person(temporary=False), admin=True)])
        store.close = lambda: None
        admin_pc = AccessConfig(reader_uri="mongodb://reader", admin_uri="mongodb://admin")
        run = lambda *argv: cli.main(["reset-password", *argv])
        with patch.object(cfg, "load_config", return_value=admin_pc), \
                patch("suite_services.access.store.AccessStore", return_value=store), \
                patch("builtins.print"):
            with patch.object(cli.getpass, "getpass", side_effect=["Fresh start 2026!", "Fresh start 2027!"]):
                self.assertEqual(run("--email", "alice@x.com"), 2)  # typed twice differently: nothing changed
            with patch.object(cli.getpass, "getpass", side_effect=["short", "short"]):
                self.assertEqual(run("--email", "alice@x.com"), 2)
            self.assertEqual(store.users["alice@x.com"].password["epoch"], 1)
            with patch.object(cli.getpass, "getpass", side_effect=["Fresh start 2026!"] * 4):
                self.assertEqual(run("--email", "nobody@x.com"), 2)
                self.assertEqual(run("--email", "Alice@x.com"), 0)
            self.assertEqual(self.service(store).sign_in_with_password("alice@x.com", "Fresh start 2026!").email, "alice@x.com")
            self.assertEqual(run("--email", "alice@x.com", "--temporary"), 0)
            self.assertTrue(store.users["alice@x.com"].password["temporary"])
        with patch.object(cfg, "load_config", return_value=PASSWORD_ONLY), patch("builtins.print"):
            self.assertEqual(run("--email", "alice@x.com"), 2)  # not an admin PC


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


class SecureStoreTests(TempRuntime):
    def test_round_trip_and_purpose_binding(self):
        from suite_services import secure_store
        path = Path(self._tmp.name) / "x.bin"
        secure_store.write_protected(path, b"secret value", "web sir")
        self.assertNotIn(b"secret value", path.read_bytes())
        self.assertEqual(secure_store.read_protected(path, "web sir"), b"secret value")
        self.assertIsNone(secure_store.read_protected(path, "web evi"))  # another purpose cannot unlock it
        self.assertEqual(secure_store.unprotect(secure_store.protect(b"", "empty"), "empty"), b"")

    def test_needs_no_extra_package(self):
        # The NeraVeda shortcut runs on the installed Python, which may not have pywin32.
        from suite_services import secure_store
        self.assertNotIn("import win32crypt", Path(secure_store.__file__).read_text(encoding="utf-8"))

    def test_files_written_with_pywin32_still_open_and_vice_versa(self):
        try:
            import win32crypt
        except ImportError:
            self.skipTest("pywin32 not installed")
        from suite_services import secure_store
        old = win32crypt.CryptProtectData(b"from before", "NeraVeda session", b"session", None, None, 0)
        self.assertEqual(secure_store.unprotect(old, "session"), b"from before")
        _description, clear = win32crypt.CryptUnprotectData(secure_store.protect(b"new", "session"), b"session", None, None, 0)
        self.assertEqual(clear, b"new")


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
            self.save(mode="password")  # signed in with a NeraVeda password
            self.assertEqual(guard.check_module("oil"), (True, "alice@x.com"))
            self.save(mode="local")  # a local-mode session file never opens a workspace once sign-in is set up
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
