from dataclasses import replace
import hashlib
import json
import threading
from pathlib import Path
from time import monotonic
from typing import Callable

from inspection_intelligence.models import ClassificationResult
from inspection_intelligence.persistence.database import Database
from inspection_intelligence.services.ai.provider import AIProvider
from inspection_intelligence.taxonomy import Taxonomy


class ClassificationEngine:
    def __init__(
        self,
        provider: AIProvider,
        database: Database,
        prompt_version: str,
        reuse_results: bool = True,
    ) -> None:
        self.provider = provider
        self.database = database
        self.prompt_version = prompt_version
        self.reuse_results = reuse_results

    def classify_batch(
        self,
        photos: list[Path],
        vessel: str,
        inspection_date: str,
        progress_callback: Callable[[int, int, str], None] | None = None,
        event_callback: Callable[[str], None] | None = None,
        result_callback: Callable[[ClassificationResult], None] | None = None,
        cancel_event: threading.Event | None = None,
    ) -> list[ClassificationResult]:
        if not vessel.strip():
            raise ValueError("Vessel is required.")
        if not inspection_date.strip():
            raise ValueError("Inspection date is required.")

        try:
            if event_callback is not None:
                event_callback("Checking connection / availability of the selected local model.")
            self.provider.ensure_available()
            if event_callback is not None:
                event_callback(
                    f"Local model '{self.provider.model_name}' is available."
                )
        except Exception as error:
            if event_callback is not None:
                event_callback(f"Model preflight failed: {error}")
            raise RuntimeError(f"The selected AI provider could not start: {error}") from error

        results: list[ClassificationResult] = []
        total = len(photos)
        for index, photo_path in enumerate(photos, start=1):
            if cancel_event is not None and cancel_event.is_set():
                if event_callback:
                    event_callback("Stopped before the next photo; completed results are saved.")
                break
            started = monotonic()
            if event_callback is not None:
                event_callback(f"Starting photo {index}/{total}: {photo_path.name}")
            try:
                cache_key = None
                decision = None
                signature = getattr(self.provider, "cache_signature", None)
                if self.reuse_results and signature:
                    with photo_path.open("rb") as source:
                        digest = hashlib.sha256()
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            digest.update(chunk)
                        image_hash = digest.hexdigest()
                    cache_key = hashlib.sha256(
                        f"{signature}:{self.prompt_version}:{image_hash}".encode()
                    ).hexdigest()
                    decision = self.database.get_cached_decision(cache_key)
                cached = decision is not None
                if decision is None:
                    decision = self.provider.classify(photo_path)
                    if cache_key:
                        self.database.cache_decision(cache_key, decision)
                if event_callback:
                    if cached:
                        event_callback(f"Reused exact-photo AI result: {photo_path.name}")
                    elif getattr(self.provider, "last_metrics", None):
                        event_callback(f"Timing {photo_path.name}: "
                                       f"{json.dumps(self.provider.last_metrics)}")
                result = ClassificationResult(
                    filename=photo_path.name,
                    original_path=str(photo_path.resolve()),
                    vessel=vessel.strip(),
                    inspection_date=inspection_date.strip(),
                    ai_level1=decision.level1,
                    ai_confidence=decision.confidence,
                    ai_reason=decision.reason,
                    processing_time_ms=round((monotonic() - started) * 1000),
                    status="Processed",
                    model_name=self.provider.model_name,
                    prompt_version=self.prompt_version,
                )
                if event_callback is not None:
                    event_callback(
                        f"Classified {photo_path.name}: {decision.level1} "
                        f"({decision.confidence:.0%}) in {result.processing_time_ms} ms."
                    )
            except Exception as error:
                result = ClassificationResult(
                    filename=photo_path.name,
                    original_path=str(photo_path.resolve()),
                    vessel=vessel.strip(),
                    inspection_date=inspection_date.strip(),
                    ai_level1=None,
                    ai_confidence=None,
                    ai_reason=f"Processing failed: {error}",
                    processing_time_ms=round((monotonic() - started) * 1000),
                    status="Failed",
                    model_name=self.provider.model_name,
                    prompt_version=self.prompt_version,
                )
                if event_callback is not None:
                    event_callback(f"Failed {photo_path.name}: {error}")

            result = replace(result, id=self.database.add_result(result))
            results.append(result)
            if result_callback is not None:
                result_callback(result)
            if progress_callback is not None:
                progress_callback(index, total, photo_path.name)
        return results


def summarize(
    results: list[ClassificationResult], taxonomy: Taxonomy
) -> dict[str, int | float | None]:
    total = len(results)
    processed = sum(result.status == "Processed" for result in results)
    failed = sum(result.status == "Failed" for result in results)
    exact_matches = sum(result.match is True for result in results)
    reference_count = sum(result.abhishek_level1 is not None for result in results)
    total_time_ms = sum(result.processing_time_ms for result in results)
    return {
        "total": total,
        "processed": processed,
        "failed": failed,
        "exact_matches": exact_matches,
        "mismatches": reference_count - exact_matches,
        "accuracy": exact_matches / reference_count if reference_count else None,
        "average_processing_time_ms": total_time_ms / total if total else 0,
        "total_processing_time_ms": total_time_ms,
        "review_required": sum(
            result.ai_level1 == taxonomy.review_required for result in results
        ),
    }
