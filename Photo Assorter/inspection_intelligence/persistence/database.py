from contextlib import contextmanager
import sqlite3
from pathlib import Path
from typing import Iterator

from inspection_intelligence.models import ClassificationResult, ClassificationDecision
from inspection_intelligence.taxonomy import Taxonomy


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS classification_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL,
                    original_path TEXT NOT NULL,
                    vessel TEXT NOT NULL,
                    inspection_date TEXT NOT NULL,
                    ai_level1 TEXT,
                    ai_confidence REAL,
                    ai_reason TEXT NOT NULL,
                    abhishek_level1 TEXT,
                    final_level1 TEXT,
                    review_status TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    prompt_version TEXT NOT NULL,
                    processing_time_ms INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_results_path_date "
                "ON classification_results (original_path, inspection_date)"
            )
            connection.execute("""
                CREATE TABLE IF NOT EXISTS decision_cache (
                    cache_key TEXT PRIMARY KEY,
                    level1 TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    reason TEXT NOT NULL
                )
            """)

    def get_cached_decision(self, cache_key: str) -> ClassificationDecision | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT level1, confidence, reason FROM decision_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        return ClassificationDecision(*row) if row else None

    def cache_decision(self, cache_key: str, decision: ClassificationDecision) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO decision_cache VALUES (?, ?, ?, ?)",
                (cache_key, decision.level1, decision.confidence, decision.reason),
            )

    def add_result(self, result: ClassificationResult) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO classification_results (
                    filename, original_path, vessel, inspection_date, ai_level1,
                    ai_confidence, ai_reason, abhishek_level1, final_level1,
                    review_status, model_name, prompt_version, processing_time_ms, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result.filename,
                    result.original_path,
                    result.vessel,
                    result.inspection_date,
                    result.ai_level1,
                    result.ai_confidence,
                    result.ai_reason,
                    result.abhishek_level1,
                    result.final_level1,
                    result.review_status,
                    result.model_name,
                    result.prompt_version,
                    result.processing_time_ms,
                    result.status,
                ),
            )
            return int(cursor.lastrowid)

    def list_results(self, ids: list[int] | None = None) -> list[ClassificationResult]:
        with self._connect() as connection:
            if ids is None:
                rows = connection.execute(
                    "SELECT * FROM classification_results ORDER BY id"
                ).fetchall()
            elif not ids:
                return []
            else:
                placeholders = ",".join("?" for _ in ids)
                rows = connection.execute(
                    f"SELECT * FROM classification_results WHERE id IN ({placeholders}) ORDER BY id",
                    ids,
                ).fetchall()
        return [self._from_row(row) for row in rows]

    def approve(self, result_id: int, taxonomy: Taxonomy) -> None:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE classification_results
                SET final_level1 = ai_level1, review_status = 'Approved'
                WHERE id = ? AND ai_level1 IS NOT NULL AND ai_level1 != ?
                """,
                (result_id, taxonomy.review_required),
            )
            if cursor.rowcount != 1:
                raise ValueError(
                    "Only a specific AI Level 1 location can be approved. "
                    "Review Required must be manually classified first."
                )

    def set_abhishek_classification(
        self, result_id: int, value: str, taxonomy: Taxonomy
    ) -> None:
        taxonomy.validate(value)
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE classification_results
                SET abhishek_level1 = ?, final_level1 = ?, review_status = 'Changed'
                WHERE id = ?
                """,
                (value, value, result_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Classification result {result_id} does not exist.")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> ClassificationResult:
        return ClassificationResult(
            id=row["id"],
            filename=row["filename"],
            original_path=row["original_path"],
            vessel=row["vessel"],
            inspection_date=row["inspection_date"],
            ai_level1=row["ai_level1"],
            ai_confidence=row["ai_confidence"],
            ai_reason=row["ai_reason"],
            abhishek_level1=row["abhishek_level1"],
            final_level1=row["final_level1"],
            review_status=row["review_status"],
            model_name=row["model_name"],
            prompt_version=row["prompt_version"],
            processing_time_ms=row["processing_time_ms"],
            status=row["status"],
        )
