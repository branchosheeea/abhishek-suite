"""Home page summaries added for audit item P1-7: Digital Docking, Vessel Report Centre's last run, and SIR reports that
are only on this device. Temporary folders only; no server, portal or browser."""
from datetime import date, datetime
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from suite_services import home_intelligence as hi
from vessel_report.core import BatchRequest
from vessel_report.run_summary import build_run_summary, save_run_summary

TODAY = date(2026, 11, 24)


class HomeSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    # ── Vessel Report Centre ──────────────────────────────────────────────────

    def test_vessel_report_shows_the_last_saved_run_and_its_problem_reports(self):
        self.assertEqual(hi.vessel_report_intel(self.root, TODAY).state, "not_connected")
        request = BatchRequest(("DHT COLT", "DHT TIGER"), "Monthly", ("Main Engine Running Hours",),
                               datetime(2026, 10, 1), datetime(2026, 10, 31), Path("C:/Downloads/VRC"))
        results = [
            {"vessel": "DHT COLT", "report": "Main Engine Running Hours", "status": "Downloaded", "paths": ["a.pdf"], "error": ""},
            {"vessel": "DHT TIGER", "report": "Main Engine Running Hours", "status": "Needs attention", "paths": [], "error": "Job plan not found"},
        ]
        summary = build_run_summary(request, results, {"completed": 2, "files": 1, "failed": 1, "stopped": False},
                                    now=datetime(2026, 11, 24, 9, 30))
        save_run_summary(summary, self.root)
        intel = hi.vessel_report_intel(self.root, TODAY)
        self.assertEqual(intel.state, "ok")
        self.assertEqual(intel.headline, "Last run: 1 file collected")
        self.assertIn("2 vessels", intel.context)
        self.assertEqual([(a.vessel, a.issue) for a in intel.attention], [("DHT TIGER", "Main Engine Running Hours needs attention")])
        self.assertNotIn("a.pdf", json.dumps(summary), "no attachment paths are kept")

    # ── Digital Docking ───────────────────────────────────────────────────────

    def test_docking_shows_the_current_docking_and_missing_daily_reports(self):
        self.assertEqual(hi.docking_intel(self.root, TODAY).state, "not_connected")
        self.write(hi.docking_cache_path(self.root), {"fetchedAt": "2026-11-24T09:00:00", "dockings": [
            {"id": "d1", "code": "LEO-2026-SS", "vessel": "DHT LEOPARD", "status": "active", "day0": "2026-11-18",
             "daysSoFar": 7, "received": 4, "reviewed": 3, "noReport": 0, "missingDays": [2, 5], "latestReportDate": "2026-11-23", "jobs": 9},
            {"id": "d0", "code": "TIG-2025-IS", "vessel": "DHT TIGER", "status": "completed", "day0": "2025-03-01",
             "daysSoFar": 12, "received": 10, "reviewed": 10, "noReport": 0, "missingDays": [4], "latestReportDate": "2025-03-12", "jobs": 3},
        ]})
        intel = hi.docking_intel(self.root, TODAY)
        self.assertEqual(intel.headline, "Latest: DHT LEOPARD")
        self.assertIn("4 of 7 days received, 3 reviewed", intel.context)
        self.assertEqual(len(intel.attention), 1, "a completed docking raises no attention")
        item = intel.attention[0]
        self.assertEqual((item.issue, item.target), ("2 daily reports not received", "docking/d1"))

    def test_docking_with_no_dockings_says_so(self):
        self.write(hi.docking_cache_path(self.root), {"fetchedAt": "2026-11-24T09:00:00", "dockings": []})
        self.assertEqual(hi.docking_intel(self.root, TODAY).state, "none")

    def test_the_docking_summary_is_fetched_and_cached(self):
        body = json.dumps({"app": "neraveda-docking", "dockings": []}).encode()
        with patch("suite_services.home_intelligence.urllib.request.urlopen", return_value=io.BytesIO(body)) as opened:
            opened.return_value.__enter__ = lambda s: s
            opened.return_value.__exit__ = lambda s, *a: None
            hi.fetch_docking_summary(3000, root=self.root, headers={"x-neraveda-service": "t"})
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:3000/api/docking/summary")
        self.assertIn("fetchedAt", json.loads(hi.docking_cache_path(self.root).read_text(encoding="utf-8")))

    # ── Inspection Reports only on this device ────────────────────────────────

    def test_sir_reports_only_on_this_device_are_shown(self):
        report = {"id": "r1", "vessel": "DHT COLT", "dateFrom": "2026-11-20", "updatedAt": 1, "progress": 40, "actionRequired": []}
        self.write(hi.sir_cache_path(self.root), {"fetchedAt": "2026-11-24T09:00:00", "reports": [report],
                                                   "device": {"reports": 3, "pending": 2, "conflicts": 1, "locked": 0, "at": 1764000000000}})
        issues = [a.issue for a in hi.sir_intel(self.root, TODAY).attention]
        self.assertEqual(issues, ["2 reports only on this device", "1 report waiting for your decision"])

    def test_sir_without_device_information_is_unchanged(self):
        self.write(hi.sir_cache_path(self.root), {"fetchedAt": "2026-11-24T09:00:00", "reports": []})
        intel = hi.sir_intel(self.root, TODAY)
        self.assertEqual((intel.state, intel.attention), ("none", []))


if __name__ == "__main__":
    unittest.main()
