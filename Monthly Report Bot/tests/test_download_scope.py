from datetime import datetime
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock, patch

from vessel_report.core import BatchRequest
from vessel_report.downloader import ReportSession


BATTERY = "14.14.05.001 - Battery Condition & load test"
MOORING = "12.07.03.001 - Mooring Matrix"
LUBE_OIL = "12.04.07.021 - LO Stock and consumption report"


def history_row(report, number):
    row = MagicMock()
    date = MagicMock()
    date.count.return_value = 1
    date.inner_text.return_value = "01-Oct-2026"
    order = MagicMock()
    order.first = order
    order.count.return_value = 1
    order.inner_text.return_value = number
    cells = MagicMock()
    cells.all_inner_texts.return_value = [number, report, "01-Oct-2026"]
    row.locator.side_effect = lambda selector: {
        'td[data-field="jobEndDate"]': date,
        'td[data-field="jobOrderNo"]': order,
        "td": cells,
    }[selector]
    return row


class DownloadScopeTests(TestCase):
    def test_slow_results_can_arrive_after_old_thirty_second_limit(self):
        session = ReportSession()
        session._check = MagicMock()
        session._live = MagicMock(return_value=True)
        predicate = MagicMock(side_effect=[False, "ready"])
        with patch("vessel_report.downloader.monotonic", side_effect=[0, 1, 45]):
            self.assertEqual(session._wait(predicate, MagicMock(), "attachments"), "ready")

    def test_ready_results_do_not_wait_for_timeout(self):
        session = ReportSession()
        session._check = MagicMock()
        page = MagicMock()
        self.assertTrue(session._wait(lambda: True, page, "attachments"))
        page.wait_for_timeout.assert_not_called()

    def test_loading_overlay_uses_extended_timeout(self):
        session = ReportSession()
        session._check = MagicMock()
        page = MagicMock()
        session._idle(page)
        self.assertEqual(page.wait_for_function.call_args.kwargs["timeout"], 90000)

    def history(self, names, requested):
        page = MagicMock()
        rows = MagicMock()
        entries = [history_row(name, f"JO-{i}") for i, name in enumerate(names)]
        rows.count.return_value = len(entries)
        rows.nth.side_effect = entries.__getitem__
        page.locator.return_value = rows
        session = ReportSession()
        session._idle = MagicMock()
        session._wait = MagicMock()
        session.log = MagicMock()
        return session._history(page, datetime(2026, 6, 1), datetime(2026, 11, 10), requested)

    def test_folder_history_excludes_other_reports(self):
        matches = self.history([BATTERY, MOORING, "Electrical Insulation Report", BATTERY], BATTERY)
        self.assertEqual([number for _, number in matches], ["JO-0", "JO-3"])

    def test_missing_identity_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "identity could not be verified"):
            self.history(["", "M3", "Electrical Insulation Report"], BATTERY)

    def test_partial_title_is_not_a_match(self):
        self.assertFalse(ReportSession._report_row_matches(
            history_row("Battery Condition & load test - unrelated variant", "JO"), BATTERY))

    def test_title_without_reference_is_supported(self):
        self.assertTrue(ReportSession._report_row_matches(
            history_row("Battery Condition & load test", "JO"), BATTERY))

    def test_lube_oil_subject_variants_match_only_the_requested_report(self):
        for title in (
            "12.04.07.021 - LUBE OIL STOCK AND CONSUMPTION",
            "LUBE OIL STOCK AND CONSUMPTION REPORT",
            "LUB OIL STOCK AND CONSUMPTION REPORT",
            "12.04.07.021",
        ):
            with self.subTest(title=title):
                self.assertTrue(ReportSession._report_row_matches(history_row(title, "JO"), LUBE_OIL))
        self.assertFalse(ReportSession._report_row_matches(
            history_row("12.04.07.022 - LO analysis summary", "JO"), LUBE_OIL))

    def test_attachment_extension_filter_saves_only_xlsx(self):
        self.assertTrue(ReportSession._attachment_matches("LUBE OIL STOCK AND CONSUMPTION.xlsx", (".xlsx",)))
        self.assertTrue(ReportSession._attachment_matches("revised.XLSX", (".xlsx",)))
        self.assertFalse(ReportSession._attachment_matches("report.pdf", (".xlsx",)))
        self.assertFalse(ReportSession._attachment_matches("report.xlsm", (".xlsx",)))

    def test_attachment_download_name_is_checked_before_saving(self):
        session, receipts = ReportSession(), {}
        download = MagicMock(suggested_filename="unexpected.pdf")
        fetch = MagicMock(return_value=download)
        result = session._save_attachment(
            ("attachment",), receipts, Path("."), "reported.xlsx", fetch,
            attachment_extensions=(".xlsx",),
        )
        self.assertIsNone(result)
        self.assertEqual(receipts, {})
        download.save_as.assert_not_called()

    def test_two_vessels_two_reports_are_four_pairs(self):
        request = BatchRequest(("DHT IMPALA", "DHT STALLION"), "Quarterly",
                               (BATTERY, MOORING), datetime(2026, 6, 1),
                               datetime(2026, 11, 10), Path("."))
        self.assertEqual([(job.vessel, job.report) for job in request.jobs],
                         [(vessel, report) for vessel in request.vessels
                          for report in (BATTERY, MOORING)])

    def test_existing_history_marker_is_not_navigation(self):
        session = ReportSession()
        source = MagicMock()
        source.url = "https://example.test/equipment"
        source.is_closed.return_value = False
        source.get_by_text.return_value.first.is_visible.return_value = True
        session.context = MagicMock()
        session.context.pages = [source]
        session._wait = lambda find, *_: self.assertIsNone(find())
        session._idle = MagicMock()
        # Stop at the wait boundary; a stale source must never be returned.
        class EndCheck(Exception):
            pass
        def check(find, *_):
            self.assertIsNone(find())
            raise EndCheck()
        session._wait = check
        with self.assertRaises(EndCheck):
            session._target_page(source, lambda: None, "Job History")
