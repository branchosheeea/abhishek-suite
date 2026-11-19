"""Suite module entry point; optional historical-import command line."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Lub Oil Consumption Review — Abhishek Automation Suite")
    parser.add_argument("--data-root", type=Path, help="Override the Suite runtime data directory")
    parser.add_argument("--import-folder", type=Path, help="Archive and parse historical files, without opening the UI")
    args = parser.parse_args()
    if args.import_folder:
        from .repository import Repository
        if not args.import_folder.is_dir():
            parser.error("Import folder does not exist")
        paths = [p for p in args.import_folder.rglob("*.xlsx") if p.is_file() and not p.name.startswith("~$")]
        Repository(args.data_root).import_paths(paths, lambda r: print(json.dumps(r, ensure_ascii=False), flush=True))
    else:
        from .ui import main as run_ui
        run_ui(args.data_root)


if __name__ == "__main__":
    from suite_services.access.guard import require_module
    require_module("oil")
    main()
