import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from lube_oil.outlook import (
    OutlookDownloadError,
    _date_filter,
    _received_date,
    _subject_filter,
    download_outlook_attachments,
)


class Collection:
    def __init__(self, values):
        self.values = list(values)
        self.Count = len(self.values)
        self.filters = []

    def Item(self, index):
        return self.values[index - 1]

    def Restrict(self, filter_query):
        self.filters.append(filter_query)
        return self


class Folder:
    def __init__(self, name, items=(), folders=()):
        self.Name = name
        self.Items = Collection(items)
        self.Folders = Collection(folders)


class Attachment:
    def __init__(self, filename, content=b"workbook"):
        self.FileName = filename
        self.content = content

    def SaveAsFile(self, destination):
        Path(destination).write_bytes(self.content)


class FailingAttachment(Attachment):
    def SaveAsFile(self, destination):
        raise OSError("simulated attachment write failure")


class Mail:
    Class = 43

    def __init__(self, subject, received, attachments=()):
        self.Subject = subject
        self.ReceivedTime = received
        self.Attachments = Collection(attachments)


class Outlook:
    def __init__(self, inbox):
        self.inbox = inbox

    def GetDefaultFolder(self, folder_type):
        if folder_type != 6:
            raise AssertionError(f"Unexpected default folder: {folder_type}")
        return self.inbox


class OutlookAttachmentTests(unittest.TestCase):
    def test_outlook_date_filter_uses_local_day_boundaries(self):
        self.assertEqual(
            _date_filter(date(2026, 10, 1), date(2026, 10, 31)),
            "[ReceivedTime] >= '01/10/2026 12:00 AM' AND [ReceivedTime] < '01/11/2026 12:00 AM'",
        )

    def test_outlook_subject_filter_uses_phrase_contains(self):
        self.assertIn("LIKE '%LUBE OIL STOCK AND CONSUMPTION%'", _subject_filter())

    def test_received_date_converts_timezone_aware_time_to_local_date(self):
        local_time = datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc).astimezone()
        self.assertEqual(_received_date(datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc)), local_time.date())

    def test_searches_inbox_and_subfolders_by_subject_and_inclusive_received_dates(self):
        start = datetime(2026, 10, 1).date()
        end = datetime(2026, 10, 31).date()
        inbox = Folder("Inbox", [
            Mail("LUBE OIL STOCK AND CONSUMPTION - DHT COLT",
                 datetime(2026, 10, 1, 0, 1),
                 [Attachment("lube-oil.xlsx"), Attachment("supporting.pdf")]),
            Mail("LUBE OIL STOCK AND CONSUMPTION - DHT COLT",
                 datetime(2026, 9, 30, 23, 59), [Attachment("outside.xlsx")]),
            Mail("Monthly machinery report", datetime(2026, 10, 12), [Attachment("unrelated.xlsx")]),
        ], [Folder("Vessel reports", [
            Mail("Re: lube oil stock and consumption",
                 datetime(2026, 10, 31, 23, 59), [Attachment("../revised.xlsx")]),
        ])])

        with tempfile.TemporaryDirectory() as directory:
            events = []
            result = download_outlook_attachments(
                start, end, Path(directory),
                emit=lambda kind, **data: events.append((kind, data)),
                outlook_factory=lambda: Outlook(inbox),
            )
            self.assertEqual(len(result.paths), 2)
            self.assertEqual(result.matching_emails, 2)
            self.assertEqual(result.skipped_attachments, 1)
            self.assertTrue(all(path.suffix == ".xlsx" and path.is_file() for path in result.paths))
            self.assertEqual({path.name for path in result.paths}, {"lube-oil.xlsx", "revised.xlsx"})
            self.assertEqual(sum(kind == "matched" for kind, _ in events), 2)
            self.assertEqual(sum(kind == "saved" for kind, _ in events), 2)
            self.assertEqual(sum(kind == "skipped" for kind, _ in events), 1)

    def test_only_xlsx_is_saved_and_matching_non_excel_is_reported_as_skipped(self):
        inbox = Folder("Inbox", [
            Mail("LUBE OIL STOCK AND CONSUMPTION",
                 datetime(2026, 10, 1), [
                     Attachment("report.xls"),
                     Attachment("report.xlsm"),
                     Attachment("report.pdf"),
                 ]),
        ])

        with tempfile.TemporaryDirectory() as directory:
            result = download_outlook_attachments(
                datetime(2026, 10, 1).date(), datetime(2026, 10, 1).date(),
                Path(directory), outlook_factory=lambda: Outlook(inbox),
            )
            self.assertEqual(result.paths, ())
            self.assertEqual(result.matching_emails, 1)
            self.assertEqual(result.skipped_attachments, 3)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_partial_save_error_preserves_already_downloaded_paths(self):
        inbox = Folder("Inbox", [
            Mail("LUBE OIL STOCK AND CONSUMPTION",
                 datetime(2026, 10, 1), [
                     Attachment("saved.xlsx"),
                     FailingAttachment("failed.xlsx"),
                 ]),
        ])

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(OutlookDownloadError) as caught:
                download_outlook_attachments(
                    datetime(2026, 10, 1).date(), datetime(2026, 10, 1).date(),
                    Path(directory), outlook_factory=lambda: Outlook(inbox),
                )
            self.assertIn("simulated attachment write failure", str(caught.exception))
            self.assertEqual([path.name for path in caught.exception.downloaded_paths], ["saved.xlsx"])
            self.assertTrue(caught.exception.downloaded_paths[0].is_file())


if __name__ == "__main__":
    unittest.main()
