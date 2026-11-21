"""The NeraVeda home screen with sign-in and per-person workspaces (FakeAccess: no Microsoft, no database)."""
import json
import time
import tkinter as tk
import unittest
from unittest.mock import patch

from abhishek_automation_suite import AutomationSuite
from suite_services import home_intelligence
from suite_services.access import passwords
from suite_services.access.entitlements import UserAccess
from suite_services.access.store import MemoryAccessStore
from suite_services.access.testing import FakeAccess


def pump(app, until, seconds=5.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        app.update()
        if until():
            return True
        time.sleep(0.02)
    return False


class LimitedRightsTests(unittest.TestCase):
    def test_only_granted_workspaces_are_shown_and_others_cannot_be_opened(self):
        app = AutomationSuite(access=FakeAccess(modules=("oil", "evi")))
        try:
            app.update()
            self.assertEqual(app._allowed, ["oil", "evi"])
            self.assertEqual(sorted(app._nav_rows), ["evi", "oil"])
            self.assertEqual(app._card_by_key["vessel"].winfo_manager(), "")  # not placed at all
            self.assertEqual(app._card_by_key["oil"].winfo_manager(), "grid")
            self.assertEqual(app.tiles["vessel"]["frame"].winfo_manager(), "")
            with patch("abhishek_automation_suite.start_vessel_report_manager") as start, \
                    patch("abhishek_automation_suite.messagebox.showinfo") as info:
                app.open_project()
                app.review(home_intelligence.Attention(home_intelligence.REVIEW, "DHT X", "x", "", "vessel", "", ""))
            start.assert_not_called()
            self.assertEqual(info.call_count, 2)
            self.assertIn("do not have access", info.call_args[0][1])
        finally:
            app.destroy()

    def test_nothing_of_a_workspace_without_access_is_read(self):
        calls = []
        providers = {key: (lambda root, today, k=key: calls.append(k) or home_intelligence.Intel(k, "none", "Not yet processed")) for key in home_intelligence.ORDER}
        result = home_intelligence.load_all(providers=providers, allowed=lambda k: k in ("oil",))
        self.assertEqual(calls, ["oil"])
        self.assertEqual(result["sir"].state, "no_access")

    def test_no_workspace_assigned_says_so(self):
        app = AutomationSuite(access=FakeAccess(modules=()))
        try:
            app.update()
            self.assertEqual(app.no_workspace_note.winfo_manager(), "grid")
        finally:
            app.destroy()

    def test_admin_button_only_for_admins_on_an_admin_pc(self):
        for access, shown in ((FakeAccess(), False), (FakeAccess(admin=True), True), (FakeAccess(admin=True, can_administer=False), False)):
            app = AutomationSuite(access=access)
            try:
                app.update()
                self.assertEqual(app.admin_button.winfo_manager() == "pack", shown)
                self.assertEqual(app.sign_out_button.winfo_manager(), "pack")
            finally:
                app.destroy()

    def test_local_mode_shows_no_sign_out(self):
        app = AutomationSuite(access=FakeAccess(local_mode=True))
        try:
            app.update()
            self.assertEqual(app.sign_out_button.winfo_manager(), "")
            self.assertIn("local mode", app.user_note.cget("text"))
        finally:
            app.destroy()

    def test_rights_removed_while_open_take_effect_at_once(self):
        access = FakeAccess(modules=("oil", "sir"))
        app = AutomationSuite(access=access)
        try:
            app.update()
            access.modules = ("oil",)
            app._apply_access()
            app.update()
            self.assertEqual(app._allowed, ["oil"])
            self.assertEqual(app._card_by_key["sir"].winfo_manager(), "")
            self.assertIn(("revoke_web", "sir", 3000), access.calls)  # open browser tabs lose their session
        finally:
            app.destroy()


class SignInTests(unittest.TestCase):
    def test_signed_out_shows_the_sign_in_screen_then_the_home_screen(self):
        access = FakeAccess(signed_in=False)
        app = AutomationSuite(access=access)
        try:
            app.update()
            self.assertIsNotNone(app.signin_panel)
            self.assertFalse(app._dashboard_built)
            self.assertTrue(pump(app, lambda: app.signin_panel.sign_in_button.cget("state") == "normal"))
            app._sign_in_interactive()
            self.assertTrue(pump(app, lambda: app._dashboard_built))
            self.assertIsNone(app.signin_panel)
            self.assertEqual(len(app._allowed), 8)
        finally:
            app.destroy()

    def test_a_pc_without_microsoft_signs_in_with_id_and_password(self):
        access = FakeAccess(signed_in=False, methods={"microsoft": False, "password": True}, password="Right-Pass-1234")
        app = AutomationSuite(access=access)
        try:
            app.update()
            panel = app.signin_panel
            self.assertEqual(panel.sign_in_button.winfo_manager(), "")  # no Microsoft button on this PC
            self.assertEqual(panel.password_entry.winfo_manager(), "pack")
            panel.id_entry.insert(0, "tester@example.com")
            panel.password_entry.insert(0, "wrong")
            panel._submit_password()
            self.assertTrue(pump(app, lambda: "not correct" in panel.detail.get("1.0", "end")))
            self.assertEqual(panel.password_entry.get(), "")  # cleared after a wrong password
            panel.password_entry.insert(0, "Right-Pass-1234")
            panel._submit_password()
            self.assertTrue(pump(app, lambda: app._dashboard_built))
            self.assertEqual(app.password_button.winfo_manager(), "pack")  # "Change password" for password users
        finally:
            app.destroy()

    def test_a_temporary_password_asks_for_the_persons_own_first(self):
        access = FakeAccess(signed_in=False, methods={"microsoft": True, "password": True}, password="Temp-Pass-1234", temporary=True)
        app = AutomationSuite(access=access)
        try:
            app.update()
            panel = app.signin_panel
            self.assertEqual(panel.sign_in_button.winfo_manager(), "pack")  # both methods on this PC
            self.assertTrue(pump(app, lambda: panel.password_button.cget("state") == "normal"))
            panel.id_entry.insert(0, "tester@example.com")
            panel.password_entry.insert(0, "Temp-Pass-1234")
            panel._submit_password()
            self.assertTrue(pump(app, lambda: panel.change_box.winfo_manager() == "pack"))
            self.assertFalse(app._dashboard_built)
            panel.new_entry.insert(0, "Harbour lights 42!")
            panel.confirm_entry.insert(0, "Harbour lights 41!")
            panel._submit_new()
            self.assertIn("do not match", panel.status.cget("text"))
            panel.confirm_entry.delete(0, "end")
            panel.confirm_entry.insert(0, "Harbour lights 42!")
            panel._submit_new()
            self.assertTrue(pump(app, lambda: app._dashboard_built))
            self.assertEqual(access.password, "Harbour lights 42!")
        finally:
            app.destroy()

    def test_microsoft_users_see_no_change_password(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            app.update()
            self.assertEqual(app.password_button.winfo_manager(), "")
        finally:
            app.destroy()

    def test_sign_out_stops_and_closes(self):
        access = FakeAccess()
        app = AutomationSuite(access=access)
        app.update()
        with patch("abhishek_automation_suite.messagebox.askokcancel", return_value=True):
            app.sign_out()
        self.assertIn(("sign_out",), access.calls)
        with self.assertRaises(tk.TclError):
            app.winfo_exists()


class WebWorkspaceTests(unittest.TestCase):
    def test_a_server_from_an_earlier_session_is_restarted_with_this_launchers_secret(self):
        access = FakeAccess(accepts=False)
        app = AutomationSuite(access=access)
        try:
            with patch("abhishek_automation_suite.inspection_server.probe", return_value="sir"), \
                    patch("abhishek_automation_suite.messagebox.askokcancel", return_value=True), \
                    patch("abhishek_automation_suite.inspection_server.stop_listener", return_value=True) as stop, \
                    patch("abhishek_automation_suite.inspection_server.start_server", return_value=(None, "dev")) as start, \
                    patch("abhishek_automation_suite.threading.Thread"):
                app.open_inspection_reports()
            stop.assert_called_once_with(3000)
            self.assertEqual(start.call_args.kwargs["secret"], "0" * 64)
            self.assertIn(("web_secret", "sir", True), access.calls)
        finally:
            app.destroy()

    def test_a_start_failure_is_shown_not_silent(self):
        from suite_services.secure_store import SecureStoreError
        access = FakeAccess()
        app = AutomationSuite(access=access)
        try:
            with patch.object(access, "web_secret", side_effect=SecureStoreError("Windows could not protect the data")), \
                    patch("abhishek_automation_suite.inspection_server.probe", return_value=None), \
                    patch("abhishek_automation_suite.emissions_server.probe", return_value=None), \
                    patch("abhishek_automation_suite.messagebox.showerror") as shown:
                app.open_inspection_reports()
                app.open_emissions_validation()
            self.assertEqual(shown.call_count, 2)
            self.assertIn("Windows could not protect the data", shown.call_args_list[0][0][1])
            self.assertIsNone(app.sir_process)
            self.assertEqual(app.sir_button.cget("state"), "normal")
        finally:
            app.destroy()

    def test_secret_travels_in_the_environment_not_the_command(self):
        from suite_services import inspection_server
        env = inspection_server.server_env("a" * 64, {"MONGODB_URI": "mongodb://x"}, SIR_PORT="3000")
        self.assertEqual((env["NERAVEDA_WEB_SECRET"], env["MONGODB_URI"], env["SIR_PORT"]), ("a" * 64, "mongodb://x", "3000"))
        command = inspection_server.server_command("node", ".", 3000, "start")
        self.assertNotIn("a" * 64, " ".join(command))


class AdminWindowTests(unittest.TestCase):
    def test_admin_adds_a_person_with_workspaces(self):
        store = MemoryAccessStore([UserAccess("boss@x.com", "Boss", admin=True).with_modules(["oil"])])
        access = FakeAccess(admin=True, email="boss@x.com", store=store)
        app = AutomationSuite(access=access)
        try:
            from suite_services.access.ui import AdminWindow
            window = AdminWindow(app, access)
            self.assertTrue(pump(app, lambda: len(window.people) == 1))
            window.new_person()
            window.email.insert(0, "Alice@X.com")
            window.name.insert(0, "Alice")
            window.module_vars["evi"].set(True)
            window.reason.insert(0, "new analyst")
            window.save()
            self.assertTrue(pump(app, lambda: "Saved" in window.status.cget("text")))
            alice = store.get_user("alice@x.com")
            self.assertEqual((alice.name, alice.modules), ("Alice", ("evi",)))
            self.assertEqual(store.audit(target="alice@x.com")[0]["reason"], "new analyst")
            # an admin cannot remove their own admin right
            window._select(store.get_user("boss@x.com"))
            window.admin_var.set(False)
            window.save()
            self.assertIn("cannot remove your own admin right", window.status.cget("text"))
            window.destroy()
        finally:
            app.destroy()

    def test_admin_sets_a_temporary_password_shown_once_and_never_audited(self):
        store = MemoryAccessStore([UserAccess("boss@x.com", "Boss", admin=True).with_modules(["oil"]),
                                   UserAccess("alice@x.com", "Alice").with_modules(["evi"])])
        access = FakeAccess(admin=True, email="boss@x.com", store=store)
        app = AutomationSuite(access=access)
        cost = patch.dict(passwords.COST, {"n": 2 ** 14, "r": 8, "p": 1})
        cost.start()
        try:
            from suite_services.access.ui import AdminWindow
            window = AdminWindow(app, access)
            self.assertTrue(pump(app, lambda: len(window.people) == 2))
            window._select(store.get_user("alice@x.com"))
            self.assertIn("Microsoft only", window.password_state.cget("text"))
            window.set_temporary_password()
            self.assertTrue(pump(app, lambda: window.pending_password is not None))
            temporary = window.pending_password[1]
            with patch("suite_services.access.ui.messagebox.showinfo") as shown:
                window.save()
                self.assertTrue(pump(app, lambda: shown.called))
            self.assertIn(temporary, shown.call_args[0][1])
            alice = store.get_user("alice@x.com")
            current = passwords.resolve(alice.email, alice.password)
            self.assertTrue(current.temporary)
            self.assertIsNotNone(passwords.matches(temporary, current.verifier))
            self.assertIn("password:temporary", store.audit(target="alice@x.com")[0]["changes"])
            self.assertNotIn(temporary, json.dumps(store.audit_log))
            self.assertNotIn(alice.password["verifier"]["pub"], json.dumps(store.audit_log))
            window.destroy()
        finally:
            cost.stop()
            app.destroy()


if __name__ == "__main__":
    unittest.main()
