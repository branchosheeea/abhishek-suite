"""Console-free entry point for the Windows shortcuts."""
import ctypes
import os
from pathlib import Path
import runpy
import sys
import traceback


def main():
    root = Path(__file__).resolve().parent
    os.chdir(root)
    if "--reports" in sys.argv:
        script = "vessel_report/__main__.py"
        log_path = root / "diagnostics" / "vessel_report_desktop.log"
    else:
        script = "abhishek_automation_suite.py"
        log_path = root / "diagnostics" / "abhishek_automation_suite_desktop.log"
    try:
        log_path.parent.mkdir(exist_ok=True)
        with log_path.open("a", encoding="utf-8", buffering=1) as log:
            sys.stdout = sys.stderr = log
            try:
                runpy.run_path(str(root / script), run_name="__main__")
            except Exception:
                traceback.print_exc()
                raise
            finally:
                sys.stdout = sys.__stdout__
                sys.stderr = sys.__stderr__
    except Exception as error:
        ctypes.windll.user32.MessageBoxW(
            None, f"The app could not start or encountered an error.\n\n{error}\n\nDetails: {log_path}",
            "NeraVeda", 0x10,
        )


if __name__ == "__main__":
    main()
