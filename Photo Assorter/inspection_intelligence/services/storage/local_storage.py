from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def discover_photos(folder: Path) -> list[Path]:
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError(f"Inspection photo folder does not exist: {folder}")
    return sorted(
        (
            path
            for path in folder.rglob("*")
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        ),
        key=lambda path: str(path).casefold(),
    )


def prepare_image(image_path: Path, max_dimension: int | None) -> tuple[bytes, str]:
    """Read an original without writing to it; return validated, optionally optimized bytes."""
    with Image.open(image_path) as source:
        source.load()
        if max_dimension is None:
            return image_path.read_bytes(), _media_type(image_path)

        image = ImageOps.exif_transpose(source)
        image.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.getchannel("A"))
            image = background
        else:
            image = image.convert("RGB")

        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=90, optimize=True)
        return buffer.getvalue(), "image/jpeg"


def _media_type(image_path: Path) -> str:
    if image_path.suffix.lower() == ".png":
        return "image/png"
    return "image/jpeg"
