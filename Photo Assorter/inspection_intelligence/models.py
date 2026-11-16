from dataclasses import dataclass
from pathlib import Path


@dataclass
class ClassificationResult:
    filename: str
    original_path: str
    vessel: str
    inspection_date: str
    ai_level1: str | None
    ai_confidence: float | None
    ai_reason: str
    processing_time_ms: int
    status: str
    model_name: str
    prompt_version: str
    abhishek_level1: str | None = None
    final_level1: str | None = None
    review_status: str = "Pending"
    id: int | None = None

    @property
    def match(self) -> bool | None:
        if self.abhishek_level1 is None:
            return None
        return self.ai_level1 == self.abhishek_level1

    @property
    def path(self) -> Path:
        return Path(self.original_path)


@dataclass(frozen=True)
class ClassificationDecision:
    level1: str
    confidence: float
    reason: str
