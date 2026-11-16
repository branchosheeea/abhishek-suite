import hashlib
import builtins
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
import sys
import threading

from openpyxl import Workbook, load_workbook
from PIL import Image

from inspection_intelligence.configuration import (
    get_config_directory,
    get_data_directory,
    load_configuration,
)
from inspection_intelligence.exports.excel_export import export_results
from inspection_intelligence.models import ClassificationDecision
from inspection_intelligence.persistence.database import Database
from inspection_intelligence.services.classification_engine import (
    ClassificationEngine,
    summarize,
)
from inspection_intelligence.services.ai.ollama_provider import OllamaError, OllamaProvider
from inspection_intelligence.services.ai.fast_local_provider import FastLocalProvider
from inspection_intelligence.services.storage.local_storage import (
    discover_photos,
    prepare_image,
)
from benchmark_processing import (
    extract_level1,
    load_excel_references,
    summarize_reference_results,
)
from benchmark_fast_local import load_reference_photos


class FakeProvider:
    model_name = "test-vision-model"

    def __init__(self) -> None:
        self.fail_names: set[str] = set()
        self.availability_error: Exception | None = None

    def ensure_available(self) -> None:
        if self.availability_error is not None:
            raise self.availability_error

    def classify(self, image_path: Path) -> ClassificationDecision:
        if image_path.name in self.fail_names:
            raise ValueError("simulated individual failure")
        return ClassificationDecision("Main Deck", 0.92, "Deck plating and fittings are visible.")


class FakeResponse:
    def __init__(self, value: dict) -> None:
        self.content = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def read(self) -> bytes:
        return self.content


class ClassifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.configuration = load_configuration()
        self.taxonomy = self.configuration.taxonomy
        self.database = Database(self.root / "results.sqlite3")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def make_photo(self, path: Path, size: tuple[int, int] = (2200, 1200)) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, color=(20, 50, 80)).save(path)
        return path

    def test_packaged_paths_use_external_config_and_per_user_database(self) -> None:
        executable = self.root / "InspectionIntelligence.exe"
        local_app_data = self.root / "LocalAppData"
        with (
            patch.object(sys, "frozen", True, create=True),
            patch.object(sys, "executable", str(executable)),
            patch.dict("os.environ", {"LOCALAPPDATA": str(local_app_data)}),
        ):
            self.assertEqual(get_config_directory(), self.root / "config")
            self.assertEqual(
                get_data_directory(),
                local_app_data / "Inspection Intelligence" / "data",
            )

    def test_reference_benchmark_uses_only_unique_consistent_existing_photos(self) -> None:
        database_path = self.root / "benchmark.sqlite3"
        existing_photo = self.make_photo(self.root / "labeled.jpg", size=(32, 24))
        missing_photo = self.root / "missing.jpg"
        conflicting_photo = self.make_photo(self.root / "conflicting.jpg", size=(32, 24))
        with closing(sqlite3.connect(database_path)) as connection:
            with connection:
                connection.execute(
                    "CREATE TABLE classification_results "
                    "(id INTEGER, original_path TEXT, abhishek_level1 TEXT)"
                )
                connection.executemany(
                    "INSERT INTO classification_results VALUES (?, ?, ?)",
                    [
                        (1, str(existing_photo), "Main Deck"),
                        (2, str(existing_photo), "Main Deck"),
                        (3, str(missing_photo), "Hull"),
                        (4, str(conflicting_photo), "Hull"),
                        (5, str(conflicting_photo), "Tanks"),
                    ],
                )

        references, missing_count, conflicting_count = load_reference_photos(database_path)

        self.assertEqual(references, [(existing_photo, "Main Deck")])
        self.assertEqual(missing_count, 1)
        self.assertEqual(conflicting_count, 1)

    def test_gemma_benchmark_scores_only_valid_exact_classifications(self) -> None:
        results = [
            {"category": "Main Deck", "exact_match": True},
            {"category": "Review Required", "exact_match": False},
            {"category": None, "exact_match": False},
        ]

        self.assertEqual(
            summarize_reference_results(results),
            {
                "reference_photos": 3,
                "successfully_processed": 2,
                "failed": 1,
                "exact_matches": 1,
                "mismatches": 2,
                "accuracy": 1 / 3,
            },
        )

    def test_gemma_benchmark_rejects_malformed_or_unapproved_categories(self) -> None:
        self.assertEqual(
            extract_level1(
                '{"level1":"Main Deck","confidence":0.9,"reason":"Deck fittings"}',
                self.taxonomy,
            ),
            "Main Deck",
        )
        self.assertIsNone(extract_level1('not JSON', self.taxonomy))
        self.assertIsNone(
            extract_level1(
                '{"level1":"Engine Room-ish","confidence":0.9,"reason":"Machinery"}',
                self.taxonomy,
            )
        )
        self.assertIsNone(
            extract_level1(
                '{"level1":"Main Deck","confidence":0.9}',
                self.taxonomy,
            )
        )
        self.assertIsNone(
            extract_level1(
                '{"level1":"Main Deck","confidence":0.9,"reason":"Deck"}',
                self.taxonomy,
                done_reason="length",
            )
        )

    def test_excel_reference_benchmark_uses_abhishek_labels_and_ignores_blank_rows(self):
        photo_folder = self.root / "photos"
        photo = self.make_photo(photo_folder / "labeled.jpg", size=(32, 24))
        workbook_path = self.root / "reference.xlsx"
        workbook = Workbook()
        worksheet = workbook.active
        worksheet.title = "Inspection Results"
        worksheet.append(("Photo Name", "Abhishek Classification", "Final Classification"))
        worksheet.append(("labeled.jpg", "Main Deck", "Engine Room"))
        worksheet.append(("missing.jpg", "Hull", "Hull"))
        worksheet.append(("unlabeled.jpg", None, None))
        workbook.save(workbook_path)
        workbook.close()

        references, missing_count = load_excel_references(
            workbook_path,
            photo_folder,
            self.taxonomy,
        )

        self.assertEqual(references, [(photo, "Main Deck")])
        self.assertEqual(missing_count, 1)

    def test_discovers_supported_photos_recursively_and_ignores_other_files(self) -> None:
        nested = self.make_photo(self.root / "nested" / "B.JPG")
        first = self.make_photo(self.root / "a.png")
        (self.root / "notes.txt").write_text("not a photo", encoding="utf-8")
        (self.root / "photo.gif").write_bytes(b"not supported")

        self.assertEqual(discover_photos(self.root), [first, nested])

    def test_optimized_working_copy_does_not_change_original(self) -> None:
        photo = self.make_photo(self.root / "source.png")
        original_digest = hashlib.sha256(photo.read_bytes()).digest()

        working_bytes, media_type = prepare_image(photo, 1600)
        optimized_path = self.root / "working.jpg"
        optimized_path.write_bytes(working_bytes)
        with Image.open(optimized_path) as optimized:
            self.assertEqual(optimized.format, "JPEG")
            self.assertEqual(optimized.size, (1600, 873))
        self.assertEqual(media_type, "image/jpeg")
        self.assertEqual(hashlib.sha256(photo.read_bytes()).digest(), original_digest)

    def test_batch_continues_after_individual_failure_and_persists_each_photo(self) -> None:
        failed_photo = self.make_photo(self.root / "failed.jpg")
        good_photo = self.make_photo(self.root / "good.jpg")
        provider = FakeProvider()
        provider.fail_names.add("failed.jpg")
        engine = ClassificationEngine(provider, self.database, "test-prompt")
        progress: list[tuple[int, int, str]] = []
        events: list[str] = []

        results = engine.classify_batch(
            [failed_photo, good_photo],
            "MV Example",
            "2026-11-10",
            lambda current, total, name: progress.append((current, total, name)),
            events.append,
        )

        self.assertEqual([result.status for result in results], ["Failed", "Processed"])
        self.assertIn("simulated individual failure", results[0].ai_reason)
        self.assertEqual(len(self.database.list_results()), 2)
        self.assertEqual([item[0] for item in progress], [1, 2])
        self.assertTrue(any("Checking connection" in event for event in events))
        self.assertTrue(any("Failed failed.jpg" in event for event in events))
        self.assertTrue(any("Classified good.jpg" in event for event in events))
        summary = summarize(results, self.taxonomy)
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["processed"], 1)
        self.assertEqual(summary["failed"], 1)
        self.assertIsNone(summary["accuracy"])

    def test_preflight_failure_is_reported_for_every_photo(self) -> None:
        first = self.make_photo(self.root / "one.jpg")
        second = self.make_photo(self.root / "two.jpg")
        provider = FakeProvider()
        provider.availability_error = RuntimeError("Ollama is unavailable")
        engine = ClassificationEngine(provider, self.database, "test-prompt")
        events: list[str] = []

        with self.assertRaisesRegex(RuntimeError, "Ollama is unavailable"):
            engine.classify_batch(
                [first, second],
                "MV Example",
                "2026-11-10",
                event_callback=events.append,
            )

        self.assertTrue(any("Model preflight failed" in event for event in events))
        self.assertEqual(self.database.list_results(), [])

    def test_missing_fast_dependency_reports_active_interpreter(self) -> None:
        provider = FastLocalProvider(self.root / "missing-model", self.taxonomy)
        original_import = builtins.__import__

        def missing_onnxruntime(name, *args, **kwargs):
            if name == "onnxruntime":
                raise ModuleNotFoundError("No module named 'onnxruntime'", name="onnxruntime")
            return original_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=missing_onnxruntime):
            with self.assertRaises(RuntimeError) as raised:
                provider.ensure_available()

        message = str(raised.exception)
        self.assertIn("onnxruntime", message)
        self.assertIn(sys.executable, message)
        self.assertIn("setup_fast_mode.cmd", message)

    def test_batch_processes_twenty_photos(self) -> None:
        photos = [
            self.make_photo(self.root / f"photo-{index:02}.jpg", size=(32, 24))
            for index in range(20)
        ]
        engine = ClassificationEngine(FakeProvider(), self.database, "test-prompt")

        results = engine.classify_batch(photos, "MV Example", "2026-11-10")

        self.assertEqual(len(results), 20)
        self.assertTrue(all(result.status == "Processed" for result in results))
        self.assertEqual(len(self.database.list_results()), 20)

    def test_corrupt_image_fails_without_stopping_the_batch(self) -> None:
        corrupt_photo = self.root / "corrupt.jpg"
        corrupt_photo.write_bytes(b"not an image")
        good_photo = self.make_photo(self.root / "good.jpg", size=(32, 24))
        provider = OllamaProvider(
            base_url="http://localhost:11434",
            model_name="gemma3",
            prompt=self.configuration.prompt,
            taxonomy=self.taxonomy,
            timeout_seconds=5,
            max_image_dimension=1800,
        )
        engine = ClassificationEngine(provider, self.database, "test-prompt")
        with patch(
            "inspection_intelligence.services.ai.ollama_provider.urlopen",
            side_effect=[
                FakeResponse({"models": [{"name": "gemma3"}]}),
                FakeResponse(
                    {
                        "response": json.dumps(
                            {
                                "level1": "Main Deck",
                                "confidence": 0.9,
                                "reason": "Deck plating is visible.",
                            }
                        )
                    }
                ),
            ],
        ):
            results = engine.classify_batch(
                [corrupt_photo, good_photo], "MV Example", "2026-11-10"
            )

        self.assertEqual([result.status for result in results], ["Failed", "Processed"])
        self.assertIn("Processing failed", results[0].ai_reason)

    def test_reference_match_accuracy_and_review_actions(self) -> None:
        photo = self.make_photo(self.root / "reference.jpg")
        engine = ClassificationEngine(FakeProvider(), self.database, "test-prompt")
        result = engine.classify_batch([photo], "MV Example", "2026-11-10")[0]
        self.assertIsNone(result.match)

        self.database.set_abhishek_classification(result.id, "Main Deck", self.taxonomy)
        reviewed = self.database.list_results([result.id])[0]
        self.assertIs(reviewed.match, True)
        self.assertEqual(reviewed.final_level1, "Main Deck")
        self.assertEqual(summarize([reviewed], self.taxonomy)["accuracy"], 1.0)

        self.database.set_abhishek_classification(result.id, "Hull", self.taxonomy)
        changed = self.database.list_results([result.id])[0]
        self.assertIs(changed.match, False)
        self.assertEqual(summarize([changed], self.taxonomy)["mismatches"], 1)
        with self.assertRaises(ValueError):
            self.database.set_abhishek_classification(result.id, "Not Approved", self.taxonomy)

    def test_summary_counts_review_required_and_processing_time(self) -> None:
        photo = self.make_photo(self.root / "uncertain.jpg")
        result = ClassificationEngine(
            FakeProvider(), self.database, "test-prompt"
        ).classify_batch([photo], "MV Example", "2026-11-10")[0]
        result.ai_level1 = self.taxonomy.review_required

        summary = summarize([result], self.taxonomy)

        self.assertEqual(summary["review_required"], 1)
        self.assertEqual(
            summary["average_processing_time_ms"], result.processing_time_ms
        )
        self.assertEqual(summary["total_processing_time_ms"], result.processing_time_ms)

    def test_approve_sets_final_classification_and_excel_has_required_columns(self) -> None:
        photo = self.make_photo(self.root / "approval.jpg")
        result = ClassificationEngine(
            FakeProvider(), self.database, "test-prompt"
        ).classify_batch([photo], "MV Example", "2026-11-10")[0]
        self.database.approve(result.id, self.taxonomy)
        approved = self.database.list_results([result.id])[0]
        self.assertEqual(approved.final_level1, "Main Deck")
        self.assertEqual(approved.review_status, "Approved")

        output = self.root / "results.xlsx"
        export_results([approved], output)
        workbook = load_workbook(output, read_only=True)
        sheet = workbook["Inspection Results"]
        self.assertEqual(
            tuple(cell.value for cell in sheet[1]),
            (
                "Photo Name",
                "Vessel",
                "Inspection Date",
                "AI Level 1",
                "Confidence",
                "Abhishek Classification",
                "Final Classification",
                "Review Status",
                "Reason",
            ),
        )
        workbook.close()

    def test_excel_export_cannot_overwrite_an_original_photo(self) -> None:
        photo = self.make_photo(self.root / "protected.jpg")
        original_digest = hashlib.sha256(photo.read_bytes()).digest()
        result = ClassificationEngine(
            FakeProvider(), self.database, "test-prompt"
        ).classify_batch([photo], "MV Example", "2026-11-10")[0]

        with self.assertRaisesRegex(ValueError, "cannot overwrite an original photograph"):
            export_results([result], photo)

        self.assertEqual(hashlib.sha256(photo.read_bytes()).digest(), original_digest)

    def test_ollama_provider_checks_model_and_parses_classification(self) -> None:
        photo = self.make_photo(self.root / "provider.jpg")
        provider = OllamaProvider(
            base_url="http://localhost:11434/",
            model_name="gemma3",
            prompt=self.configuration.prompt,
            taxonomy=self.taxonomy,
            timeout_seconds=5,
            max_image_dimension=1800,
        )
        with patch(
            "inspection_intelligence.services.ai.ollama_provider.urlopen",
            side_effect=[
                FakeResponse({"models": [{"name": "gemma3:latest"}]}),
                FakeResponse(
                    {
                        "response": json.dumps(
                            {
                                "level1": "Main Deck",
                                "confidence": 0.88,
                                "reason": "Deck plating is visible.",
                            }
                        )
                    }
                ),
            ],
        ) as mocked_urlopen:
            decision = provider.classify(photo)

        self.assertEqual(decision.level1, "Main Deck")
        self.assertEqual(decision.confidence, 0.88)
        self.assertEqual(mocked_urlopen.call_count, 2)

    def test_ollama_provider_rejects_unapproved_model_output(self) -> None:
        photo = self.make_photo(self.root / "invalid.jpg")
        provider = OllamaProvider(
            base_url="http://localhost:11434",
            model_name="gemma3",
            prompt=self.configuration.prompt,
            taxonomy=self.taxonomy,
            timeout_seconds=5,
            max_image_dimension=1800,
        )
        with patch(
            "inspection_intelligence.services.ai.ollama_provider.urlopen",
            side_effect=[
                FakeResponse({"models": [{"name": "gemma3"}]}),
                FakeResponse(
                    {
                        "response": json.dumps(
                            {
                                "level1": "Engine Room-ish",
                                "confidence": 0.75,
                                "reason": "A guess.",
                            }
                        )
                    }
                ),
            ],
        ):
            with self.assertRaisesRegex(OllamaError, "not an approved Level 1 value"):
                provider.classify(photo)

    def test_cache_reuses_only_matching_content_and_configuration(self):
        class CachedProvider(FakeProvider):
            cache_signature = 'model-digest-and-settings-v1'
            calls = 0

            def classify(self, path):
                self.calls += 1
                return super().classify(path)

        provider = CachedProvider()
        engine = ClassificationEngine(provider, self.database, 'v1')
        photo = self.make_photo(self.root / 'cached.jpg', size=(32, 24))
        first = engine.classify_batch([photo], 'Vessel A', '2026-11-10')[0]
        self.database.approve(first.id, self.taxonomy)
        second = engine.classify_batch([photo], 'Vessel B', '2026-11-11')[0]
        self.assertEqual(provider.calls, 1)
        self.assertEqual(second.vessel, 'Vessel B')
        self.assertEqual(second.review_status, 'Pending')
        self.assertIsNone(second.final_level1)
        Image.new('RGB', (32, 24), 'red').save(photo)
        engine.classify_batch([photo], 'Vessel B', '2026-11-11')
        self.assertEqual(provider.calls, 2)
        provider.cache_signature = 'new-model-digest'
        engine.classify_batch([photo], 'Vessel B', '2026-11-11')
        self.assertEqual(provider.calls, 3)
        engine.reuse_results = False
        engine.classify_batch([photo], 'Vessel B', '2026-11-11')
        self.assertEqual(provider.calls, 4)

    def test_review_required_cannot_be_approved_as_a_final_location(self):
        class UncertainProvider(FakeProvider):
            def __init__(self, level):
                super().__init__()
                self.level = level

            def classify(self, image_path):
                return ClassificationDecision(
                    self.level, 0.3, "Please review."
                )

        photo = self.make_photo(self.root / "uncertain.jpg", size=(32, 24))
        result = ClassificationEngine(
            UncertainProvider(self.taxonomy.review_required), self.database, "v1"
        ).classify_batch([photo], "Vessel", "2026-11-11")[0]

        with self.assertRaisesRegex(ValueError, "must be manually classified"):
            self.database.approve(result.id, self.taxonomy)

        unchanged = self.database.list_results([result.id])[0]
        self.assertEqual(unchanged.review_status, "Pending")
        self.assertIsNone(unchanged.final_level1)

    def test_results_arrive_incrementally_and_cancel_preserves_finished_photo(self):
        photos = [self.make_photo(self.root / f'{i}.jpg', size=(32, 24)) for i in range(3)]
        stop = threading.Event()
        seen = []

        def received(result):
            self.assertEqual(self.database.list_results([result.id])[0].filename, result.filename)
            seen.append(result)
            stop.set()

        results = ClassificationEngine(FakeProvider(), self.database, 'v1').classify_batch(
            photos, 'Vessel', '2026-11-10', result_callback=received, cancel_event=stop)
        self.assertEqual(len(results), 1)
        self.assertEqual(results, seen)

    def test_truncated_ai_response_is_not_saved_as_a_valid_decision(self):
        photo = self.make_photo(self.root / 'truncated.jpg', size=(32, 24))
        provider = OllamaProvider('http://localhost:11434', 'gemma3', self.configuration.prompt,
                                  self.taxonomy, 5, 768)
        provider._available = True
        with patch('inspection_intelligence.services.ai.ollama_provider.urlopen', return_value=FakeResponse({
                'response': '{"level1":"Hull","confidence":0.9,"reason":"Hull"}', 'done_reason': 'length'})):
            with self.assertRaisesRegex(OllamaError, 'output limit'):
                provider.classify(photo)


if __name__ == "__main__":
    unittest.main()
