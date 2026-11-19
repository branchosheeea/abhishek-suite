"""NeraVeda home intelligence: truthful states, module-defined exceptions, isolation and ranking."""
import http.server
import json
import re
import sys
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for extra in (ROOT / "Critical Jobs Compliance", Path(__file__).resolve().parent):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from cjc.models import Check, JobPlan, Reconciliation  # noqa: E402
from cjc.store import Store  # noqa: E402
from gc_manager.repository import Repository as ClaimRepository  # noqa: E402
from lube_oil.repository import Repository as LubeRepository  # noqa: E402
from suite_services import home_intelligence as home  # noqa: E402
from test_lube_oil_review import create_report  # noqa: E402

TODAY = date(2026, 11, 16)
FALSE_CLEAR = re.compile(r"\ball clear\b|\bhealthy\b|\bcomplete\b(?!d)|\bcurrent\b|^0\b|\b0 (exceptions|items|issues)", re.I)


def _texts(intel):
    return [intel.headline, intel.context, intel.freshness, intel.outcome, intel.updated]


class HomeIntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    # ── Missing data ────────────────────────────────────────────────────────

    def test_no_data_is_never_reported_as_zero_or_all_clear(self):
        intel = home.load_all(self.root, TODAY)
        self.assertEqual(list(intel), list(home.ORDER))
        expected = {"vessel": "not_connected", "oil": "none", "voyage": "not_connected",
                    "gc": "none", "cjc": "none", "sir": "not_connected", "evi": "not_connected"}
        self.assertEqual({k: v.state for k, v in intel.items()}, expected)
        for item in intel.values():
            for text in _texts(item):
                self.assertNotRegex(text, FALSE_CLEAR, f"{item.key}: {text!r}")
        self.assertEqual(home.top_attention(intel), ([], {}))

    # ── Lub Oil Review ──────────────────────────────────────────────────────

    def test_lube_review_item_uses_the_module_decision_brief_and_keeps_its_month(self):
        source = self.root / "sources"
        source.mkdir()
        create_report(source / "colt.xlsx", actual_rob=80, shortage=20)
        (source / "broken.xlsx").write_bytes(b"not a workbook")
        repository = LubeRepository(self.root)
        repository.import_file(source / "colt.xlsx")
        repository.import_file(source / "broken.xlsx")

        intel = home.lube_intel(self.root, TODAY)
        self.assertEqual(intel.state, "ok")
        self.assertEqual(intel.headline, "January 2026 sheets")  # historical period stays visible
        self.assertIn("Processed", intel.freshness)
        self.assertIn("1 file not imported", intel.updated)
        stock = next(i for i in intel.attention if i.vessel == "DHT COLT")
        self.assertEqual(stock.severity, home.REVIEW)
        self.assertEqual(stock.issue, "Reconcile stated stock before making a purchase decision")
        self.assertEqual(stock.period, "January 2026 sheet")
        failed = next(i for i in intel.attention if i.vessel == "Vessel not identified")
        self.assertEqual(failed.issue, "1 source file could not be imported")

    def test_lube_verified_zero_is_stated_only_after_processing(self):
        source = self.root / "colt.xlsx"
        create_report(source)
        LubeRepository(self.root).import_file(source)
        intel = home.lube_intel(self.root, TODAY)
        self.assertEqual(intel.attention, [])
        self.assertEqual(intel.outcome, "No priority exception in the latest sheet of 1 vessel")

    # ── Guarantee Claims ────────────────────────────────────────────────────

    def test_gc_items_come_from_the_module_attention_rules(self):
        repository = ClaimRepository(self.root)
        vessels = {v["name"].casefold(): v["id"] for v in repository.vessels()}
        overdue = repository.create_claim(vessels["dht impala"], "GC-014", title="ME fuel pump")
        repository.update_claim(overdue, next_follow_up_date="2026-11-10")
        repository.create_claim(vessels["dht leopard"], "GC-015", title="Steering pump")  # no flags

        intel = home.gc_intel(self.root, TODAY)
        self.assertEqual(intel.headline, "2 open claims")
        self.assertEqual(intel.outcome, "1 claim flagged by follow-up rules")
        [item] = [i for i in intel.attention if i.workspace == "gc" and i.vessel == "DHT IMPALA"]
        self.assertEqual(item.severity, home.ACTION)  # OVERDUE is red in the GC workspace too
        self.assertIn("GC-014", item.issue)
        self.assertIn("Follow-up overdue", item.issue)
        self.assertIn("10 Nov", item.reason)
        self.assertFalse(any(i.vessel == "DHT LEOPARD" for i in intel.attention))

    # ── Critical Jobs ───────────────────────────────────────────────────────

    def test_cjc_failed_extraction_needs_review_and_verified_run_reports_its_window(self):
        store = Store(self.root)
        failed = store.start_run("DHT IMPALA", date(2026, 10, 1), date(2026, 10, 31), {})
        store.fail_run(failed, "Sign-in expired")
        verified = store.start_run("DHT BRONCO", date(2025, 12, 1), date(2026, 11, 15), {})
        plans = [JobPlan.from_portal({"jobPlanId": n, "title": f"Job {n}"}) for n in (1, 2, 3)]
        store.finish_run(verified, plans, Reconciliation(3, 3, [Check("counts", True, "ok")]))

        intel = home.cjc_intel(self.root, TODAY)
        self.assertEqual(intel.state, "ok")
        self.assertEqual(intel.headline, "DHT BRONCO · population verified")
        self.assertIn("1 Dec 2025 – 15 Nov", intel.context)
        self.assertIn("compliance not yet assessed", intel.freshness)  # not presented as compliant
        [item] = intel.attention
        self.assertEqual((item.vessel, item.severity, item.reason), ("DHT IMPALA", home.REVIEW, "Sign-in expired"))

    # ── Superintendent Inspection Report ────────────────────────────────────

    def _write_summary(self, reports):
        path = home.sir_cache_path(self.root)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"fetchedAt": "2026-11-16T09:30:00", "reports": reports}), encoding="utf-8")

    def test_signed_off_report_with_action_items_shows_both_states(self):
        long_vessel = "DHT EXTRAORDINARILY LONG VESSEL NAME FOR LAYOUT TESTING"
        self._write_summary([{
            "id": "abcdef123456", "vessel": long_vessel, "dateFrom": "2026-09-12", "updatedAt": 1794811685359,
            "progress": 100, "signedOff": True, "actionRequired": ["Main engine", "Steering gear"],
            "ratedCount": 25, "itemCount": 25,
        }])
        intel = home.sir_intel(self.root, TODAY)
        self.assertEqual(intel.headline, f"Latest: {long_vessel}")
        self.assertEqual(intel.outcome, "Signed off · 2 items rated Action required")
        self.assertIn("finding closure not tracked", intel.freshness)
        [item] = intel.attention
        self.assertEqual(item.severity, home.ACTION)
        self.assertEqual(item.target, "inspections/report?id=abcdef123456")
        self.assertEqual(item.period, "Inspection 12 Sep")

    def test_draft_without_ratings_is_not_an_alert(self):
        self._write_summary([{"id": "x" * 12, "vessel": "", "updatedAt": 1794811685359, "progress": 13,
                              "signedOff": False, "actionRequired": [], "ratedCount": 0, "itemCount": 25}])
        intel = home.sir_intel(self.root, TODAY)
        self.assertEqual(intel.attention, [])
        self.assertEqual(intel.headline, "Latest: Untitled inspection")
        self.assertIn("Draft · 13% complete", intel.context)
        self.assertIn("Inspection date not entered", intel.context)

    def test_summary_fetch_is_cached_with_its_fetch_time(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"reports": []}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            home.fetch_inspection_summary(server.server_address[1], self.root)
        finally:
            server.shutdown()
        cached = json.loads(home.sir_cache_path(self.root).read_text(encoding="utf-8"))
        self.assertIn("fetchedAt", cached)
        self.assertEqual(home.sir_intel(self.root, TODAY).state, "none")

    # ── Isolation and ranking ───────────────────────────────────────────────

    def test_one_failing_workspace_does_not_block_the_others(self):
        def broken(root, today):
            raise RuntimeError("database is locked")

        providers = dict(home.PROVIDERS, gc=broken)
        intel = home.load_all(self.root, TODAY, providers)
        self.assertEqual(intel["gc"].state, "error")
        self.assertIn("database is locked", intel["gc"].context)
        self.assertEqual(intel["cjc"].state, "none")

    def test_ranking_puts_action_first_and_alternates_workspaces(self):
        def item(workspace, severity, n):
            return home.Attention(severity, f"V{n}", "issue " * 40, "reason", workspace, "Oct 2026", "today", rank=(n,))

        intel = {
            "oil": home.Intel("oil", "ok", "", attention=[item("oil", home.REVIEW, n) for n in range(6)]),
            "gc": home.Intel("gc", "ok", "", attention=[item("gc", home.REVIEW, n) for n in range(3)]),
            "sir": home.Intel("sir", "ok", "", attention=[item("sir", home.ACTION, 0)]),
        }
        shown, hidden = home.top_attention(intel, limit=4)
        self.assertEqual([(i.workspace, i.severity) for i in shown],
                         [("sir", home.ACTION), ("oil", home.REVIEW), ("gc", home.REVIEW), ("oil", home.REVIEW)])
        self.assertEqual(hidden, {"oil": 4, "gc": 2})


if __name__ == "__main__":
    unittest.main()
