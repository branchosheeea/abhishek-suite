"""Local Edge fixtures only; no MariApps sign-in or downloads.

Run explicitly: python -m unittest tests.test_portal_selectors -v
"""
import os
import unittest
from unittest.mock import MagicMock

from playwright.sync_api import sync_playwright
from vessel_report.downloader import ReportSession


@unittest.skipUnless(os.environ.get("RUN_EDGE_FIXTURES") == "1",
                     "Set RUN_EDGE_FIXTURES=1 to run local Edge fixtures")
class PortalSelectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel="msedge", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(2000)
        self.session = ReportSession()
        self.session._idle = MagicMock()

    def tearDown(self):
        self.page.close()

    def test_hidden_duplicates_and_tree_are_not_report_matches(self):
        self.page.set_content("""
            <div>Lub Oil Consumption Trend</div>
            <table style="display:none"><tbody><tr><td>Lub Oil Consumption Trend</td></tr></tbody></table>
            <table><tbody>
              <tr style="display:none"><td>Lub Oil Consumption Trend</td></tr>
              <tr><td id="requested">Lub Oil Consumption Trend</td></tr>
              <tr><td>Mooring Matrix</td></tr>
            </tbody></table>
        """)
        result = self.session._find_report(self.page, "Lub Oil Consumption Trend")
        self.assertEqual(result.get_attribute("id"), "requested")

    def test_real_visible_duplicates_are_rejected(self):
        self.page.set_content("<table><tbody>" +
                             "<tr><td>Lub Oil Consumption Trend</td></tr>" * 2 +
                             "</tbody></table>")
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            self.session._find_report(self.page, "Lub Oil Consumption Trend")

    def test_code_and_name_in_separate_cells(self):
        self.page.set_content("<table><tbody><tr><td>14.14.05.002</td>"
                              "<td>GMDSS Battery Load Test</td></tr></tbody></table>")
        # Multiple cells in the same row identify one report, not two reports.
        result = self.session._find_report(self.page, "14.14.05.002 - GMDSS Battery Load Test")
        self.assertEqual(result.count(), 1)

    def test_case_whitespace_and_dash_variants(self):
        for value in ("14.14.05.002–GMDSS Battery Load Test",
                      "14.14.05.002 - GMDSS BATTERY LOAD TEST",
                      "GMDSS  Battery Load Test"):
            with self.subTest(value=value):
                self.page.set_content(f"<table><tbody><tr><td>{value}</td></tr></tbody></table>")
                self.assertEqual(self.session._find_report(
                    self.page, "14.14.05.002 - GMDSS Battery Load Test").count(), 1)

    def test_current_vessel_does_not_open_hidden_dropdown(self):
        self.page.set_content("""
            <input aria-controls="vesselSearchBox_listbox" value="DHT STALLION">
            <div id="vesselSearchBox_listbox" style="display:none"><h5>DHT STALLION</h5></div>
        """)
        self.session._select_vessel(self.page, "DHT STALLION")
        self.assertEqual(self.session.current_vessel, "DHT STALLION")
        self.assertFalse(self.page.locator("#vesselSearchBox_listbox").is_visible())

    def test_attachment_zero_is_immediate_empty_state(self):
        self.page.set_content("<button>Attachments 0</button><div>Add File</div>")
        self.assertEqual(ReportSession._attachment_state(self.page), "empty")

    def test_download_icon_is_file_state(self):
        self.page.set_content("<a class='download-icon'>Download</a>")
        self.assertEqual(ReportSession._attachment_state(self.page), "files")
