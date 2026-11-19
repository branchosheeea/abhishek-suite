"""Workspace 07 (DNV Emissions Validation): desktop card, local server control and the Home tile."""
import json
import re
import socket
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from abhishek_automation_suite import AutomationSuite, WORKSPACES
from report_catalog import VESSELS
from suite_services import emissions_server
from suite_services import home_intelligence as home
from suite_services.access.testing import FakeAccess

APP = Path(__file__).resolve().parents[1] / emissions_server.EVI_FOLDER
TODAY = date(2026, 11, 18)


def test_emissions_fleet_list_matches_report_catalog():
    source = (APP / "lib" / "vessels.ts").read_text(encoding="utf-8")
    block = re.search(r"FLEET_VESSELS = \[(.*?)\] as const", source, re.S)
    assert block, "FLEET_VESSELS not found in lib/vessels.ts"
    assert re.findall(r'"([^"]+)"', block.group(1)) == VESSELS


class EmissionsServerTests(unittest.TestCase):
    def test_app_folder_and_health_marker(self):
        self.assertTrue((APP / "package.json").is_file())
        health = (APP / "app" / "api" / "health" / "route.ts").read_text(encoding="utf-8")
        self.assertIn(emissions_server.HEALTH_MARKER.strip('"'), health)
        with tempfile.TemporaryDirectory() as empty, self.assertRaises(FileNotFoundError):
            emissions_server.app_dir(Path(empty))

    def test_port_defaults_and_validation(self):
        with patch.dict("os.environ", {"EMISSIONS_PORT": "notaport"}):
            self.assertEqual(emissions_server.server_port(), 3001)
        with patch.dict("os.environ", {"EMISSIONS_PORT": "80"}):
            self.assertEqual(emissions_server.server_port(), 3001)
        with patch.dict("os.environ", {"EMISSIONS_PORT": "3105"}):
            self.assertEqual(emissions_server.server_port(), 3105)
        self.assertEqual(emissions_server.app_url(3001), "http://localhost:3001/")

    def test_probe_free_port_and_stale_build(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            free = s.getsockname()[1]
        self.assertIsNone(emissions_server.probe(free))
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "app").mkdir()
            (Path(folder) / "app" / "page.tsx").write_text("x")
            self.assertEqual(emissions_server.server_mode(Path(folder)), "dev")

    def test_server_listens_on_localhost_only(self):
        command = emissions_server.server_command("node", APP, 3001, "start")
        self.assertIn("127.0.0.1", command)


class EmissionsHomeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def write(self, summary):
        path = home.evi_cache_path(self.root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fetchedAt": "2026-11-18T09:00:00", **summary}), encoding="utf-8")

    def test_states_are_never_zero_or_all_clear(self):
        self.assertEqual(home.evi_intel(self.root, TODAY).state, "not_connected")
        self.write({"configured": False, "sessions": []})
        self.assertEqual(home.evi_intel(self.root, TODAY).headline, "Storage not configured")
        self.write({"configured": True, "sessions": [{"id": "s1", "vessel": "DHT COLT", "period": None, "run": None}]})
        intel = home.evi_intel(self.root, TODAY)
        self.assertEqual((intel.state, intel.headline), ("none", "Not yet validated"))

    def test_latest_run_and_attention(self):
        run = {"id": "r1", "finishedAt": "2026-11-17T10:00:00Z", "summary": {"errors": 3, "warnings": 5, "dnv": 4, "dnvReproduced": 2, "dnvUnresolved": 1}}
        self.write({"configured": True, "sessions": [{"id": "abcdefgh12", "vessel": "DHT COLT", "period": {"from": "2025-01-01", "to": "2025-12-31"}, "run": run}]})
        intel = home.evi_intel(self.root, TODAY)
        self.assertEqual(intel.state, "ok")
        self.assertEqual(intel.headline, "Latest: DHT COLT")
        self.assertIn("3 errors, 5 warnings", intel.context)
        self.assertIn("4 DNV items: 2 reproduced, 1 unresolved", intel.outcome)
        [item] = intel.attention
        self.assertEqual((item.severity, item.workspace, item.target), (home.REVIEW, "evi", "sessions/abcdefgh12"))
        self.assertIn("not confirmed reporting errors", item.reason)


class EmissionsCardTests(unittest.TestCase):
    def test_card_seven_and_review_opens_the_session(self):
        self.assertEqual([w[0] for w in WORKSPACES][-1], "evi")
        app = AutomationSuite(access=FakeAccess())
        try:
            self.assertEqual(app.evi_button.cget("text"), "Open Emissions Validation")
            self.assertEqual(list(app.tiles)[-1], "evi")
            item = home.Attention(home.REVIEW, "DHT COLT", "3 errors", "", "evi", "", "", target="sessions/abcdefgh12")
            with patch("abhishek_automation_suite.emissions_server.probe", return_value="evi"), \
                    patch("abhishek_automation_suite.emissions_server.start_server") as start, \
                    patch("abhishek_automation_suite.webbrowser.open") as browser:
                app.review(item)
            start.assert_not_called()
            browser.assert_called_once_with("http://localhost:3001/api/auth/enter?t=test&next=/sessions/abcdefgh12")
        finally:
            app.destroy()

    def test_refuses_a_port_used_by_another_program(self):
        app = AutomationSuite(access=FakeAccess())
        try:
            with patch("abhishek_automation_suite.emissions_server.probe", return_value="other"), \
                    patch("abhishek_automation_suite.emissions_server.start_server") as start, \
                    patch("abhishek_automation_suite.messagebox.showerror") as error:
                app.open_emissions_validation()
            start.assert_not_called()
            error.assert_called_once()
        finally:
            app.destroy()


if __name__ == "__main__":
    unittest.main()
