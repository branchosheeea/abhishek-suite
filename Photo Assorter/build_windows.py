import argparse
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the Windows desktop application.")
    parser.add_argument(
        "--output-directory",
        default="release",
        help="Output directory relative to the project root (default: release).",
    )
    arguments = parser.parse_args()
    release_root = (PROJECT_ROOT / arguments.output_directory).resolve()
    if not release_root.is_relative_to(PROJECT_ROOT.resolve()):
        raise SystemExit("The output directory must be inside the project folder.")
    bundle_path = release_root / "InspectionIntelligence"
    archive_path = release_root / "InspectionIntelligence-Windows.zip"
    if bundle_path.exists() or archive_path.exists():
        raise SystemExit(
            "Release output already exists. Move or rename it before building again."
        )

    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", "requirements-build.txt"],
        cwd=PROJECT_ROOT,
        check=True,
    )
    release_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--onedir",
            "--windowed",
            "--name",
            "InspectionIntelligence",
            "--distpath",
            str(release_root),
            "--workpath",
            str(PROJECT_ROOT / "build" / release_root.name),
            "app.py",
        ],
        cwd=PROJECT_ROOT,
        check=True,
    )

    shutil.copytree(PROJECT_ROOT / "config", bundle_path / "config")
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in bundle_path.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(release_root))

    print(f"Build complete:\n  App folder: {bundle_path}\n  Shareable ZIP: {archive_path}")


if __name__ == "__main__":
    main()
