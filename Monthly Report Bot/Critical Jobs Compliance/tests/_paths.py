"""Make the module package and the suite root importable from any runner."""
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1]
ROOT = MODULE.parent
for path in (str(ROOT), str(MODULE)):
    if path not in sys.path:
        sys.path.insert(0, path)
