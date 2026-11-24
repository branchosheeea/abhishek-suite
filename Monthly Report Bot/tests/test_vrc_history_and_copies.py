"""Vessel Report Centre (audit item P1-4): Job History beyond the first page is never missed silently, and a re-run
does not add " (2)" copies of a file it already saved. Temporary folders; no portal, no browser."""
from pathlib import Path
import tempfile
import unittest

from vessel_report.core import existing_copy, file_sha256, history_check
from vessel_report.downloader import ReportSession


class HistoryCheckTests(unittest.TestCase):
    def test_a_single_page_is_read_as_before(self):
        self.assertIsNone(history_check(total=12, page_size=20, rows_read=12))
        self.assertIsNone(history_check(total=12, page_size=20, rows_read=11), "single page: no new check")
        self.assertIsNone(history_check(total=None, page_size=None, rows_read=5, more_pages_shown=False))

    def test_several_pages_must_all_be_read(self):
        self.assertIsNone(history_check(total=45, page_size=20, rows_read=45))
        self.assertIn("only 20 could be read", history_check(total=45, page_size=20, rows_read=20))

    def test_an_unreadable_grid_with_more_pages_stops_the_report(self):
        self.assertIn("more than one page", history_check(total=None, page_size=None, rows_read=20, more_pages_shown=True))


class FakeDownload:
    def __init__(self, name, data):
        self.suggested_filename, self.data = name, data

    def save_as(self, path):
        Path(path).write_bytes(self.data)


class CopyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.session = ReportSession()
        self.session.log = lambda message: None

    def tearDown(self):
        self.temp.cleanup()

    def save(self, data, name="Main Engine RH [Oct].pdf"):
        return self.session._save_attachment(("k", data), {}, self.folder, name, lambda: FakeDownload(name, data))

    def test_the_same_file_again_is_not_copied(self):
        first = self.save(b"%PDF report")
        again = self.save(b"%PDF report")
        self.assertEqual(again, first)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["Main Engine RH [Oct].pdf"], "no copy, no leftovers")

    def test_a_different_file_with_the_same_name_is_kept_beside_it(self):
        self.save(b"%PDF first")
        second = self.save(b"%PDF corrected")
        self.assertTrue(second.endswith("Main Engine RH [Oct] (2).pdf"))
        self.assertEqual(self.save(b"%PDF corrected"), second, "and found again on the next run")

    def test_a_re_run_reuses_each_job_orders_own_earlier_file(self):
        # Two job orders whose attachments are byte-identical keep a file each (one per job order), and a later run
        # finds both again instead of adding (3) and (4).
        def run():
            receipts = {}
            name = "same.pdf"
            paths = [self.session._save_attachment(("JO-%d" % n,), receipts, self.folder, name, lambda: FakeDownload(name, b"%PDF same"))
                     for n in (1, 2)]
            return [Path(p).name for p in paths]
        self.assertEqual(run(), ["same.pdf", "same (2).pdf"])
        self.assertEqual(run(), ["same.pdf", "same (2).pdf"])
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["same (2).pdf", "same.pdf"])

    def test_existing_copy_matches_content_not_just_the_name(self):
        (self.folder / "a.pdf").write_bytes(b"one")
        sha = file_sha256(self.folder / "a.pdf")
        self.assertEqual(existing_copy(self.folder, "a.pdf", sha, 3), self.folder / "a.pdf")
        self.assertIsNone(existing_copy(self.folder, "a.pdf", "0" * 64, 3))
        self.assertIsNone(existing_copy(self.folder, "b.pdf", sha, 3))


if __name__ == "__main__":
    unittest.main()
