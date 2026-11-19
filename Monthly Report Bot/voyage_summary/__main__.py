"""Voyage Summary dashboard for the Abhishek Automation Suite."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
import math
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox

import customtkinter as ctk
from openpyxl import load_workbook

BG = "#0b1428"
NAVY = "#121d33"
PANEL = "#151f34"
BORDER = "#1e2b43"
TEXT = "#dce5ff"
MUTED = "#8794a9"
TEAL = "#25d5f2"
GREEN = "#39d9a5"
CYAN = "#35c9ee"
YELLOW = "#ffb84d"
WHITE = "#e7edff"

NOON_REPORT_NAME = "Log Report 11 NOV 2026 Noon-.xlsx"
VOYAGE_EXTRACT_NAME = "VoyageDataExtract12Nov26 addax.xlsx"
PROJECT_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class VoyageDataset:
    vessel: str
    records: tuple[dict[str, object], ...]
    source_path: Path
    source_format: str = "Noon at Sea"

    @property
    def latest(self) -> dict[str, object]:
        return self.records[-1]


def load_voyage_data(path: Path | None = None) -> VoyageDataset:
    """Load a supported Noon report or VoyageDataExtract workbook."""
    candidates = (
        (path,)
        if path is not None
        else (
            PROJECT_DIR / "data" / NOON_REPORT_NAME,
            Path.home() / "Downloads" / NOON_REPORT_NAME,
            PROJECT_DIR / "data" / VOYAGE_EXTRACT_NAME,
        )
    )
    workbook = None
    source = None
    permission_error = None
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            workbook = load_workbook(candidate, data_only=True, read_only=True)
        except PermissionError as exc:
            permission_error = exc
            continue
        source = candidate
        break
    if source is None or workbook is None:
        if permission_error is not None:
            expected = "\n".join(str(candidate) for candidate in candidates)
            raise PermissionError(
                f"Cannot read the voyage workbook. Close it in Excel and check file "
                f"permissions. Checked:\n{expected}"
            ) from permission_error
        expected = "\n".join(str(candidate) for candidate in candidates)
        raise FileNotFoundError(f"No supported voyage workbook was found. Checked:\n{expected}")
    try:
        worksheet = workbook["Log Report"] if "Log Report" in workbook.sheetnames else workbook.active
        if worksheet["C3"].value != "NOON AT SEA":
            headers = {cell.value for cell in worksheet[1] if cell.value is not None}
            required = {"Log Date Local", "Voyage/Leg Number", "Distance Over Ground (nm)"}
            if required.issubset(headers):
                return _parse_voyage_extract(worksheet, source)
            raise ValueError(f"Unsupported voyage workbook layout: {source}")

        def cell(coordinate: str) -> object:
            return worksheet[coordinate].value

        report_date = cell("D6")
        if not isinstance(report_date, datetime):
            raise ValueError(f"The Noon report has no valid report date in D6: {source}")
        eta_date = cell("D38")
        eta_time = cell("D39")
        eta: datetime | None = None
        if isinstance(eta_date, datetime):
            eta = datetime.combine(eta_date.date(), eta_time if isinstance(eta_time, time) else time())
        loading_condition = (
            "Laden"
            if cell("P23") == "Y"
            else "Ballast"
            if cell("P21") == "Y"
            else None
        )

        record: dict[str, object] = {
            "Log Date Local": report_date,
            "Vessel": cell("M6"),
            "IMO Number": cell("Q6"),
            "Voyage/Leg Number": cell("D8"),
            "Next Port": cell("D41"),
            "Loading Condition": loading_condition,
            "Sailing Course": cell("N12"),
            "Charter Party Min Speed": cell("N14"),
            "Charter Party Max Speed": cell("N16"),
            "Latitude": " ".join(
                str(cell(coordinate)) for coordinate in ("D16", "E16", "F16", "J16")
                if cell(coordinate) is not None
            ),
            "Longitude": " ".join(
                str(cell(coordinate)) for coordinate in ("D18", "E18", "F18", "J18")
                if cell(coordinate) is not None
            ),
            "Average Speed over ground (knots)": cell("D28"),
            "Average Speed over water (knots)": cell("N28"),
            "Distance Over Ground (nm)": cell("D34"),
            "Total Distance on Passage (nm)": cell("N34"),
            "Distance to go (nm)": cell("D36"),
            "Total Steaming on Passage (hrs)": cell("N36"),
            "Draft Fwd": cell("D32"),
            "Draft Aft": cell("N32"),
            "ETA": eta,
            "M/E Running Hours": cell("D54"),
            "M/E RPM": cell("N54"),
            "M/E Average Load (%)": cell("N59"),
            "M/E Average Power (kW)": cell("N60"),
            "M/E SFOC (g/kWh)": cell("N68"),
            "M/E SCOC (g/kWh)": cell("N69"),
            "M/E Scavenge Pressure (kg/cm2)": cell("N65"),
            "Lube Oil Pressure (kg/cm2)": cell("D65"),
            "M/E Cooling Water In (deg C)": cell("D57"),
            "M/E Cooling Water Out (deg C)": cell("D58"),
            "M/E Turbocharger 1 RPM": cell("N55"),
            "M/E Turbocharger 2 RPM": cell("N56"),
            "M/E Turbocharger 1 Inlet Temp (deg C)": cell("Q55"),
            "M/E Turbocharger 1 Outlet Temp (deg C)": cell("R55"),
            "M/E Turbocharger 2 Inlet Temp (deg C)": cell("Q56"),
            "M/E Turbocharger 2 Outlet Temp (deg C)": cell("R56"),
            "Cylinder Exhaust Temp Min (deg C)": cell("D60"),
            "Cylinder Exhaust Temp Max (deg C)": cell("D61"),
            "M/E Index (mm)": cell("N61"),
            "M/E Scavenge Air Temp (deg C)": cell("N63"),
            "M/E Scavenge Pressure Drop (mm H2O)": cell("N67"),
            "Engine Room Air Temp (deg C)": cell("D67"),
            "Sea Water Temp (deg C)": cell("D69"),
            "Sludge Tank Capacity (MT)": cell("K110"),
            "Sludge Quantity (MT)": cell("N110"),
            "Bilge Tank Capacity (MT)": cell("K112"),
            "Bilge Quantity (MT)": cell("N112"),
            "AE1 Energy (kWh)": cell("D80"),
            "AE1 Running Hours": cell("M80"),
            "AE2 Energy (kWh)": cell("D81"),
            "AE2 Running Hours": cell("M81"),
            "AE3 Energy (kWh)": cell("D82"),
            "AE3 Running Hours": cell("M82"),
            "AE4 Energy (kWh)": cell("D83"),
            "AE4 Running Hours": cell("M83"),
            "Turbo Alternator Energy (kWh)": cell("D84"),
            "Turbo Alternator Hours": cell("M84"),
            "Total DG Running Hours": cell("M85"),
            "AE SFOC (g/kWh)": cell("D86"),
            "HSFO Sulfur (%)": cell("K91"),
            "LSFO Sulfur (%)": cell("L91"),
            "LSDO Sulfur (%)": cell("N91"),
            "HFO ROB (MT)": cell("K100"),
            "LFO ROB (MT)": cell("L100"),
            "HSDO ROB (MT)": cell("M100"),
            "LSDO ROB (MT)": cell("N100"),
            "Total FO ROB (MT)": cell("Q100"),
            "Total DO ROB (MT)": cell("R100"),
            "Cargo Name": cell("C124"),
            "Cargo Onboard": cell("C126"),
            "Wind Force (Beaufort)": cell("D43"),
            "Wind Direction": cell("N43"),
            "Sea Current Speed (knots)": cell("D45"),
            "Sea Current Direction": cell("N45"),
            "Swell Height (m)": cell("D47"),
            "Swell Direction": cell("N47"),
            "Fresh Water Consumption (MT)": cell("D116"),
            "Fresh Water Production (MT)": cell("D118"),
            "Fresh Water ROB (MT)": cell("D120"),
            "Ship's Clock Comment": cell("L115"),
            "Cylinder Oil Consumption": cell("K104"),
            "Cylinder Oil ROB": cell("M104"),
            "Cylinder Oil Type": cell("N104"),
            "ME Oil Consumption": cell("K105"),
            "ME Oil ROB": cell("M105"),
            "ME Oil Type": cell("N105"),
            "DG Oil Consumption": cell("K106"),
            "DG Oil ROB": cell("M106"),
            "DG Oil Type": cell("N106"),
            "HFO Consumption ME (MT)": cell("K92"),
            "LFO Consumption ME (MT)": cell("L92"),
            "HSDO Consumption ME (MT)": cell("M92"),
            "LSDO Consumption ME (MT)": cell("N92"),
            "Total FO Consumption ME (MT)": cell("Q92"),
            "Total DO Consumption ME (MT)": cell("R92"),
            "HFO Consumption Generators (MT)": cell("K93"),
            "LFO Consumption Generators (MT)": cell("L93"),
            "HSDO Consumption Generators (MT)": cell("M93"),
            "LSDO Consumption Generators (MT)": cell("N93"),
            "Total FO Consumption Generators (MT)": cell("Q93"),
            "Total DO Consumption Generators (MT)": cell("R93"),
            "Cargo heating HFO (MT)": cell("K94"),
            "Cargo heating LFO (MT)": cell("L94"),
            "Cargo heating HSDO (MT)": cell("M94"),
            "Cargo heating LSDO (MT)": cell("N94"),
            "Cargo heating total FO (MT)": cell("Q94"),
            "Cargo heating total DO (MT)": cell("R94"),
            "Boiler HFO (MT)": cell("K95"),
            "Boiler LFO (MT)": cell("L95"),
            "Boiler HSDO (MT)": cell("M95"),
            "Boiler LSDO (MT)": cell("N95"),
            "Boiler total FO (MT)": cell("Q95"),
            "Boiler total DO (MT)": cell("R95"),
            "Incinerator HFO (MT)": cell("K97"),
            "Incinerator LFO (MT)": cell("L97"),
            "Incinerator HSDO (MT)": cell("M97"),
            "Incinerator LSDO (MT)": cell("N97"),
            "Incinerator total FO (MT)": cell("Q97"),
            "Incinerator total DO (MT)": cell("R97"),
            "IGG HFO (MT)": cell("K98"),
            "IGG LFO (MT)": cell("L98"),
            "IGG HSDO (MT)": cell("M98"),
            "IGG LSDO (MT)": cell("N98"),
            "IGG total FO (MT)": cell("Q98"),
            "IGG total DO (MT)": cell("R98"),
            "Stoppage HFO (MT)": cell("K99"),
            "Stoppage LFO (MT)": cell("L99"),
            "Stoppage HSDO (MT)": cell("M99"),
            "Stoppage LSDO (MT)": cell("N99"),
            "Stoppage total FO (MT)": cell("Q99"),
            "Stoppage total DO (MT)": cell("R99"),
            "Total FO Consumption ROB (MT)": cell("Q100"),
            "Total DO Consumption ROB (MT)": cell("R100"),
            "Noon Report Source": source.name,
        }
        return VoyageDataset(str(record["Vessel"] or worksheet.title), (record,), source)
    finally:
        workbook.close()


def _parse_voyage_extract(worksheet, source: Path) -> VoyageDataset:
    headers = [cell.value for cell in worksheet[1]]
    column_by_name = {
        str(header).strip(): index
        for index, header in enumerate(headers)
        if header is not None
    }
    source_to_canonical = {
        "Voyage/Leg Number": "Voyage/Leg Number",
        "Log Date Local": "Log Date Local",
        "Log Duration": "Log Duration (hrs)",
        "Port Of Call": "Port Of Call",
        "Loading Condition": "Loading Condition",
        "Master Name": "Master Name",
        "Chief Engineer Name": "Chief Engineer Name",
        "Distance Over Ground (nm)": "Distance Over Ground (nm)",
        "Next Port": "Next Port",
        "Cargo Onboard": "Cargo Onboard",
        "Air Temperature": "Air Temperature (deg C)",
        "Draft Aft": "Draft Aft",
        "Draft Fwd": "Draft Fwd",
        "ME HFO Consumption (MT)": "HFO Consumption ME (MT)",
        "ME MDO Consumption (MT)": "MDO Consumption ME (MT)",
        "AE HFO Consumption (MT)": "HFO Consumption Generators (MT)",
        "AE MDO Consumption (MT)": "MDO Consumption Generators (MT)",
        "BOLR HFO Consumption (MT)": "Boiler HFO (MT)",
        "BOLR MDO Consumption (MT)": "Boiler MDO (MT)",
        "MECYL Consumption (ltrs)": "Cylinder Oil Consumption",
        "MELO Consumption (ltrs)": "ME Oil Consumption",
        "AELO Consumption (ltrs)": "DG Oil Consumption",
        "Hydraulic Oil Consumption (ltrs)": "Hydraulic Oil Consumption (ltrs)",
        "Fresh Water Production (MT)": "Fresh Water Production (MT)",
        "Fresh Water Consumption (MT)": "Fresh Water Consumption (MT)",
        "Fresh Water ROB (MT)": "Fresh Water ROB (MT)",
        "ME 1 Running Hrs": "M/E Running Hours",
        "ME 1 Average Power (kW)": "M/E Average Power (kW)",
        "ME 1 Energy Produced (kWh)": "M/E Energy (kWh)",
        "ME1 RPM": "M/E RPM",
        "ME1 MCR (%)": "M/E Average Load (%)",
        "AE1 Running Hrs": "AE1 Running Hours",
        "AE1 Average Power (kW)": "AE1 Average Power (kW)",
        "AE1 Energy Produced (kWh)": "AE1 Energy (kWh)",
        "AE1 MCR (%)": "AE1 MCR (%)",
        "AE2 Running Hrs": "AE2 Running Hours",
        "AE2 Average Power (kW)": "AE2 Average Power (kW)",
        "AE2 Energy Produced (kWh)": "AE2 Energy (kWh)",
        "AE2 MCR (%)": "AE2 MCR (%)",
        "AE3 Running Hrs": "AE3 Running Hours",
        "AE3 Average Power (kW)": "AE3 Average Power (kW)",
        "AE3 Energy Produced (kWh)": "AE3 Energy (kWh)",
        "AE3 MCR (%)": "AE3 MCR (%)",
        "AUX BLR1 Running Hrs": "Aux Boiler Running Hrs",
        "AUX BLR1 Steam Pressure (bar)": "Aux Boiler Steam Pressure (bar)",
        "HFO ROB (MT)": "HFO ROB (MT)",
        "LFO ROB (MT)": "LFO ROB (MT)",
        "MDO ROB (MT)": "MDO ROB (MT)",
        "MECYL ROB (ltrs)": "Cylinder Oil ROB",
        "MELO ROB (ltrs)": "ME Oil ROB",
        "AELO ROB (ltrs)": "DG Oil ROB",
        "Hydraulic Oil ROB (ltrs)": "Hydraulic Oil ROB (ltrs)",
        "Speed Overground (knots)": "Average Speed over ground (knots)",
        "Sea State (DSS)": "Sea State (DSS)",
        "Apparent Slip (%)": "Apparent Slip (%)",
        "Real Slip (%)": "Real Slip (%)",
        "ME Cylinder Oil Consumption (ltr)": "ME Cylinder Oil Consumption (ltr)",
        "ME Consumption (MT)": "M/E Total Consumption (MT)",
        "ME ISO SFOC (g/kWh)": "M/E SFOC (g/kWh)",
        "ME SCOC (g/kWh)": "M/E SCOC (g/kWh)",
        "AE Consumption (MT)": "AE Total Consumption (MT)",
        "AE ISO SFOC (g/kWh)": "AE SFOC (g/kWh)",
        "ME Thermal Efficiency (%)": "M/E Thermal Efficiency (%)",
        "CO2 Emission (MT)": "CO2 Emission (MT)",
        "SOx Emission (MT)": "SOx Emission (MT)",
        "NOx Emission (MT)": "NOx Emission (MT)",
    }
    records: list[dict[str, object]] = []
    for row in worksheet.iter_rows(min_row=2, values_only=True):
        source_date = row[column_by_name["Log Date Local"]]
        if not isinstance(source_date, datetime):
            continue
        record: dict[str, object] = {
            "Vessel": worksheet.title.removesuffix(" EXTRACT").strip(),
            "Noon Report Source": source.name,
        }
        for source_name, canonical_name in source_to_canonical.items():
            column_index = column_by_name.get(source_name)
            if column_index is not None:
                record[canonical_name] = row[column_index]
        for key in ("Log Duration (hrs)", "M/E Average Load (%)",
                    "AE1 MCR (%)", "AE2 MCR (%)", "AE3 MCR (%)"):
            value = record.get(key)
            number = _number(value)
            if number is not None:
                record[key] = number / 100 if "MCR" in key or key == "M/E Average Load (%)" else number
        record["ETA"] = None
        record["Total Distance on Passage (nm)"] = None
        record["Distance to go (nm)"] = None
        records.append(record)
    if not records:
        raise ValueError(f"No dated voyage records were found in: {source}")
    records.sort(key=lambda record: record["Log Date Local"])
    vessel = str(records[-1].get("Vessel") or worksheet.title)
    return VoyageDataset(vessel, tuple(records), source, "VoyageDataExtract")


def _number(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _format_number(value: object, decimals: int = 2, suffix: str = "") -> str:
    number = _number(value)
    if number is None:
        return "—"
    return f"{number:,.{decimals}f}{suffix}"


def _format_percent(value: object) -> str:
    number = _number(value)
    if number is None:
        return "—"
    if abs(number) <= 1:
        number *= 100
    return f"{number:.2f}"


def _sum_fields(record: dict[str, object], fields: tuple[str, ...]) -> float | None:
    values = [_number(record.get(field)) for field in fields]
    numbers = [value for value in values if value is not None]
    return sum(numbers) if numbers else None


def _reported_burn(record: dict[str, object]) -> float | None:
    component_fields = (
        "HFO Consumption ME (MT)",
        "LFO Consumption ME (MT)",
        "HSDO Consumption ME (MT)",
        "LSDO Consumption ME (MT)",
        "HFO Consumption Generators (MT)",
        "LFO Consumption Generators (MT)",
        "HSDO Consumption Generators (MT)",
        "LSDO Consumption Generators (MT)",
        "Cargo heating HFO (MT)",
        "Cargo heating LFO (MT)",
        "Cargo heating HSDO (MT)",
        "Cargo heating LSDO (MT)",
        "Boiler HFO (MT)",
        "Boiler LFO (MT)",
        "Boiler HSDO (MT)",
        "Boiler LSDO (MT)",
        "Incinerator HFO (MT)",
        "Incinerator LFO (MT)",
        "Incinerator HSDO (MT)",
        "Incinerator LSDO (MT)",
        "IGG HFO (MT)",
        "IGG LFO (MT)",
        "IGG HSDO (MT)",
        "IGG LSDO (MT)",
        "Stoppage HFO (MT)",
        "Stoppage LFO (MT)",
        "Stoppage HSDO (MT)",
        "Stoppage LSDO (MT)",
    )
    reported = [_number(record.get(field)) for field in component_fields]
    values = [value for value in reported if value is not None]
    return sum(values) if values else None


def _component_total(
    record: dict[str, object], component_fields: tuple[str, ...], reported_field: str
) -> tuple[float | None, bool]:
    components = [_number(record.get(field)) for field in component_fields]
    component_values = [value for value in components if value is not None]
    reported_total = _number(record.get(reported_field))
    if not component_values:
        return reported_total, False
    component_total = sum(component_values)
    if reported_total is None or abs(component_total - reported_total) > 0.01:
        return component_total, True
    return reported_total, False


class VoyageSummaryApp(ctk.CTk):
    def __init__(self, dataset: VoyageDataset):
        super().__init__()
        self.dataset = dataset
        self._resize_pending = False
        self._responsive_state: tuple[bool, int, bool, int] | None = None
        self.bind("<Configure>", self._on_resize)
        self._render_workspace()

    def _render_workspace(self) -> None:
        latest = self.dataset.latest
        self.title(f"{self.dataset.vessel} — Voyage Summary")
        scale = ctk.ScalingTracker.get_widget_scaling(self)
        screen_width = round(self.winfo_screenwidth() / scale)
        screen_height = round(self.winfo_screenheight() / scale)
        initial_width = max(620, min(1520, round(screen_width * 0.96)))
        initial_height = max(440, min(920, round(screen_height * 0.90)))
        position_x = max(0, (screen_width - initial_width) // 2)
        position_y = max(0, (screen_height - initial_height) // 2)
        self.geometry(
            f"{initial_width}x{initial_height}+{position_x}+{position_y}"
        )
        self.minsize(min(620, initial_width), min(440, initial_height))
        self.configure(fg_color=BG)
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(1, weight=1)

        self.sidebar = ctk.CTkFrame(self, width=190, fg_color=NAVY, corner_radius=0)
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.sidebar.grid_propagate(False)
        self.sidebar.grid_columnconfigure(0, weight=1)
        self._build_sidebar()

        self.main = ctk.CTkFrame(self, fg_color=BG, corner_radius=0)
        self.main.grid(row=0, column=1, sticky="nsew", padx=(14, 18), pady=(12, 16))
        self.main.grid_columnconfigure(0, weight=1)
        self.main.grid_rowconfigure(1, weight=1)

        self._create_pages()
        self._build_topbar(latest)
        self._build_voyage_strip(latest)
        self._build_metrics(latest)
        self._build_panels(latest)
        self._build_footer(latest)
        self._build_overview_note()
        self._show_page("overview")
        self.after_idle(self._apply_responsive_layout)

    def _open_workbook(self) -> None:
        selected = filedialog.askopenfilename(
            parent=self,
            title="Open voyage workbook",
            initialdir=str(self.dataset.source_path.parent),
            filetypes=(("Excel workbooks", "*.xlsx"), ("All files", "*.*")),
        )
        if not selected:
            return
        try:
            dataset = load_voyage_data(Path(selected))
        except (OSError, ValueError) as error:
            messagebox.showerror("Voyage Summary — Workbook", str(error), parent=self)
            return
        for widget in self.winfo_children():
            widget.destroy()
        self.dataset = dataset
        self._responsive_state = None
        self._render_workspace()

    def _build_sidebar(self) -> None:
        logo = ctk.CTkFrame(self.sidebar, fg_color=BG, corner_radius=10)
        logo.grid(row=0, column=0, sticky="ew", padx=14, pady=(16, 10))
        self._label(logo, self.dataset.vessel, 15, WHITE, True, wraplength=165).pack(
            anchor="w", padx=12, pady=12
        )

        self.nav_sections = (
            ("◉", "Executive Overview", "overview"),
            ("◇", "Passage & Schedule", "passage"),
            ("⌁", "Main Engine", "propulsion"),
            ("ϟ", "Auxiliary Power", "auxiliary"),
            ("▤", "Bunkers & Consumption", "bunkers"),
            ("≋", "Cargo & Conditions", "cargo"),
            ("▣", "Remarks & Provenance", "remarks"),
        )
        self.nav_buttons = []
        for row_idx, (icon, title, section) in enumerate(self.nav_sections, start=1):
            button = ctk.CTkButton(
                self.sidebar,
                text=f"{icon}   {title}",
                anchor="w",
                command=lambda target=section: self._show_page(target),
                fg_color="#1b2942" if row_idx == 1 else "transparent",
                hover_color="#1b2942",
                text_color=WHITE if row_idx == 1 else MUTED,
                font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold" if row_idx == 1 else "normal"),
                height=34,
                corner_radius=5,
                border_spacing=10,
            )
            button.grid(row=row_idx, column=0, sticky="ew", padx=8, pady=2)
            self.nav_buttons.append(button)

        brief = ctk.CTkFrame(
            self.sidebar,
            fg_color="#0e1f31",
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        brief.grid(
            row=len(self.nav_sections) + 1,
            column=0,
            sticky="ew",
            padx=10,
            pady=(8, 0),
        )
        report_date = self.dataset.latest["Log Date Local"]
        self._label(brief, "LATEST REPORT", 9, MUTED, True).pack(
            anchor="w", padx=12, pady=(10, 0)
        )
        self._label(brief, report_date.strftime("%d %b %Y"), 11, TEAL, True).pack(
            anchor="w", padx=12, pady=(0, 10)
        )

    def _create_pages(self) -> None:
        page_details = (
            ("overview", "Voyage overview", "Management snapshot · reported facts from the selected source"),
            ("passage", "Passage & schedule", "Voyage progress and reporting history · no inferred route"),
            ("propulsion", "Main engine", "Propulsion performance and available engine telemetry"),
            ("auxiliary", "Auxiliary power", "Generator operation, energy and auxiliary machinery"),
            ("bunkers", "Bunkers & consumption", "Reported fuel consumption and remaining onboard"),
            ("cargo", "Cargo & conditions", "Cargo, drafts, fresh water and reported environmental conditions"),
            ("remarks", "Remarks & provenance", "Source workbook, reporting context and master’s remarks"),
        )
        self.pages: dict[str, ctk.CTkScrollableFrame] = {}
        self.page_nav_buttons: dict[str, ctk.CTkButton] = {}
        for key, title, subtitle in page_details:
            page = ctk.CTkScrollableFrame(
                self.main,
                fg_color=BG,
                corner_radius=0,
                scrollbar_button_color="#34445d",
                scrollbar_button_hover_color="#526784",
            )
            page.grid(row=1, column=0, sticky="nsew")
            page.grid_columnconfigure(0, weight=1)
            self.pages[key] = page
            heading = ctk.CTkFrame(page, fg_color="transparent")
            heading.grid(row=0, column=0, sticky="ew", pady=(1, 13))
            heading.grid_columnconfigure(0, weight=1)
            self._label(heading, title, 23, WHITE, True).grid(
                row=0, column=0, sticky="w"
            )
            self._label(heading, subtitle, 11, MUTED).grid(
                row=1, column=0, sticky="w", pady=(3, 0)
            )

    def _show_page(self, page_key: str) -> None:
        page = self.pages.get(page_key)
        if page is None:
            raise ValueError(f"Unknown Voyage Summary page: {page_key}")
        page.tkraise()
        self.active_page = page_key
        for (_, _, key), button in zip(self.nav_sections, self.nav_buttons):
            selected = key == page_key
            button.configure(
                fg_color="#1b3550" if selected else "transparent",
                text_color=WHITE if selected else MUTED,
                font=ctk.CTkFont(
                    family="Segoe UI", size=11, weight="bold" if selected else "normal"
                ),
            )

    def _build_topbar(self, latest: dict[str, object]) -> None:
        self.topbar = ctk.CTkFrame(self.main, fg_color=BG)
        self.topbar.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        self.topbar.grid_columnconfigure(0, weight=1)
        self.brand = ctk.CTkFrame(self.topbar, fg_color=BG)
        self.brand.grid(row=0, column=0, sticky="w")
        self._label(self.brand, self.dataset.vessel, 21, WHITE, True).pack(
            side="left", padx=(0, 10)
        )
        self._label(self.brand, "VOYAGE SUMMARY", 10, MUTED, True).pack(side="left")

        self.meta = ctk.CTkFrame(self.topbar, fg_color=BG)
        self.meta.grid(row=0, column=1, sticky="e")
        eta = latest.get("ETA")
        self.meta_cards = [
            self._info_chip(
                self.meta,
                "SOURCE FORMAT",
                "NOON AT SEA" if self.dataset.source_format == "Noon at Sea" else "VOYAGE DATA EXTRACT",
                latest["Log Date Local"].strftime("%d %b %Y %H:%M"),
            ),
            self._info_chip(
                self.meta,
                f"VOYAGE {latest.get('Voyage/Leg Number') or '—'}",
                str(latest.get("Next Port") or "Next port not reported"),
                f"ETA: {eta.strftime('%d %b %Y %H:%M') if isinstance(eta, datetime) else 'Not reported'}",
            ),
        ]

    def _build_voyage_strip(self, latest: dict[str, object]) -> None:
        strip = ctk.CTkFrame(self.pages["overview"], fg_color="#0d2940", corner_radius=10)
        strip.grid(row=1, column=0, sticky="ew", pady=(0, 12))
        strip.grid_columnconfigure(0, weight=1)
        speed = _format_number(latest.get("Average Speed over ground (knots)"), 1)
        water_speed = _format_number(latest.get("Average Speed over water (knots)"), 2)
        course = latest.get("Sailing Course")
        status_parts = [
            f"VOYAGE {latest.get('Voyage/Leg Number') or '—'}",
            str(latest.get("Loading Condition") or "Condition not reported").upper(),
        ]
        if course is not None:
            status_parts.append(f"COURSE {course}°")
        if speed != "—":
            status_parts.append(f"SOG {speed} kn")
        if water_speed != "—":
            status_parts.append(f"SOW {water_speed} kn")
        status = "   ·   ".join(status_parts)
        self._label(
            strip, status, 10, TEAL, True, wraplength=1100, justify="left"
        ).grid(row=0, column=0, sticky="w", padx=14, pady=10)
        position = (
            f"POSITION  {latest.get('Latitude') or 'Not reported'} / "
            f"{latest.get('Longitude') or 'Not reported'}"
            f"     ·     FROM  {latest.get('Port Of Call') or 'Not reported'}"
            f"     ·     DESTINATION  {latest.get('Next Port') or 'Not reported'}"
        )
        self._label(
            strip, position, 9, MUTED, wraplength=1100, justify="left"
        ).grid(row=1, column=0, sticky="w", padx=14, pady=(0, 10))

    def _build_metrics(self, latest: dict[str, object]) -> None:
        self.status_row = ctk.CTkFrame(self.pages["overview"], fg_color=BG)
        self.status_row.grid(row=2, column=0, sticky="ew", pady=(0, 16))
        speed = _number(latest.get("Average Speed over ground (knots)"))
        min_speed = _number(latest.get("Charter Party Min Speed"))
        max_speed = _number(latest.get("Charter Party Max Speed"))
        speed_detail = (
            f"Charter {min_speed:g}–{max_speed:g} kn"
            if speed is not None and min_speed is not None and max_speed is not None
            else "Charter speed not fully reported"
        )
        load_fraction = _number(latest.get("M/E Average Load (%)"))
        engine_detail = (
            f"{_format_number(latest.get('M/E RPM'), 2)} rpm"
            + (
                f" · {_format_number(load_fraction * 100, 1)}% MCR"
                if load_fraction is not None
                else ""
            )
        )
        reported_burn = _reported_burn(latest)
        extract = self.dataset.source_format == "VoyageDataExtract"
        fuel_detail = (
            f"ME {_format_number(latest.get('M/E Total Consumption (MT)'))} · "
            f"AE {_format_number(latest.get('AE Total Consumption (MT)'))} MT"
            if extract
            else f"ME {_format_number(latest.get('HFO Consumption ME (MT)'))} · "
            f"DG {_format_number(latest.get('HFO Consumption Generators (MT)'))} MT"
        )
        fuel_rob = latest.get("Total FO ROB (MT)")
        rob_label = "HFO ROB" if extract else "FUEL OIL ROB"
        rob_value = latest.get("HFO ROB (MT)") if extract else fuel_rob
        distance_label = "DISTANCE RUN" if extract else "DISTANCE TO GO"
        distance_value = (
            latest.get("Distance Over Ground (nm)")
            if extract
            else latest.get("Distance to go (nm)")
        )
        self.metric_cards = [
            self._metric_card(
                "NOON SPEED",
                _format_number(speed, 1),
                "kn",
                f"Charter range {min_speed:g}–{max_speed:g} kn"
                if min_speed is not None and max_speed is not None
                else speed_detail,
                TEAL,
            ),
            self._metric_card(
                "M/E CONSUMPTION" if extract else "24H FUEL CONSUMPTION",
                _format_number(latest.get("M/E Total Consumption (MT)") if extract else reported_burn),
                "MT",
                fuel_detail,
                GREEN,
            ),
            self._metric_card(
                "MAIN ENGINE OUTPUT",
                _format_number(latest.get("M/E Average Power (kW)"), 0),
                "kW",
                engine_detail,
                YELLOW,
            ),
            self._metric_card(
                rob_label,
                _format_number(rob_value, 1),
                "MT",
                (
                    f"MDO ROB {_format_number(latest.get('MDO ROB (MT)'))} MT"
                    if extract
                    else f"HFO {_format_number(latest.get('HFO ROB (MT)'))} · "
                    f"LFO {_format_number(latest.get('LFO ROB (MT)'))} MT"
                ),
                CYAN,
            ),
            self._metric_card(
                distance_label,
                _format_number(distance_value, 0),
                "nm",
                (
                    f"Reported over {len(self.dataset.records)} records"
                    if extract
                    else f"Completed {_format_number(latest.get('Total Distance on Passage (nm)'), 0)} nm"
                ),
                YELLOW,
            ),
        ]

    def _build_panels(self, latest: dict[str, object]) -> None:
        self.top_panels = self.pages["passage"]
        self.bottom_panels = self.pages["auxiliary"]
        self.chart_card = ctk.CTkFrame(
            self.top_panels, fg_color=PANEL, border_width=1, border_color=BORDER, corner_radius=8
        )
        self.chart_card.grid(row=1, column=0, sticky="nsew")
        self.chart_card.grid_columnconfigure(0, weight=1)
        chart_header = ctk.CTkFrame(self.chart_card, fg_color="transparent")
        chart_header.grid(row=0, column=0, sticky="ew", padx=16, pady=(16, 8))
        chart_header.grid_columnconfigure(0, weight=1)
        self._label(chart_header,         "PASSAGE PROGRESS" if self.dataset.source_format == "Noon at Sea" else "REPORTED DISTANCE HISTORY", 13, WHITE, True).grid(
            row=0, column=0, sticky="w"
        )
        self._label(
            chart_header,
            latest["Log Date Local"].strftime("%d %b %Y"),
            10,
            MUTED,
            True,
        ).grid(row=0, column=1, sticky="e")
        self.chart = tk.Canvas(
            self.chart_card,
            height=260,
            bg="#071c2d",
            highlightthickness=0,
            borderwidth=0,
        )
        self.chart.grid(row=1, column=0, sticky="nsew", padx=16, pady=(0, 16))
        self.chart.bind("<Configure>", self._draw_chart)

        self.engine_panel = ctk.CTkFrame(
            self.pages["propulsion"], fg_color=PANEL, border_width=1, border_color=BORDER, corner_radius=8
        )
        self.engine_panel.grid(row=1, column=0, sticky="ew")
        self.engine_panel.grid_columnconfigure(0, weight=1)
        self._label(self.engine_panel, "PROPULSION & MAIN ENGINE", 13, WHITE, True).grid(
            row=0, column=0, sticky="w", padx=12, pady=(10, 4)
        )
        load = _number(latest.get("M/E Average Load (%)"))
        engine_summary = (
            f"Engine room air {_format_number(latest.get('Engine Room Air Temp (deg C)'), 1, '°C')}   "
            f"M/E index {_format_number(latest.get('M/E Index (mm)'), 0, ' mm')}   "
            f"SFOC {_format_number(latest.get('M/E SFOC (g/kWh)'), 2, ' g/kWh')}   "
            f"SCOC {_format_number(latest.get('M/E SCOC (g/kWh)'), 2, ' g/kWh')}"
        )
        self._label(
            self.engine_panel,
            engine_summary,
            8,
            MUTED,
            True,
            wraplength=1100,
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=12, pady=(0, 8))
        self.engine_grid = ctk.CTkFrame(self.engine_panel, fg_color="transparent")
        self.engine_grid.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 10))
        engine_stats = (
            (
                "TURBOCHARGER MATRIX",
                f"T/C 1  {_format_number(latest.get('M/E Turbocharger 1 RPM'), 0)} rpm · "
                f"{_format_number(latest.get('M/E Turbocharger 1 Inlet Temp (deg C)'), 0)} / "
                f"{_format_number(latest.get('M/E Turbocharger 1 Outlet Temp (deg C)'), 0)}°C\n"
                f"T/C 2  {_format_number(latest.get('M/E Turbocharger 2 RPM'), 0)} rpm · "
                f"{_format_number(latest.get('M/E Turbocharger 2 Inlet Temp (deg C)'), 0)} / "
                f"{_format_number(latest.get('M/E Turbocharger 2 Outlet Temp (deg C)'), 0)}°C",
            ),
            (
                "THERMAL GRADIENTS",
                f"Cylinder exhaust  {_format_number(latest.get('Cylinder Exhaust Temp Min (deg C)'), 0)} / "
                f"{_format_number(latest.get('Cylinder Exhaust Temp Max (deg C)'), 0)}°C\n"
                f"Cooling water  {_format_number(latest.get('M/E Cooling Water In (deg C)'), 0)} / "
                f"{_format_number(latest.get('M/E Cooling Water Out (deg C)'), 0)}°C",
            ),
            (
                "SCAVENGE AIR",
                f"Air temperature  {_format_number(latest.get('M/E Scavenge Air Temp (deg C)'), 0)}°C\n"
                f"Air pressure  {_format_number(latest.get('M/E Scavenge Pressure (kg/cm2)'), 2)} kg/cm²\n"
                f"Pressure drop  {_format_number(latest.get('M/E Scavenge Pressure Drop (mm H2O)'), 0)} mm H₂O",
            ),
            (
                "M/E OPERATING",
                f"Running hours  {_format_number(latest.get('M/E Running Hours'), 1)} h\n"
                f"RPM / load  {_format_number(latest.get('M/E RPM'), 0)} / "
                f"{_format_number(load * 100 if load is not None else None, 1)}%\n"
                f"Average output  {_format_number(latest.get('M/E Average Power (kW)'), 0)} kW\n"
                f"Lube oil pressure  {_format_number(latest.get('Lube Oil Pressure (kg/cm2)'), 2)} kg/cm²",
            ),
        )
        self.engine_cards = [self._detail_card(self.engine_grid, *item) for item in engine_stats]

        self.auxiliary_panel = ctk.CTkFrame(
            self.bottom_panels, fg_color=PANEL, border_width=1, border_color=BORDER, corner_radius=8
        )
        self.auxiliary_panel.grid(row=1, column=0, sticky="ew")
        self.auxiliary_panel.grid_columnconfigure(0, weight=1)
        self._label(self.auxiliary_panel, "AUXILIARY ENGINE / POWER", 13, WHITE, True).grid(
            row=0, column=0, sticky="w", padx=12, pady=(10, 6)
        )
        self._label(
            self.auxiliary_panel,
            f"Total DG working hours: {_format_number(latest.get('Total DG Running Hours'), 1)} h"
            f"  ·  AE SFOC: {_format_number(latest.get('AE SFOC (g/kWh)'), 1)} g/kWh",
            10,
            TEAL,
            True,
            wraplength=700,
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=12, pady=(0, 6))
        self.auxiliary_grid = ctk.CTkFrame(self.auxiliary_panel, fg_color="transparent")
        self.auxiliary_grid.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 6))
        auxiliary_stats = (
            ("NO. 1 A/E", f"{_format_number(latest.get('AE1 Energy (kWh)'), 0)} kWh · {_format_number(latest.get('AE1 Running Hours'), 1)} h"),
            ("NO. 2 A/E", f"{_format_number(latest.get('AE2 Energy (kWh)'), 0)} kWh · {_format_number(latest.get('AE2 Running Hours'), 1)} h"),
            ("NO. 3 A/E", f"{_format_number(latest.get('AE3 Energy (kWh)'), 0)} kWh · {_format_number(latest.get('AE3 Running Hours'), 1)} h"),
            ("NO. 4 A/E", f"{_format_number(latest.get('AE4 Energy (kWh)'), 0)} kWh · {_format_number(latest.get('AE4 Running Hours'), 1)} h"),
            ("TURBO ALTERNATOR", f"{_format_number(latest.get('Turbo Alternator Energy (kWh)'), 0)} kWh · {_format_number(latest.get('Turbo Alternator Hours'), 1)} h"),
        )
        self.auxiliary_cards = []
        for row, (title, value) in enumerate(auxiliary_stats):
            card = ctk.CTkFrame(
                self.auxiliary_grid,
                fg_color="#1a263d",
                corner_radius=4,
            )
            card.grid(row=row, column=0, sticky="ew", pady=2)
            card.grid_columnconfigure(0, weight=1)
            self._label(card, title, 8, WHITE, True).grid(
                row=0, column=0, sticky="w", padx=8, pady=5
            )
            self._label(card, value, 8, TEAL, True).grid(
                row=0, column=1, sticky="e", padx=8, pady=5
            )
            self.auxiliary_cards.append(card)
        oil_details = (
            f"Cylinder oil: {latest.get('Cylinder Oil Type') or 'Not reported'} · "
            f"ROB {latest.get('Cylinder Oil ROB') or 'Not reported'} L · "
            f"cons {latest.get('Cylinder Oil Consumption') or 'Not reported'} L"
            f"     M/E oil: {latest.get('ME Oil Type') or 'Not reported'} · "
            f"ROB {_format_number(latest.get('ME Oil ROB'))} L"
            f"     D/G oil: {latest.get('DG Oil Type') or 'Not reported'} · "
            f"cons {latest.get('DG Oil Consumption') or 'Not reported'} L · "
            f"ROB {_format_number(latest.get('DG Oil ROB'))} L"
        )
        self._label(
            self.auxiliary_panel,
            oil_details,
            8,
            MUTED,
            wraplength=900,
            justify="left",
        ).grid(row=3, column=0, sticky="w", padx=12, pady=(0, 10))

        self.cargo_panel = ctk.CTkFrame(
            self.pages["cargo"], fg_color=PANEL, border_width=1, border_color=BORDER, corner_radius=8
        )
        self.cargo_panel.grid(row=1, column=0, sticky="ew")
        self.cargo_panel.grid_columnconfigure(0, weight=1)
        cargo_heading = ctk.CTkFrame(self.cargo_panel, fg_color="transparent")
        cargo_heading.grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 8))
        cargo_heading.grid_columnconfigure(0, weight=1)
        self._label(cargo_heading, "CARGO, DRAFT & ENVIRONMENT", 13, WHITE, True).grid(
            row=0, column=0, sticky="w"
        )
        self._label(
            cargo_heading,
            str(latest.get("Loading Condition") or "CONDITION NOT REPORTED").upper(),
            8,
            GREEN,
            True,
        ).grid(row=0, column=1, sticky="e")
        cargo = _format_number(latest.get("Cargo Onboard"), 2, " MT")
        self._label(
            self.cargo_panel,
            f"{latest.get('Cargo Name') or 'Cargo not reported'}   {cargo}",
            11,
            GREEN,
            True,
            wraplength=280,
        ).grid(row=1, column=0, sticky="w", padx=12, pady=(0, 6))
        self.cargo_grid = ctk.CTkFrame(self.cargo_panel, fg_color="transparent")
        self.cargo_grid.grid(row=2, column=0, sticky="ew", padx=10, pady=(0, 4))
        aft = _number(latest.get("Draft Aft"))
        fwd = _number(latest.get("Draft Fwd"))
        trim = aft - fwd if aft is not None and fwd is not None else None
        cargo_stats = (
            (
                "FWD / AFT DRAFT",
                f"{_format_number(latest.get('Draft Fwd'), 2)} / "
                f"{_format_number(latest.get('Draft Aft'), 2)} m",
            ),
            (
                "TRIM (AFT − FWD)",
                f"{_format_number(trim, 2, ' m')}"
                + (" · EVEN KEEL" if trim is not None and abs(trim) < 0.01 else ""),
            ),
            (
                "WIND",
                f"BF {_format_number(latest.get('Wind Force (Beaufort)'), 0)} · "
                f"{_format_number(latest.get('Wind Direction'), 0, '°')}",
            ),
            (
                "SEA SWELL",
                f"{_format_number(latest.get('Swell Height (m)'), 1, ' m')} · "
                f"{_format_number(latest.get('Swell Direction'), 0, '°')}",
            ),
            (
                "SURFACE CURRENT",
                f"{_format_number(latest.get('Sea Current Speed (knots)'), 1, ' kn')} · "
                f"{_format_number(latest.get('Sea Current Direction'), 0, '°')}",
            ),
            (
                "FRESH WATER",
                f"ROB {_format_number(latest.get('Fresh Water ROB (MT)'), 0)} · "
                f"+{_format_number(latest.get('Fresh Water Production (MT)'), 0)} / "
                f"−{_format_number(latest.get('Fresh Water Consumption (MT)'), 0)} MT",
            ),
        )
        self.cargo_cards = [self._detail_card(self.cargo_grid, *item) for item in cargo_stats]
        self.tank_grid = ctk.CTkFrame(self.cargo_panel, fg_color="transparent")
        self.tank_grid.grid(row=3, column=0, sticky="ew", padx=12, pady=(2, 12))
        tank_rows = (
            ("SLUDGE TANK", "Sludge Quantity (MT)", "Sludge Tank Capacity (MT)", TEAL),
            ("BILGE TANK", "Bilge Quantity (MT)", "Bilge Tank Capacity (MT)", GREEN),
        )
        for row, (title, quantity_field, capacity_field, color) in enumerate(tank_rows):
            quantity = _number(latest.get(quantity_field))
            capacity = _number(latest.get(capacity_field))
            amount = (
                f"{_format_number(quantity, 1)} / {_format_number(capacity, 1)} MT"
                + (
                    f" ({quantity / capacity:.1%})"
                    if quantity is not None and capacity is not None and capacity > 0
                    else ""
                )
            )
            self._label(
                self.tank_grid,
                f"{title}     {amount}",
                8,
                MUTED,
                True,
                anchor="w",
            ).grid(row=row * 2, column=0, sticky="ew", pady=(5, 2))
            if quantity is not None and capacity is not None and capacity > 0:
                bar = ctk.CTkProgressBar(
                    self.tank_grid,
                    height=6,
                    progress_color=color,
                    fg_color="#0b1428",
                    corner_radius=3,
                )
                bar.grid(row=row * 2 + 1, column=0, sticky="ew", pady=(0, 2))
                bar.set(min(max(quantity / capacity, 0), 1))
        self.tank_grid.grid_columnconfigure(0, weight=1)

        self.fuel_panel = ctk.CTkFrame(
            self.pages["bunkers"], fg_color=PANEL, border_width=1, border_color=BORDER, corner_radius=8
        )
        self.fuel_panel.grid(row=1, column=0, sticky="ew")
        self.fuel_panel.grid_columnconfigure(0, weight=1)
        if self.dataset.source_format == "VoyageDataExtract":
            self._build_extract_fuel_panel(latest)
            return
        self._label(self.fuel_panel, "BUNKERS & FUEL OIL ACCOUNTING · 24H", 13, WHITE, True).grid(
            row=0, column=0, sticky="w", padx=12, pady=(10, 8)
        )
        self.fuel_table = ctk.CTkFrame(self.fuel_panel, fg_color="transparent")
        self.fuel_table.grid(row=1, column=0, sticky="ew", padx=8)
        headings = (
            "EQUIPMENT",
            "H.S.F.O.",
            "L.S.F.O.",
            "H.S.D.O. / L.S.D.O.",
            "TOTAL F.O.",
            "TOTAL D.O.",
        )
        for column, heading in enumerate(headings):
            self._label(
                self.fuel_table, heading, 7, MUTED, True, anchor="w", wraplength=95
            ).grid(row=0, column=column, sticky="ew", padx=4, pady=(0, 8))

        sulfur_cells = (
            "SULFUR SPEC (%)",
            f"{_format_percent(latest.get('HSFO Sulfur (%)'))}%",
            f"{_format_percent(latest.get('LSFO Sulfur (%)'))}%",
            f"— / {_format_percent(latest.get('LSDO Sulfur (%)'))}%",
            None,
            None,
        )
        self._add_fuel_row(1, sulfur_cells, muted=True)

        hfo_fields = (
            "HFO Consumption ME (MT)",
            "HFO Consumption Generators (MT)",
            "Cargo heating HFO (MT)",
            "Boiler HFO (MT)",
            "Incinerator HFO (MT)",
            "IGG HFO (MT)",
            "Stoppage HFO (MT)",
        )
        lfo_fields = (
            "LFO Consumption ME (MT)",
            "LFO Consumption Generators (MT)",
            "Cargo heating LFO (MT)",
            "Boiler LFO (MT)",
            "Incinerator LFO (MT)",
            "IGG LFO (MT)",
            "Stoppage LFO (MT)",
        )
        hsdo_fields = (
            "HSDO Consumption ME (MT)",
            "HSDO Consumption Generators (MT)",
            "Cargo heating HSDO (MT)",
            "Boiler HSDO (MT)",
            "Incinerator HSDO (MT)",
            "IGG HSDO (MT)",
            "Stoppage HSDO (MT)",
        )
        lsdo_fields = (
            "LSDO Consumption ME (MT)",
            "LSDO Consumption Generators (MT)",
            "Cargo heating LSDO (MT)",
            "Boiler LSDO (MT)",
            "Incinerator LSDO (MT)",
            "IGG LSDO (MT)",
            "Stoppage LSDO (MT)",
        )
        fuel_rows = (
            (
                "Main engine",
                "HFO Consumption ME (MT)",
                "LFO Consumption ME (MT)",
                "HSDO Consumption ME (MT)",
                "LSDO Consumption ME (MT)",
                "*Total FO Consumption ME (MT)",
                "Total DO Consumption ME (MT)",
            ),
            (
                "Generators",
                "HFO Consumption Generators (MT)",
                "LFO Consumption Generators (MT)",
                "HSDO Consumption Generators (MT)",
                "LSDO Consumption Generators (MT)",
                "*Total FO Consumption Generators (MT)",
                "Total DO Consumption Generators (MT)",
            ),
            ("Other consumers", "", "", "", "", "", ""),
            ("TOTAL 24H BURN", "", "", "", "", "", ""),
            ("Bunkers ROB", "HFO ROB (MT)", "LFO ROB (MT)", "HSDO ROB (MT)", "LSDO ROB (MT)", "Total FO ROB (MT)", "Total DO ROB (MT)"),
        )
        for row_index, values in enumerate(fuel_rows, start=2):
            other_row = values[0] == "Other consumers"
            total_burn_row = values[0] == "TOTAL 24H BURN"
            if other_row or total_burn_row:
                hfo_total = _sum_fields(latest, hfo_fields if total_burn_row else hfo_fields[2:])
                lfo_total = _sum_fields(latest, lfo_fields if total_burn_row else lfo_fields[2:])
                hsdo_total = _sum_fields(latest, hsdo_fields if total_burn_row else hsdo_fields[2:])
                lsdo_total = _sum_fields(latest, lsdo_fields if total_burn_row else lsdo_fields[2:])
                fo_total = (
                    (hfo_total or 0) + (lfo_total or 0)
                    if hfo_total is not None or lfo_total is not None
                    else None
                )
                do_total = (
                    (hsdo_total or 0) + (lsdo_total or 0)
                    if hsdo_total is not None or lsdo_total is not None
                    else None
                )
                cells = (
                    values[0],
                    hfo_total,
                    lfo_total,
                    f"{_format_number(hsdo_total)} / {_format_number(lsdo_total)}",
                    fo_total,
                    do_total,
                )
            else:
                cells = (
                    values[0],
                    values[1],
                    values[2],
                    f"{_format_number(latest.get(values[3]), 2)} / "
                    f"{_format_number(latest.get(values[4]), 2)}",
                    values[5],
                    values[6],
                )
            self._add_fuel_row(
                row_index,
                cells,
                calculated_total=total_burn_row or other_row,
                highlighted=total_burn_row,
            )
        for column, (weight, minimum) in enumerate(
            zip((2, 1, 1, 2, 2, 2), (85, 45, 45, 78, 65, 65))
        ):
            self.fuel_table.grid_columnconfigure(column, weight=weight, minsize=minimum)
        self._label(
            self.fuel_panel,
            "— means not reported. *Totals are calculated from available fuel-grade cells; the source's main "
            "engine and generator total F.O. cells show 0.00 despite H.S.F.O. entries of 51.30 and 4.70 MT. "
            "The 24h burn combines F.O. and D.O.; verify the source discrepancy.",
            8,
            MUTED,
            wraplength=700,
            justify="left",
        ).grid(row=2, column=0, sticky="w", padx=12, pady=(8, 10))

    def _build_extract_fuel_panel(self, latest: dict[str, object]) -> None:
        self._label(
            self.fuel_panel, "REPORTED BUNKER POSITION & CONSUMPTION", 14, WHITE, True
        ).grid(row=0, column=0, sticky="w", padx=16, pady=(15, 5))
        rob = ctk.CTkFrame(self.fuel_panel, fg_color="transparent")
        rob.grid(row=1, column=0, sticky="ew", padx=12, pady=(5, 12))
        for column, (grade, field) in enumerate((
            ("HFO ROB", "HFO ROB (MT)"),
            ("LFO ROB", "LFO ROB (MT)"),
            ("MDO ROB", "MDO ROB (MT)"),
        )):
            self._detail_card(rob, grade, f"{_format_number(latest.get(field), 1)} MT").grid(
                row=0, column=column, sticky="ew", padx=4
            )
            rob.grid_columnconfigure(column, weight=1)

        self._label(self.fuel_panel, "CONSUMPTION REPORTED FOR THIS RECORD", 11, TEXT, True).grid(
            row=2, column=0, sticky="w", padx=16, pady=(5, 5)
        )
        table = ctk.CTkFrame(self.fuel_panel, fg_color="transparent")
        table.grid(row=3, column=0, sticky="ew", padx=12)
        rows = (
            ("Main engine", "M/E Total Consumption (MT)", "HFO Consumption ME (MT)", "MDO Consumption ME (MT)"),
            ("Auxiliary engines", "AE Total Consumption (MT)", "HFO Consumption Generators (MT)", "MDO Consumption Generators (MT)"),
            ("Auxiliary boiler", None, "Boiler HFO (MT)", "Boiler MDO (MT)"),
        )
        headings = ("CONSUMER", "REPORTED TOTAL", "HFO", "MDO")
        for column, title in enumerate(headings):
            self._label(table, title, 9, MUTED, True, anchor="w").grid(
                row=0, column=column, sticky="ew", padx=8, pady=(3, 8)
            )
        for row_index, (consumer, total_field, hfo_field, mdo_field) in enumerate(rows, start=1):
            values = (
                consumer,
                _format_number(latest.get(total_field), 2) if total_field else "—",
                _format_number(latest.get(hfo_field), 2),
                _format_number(latest.get(mdo_field), 2),
            )
            for column, value in enumerate(values):
                self._label(
                    table, value, 11 if column == 0 else 10,
                    WHITE if column == 0 else TEXT,
                    column == 0, anchor="w",
                ).grid(row=row_index, column=column, sticky="ew", padx=8, pady=7)
        for column, weight in enumerate((3, 2, 1, 1)):
            table.grid_columnconfigure(column, weight=weight)
        self._label(
            self.fuel_panel,
            "The extract reports consumer totals and fuel-grade entries separately. They are shown as supplied; "
            "a combined total burn or consumption-to-ROB balance is not inferred.",
            10,
            MUTED,
            wraplength=900,
            justify="left",
        ).grid(row=4, column=0, sticky="w", padx=16, pady=(12, 16))

    def _add_fuel_row(
        self,
        row: int,
        cells: tuple[object, ...],
        *,
        muted: bool = False,
        highlighted: bool = False,
        calculated_total: bool = False,
    ) -> None:
        latest = self.dataset.latest
        for column, field in enumerate(cells):
            calculated = calculated_total and column == 4
            if column in (0, 3) or (
                isinstance(field, str) and field.endswith("%")
            ):
                value = field
            elif column == 4 and isinstance(field, str) and field.startswith(
                "*Total FO Consumption ME"
            ):
                value, calculated = _component_total(
                    latest,
                    (
                        "HFO Consumption ME (MT)",
                        "LFO Consumption ME (MT)",
                    ),
                    "Total FO Consumption ME (MT)",
                )
            elif column == 4 and isinstance(field, str) and field.startswith(
                "*Total FO Consumption Generators"
            ):
                value, calculated = _component_total(
                    latest,
                    (
                        "HFO Consumption Generators (MT)",
                        "LFO Consumption Generators (MT)",
                    ),
                    "Total FO Consumption Generators (MT)",
                )
            elif isinstance(field, (int, float)) or field is None:
                value = field
            else:
                value = latest.get(field)
            text = (
                str(value)
                if column in (0, 3) or (isinstance(value, str) and value.endswith("%"))
                else _format_number(value, 2)
            )
            if calculated and value is not None:
                text += "*"
            color = MUTED if muted else TEAL if highlighted else TEXT if column == 0 else WHITE
            self._label(
                self.fuel_table,
                text,
                8 if column == 0 or highlighted else 7,
                color,
                column == 0 or highlighted,
                anchor="w",
                wraplength=130 if column == 0 else 100,
            ).grid(row=row, column=column, sticky="ew", padx=3, pady=3)

    def _build_footer(self, latest: dict[str, object]) -> None:
        self.footer = ctk.CTkFrame(
            self.main, fg_color="#121d33", corner_radius=8, border_width=1, border_color=BORDER
        )
        self.footer.grid(row=4, column=0, sticky="ew", pady=(16, 0))
        self.footer.grid_columnconfigure(0, weight=1)
        eta = latest.get("ETA")
        self._label(
            self.footer,
            "NOON REPORT REMARKS",
            13,
            TEXT,
            True,
        ).grid(row=0, column=0, sticky="w", padx=12, pady=(10, 4))
        comment = latest.get("Ship's Clock Comment")
        self._label(
            self.footer,
            str(comment) if comment else "No remark recorded in the source report.",
            10,
            WHITE,
            wraplength=950,
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=12, pady=(0, 6))
        self._label(
            self.footer,
            f"{self.dataset.vessel}  ·  IMO {latest.get('IMO Number') or 'Not reported'}  ·  "
            f"{latest['Log Date Local'].strftime('%d %b %Y %H:%M')}  ·  "
            f"ETA {eta.strftime('%d %b %Y %H:%M') if isinstance(eta, datetime) else 'Not reported'}  ·  "
            f"Source {self.dataset.source_path.name}",
            8,
            MUTED,
            wraplength=950,
            justify="left",
        ).grid(row=2, column=0, sticky="w", padx=12, pady=(0, 10))

    def _build_overview_note(self) -> None:
        pass

    def _on_resize(self, event: tk.Event) -> None:
        if event.widget is not self or self._resize_pending:
            return
        self._resize_pending = True
        self.after_idle(self._apply_responsive_layout)

    def _scroll_to_section(self, section: str) -> None:
        targets = {
            "overview": self.status_row,
            "passage": self.chart_card,
            "propulsion": self.engine_panel,
            "auxiliary": self.auxiliary_panel,
            "bunker": self.fuel_panel,
            "cargo": self.cargo_panel,
            "remarks": self.footer,
        }
        target = targets.get(section)
        if target is None:
            return
        canvas = self.main._parent_canvas
        canvas.update_idletasks()
        bounds = canvas.bbox("all")
        if bounds is None:
            return
        content_height = max(bounds[3], 1)
        scroll_offset = canvas.yview()[0] * content_height
        target_y = max(
            target.winfo_rooty() - canvas.winfo_rooty() + scroll_offset,
            0,
        )
        canvas.yview_moveto(min(target_y / content_height, 1))

    def _apply_responsive_layout(self) -> None:
        self._resize_pending = False
        width = min(self._display_width(), self.winfo_screenwidth())
        show_sidebar = width >= 1120
        if show_sidebar:
            self.grid_columnconfigure(0, weight=0, minsize=190)
            self.grid_columnconfigure(1, weight=1, minsize=0)
            self.sidebar.grid(row=0, column=0, sticky="nsew")
            self.main.grid(row=0, column=1, sticky="nsew", padx=(14, 18), pady=(12, 16))
        else:
            self.sidebar.grid_remove()
            self.grid_columnconfigure(0, weight=1, minsize=0)
            self.grid_columnconfigure(1, weight=0, minsize=0)
            self.main.grid(row=0, column=0, sticky="nsew", padx=8, pady=8)
        self.update_idletasks()
        content_width = self._content_width()
        metric_columns = (
            5
            if content_width >= 800
            else 3
            if content_width >= 600
            else 2
            if content_width >= 420
            else 1
        )
        two_panel_columns = content_width >= 800
        topbar_columns = content_width >= 1500
        state = (show_sidebar, metric_columns, two_panel_columns, int(topbar_columns))
        if state == self._responsive_state:
            return
        self._responsive_state = state
        self._layout_metrics(metric_columns)
        self._layout_panels(two_panel_columns)
        self._layout_topbar(topbar_columns)

    def _layout_metrics(self, columns: int) -> None:
        for column in range(len(self.metric_cards)):
            self.status_row.grid_columnconfigure(column, weight=1 if column < columns else 0)
        for index, card in enumerate(self.metric_cards):
            card.grid(
                row=index // columns,
                column=index % columns,
                sticky="ew",
                padx=(0 if index % columns == 0 else 6, 0 if index % columns == columns - 1 else 6),
                pady=(0, 8 if index // columns < (len(self.metric_cards) - 1) // columns else 0),
            )

    def _layout_panels(self, two_columns: bool) -> None:
        for parent in (self.top_panels, self.bottom_panels):
            parent.grid_columnconfigure(0, weight=3 if two_columns else 1)
            parent.grid_columnconfigure(1, weight=2 if two_columns else 0)
        self.top_panels.grid_columnconfigure(1, minsize=0)
        self.bottom_panels.grid_columnconfigure(1, minsize=0)
        if two_columns:
            top_positions = ((self.chart_card, 0, 0), (self.cargo_panel, 0, 1))
            bottom_positions = ((self.auxiliary_panel, 0, 0), (self.fuel_panel, 0, 1))
        else:
            top_positions = ((self.chart_card, 0, 0), (self.cargo_panel, 1, 0))
            bottom_positions = ((self.auxiliary_panel, 0, 0), (self.fuel_panel, 1, 0))
        for panel, row, column in top_positions:
            panel.grid(
                row=row,
                column=column,
                sticky="nsew",
                padx=(0, 8) if two_columns and column == 0 else 0,
                pady=(0, 10) if not two_columns and row > 0 else 0,
            )
        for panel, row, column in bottom_positions:
            panel.grid(
                row=row,
                column=column,
                sticky="nsew",
                padx=(0, 8) if two_columns and column == 0 else 0,
                pady=(0, 10) if not two_columns and row > 0 else 0,
            )
        width = self._content_width()
        columns = 4 if width >= 800 else 2
        for column in range(4):
            self.engine_grid.grid_columnconfigure(column, weight=1 if column < columns else 0)
        for index, card in enumerate(self.engine_cards):
            card.grid(
                row=index // columns,
                column=index % columns,
                sticky="ew",
                padx=(0 if index % columns == 0 else 6, 0 if index % columns == columns - 1 else 6),
                pady=(0, 8 if index // columns == 0 else 0),
            )
        cargo_columns = 2 if width >= 850 else 1
        for column in range(2):
            self.cargo_grid.grid_columnconfigure(
                column, weight=1 if column < cargo_columns else 0
            )
        for index, card in enumerate(self.cargo_cards):
            card.grid(
                row=index // cargo_columns,
                column=index % cargo_columns,
                sticky="ew",
                padx=(0 if index % cargo_columns == 0 else 6, 0 if index % cargo_columns == cargo_columns - 1 else 6),
                pady=(0, 8),
            )
        auxiliary_columns = 1
        for column in range(5):
            self.auxiliary_grid.grid_columnconfigure(
                column, weight=1 if column < auxiliary_columns else 0
            )
        for index, card in enumerate(self.auxiliary_cards):
            card.grid(
                row=index // auxiliary_columns,
                column=index % auxiliary_columns,
                sticky="ew",
                padx=(0 if index % auxiliary_columns == 0 else 6, 0 if index % auxiliary_columns == auxiliary_columns - 1 else 6),
                pady=(0, 8),
            )

    def _layout_topbar(self, two_columns: bool) -> None:
        if two_columns:
            self.topbar.grid_columnconfigure(0, weight=1)
            self.topbar.grid_columnconfigure(1, weight=0)
            self.brand.grid(row=0, column=0, sticky="w")
            self.meta.grid(row=0, column=1, sticky="e")
            for index, card in enumerate(self.meta_cards):
                card.grid(row=0, column=index, sticky="e", padx=(12 if index else 0, 0))
        else:
            self.topbar.grid_columnconfigure(0, weight=1)
            self.topbar.grid_columnconfigure(1, weight=0)
            self.brand.grid(row=0, column=0, sticky="w")
            self.meta.grid(row=1, column=0, sticky="ew", pady=(10, 0))
            for index, card in enumerate(self.meta_cards):
                card.grid(row=0, column=index, sticky="ew", padx=(0 if index == 0 else 8, 0))

    def _display_width(self) -> int:
        return self.winfo_width()

    def _content_width(self) -> int:
        return max(self.main.winfo_width(), 1)

    def _draw_chart(self, _event: tk.Event | None = None) -> None:
        del _event
        canvas = self.chart
        canvas.delete("all")
        width = max(canvas.winfo_width(), 240)
        height = max(canvas.winfo_height(), 180)
        canvas.create_rectangle(0, 0, width, height, fill="#091d2f", outline="")

        latest = self.dataset.latest
        completed = _number(latest.get("Total Distance on Passage (nm)"))
        remaining = _number(latest.get("Distance to go (nm)"))
        if completed is None or remaining is None or completed < 0 or remaining < 0:
            canvas.create_text(
                width / 2,
                height / 2,
                text="Passage distance is not fully reported.",
                fill=MUTED,
                font=("Segoe UI", 10),
            )
            return

        total = completed + remaining
        progress = completed / total if total else 0
        left, right = 28, width - 28
        bar_top, bar_bottom = 92, 130
        canvas.create_text(
            left,
            34,
            text=f"Voyage {latest.get('Voyage/Leg Number') or '—'}  ·  "
            f"Next port: {latest.get('Next Port') or 'Not reported'}",
            fill="#d7eef9",
            anchor="w",
            font=("Segoe UI", 10, "bold"),
        )
        canvas.create_text(
            left,
            66,
            text=f"Completed  {completed:,.0f} nm",
            fill=TEAL,
            anchor="w",
            font=("Segoe UI", 9, "bold"),
        )
        canvas.create_text(
            right,
            66,
            text=f"To go  {remaining:,.0f} nm",
            fill="#7ca1b9",
            anchor="e",
            font=("Segoe UI", 9, "bold"),
        )
        canvas.create_rectangle(
            left, bar_top, right, bar_bottom, fill="#18384e", outline="#28506a"
        )
        if progress > 0:
            canvas.create_rectangle(
                left,
                bar_top,
                left + (right - left) * progress,
                bar_bottom,
                fill=TEAL,
                outline="",
            )
        canvas.create_text(
            left,
            160,
            text=f"{progress:.1%} of combined completed + remaining distance",
            fill=TEXT,
            anchor="w",
            font=("Segoe UI", 9),
        )
        eta = latest.get("ETA")
        if isinstance(eta, datetime):
            canvas.create_text(
                right,
                160,
                text=f"ETA  {eta.strftime('%d %b %Y %H:%M')}",
                fill=YELLOW,
                anchor="e",
                font=("Segoe UI", 9, "bold"),
            )

    @staticmethod
    def _label(
        parent,
        text: str,
        size: int,
        color: str,
        bold: bool = False,
        **kwargs: object,
    ) -> ctk.CTkLabel:
        return ctk.CTkLabel(
            parent,
            text=text,
            text_color=color,
            font=ctk.CTkFont(
                family="Segoe UI", size=size, weight="bold" if bold else "normal"
            ),
            **kwargs,
        )

    def _metric_card(
        self, title: str, value: str, unit: str, detail: str, accent: str
    ) -> ctk.CTkFrame:
        card = ctk.CTkFrame(
            self.status_row,
            fg_color="#121d33",
            border_width=1,
            border_color=BORDER,
            corner_radius=6,
        )
        card.grid_columnconfigure(0, weight=1)
        self._label(card, title, 9, MUTED, True, wraplength=240).grid(
            row=0, column=0, sticky="w", padx=12, pady=(10, 0)
        )
        value_row = ctk.CTkFrame(card, fg_color="transparent")
        value_row.grid(row=1, column=0, sticky="ew", padx=12, pady=(5, 0))
        self._label(value_row, value, 24, accent, True).pack(side="left")
        self._label(value_row, unit, 10, MUTED, True).pack(side="left", padx=(5, 0))
        self._label(card, detail, 9, MUTED, wraplength=240, justify="left").grid(
            row=2, column=0, sticky="w", padx=12, pady=(1, 10)
        )
        return card

    def _detail_card(self, parent: ctk.CTkFrame, title: str, value: str) -> ctk.CTkFrame:
        card = ctk.CTkFrame(
            parent, fg_color="#1a263d", corner_radius=5, border_width=1, border_color=BORDER
        )
        card.grid_columnconfigure(0, weight=1)
        self._label(card, title, 9, MUTED, True, wraplength=220).grid(
            row=0, column=0, sticky="w", padx=9, pady=(7, 3)
        )
        self._label(card, value, 11, WHITE, True, wraplength=220, justify="left").grid(
            row=1, column=0, sticky="w", padx=9, pady=(0, 7)
        )
        return card

    def _info_chip(self, parent: ctk.CTkFrame, title: str, value: str, detail: str) -> ctk.CTkFrame:
        chip = ctk.CTkFrame(parent, fg_color="transparent")
        self._label(chip, title, 9, MUTED, True).grid(row=0, column=0, sticky="w")
        self._label(chip, value, 12, WHITE, True, wraplength=190).grid(
            row=1, column=0, sticky="w"
        )
        self._label(chip, detail, 9, MUTED, wraplength=220, justify="left").grid(
            row=2, column=0, sticky="w"
        )
        return chip


def main() -> None:
    ctk.set_appearance_mode("dark")
    ctk.set_default_color_theme("blue")
    try:
        dataset = load_voyage_data()
    except (FileNotFoundError, PermissionError, ValueError) as exc:
        dialog = tk.Tk()
        dialog.withdraw()
        messagebox.showerror("Voyage Summary — Noon Report", str(exc), parent=dialog)
        dialog.destroy()
        return
    app = VoyageSummaryApp(dataset)
    app.mainloop()


if __name__ == "__main__":
    from suite_services.access.guard import require_module
    require_module("voyage")
    main()
