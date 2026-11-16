"""Portal facts and the confirmed Critical Job filter profile.

Every value here was observed on the live PAL portal (Job Overview Report,
15-Nov-2026). Change them only on the basis of fresh live evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from suite_services.storage import runtime_root

MODULE_NAME = "Critical Job Compliance"

# Own Edge profile outside OneDrive, so this module never contends for the
# Vessel Report Centre's locked bot profile. SSO signs in automatically.
DATA_ROOT = runtime_root() / "critical_jobs"
PROFILE = DATA_ROOT / "edge_profile"
DIAGNOSTICS = DATA_ROOT / "diagnostics"
EXPORT_ROOT = Path.home() / "Downloads" / "Critical Job Compliance"

# Navigation: main menu > Maintenance > Reports > Job Overview (opens a new tab).
MENU_PATH = ("Maintenance", "Reports", "Job Overview")
JOB_OVERVIEW_URL_MARKER = "/Maintenance/JobOverview"
GRID = "#jobOverviewGrid"
APPLY_BUTTON = ".btn-icon-apply-search-result:visible"
SUBLEVEL_CHECKBOX = "#sublevel"
OVERDUE_CHECKBOX = "#Overdue"
GRID_READ_URL = "ServiceRouter/POST"

# Every filter dropdown on the page, so a run never inherits a stale selection.
ALL_SELECTS = ("Job Type", "Maintenance Type", "Job Priority", "Equipment Type", "Discipline",
               "Maintenance Cause", "Safety Level", "Risk Assessment Required", "Critical to Safety")
SELECT_ALL_TEXT = {"Risk Assessment Required": "ALL", "Critical to Safety": "ALL"}  # others: "Select All"


def select_all_text(label: str) -> str:
    return SELECT_ALL_TEXT.get(label, "Select All")


@dataclass(frozen=True)
class FilterProfile:
    """What to set in the portal, and what the result must prove it received."""
    key: str
    name: str
    equipment_node: str
    show_sublevel: bool
    show_overdue: bool
    selects: dict[str, str]                       # label -> option text (unlisted -> Select All/ALL)
    expected_payload: dict[str, object] = field(default_factory=dict)  # grid read request fields
    expected_row_values: dict[str, str] = field(default_factory=dict)  # every returned row

    def option_for(self, label: str) -> str:
        return self.selects.get(label, select_all_text(label))

    def summary(self) -> list[str]:
        parts = [self.equipment_node]
        parts.append("Sublevel equipment" if self.show_sublevel else "Top level only")
        if self.show_overdue:
            parts.append("Overdue only")
        parts += [f"{label} = {value}" for label, value in self.selects.items()]
        return parts

    def as_record(self) -> dict:
        return dict(key=self.key, name=self.name, equipment_node=self.equipment_node,
                    show_sublevel=self.show_sublevel, show_overdue=self.show_overdue,
                    selects={label: self.option_for(label) for label in ALL_SELECTS})


# Confirmed by the user on 15-Nov-2026.
CRITICAL_JOB_FILTERS = FilterProfile(
    key="critical-jobs-v1",
    name="Critical Job Plans",
    equipment_node="A - EQUIPMENT",
    show_sublevel=True,
    show_overdue=False,
    selects={"Risk Assessment Required": "YES", "Critical to Safety": "YES"},
    expected_payload={"riskAnalysis": "Y", "chkCritical": "Y", "chkSubEquips": "Y", "chkOverdue": "N"},
    expected_row_values={"riskAnalysis": "YES", "criticalSafety": "YES"},
)
