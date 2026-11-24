import os
import subprocess
import sys
import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch

import customtkinter as ctk

from abhishek_automation_suite import (
    AutomationSuite,
    PROJECT_ROOT,
    _project_python,
    start_lub_oil_review,
    start_vessel_report_manager,
    start_gc_manager,
)
from suite_services import home_intelligence
from suite_services.access.testing import FakeAccess

# The dashboard starts the daily suite backup; never let a test back up this PC's real data.
os.environ["NERAVEDA_NO_BACKUP"] = "1"


class SuiteLauncherTests(unittest.TestCase):
    def test_project_one_launches_existing_report_ui(self):
        with patch("abhishek_automation_suite.subprocess.Popen") as popen:
            process = start_vessel_report_manager()

        self.assertIs(process, popen.return_value)
        popen.assert_called_once_with(
            [_project_python(PROJECT_ROOT), "-m", "vessel_report"],
            cwd=str(PROJECT_ROOT), creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def test_missing_project_entry_point_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaises(FileNotFoundError):
                start_vessel_report_manager(Path(temporary_directory))

    def test_project_two_launches_lube_oil_review_module(self):
        with patch("abhishek_automation_suite.subprocess.Popen") as popen:
            process = start_lub_oil_review()

        self.assertIs(process, popen.return_value)
        popen.assert_called_once_with(
            [_project_python(PROJECT_ROOT), "-m", "lube_oil"],
            cwd=str(PROJECT_ROOT), creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def test_project_two_prefers_project_virtual_environment(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_root = Path(temporary_directory)
            entry_point = project_root / "lube_oil" / "__main__.py"
            entry_point.parent.mkdir()
            entry_point.touch()
            environment_python = project_root / ".venv" / "Scripts" / "python.exe"
            environment_python.parent.mkdir(parents=True)
            environment_python.touch()

            with patch("abhishek_automation_suite.subprocess.Popen") as popen:
                start_lub_oil_review(project_root)

        popen.assert_called_once_with(
            [str(environment_python), "-m", "lube_oil"],
            cwd=str(project_root), creationflags=subprocess.CREATE_NO_WINDOW,
        )

    def test_project_four_launches_guarantee_claim_manager(self):
        with patch("abhishek_automation_suite.subprocess.Popen") as popen:
            process=start_gc_manager()
        self.assertIs(process,popen.return_value)
        popen.assert_called_once_with([_project_python(PROJECT_ROOT),"-m","gc_manager"],cwd=str(PROJECT_ROOT),
                                      creationflags=subprocess.CREATE_NO_WINDOW)

    def test_missing_project_four_module_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaises(FileNotFoundError):start_gc_manager(Path(temporary_directory))

    def test_missing_project_two_module_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            with self.assertRaises(FileNotFoundError):
                start_lub_oil_review(Path(temporary_directory))

    def test_inspection_report_is_workspace_six(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            self.assertEqual(len(app._cards), 8)  # 07 is DNV Emissions Validation, 08 Digital Docking
            self.assertEqual(app.sir_button.cget("text"), "Open Inspection Reports")
            self.assertEqual(app.dd_button.cget("text"), "Open Digital Docking")
            self.assertEqual(app.title(), "NeraVeda")
            self.assertEqual(list(app.tiles), list(home_intelligence.ORDER))
        finally:
            app.destroy()

    def test_unavailable_results_render_as_states_not_zero(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            with tempfile.TemporaryDirectory() as empty:
                app.intel = home_intelligence.load_all(Path(empty))
            app.render_intelligence()
            app.update()
            # Vessel Report Centre now saves its last run for Home (audit P1-7); with none saved yet it says so.
            self.assertEqual(app.tiles["vessel"]["headline"].cget("text"), "No collection run saved yet")
            self.assertEqual(app.tiles["voyage"]["headline"].cget("text"), "Not connected to Home")
            self.assertEqual(app.tiles["oil"]["headline"].cget("text"), "Not yet processed")
            self.assertEqual(app.tiles["cjc"]["headline"].cget("text"), "Not yet processed")
            for tile in app.tiles.values():
                self.assertNotRegex(tile["headline"].cget("text"), r"^0\b")
            [message] = app.attention_box.winfo_children()
            self.assertIn("Not included because no completed result is available", message.cget("text"))
        finally:
            app.destroy()

    def test_one_card_per_workspace_with_its_saved_result_and_attention_count(self):
        app = AutomationSuite(access=FakeAccess(local_mode=True))
        try:
            review = home_intelligence.Attention(home_intelligence.REVIEW, "DHT X", "issue", "reason", "oil", "", "")
            action = home_intelligence.Attention(home_intelligence.ACTION, "DHT Y", "issue", "reason", "oil", "", "")
            intel = {key: home_intelligence.Intel(key, "none", "Not yet processed") for key in home_intelligence.ORDER}
            intel["oil"] = home_intelligence.Intel("oil", "ok", "October 2026 sheets", "9 vessel sheets in use",
                                                   "Processed 15 Nov", attention=[review, review, action])
            app.intel = intel
            app.render_intelligence()
            app.update()
            oil = app._card_by_key["oil"]
            self.assertEqual((oil.headline.cget("text"), oil.context.cget("text")), ("October 2026 sheets", "9 vessel sheets in use"))
            self.assertIn("1 needs action · 2 to review", oil.chip.cget("text"))
            self.assertEqual(oil.chip.winfo_manager(), "grid")
            vessel = app._card_by_key["vessel"]
            self.assertEqual(vessel.chip.winfo_manager(), "")  # nothing to count: no chip
            self.assertEqual(vessel.context.winfo_manager(), "")  # empty lines are hidden, not blank gaps
            self.assertFalse(hasattr(app, "tile_host"))  # no second box per workspace any more
            self.assertEqual(app.tiles["oil"]["frame"], oil)
            # The header stays compact in local mode (no empty button row stretching it).
            scale = ctk.ScalingTracker.get_widget_scaling(app)
            self.assertLess(app.user_box.winfo_reqheight() / scale, 80)
            self.assertEqual(AutomationSuite.attention_chip([]), None)
            self.assertEqual(AutomationSuite.attention_chip([review]), ("1 to review", home_intelligence.REVIEW))
        finally:
            app.destroy()

    def test_review_opens_the_workspace_that_produced_the_item(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            item = home_intelligence.Attention(home_intelligence.REVIEW, "DHT COLT", "Reconcile stock", "reason",
                                               "oil", "October 2026 sheet", "Imported 11 Nov")
            with patch.object(app, "open_lub_oil") as open_lub_oil:
                app.review(item)
            open_lub_oil.assert_called_once_with()
            sir_item = home_intelligence.Attention(home_intelligence.ACTION, "DHT X", "2 items", "", "sir", "", "",
                                                   target="inspections/report?id=abcdefgh12")
            with patch("abhishek_automation_suite.inspection_server.probe", return_value="sir"), \
                    patch("abhishek_automation_suite.webbrowser.open") as browser:
                app.review(sir_item)
            browser.assert_called_once_with("http://localhost:3000/api/auth/enter?t=test&next=/inspections/report?id=abcdefgh12")
        finally:
            app.destroy()

    def test_workspace_buttons_take_keyboard_focus_and_show_a_ring(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            app.update()
            # Tab traversal reaches the home and workspace controls, in reading order.
            order, widget = [], app
            for _ in range(40):
                widget = widget.tk_focusNext()
                if widget is None or str(widget) in order:
                    break
                order.append(str(widget))
            buttons = [str(b) for b in (app.reload_button, app.launch_button, app.oil_button, app.voyage_button,
                                         app.gc_button, app.cjc_button, app.sir_button, app.evi_button)]
            self.assertEqual([name for name in order if name in buttons], buttons)
            # Focus the button itself, as Tab does (CTkButton.focus_force targets its inner label).
            tk.Frame.focus_force(app.oil_button)
            app.update()
            self.assertEqual(app.oil_button.cget("border_width"), 2)
            tk.Frame.focus_force(app.voyage_button)
            app.update()
            self.assertEqual(app.oil_button.cget("border_width"), 0)
            # Enter activates the focused button through the normal launch path (launcher patched: nothing starts).
            with patch("abhishek_automation_suite.start_voyage_summary") as start:
                app.voyage_button.event_generate("<Return>")
                app.update()
            start.assert_called_once_with()
            self.assertEqual(app.voyage_button.cget("text"), "Voyage Summary is open")
        finally:
            app.destroy()

    def test_inspection_report_reuses_a_server_that_is_already_running(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            with patch("abhishek_automation_suite.inspection_server.probe", return_value="sir"), \
                    patch("abhishek_automation_suite.inspection_server.start_server") as start, \
                    patch("abhishek_automation_suite.webbrowser.open") as browser:
                app.open_inspection_reports()
            start.assert_not_called()
            browser.assert_called_once_with("http://localhost:3000/api/auth/enter?t=test&next=/inspections")
        finally:
            app.destroy()

    def test_inspection_report_refuses_a_port_used_by_another_program(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            with patch("abhishek_automation_suite.inspection_server.probe", return_value="other"), \
                    patch("abhishek_automation_suite.inspection_server.start_server") as start, \
                    patch("abhishek_automation_suite.messagebox.showerror") as error:
                app.open_inspection_reports()
            start.assert_not_called()
            error.assert_called_once()
        finally:
            app.destroy()

    def test_launcher_scrolls_when_content_exceeds_window(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            app.minsize(1, 1)
            app.geometry("920x360")
            app.update()

            canvas = app.page._parent_canvas
            before = canvas.yview()
            self.assertLess(before[1], 1)

            app.launch_button.event_generate("<MouseWheel>", delta=-120)
            app.update()

            self.assertGreater(canvas.yview()[0], before[0])
        finally:
            app.destroy()


if __name__ == "__main__":
    unittest.main()
