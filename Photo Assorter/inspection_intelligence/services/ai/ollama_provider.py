import base64
import json
import hashlib
from time import monotonic
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from inspection_intelligence.models import ClassificationDecision
from inspection_intelligence.services.storage.local_storage import prepare_image
from inspection_intelligence.taxonomy import Taxonomy


class OllamaError(RuntimeError):
    """A local Ollama service or model error."""


class OllamaProvider:
    def __init__(
        self,
        base_url: str,
        model_name: str,
        prompt: str,
        taxonomy: Taxonomy,
        timeout_seconds: int,
        max_image_dimension: int | None,
        max_output_tokens: int = 128,
        context_length: int = 2048,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.prompt = prompt
        self.taxonomy = taxonomy
        self.timeout_seconds = timeout_seconds
        self.max_image_dimension = max_image_dimension
        self._available = False
        self.max_output_tokens = max_output_tokens
        self.context_length = context_length
        self.model_digest = None
        self.last_metrics = {}

    @property
    def cache_signature(self) -> str | None:
        # Do not reuse results across unknown or changed model weights.
        if not self.model_digest:
            return None
        settings = ("image-pipeline-v1", self.base_url, self.model_name, self.model_digest,
                    self.prompt, self.taxonomy.values, self.max_image_dimension,
                    self.max_output_tokens, self.context_length, "compact-schema-v1")
        return hashlib.sha256(json.dumps(settings).encode()).hexdigest()

    def ensure_available(self) -> None:
        request = Request(f"{self.base_url}/api/tags", method="GET")
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            raise OllamaError(
                f"Cannot reach Ollama at {self.base_url}. Start Ollama and try again. Details: {error}"
            ) from error

        models = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models, list):
            raise OllamaError("Ollama returned an invalid model list.")
        requested = self.model_name if ":" in self.model_name else f"{self.model_name}:latest"
        selected = next((entry for entry in models if isinstance(entry, dict)
                         and entry.get("name") in (self.model_name, requested)), None)
        if selected is None:
            raise OllamaError(
                f"Ollama model '{self.model_name}' is not installed. "
                f"Pull the model locally, then try again."
            )
        self._available = True
        self.model_digest = selected.get("digest")

    def classify(self, image_path: Path) -> ClassificationDecision:
        self.last_metrics = {}
        started = monotonic()
        if not self._available:
            self.ensure_available()
        image_bytes, _media_type = prepare_image(image_path, self.max_image_dimension)
        prepare_seconds = monotonic() - started
        prompt = self.prompt.replace("{taxonomy}", ", ".join(self.taxonomy.values))
        prompt += "\nUse at most 12 words for reason. Return compact JSON without whitespace."
        payload = {
            "model": self.model_name,
            "prompt": prompt,
            "images": [base64.b64encode(image_bytes).decode("ascii")],
            "format": {
                "type": "object",
                "properties": {
                    "level1": {"type": "string", "enum": list(self.taxonomy.values)},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "reason": {"type": "string"},
                },
                "required": ["level1", "confidence", "reason"],
                "additionalProperties": False,
            },
            "stream": False,
            "keep_alive": "30m",
            "options": {"temperature": 0, "num_predict": self.max_output_tokens,
                        "num_ctx": self.context_length},
        }
        request = Request(
            f"{self.base_url}/api/generate",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise OllamaError(f"Ollama request failed (HTTP {error.code}): {body}") from error
        except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            raise OllamaError(f"Ollama classification request failed: {error}") from error

        if not isinstance(result, dict) or not isinstance(result.get("response"), str):
            raise OllamaError("Ollama returned a malformed response.")
        self.last_metrics = {
            "prepare_seconds": round(prepare_seconds, 3),
            "wall_seconds": round(monotonic() - started, 3),
            **{key.replace("_duration", "_seconds"): round(result.get(key, 0) / 1e9, 3)
               for key in ("load_duration", "prompt_eval_duration", "eval_duration")},
            "output_tokens": result.get("eval_count", 0),
        }
        if result.get("done_reason") == "length":
            raise OllamaError("AI response reached the output limit; increase max_output_tokens in settings.")
        try:
            decision_data = json.loads(result["response"])
        except json.JSONDecodeError as error:
            raise OllamaError("The model response was not valid JSON.") from error
        if not isinstance(decision_data, dict):
            raise OllamaError("The model response must be a JSON object.")

        level1 = decision_data.get("level1")
        confidence = decision_data.get("confidence")
        reason = decision_data.get("reason")
        if not isinstance(level1, str):
            raise OllamaError("The model response is missing a valid 'level1' value.")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            raise OllamaError("The model response is missing a numeric 'confidence'.")
        if not 0 <= confidence <= 1:
            raise OllamaError("Model confidence must be between 0.0 and 1.0.")
        if not isinstance(reason, str) or not reason.strip():
            raise OllamaError("The model response is missing a non-empty 'reason'.")
        try:
            self.taxonomy.validate(level1)
        except ValueError as error:
            raise OllamaError(str(error)) from error

        return ClassificationDecision(level1, float(confidence), reason.strip())
