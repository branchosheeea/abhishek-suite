"""Local runtime paths and immutable, content-addressed source storage."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import tempfile


def runtime_root():
    override = os.environ.get("ABHISHEK_SUITE_DATA")
    return Path(override) if override else Path(os.environ.get("LOCALAPPDATA", Path.home())) / "AbhishekAutomationSuite"


def archive_file(source, root):
    source, root = Path(source), Path(root)
    if source.stat().st_size > 30 * 1024 * 1024:
        raise ValueError("Workbook exceeds the 30 MB import limit.")
    before = source.stat()
    folder = root / "originals"
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    temporary = None
    try:
        with source.open("rb") as incoming, tempfile.NamedTemporaryFile(dir=folder, delete=False) as outgoing:
            temporary = Path(outgoing.name)
            for block in iter(lambda: incoming.read(1024 * 1024), b""):
                digest.update(block)
                outgoing.write(block)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("The source changed during import. Save/close it and retry.")
        sha = digest.hexdigest()
        target = folder / sha[:2] / (sha + source.suffix.lower())
        target.parent.mkdir(exist_ok=True)
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != sha:
                raise ValueError("Archived source failed its integrity check.")
        else:
            # Identical hashes are identical bytes even if two importers race here.
            os.replace(temporary, target)
        return sha, target
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
