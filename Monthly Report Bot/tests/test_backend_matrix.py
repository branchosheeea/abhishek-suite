"""Backend scenario matrix. No portal requests or production downloads."""
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, get_ident
from unittest import TestCase
from unittest.mock import MagicMock
import os
import unittest

from report_catalog import VESSELS, REPORTS_BY_FREQUENCY
from vessel_report.core import BatchRequest, DownloadError, ReportJob, SessionInterrupted, run_batch
from vessel_report.downloader import ReportSession


class BackendMatrixTests(TestCase):
    def test_every_catalog_frequency_and_fleet_combination(self):
        for frequency, reports in REPORTS_BY_FREQUENCY.items():
            with self.subTest(frequency=frequency):
                request = BatchRequest(tuple(VESSELS), frequency, tuple(reports),
                    datetime(2026, 1, 1), datetime(2026, 10, 31), Path("output"))
                calls, events = [], []
                def download(*args, **kwargs):
                    calls.append(args[:3])
                    return {"downloaded_files": []}
                run_batch(request, lambda kind, **data: events.append((kind, data)), Event(), download)
                self.assertEqual(calls, [(v, r, frequency) for v in VESSELS for r in reports])
                self.assertEqual(events[-1][1]["failed"], 0)

    def test_failure_then_retry_only_requested_pairs(self):
        request = BatchRequest(("DHT SUNDARBANS", "DHT TAIGA", "DHT TIGER"),
            "Six Monthly", tuple(REPORTS_BY_FREQUENCY["Six Monthly"]),
            datetime(2026, 1, 1), datetime(2026, 10, 31), Path("output"))
        events = []
        def download(vessel, report, *args, **kwargs):
            if "SEEMP" not in report:
                raise DownloadError("fixture: missing result")
            return {"downloaded_files": [vessel + ".pdf"]}
        run_batch(request, lambda kind, **data: events.append((kind, data)), Event(), download)
        self.assertEqual(events[-1][1]["failed"], 6)
        self.assertEqual(events[-1][1]["files"], 3)
        failed = [ReportJob(d["vessel"], d["report"]) for k, d in events
                  if k == "result" and d["status"] == "Needs attention"]
        calls = []
        def retry(vessel, report, *args, **kwargs):
            calls.append(ReportJob(vessel, report))
            return {"downloaded_files": []}
        run_batch(request.retry(failed), lambda *a, **k: None, Event(), retry)
        self.assertEqual(calls, failed)

    def test_navigation_reuse_and_vessel_frequency_changes(self):
        session = ReportSession()
        session.open = MagicMock()
        page = MagicMock()
        session._equipment_page = MagicMock(return_value=page)
        session._select_vessel = MagicMock(side_effect=lambda p, v: (
            setattr(session, "current_vessel", v), setattr(session, "current_frequency", None)))
        session._open_frequency = MagicMock(side_effect=lambda p, f: setattr(session, "current_frequency", f))
        session.prepare("DHT TAIGA", "Monthly")
        session.prepare("DHT TAIGA", "Monthly")
        session._select_vessel.assert_called_once()
        session._open_frequency.assert_called_once()
        session.prepare("DHT TAIGA", "Quarterly")
        self.assertEqual(session._select_vessel.call_count, 1)
        session.prepare("DHT TIGER", "Quarterly")
        self.assertEqual(session._select_vessel.call_count, 2)
        self.assertEqual(session._open_frequency.call_count, 3)
        session._invalidate()
        session.prepare("DHT TIGER", "Quarterly")
        self.assertEqual(session._select_vessel.call_count, 3)

    def test_attachment_receipts_deduplicate_recovery_but_not_other_jobs(self):
        with TemporaryDirectory(dir=".") as directory:
            folder = Path(directory)
            session, receipts = ReportSession(), {}
            download = MagicMock()
            download.suggested_filename = "same.pdf"
            download.save_as.side_effect = lambda path: Path(path).write_bytes(b"fixture")
            fetch = MagicMock(return_value=download)
            key = ("DHT TAIGA", "SEEMP", "JO-1", "attachment-1", 0)
            first = session._save_attachment(key, receipts, folder, "same.pdf", fetch)
            self.assertEqual(session._save_attachment(key, receipts, folder, "same.pdf", fetch), first)
            self.assertEqual(fetch.call_count, 1)
            second = session._save_attachment(("DHT TAIGA", "SEEMP", "JO-2", "attachment-1", 0),
                                              receipts, folder, "same.pdf", fetch)
            self.assertNotEqual(first, second)
            Path(first).unlink()
            session._save_attachment(key, receipts, folder, "same.pdf", fetch)
            self.assertEqual(fetch.call_count, 3)

    def test_auth_recovery_reuses_receipts_and_finishes_unfinished_job(self):
        request = BatchRequest(("DHT TAIGA",), "Monthly", ("one", "two"),
            datetime(2026, 1, 1), datetime(2026, 10, 31), Path("."))
        calls, events = [], []
        def download(vessel, report, *args, receipts, **kwargs):
            calls.append(report)
            if len(calls) == 1:
                receipts["attachment"] = "saved.pdf"
                raise SessionInterrupted("auth", "fixture expiry", ["saved.pdf"])
            if report == "one":
                self.assertEqual(receipts, {"attachment": "saved.pdf"})
                return {"downloaded_files": ["saved.pdf"]}
            self.assertEqual(receipts, {})
            return {"downloaded_files": ["second.pdf"]}
        run_batch(request, lambda k, **d: events.append((k, d)), Event(),
                  download, recover=lambda *args: True)
        self.assertEqual(calls, ["one", "one", "two"])
        self.assertEqual(events[-1][1]["files"], 2)
        self.assertEqual(events[-1][1]["failed"], 0)

    def test_browser_loss_and_auth_expiry_are_distinct(self):
        session = ReportSession()
        with self.assertRaises(SessionInterrupted) as error:
            session._check()
        self.assertEqual(error.exception.reason, "browser")
        session.context = MagicMock()
        session.context.pages = [MagicMock()]
        session._auth_expired = True
        with self.assertRaises(SessionInterrupted) as error:
            session._check()
        self.assertEqual(error.exception.reason, "auth")

    def test_close_is_on_owner_thread(self):
        session = ReportSession()
        session.context = MagicMock()
        owner_calls = []
        session.context.close.side_effect = lambda: owner_calls.append(get_ident())
        session.close()
        self.assertEqual(owner_calls, [session._owner])

    def test_observed_mariapps_titles_and_nonmatches(self):
        pattern = ReportSession._report_pattern("Vent Heads Inspections And Overhauling")
        self.assertIsNotNone(pattern.fullmatch("Vent Heads Inspections And Overhauling Report"))
        self.assertIsNone(pattern.fullmatch("Vent Heads Inspections And Overhauling Report - OTHER"))
        pattern = ReportSession._report_pattern("14.14.05.002 - GMDSS Battery Load Test")
        self.assertIsNotNone(pattern.fullmatch("14.14.05.002 – GMDSS Battery Load Test"))
        self.assertIsNone(pattern.fullmatch("14.14.05.001 – GMDSS Battery Load Test"))

    @unittest.skipUnless(os.name == "nt", "Windows long-path regression")
    def test_long_download_path(self):
        with TemporaryDirectory(dir=".") as directory:
            session = ReportSession()
            download = MagicMock()
            download.suggested_filename = "report.pdf"
            download.save_as.side_effect = lambda path: Path(path).write_bytes(b"fixture")
            filename = "Long report title " * 9 + ".pdf"
            saved = session._save_attachment(("long",), {}, Path(directory), filename,
                                             lambda: download)
            self.assertGreater(len(str(Path(directory).absolute() / filename)), 260)
            self.assertTrue(Path(saved).is_file())
            Path(saved).unlink()

    def test_observed_title_variants_are_explicit(self):
        cases = {
            "M/E & A/E Cooling Water Test Log": "M/E Cooling Water Test Log",
            "Monthly Oil Record Book Report": "Monthly Oil Record Book Report 1M",
            "1M BWTS Operation Log Report": "BWTS Operation Log Report",
            "14.14.05.001 - Battery Condition & load test": "14.14.05.001 - Battery Condition & load test report",
            "14.34.00.001 - Inventory of Precision Measuring": "14.34.00.001 - Inventory of Precision Measuring Instruments",
        }
        for expected, actual in cases.items():
            with self.subTest(report=expected):
                pattern = ReportSession._report_pattern(expected)
                self.assertIsNotNone(pattern.fullmatch(actual))
                self.assertIsNone(pattern.fullmatch(actual + " unrelated"))
