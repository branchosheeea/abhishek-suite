import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from abhishek_automation_suite import (
    AutomationSuite,
    PROJECT_ROOT,
    _project_python,
    start_lub_oil_review,
    start_vessel_report_manager,
    start_gc_manager,
)


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

    def test_launcher_scrolls_when_content_exceeds_window(self):
        app = AutomationSuite()
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
