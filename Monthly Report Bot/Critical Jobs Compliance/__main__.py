"""Entry point: python "Critical Jobs Compliance" (launched by the Neraveda suite)."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # suite root: vessel_report, suite_services, report_catalog
for path in (str(ROOT), str(HERE)):
    if path not in sys.path:
        sys.path.insert(0, path)

from cjc.ui import main  # noqa: E402

if __name__ == "__main__":
    main()
