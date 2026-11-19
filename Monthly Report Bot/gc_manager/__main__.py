"""Launch Guarantee Claim Manager."""
import argparse
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description="Guarantee Claim Manager")
    parser.add_argument("--data-root",type=Path,help="Override Suite runtime data directory")
    args=parser.parse_args()
    from .ui import main as run_ui
    run_ui(args.data_root)


if __name__=="__main__":
    from suite_services.access.guard import require_module
    require_module("gc")
    main()
