"""The inspection web app's vessel picker must offer the same fleet as the desktop suite."""

import re
from pathlib import Path

from report_catalog import VESSELS

VESSELS_TS = Path(__file__).resolve().parents[1] / "Superintendent inspection Report" / "lib" / "vessels.ts"


def test_web_fleet_list_matches_report_catalog():
    source = VESSELS_TS.read_text(encoding="utf-8")
    block = re.search(r"FLEET_VESSELS = \[(.*?)\] as const", source, re.S)
    assert block, "FLEET_VESSELS not found in lib/vessels.ts"
    assert re.findall(r'"([^"]+)"', block.group(1)) == VESSELS
