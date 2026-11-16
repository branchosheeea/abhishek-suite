import json
from pathlib import Path


class Taxonomy:
    def __init__(self, values: list[str], review_required: str) -> None:
        if not values or any(not isinstance(value, str) or not value.strip() for value in values):
            raise ValueError("The Level 1 taxonomy must contain non-empty strings.")
        if len(set(values)) != len(values):
            raise ValueError("The Level 1 taxonomy contains duplicate values.")
        if review_required not in values:
            raise ValueError("The Review Required value must be included in the Level 1 taxonomy.")
        self.values = tuple(values)
        self.review_required = review_required
        self._value_set = set(values)

    @classmethod
    def from_file(cls, path: Path) -> "Taxonomy":
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        values = data.get("level1") if isinstance(data, dict) else None
        review_required = data.get("review_required") if isinstance(data, dict) else None
        if not isinstance(values, list) or not isinstance(review_required, str):
            raise ValueError(
                f"Taxonomy file must contain a 'level1' list and 'review_required' value: {path}"
            )
        return cls(values, review_required)

    def validate(self, value: str) -> str:
        if value not in self._value_set:
            raise ValueError(f"Classification is not an approved Level 1 value: {value}")
        return value
