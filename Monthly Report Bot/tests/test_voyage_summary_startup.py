"""Voyage Summary start-up (audit item P1-3): a missing default noon report offers a file picker instead of closing."""
from pathlib import Path
import unittest

from voyage_summary.__main__ import VoyageDataset, startup_dataset

DATASET = VoyageDataset(vessel="DHT ADDAX", records=({"day": 1},), source_path=Path("chosen.xlsx"))


def loader(*, default=None, files=None):
    """load_voyage_data stand-in: the default fails unless given; chosen files succeed or fail as listed."""
    files = files or {}

    def load(path=None):
        if path is None:
            if default is None:
                raise FileNotFoundError("Voyage workbook not found. Checked: Downloads\\Log Report 11 NOV 2026 Noon-.xlsx")
            return default
        outcome = files[str(path)]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome
    return load


class StartupTests(unittest.TestCase):
    def test_the_default_report_opens_without_asking(self):
        asked = []
        dataset = startup_dataset(loader(default=DATASET), choose=lambda: asked.append("choose"), confirm=lambda t: asked.append(t), show_error=asked.append)
        self.assertIs(dataset, DATASET)
        self.assertEqual(asked, [])

    def test_a_missing_default_offers_a_file_picker_with_the_reason(self):
        shown = []
        dataset = startup_dataset(
            loader(files={"chosen.xlsx": DATASET}), choose=lambda: "chosen.xlsx",
            confirm=lambda text: shown.append(text) or True, show_error=shown.append,
        )
        self.assertIs(dataset, DATASET)
        self.assertIn("not found", shown[0])

    def test_an_unreadable_choice_shows_why_and_offers_the_picker_again(self):
        picks = iter(["broken.xlsx", "chosen.xlsx"])
        errors = []
        dataset = startup_dataset(
            loader(files={"broken.xlsx": ValueError("No Noon at Sea sheet was found."), "chosen.xlsx": DATASET}),
            choose=lambda: next(picks), confirm=lambda text: True, show_error=errors.append,
        )
        self.assertIs(dataset, DATASET)
        self.assertEqual(len(errors), 1)
        self.assertIn("No Noon at Sea sheet", errors[0])

    def test_declining_or_cancelling_closes_quietly(self):
        self.assertIsNone(startup_dataset(loader(), choose=lambda: "x", confirm=lambda text: False, show_error=print))
        self.assertIsNone(startup_dataset(loader(), choose=lambda: "", confirm=lambda text: True, show_error=print))


if __name__ == "__main__":
    unittest.main()
