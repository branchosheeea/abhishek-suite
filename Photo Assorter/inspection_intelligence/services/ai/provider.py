from pathlib import Path
from typing import Protocol

from inspection_intelligence.models import ClassificationDecision


class AIProvider(Protocol):
    model_name: str

    def ensure_available(self) -> None: ...

    def classify(self, image_path: Path) -> ClassificationDecision: ...
