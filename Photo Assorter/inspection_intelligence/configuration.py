import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from inspection_intelligence.taxonomy import Taxonomy

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def get_config_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "config"
    return PROJECT_ROOT / "config"


def get_data_directory() -> Path:
    if not getattr(sys, "frozen", False):
        return PROJECT_ROOT / "data"
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "Inspection Intelligence" / "data"


@dataclass(frozen=True)
class AppConfiguration:
    ollama_url: str
    model_name: str
    request_timeout_seconds: int
    max_image_dimension: int | None
    prompt_version: str
    prompt: str
    taxonomy: Taxonomy
    max_output_tokens: int = 128
    context_length: int = 2048
    reuse_results: bool = True
    processing_mode: str = "detailed"


def load_configuration(config_directory: Path | None = None) -> AppConfiguration:
    if config_directory is None:
        config_directory = get_config_directory()
    with (config_directory / "settings.json").open("r", encoding="utf-8") as file:
        settings = json.load(file)
    if not isinstance(settings, dict):
        raise ValueError("Settings file must contain a JSON object.")

    max_dimension = settings.get("max_image_dimension")
    if max_dimension is not None and (
        isinstance(max_dimension, bool) or not isinstance(max_dimension, int) or max_dimension < 1
    ):
        raise ValueError("'max_image_dimension' must be a positive integer or null.")
    timeout = settings.get("request_timeout_seconds")
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
        raise ValueError("'request_timeout_seconds' must be a positive integer.")
    for key in ("ollama_url", "model_name", "prompt_version"):
        if not isinstance(settings.get(key), str) or not settings[key].strip():
            raise ValueError(f"Settings must define a non-empty '{key}'.")

    prompt = (config_directory / "level1_prompt.txt").read_text(encoding="utf-8")
    taxonomy = Taxonomy.from_file(config_directory / "level1_taxonomy.json")
    for key, default in (("max_output_tokens", 128), ("context_length", 2048)):
        value = settings.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < 64:
            raise ValueError(f"'{key}' must be an integer of at least 64.")
    if not isinstance(settings.get("reuse_results", True), bool):
        raise ValueError("'reuse_results' must be true or false.")
    if settings.get("processing_mode", "detailed") not in ("fast", "detailed"):
        raise ValueError("'processing_mode' must be 'fast' or 'detailed'.")
    return AppConfiguration(
        ollama_url=settings["ollama_url"],
        model_name=settings["model_name"],
        request_timeout_seconds=timeout,
        max_image_dimension=max_dimension,
        prompt_version=settings["prompt_version"],
        prompt=prompt,
        taxonomy=taxonomy,
        max_output_tokens=settings.get("max_output_tokens", 128),
        context_length=settings.get("context_length", 2048),
        reuse_results=settings.get("reuse_results", True),
        processing_mode=settings.get("processing_mode", "detailed"),
    )
