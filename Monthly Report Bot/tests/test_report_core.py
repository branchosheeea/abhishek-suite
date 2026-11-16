import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from threading import Event
from vessel_report.core import BatchRequest, ReportJob, DownloadError, NoDataError, parse_range, preset_range, run_batch, unique_path


class CoreTests(unittest.TestCase):
    def request(self):
        return BatchRequest("DHT LEOPARD", "Monthly", ("first", "second"), datetime(2026, 10, 1), datetime(2026, 10, 31), Path("output"))

    def test_previous_month_leap_year_and_january(self):
        self.assertEqual(preset_range("Previous Month", date(2024, 3, 10)), (date(2024, 2, 1), date(2024, 2, 29)))
        self.assertEqual(preset_range("Previous Month", date(2026, 1, 1)), (date(2025, 12, 1), date(2025, 12, 31)))

    def test_rolling_months_include_current_partial_month(self):
        self.assertEqual(preset_range("Last 3 Months", date(2026, 1, 10)), (date(2025, 11, 1), date(2026, 1, 10)))
        self.assertEqual(preset_range("Last 12 Months", date(2026, 11, 10)), (date(2025, 12, 1), date(2026, 11, 10)))
        self.assertIsNone(preset_range("Custom Range"))

    def test_dates_validate_order_and_format(self):
        self.assertEqual(parse_range("01-Oct-2026", "01-Oct-2026")[0], datetime(2026, 10, 1))
        for start, end in [("31-Oct-2026", "01-Oct-2026"), ("31-Feb-2026", "01-Mar-2026"), ("", "")]:
            with self.assertRaises(ValueError):
                parse_range(start, end)

    def test_repeated_filename_collisions(self):
        folder = Path(".test-tmp-collisions")
        folder.mkdir(exist_ok=True)
        try:
            for name in ("report.xlsx", "report (2).xlsx", "report (3).xlsx"):
                (folder / name).touch()
            self.assertEqual(unique_path(folder, "report.xlsx").name, "report (4).xlsx")
        finally:
            for path in folder.glob("report*.xlsx"):
                path.unlink(missing_ok=True)
            folder.rmdir()

    def test_partial_failure_keeps_files_and_continues(self):
        events, calls = [], []
        def download(*args, **kwargs):
            calls.append((args, kwargs))
            if args[1] == "first":
                raise DownloadError("second attachment failed", ["saved.xlsx"])
            return {"downloaded_files": ["other.xlsx"]}
        run_batch(self.request(), lambda kind, **data: events.append((kind, data)), Event(), download)
        self.assertEqual(events[-1], ("finished", dict(stopped=False, completed=2, files=2, failed=1)))
        self.assertEqual(calls[0][0][:3], ("DHT LEOPARD", "first", "Monthly"))
        self.assertEqual(calls[0][1]["output_dir"], Path("output"))

    def test_attachment_extension_filter_is_forwarded_and_preserved_for_retry(self):
        request = BatchRequest(
            ("DHT COLT",), "Monthly", ("lube oil",), datetime(2026, 10, 1),
            datetime(2026, 10, 31), Path("output"),
            attachment_extensions=("XLSX", ".xlsx"),
        )
        self.assertEqual(request.attachment_extensions, (".xlsx",))
        retry = request.retry((ReportJob("DHT COLT", "lube oil"),))
        self.assertEqual(retry.attachment_extensions, (".xlsx",))
        calls = []
        run_batch(request, lambda *_args, **_kwargs: None, Event(),
                  lambda *args, **kwargs: calls.append(kwargs) or {"downloaded_files": []})
        self.assertEqual(calls[0]["attachment_extensions"], (".xlsx",))

    def test_invalid_attachment_filter_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "valid file extensions"):
            BatchRequest(
                ("DHT COLT",), "Monthly", ("lube oil",), datetime(2026, 10, 1),
                datetime(2026, 10, 31), Path("output"), attachment_extensions=("../xlsx",),
            )

    def test_no_data_is_completed_without_retryable_failure(self):
        events = []
        def download(*args, **kwargs):
            if args[1] == "first":
                raise NoDataError("No completed job order")
            raise NoDataError("Attachments 0", status="No attachments")
        run_batch(self.request(), lambda kind, **data: events.append((kind, data)),
                  Event(), download)
        results = [data for kind, data in events if kind == "result"]
        self.assertEqual([result["status"] for result in results],
                         ["No data", "No attachments"])
        self.assertTrue(all(not result["error"] for result in results))
        self.assertEqual(events[-1][1],
                         dict(stopped=False, completed=2, files=0, failed=0))

    def test_stop_finishes_active_report(self):
        events, stop = [], Event()
        def download(*args, **kwargs):
            stop.set()
            return {"downloaded_files": ["complete.xlsx"]}
        run_batch(self.request(), lambda kind, **data: events.append((kind, data)), stop, download)
        self.assertEqual(events[-1], ("finished", dict(stopped=True, completed=1, files=1, failed=0)))
        self.assertEqual(sum(kind == "started" for kind, _ in events), 1)

    def test_stop_before_start(self):
        stop = Event()
        stop.set()
        events = []
        run_batch(self.request(), lambda kind, **data: events.append((kind, data)), stop, lambda *a, **k: self.fail("Must not download"))
        self.assertEqual(events[-1][1]["completed"], 0)

    def test_multiple_vessels_run_every_report_once(self):
        r = self.request()
        request = BatchRequest(("DHT LEOPARD", "DHT IMPALA"), r.frequency, r.reports, r.start, r.end, r.output)
        calls, events = [], []
        def download(*args, **kwargs):
            calls.append(args[:2])
            return {"downloaded_files": ["file"]}
        run_batch(request, lambda kind, **data: events.append((kind, data)), Event(), download)
        self.assertEqual(calls, [("DHT LEOPARD", "first"), ("DHT LEOPARD", "second"), ("DHT IMPALA", "first"), ("DHT IMPALA", "second")])
        self.assertEqual(events[-1][1], dict(stopped=False, completed=4, files=4, failed=0))
        self.assertEqual([data["vessel"] for kind, data in events if kind == "result"], ["DHT LEOPARD", "DHT LEOPARD", "DHT IMPALA", "DHT IMPALA"])

    def test_retry_only_failed_pairs_not_cross_product(self):
        r = self.request()
        request = BatchRequest(("DHT LEOPARD", "DHT IMPALA"), r.frequency, r.reports, r.start, r.end, r.output)
        failed = (ReportJob("DHT LEOPARD", "first"), ReportJob("DHT IMPALA", "second"))
        retry = request.retry(failed)
        calls = []
        def download(*args, **kwargs):
            calls.append(ReportJob(args[0], args[1]))
            return {"downloaded_files": []}
        run_batch(retry, lambda *a, **k: None, Event(), download)
        self.assertEqual(tuple(calls), failed)
        self.assertEqual((retry.start, retry.end, retry.output), (r.start, r.end, r.output))

    def test_all_vessels_and_duplicate_selection(self):
        from report_catalog import VESSELS
        r = self.request()
        request = BatchRequest(tuple(VESSELS) + (VESSELS[0],), r.frequency, r.reports, r.start, r.end, r.output)
        self.assertEqual(len(request.jobs), len(VESSELS) * len(r.reports))
        self.assertEqual(len(set(request.jobs)), len(request.jobs))

    def test_empty_vessels_and_foreign_retry_are_rejected(self):
        r = self.request()
        with self.assertRaises(ValueError):
            BatchRequest((), r.frequency, r.reports, r.start, r.end, r.output)
        with self.assertRaises(ValueError):
            r.retry((ReportJob("OTHER", "first"),))

    def test_stop_does_not_start_next_vessel(self):
        r = self.request()
        request = BatchRequest(("DHT LEOPARD", "DHT IMPALA"), r.frequency, ("first",), r.start, r.end, r.output)
        stop, calls, events = Event(), [], []
        def download(*args, **kwargs):
            calls.append(args[0])
            stop.set()
            return {"downloaded_files": ["saved"]}
        run_batch(request, lambda kind, **data: events.append((kind, data)), stop, download)
        self.assertEqual(calls, ["DHT LEOPARD"])
        self.assertTrue(events[-1][1]["stopped"])


if __name__ == "__main__":
    unittest.main()
