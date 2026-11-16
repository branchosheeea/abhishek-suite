"""Evidence-led desktop review, using the Suite's CustomTkinter design language."""

from __future__ import annotations
import json
import math
import os
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from datetime import datetime
import customtkinter as ctk
from suite_services.theme import BG, WHITE, INK, MUTED, BORDER, AMBER, RED
from vessel_report.core import DEFAULT_OUTPUT, parse_range, preset_range
from vessel_report.pickers import DatePicker
from .outlook import SUBJECT_PHRASE, OutlookDownloadError, download_outlook_attachments
from .repository import TANK_CATEGORIES, Repository
from .analytics import (
    continuity,
    consumption_trend_range,
    dashboard,
    LOW_COVER_MONTHS,
    grade_daily_trend,
    group_monthly_trend,
    group_unit,
    oil_group,
    GROUP_ORDER,
    PRIMARY_GROUPS,
    decision_brief,
    metric,
    monthly_analysis,
    period_rate,
    COVER_THRESHOLDS,
    tank_fill,
)
from .budget import (
    AE_SYSTEM_OIL,
    BUDGET_CATEGORIES,
    CATEGORY_GROUPS,
    CATEGORY_LABEL,
    ME_CYLINDER_OIL,
    ME_SYSTEM_OIL,
    budget_category,
    budget_performance,
    card_budget,
    group_ytd_actual,
)
from .exports import export_excel, export_pdf
from .fleet import fleet_comparison
from suite_services import vessel_groups
from .parser import norm
from vessel_report.scroll_input import ScrollRouter


def amount(value, digits=1):
    return "—" if value is None else f"{value:,.{digits}f}"


SIDEBAR = "#0E2A47"
SIDEBAR_HOVER = "#173A5E"
SIDEBAR_ACTIVE = "#1F4D7A"
SIDEBAR_TEXT = "#D3DFEB"
SIDEBAR_MUTED = "#8FA6BE"
ACCENT = "#1557A0"
ACCENT_HOVER = "#114888"
ACCENT_TINT = "#E8F0FA"
GOOD = "#1E7A45"
GRID = "#EDF1F5"
TABLE_HEAD = "#F4F7FA"
# The budget year starts on 1 January: the default view is year to date. Rolling windows stay for trends.
YTD_PERIOD = "Budget year to date"
PERIODS = {
    YTD_PERIOD: "YTD",
    "Latest month": 1,
    "Last 3 months": 3,
    "Last 6 months": 6,
    "Last 12 months": 12,
    "Last 24 months": 24,
}
TABS = (
    ("Overview", "Overview"),
    ("Consumption", "Consumption"),
    ("Budget Performance", "Budget"),
    ("AE Analysis", "Renewals"),
    ("Inventory", "Inventory"),
    ("Reports", "Reports"),
    ("Exceptions", "Findings"),
)
SIDEBAR_PAGES = (
    ("Overview", "Lube Oil Intelligence"),
    ("Fleet", "Fleet Comparison"),
    ("Monthly Analysis", "Monthly Reports"),
    ("Register", "Master Data Register"),
    ("Activity", "Activity Log"),
)
# Locked order everywhere: ME system oil, cylinder high BN, cylinder low BN, AE system oil.
GRADE_STYLE = {
    "System oil · ME": dict(
        title="ME System Oil", badge="ME", color="#16936E", tint="#DDF3EC"
    ),
    "Cylinder oil · High TBN": dict(
        title="Cylinder Oil · High BN", badge="HB", color="#1E5AA8", tint="#E3ECF8"
    ),
    "Cylinder oil · Low TBN": dict(
        title="Cylinder Oil · Low BN", badge="LB", color="#3796D6", tint="#E1F0FA"
    ),
    "System oil · AE": dict(
        title="AE System Oil / AECC", badge="AE", color="#6A5ACD", tint="#ECE9FB"
    ),
}
COVER_PILL = {
    "Normal": ("#DDF3E6", "#1E7A45"),
    "Planning": ("#E3ECF8", ACCENT),
    "Low": ("#FCEFD3", "#8A5A00"),
    "Critical": ("#FBE3E1", "#B42318"),
    "No data": ("#ECEFF2", MUTED),
}
# Supporting lubricants: compact, inventory-only buckets. Never part of the cost analysis.
SUPPORT_BUCKETS = (
    ("Hydraulics", ("Hydraulic oil",), "HY", "#D2504B", "#FBE7E6"),
    ("Gear oils", ("Gear oil",), "GR", "#E19A16", "#FCF1DC"),
    (
        "Compressor / refrigeration",
        ("Compressor oil", "Refrigeration oil"),
        "CP",
        "#2A9D8F",
        "#DDF3F0",
    ),
    ("Greases", ("Grease",), "GS", "#7B61C9", "#EEEAF9"),
    (
        "Other / EAL",
        ("Turbocharger oil", "Stern tube oil", "Other oils"),
        "OT",
        "#6B7A86",
        "#ECEFF2",
    ),
)


def vessel_title(name):
    return " ".join(
        word if word in ("DHT", "MT", "MV") else word.capitalize()
        for word in str(name).split()
    )


def money(value, currency="USD"):
    if value is None:
        return "Pending price"
    sign = "-" if value < 0 else ""
    return (
        f"{sign}${abs(value):,.0f}"
        if currency == "USD"
        else f"{sign}{currency} {abs(value):,.0f}"
    )


def signed(value, unit="L"):
    return "—" if value is None else f"{value:+,.0f} {unit}".strip()


class _FloatingTip:
    """A small borderless window beside the pointer.

    Drawn outside the chart, so a long tip is never clipped by a short canvas, and offset from the pointer,
    so it never sits under it (which made the old in-canvas tip vanish and flicker).
    """

    def __init__(self, canvas):
        self.canvas = canvas
        self.window = None
        self.text = None

    def show(self, text, x_root, y_root):
        if self.window is None:
            self.window = tk.Toplevel(self.canvas)
            self.window.overrideredirect(True)
            self.window.attributes("-topmost", True)
            self.label = tk.Label(
                self.window,
                bg=INK,
                fg=WHITE,
                font=("Segoe UI", 9),
                justify="left",
                padx=9,
                pady=6,
            )
            self.label.pack()
        if text != self.text:
            self.label.configure(text=text)
            self.text = text
        width, height = self.label.winfo_reqwidth(), self.label.winfo_reqheight()
        x, y = x_root + 16, y_root + 18
        if x + width > self.canvas.winfo_screenwidth():
            x = x_root - width - 16
        if y + height > self.canvas.winfo_screenheight():
            y = y_root - height - 12
        self.window.geometry(f"+{x}+{y}")
        self.window.deiconify()

    def hide(self):
        if self.window is not None:
            try:
                self.window.withdraw()
            except tk.TclError:  # already destroyed with its chart
                self.window = None
        self.text = None


def attach_tooltips(canvas, zones):
    """Hover text over whole columns of a chart: zones = [(x1, x2, text)].

    The full column height responds, so a short bar or a missing month ("—") is as easy to hover as a tall bar.
    Charts redraw on resize, so the zones are replaced each time and the bindings are made once per canvas.
    """
    canvas._tip_zones = zones
    if getattr(canvas, "_tip", None) is not None:
        return
    canvas._tip = tip = _FloatingTip(canvas)

    def motion(event):
        text = next((t for x1, x2, t in canvas._tip_zones if x1 <= event.x < x2), None)
        if text:
            tip.show(text, event.x_root, event.y_root)
        else:
            tip.hide()

    canvas.bind("<Motion>", motion, add="+")
    canvas.bind("<Leave>", lambda _e: tip.hide(), add="+")
    canvas.bind("<Destroy>", lambda _e: tip.hide(), add="+")


def draw_card_bars(canvas, details, color, unit="L"):
    """Vertical bars: height = monthly consumption. A missing month shows a dash, never a zero bar."""
    canvas.delete("all")
    width, height = _size(canvas, 160)
    left, right, top, bottom = 40, 6, 8, 20
    known = [d["value"] for d in details if d["value"] is not None]
    if not known:
        canvas.create_text(
            width / 2,
            height / 2,
            text="No consumption reported",
            fill=MUTED,
            font=("Segoe UI", 9),
        )
        return
    peak = _nice_max(max(known))
    plot_w, plot_h = width - left - right, height - top - bottom
    for tick in range(3):
        y = top + plot_h * (1 - tick / 2)
        canvas.create_line(left, y, width - right, y, fill=GRID)
        canvas.create_text(
            left - 6,
            y,
            text=_axis(peak * tick / 2),
            anchor="e",
            fill=MUTED,
            font=("Segoe UI", 8),
        )
    slot = plot_w / max(len(details), 1)
    bar = min(26, slot * 0.58)
    every = _label_every(
        len(details), plot_w, 30
    )  # long periods: label every n-th month so labels never overlap
    tips = []
    for i, d in enumerate(details):
        centre = left + slot * (i + 0.5)
        baseline = top + plot_h
        lines = [month_label(d["month"], True)]
        if d["value"] is None:
            canvas.create_text(
                centre, baseline - 8, text="—", fill=MUTED, font=("Segoe UI", 10)
            )
            lines.append(
                d["status"]
                if d["status"] == "Missing report"
                else "Quantity not reported"
            )
        else:
            size = max(plot_h * d["value"] / peak, 1)
            canvas.create_rectangle(
                centre - bar / 2,
                baseline - size,
                centre + bar / 2,
                baseline,
                fill=color,
                outline="",
            )
            lines.append(f"Consumed {d['value']:,.0f} {unit}")
            if d.get("rate") is not None:
                lines.append(f"{d['rate']:,.1f} L/24h")
            lines.append(f"Report: {d['status']}")
        if d.get("note"):
            lines.append(d["note"])
        tips.append((left + slot * i, left + slot * (i + 1), "\n".join(lines)))
        if (len(details) - 1 - i) % every == 0:
            canvas.create_text(
                centre,
                height - 7,
                text=month_label(d["month"]),
                fill=MUTED,
                font=("Segoe UI", 8),
            )
    attach_tooltips(canvas, tips)


GROUP_STYLE = {
    "Hydraulic oil": ("HY", "#D2504B", "#FBE7E6"),
    "Gear oil": ("GR", "#E19A16", "#FCF1DC"),
    "Compressor oil": ("CP", "#2A9D8F", "#DDF3F0"),
    "Refrigeration oil": ("RF", "#3A86C8", "#E1EEF9"),
    "Turbocharger oil": ("TC", "#8E6CC4", "#EFE9F8"),
    "Stern tube oil": ("ST", "#5B7083", "#E8EDF1"),
    "Grease": ("GS", "#7B61C9", "#EEEAF9"),
    "Other oils": ("OT", "#6B7A86", "#ECEFF2"),
}


def litres(value, unit="L"):
    return "—" if value is None else f"{value:,.0f} {unit}".strip()


def month_label(month, year=False):
    return datetime.strptime(month + "-01", "%Y-%m-%d").strftime(
        "%b-%y" if year else "%b"
    )


def _nice_max(value):
    if value <= 0:
        return 1
    magnitude = 10 ** math.floor(math.log10(value))
    return next(
        step * magnitude for step in (1, 2, 2.5, 5, 10) if value <= step * magnitude
    )


def _axis(value):
    return f"{value / 1000:g}K" if value >= 1000 else f"{value:g}"


def _size(canvas, minimum_width):
    height = canvas.winfo_height()
    return max(canvas.winfo_width(), minimum_width), (
        height if height > 20 else int(canvas.cget("height"))
    )


def _label_every(count, plot_width, label_width):
    return max(1, math.ceil(count * label_width / max(plot_width, 1)))


def draw_area(canvas, months, values, color, tint, axis=True):
    """Line-and-area trend; a missing month breaks the line instead of dropping to zero."""
    canvas.delete("all")
    width, height = _size(canvas, 120)
    left, right, top, bottom = (36, 8, 8, 18) if axis else (4, 4, 6, 6)
    known = [v for v in values if v is not None]
    if not known:
        canvas.create_text(
            width / 2,
            height / 2,
            text="No data in period",
            fill=MUTED,
            font=("Segoe UI", 9),
        )
        return
    peak = _nice_max(max(known))
    plot_w, plot_h = width - left - right, height - top - bottom
    if axis:
        for tick in range(3):
            y = top + plot_h * (1 - tick / 2)
            canvas.create_line(left, y, width - right, y, fill=GRID)
            canvas.create_text(
                left - 6,
                y,
                text=_axis(peak * tick / 2),
                anchor="e",
                fill=MUTED,
                font=("Segoe UI", 8),
            )
    step = plot_w / max(len(values) - 1, 1)
    points = [
        None if v is None else (left + i * step, top + plot_h * (1 - v / peak))
        for i, v in enumerate(values)
    ]
    segment = []
    for point in points + [None]:
        if point is not None:
            segment.append(point)
            continue
        if len(segment) >= 2:
            flat = [c for p in segment for c in p]
            canvas.create_polygon(
                [segment[0][0], top + plot_h, *flat, segment[-1][0], top + plot_h],
                fill=tint,
                outline="",
            )
            canvas.create_line(flat, fill=color, width=2)
        segment = []
    for point in points:
        if point is not None:
            canvas.create_oval(
                point[0] - 2.5,
                point[1] - 2.5,
                point[0] + 2.5,
                point[1] + 2.5,
                fill=color,
                outline=WHITE,
            )
    if axis:
        every = _label_every(len(months), plot_w, 34)
        for i, month in enumerate(months):
            if (len(months) - 1 - i) % every == 0:
                canvas.create_text(
                    left + i * step,
                    height - 6,
                    text=month_label(month),
                    fill=MUTED,
                    font=("Segoe UI", 8),
                )


def draw_ranking(canvas, items, color, fmt, row=30):
    """Horizontal bars in the given order. items = [(name, value)]; a missing value shows a dash, never a zero bar."""
    canvas.delete("all")
    width, _height = _size(canvas, 260)
    left, right, top = 150, 90, 8
    known = [value for _, value in items if value is not None]
    if not known:
        canvas.create_text(
            width / 2, 40, text="No data in period", fill=MUTED, font=("Segoe UI", 10)
        )
        return
    peak = max(known) or 1
    for index, (name, value) in enumerate(items):
        y = top + row * index + row / 2
        canvas.create_text(
            left - 10, y, text=name, anchor="e", fill=INK, font=("Segoe UI", 9)
        )
        if value is None:
            canvas.create_text(
                left + 4,
                y,
                text="—  not reported",
                anchor="w",
                fill=MUTED,
                font=("Segoe UI", 9),
            )
            continue
        end = left + max((width - left - right) * value / peak, 2)
        canvas.create_rectangle(
            left, y - row * 0.28, end, y + row * 0.28, fill=color, outline=""
        )
        canvas.create_text(
            end + 6,
            y,
            text=fmt(value),
            anchor="w",
            fill=INK,
            font=("Segoe UI", 9, "bold"),
        )


def draw_bars(canvas, months, series, stacked=False, notes=None):
    """Grouped or stacked monthly bars. series = [(name, colour, values)]; blanks are not drawn.

    notes: optional text per month, printed under the month label (e.g. how many vessels reported).
    """
    canvas.delete("all")
    width, height = _size(canvas, 260)
    left, right, top, bottom = 52, 8, 10, 40 if notes else 24
    count = len(months)
    if stacked:
        peaks = [sum(values[i] or 0 for _, _, values in series) for i in range(count)]
    else:
        peaks = [v for _, _, values in series for v in values if v is not None]
    if not any(peaks):
        canvas.create_text(
            width / 2,
            height / 2,
            text="No data in period",
            fill=MUTED,
            font=("Segoe UI", 10),
        )
        return
    peak = _nice_max(max(peaks))
    plot_w, plot_h = width - left - right, height - top - bottom
    for tick in range(5):
        y = top + plot_h * (1 - tick / 4)
        canvas.create_line(left, y, width - right, y, fill=GRID)
        canvas.create_text(
            left - 6,
            y,
            text=f"{peak * tick / 4:,.0f}",
            anchor="e",
            fill=MUTED,
            font=("Segoe UI", 8),
        )
    slot = plot_w / max(count, 1)
    baseline = top + plot_h
    for i, month in enumerate(months):
        centre = left + slot * (i + 0.5)
        if stacked:
            bar = min(34, slot * 0.58)
            base = baseline
            for _, color, values in series:
                if values[i]:
                    size = plot_h * values[i] / peak
                    canvas.create_rectangle(
                        centre - bar / 2,
                        base - size,
                        centre + bar / 2,
                        base,
                        fill=color,
                        outline="",
                    )
                    base -= size
        else:
            group = min(slot * 0.8, 17 * len(series))
            bar = group / len(series)
            for j, (_, color, values) in enumerate(series):
                if values[i] is not None:
                    x = centre - group / 2 + j * bar
                    canvas.create_rectangle(
                        x + 1,
                        baseline - plot_h * values[i] / peak,
                        x + bar - 1,
                        baseline,
                        fill=color,
                        outline="",
                    )
        if all(values[i] is None for _, _, values in series):
            canvas.create_text(
                centre, baseline - 8, text="—", fill=MUTED, font=("Segoe UI", 9)
            )
        if (count - 1 - i) % _label_every(count, plot_w, 48) == 0:
            canvas.create_text(
                centre,
                height - (24 if notes else 8),
                text=month_label(month, True),
                fill=MUTED,
                font=("Segoe UI", 8),
            )
            if notes:
                canvas.create_text(
                    centre, height - 8, text=notes[i], fill=MUTED, font=("Segoe UI", 7)
                )


class ReviewApp(ctk.CTk):
    def __init__(self, root=None):
        super().__init__()
        self.title("Lube Oil Intelligence | NeraVeda")
        self.geometry("1520x940")
        self.minsize(1280, 760)
        self.configure(fg_color=BG)
        self.repo = Repository(root)
        self.events = queue.Queue()
        self.stop = threading.Event()
        self.download_thread = None
        self.download_paths = []
        self.download_error = None
        self.download_summary = None
        self.transfer_notice = None
        self.busy = False
        self.closing = False
        self.report_id = None
        self.page = "Overview"
        self.last_tab = "Overview"
        self.period_months = PERIODS[YTD_PERIOD]
        self.fleet_group = None  # None = all vessels; otherwise a suite vessel-group id
        self.fleet_category = ME_SYSTEM_OIL
        self.analysis_month = None
        self.analysis_window = 3
        self.budget_year = None
        self.variance_category = ME_CYLINDER_OIL
        self.variance_view = "Quantity"
        self.import_log = []
        self.activity_log = []
        self.activity_box = None
        self.scroll_router = ScrollRouter(self)
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        sidebar = ctk.CTkFrame(self, width=236, fg_color=SIDEBAR, corner_radius=0)
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_propagate(False)
        self.label(sidebar, "NeraVeda", 22, WHITE, True, justify="left").pack(
            anchor="w", padx=24, pady=(26, 2)
        )
        self.label(sidebar, "Maritime Engineering Insights", 11, SIDEBAR_MUTED).pack(
            anchor="w", padx=24, pady=(0, 26)
        )
        self.nav = {}
        for page, text in SIDEBAR_PAGES:
            button = ctk.CTkButton(
                sidebar,
                text=text,
                anchor="w",
                height=42,
                corner_radius=8,
                command=lambda p=page: self.show(
                    self.last_tab if p == "Overview" else p
                ),
                fg_color="transparent",
                hover_color=SIDEBAR_HOVER,
                text_color=SIDEBAR_TEXT,
                font=ctk.CTkFont(family="Segoe UI", size=13),
            )
            button.pack(fill="x", padx=14, pady=2)
            self.nav[page] = button
        actions = ctk.CTkFrame(sidebar, fg_color="transparent")
        actions.pack(side="bottom", fill="x", padx=16, pady=(0, 22))
        self.label(actions, "IMPORT VESSEL SHEETS", 10, SIDEBAR_MUTED, True).pack(
            anchor="w", pady=(0, 6)
        )
        self.download_button = self.side_button(
            actions, "Get Excel from Outlook", self.open_outlook_download
        )
        self.folder_button = self.side_button(
            actions, "Import folder", self.import_folder
        )
        self.import_button = self.side_button(
            actions, "Import files", self.import_files
        )
        ctk.CTkFrame(actions, height=1, fg_color=SIDEBAR_HOVER).pack(
            fill="x", pady=(16, 12)
        )
        self.label(
            actions,
            "Smarter Data.\nSharper Decisions.\nSmoother Sailing.",
            13,
            SIDEBAR_TEXT,
            justify="left",
        ).pack(anchor="w")

        main = ctk.CTkFrame(self, fg_color=BG, corner_radius=0)
        main.grid(row=0, column=1, sticky="nsew")
        main.grid_columnconfigure(0, weight=1)
        main.grid_rowconfigure(2, weight=1)
        header = ctk.CTkFrame(main, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=28, pady=(18, 0))
        header.grid_columnconfigure(0, weight=1)
        # The title has the full width of its own row, so the pickers never cut it off.
        self.title_label = self.label(
            header, "Lube Oil Consumption & Budget", 20, INK, True
        )
        self.title_label.grid(row=0, column=0, columnspan=2, sticky="w")
        self.label(header, datetime.now().strftime("%a, %d %b %Y"), 12, MUTED).grid(
            row=0, column=1, sticky="e"
        )
        self.label(
            header,
            "Consumption-led · budget-aware · every figure traceable to the vessel's sheet",
            12,
            MUTED,
            wraplength=360,
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=(0, 12))
        pickers = ctk.CTkFrame(header, fg_color="transparent")
        pickers.grid(row=1, column=1, sticky="e", pady=(6, 0))
        menu_style = dict(
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
            height=34,
            font=ctk.CTkFont(family="Segoe UI", size=12),
        )
        self.vessel = ctk.CTkOptionMenu(
            pickers,
            values=["No reports"],
            command=self.change_vessel,
            width=170,
            **menu_style,
        )
        self.vessel.pack(side="left", padx=(0, 8))
        self.period = ctk.CTkOptionMenu(
            pickers,
            values=list(PERIODS),
            command=self.change_period,
            width=176,
            **menu_style,
        )
        self.period.set(YTD_PERIOD)
        self.period.pack(side="left", padx=(0, 8))
        self.report_menu = ctk.CTkOptionMenu(
            pickers,
            values=["No reports"],
            command=self.change_report,
            width=240,
            **menu_style,
        )
        self.report_menu.pack(side="left")
        tabs = ctk.CTkFrame(header, fg_color="transparent")
        tabs.grid(row=2, column=0, columnspan=2, sticky="sw", pady=(12, 0))
        self.tabs = {}
        for text, page in TABS:
            holder = ctk.CTkFrame(tabs, fg_color="transparent")
            holder.pack(side="left", padx=(0, 14))
            tab = ctk.CTkButton(
                holder,
                text=text,
                command=lambda p=page: self.show(p),
                width=20,
                height=32,
                fg_color="transparent",
                hover_color="#E6ECF2",
                text_color=MUTED,
                corner_radius=6,
                font=ctk.CTkFont(family="Segoe UI", size=13, weight="bold"),
            )
            tab.pack()
            underline = ctk.CTkFrame(
                holder, width=1, height=3, fg_color="transparent", corner_radius=2
            )
            underline.pack(fill="x")
            self.tabs[page] = (tab, underline)
        ctk.CTkFrame(main, height=1, fg_color=BORDER).grid(
            row=1, column=0, sticky="ew", padx=28
        )
        self.body = ctk.CTkScrollableFrame(main, fg_color=BG, corner_radius=0)
        self.body.grid(row=2, column=0, sticky="nsew", padx=(28, 12), pady=(14, 0))
        self.body.grid_columnconfigure(0, weight=1)
        footer = ctk.CTkFrame(
            main, fg_color=WHITE, corner_radius=0, border_width=1, border_color=BORDER
        )
        footer.grid(row=3, column=0, sticky="ew")
        self.status = self.label(footer, "Import vessel reports to begin.", 12, MUTED)
        self.status.pack(side="left", padx=28, pady=11)
        self.attention_button = ctk.CTkButton(
            footer,
            text="",
            command=lambda: self.show("Findings"),
            width=20,
            height=30,
            fg_color="transparent",
            hover_color="#FBF1DD",
            text_color=AMBER,
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
        )
        self.attention_button.pack(side="right", padx=(6, 24))
        self.source_button = ctk.CTkButton(
            footer,
            text="Open source workbook",
            command=lambda: self.current and self.open_original(self.current),
            width=20,
            height=30,
            fg_color="transparent",
            hover_color=ACCENT_TINT,
            text_color=ACCENT,
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
        )
        self.source_button.pack(side="right")
        self.import_label = self.label(footer, "", 12, MUTED)
        self.import_label.pack(side="right", padx=14)
        self.protocol("WM_DELETE_WINDOW", self.close_app)
        self.bind("<Control-o>", lambda _: self.import_files())
        self.bind("<F5>", lambda _: self.refresh())
        self.status.configure(text="Refreshing stored report analysis…")
        self.update_idletasks()
        try:
            refreshed = self.repo.reprocess_stale_reports()
            if refreshed:
                self.status.configure(
                    text=f"Updated analysis for {refreshed} archived report(s) using the current parser."
                )
            self.repo.activate_imported()
        except (OSError, RuntimeError, ValueError) as error:
            self.status.configure(text=f"Stored report refresh failed: {error}")
            messagebox.showerror(
                "Could not refresh stored reports",
                str(error),
                parent=self,
            )
        self.refresh()
        self.timer = self.after(100, self.poll)

    @staticmethod
    def label(parent, text, size=13, color=INK, bold=False, **kwargs):
        return ctk.CTkLabel(
            parent,
            text=text,
            text_color=color,
            font=ctk.CTkFont(
                family="Segoe UI", size=size, weight="bold" if bold else "normal"
            ),
            anchor="w",
            **kwargs,
        )

    @staticmethod
    def button(parent, text, command, secondary=False, **kwargs):
        return ctk.CTkButton(
            parent,
            text=text,
            command=command,
            height=34,
            corner_radius=8,
            fg_color=ACCENT_TINT if secondary else ACCENT,
            hover_color="#D6E4F5" if secondary else ACCENT_HOVER,
            text_color=ACCENT if secondary else WHITE,
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
            **kwargs,
        )

    def fluid(self, parent, text, size=10, color=MUTED, bold=False, wrap=900, **pack):
        """A wrapped note. Wrap widths are fixed and sized for the minimum window (1280 px): resize-driven
        wrapping makes the scrollable page height oscillate and CustomTkinter's scrollbar recurse.
        """
        label = self.label(
            parent, text, size, color, bold, justify="left", wraplength=wrap
        )
        label.pack(anchor="w", **pack)
        return label

    def side_button(self, parent, text, command):
        button = ctk.CTkButton(
            parent,
            text=text,
            command=command,
            height=34,
            corner_radius=8,
            anchor="w",
            fg_color=SIDEBAR_HOVER,
            hover_color=SIDEBAR_ACTIVE,
            text_color=WHITE,
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
        )
        button.pack(fill="x", pady=3)
        return button

    def card(self):
        frame = ctk.CTkFrame(
            self.body,
            fg_color=WHITE,
            border_width=1,
            border_color=BORDER,
            corner_radius=12,
        )
        frame.pack(fill="x", pady=(0, 14), padx=2)
        return frame

    def heading(self, title, caption):
        self.label(self.body, title, 20, bold=True).pack(anchor="w", pady=(2, 2))
        self.label(self.body, caption, 12, MUTED, wraplength=1000, justify="left").pack(
            anchor="w", pady=(0, 14)
        )

    def banner(self, text, tone="good"):
        fill, ink = {
            "good": ("#E7F5EC", GOOD),
            "warn": ("#FDF5E6", AMBER),
            "neutral": ("#EEF1F4", MUTED),
        }[tone]
        frame = ctk.CTkFrame(self.body, fg_color=fill, corner_radius=10)
        frame.pack(fill="x", pady=(0, 14), padx=2)
        self.label(frame, text, 12, ink, True, wraplength=1000, justify="left").pack(
            anchor="w", padx=16, pady=10
        )
        return frame

    def section(self, title, subtitle=None, link=None):
        panel = self.panel(self.body, title, subtitle, link)
        panel.pack(fill="x", pady=(0, 14), padx=2)
        return panel

    def render_monthly_analysis(self):
        months = sorted(
            {report["month"] for report in self.reports if report.get("month")},
            reverse=True,
        )
        selected_vessel = self.vessel.get()
        self.heading(
            (
                "Monthly vessel review"
                if selected_vessel != "No reports"
                else "Monthly fleet review"
            ),
            (
                f"Review {selected_vessel} for the selected workbook month against its own available history. "
                if selected_vessel != "No reports"
                else "Assess each vessel’s report for the selected workbook month against its own available history. "
            )
            + "Missing months are never filled with zero.",
        )
        controls = self.card()
        self.label(controls, "REPORTING MONTH", 10, MUTED, True).pack(
            side="left", padx=(18, 8), pady=16
        )
        if not months:
            self.label(controls, "No parsed reporting months yet", 13, MUTED).pack(
                side="left", padx=8, pady=16
            )
            self.button(
                controls, "Get Excel from Outlook", self.open_outlook_download
            ).pack(side="right", padx=16, pady=12)
            self.button(
                controls, "Import folder", self.import_folder, secondary=True
            ).pack(side="right", padx=8, pady=12)
            self.label(
                self.body,
                "Reports are grouped by the month stated inside each workbook, not the email received date.",
                12,
                MUTED,
            ).pack(anchor="w", pady=(0, 12))
            return

        month_menu = ctk.CTkOptionMenu(
            controls,
            values=months,
            command=self.change_analysis_month,
            width=130,
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
        )
        month_menu.set(
            self.analysis_month if self.analysis_month in months else months[0]
        )
        month_menu.pack(side="left", padx=(0, 18), pady=12)
        self.label(controls, "COMPARISON", 10, MUTED, True).pack(
            side="left", padx=(0, 8), pady=16
        )
        period_names = {
            0: "Current month",
            3: "Prior 3 months",
            6: "Prior 6 months",
            12: "Prior 12 months",
        }
        period_menu = ctk.CTkOptionMenu(
            controls,
            values=list(period_names.values()),
            command=lambda value: self.change_analysis_window(
                next(key for key, label in period_names.items() if label == value)
            ),
            width=160,
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
        )
        period_menu.set(period_names[self.analysis_window])
        period_menu.pack(side="left", pady=12)
        self.button(
            controls,
            "Export Excel",
            lambda: self.export_monthly("excel"),
            secondary=True,
        ).pack(side="right", padx=(8, 16), pady=12)
        self.button(
            controls, "Export PDF", lambda: self.export_monthly("pdf"), secondary=True
        ).pack(side="right", pady=12)

        analysis = monthly_analysis(self.reports, self.analysis_month)
        if selected_vessel != "No reports":
            analysis["vessels"] = [
                vessel
                for vessel in analysis["vessels"]
                if vessel["vessel"] == selected_vessel
            ]
            analysis["report_count"] = sum(
                vessel["candidate_count"] for vessel in analysis["vessels"]
            )
            analysis["unresolved_count"] = sum(
                not report.get("month")
                and (report.get("vessel") or report["data"].get("vessel"))
                == selected_vessel
                for report in self.reports
            )
        self.monthly_analysis = analysis
        window = self.analysis_window
        present = sum(
            vessel["state"] in ("confirmed", "provisional")
            for vessel in analysis["vessels"]
        )
        findings = sum(
            len(vessel["issues"]) for vessel in analysis["vessels"] if vessel["report"]
        )
        if selected_vessel != "No reports" and analysis["vessels"]:
            self.render_superintendent_brief(
                analysis["vessels"][0],
                analysis["month"],
                window,
            )
        else:
            self.stat_tiles(
                (
                    ("Vessels in history", str(len(analysis["vessels"])), ACCENT),
                    (
                        "Reports this month",
                        f"{present}/{len(analysis['vessels'])}",
                        GOOD,
                    ),
                    ("Parsed findings", str(findings), AMBER if findings else GOOD),
                )
            )

        self.label(
            self.body,
            f"{analysis['report_count']} source report(s) for {analysis['month']}"
            + (
                f" · {analysis['unresolved_count']} imported report(s) have a workbook month that could not be read."
                if analysis["unresolved_count"]
                else "."
            ),
            11,
            MUTED,
            wraplength=1000,
            justify="left",
        ).pack(anchor="w", padx=4, pady=(0, 12))

        for vessel in analysis["vessels"]:
            frame = self.card()
            report = vessel["report"]
            state_text = {
                "confirmed": "OFFICIAL REPORT",
                "provisional": "NOT USABLE · VESSEL OR MONTH UNIDENTIFIED",
                "ambiguous": "MULTIPLE VERSIONS · RESOLVE BEFORE COMPARISON",
                "missing": "NO REPORT FOR SELECTED MONTH",
            }[vessel["state"]]
            head = ctk.CTkFrame(frame, fg_color="transparent")
            head.pack(fill="x", padx=20, pady=(14, 8))
            self.label(head, vessel["vessel"], 16, INK, True).pack(side="left")
            self.pill(
                head, state_text, "good" if vessel["state"] == "confirmed" else "warn"
            ).pack(side="left", padx=12)
            if report is None:
                vessel_reports = [
                    item
                    for item in self.reports
                    if (item.get("vessel") or item["data"].get("vessel"))
                    == vessel["vessel"]
                ]
                options = [
                    item
                    for item in vessel_reports
                    if item.get("month") == analysis["month"]
                ]
                if options:
                    self.label(
                        frame,
                        "Candidate sources: "
                        + " · ".join(item["filename"] for item in options),
                        12,
                        MUTED,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 12))
                elif vessel_reports:
                    other_months = sorted(
                        vessel_reports,
                        key=lambda item: item.get("month") or "",
                        reverse=True,
                    )
                    source_lines = [
                        f"{item.get('month') or 'Month unresolved'} · {item['filename']}"
                        for item in other_months[:5]
                    ]
                    self.label(
                        frame,
                        "No report is assigned to the selected workbook month. Other imported sources "
                        "are shown for review; do not assume they belong to this month:\n"
                        + "\n".join(source_lines),
                        12,
                        MUTED,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 12))
                else:
                    self.label(
                        frame,
                        f"No workbook with reporting month {analysis['month']} is available for this vessel. "
                        "Check the Outlook received-date range, import outcome, and workbook month.",
                        12,
                        MUTED,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 12))
                continue

            self.label(
                frame,
                f"Source: {report['filename']} · validation {report['validation_status']}",
                11,
                MUTED,
                wraplength=870,
            ).pack(anchor="w", padx=20, pady=(0, 8))
            brief = vessel["brief"]
            if brief:
                self.label(
                    frame,
                    brief["headline"],
                    15,
                    INK,
                    True,
                    wraplength=870,
                    justify="left",
                ).pack(anchor="w", padx=20, pady=(0, 4))
                self.label(
                    frame,
                    brief["rationale"],
                    12,
                    MUTED,
                    wraplength=870,
                    justify="left",
                ).pack(anchor="w", padx=20, pady=(0, 4))
                self.label(
                    frame,
                    "NEXT: " + brief["action"],
                    12,
                    INK,
                    wraplength=870,
                    justify="left",
                ).pack(anchor="w", padx=20, pady=(0, 8))
                for fact in brief["facts"]:
                    self.label(
                        frame,
                        "• " + fact,
                        12,
                        INK,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 4))

            if vessel["engines"]:
                period_title = (
                    "Current month only"
                    if window == 0
                    else f"Prior {window}-month average"
                )
                self.label(frame, period_title, 12, MUTED, True).pack(
                    anchor="w", padx=20, pady=(8, 4)
                )
                rows = []
                for engine in vessel["engines"]:
                    if window == 0:
                        rows.append(
                            (
                                engine["engine"],
                                engine["comparisons"].get(3, {}).get("grade") or "—",
                                amount(engine["hours"]),
                                amount(engine["rate"], 2),
                                "—",
                                "—",
                                "—",
                            )
                        )
                    else:
                        comparison = engine["comparisons"][window]
                        rows.append(
                            (
                                engine["engine"],
                                comparison["grade"] or "—",
                                amount(engine["hours"]),
                                amount(engine["rate"], 2),
                                amount(comparison["average_rate"], 2),
                                (
                                    f"{comparison['change_percent']:+.1f}%"
                                    if comparison["change_percent"] is not None
                                    else "—"
                                ),
                                f"{comparison['coverage']}/{window}",
                            )
                        )
                headers = (
                    [
                        "Engine",
                        "Oil grade",
                        "Current hours",
                        "Current L/24h",
                        "Prior avg L/24h",
                        "Change",
                        "Coverage",
                    ]
                    if window
                    else [
                        "Engine",
                        "Oil grade",
                        "Hours",
                        "Current L/24h",
                        "Prior avg",
                        "Change",
                        "Coverage",
                    ]
                )
                self.table(
                    frame,
                    headers,
                    rows,
                    [105, 150, 110, 125, 135, 90, 90],
                )
                main_engine = next(
                    (
                        engine
                        for engine in vessel["engines"]
                        if engine["engine"] == "ME"
                    ),
                    None,
                )
                if main_engine and main_engine["cylinder_rate"] is not None:
                    grade_basis = (
                        "; ".join(
                            f"{family.title()}: {grade}"
                            for family, grade in main_engine["cylinder_grade_basis"]
                        )
                        or "grade unresolved"
                    )
                    cylinder_text = (
                        f"ME cylinder-oil rate: {amount(main_engine['cylinder_rate'], 2)} L/24h "
                        f"· grade basis: {grade_basis}"
                    )
                    if window:
                        comparison = main_engine["cylinder_comparisons"][window]
                        cylinder_text += (
                            f"\nPrior average: "
                            f"{amount(comparison['average_rate'], 2)} L/24h "
                            f"({comparison['coverage']}/{window} months)"
                        )
                        if comparison["change_percent"] is not None:
                            cylinder_text += (
                                f" · change {comparison['change_percent']:+.1f}%"
                            )
                        if comparison["reference_provisional_months"]:
                            cylinder_text += (
                                f"\nPRELIMINARY REFERENCE: "
                                f"{amount(comparison['reference_average_rate'], 2)} L/24h "
                                f"({comparison['reference_coverage']}/{window} months; "
                                f"{comparison['reference_provisional_months']} pending)"
                            )
                            if comparison["reference_change_percent"] is not None:
                                cylinder_text += f" · {comparison['reference_change_percent']:+.1f}% vs current"
                    self.label(
                        frame,
                        cylinder_text,
                        12,
                        INK,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 8))
                if window:
                    references = []
                    for engine in vessel["engines"]:
                        comparison = engine["comparisons"][window]
                        if comparison["reference_provisional_months"]:
                            average = comparison["reference_average_rate"]
                            delta = comparison["reference_change_percent"]
                            references.append(
                                f"{engine['engine']}: "
                                f"{amount(average, 2)} L/24h "
                                f"({comparison['reference_coverage']}/{window} months"
                                f"; {comparison['reference_provisional_months']} pending)"
                                + (
                                    f"; {delta:+.1f}% vs current"
                                    if delta is not None
                                    else ""
                                )
                            )
                    if references:
                        self.label(
                            frame,
                            "PRELIMINARY REFERENCE · includes unconfirmed reports; verify before relying on it\n"
                            + " · ".join(references),
                            11,
                            AMBER,
                            wraplength=870,
                            justify="left",
                        ).pack(anchor="w", padx=20, pady=(0, 8))
                    self.label(
                        frame,
                        "Change is shown only when every month in the selected window has a valid rate "
                        "on the same oil grade. Coverage is comparable months / window.",
                        11,
                        MUTED,
                        wraplength=870,
                        justify="left",
                    ).pack(anchor="w", padx=20, pady=(0, 8))

            system_oils = [
                oil
                for oil in vessel["oils"]
                if norm(oil["category"]) in ("SYSTEM OIL M E", "SYSTEM OIL A E")
            ]
            if system_oils:
                self.label(
                    frame, "Monthly operating consumption", 12, MUTED, True
                ).pack(anchor="w", padx=20, pady=(8, 4))
                oil_rows = []
                for oil in system_oils:
                    if window:
                        comparison = oil["comparisons"][window]
                        oil_rows.append(
                            (
                                oil["category"],
                                oil["grade"] or "—",
                                amount(oil["operating"]),
                                amount(oil["change_loss"]),
                                amount(oil["all_in"]),
                                amount(comparison["average_operating"]),
                                (
                                    f"{comparison['change_percent']:+.1f}%"
                                    if comparison["change_percent"] is not None
                                    else "—"
                                ),
                                f"{comparison['coverage']}/{window}",
                            )
                        )
                    else:
                        oil_rows.append(
                            (
                                oil["category"],
                                oil["grade"] or "—",
                                amount(oil["operating"]),
                                amount(oil["change_loss"]),
                                amount(oil["all_in"]),
                                "—",
                                "—",
                                "—",
                            )
                        )
                self.table(
                    frame,
                    [
                        "System",
                        "Grade",
                        "Operating (L)",
                        "Change/loss (L)",
                        "All-in (L)",
                        "Prior avg operating (L)",
                        "Change",
                        "Coverage",
                    ],
                    oil_rows,
                    [145, 145, 115, 125, 105, 170, 90, 90],
                )
                if window:
                    references = []
                    for oil in system_oils:
                        comparison = oil["comparisons"][window]
                        if comparison["reference_provisional_months"]:
                            average = comparison["reference_average_operating"]
                            delta = comparison["reference_change_percent"]
                            references.append(
                                f"{oil['category']}: {amount(average)} L "
                                f"({comparison['reference_coverage']}/{window} months"
                                f"; {comparison['reference_provisional_months']} pending)"
                                + (
                                    f"; {delta:+.1f}% vs current"
                                    if delta is not None
                                    else ""
                                )
                            )
                    if references:
                        self.label(
                            frame,
                            "PRELIMINARY REFERENCE · includes unconfirmed reports; verify before relying on it\n"
                            + " · ".join(references),
                            11,
                            AMBER,
                            wraplength=870,
                            justify="left",
                        ).pack(anchor="w", padx=20, pady=(0, 8))
                self.label(
                    frame,
                    "Storage withdrawal, system operating consumption, and change/loss are distinct movements; "
                    "the table does not classify unexplained differences as physical loss.",
                    11,
                    MUTED,
                    wraplength=870,
                    justify="left",
                ).pack(anchor="w", padx=20, pady=(0, 8))

            buttons = ctk.CTkFrame(frame, fg_color="transparent")
            buttons.pack(anchor="w", padx=20, pady=(4, 16))
            self.button(
                buttons,
                "Open report evidence",
                lambda report_id=report["id"]: self.open_month_report(report_id),
                secondary=True,
            ).pack(side="left")

    def render_superintendent_brief(self, vessel, month, window):
        frame = self.card()
        report = vessel["report"]
        report_state = vessel["state"]
        state_labels = {
            "confirmed": "OFFICIAL REPORT",
            "provisional": "NOT USABLE",
            "ambiguous": "SOURCE VERSION NEEDS RESOLUTION",
            "missing": "NO REPORT FOR SELECTED MONTH",
        }
        state_color = GOOD if report_state == "confirmed" else AMBER
        if report is None:
            self.label(frame, "Technical review brief", 15, INK, True).pack(
                anchor="w", padx=20, pady=(14, 4)
            )
            self.label(
                frame,
                state_labels[report_state],
                10,
                state_color,
                True,
            ).pack(anchor="w", padx=20, pady=(0, 8))
            self.label(
                frame,
                f"No report is resolved for {vessel['vessel']} in {month}. "
                "Choose a reporting month with an imported workbook to see consumption analytics.",
                12,
                MUTED,
                wraplength=870,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 16))
            return

        significant = [
            issue
            for issue in vessel["issues"]
            if not issue["code"].startswith(("missing:", "unit:"))
        ]
        failed = report.get("validation_status") == "FAIL"
        issue_color = RED if failed else AMBER if significant else GOOD
        self.label(frame, "Technical review brief", 15, INK, True).pack(
            anchor="w", padx=20, pady=(14, 4)
        )
        self.label(
            frame,
            f"{state_labels[report_state]}  ·  {report['validation_status']} VALIDATION  ·  "
            f"{len(significant)} PRIORITY FINDING(S)",
            10,
            state_color if not failed else RED,
            True,
        ).pack(anchor="w", padx=20, pady=(0, 8))

        brief = vessel["brief"] or {}
        self.label(
            frame,
            brief.get("headline", "Review the report before making a decision"),
            16,
            INK,
            True,
            wraplength=870,
            justify="left",
        ).pack(anchor="w", padx=20, pady=(0, 4))
        if brief.get("rationale"):
            self.label(
                frame,
                brief["rationale"],
                12,
                MUTED,
                wraplength=870,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 4))
        if brief.get("action"):
            self.label(
                frame,
                "NEXT ACTION  ·  " + brief["action"],
                12,
                issue_color,
                True,
                wraplength=870,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 10))

        primary = [oil for oil in vessel.get("bulk_oils", []) if oil.get("primary")]
        groups = vessel.get("oil_groups", [])
        if primary or groups:
            comparison_window = window or 3
            comparison_name = (
                f"prior {comparison_window}-month average"
                if window
                else "prior 3-month context"
            )
            provisional = report_state == "provisional"
            if primary:
                self.label(
                    frame,
                    f"PRIMARY BULK GRADES  ·  {comparison_name.upper()}",
                    10,
                    MUTED,
                    True,
                ).pack(anchor="w", padx=20, pady=(4, 6))
                self.comparison_bars(
                    frame,
                    [
                        dict(
                            label=f"{oil['group']}  ·  {oil['grade']}",
                            current=oil["monthly_consumption"],
                            unit=oil["unit"] or "qty",
                            comparison=oil["comparisons"].get(comparison_window, {}),
                        )
                        for oil in primary
                    ],
                    comparison_window,
                    provisional,
                )
            if groups:
                self.label(
                    frame,
                    f"OTHER OILS BY GROUP  ·  {comparison_name.upper()}",
                    10,
                    MUTED,
                    True,
                ).pack(anchor="w", padx=20, pady=(10, 6))
                self.comparison_bars(
                    frame,
                    [
                        dict(
                            label=f"{group['group']}  ·  {len(group['grades'])} heading(s)",
                            current=group["monthly_consumption"],
                            unit=group["unit"] or "qty",
                            comparison=group["comparisons"].get(comparison_window, {}),
                            reason=group["unavailable_reason"],
                        )
                        for group in groups
                    ],
                    comparison_window,
                    provisional,
                )
            self.label(
                frame,
                "Bars show the selected month's quantity; dashed markers show the prior average. "
                "Percent change is withheld when calendar-month coverage is incomplete. System oils use operating "
                "consumption; other oils use storage withdrawal. A group total needs every heading in the group "
                "to be reported; grease stays in its reported unit and is never added to litres.",
                10,
                MUTED,
                wraplength=870,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 12))
        else:
            self.label(
                frame,
                "No grade-level litre quantities are available to compare in this report.",
                12,
                MUTED,
                wraplength=870,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 12))

        if significant:
            self.label(frame, "TOP ITEMS TO VERIFY", 10, MUTED, True).pack(
                anchor="w", padx=20, pady=(0, 4)
            )
            for issue in significant[:3]:
                self.label(
                    frame,
                    f"• {issue['title']} — {issue['detail']}",
                    11,
                    RED if issue["severity"] == "FAIL" else INK,
                    wraplength=870,
                    justify="left",
                ).pack(anchor="w", padx=20, pady=(0, 3))

        self.button(
            frame,
            "Open source evidence",
            lambda report_id=report["id"]: self.open_month_report(report_id),
            secondary=True,
        ).pack(anchor="w", padx=20, pady=(8, 16))

    def comparison_bars(self, parent, rows, comparison_window, provisional):
        chart = tk.Canvas(
            parent,
            height=max(118, 52 * len(rows) + 52),
            bg=WHITE,
            highlightthickness=0,
            borderwidth=0,
        )
        chart.pack(fill="x", padx=20, pady=(0, 4))
        bar_color = AMBER if provisional else ACCENT

        def draw(_event=None):
            chart.delete("all")
            width = max(chart.winfo_width(), 320)
            label_width = min(260, max(150, width * 0.38))
            plot_width = max(width - label_width - 12, 80)
            for index, row in enumerate(rows):
                comparison = row["comparison"]
                current, unit = row["current"], row["unit"]
                average = comparison.get("average_consumption")
                y = 28 + index * 52
                chart.create_text(
                    0,
                    y + 1,
                    text=row["label"],
                    anchor="w",
                    fill=INK,
                    font=("Segoe UI", 9, "bold"),
                )
                maximum = max(current or 0, average or 0)
                scale = maximum * 1.18 if maximum > 0 else 1
                bar_y = y + 18
                chart.create_line(
                    label_width,
                    bar_y + 7,
                    label_width + plot_width,
                    bar_y + 7,
                    fill="#E4EAED",
                )
                if average is not None:
                    average_x = label_width + plot_width * average / scale
                    chart.create_line(
                        average_x,
                        bar_y - 2,
                        average_x,
                        bar_y + 17,
                        fill="#53646D",
                        dash=(3, 2),
                        width=2,
                    )
                if current is not None:
                    chart.create_rectangle(
                        label_width,
                        bar_y,
                        label_width + plot_width * current / scale,
                        bar_y + 14,
                        fill=bar_color,
                        outline="",
                    )
                change = comparison.get("change_percent")
                value_label = (
                    f"{amount(current)} {unit}"
                    if current is not None
                    else row.get("reason") or "Quantity unavailable"
                )
                if average is not None:
                    value_label += (
                        f"  ·  avg {amount(average)} {unit}"
                        f"  ·  {comparison.get('coverage', 0)}/{comparison_window} months"
                    )
                    if change is not None:
                        value_label += f"  ·  {change:+.1f}%"
                elif comparison.get("reference_provisional_months"):
                    value_label += "  ·  prior average unavailable"
                else:
                    value_label += "  ·  no prior average"
                chart.create_text(
                    label_width,
                    bar_y + 27,
                    text=value_label,
                    anchor="w",
                    fill=MUTED,
                    font=("Segoe UI", 8),
                )
            chart.create_rectangle(
                label_width, 8, label_width + 10, 18, fill=bar_color, outline=""
            )
            chart.create_text(
                label_width + 15,
                13,
                text="Selected report consumption",
                anchor="w",
                fill=MUTED,
                font=("Segoe UI", 8),
            )
            chart.create_line(
                label_width + 190,
                8,
                label_width + 190,
                18,
                fill="#53646D",
                dash=(3, 2),
                width=2,
            )
            chart.create_text(
                label_width + 196,
                13,
                text="Prior average",
                anchor="w",
                fill=MUTED,
                font=("Segoe UI", 8),
            )

        chart.bind("<Configure>", draw)
        draw()

    def change_analysis_month(self, month):
        self.analysis_month = month
        self.show("Monthly Analysis")

    def change_analysis_window(self, window):
        self.analysis_window = window
        self.show("Monthly Analysis")

    def open_month_report(self, report_id):
        report = next((item for item in self.reports if item["id"] == report_id), None)
        if report is None:
            return
        vessel = (
            report.get("vessel") or report["data"].get("vessel") or "Unresolved vessel"
        )
        self.vessel.set(vessel)
        self.report_id = report_id
        self.change_vessel(vessel)
        self.show("Findings")

    def export_monthly(self, export_type):
        analysis = getattr(self, "monthly_analysis", None)
        if analysis is None:
            return
        extension = ".pdf" if export_type == "pdf" else ".xlsx"
        initial_file = f"{analysis['month']}-lub-oil-monthly-analysis{extension}"
        file_types = (
            [("PDF report", "*.pdf")]
            if export_type == "pdf"
            else [("Excel workbook", "*.xlsx")]
        )
        target = filedialog.asksaveasfilename(
            parent=self,
            defaultextension=extension,
            initialfile=initial_file,
            filetypes=file_types,
        )
        if not target:
            return
        try:
            exporter = export_pdf if export_type == "pdf" else export_excel
            exporter(analysis, target)
            self.status.configure(text=f"Monthly analysis exported · {target}")
        except (OSError, ValueError) as error:
            messagebox.showerror("Monthly export failed", str(error), parent=self)

    def refresh(self):
        prior_vessel = self.vessel.get()
        self.reports = self.repo.reports()
        months = sorted({report["month"] for report in self.reports if report["month"]})
        if self.analysis_month not in months:
            self.analysis_month = months[-1] if months else None
        vessels = sorted(
            {
                r["vessel"] or r["data"]["vessel"] or "Unresolved vessel"
                for r in self.reports
            }
        ) or ["No reports"]
        self.vessel.configure(values=vessels)
        self.vessel.set(prior_vessel if prior_vessel in vessels else vessels[0])
        self.change_vessel(self.vessel.get())

    def change_vessel(self, _value):
        vessel = self.vessel.get()
        self.visible_reports = [
            r
            for r in self.reports
            if (r["vessel"] or r["data"]["vessel"] or "Unresolved vessel") == vessel
        ]
        vessel_months = sorted(
            {report["month"] for report in self.visible_reports if report.get("month")}
        )
        if vessel_months and self.analysis_month not in vessel_months:
            self.analysis_month = vessel_months[-1]
        self.report_options = {
            f"{r['month'] or 'Unknown month'}  ·  v{r['report_version']}  ·  {'In use' if r['is_active'] else 'Superseded' if r['confirmed_at'] else 'Not usable'}": r[
                "id"
            ]
            for r in self.visible_reports
        }
        self.report_menu.configure(values=list(self.report_options) or ["No reports"])
        key = next(
            (key for key, rid in self.report_options.items() if rid == self.report_id),
            next(iter(self.report_options), "No reports"),
        )
        self.report_menu.set(key)
        self.change_report(key)

    def change_report(self, key):
        self.report_id = self.report_options.get(key)
        self.current = next(
            (r for r in self.visible_reports if r["id"] == self.report_id), None
        )
        if not self.busy:
            if self.current:
                state = (
                    "Official report in use"
                    if self.current["is_active"]
                    else (
                        "Superseded by a newer import"
                        if self.current["confirmed_at"]
                        else "Not usable · vessel or month could not be identified"
                    )
                )
                self.status.configure(
                    text=f"{self.current.get('month') or 'Month unknown'} · {state}"
                )
            else:
                self.status.configure(
                    text="Import .xlsx reports. Originals are preserved and used for analysis immediately."
                )
        self.update_footer()
        self.show(self.page)

    def show(self, page):
        self.page = page
        tab_pages = {tab_page for _, tab_page in TABS}
        if page in tab_pages:
            self.last_tab = page
        for name, button in self.nav.items():
            active = name == page or (name == "Overview" and page in tab_pages)
            button.configure(
                fg_color=SIDEBAR_ACTIVE if active else "transparent",
                text_color=WHITE if active else SIDEBAR_TEXT,
            )
        for tab_page, (tab, underline) in self.tabs.items():
            tab.configure(text_color=ACCENT if tab_page == page else MUTED)
            underline.configure(fg_color=ACCENT if tab_page == page else "transparent")
        vessel = self.vessel.get()
        fleet_wide = page in ("Fleet", "Register")
        self.title_label.configure(
            text=(
                "Fleet  |  "
                if fleet_wide
                else f"{vessel_title(vessel)}  |  " if vessel != "No reports" else ""
            )
            + "Lube Oil Consumption & Budget"
        )
        for child in self.body.winfo_children():
            child.destroy()
        self.activity_box = None
        if page == "Activity":
            self.render_activity()
        elif page == "Reports":
            self.render_reports()
        elif page == "Monthly Analysis":
            self.render_monthly_analysis()
        elif page == "Overview":
            self.render_overview()
        elif page == "Budget":
            self.render_budget()
        elif page == "Register":
            self.render_register()
        elif page == "Fleet":
            self.render_fleet()
        elif not self.current:
            self.heading(
                "A clearer monthly review.",
                "Import your vessel workbooks to see stock, consumption and anything that needs attention.",
            )
            self.label(
                self.card(),
                "No sample data. Your source reports drive every finding.",
                15,
                MUTED,
            ).pack(padx=24, pady=30)
        else:
            {
                "Findings": self.render_review,
                "Consumption": self.render_consumption,
                "Inventory": self.render_inventory,
                "Renewals": self.render_renewals,
            }[page]()
        self.scroll_router.attach(self.body)

    def change_period(self, value):
        self.period_months = PERIODS[value]  # "YTD" or a rolling number of months
        if self.page in ("Overview", "Renewals", "Fleet"):
            self.show(self.page)

    def update_footer(self):
        imported = [
            r["imported_at"] for r in self.visible_reports if r.get("imported_at")
        ]
        if imported:
            latest = datetime.fromisoformat(max(imported)).astimezone()
            self.import_label.configure(text=f"Latest import: {latest:%d %b %Y, %H:%M}")
        else:
            self.import_label.configure(text="")
        if self.current:
            self.source_button.configure(state="normal", text="Open source workbook")
            findings = [
                i
                for i in self.current["data"]["issues"]
                if not i["code"].startswith(("missing:", "unit:"))
            ]
            self.attention_button.configure(
                text=(
                    f"{len(findings)} item(s) need attention"
                    if findings
                    else "No exceptions in this report"
                ),
                text_color=AMBER if findings else GOOD,
            )
        else:
            self.source_button.configure(state="disabled", text="")
            self.attention_button.configure(text="")

    def panel(self, parent, title, subtitle=None, link=None):
        frame = ctk.CTkFrame(
            parent,
            fg_color=WHITE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        head = ctk.CTkFrame(frame, fg_color="transparent")
        head.pack(fill="x", padx=16, pady=(12, 6))
        self.label(head, title, 15, INK, True).pack(side="left")
        if subtitle:
            self.label(head, "  ·  " + subtitle, 13, MUTED).pack(side="left")
        if link:
            text, command = link
            ctk.CTkButton(
                head,
                text=text + "  ›",
                command=command,
                width=20,
                height=26,
                fg_color="transparent",
                hover_color="#E8EFF7",
                text_color=ACCENT,
                font=ctk.CTkFont(family="Segoe UI", size=12),
            ).pack(side="right")
        return frame

    def legend(self, parent, items):
        for name, color in items:
            row = ctk.CTkFrame(parent, fg_color="transparent")
            row.pack(anchor="w", pady=3)
            ctk.CTkFrame(
                row, width=12, height=12, fg_color=color, corner_radius=3
            ).pack(side="left", padx=(0, 8))
            self.label(row, name, 11, INK).pack(side="left")

    def dashboard_end(self):
        months = sorted(
            {
                r["month"]
                for r in self.visible_reports
                if r.get("month") and r.get("is_active")
            }
        )
        if not months:
            return None
        return (
            self.current["month"]
            if self.current and self.current.get("month") in months
            else months[-1]
        )

    def budget_monthly(self, year):
        """Approved monthly litres per group: the last-resort stock-cover rate (cylinder budget is a total, so not split)."""
        rows = (
            {
                b["oil_category"]: b
                for b in self.repo.budget_basis(self.vessel.get(), year)
            }
            if year
            else {}
        )
        groups = {ME_SYSTEM_OIL: "System oil · ME", AE_SYSTEM_OIL: "System oil · AE"}
        return {
            group: rows[c]["daily_budget_rate"]
            * rows[c]["applicable_days_per_year"]
            / 12
            for c, group in groups.items()
            if c in rows
        }

    def window_months(self, end):
        """Months in the selected period ending at `end`. Year to date runs from 1 January of end's year."""
        return int(end[5:]) if self.period_months == "YTD" else self.period_months

    def dashboard_data(self, minimum_months=1, months=None, end=None):
        end = end or self.dashboard_end()
        if end is None:
            return None
        return dashboard(
            self.reports,
            self.vessel.get(),
            end,
            months or max(self.window_months(end), minimum_months),
            budget_monthly=self.budget_monthly(int(end[:4])),
        )

    def card_budget_data(self, end, detail_months):
        """Year-to-date budget for the cards plus each bar month against its own allowance (its own year's basis)."""
        vessel = self.vessel.get()
        basis, prices = [], []
        for year in sorted({int(end[:4])} | {int(m[:4]) for m in detail_months}):
            try:
                basis += self.repo.budget_basis(vessel, year)
                prices += self.repo.reference_prices(vessel, year)
            except ValueError:
                pass
        return card_budget(self.reports, vessel, end, basis, prices, detail_months)

    def bulk_cards(self, parent, end=None):
        """The four primary cards in the locked order. Bars and L/24h follow the selected period."""
        end = end or self.dashboard_end()
        data = self.dashboard_data(months=self.window_months(end), end=end)
        budget = self.card_budget_data(end, data["months"])
        for grade in data["grades"]:
            grade["budget"] = budget
            # L/24h follows the selected period at all times (hours-weighted; missing months left out, never zero).
            grade["period_rate"] = period_rate(
                self.reports, self.vessel.get(), end, self.period_months, grade["group"]
            )
        grades = sorted(
            data["grades"], key=lambda g: list(GRADE_STYLE).index(g["group"])
        )
        cards = ctk.CTkFrame(parent, fg_color="transparent")
        cards.pack(fill="x")
        for index in range(4):
            cards.grid_columnconfigure(index, weight=1, uniform="grade")
        try:
            registered = self.repo.tanks(self.vessel.get())
        except ValueError:
            registered = []
        for index, grade in enumerate(grades):
            tanks = [
                t
                for t in registered
                if TANK_CATEGORIES.get(t["oil_category"]) == grade["group"]
            ]
            self.bulk_card(cards, grade, tank_fill(grade["closing"], tanks)).grid(
                row=0,
                column=index,
                sticky="nsew",
                padx=(0 if index == 0 else 6, 0 if index == 3 else 6),
            )
        return data

    def render_overview(self):
        data = self.dashboard_data()
        if data is None:
            self.heading(
                "No reports yet",
                "Import the vessels' monthly lube oil sheets from the sidebar to build this dashboard.",
            )
            return
        months = data["months"]
        if self.period_months == "YTD":
            span = month_label(months[0]) + (
                "" if len(months) == 1 else f"–{month_label(months[-1])}"
            )
            period = f"Budget year {months[-1][:4]}  ·  {span}  ·  {data['coverage']} of {len(months)} months reported"
        elif len(months) == 1:
            period = f"Latest month: {month_label(months[0], True)}"
        else:
            period = (
                f"{month_label(months[0], True)} to {month_label(months[-1], True)}  ·  "
                f"{data['coverage']} of {len(months)} monthly reports"
            )
        self.label(
            self.body,
            f"{data['vessel']}  ·  {period}  ·  Card bars and L/24h follow this period; hover over a bar for detail",
            12,
            MUTED,
        ).pack(anchor="w", pady=(0, 10))
        self.bulk_cards(self.body)
        grades = sorted(
            data["grades"], key=lambda g: list(GRADE_STYLE).index(g["group"])
        )

        charts = ctk.CTkFrame(self.body, fg_color="transparent")
        charts.pack(fill="x", pady=(14, 0))
        charts.grid_columnconfigure(0, weight=3, uniform="charts")
        charts.grid_columnconfigure(1, weight=2, uniform="charts")
        bulk = self.panel(charts, "Bulk Oil Consumption", "Monthly litres")
        bulk.grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        inner = ctk.CTkFrame(bulk, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=12, pady=(0, 4))
        series = [
            (
                GRADE_STYLE[g["group"]]["title"],
                GRADE_STYLE[g["group"]]["color"],
                g["used_series"],
            )
            for g in grades
        ]
        chart = tk.Canvas(inner, height=220, bg=WHITE, highlightthickness=0)
        chart.pack(side="left", fill="both", expand=True)
        legend = ctk.CTkFrame(inner, fg_color="transparent")
        legend.pack(side="right", padx=(12, 4))
        self.legend(legend, [(name, color) for name, color, _ in series])
        chart.bind("<Configure>", lambda _e: draw_bars(chart, months, series))
        self.label(
            bulk,
            "System oils: total consumption (routine + change/loss). Cylinder oils: storage withdrawal. A gap is a missing report, not zero.",
            10,
            MUTED,
        ).pack(anchor="w", padx=16, pady=(0, 12))
        self.ae_panel(charts, data, 220).grid(
            row=0, column=1, sticky="nsew", padx=(7, 0)
        )

        self.stock_panel(grades).pack(fill="x", pady=(14, 0))
        if data["support"]:
            self.support_panel(data).pack(fill="x", pady=(14, 8))

    def bulk_card(self, parent, grade, fill=None):
        style = GRADE_STYLE[grade["group"]]
        card = ctk.CTkFrame(
            parent,
            fg_color=WHITE,
            corner_radius=12,
            border_width=1,
            border_color=BORDER,
        )
        ctk.CTkFrame(card, height=4, fg_color=style["color"], corner_radius=2).pack(
            fill="x", padx=12, pady=(7, 0)
        )
        head = ctk.CTkFrame(card, fg_color="transparent")
        head.pack(fill="x", padx=14, pady=(10, 4))
        badge = ctk.CTkFrame(
            head, width=38, height=38, fg_color=style["tint"], corner_radius=10
        )
        badge.pack(side="left")
        badge.pack_propagate(False)
        self.label(badge, style["badge"], 12, style["color"], True).pack(expand=True)
        names = ctk.CTkFrame(head, fg_color="transparent")
        names.pack(side="left", fill="x", expand=True, padx=(10, 0))
        self.label(names, style["title"], 14, style["color"], True).pack(anchor="w")
        grade_text = (
            grade["grade"] if len(grade["grade"]) <= 34 else grade["grade"][:33] + "…"
        )
        self.label(names, grade_text, 11, MUTED).pack(anchor="w")
        stats = ctk.CTkFrame(card, fg_color="transparent")
        stats.pack(fill="x", padx=14, pady=(6, 0))
        latest = grade["details"][-1]["month"] if grade["details"] else None
        for column, (title, value) in enumerate(
            (
                ("Consumed this month", litres(grade["latest_used"])),
                ("Storage ROB", litres(grade["closing"])),
            )
        ):
            stats.grid_columnconfigure(column, weight=1, uniform="stat")
            self.label(stats, title, 10, MUTED).grid(row=0, column=column, sticky="w")
            self.label(stats, value, 18, INK, True).grid(
                row=1, column=column, sticky="w"
            )
        minor = ctk.CTkFrame(card, fg_color="transparent")
        minor.pack(fill="x", padx=14, pady=(6, 0))
        cover = f"{grade['cover']:.1f} mo" if grade["cover"] is not None else "—"
        budget = grade.get("budget")
        category = budget_category(grade["group"])
        row = budget["categories"].get(category) if budget else None
        rate = grade.get("period_rate")
        span = {"YTD": "YTD", 1: None}.get(self.period_months, f"{self.period_months}M")
        # Short heading so it never runs into "YTD used" on narrow cards; "High + Low" goes on the line below.
        rate_title = "L/24h" + (f" · {span}" if span else "")
        rate_value = rate["rate"] if rate else grade["latest_rate"]
        for column, (title, value) in enumerate(
            (
                (rate_title, "—" if rate_value is None else f"{rate_value:,.1f}"),
                ("YTD used", litres(group_ytd_actual(row, grade["group"]))),
                ("Cover", cover),
            )
        ):
            minor.grid_columnconfigure(column, weight=1, uniform="minor")
            self.label(minor, title, 9, MUTED).grid(row=0, column=column, sticky="w")
            self.label(minor, value, 12, INK, True).grid(
                row=1, column=column, sticky="w"
            )
        parts = ["High + Low"] if grade["group"].startswith("Cylinder") else []
        partial = False
        if rate and rate["of"] > 1 and rate["rate"] is not None:
            # Which months the average stands on: a month without rate or hours is left out, not counted as zero.
            parts.append(f"{len(rate['months'])} of {rate['of']} mo")
            if rate["flagged"]:
                parts.append(f"{len(rate['flagged'])} flagged")
            partial = len(rate["months"]) < rate["of"]
        if parts:
            self.label(minor, " · ".join(parts), 8, AMBER if partial else MUTED).grid(
                row=2, column=0, columnspan=2, sticky="w"
            )
        if budget:
            self.card_budget_line(card, budget, row)
            grade = dict(
                grade,
                details=[
                    dict(d, note=self.bar_note(d, budget, category))
                    for d in grade["details"]
                ],
            )
        tank = fill
        tank_text = (
            (
                f"Tank fill {tank['percent']:.0f}% of {tank['usable']:,.0f} L usable"
                + (f" ({tank['tanks']} tanks)" if tank["tanks"] > 1 else "")
            )
            if tank
            else "Tank capacity not registered"
        )
        self.label(card, tank_text, 10, INK if tank else MUTED).pack(
            anchor="w", padx=14, pady=(6, 0)
        )
        foot = ctk.CTkFrame(card, fg_color="transparent")
        foot.pack(fill="x", padx=14, pady=(4, 0))
        fill, ink = COVER_PILL[grade["status"]]
        ctk.CTkLabel(
            foot,
            text=grade["status"],
            fg_color=fill,
            text_color=ink,
            corner_radius=6,
            height=22,
            font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
        ).pack(side="left")
        basis = {
            "6-month normal average": "6M avg",
            "3-month normal average": "3M avg",
            "approved budget rate": "budget rate",
        }.get(grade["cover_basis"], "no rate")
        self.label(
            foot,
            f"  cover basis: {basis}"
            + (f" · {month_label(latest, True)}" if latest else ""),
            9,
            MUTED,
        ).pack(side="left")
        canvas = tk.Canvas(card, height=120, bg=WHITE, highlightthickness=0)
        canvas.pack(fill="x", padx=8, pady=(4, 10))
        canvas.bind(
            "<Configure>",
            lambda _e: draw_card_bars(canvas, grade["details"], style["color"]),
        )
        return card

    def card_budget_line(self, card, budget, row):
        """Year to date (from 1 January) against the allowance: the same figures as the Budget Performance page."""
        months = budget["months"]
        span = month_label(months[0]) + (
            "" if len(months) == 1 else f"–{month_label(months[-1])}"
        )
        box = ctk.CTkFrame(card, fg_color=TABLE_HEAD, corner_radius=8)
        box.pack(fill="x", padx=14, pady=(8, 0))
        top = ctk.CTkFrame(box, fg_color="transparent")
        top.pack(fill="x", padx=10, pady=(6, 0))
        heading = f"Budget {budget['year']} · {span}"
        if row is not None and len(row["covered"]) < len(months):
            heading += f" · {len(row['covered'])} of {len(months)} mo"
        note = None
        if row is None or not row["configured"]:
            text, color = "Budget basis not configured", MUTED
        elif row["adjusted"] is None:
            text, color = "No month reported in this budget year yet", MUTED
        else:
            over = row["technical"] > 0
            pct = row["technical_percent"]
            ctk.CTkLabel(
                top,
                text="—" if pct is None else f"{pct:+.1f}%",
                height=20,
                corner_radius=6,
                fg_color="#FDF1DC" if over else "#E3F4EA",
                text_color=AMBER if over else GOOD,
                font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
            ).pack(side="right")
            text, color = f"{row['actual']:,.0f} L vs {row['adjusted']:,.0f} L", INK
            kind = (
                "hours-adjusted allowance"
                if row["activity_driven"]
                else "allowance, vessel total"
            )
            note = (
                "High + Low BN combined vs "
                if row["category"] == ME_CYLINDER_OIL
                else "Used vs "
            ) + kind
        self.label(top, heading, 9, MUTED).pack(side="left")
        self.label(box, text, 11 if note else 10, color, bool(note)).pack(
            anchor="w", padx=10, pady=(2, 0 if note else 6)
        )
        if note:
            # Fixed wrap sized for the 1280 px minimum window (resize-driven wrapping hangs Tk here).
            self.label(box, note, 9, MUTED, wraplength=170, justify="left").pack(
                anchor="w", padx=10, pady=(0, 6)
            )

    def bar_note(self, detail, budget, category):
        """Hover text: the month against its own allowance; a 12-month trend only when that year has no basis."""
        notes = [detail["note"]] if detail.get("note") else []
        row = budget["monthly"].get(detail["month"], {}).get(category)
        if row and row["configured"] and row["adjusted"] is not None:
            pct = row["technical_percent"]
            hours = ", hours-adjusted" if row["activity_driven"] else ""
            change = "" if pct is None else f" ({pct:+.0f}%)"
            if category == ME_CYLINDER_OIL:
                notes.append(
                    f"High + Low {row['actual']:,.0f} L vs allowance {row['adjusted']:,.0f} L{hours}{change}"
                )
            else:
                notes.append(f"Allowance {row['adjusted']:,.0f} L{hours}{change}")
        elif detail.get("trend") is not None and abs(detail["trend"]) >= 25:
            notes.append(f"{detail['trend']:+.0f}% vs 12-month average")
        return "\n".join(notes) or None

    def ae_panel(self, parent, data, height):
        panel = self.panel(parent, "AE Oil Breakdown", "Monthly litres")
        inner = ctk.CTkFrame(panel, fg_color="transparent")
        inner.pack(fill="both", expand=True, padx=12, pady=(0, 4))
        ae = data["ae"]
        series = [
            ("Change / loss", "#1E5AA8", ae["change_loss"]),
            ("Routine use", "#8DBBEA", ae["operating"]),
        ]
        side = ctk.CTkFrame(inner, fg_color="transparent", width=150)
        side.pack(side="right", padx=(10, 4), fill="y")
        chart = tk.Canvas(inner, height=height, bg=WHITE, highlightthickness=0)
        chart.pack(side="left", fill="both", expand=True)
        self.legend(side, [(name, color) for name, color, _ in reversed(series)])
        box = ctk.CTkFrame(
            side,
            fg_color="#FDF5E6",
            corner_radius=10,
            border_width=1,
            border_color="#F1D9A8",
        )
        box.pack(fill="x", pady=(12, 0))
        self.label(box, "Sump renewals", 11, INK, True).pack(
            anchor="w", padx=12, pady=(10, 0)
        )
        self.label(box, str(ae["confirmed"]), 24, INK, True).pack(anchor="w", padx=12)
        self.label(box, "confirmed", 10, MUTED).pack(anchor="w", padx=12)
        self.label(box, f"+ {ae['probable']} indicated", 10, AMBER).pack(
            anchor="w", padx=12, pady=(4, 10)
        )
        chart.bind(
            "<Configure>",
            lambda _e: draw_bars(chart, data["months"], series, stacked=True),
        )
        self.label(
            panel,
            "Change/loss is reported separately from routine use and can include sump renewals. "
            '"Indicated" = a change date or remark without both pieces of evidence.',
            10,
            MUTED,
            wraplength=520,
            justify="left",
        ).pack(anchor="w", padx=16, pady=(0, 12))
        return panel

    def stock_panel(self, grades):
        panel = self.panel(
            self.body,
            "Bulk Grade Stock & Cover",
            link=("View inventory", lambda: self.show("Inventory")),
        )
        table = ctk.CTkFrame(panel, fg_color="transparent")
        table.pack(fill="x", padx=16, pady=(0, 6))
        headings = (
            "Grade",
            "Opening (L)",
            "Received (L)",
            "Consumption (L)",
            "Closing (L)",
            "Cover (months)",
            "Status",
        )
        for column, heading in enumerate(headings):
            table.grid_columnconfigure(
                column,
                weight=4 if column == 0 else 1,
                uniform="stock" if column else None,
            )
            cell = ctk.CTkFrame(table, fg_color="#F4F7FA", corner_radius=0, height=34)
            cell.grid(row=0, column=column, sticky="nsew")
            self.label(cell, heading, 11, INK, True).pack(
                anchor="w" if column == 0 else "e", padx=10, pady=7
            )
        pills = COVER_PILL
        for row, grade in enumerate(grades, start=1):
            style = GRADE_STYLE[grade["group"]]
            values = (
                f"{style['title']}  ({grade['grade']})",
                amount(grade["opening"], 0),
                amount(grade["received"], 0),
                # Consumption as on the cards (system oils: routine + change/loss; cylinder: storage withdrawal),
                # not the storage issue: for system oils part of what leaves storage tops up the sump.
                amount(grade["consumption"], 0),
                amount(grade["closing"], 0),
                f"{grade['cover']:.1f}" if grade["cover"] is not None else "—",
            )
            for column, value in enumerate(values):
                self.label(
                    table,
                    value,
                    12,
                    INK,
                    column == 0,
                    wraplength=420 if column == 0 else 0,
                ).grid(
                    row=row,
                    column=column,
                    sticky="w" if column == 0 else "e",
                    padx=10,
                    pady=7,
                )
            fill, ink = pills[grade["status"]]
            ctk.CTkLabel(
                table,
                text=grade["status"],
                fg_color=fill,
                text_color=ink,
                corner_radius=6,
                width=96,
                height=24,
                font=ctk.CTkFont(family="Segoe UI", size=11, weight="bold"),
            ).grid(row=row, column=6, padx=10, pady=7)
            ctk.CTkFrame(table, height=1, fg_color=GRID).grid(
                row=row, column=0, columnspan=7, sticky="sew"
            )
        self.label(
            panel,
            "Opening = start of the first month in the period. Consumption = total for the period, as on the cards "
            "(system oils: routine + change/loss; cylinder oils: storage withdrawal). For system oils, oil issued from "
            "storage can differ from consumption by the change in sump quantity, so Opening + Received − Consumption "
            "need not equal Closing; the storage book is on the Inventory page. "
            "Cover = storage ROB ÷ normal monthly consumption (6-month average, else 3-month, else approved budget rate; "
            "confirmed AE sump renewals excluded). Provisional thresholds, not company policy: "
            f"Critical < {COVER_THRESHOLDS['Critical']}, Low < {COVER_THRESHOLDS['Low']}, "
            f"Planning < {COVER_THRESHOLDS['Planning']} months.",
            10,
            MUTED,
            wraplength=1000,
            justify="left",
        ).pack(anchor="w", padx=16, pady=(4, 12))
        return panel

    def support_panel(self, data):
        panel = self.panel(
            self.body,
            "Supporting Lubricants",
            "Grouped view",
            link=("View all in Consumption", lambda: self.show("Consumption")),
        )
        grid = ctk.CTkFrame(panel, fg_color="transparent")
        grid.pack(fill="x", padx=12, pady=(0, 12))
        per_row = 5
        for column in range(per_row):
            grid.grid_columnconfigure(column, weight=1, uniform="support")
        for index, group in enumerate(data["support"]):
            badge_text, color, tint = GROUP_STYLE[group["group"]]
            card = ctk.CTkFrame(
                grid,
                fg_color=WHITE,
                corner_radius=10,
                border_width=1,
                border_color=BORDER,
            )
            card.grid(
                row=index // per_row,
                column=index % per_row,
                sticky="nsew",
                padx=4,
                pady=4,
            )
            head = ctk.CTkFrame(card, fg_color="transparent")
            head.pack(fill="x", padx=12, pady=(12, 0))
            badge = ctk.CTkFrame(
                head, width=32, height=32, fg_color=tint, corner_radius=8
            )
            badge.pack(side="left")
            badge.pack_propagate(False)
            self.label(badge, badge_text, 10, color, True).pack(expand=True)
            names = ctk.CTkFrame(head, fg_color="transparent")
            names.pack(side="left", padx=(8, 0), fill="x", expand=True)
            self.label(names, group["group"], 13, INK, True).pack(anchor="w")
            self.label(names, f"{len(group['headings'])} heading(s)", 10, MUTED).pack(
                anchor="w"
            )
            self.label(
                card, litres(group["total"], group["unit"] or ""), 18, INK, True
            ).pack(anchor="w", padx=12, pady=(8, 0))
            canvas = tk.Canvas(card, height=54, bg=WHITE, highlightthickness=0)
            canvas.pack(fill="x", padx=10, pady=(8, 0))
            canvas.bind(
                "<Configure>",
                lambda _e, c=canvas, s=group["series"], k=color, t=tint: draw_area(
                    c, data["months"], s, k, t, axis=False
                ),
            )
            note = f"{group['months']}/{len(data['months'])} months complete" + (
                " · unit not stated on sheet" if group["unit"] is None else ""
            )
            self.label(card, note, 9, MUTED).pack(anchor="w", padx=12, pady=(2, 0))
            ctk.CTkButton(
                card,
                text="View trend  ›",
                command=lambda g=group["group"]: self.open_group_trend(g),
                width=20,
                height=24,
                fg_color="transparent",
                hover_color="#E8EFF7",
                text_color=ACCENT,
                font=ctk.CTkFont(family="Segoe UI", size=11),
            ).pack(anchor="w", padx=6, pady=(0, 8))
        self.label(
            panel,
            "Group totals are storage withdrawals over the period; a month is counted only when every heading "
            "in the group is reported. Grease is never added to litres.",
            10,
            MUTED,
        ).pack(anchor="w", padx=16, pady=(0, 12))
        return panel

    def open_group_trend(self, group):
        self.consumption_grade = f"{group} · all headings"
        self.consumption_period = "12M"
        self.show("Consumption")

    def render_renewals(self):
        data = self.dashboard_data(minimum_months=12)
        self.heading(
            "AE sump renewals",
            "Auxiliary-engine system oil: routine operating use, reported change/loss, and the oil-change evidence in each sheet.",
        )
        if data is None:
            return
        self.ae_panel(self.body, data, 260).pack(fill="x")
        report = data["latest"]
        engines = [
            e
            for e in report["data"].get("engines", [])
            if e.get("engine", "").startswith("AE")
        ]
        end = datetime.strptime(report["month"] + "-01", "%Y-%m-%d")
        rows = []
        for engine in engines:
            changed = engine.get("last_change")
            age = None
            if changed:
                when = datetime.fromisoformat(changed)
                age = (end.year - when.year) * 12 + end.month - when.month
            rows.append(
                (
                    engine["engine"],
                    amount(engine.get("hours")),
                    amount(engine.get("rate"), 2),
                    changed or "Not stated",
                    "—" if age is None else str(age),
                )
            )
        ctk.CTkFrame(self.body, height=14, fg_color="transparent").pack()
        self.table(
            self.section("Auxiliary Engines", report["month"]),
            [
                "Engine",
                "Running hours",
                "Reported L/24h",
                "Last oil change",
                "Months since change",
            ],
            rows,
            [120, 150, 120, 170, 170],
        )
        events = data["ae"]["events"]
        evidence = self.section("Oil-Change Evidence", "in period")
        if events:
            self.table(
                evidence,
                ["Engine", "Change date", "Report month", "Evidence"],
                [
                    (
                        e["engine"],
                        e.get("date") or "Not stated",
                        e["month"],
                        (
                            "Confirmed: renewal remark and change date"
                            if e["event_type"] == "CONFIRMED_RENEWAL"
                            else "Indicated: change date or remark only"
                        ),
                    )
                    for e in events
                ],
                [120, 150, 150, 420],
            )
        else:
            self.label(
                evidence, "No AE oil changes are recorded in this period.", 13, MUTED
            ).pack(anchor="w", padx=16, pady=(0, 16))

    def render_review(self):
        r, d = self.current, self.current["data"]
        self.heading(
            "Exceptions",
            "What this month's sheet shows: stock differences, reporting inconsistencies and the source cells behind them.",
        )
        significant = [
            i for i in d["issues"] if not i["code"].startswith(("missing:", "unit:"))
        ]
        priorities = {
            "actual": 0,
            "hours": 1,
            "renewal": 2,
            "system_balance": 3,
            "ae_reconciliation": 4,
        }
        significant.sort(
            key=lambda i: (
                0 if i["severity"] == "FAIL" else 1,
                priorities.get(i["code"].split(":")[0], 8),
            )
        )
        reviewed = {n["issue_code"] for n in self.repo.notes(r["id"])}
        active = [report for report in self.visible_reports if report["is_active"]]
        self.stat_tiles(
            (
                ("Report month", d["month"] or "Unknown", ACCENT),
                (
                    "Priority findings",
                    str(len(significant)),
                    AMBER if significant else GOOD,
                ),
                ("Months on record", str(len(active)), ACCENT),
                (
                    "Validation",
                    r["validation_status"],
                    (
                        RED
                        if r["validation_status"] == "FAIL"
                        else AMBER if r["validation_status"] == "WARNING" else GOOD
                    ),
                ),
            )
        )
        brief_data = decision_brief(r)
        brief = self.section("Monthly Brief")
        self.pill(
            brief, brief_data["source_state"], "warn" if not r["is_active"] else "good"
        ).pack(anchor="w", padx=16)
        self.label(brief, brief_data["headline"], 17, bold=True, wraplength=1000).pack(
            anchor="w", padx=16, pady=(10, 4)
        )
        self.label(
            brief, brief_data["rationale"], 12, MUTED, wraplength=1000, justify="left"
        ).pack(anchor="w", padx=16)
        for fact in brief_data["facts"]:
            self.label(brief, "•  " + fact, 12, INK, True, wraplength=1000).pack(
                anchor="w", padx=16, pady=(6, 0)
            )
        self.label(brief, "NEXT ACTION", 10, MUTED, True).pack(
            anchor="w", padx=16, pady=(12, 2)
        )
        self.label(
            brief, brief_data["action"], 12, INK, wraplength=1000, justify="left"
        ).pack(anchor="w", padx=16)
        self.label(brief, brief_data["boundary"], 10, MUTED, wraplength=1000).pack(
            anchor="w", padx=16, pady=(10, 14)
        )

        findings = self.section(
            "Priority Findings", f"{len(significant)} in this report"
        )
        if not significant:
            self.label(
                findings, "No priority exceptions detected in this report.", 13, MUTED
            ).pack(anchor="w", padx=16, pady=(0, 16))
        for index, issue in enumerate(significant):
            row = ctk.CTkFrame(findings, fg_color="transparent")
            row.pack(fill="x", padx=16, pady=(0, 2))
            if index:
                ctk.CTkFrame(row, height=1, fg_color=GRID).pack(fill="x", pady=(0, 10))
            line = ctk.CTkFrame(row, fg_color="transparent")
            line.pack(fill="x")
            self.pill(
                line,
                "FAIL" if issue["severity"] == "FAIL" else "WARNING",
                "bad" if issue["severity"] == "FAIL" else "warn",
            ).pack(side="left", anchor="n", padx=(0, 12))
            ctk.CTkButton(
                line,
                text="View evidence  ›",
                command=lambda item=issue: self.evidence(item),
                width=20,
                height=26,
                fg_color="transparent",
                hover_color=ACCENT_TINT,
                text_color=ACCENT,
                font=ctk.CTkFont(family="Segoe UI", size=12),
            ).pack(side="right", anchor="n")
            text = ctk.CTkFrame(line, fg_color="transparent")
            text.pack(side="left", fill="x", expand=True)
            title = issue["title"] + (
                "  ·  note added" if issue["code"] in reviewed else ""
            )
            self.label(text, title, 13, INK, True, wraplength=820).pack(anchor="w")
            self.label(
                text, issue["detail"], 12, MUTED, wraplength=820, justify="left"
            ).pack(anchor="w", pady=(2, 10))
        ctk.CTkFrame(findings, height=4, fg_color="transparent").pack()

        warnings = len(d["issues"]) - len(significant)
        completeness = self.section(
            "Completeness & Unit Warnings",
            f"{warnings} in this report",
            link=("All source evidence", lambda: self.evidence()),
        )
        self.label(
            completeness,
            "Blank cells and unit notes. Blank values are shown as unavailable and never treated as zero.",
            12,
            MUTED,
        ).pack(anchor="w", padx=16, pady=(0, 14))
        gaps = continuity(active)
        if gaps:
            stock = self.section(
                "Stock Continuity", "opening stock vs previous month's closing"
            )
            for issue in gaps:
                self.label(
                    stock,
                    f"{issue['title']}  —  {issue['detail']}",
                    12,
                    AMBER,
                    wraplength=1000,
                    justify="left",
                ).pack(anchor="w", padx=16, pady=(0, 6))
            ctk.CTkFrame(stock, height=8, fg_color="transparent").pack()

    def stat_tiles(self, items):
        row = ctk.CTkFrame(self.body, fg_color="transparent")
        row.pack(fill="x", pady=(0, 14))
        for index, (title, value, color) in enumerate(items):
            row.grid_columnconfigure(index, weight=1, uniform="tiles")
            tile = ctk.CTkFrame(
                row,
                fg_color=WHITE,
                corner_radius=12,
                border_width=1,
                border_color=BORDER,
            )
            tile.grid(
                row=0,
                column=index,
                sticky="nsew",
                padx=(0 if index == 0 else 6, 0 if index == len(items) - 1 else 6),
            )
            ctk.CTkFrame(tile, height=4, fg_color=color, corner_radius=2).pack(
                fill="x", padx=12, pady=(7, 0)
            )
            self.label(tile, title, 11, MUTED).pack(anchor="w", padx=16, pady=(10, 0))
            self.label(tile, value, 22, INK, True).pack(
                anchor="w", padx=16, pady=(0, 14)
            )
        return row

    def pill(self, parent, text, tone="good"):
        fill, ink = {
            "good": ("#DDF3E6", GOOD),
            "warn": ("#FCEFD3", "#8A5A00"),
            "bad": ("#FBE3E1", RED),
            "neutral": ("#ECEFF2", MUTED),
        }[tone]
        return ctk.CTkLabel(
            parent,
            text=text,
            fg_color=fill,
            text_color=ink,
            corner_radius=6,
            height=24,
            font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
        )

    def table(self, parent, headings, rows, widths=None, on_select=None):
        outer = ctk.CTkFrame(parent, fg_color=WHITE)
        outer.pack(fill="x", padx=16, pady=(2, 14))
        style = ttk.Style(self)
        if style.theme_use() != "clam":
            style.theme_use("clam")
        style.configure(
            "Lub.Treeview",
            font=("Segoe UI", 11),
            rowheight=32,
            background=WHITE,
            foreground=INK,
            fieldbackground=WHITE,
            borderwidth=0,
            relief="flat",
        )
        style.configure(
            "Lub.Treeview.Heading",
            font=("Segoe UI", 10, "bold"),
            background=TABLE_HEAD,
            foreground=INK,
            borderwidth=0,
            relief="flat",
            padding=(8, 7),
        )
        style.map(
            "Lub.Treeview",
            background=[("selected", ACCENT_TINT)],
            foreground=[("selected", INK)],
        )
        style.map("Lub.Treeview.Heading", background=[("active", "#E9EEF4")])
        style.layout("Lub.Treeview", [("Lub.Treeview.treearea", {"sticky": "nswe"})])
        columns = [str(i) for i in range(len(headings))]
        tree = ttk.Treeview(
            outer,
            columns=columns,
            show="headings",
            height=min(max(len(rows), 2), 14),
            style="Lub.Treeview",
        )
        tree.tag_configure("stripe", background="#FAFBFD")
        widths = widths or [130] * len(headings)

        def numeric(value):
            text = str(value).replace(",", "").replace("%", "").replace("+", "").strip()
            if text in ("", "—", "-"):
                return None
            try:
                float(text)
                return True
            except ValueError:
                return False

        for index, name in enumerate(headings):
            kinds = [numeric(row[index]) for row in rows if index < len(row)]
            # Numbers align right; text columns (grades, states, filenames) align left.
            anchor = "e" if index and True in kinds and False not in kinds else "w"
            tree.heading(str(index), text=name, anchor=anchor)
            tree.column(str(index), width=widths[index], minwidth=90, anchor=anchor)
        for index, row in enumerate(rows):
            tree.insert(
                "",
                "end",
                iid=str(index),
                values=row,
                tags=("stripe",) if index % 2 else (),
            )
        outer.grid_columnconfigure(0, weight=1)
        tree.grid(row=0, column=0, sticky="ew")
        if len(rows) > 14:
            yscroll = ttk.Scrollbar(outer, orient="vertical", command=tree.yview)
            tree.configure(yscrollcommand=yscroll.set)
            yscroll.grid(row=0, column=1, sticky="ns")
        if sum(widths) > 1000:
            xscroll = ttk.Scrollbar(outer, orient="horizontal", command=tree.xview)
            tree.configure(xscrollcommand=xscroll.set)
            xscroll.grid(row=1, column=0, sticky="ew")
        if on_select:
            tree.bind(
                "<<TreeviewSelect>>",
                lambda _: (
                    on_select(int(tree.selection()[0])) if tree.selection() else None
                ),
            )
        return tree

    def render_inventory(self):
        self.heading(
            "Stock inventory",
            f"{self.current['month']} · book quantities and vessel-stated actual stock, kept separate.",
        )
        oils = sorted(
            self.current["data"]["inventory"],
            key=lambda o: GROUP_ORDER.index(oil_group(o.get("category"))),
        )

        def difference(oil):
            if oil["closing"] is None or oil["actual_rob"] is None:
                return None
            return oil["closing"] - oil["actual_rob"]

        storage = self.section(
            "Storage Stock by Grade", "select a row to see its source cells"
        )
        self.table(
            storage,
            [
                "Group",
                "Oil grade",
                "Unit",
                "Opening",
                "Receipts",
                "Withdrawn",
                "Book closing",
                "Stated actual",
                "Difference",
            ],
            [
                (
                    oil_group(o.get("category")),
                    o["grade"] or "Unknown",
                    o["unit"] or "n/s",
                    amount(o["opening"]),
                    amount(o["receipts"]),
                    amount(o["withdrawal"]),
                    amount(o["closing"]),
                    amount(o["actual_rob"]),
                    amount(difference(o)),
                )
                for o in oils
            ],
            [150, 230, 60, 90, 90, 90, 100, 100, 90],
            lambda index: self.evidence(
                dict(
                    title=oils[index]["grade"],
                    fields=[
                        k
                        for k in self.current["data"]["evidence"]
                        if k.startswith(f"oil.{oils[index]['id']}.")
                        or k.startswith("remarks.")
                    ],
                    detail="Source cells for this grade; check units and physical stock before using it for purchasing.",
                    code="inventory:" + oils[index]["id"],
                )
            ),
        )
        self.label(
            storage,
            'A dash means unavailable, not zero. "n/s" = unit not stated on the sheet.',
            10,
            MUTED,
        ).pack(anchor="w", padx=16, pady=(0, 12))
        self.table(
            self.section("System Oil Movement", "oil in engine systems"),
            [
                "System oil",
                "Opening in system",
                "Replenishment",
                "Closing in system",
                "Operating",
                "Change / loss",
                "All-in",
            ],
            [
                (
                    o["category"],
                    *[
                        amount(o[k])
                        for k in (
                            "system_opening",
                            "replenishment",
                            "system_closing",
                            "operating",
                            "change_loss",
                            "all_in",
                        )
                    ],
                )
                for o in oils
                if o["system_opening"] is not None
            ],
            [180, 150, 140, 150, 120, 130, 110],
        )

    def render_consumption(self):
        report = self.current
        data = report["data"]
        vessel = report.get("vessel") or data.get("vessel") or "Unresolved vessel"
        month = report.get("month")
        engines = data.get("engines", [])
        self.heading(
            "Bulk oil consumption by grade",
            f"{vessel} · {month or 'Reporting month unresolved'}. Monthly litres for each oil grade, compared with this "
            "vessel's recent reports. A trend is a signal to look closer, not an explanation of cause.",
        )

        pending = not report.get("is_active") and not report.get("confirmed_at")
        if pending:
            self.banner(
                "NOT USABLE — the vessel or reporting month could not be identified; excluded from history.",
                "warn",
            )
        elif report.get("is_active"):
            self.banner(
                "OFFICIAL REPORT — compared with this vessel's earlier reports."
            )
        else:
            self.banner(
                "SUPERSEDED — a newer sheet for this month is in use; shown for reference only.",
                "neutral",
            )

        if not month:
            self.banner(
                "The workbook reporting month could not be resolved. Grade quantities are shown for source review, "
                "but no calendar trend or historical comparison is calculated.",
                "warn",
            )
            rows = []
            for oil in data.get("inventory", []):
                if oil.get("unit") != "L" or not oil.get("grade"):
                    continue
                field = (
                    "operating"
                    if norm(oil.get("category")) in ("SYSTEM OIL M E", "SYSTEM OIL A E")
                    else "withdrawal"
                )
                rows.append(
                    (
                        oil.get("category"),
                        oil["grade"],
                        (
                            "System operating"
                            if field == "operating"
                            else "Storage withdrawal"
                        ),
                        amount(oil.get(field)),
                        amount(oil.get("change_loss")),
                    )
                )
            if rows:
                self.table(
                    self.section("Grade quantities", "this report"),
                    ["Oil category", "Grade", "Measure", "Monthly (L)", "Change/loss (L)"],
                    rows,
                    [190, 220, 180, 130, 140],
                )
            return

        grade_analysis = monthly_analysis(
            self.visible_reports,
            month,
            windows=(3, 6),
        )
        vessel_analysis = next(
            (item for item in grade_analysis["vessels"] if item["vessel"] == vessel),
            None,
        )
        analysis_report = vessel_analysis.get("report") if vessel_analysis else None
        comparison_is_aligned = analysis_report is not None and analysis_report.get(
            "id"
        ) == report.get("id")
        if not comparison_is_aligned:
            self.banner(
                "A grade trend is withheld because this version is not the one in use for this vessel and month. "
                "Select the version in use to compare.",
                "warn",
            )

        oils = vessel_analysis.get("bulk_oils", []) if comparison_is_aligned else []
        groups = vessel_analysis.get("oil_groups", []) if comparison_is_aligned else []
        primary_oils = [oil for oil in oils if oil["primary"]]
        # Every non-primary heading, including grease reported without a litre unit.
        other_oils = [
            dict(
                oil,
                group=oil_group(oil.get("category")),
                monthly_consumption=oil.get("withdrawal"),
            )
            for oil in data.get("inventory", [])
            if comparison_is_aligned
            and oil_group(oil.get("category")) not in PRIMARY_GROUPS
        ]
        other_oils.sort(key=lambda oil: GROUP_ORDER.index(oil["group"]))
        # Primary grades trend per running hour; other oils have no hour basis and trend per month.
        choices = {
            f"{oil['group']} · {oil['grade']}": ("rate", oil) for oil in primary_oils
        }
        for group in groups:
            choices[f"{group['group']} · all headings"] = ("group", group["group"])
            for oil in other_oils:
                if oil["group"] == group["group"]:
                    name = f"{oil['group']} · {' '.join(str(oil['category']).split())} · {oil.get('grade') or 'grade not stated'}"
                    choices[name] = ("heading", oil)
        if not choices:
            self.banner(
                "No grade-level litre consumption is available in this report. Check the source workbook "
                "and its unit or grade mapping.",
                "neutral",
            )
        else:
            history_card = self.section("Consumption trend", "selected grade or group")
            self.label(
                history_card,
                "Primary bulk grades: operating-day consumption (L/day) = monthly litres / matching running hours x 24. "
                "System oils use operating consumption; cylinder oils use grade withdrawal. "
                "Other oil groups have no running-hour basis, so they trend as litres withdrawn per month. "
                "Change/loss remains separate.",
                12,
                MUTED,
                wraplength=880,
                justify="left",
            ).pack(anchor="w", padx=20, pady=(0, 12))
            controls = ctk.CTkFrame(history_card, fg_color="transparent")
            controls.pack(fill="x", padx=20, pady=(0, 10))
            grade_names = list(choices)
            oil_by_name = choices
            grade_menu = ctk.CTkOptionMenu(
                controls,
                values=grade_names,
                width=420,
                fg_color=WHITE,
                button_color=ACCENT,
                button_hover_color=ACCENT_HOVER,
                text_color=INK,
            )
            grade_menu.set(grade_names[0])
            if getattr(self, "consumption_grade", None) in oil_by_name:
                grade_menu.set(self.consumption_grade)
            grade_menu.pack(side="left", padx=(0, 10))
            window_menu = ctk.CTkOptionMenu(
                controls,
                values=["1M", "3M", "6M", "12M", "Custom"],
                width=130,
                fg_color=WHITE,
                button_color=ACCENT,
                button_hover_color=ACCENT_HOVER,
                text_color=INK,
            )
            window_menu.set(getattr(self, "consumption_period", "3M"))
            window_menu.pack(side="left")
            custom_dates = ctk.CTkFrame(history_card, fg_color="transparent")
            first_default = datetime.strptime(month + "-01", "%Y-%m-%d").strftime(
                "%d-%b-%Y"
            )
            start_value = tk.StringVar(
                value=getattr(self, "consumption_start", first_default)
            )
            end_value = tk.StringVar(
                value=getattr(self, "consumption_end", first_default)
            )
            for title, variable in (("From", start_value), ("To", end_value)):
                self.label(custom_dates, title, 12, MUTED).pack(
                    side="left", padx=(0, 6)
                )
                entry = ctk.CTkEntry(custom_dates, textvariable=variable, width=135)
                entry.pack(side="left", padx=(0, 6))
                self.button(
                    custom_dates,
                    "Calendar",
                    lambda v=variable, t=title: DatePicker(
                        self, t + " date", v.get(), v.set
                    ),
                    secondary=True,
                    width=90,
                ).pack(side="left", padx=(0, 12))
                entry.bind("<Return>", lambda _: render_grade_history())
            self.button(
                custom_dates,
                "Apply",
                lambda: render_grade_history(),
                secondary=True,
                width=80,
            ).pack(side="left")
            result_frame = ctk.CTkFrame(
                history_card,
                fg_color="#F6F9FA",
                corner_radius=10,
            )
            result_frame.pack(fill="x", padx=20, pady=(0, 16))

            def render_grade_history(_value=None):
                preset = window_menu.get()
                self.consumption_period = preset
                if preset == "Custom":
                    custom_dates.pack(
                        fill="x", padx=20, pady=(0, 12), before=result_frame
                    )
                else:
                    custom_dates.pack_forget()
                try:
                    if preset == "Custom":
                        first, last = parse_range(start_value.get(), end_value.get())
                        start, end = consumption_trend_range(
                            month,
                            preset,
                            first.date().isoformat(),
                            last.date().isoformat(),
                        )
                        self.consumption_start, self.consumption_end = (
                            start_value.get(),
                            end_value.get(),
                        )
                    else:
                        start, end = consumption_trend_range(month, preset)
                except ValueError as error:
                    messagebox.showerror("Invalid trend dates", str(error), parent=self)
                    return
                for child in result_frame.winfo_children():
                    child.destroy()
                kind, target = oil_by_name[grade_menu.get()]
                self.consumption_grade = grade_menu.get()
                if kind == "rate":
                    comparison = grade_daily_trend(
                        self.visible_reports, target, report, start, end
                    )
                    unit = "L/day"
                    series_color = GRADE_STYLE.get(target["group"], {}).get(
                        "color", ACCENT
                    )
                else:
                    group = target if kind == "group" else target["group"]
                    series_color = GROUP_STYLE.get(group, ("", ACCENT, ""))[1]
                    comparison = group_monthly_trend(
                        self.visible_reports,
                        report,
                        start,
                        end,
                        group=group if kind == "group" else None,
                        category=target["category"] if kind == "heading" else None,
                    )
                    unit = f"{group_unit(group) or 'qty'}/month"
                monthly = kind != "rate"
                window = comparison["months"]
                summary = ctk.CTkFrame(result_frame, fg_color="transparent")
                summary.pack(fill="x", padx=8, pady=(10, 4))

                def summary_item(title, value, detail, color=INK):
                    tile = ctk.CTkFrame(
                        summary,
                        fg_color=WHITE,
                        corner_radius=9,
                    )
                    tile.pack(side="left", expand=True, fill="both", padx=5)
                    self.label(tile, title.upper(), 10, MUTED, True).pack(
                        anchor="w", padx=12, pady=(10, 3)
                    )
                    self.label(tile, value, 20, color, True).pack(
                        anchor="w", padx=12, pady=(0, 2)
                    )
                    self.label(
                        tile,
                        detail,
                        11,
                        MUTED,
                        wraplength=245,
                        justify="left",
                    ).pack(anchor="w", padx=12, pady=(0, 10))

                current = comparison["current"]["value"]
                average = comparison["average_consumption"]
                average_detail = (
                    f"{comparison['coverage']}/{window} comparable months"
                    if comparison["coverage"]
                    else (
                        "No prior months in this range"
                        if not window
                        else "No comparable history"
                    )
                )
                if comparison["change_percent"] is not None:
                    average_detail += f" · this report {comparison['change_percent']:+.1f}% vs baseline"
                current_point = comparison["current"]
                if current is None:
                    current_detail = (
                        current_point["reason"]
                        or "No valid matching quantity is available."
                    )
                elif monthly:
                    current_detail = (
                        "Reported storage withdrawal for the reporting month"
                    )
                else:
                    current_detail = (
                        f"{amount(current_point['quantity'])} L / {amount(current_point['hours'])} h x 24\n"
                        f"{current_point['hours_basis']}"
                    )
                if report.get("validation_status") == "FAIL":
                    current_detail += (
                        " · validation failed; source value excluded from trend"
                    )
                summary_item(
                    "This report",
                    (
                        f"{amount(current)} {unit}"
                        if current is not None
                        else "Unavailable"
                    ),
                    current_detail,
                    (
                        RED
                        if report.get("validation_status") == "FAIL"
                        else AMBER if pending else INK
                    ),
                )
                summary_item(
                    "Prior average",
                    (
                        f"{amount(average)} {unit}"
                        if average is not None
                        else "No baseline"
                    ),
                    average_detail,
                )
                reference = comparison["reference_average_consumption"]
                if comparison["reference_provisional_months"]:
                    reference_detail = (
                        f"{comparison['reference_coverage']}/{window} comparable months · "
                        f"{comparison['reference_provisional_months']} pending"
                    )
                    if comparison["reference_change_percent"] is not None:
                        reference_detail += f" · this report {comparison['reference_change_percent']:+.1f}% vs reference"
                    summary_item(
                        "Preliminary reference · verify",
                        (
                            f"{amount(reference)} {unit}"
                            if reference is not None
                            else "Incomplete"
                        ),
                        reference_detail,
                        AMBER,
                    )

                points = comparison["history"]
                chart = tk.Canvas(
                    result_frame,
                    height=290,
                    bg="#F6F9FA",
                    highlightthickness=0,
                    borderwidth=0,
                )
                chart.pack(fill="x", padx=14, pady=(4, 0))

                def draw_chart(_event=None):
                    chart.delete("all")
                    width = max(chart.winfo_width(), 520)
                    height = 290
                    left, right, top, bottom = 64, 18, 32, 66
                    chart.create_text(
                        left,
                        12,
                        text=unit,
                        anchor="w",
                        fill=MUTED,
                        font=("Segoe UI", 10, "bold"),
                    )
                    plot_width = width - left - right
                    plot_height = height - top - bottom
                    values = [
                        point["value"] for point in points if point["value"] is not None
                    ]
                    if comparison["average_consumption"] is not None:
                        values.append(comparison["average_consumption"])
                    maximum = max(values, default=0)
                    scale_max = maximum * 1.15 if maximum > 0 else 1

                    for tick in range(5):
                        value = scale_max * tick / 4
                        y = top + plot_height * (1 - tick / 4)
                        chart.create_line(
                            left,
                            y,
                            width - right,
                            y,
                            fill="#DCE5E8",
                            width=1,
                        )
                        chart.create_text(
                            left - 10,
                            y,
                            text=f"{value:,.1f}",
                            anchor="e",
                            fill=MUTED,
                            font=("Segoe UI", 9),
                        )
                    if comparison["average_consumption"] is not None:
                        y = top + plot_height * (
                            1 - comparison["average_consumption"] / scale_max
                        )
                        chart.create_line(
                            left,
                            y,
                            width - right,
                            y,
                            fill="#53646D",
                            dash=(5, 4),
                            width=2,
                        )
                    slot = plot_width / max(len(points), 1)
                    bar_width = min(54, slot * 0.56)
                    for index, point in enumerate(points):
                        center = left + slot * (index + 0.5)
                        value = point["value"]
                        if value is not None:
                            y = top + plot_height * (1 - value / scale_max)
                            color = (
                                AMBER
                                if point["state"] == "provisional"
                                else (
                                    MUTED
                                    if point["state"] == "superseded"
                                    else series_color
                                )
                            )
                            chart.create_rectangle(
                                center - bar_width / 2,
                                y,
                                center + bar_width / 2,
                                top + plot_height,
                                fill=color,
                                outline="",
                            )
                            chart.create_text(
                                center,
                                y - 8,
                                text=f"{value:,.1f}",
                                anchor="s",
                                fill=INK,
                                font=("Segoe UI", 9, "bold"),
                            )
                        else:
                            chart.create_text(
                                center,
                                top + plot_height - 8,
                                text="—",
                                fill=MUTED,
                                font=("Segoe UI", 10),
                            )
                        if (
                            index % max(1, (len(points) + 11) // 12) == 0
                            or index == len(points) - 1
                        ):
                            chart.create_text(
                                center,
                                top + plot_height + 17,
                                text=point["month"],
                                fill=MUTED,
                                font=("Segoe UI", 8),
                            )
                        if value is None:
                            state_labels = {
                                "missing": "No report",
                                "ambiguous": "Ambiguous",
                                "invalid": "Invalid report",
                                "grade_missing": "Grade absent",
                                "quantity_missing": "No quantity",
                                "hours_unavailable": "Check hours / basis",
                            }
                            state_label = state_labels.get(
                                point["state"], "Unavailable"
                            )
                            if point["source_state"] == "provisional":
                                state_label += " · pending"
                            chart.create_text(
                                center,
                                top + plot_height + 34,
                                text=state_label,
                                fill=AMBER if "pending" in state_label else MUTED,
                                font=("Segoe UI", 7),
                            )

                chart.bind("<Configure>", draw_chart)
                hover = self.label(
                    result_frame,
                    "Move over a month to inspect its quantity, hours and rate.",
                    11,
                    MUTED,
                    wraplength=850,
                    justify="left",
                )
                hover.pack(anchor="w", padx=18, pady=(0, 10))

                def inspect_point(event):
                    plot_width = max(chart.winfo_width(), 520) - 82
                    index = int((event.x - 64) / (plot_width / max(len(points), 1)))
                    if event.x < 64 or not 0 <= index < len(points):
                        return
                    point = points[index]
                    if point["value"] is None:
                        text = f"{point['month']} | {point['state']} | {point['reason'] or 'No comparable validated quantity.'}"
                    elif monthly:
                        text = f"{point['month']} | {point['source_state']} | {amount(point['value'])} {unit} | {point['hours_basis']}"
                    else:
                        text = (
                            f"{point['month']} | {point['source_state']} | "
                            f"{amount(point['quantity'])} L / {amount(point['hours'])} h x 24 = "
                            f"{amount(point['value'])} L/day | {point['hours_basis']}"
                        )
                    hover.configure(text=text)

                chart.bind("<Motion>", inspect_point)
                self.label(
                    result_frame,
                    "Teal: official report   Grey: superseded version   Dashed line: prior average. "
                    "A missing month is shown as a gap, not zero.",
                    10,
                    MUTED,
                    wraplength=850,
                    justify="left",
                ).pack(anchor="w", padx=18, pady=(0, 12))
                note = (
                    f"{start} to {end} | {unit} is the reported storage withdrawal per reporting month. "
                    "A group total is shown only when every heading in the group is reported; a blank is never "
                    "treated as zero. Benchmark = average of prior months in the range; the selected month "
                    "is excluded. Grease stays in its reported unit and is never added to litres."
                    if monthly
                    else f"{start} to {end} | L/day means litres per 24 running hours, not per calendar day. "
                    "Each bar represents a full reporting month, even for partial-month custom dates. "
                    "Benchmarks = total eligible litres / total matching hours x 24; the selected month is excluded. "
                    "Cylinder grades use total ME hours, not grade-specific usage hours. "
                    "Review fuel sulphur, BN selection and engine load before interpreting changes as efficiency changes."
                )
                self.label(
                    result_frame, note, 11, MUTED, wraplength=850, justify="left"
                ).pack(anchor="w", padx=18, pady=(0, 14))
                draw_chart()

            grade_menu.configure(command=render_grade_history)
            window_menu.configure(command=render_grade_history)
            render_grade_history()

            if primary_oils:
                self.table(
                    self.section("Primary Bulk Grades", "this month"),
                    ["Bulk grade", "Oil", "Measure", "Monthly (L)", "Change/loss (L)"],
                    [
                        (
                            oil["group"],
                            oil["grade"],
                            (
                                "System operating"
                                if oil["consumption_field"] == "operating"
                                else "Storage withdrawal"
                            ),
                            amount(oil["monthly_consumption"]),
                            amount(oil["change_loss"]),
                        )
                        for oil in primary_oils
                    ],
                    [190, 260, 160, 120, 130],
                )
            if groups:
                group_rows = []
                for group in groups:
                    comparison = group["comparisons"][3]
                    baseline = comparison["average_consumption"]
                    coverage = f"{comparison['coverage']}/3 months"
                    if (
                        baseline is None
                        and comparison["reference_average_consumption"] is not None
                    ):
                        baseline = comparison["reference_average_consumption"]
                        coverage = f"{comparison['reference_coverage']}/3 incl. pending"
                    group_rows.append(
                        (
                            group["group"],
                            len(group["grades"]),
                            (
                                amount(group["monthly_consumption"])
                                if group["monthly_consumption"] is not None
                                else "— (heading blank)"
                            ),
                            group["unit"] or "as reported",
                            amount(baseline),
                            (
                                f"{comparison['change_percent']:+.1f}%"
                                if comparison["change_percent"] is not None
                                else "—"
                            ),
                            coverage,
                        )
                    )
                self.table(
                    self.section("Other Oils by Group", "this month vs prior 3 months"),
                    [
                        "Group",
                        "Headings",
                        "This month",
                        "Unit",
                        "Prior 3M avg",
                        "Change",
                        "Coverage",
                    ],
                    group_rows,
                    [170, 90, 140, 100, 120, 90, 150],
                )
                self.table(
                    self.section("Other Oil Headings", "this month"),
                    ["Group", "Heading", "Oil", "Monthly consumption", "Unit"],
                    [
                        (
                            oil["group"],
                            " ".join(str(oil["category"]).split()),
                            oil.get("grade") or "—",
                            amount(oil["monthly_consumption"]),
                            group_unit(oil["group"]) or "as reported",
                        )
                        for oil in other_oils
                    ],
                    [170, 240, 300, 150, 110],
                )
            self.label(
                self.body,
                "System oil uses the reported operating quantity; all other oils use the reported storage withdrawal. "
                "These are different measures and are not combined. A group total needs every heading in the group "
                "to be reported. Grease is shown in its reported unit and is never added to litres. "
                "Change/loss is not classified as physical loss without supporting evidence.",
                11,
                MUTED,
                wraplength=1000,
                justify="left",
            ).pack(anchor="w", padx=4, pady=(0, 16))

        engine_rows = []
        for engine in engines:
            name = engine["engine"]
            engine_rows.append(
                (
                    name,
                    amount(engine.get("hours")),
                    amount(metric(report, name, "rate"), 2),
                    (
                        amount(metric(report, name, "cylinder_rate"), 2)
                        if name == "ME"
                        else "—"
                    ),
                    engine.get("last_change") or "Unresolved",
                )
            )
        machinery = self.section("Machinery Rates", "supporting context")
        self.table(
            machinery,
            [
                "Engine",
                "Running hours",
                "System L/24h",
                "Cylinder L/24h",
                "Last change",
            ],
            engine_rows,
            [100, 140, 150, 150, 180],
        )
        self.label(
            machinery,
            "Machinery rates are reported per engine, not assigned to a specific bulk-oil grade. They are shown "
            "as supporting context and are not plotted as grade-level consumption.",
            10,
            MUTED,
            wraplength=1000,
            justify="left",
        ).pack(anchor="w", padx=16, pady=(0, 12))

        if any(
            issue["code"] == "ae_reconciliation" for issue in data.get("issues", [])
        ):
            self.banner(
                "AE rate caution: individual auxiliary-engine rates do not reconcile with the pooled reported "
                "total. They remain visible as reported values but are not treated as grade-level consumption.",
                "warn",
            )

        events = data.get("events", [])
        if events:
            self.table(
                self.section("Reported Oil-Change Events", "this report"),
                ["Engine", "Change date", "Classification", "Renewal quantity (L)"],
                [
                    (
                        event["engine"],
                        event["date"] or "Unknown",
                        event["event_type"].replace("_", " "),
                        "Not reported",
                    )
                    for event in events
                ],
                [100, 150, 240, 170],
            )

    def render_reports(self):
        self.heading(
            "Reports & exceptions",
            "Vessel submissions are official and used as soon as they are imported. A newer sheet for the same month replaces the earlier one; every original is kept.",
        )
        in_use = sum(bool(r["is_active"]) for r in self.visible_reports)
        self.stat_tiles(
            (
                ("Reports for vessel", str(len(self.visible_reports)), ACCENT),
                ("In use", str(in_use), GOOD),
                (
                    "Superseded / not usable",
                    str(len(self.visible_reports) - in_use),
                    AMBER if len(self.visible_reports) - in_use else GOOD,
                ),
            )
        )
        if self.current:
            selected = self.section(
                "Selected Report",
                f"{self.current['month']} · version {self.current['report_version']}",
            )
            self.label(
                selected, self.current["filename"], 12, MUTED, wraplength=1000
            ).pack(anchor="w", padx=16)
            buttons = ctk.CTkFrame(selected, fg_color="transparent")
            buttons.pack(anchor="w", padx=16, pady=(10, 14))
            self.button(buttons, "Source & audit", lambda: self.evidence(), True).pack(
                side="left", padx=(0, 10)
            )
            self.button(buttons, "Compare versions", self.compare_versions, True).pack(
                side="left", padx=(0, 10)
            )
            self.button(
                buttons,
                "Open source workbook",
                lambda: self.open_original(self.current),
                True,
            ).pack(side="left")
        if self.visible_reports:
            self.table(
                self.section("Report History", "select a row to open that report"),
                ["Month", "Version", "State", "Validation", "Source filename"],
                [
                    (
                        r["month"],
                        r["report_version"],
                        (
                            "In use"
                            if r["is_active"]
                            else "Superseded" if r["confirmed_at"] else "Not usable"
                        ),
                        r["validation_status"],
                        r["filename"],
                    )
                    for r in self.visible_reports
                ],
                [110, 90, 130, 110, 520],
                lambda index: self.select_report(self.visible_reports[index]["id"]),
            )
        failures = self.repo.failures()
        if failures:
            self.table(
                self.section("Files Requiring Attention", "could not be imported"),
                ["File", "Import result"],
                [(f["filename"], f["error"]) for f in failures],
                [400, 600],
            )
        if self.import_log:
            self.table(
                self.section("Last Import", "this session"),
                ["File", "State", "Detail"],
                [(r["filename"], r["status"], r["detail"]) for r in self.import_log],
                [380, 140, 480],
            )

    def select_report(self, report_id):
        if report_id == self.report_id:
            return
        self.report_id = report_id
        self.after_idle(self.refresh)

    def evidence(self, issue=None):
        r = self.current
        issue = issue or dict(
            title="Source evidence and review history",
            detail="Raw values, formulas and cached results are retained separately. Blank is not zero.",
            fields=list(r["data"]["evidence"]),
            code="report",
        )
        window = ctk.CTkToplevel(self)
        window.title(str(issue["title"]))
        window.geometry("920x700")
        window.transient(self)
        self.label(window, str(issue["title"]), 21, bold=True, wraplength=850).pack(
            anchor="w", padx=24, pady=(20, 8)
        )
        self.label(
            window, issue["detail"], 13, MUTED, wraplength=850, justify="left"
        ).pack(anchor="w", padx=24, pady=(0, 12))
        box = ctk.CTkTextbox(window, font=("Consolas", 12), fg_color=BG)
        box.pack(fill="both", expand=True, padx=24)
        lines = [
            r["filename"],
            f"SHA-256: {r['sha256']}",
            f"Parser: {r['data']['parser_version']} | Status: {r['validation_status']}",
            "",
        ]
        for key in issue["fields"]:
            e = r["data"]["evidence"].get(key)
            if e:
                lines.extend(
                    [
                        f"{key}  [{e['sheet']}!{e['cell']}]",
                        f"Reported/cache: {e['raw']!r}",
                        f"Formula: {e['formula']}" if e["formula"] else "Direct entry",
                        "",
                    ]
                )
        if issue["code"] == "report":
            lines.extend(
                [
                    "ALL VALIDATION FINDINGS",
                    *[
                        f"{i['severity']} | {i['title']}: {i['detail']}"
                        for i in r["data"]["issues"]
                    ],
                    "",
                    "REMARKS",
                    r["data"]["remarks"],
                    "",
                    "AUDIT",
                    json.dumps(self.repo.audit(r["id"]), indent=2),
                ]
            )
        lines.extend(
            ["", "REVIEW NOTES", json.dumps(self.repo.notes(r["id"]), indent=2)]
        )
        box.insert("1.0", "\n".join(lines))
        box.configure(state="disabled")
        note = ctk.CTkEntry(
            window,
            placeholder_text="Add a note; source values and warnings remain unchanged",
            height=38,
        )
        note.pack(fill="x", padx=24, pady=12)
        actions = ctk.CTkFrame(window, fg_color="transparent")
        actions.pack(fill="x", padx=24, pady=(0, 20))

        def save():
            try:
                self.repo.add_note(r["id"], issue["code"], note.get())
                window.destroy()
                self.show(self.page)
            except Exception as error:
                messagebox.showerror("Review note", str(error), parent=window)

        self.button(actions, "Save note", save).pack(side="left")
        self.button(actions, "Open original", lambda: self.open_original(r), True).pack(
            side="left", padx=12
        )
        self.button(actions, "Export evidence", lambda: self.export(r), True).pack(
            side="left"
        )

    def open_original(self, report):
        try:
            os.startfile(str(self.repo.root / report["archive_path"]))
        except OSError as error:
            messagebox.showerror("Open source", str(error), parent=self)

    def export(self, report):
        target = filedialog.asksaveasfilename(
            parent=self,
            defaultextension=".json",
            initialfile=f"{report['month']}-lub-oil-evidence.json",
            filetypes=[("JSON evidence", "*.json")],
        )
        if target:
            try:
                Path(target).write_text(
                    json.dumps(
                        dict(
                            source=report["filename"],
                            sha256=report["sha256"],
                            data=report["data"],
                            notes=self.repo.notes(report["id"]),
                        ),
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
            except OSError as error:
                messagebox.showerror("Export failed", str(error), parent=self)

    def compare_versions(self):
        r = self.current
        others = [
            x
            for x in self.visible_reports
            if x["month"] == r["month"] and x["id"] != r["id"]
        ]
        if not others:
            messagebox.showinfo(
                "Version comparison",
                "Only one source version is present for this month.",
                parent=self,
            )
            return
        text = []
        for other in others:
            text.append(
                f"Selected v{r['report_version']} compared with v{other['report_version']} ({'active' if other['is_active'] else 'inactive'})"
            )
            for key in sorted(
                set(r["data"]["evidence"]) | set(other["data"]["evidence"])
            ):
                a = r["data"]["evidence"].get(key, {}).get("raw")
                b = other["data"]["evidence"].get(key, {}).get("raw")
                if a != b:
                    text.append(f"{key}: selected {a!r} | other {b!r}")
        window = ctk.CTkToplevel(self)
        window.title("Report version comparison")
        window.geometry("900x600")
        box = ctk.CTkTextbox(window, font=("Consolas", 12))
        box.pack(fill="both", expand=True, padx=20, pady=20)
        box.insert("1.0", "\n\n".join(text))
        box.configure(state="disabled")

    # ------------------------------------------------------------------ Budget Performance
    def grid_table(self, parent, headings, rows, weights, emphasis=()):
        """Flat table in the dashboard style. rows = [[text, ...]]; first column left, others right."""
        table = ctk.CTkFrame(parent, fg_color="transparent")
        table.pack(fill="x", padx=16, pady=(0, 6))
        for column, heading in enumerate(headings):
            table.grid_columnconfigure(
                column, weight=weights[column], uniform=f"t{column}"
            )
            cell = ctk.CTkFrame(table, fg_color=ACCENT_TINT, corner_radius=0, height=34)
            cell.grid(row=0, column=column, sticky="nsew")
            self.label(cell, heading, 11, INK, True).pack(
                anchor="w" if column == 0 else "e", padx=10, pady=7
            )
        for row, values in enumerate(rows, start=1):
            for column, value in enumerate(values):
                bold = column == 0 or column in emphasis
                self.label(
                    table, value, 13 if column in emphasis else 12, INK, bold
                ).grid(
                    row=row,
                    column=column,
                    sticky="w" if column == 0 else "e",
                    padx=10,
                    pady=7,
                )
            ctk.CTkFrame(table, height=1, fg_color=GRID).grid(
                row=row, column=0, columnspan=len(headings), sticky="sew"
            )
        return table

    def budget_context(self):
        vessel = self.vessel.get()
        active = sorted(
            r["month"]
            for r in self.visible_reports
            if r.get("month") and r.get("is_active")
        )
        if not active:
            return None
        try:
            configured = self.repo.budget_years(vessel)
        except ValueError:
            configured = []
        years = sorted({int(m[:4]) for m in active} | set(configured))
        if self.budget_year not in years:
            self.budget_year = int(active[-1][:4])
        year = self.budget_year
        in_year = [m for m in active if int(m[:4]) == year]
        end = in_year[-1] if in_year else f"{year}-12"
        try:
            basis, prices = self.repo.budget_basis(
                vessel, year
            ), self.repo.reference_prices(vessel, year)
        except ValueError:
            basis, prices = [], []
        return years, budget_performance(self.reports, vessel, year, end, basis, prices)

    def change_budget_year(self, value):
        self.budget_year = int(value)
        self.show("Budget")

    def render_budget(self):
        context = self.budget_context()
        if context is None:
            self.heading(
                "No reports yet",
                "Import the vessels' monthly lube oil sheets from the sidebar to build the budget view.",
            )
            return
        years, perf = context
        vessel = self.vessel.get()
        months = perf["months"]
        top = ctk.CTkFrame(self.body, fg_color="transparent")
        top.pack(fill="x", pady=(0, 12))
        titles = ctk.CTkFrame(top, fg_color="transparent")
        titles.pack(side="left")
        self.label(titles, "Budget Performance", 20, INK, True).pack(anchor="w")
        self.label(
            titles,
            f"Period: {month_label(months[0])} – {month_label(months[-1], True)}  ·  "
            f"{len(perf['reported'])} of {len(months)} monthly reports in use  ·  "
            f"budget year {perf['year']}, {vessel_title(vessel)}",
            12,
            MUTED,
        ).pack(anchor="w")
        tools = ctk.CTkFrame(top, fg_color="transparent")
        tools.pack(side="right")
        self.label(tools, "Budget year:", 12, MUTED).pack(side="left", padx=(0, 6))
        year_menu = ctk.CTkOptionMenu(
            tools,
            values=[str(y) for y in years],
            command=self.change_budget_year,
            width=96,
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
        )
        year_menu.set(str(perf["year"]))
        year_menu.pack(side="left", padx=(0, 10))
        self.button(
            tools,
            "Budget basis & prices",
            lambda: self.edit_budget_basis(perf["year"]),
            secondary=True,
        ).pack(side="left")
        if not perf["configured"]:
            self.banner(
                f"BUDGET BASIS NOT CONFIGURED for {vessel_title(vessel)} {perf['year']}. Earlier-year rates, "
                "days and prices are never copied forward. Use 'Budget basis & prices' to record the approved basis.",
                "warn",
            )
        self.bulk_cards(self.body, perf["end_month"])
        ctk.CTkFrame(self.body, height=14, fg_color="transparent").pack()
        self.cost_table(perf)
        row = ctk.CTkFrame(self.body, fg_color="transparent")
        row.pack(fill="x", pady=(0, 14))
        row.grid_columnconfigure(0, weight=3, uniform="budget")
        row.grid_columnconfigure(1, weight=2, uniform="budget")
        self.variance_panel(row, perf).grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        self.ae_budget_panel(row, perf).grid(
            row=0, column=1, sticky="nsew", padx=(7, 0)
        )
        row = ctk.CTkFrame(self.body, fg_color="transparent")
        row.pack(fill="x", pady=(0, 10))
        row.grid_columnconfigure(0, weight=2, uniform="lower")
        row.grid_columnconfigure(1, weight=3, uniform="lower")
        self.comments_panel(row, perf).grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        self.supporting_panel(row, perf).grid(
            row=0, column=1, sticky="nsew", padx=(7, 0)
        )

    def cost_table(self, perf):
        panel = self.section(
            "Consumption-only cost analysis",
            "Consumed litres × reference USD/L. Receipts do not create cost.",
        )
        rows = []
        for row in perf["categories"]:
            basis = row["basis"]
            currency = row["currency"] or "USD"
            rows.append(
                [
                    row["label"],
                    (
                        f"{basis['daily_budget_rate']:,.0f} L/day"
                        if basis
                        else "Not configured"
                    ),
                    f"{basis['applicable_days_per_year']:,.0f} days" if basis else "—",
                    amount(row["annual"], 0),
                    amount(row["actual"], 0),
                    (
                        f"{row['unit_price']:,.2f}"
                        if row["unit_price"] is not None
                        else "Not configured"
                    ),
                    (
                        money(
                            row["costs"]["actual"] if row["costs"] else None, currency
                        )
                        if row["actual"] is not None
                        else "—"
                    ),
                ]
            )
        self.grid_table(
            panel,
            (
                "Category",
                "Budget rate",
                "Annual basis",
                "Annual allowance (L)",
                "Consumption (L)",
                "Reference USD/L",
                "Consumption value",
            ),
            rows,
            (4, 2, 2, 2, 2, 2, 2),
            emphasis=(6,),
        )
        cylinder = next(
            r for r in perf["categories"] if r["category"] == ME_CYLINDER_OIL
        )
        split = "  ·  ".join(
            f"{GRADE_STYLE[s['group']]['title'].split('· ')[-1]} {litres(s['actual'])}"
            for s in cylinder["sub"]
        )
        self.fluid(
            panel,
            f"Cylinder total = High BN + Low BN ({split}). AE allowance is vessel-level, not per engine. "
            "Reference prices: Singapore basis; not invoice, purchase or inventory cost.",
            padx=16,
            pady=(2, 2),
        )
        gaps = sorted(
            {
                (m, why)
                for r in perf["categories"]
                for m, why in r["missing"]
                if r["configured"]
            }
        )
        flags = sorted(
            {m for r in perf["categories"] for m, _ in r.get("hour_flags", [])}
        )
        if gaps:
            self.fluid(
                panel,
                "Excluded from both allowance and actual (never treated as zero): "
                + "; ".join(f"{month_label(m, True)} {why.lower()}" for m, why in gaps),
                color=AMBER,
                padx=16,
                pady=(0, 2),
            )
        if flags:
            self.fluid(
                panel,
                f"ME hours exceed the calendar month in {', '.join(month_label(m, True) for m in flags)}; "
                "kept as reported, since the sheet's reporting period may not match the calendar month.",
                padx=16,
                pady=(0, 2),
            )
        ctk.CTkFrame(panel, height=8, fg_color="transparent").pack()

    def variance_panel(self, parent, perf):
        row = next(
            r for r in perf["categories"] if r["category"] == self.variance_category
        )
        panel = self.panel(
            parent,
            CATEGORY_LABEL[self.variance_category].replace(" · Total", ""),
            "Explain the variance",
        )
        controls = ctk.CTkFrame(panel, fg_color="transparent")
        controls.pack(fill="x", padx=16, pady=(0, 6))
        names = {"ME Cylinder Oil": ME_CYLINDER_OIL, "ME System Oil": ME_SYSTEM_OIL}
        segment_style = dict(
            height=28,
            selected_color=ACCENT,
            selected_hover_color=ACCENT_HOVER,
            unselected_color="#9FB3C8",
            unselected_hover_color="#8AA2BB",
            text_color=WHITE,
            fg_color="#9FB3C8",
            font=ctk.CTkFont(family="Segoe UI", size=11, weight="bold"),
        )
        chooser = ctk.CTkSegmentedButton(
            controls,
            values=list(names),
            **segment_style,
            text_color_disabled=MUTED,
            command=lambda v: (
                setattr(self, "variance_category", names[v]),
                self.show("Budget"),
            ),
        )
        chooser.set(next(k for k, v in names.items() if v == self.variance_category))
        chooser.pack(side="left")
        view = ctk.CTkSegmentedButton(
            controls,
            values=["Quantity", "Cost"],
            **segment_style,
            command=lambda v: (setattr(self, "variance_view", v), self.show("Budget")),
        )
        view.set(self.variance_view)
        view.pack(side="right")
        if not row["configured"] or row["original"] is None:
            reason = (
                "Budget basis not configured for this year."
                if not row["configured"]
                else "No month has both consumption and ME running hours reported."
            )
            self.label(panel, reason, 13, MUTED).pack(
                anchor="w", padx=16, pady=(10, 18)
            )
            return panel
        cost = self.variance_view == "Cost"
        if cost and row["costs"]["original"] is None:
            self.label(
                panel,
                "Reference price not configured for this category and year; cost view unavailable.",
                13,
                MUTED,
            ).pack(anchor="w", padx=16, pady=(10, 18))
            return panel
        values = (
            row["costs"]
            if cost
            else dict(
                original=row["original"],
                activity=row["activity"]["quantity"],
                adjusted=row["adjusted"],
                actual=row["actual"],
                technical=row["technical"],
            )
        )
        fmt = (lambda v: money(v)) if cost else (lambda v: litres(v))
        sfmt = (
            (lambda v: ("+" if v >= 0 else "") + money(v))
            if cost
            else (lambda v: signed(v))
        )
        stats = ctk.CTkFrame(panel, fg_color="transparent")
        stats.pack(fill="x", padx=16, pady=(4, 0))
        items = (
            ("Original allowance", fmt(values["original"]), "#2A9D8F"),
            ("Activity impact", sfmt(values["activity"]), "#7FB8E6"),
            ("Adjusted allowance", fmt(values["adjusted"]), "#1E6FD0"),
            ("Actual", fmt(values["actual"]), SIDEBAR),
        )
        for column, (title, value, _color) in enumerate(items):
            stats.grid_columnconfigure(column, weight=1, uniform="var")
            self.label(stats, title, 10, MUTED).grid(row=0, column=column)
            self.label(stats, value, 16, INK, True).grid(row=1, column=column)
        canvas = tk.Canvas(panel, height=130, bg=WHITE, highlightthickness=0)
        canvas.pack(fill="x", padx=16, pady=(4, 4))
        steps = [
            (0, values["original"]),
            (values["original"], values["adjusted"]),
            (0, values["adjusted"]),
            (0, values["actual"]),
        ]
        activity = row["activity"]
        tips = [
            f"{len(row['covered'])} month(s) × approved basis\n{row['basis']['daily_budget_rate']:,.0f} L/day, "
            f"{row['basis']['applicable_days_per_year']:,.0f} days/year",
            f"ME ran {activity['actual_hours']:,.0f} h vs {activity['budget_hours']:,.0f} h budget\n"
            f"{activity['day_variance']:+,.1f} equivalent operating days × {row['basis']['daily_budget_rate']:,.0f} L/day",
            "Original allowance + activity impact",
            f"Reported consumption, {len(row['covered'])} month(s)",
        ]
        canvas.bind(
            "<Configure>",
            lambda _e: self.draw_waterfall(
                canvas, steps, [c for _, _, c in items], tips
            ),
        )
        days = activity["day_variance"]
        self.fluid(
            panel,
            f"Activity: ME ran {activity['actual_hours']:,.0f} h against {activity['budget_hours']:,.0f} h budgeted "
            f"({days:+,.1f} operating days). Activity impact reflects vessel utilisation, not technical performance.",
            wrap=540,
            padx=16,
        )
        technical = values["technical"]
        if technical is None:
            text, tone = (
                "Technical variance unavailable: price missing for part of the category.",
                "neutral",
            )
        else:
            quantity = row["technical"]
            value = row["costs"]["technical"]
            word = "Above" if quantity > 0 else "Within"
            text = (
                f"{word} activity-adjusted allowance: {signed(quantity)}  ({row['technical_percent']:+.1f}%)"
                + (
                    f"  |  {('+' if value >= 0 else '') + money(value)} reference value"
                    if value is not None
                    else ""
                )
            )
            tone = "warn" if quantity > 0 else "good"
        fill, ink = {
            "good": ("#E7F5EC", GOOD),
            "warn": ("#FDF5E6", AMBER),
            "neutral": ("#EEF1F4", MUTED),
        }[tone]
        box = ctk.CTkFrame(panel, fg_color=fill, corner_radius=8)
        box.pack(fill="x", padx=16, pady=(8, 14))
        self.label(box, text, 12, ink, True).pack(anchor="w", padx=12, pady=8)
        return panel

    @staticmethod
    def draw_waterfall(canvas, steps, colors, tips):
        canvas.delete("all")
        width, height = _size(canvas, 300)
        top, bottom = 8, 6
        peak = (max(max(a, b) for a, b in steps) or 1) * 1.06
        plot_h = height - top - bottom
        slot = width / len(steps)
        baseline = top + plot_h
        canvas.create_line(0, baseline, width, baseline, fill=BORDER)
        zones = []
        for index, ((start, end), color) in enumerate(zip(steps, colors)):
            low, high = sorted((start, end))
            x = slot * index + slot * 0.22
            y1, y2 = baseline - plot_h * high / peak, baseline - plot_h * low / peak
            canvas.create_rectangle(
                x, y1, x + slot * 0.56, max(y2, y1 + 2), fill=color, outline=""
            )
            zones.append((slot * index, slot * (index + 1), tips[index]))
        attach_tooltips(canvas, zones)

    def ae_budget_panel(self, parent, perf):
        row = next(r for r in perf["categories"] if r["category"] == AE_SYSTEM_OIL)
        panel = self.panel(parent, "AE consumption breakdown", "vessel total")
        ae = row.get("ae")
        if not ae:
            self.label(
                panel,
                "No AE system oil month with routine and change/loss reported.",
                13,
                MUTED,
            ).pack(anchor="w", padx=16, pady=(10, 18))
            return panel
        price = row["unit_price"]
        body = ctk.CTkFrame(panel, fg_color="transparent")
        body.pack(fill="x", padx=16, pady=(4, 0))
        body.grid_columnconfigure(1, weight=1)
        parts = (
            ("Routine consumption", ae["routine"], "#6A5ACD"),
            ("Confirmed sump renewal", ae["confirmed"], "#A99CF0"),
            ("Probable renewal (not excluded)", ae["probable"], "#E6B450"),
            ("Unclassified change/loss", ae["unclassified"], "#C9CED6"),
        )
        for index, (name, value, color) in enumerate(parts):
            self.label(body, name, 12, INK).grid(
                row=index, column=0, sticky="w", pady=5
            )
            track = ctk.CTkFrame(body, height=18, fg_color="#EEF0F6", corner_radius=4)
            track.grid(row=index, column=1, sticky="ew", padx=10)
            track.grid_propagate(False)
            share = value / ae["total"] if ae["total"] else 0
            if share > 0:
                ctk.CTkFrame(track, height=18, fg_color=color, corner_radius=4).place(
                    relx=0, rely=0, relwidth=max(share, 0.02), relheight=1
                )
            cost = f" · {money(value * price)}" if price is not None else ""
            self.label(body, litres(value) + cost, 12, INK, True).grid(
                row=index, column=2, sticky="e"
            )
        total = ctk.CTkFrame(panel, fg_color=ACCENT_TINT, corner_radius=10)
        total.pack(fill="x", padx=16, pady=(10, 6))
        self.label(total, f"Total: {litres(ae['total'])}", 20, INK, True).pack(
            anchor="w", padx=14, pady=(10, 0)
        )
        allowance = row["original"]
        normal_line = (
            f"Normal operating (excl. confirmed renewals): {litres(ae['normal'])}"
        )
        if allowance is not None:
            normal_line += f"  ·  allowance {litres(allowance)}"
        self.fluid(total, normal_line, 11, INK, wrap=320, padx=14, pady=(0, 2))
        self.fluid(
            total,
            "Renewal oil carries consumption cost but is not routine consumption."
            + (
                ""
                if price is not None
                else " AE reference price not configured, so no cost is shown."
            ),
            wrap=320,
            padx=14,
            pady=(0, 10),
        )
        if row["basis"]:
            self.fluid(
                panel,
                f"Allowance = {row['basis']['daily_budget_rate']:,.0f} L/day × calendar days for the vessel "
                f"(not per engine). Probable renewals stay in normal consumption until confirmed.",
                wrap=340,
                padx=16,
                pady=(0, 12),
            )
        return panel

    def comments_panel(self, parent, perf):
        vessel = self.vessel.get()
        period = f"{perf['year']}-YTD-{perf['end_month']}"
        panel = self.panel(
            parent,
            "Superintendent comments",
            f"{month_label(perf['months'][0])} – {month_label(perf['end_month'], True)}",
        )
        options = ctk.CTkFrame(panel, fg_color="transparent")
        options.pack(fill="x", padx=16, pady=(0, 6))
        menu = dict(
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
            height=30,
        )
        types = {
            "General": "GENERAL",
            "Activity variance": "ACTIVITY_VARIANCE",
            "Consumption variance": "CONSUMPTION_VARIANCE",
            "Sump renewal": "SUMP_RENEWAL",
            "Maintenance": "MAINTENANCE",
            "Oil loss": "LOSS",
            "Pending vessel investigation": "PENDING_INVESTIGATION",
        }
        categories = {
            "All categories": None,
            **{CATEGORY_LABEL[c]: c for c in BUDGET_CATEGORIES},
        }
        kind = ctk.CTkOptionMenu(options, values=list(types), width=180, **menu)
        kind.pack(side="left", padx=(0, 8))
        category = ctk.CTkOptionMenu(
            options, values=list(categories), width=210, **menu
        )
        category.pack(side="left")
        box = ctk.CTkTextbox(
            panel,
            height=74,
            border_width=1,
            border_color=BORDER,
            fg_color=WHITE,
            text_color=INK,
            font=ctk.CTkFont(family="Segoe UI", size=12),
            wrap="word",
        )
        box.pack(fill="x", padx=16)

        def save():
            try:
                self.repo.add_comment(
                    vessel,
                    period,
                    box.get("1.0", "end"),
                    types[kind.get()],
                    categories[category.get()],
                )
            except ValueError as error:
                messagebox.showerror("Comment not saved", str(error), parent=self)
                return
            self.log_activity(f"Comment saved for {vessel} {period}.")
            self.show("Budget")

        self.button(panel, "Save comment", save).pack(anchor="e", padx=16, pady=(6, 6))
        try:
            saved = self.repo.comments(vessel, period)
        except ValueError:
            saved = []
        if not saved:
            self.fluid(
                panel,
                "No comments for this period. Explanations are entered by the superintendent, never generated.",
                wrap=340,
                padx=16,
                pady=(0, 12),
            )
        for item in saved[:4]:
            stamp = (
                datetime.fromisoformat(item["created_at"])
                .astimezone()
                .strftime("%d %b %Y %H:%M")
            )
            scope = CATEGORY_LABEL.get(item["oil_category"], "All categories")
            entry = ctk.CTkFrame(panel, fg_color=TABLE_HEAD, corner_radius=8)
            entry.pack(fill="x", padx=16, pady=(0, 6))
            self.fluid(entry, item["comment"], 12, INK, wrap=330, padx=10, pady=(6, 0))
            self.fluid(
                entry,
                f"{item['created_by']} · {stamp} · {item['variance_type'].replace('_', ' ').lower()} · {scope}",
                9,
                wrap=330,
                padx=10,
                pady=(0, 6),
            )
        if saved:
            ctk.CTkFrame(panel, height=6, fg_color="transparent").pack()
        return panel

    def supporting_panel(self, parent, perf):
        data = dashboard(
            self.reports, self.vessel.get(), perf["end_month"], len(perf["months"])
        )
        panel = self.panel(
            parent, "Supporting lubricants", "Inventory only · excluded from cost"
        )
        grid = ctk.CTkFrame(panel, fg_color="transparent")
        grid.pack(fill="x", padx=12, pady=(0, 6))
        support = {g["group"]: g for g in data["support"]}
        for column, (name, groups, badge_text, color, tint) in enumerate(
            SUPPORT_BUCKETS
        ):
            grid.grid_columnconfigure(column, weight=1, uniform="bucket")
            members = [support[g] for g in groups if g in support]
            card = ctk.CTkFrame(
                grid,
                fg_color=WHITE,
                corner_radius=10,
                border_width=1,
                border_color=BORDER,
            )
            card.grid(row=0, column=column, sticky="nsew", padx=4, pady=4)
            badge = ctk.CTkFrame(
                card, width=30, height=30, fg_color=tint, corner_radius=8
            )
            badge.pack(anchor="w", padx=10, pady=(10, 4))
            badge.pack_propagate(False)
            self.label(badge, badge_text, 10, color, True).pack(expand=True)
            self.fluid(card, name, 12, INK, True, wrap=90, padx=10)
            totals = [m["total"] for m in members if m["total"] is not None]
            unit = "L" if all(m["unit"] == "L" for m in members) else None
            value = (
                "—"
                if not totals
                else (litres(sum(totals)) if unit else f"{sum(totals):,.0f}")
            )
            self.label(card, value, 15, INK, True).pack(
                anchor="w", padx=10, pady=(4, 0)
            )
            headings = sum(len(m["headings"]) for m in members)
            self.label(
                card, f"({headings} heading{'s' if headings != 1 else ''})", 9, MUTED
            ).pack(anchor="w", padx=10)
            if members and not unit:
                self.label(card, "unit not stated", 9, AMBER).pack(anchor="w", padx=10)
            if members:
                ctk.CTkButton(
                    card,
                    text="Drill down  ›",
                    command=lambda g=members[0]["group"]: self.open_group_trend(g),
                    width=20,
                    height=22,
                    fg_color="transparent",
                    hover_color="#E8EFF7",
                    text_color=ACCENT,
                    font=ctk.CTkFont(family="Segoe UI", size=10),
                ).pack(anchor="w", padx=4, pady=(0, 6))
        self.fluid(
            panel,
            "Period storage withdrawals; a month counts only when every heading in the group is reported. "
            "Grease is never added to litres.",
            wrap=540,
            padx=16,
            pady=(0, 12),
        )
        return panel

    def edit_budget_basis(self, year, vessel=None):
        vessel = vessel or self.vessel.get()
        try:
            basis = {b["oil_category"]: b for b in self.repo.budget_basis(vessel, year)}
            prices = {
                p["oil_category"]: p
                for p in self.repo.reference_prices(vessel, year)
                if not p.get("oil_grade")
            }
        except ValueError as error:
            messagebox.showerror("Vessel not in master", str(error), parent=self)
            return
        window = ctk.CTkToplevel(self)
        window.title(f"Budget basis & reference prices · {vessel_title(vessel)} {year}")
        window.geometry("820x470")
        window.configure(fg_color=BG)
        window.transient(self)
        self.label(
            window, f"{vessel_title(vessel)} · budget year {year}", 18, INK, True
        ).pack(anchor="w", padx=20, pady=(16, 0))
        self.label(
            window,
            "Vessel- and year-specific master data. Nothing is copied from another year. "
            "Prices are Singapore reference consumption prices, not invoice or purchase prices.",
            11,
            MUTED,
            wraplength=760,
            justify="left",
        ).pack(anchor="w", padx=20, pady=(0, 10))
        form = ctk.CTkFrame(
            window,
            fg_color=WHITE,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        form.pack(fill="x", padx=20)
        heads = (
            "Category",
            "Daily rate (L/day)",
            "Applicable days / year",
            "Reference USD/L",
        )
        for column, head in enumerate(heads):
            form.grid_columnconfigure(column, weight=2 if column == 0 else 1)
            self.label(form, head, 11, MUTED, True).grid(
                row=0, column=column, sticky="w", padx=12, pady=(10, 4)
            )
        entries = {}
        for row, category in enumerate(BUDGET_CATEGORIES, start=1):
            self.label(form, CATEGORY_LABEL[category], 12, INK, True).grid(
                row=row, column=0, sticky="w", padx=12, pady=6
            )
            current = basis.get(category)
            price = prices.get(category)
            fields = []
            for column, value in enumerate(
                (
                    current and current["daily_budget_rate"],
                    current and current["applicable_days_per_year"],
                    price and price["reference_price_per_litre"],
                ),
                start=1,
            ):
                entry = ctk.CTkEntry(
                    form, height=32, border_color=BORDER, fg_color=WHITE
                )
                if value is not None:
                    entry.insert(0, f"{value:g}")
                entry.grid(row=row, column=column, sticky="ew", padx=12, pady=6)
                fields.append(entry)
            entries[category] = fields
        self.label(window, "Source / approval reference (required)", 11, MUTED).pack(
            anchor="w", padx=20, pady=(12, 2)
        )
        source = ctk.CTkEntry(window, height=32, border_color=BORDER, fg_color=WHITE)
        source.pack(fill="x", padx=20)

        def save():
            reference = source.get().strip()
            if not reference:
                messagebox.showerror(
                    "Source required",
                    "Record where these values were approved.",
                    parent=window,
                )
                return
            try:
                changed = 0
                for category, (rate, days, price) in entries.items():
                    rate_text, days_text, price_text = (
                        rate.get().strip(),
                        days.get().strip(),
                        price.get().strip(),
                    )
                    current = basis.get(category)
                    if (
                        rate_text
                        and days_text
                        and (
                            current is None
                            or float(rate_text) != current["daily_budget_rate"]
                            or float(days_text) != current["applicable_days_per_year"]
                        )
                    ):
                        self.repo.set_budget_basis(
                            vessel, year, category, rate_text, days_text, reference
                        )
                        changed += 1
                    old = prices.get(category)
                    if price_text and (
                        old is None
                        or float(price_text) != old["reference_price_per_litre"]
                    ):
                        self.repo.set_reference_price(
                            vessel, year, category, price_text, reference
                        )
                        changed += 1
            except ValueError as error:
                messagebox.showerror("Not saved", str(error), parent=window)
                return
            self.log_activity(
                f"Budget master data updated for {vessel} {year}: {changed} change(s)."
            )
            window.destroy()
            self.show(self.page)

        self.button(window, "Save master data", save).pack(anchor="e", padx=20, pady=14)

    # ------------------------------------------------------------------ Master Data Register
    def register_years(self):
        years = {datetime.now().year, datetime.now().year + 1}
        years |= {int(r["month"][:4]) for r in self.reports if r.get("month")}
        with_basis = set()
        for vessel in self.repo.vessels():
            with_basis |= set(self.repo.budget_years(vessel))
        return sorted(years | with_basis)

    def latest_system_quantity(self, vessel):
        """The ME system quantity on the vessel's latest sheet in use: a reference while entering the full charge."""
        active = [
            r
            for r in self.reports
            if r.get("vessel") == vessel and r.get("is_active") and r.get("month")
        ]
        if not active:
            return None, None
        report = max(active, key=lambda r: r["month"])
        values = [
            o.get("system_closing")
            for o in report["data"].get("inventory", [])
            if oil_group(o.get("category")) == "System oil · ME"
        ]
        return (values[0] if len(values) == 1 else None), report["month"]

    def register_row(self, table, row, values, weights, actions):
        for column, value in enumerate(values):
            if isinstance(value, tuple):  # (text, tone) pill
                fill, ink = {
                    "good": ("#DDF3E6", GOOD),
                    "warn": ("#FCEFD3", "#8A5A00"),
                    "neutral": ("#ECEFF2", MUTED),
                }[value[1]]
                ctk.CTkLabel(
                    table,
                    text=value[0],
                    fg_color=fill,
                    text_color=ink,
                    corner_radius=6,
                    height=22,
                    font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
                ).grid(row=row, column=column, sticky="w", padx=10, pady=6)
            else:
                self.label(table, value, 12, INK, column == 0).grid(
                    row=row, column=column, sticky="w", padx=10, pady=6
                )
        cell = ctk.CTkFrame(table, fg_color="transparent")
        cell.grid(row=row, column=len(values), sticky="e", padx=6)
        for text, command in actions:
            ctk.CTkButton(
                cell,
                text=text,
                command=command,
                width=20,
                height=26,
                fg_color="transparent",
                hover_color="#E8EFF7",
                text_color=ACCENT,
                font=ctk.CTkFont(family="Segoe UI", size=11, weight="bold"),
            ).pack(side="left", padx=2)
        ctk.CTkFrame(table, height=1, fg_color=GRID).grid(
            row=row, column=0, columnspan=len(weights), sticky="sew"
        )

    def register_table(self, parent, headings, weights):
        table = ctk.CTkFrame(parent, fg_color="transparent")
        table.pack(fill="x", padx=16, pady=(0, 10))
        for column, heading in enumerate(headings):
            table.grid_columnconfigure(column, weight=weights[column])
            cell = ctk.CTkFrame(table, fg_color=ACCENT_TINT, corner_radius=0, height=32)
            cell.grid(row=0, column=column, sticky="nsew")
            self.label(cell, heading, 11, INK, True).pack(anchor="w", padx=10, pady=6)
        return table

    def render_register(self):
        years = self.register_years()
        if getattr(self, "register_year", None) not in years:
            self.register_year = datetime.now().year
        year = self.register_year
        top = ctk.CTkFrame(self.body, fg_color="transparent")
        top.pack(fill="x", pady=(0, 12))
        titles = ctk.CTkFrame(top, fg_color="transparent")
        titles.pack(side="left")
        self.label(titles, "Master Data Register", 20, INK, True).pack(anchor="w")
        self.label(
            titles,
            "Vessel- and year-specific values used by Lube Oil Intelligence. Nothing is hard-wired; "
            "every change is logged with user, time and source.",
            12,
            MUTED,
        ).pack(anchor="w")
        tools = ctk.CTkFrame(top, fg_color="transparent")
        tools.pack(side="right")
        self.label(tools, "Budget year:", 12, MUTED).pack(side="left", padx=(0, 6))
        menu = ctk.CTkOptionMenu(
            tools,
            values=[str(y) for y in years],
            width=96,
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
            command=lambda v: (
                setattr(self, "register_year", int(v)),
                self.show("Register"),
            ),
        )
        menu.set(str(year))
        menu.pack(side="left")

        rows = self.repo.register(year)
        configured = sum(len(r["basis"]) == len(BUDGET_CATEGORIES) for r in rows)
        priced = sum(len(r["prices"]) == len(BUDGET_CATEGORIES) for r in rows)
        tanks = self.repo.tanks()
        self.stat_tiles(
            [
                (
                    f"Vessels with complete budget basis · {year}",
                    f"{configured} / {len(rows)}",
                    ACCENT,
                ),
                (
                    f"Vessels with all three reference prices · {year}",
                    f"{priced} / {len(rows)}",
                    "#2A9D8F",
                ),
                (
                    "Vessels with ME full charge recorded",
                    f"{sum(r['charge'] is not None for r in rows)} / {len(rows)}",
                    GOOD,
                ),
                ("Current bulk tanks registered", str(len(tanks)), "#6A5ACD"),
            ]
        )

        section = self.section(
            f"Budget basis & reference prices · {year}",
            "rate × applicable days per category; Singapore reference USD/L",
        )
        weights = (3, 3, 3, 3, 3, 2, 1)
        table = self.register_table(
            section,
            (
                "Vessel",
                "ME system oil",
                "ME cylinder oil",
                "AE system oil",
                "Reference USD/L (ME · Cyl · AE)",
                "Status",
                "",
            ),
            weights,
        )
        for index, row in enumerate(rows, start=1):

            def basis_text(category):
                b = row["basis"].get(category)
                return (
                    f"{b['daily_budget_rate']:g} L/day × {b['applicable_days_per_year']:g} d"
                    if b
                    else "—"
                )

            price_text = " · ".join(
                (
                    f"{row['prices'][c]['reference_price_per_litre']:.2f}"
                    if c in row["prices"]
                    else "—"
                )
                for c in BUDGET_CATEGORIES
            )
            complete = len(row["basis"]) == len(BUDGET_CATEGORIES)
            status = (
                ("Complete", "good")
                if complete and len(row["prices"]) == len(BUDGET_CATEGORIES)
                else (
                    ("Price missing", "warn")
                    if complete
                    else (
                        ("Partial", "warn")
                        if row["basis"]
                        else ("Not configured", "neutral")
                    )
                )
            )
            self.register_row(
                table,
                index,
                (
                    vessel_title(row["vessel"]),
                    basis_text(ME_SYSTEM_OIL),
                    basis_text(ME_CYLINDER_OIL),
                    basis_text(AE_SYSTEM_OIL),
                    price_text,
                    status,
                ),
                weights,
                [("Edit", lambda v=row["vessel"]: self.edit_budget_basis(year, v))],
            )
        self.fluid(
            section,
            f"Values apply to {year} only and are never copied into another year. "
            "Cylinder allowance is for High BN + Low BN together; AE allowance is vessel-level.",
            wrap=900,
            padx=16,
            pady=(0, 12),
        )

        section = self.section("Stock-cover parameters", "per vessel, versioned")
        weights = (3, 3, 3, 4, 1)
        table = self.register_table(
            section,
            (
                "Vessel",
                "ME system oil · one full charge",
                "Latest sheet: ME system qty",
                "Source",
                "",
            ),
            weights,
        )
        for index, row in enumerate(rows, start=1):
            charge = row["charge"]
            quantity, month = self.latest_system_quantity(row["vessel"])
            self.register_row(
                table,
                index,
                (
                    vessel_title(row["vessel"]),
                    litres(charge["value"]) if charge else ("Not recorded", "neutral"),
                    (
                        f"{litres(quantity)} ({month_label(month, True)})"
                        if quantity is not None
                        else "—"
                    ),
                    (
                        (
                            charge["source_reference"][:48]
                            + ("…" if len(charge["source_reference"]) > 48 else "")
                        )
                        if charge
                        else "—"
                    ),
                ),
                weights,
                [("Edit", lambda v=row["vessel"]: self.edit_parameter(v))],
            )
        self.fluid(
            section,
            "Agreed rule: ME system oil storage ROB should hold one full charge at all times. "
            "Cylinder oil minimum: under assessment. Status thresholds stay provisional until agreed.",
            wrap=900,
            padx=16,
            pady=(0, 12),
        )

        section = self.section(
            "Bulk oil tanks",
            "storage only; machinery sump/system quantity is never counted as storage",
            link=("Add tank", lambda: self.edit_tank()),
        )
        if tanks:
            weights = (3, 2, 3, 3, 2, 2, 2, 2, 2)
            table = self.register_table(
                section,
                (
                    "Vessel",
                    "Tank",
                    "Holds",
                    "Grade",
                    "Physical (L)",
                    "Usable (L)",
                    "Minimum ROB (L)",
                    "Safety stock (L)",
                    "",
                ),
                weights,
            )
            labels = {
                "ME_SYSTEM_OIL": "ME system oil",
                "ME_CYLINDER_OIL_HIGH_BN": "Cylinder · High BN",
                "ME_CYLINDER_OIL_LOW_BN": "Cylinder · Low BN",
                "AE_SYSTEM_OIL": "AE system oil",
            }
            for index, tank in enumerate(tanks, start=1):
                self.register_row(
                    table,
                    index,
                    (
                        vessel_title(tank["vessel"]),
                        f"{tank['tank_identifier']} · {tank['tank_name']}",
                        labels.get(tank["oil_category"], tank["oil_category"]),
                        tank["assigned_grade"] or "—",
                        amount(tank["physical_capacity"], 0),
                        amount(tank["usable_capacity"], 0),
                        amount(tank["minimum_rob"], 0),
                        amount(tank["safety_stock"], 0),
                    ),
                    weights,
                    [
                        ("Edit", lambda t=tank: self.edit_tank(t)),
                        ("Retire", lambda t=tank: self.retire_tank(t)),
                    ],
                )
        else:
            self.fluid(
                section,
                "No tanks registered yet. Add each bulk tank from the vessel's capacity plan; "
                "a category can have more than one tank. Tank fill % appears on the cards once a tank is added.",
                wrap=900,
                padx=16,
                pady=(0, 14),
            )

        history = self.repo.master_history(25)
        section = self.section("Change history", "latest 25 master-data changes")
        if history:

            def change(item):
                new = json.loads(item["new_value"])
                old = json.loads(item["old_value"]) if item["old_value"] else None
                text = ", ".join(
                    f"{k.replace('_', ' ')} {old.get(k) if old else '—'} → {v}"
                    for k, v in new.items()
                    if k != "source_reference" and (old is None or old.get(k) != v)
                )
                return text or "source updated"

            self.table(
                section,
                ["When", "User", "Record", "Change", "Reason"],
                [
                    (
                        datetime.fromisoformat(h["created_at"])
                        .astimezone()
                        .strftime("%d %b %Y %H:%M"),
                        h["actor"],
                        h["record_key"].replace("|", " · "),
                        change(h),
                        h["reason"] or "—",
                    )
                    for h in history
                ],
                [140, 110, 280, 420, 200],
            )
        else:
            self.label(section, "No changes recorded yet.", 12, MUTED).pack(
                anchor="w", padx=16, pady=(0, 14)
            )

    # ---- Fleet Comparison: all vessels, or a user-defined suite vessel group ----
    FLEET_CATEGORIES = {
        "ME System Oil": ME_SYSTEM_OIL,
        "Cylinder Oil": ME_CYLINDER_OIL,
        "AE System Oil": AE_SYSTEM_OIL,
    }

    def fleet_scopes(self):
        vessels = self.repo.vessels()
        scopes = {f"All vessels ({len(vessels)})": (None, vessels)}
        for group in vessel_groups.groups(self.repo.root):
            scopes[f"Group: {group['name']} ({len(group['vessels'])})"] = (
                group["id"],
                group["vessels"],
            )
        return scopes

    def fleet_data(self, vessels):
        """Comparison ending at the latest month any vessel in scope has reported; nothing for an empty scope."""
        months = sorted(
            {
                r["month"]
                for r in self.reports
                if r.get("is_active")
                and r.get("month")
                and (r["vessel"] or r["data"]["vessel"]) in vessels
            }
        )
        if not months:
            return None
        year = int(months[-1][:4])
        basis, prices = {}, {}
        for vessel in vessels:
            try:
                basis[vessel] = self.repo.budget_basis(vessel, year)
                prices[vessel] = self.repo.reference_prices(vessel, year)
            except ValueError:
                pass
        return fleet_comparison(
            self.reports, vessels, months[-1], self.period_months, basis, prices
        )

    def render_fleet(self):
        scopes = self.fleet_scopes()
        key = next(
            (k for k, (gid, _) in scopes.items() if gid == self.fleet_group),
            next(iter(scopes)),
        )
        self.fleet_group, vessels = scopes[key]
        category = self.fleet_category
        data = self.fleet_data(vessels)
        label = next(
            name for name, value in self.FLEET_CATEGORIES.items() if value == category
        )
        color = GRADE_STYLE[CATEGORY_GROUPS[category][0]]["color"]

        top = ctk.CTkFrame(self.body, fg_color="transparent")
        top.pack(fill="x", pady=(0, 10))
        titles = ctk.CTkFrame(top, fg_color="transparent")
        titles.pack(side="left")
        self.label(titles, "Fleet Comparison", 20, INK, True).pack(anchor="w")
        if data:
            months, totals = data["months"], data["totals"][category]
            span = month_label(months[0]) + (
                "" if len(months) == 1 else f"–{month_label(months[-1], True)}"
            )
            period = (
                f"budget year {data['year']}, {span}"
                if self.period_months == "YTD"
                else span
            )
            caption = (
                f"{len(vessels)} vessels  ·  {period}  ·  "
                f"{totals['vessel_months']} of {totals['possible']} vessel-months reported"
            )
        else:
            caption = "None of these vessels has a monthly sheet in use yet."
        self.label(titles, caption, 12, MUTED).pack(anchor="w")
        tools = ctk.CTkFrame(top, fg_color="transparent")
        tools.pack(side="right")
        self.label(tools, "Compare:", 12, MUTED).pack(side="left", padx=(0, 6))
        scope = ctk.CTkOptionMenu(
            tools,
            values=list(scopes),
            width=250,
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
            command=lambda v: (
                setattr(self, "fleet_group", scopes[v][0]),
                self.show("Fleet"),
            ),
        )
        scope.set(key)
        scope.pack(side="left", padx=(0, 10))
        self.button(tools, "Manage groups", self.manage_groups, secondary=True).pack(
            side="left"
        )
        chooser = ctk.CTkSegmentedButton(
            self.body,
            values=list(self.FLEET_CATEGORIES),
            height=30,
            selected_color=ACCENT,
            selected_hover_color=ACCENT_HOVER,
            unselected_color="#9FB3C8",
            unselected_hover_color="#8AA2BB",
            text_color=WHITE,
            fg_color="#9FB3C8",
            font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
            command=lambda v: (
                setattr(self, "fleet_category", self.FLEET_CATEGORIES[v]),
                self.show("Fleet"),
            ),
        )
        chooser.set(label)
        chooser.pack(anchor="w", pady=(0, 12))
        if data is None:
            return

        budget = totals["budget"]
        if budget:
            over = budget["technical"] > 0
            budget_tile = (
                f"Budget {data['year']} YTD · {budget['vessels']} of {len(vessels)} vessels configured",
                "—" if budget["percent"] is None else f"{budget['percent']:+.1f}%",
                AMBER if over else GOOD,
            )
        else:
            budget_tile = (f"Budget {data['year']} YTD", "Not configured", MUTED)
        self.stat_tiles(
            (
                (f"{label} used · {span}", litres(totals["total"]), color),
                (
                    "Vessels reporting",
                    f"{totals['vessels_reporting']} of {len(vessels)}",
                    ACCENT,
                ),
                (
                    "Vessel-months reported",
                    f"{totals['vessel_months']} of {totals['possible']}",
                    GOOD if totals["vessel_months"] == totals["possible"] else AMBER,
                ),
                budget_tile,
            )
        )

        driven = category != AE_SYSTEM_OIL
        measure = (lambda f: f["rate"]) if driven else (lambda f: f["total"])
        entries = sorted(
            ((row["vessel"], row["categories"][category]) for row in data["vessels"]),
            key=lambda e: (
                e[1]["total"] is None,
                measure(e[1]) is None,
                -(measure(e[1]) or 0),
                e[0],
            ),
        )

        def budget_text(b):
            if not b["configured"]:
                return "Not configured"
            if b["adjusted"] is None or b["percent"] is None:
                return "—"
            return f"{b['percent']:+.1f}%" + (
                f"  ({b['covered']} of {b['months']} mo)"
                if b["covered"] < b["months"]
                else ""
            )

        rows = []
        for vessel, f in entries:
            reported = (
                f"{len(f['months'])} of {len(months)}" if f["months"] else "No reports"
            )
            rate = "—" if f["rate"] is None else f"{f['rate']:,.1f}"
            if category == ME_CYLINDER_OIL:
                high, low = (f["sub"][g] for g in CATEGORY_GROUPS[category])
                rows.append(
                    (
                        vessel_title(vessel),
                        reported,
                        amount(high, 0),
                        amount(low, 0),
                        amount(f["total"], 0),
                        rate,
                        budget_text(f["budget"]),
                    )
                )
            elif driven:
                rows.append(
                    (
                        vessel_title(vessel),
                        reported,
                        amount(f["total"], 0),
                        rate,
                        budget_text(f["budget"]),
                    )
                )
            else:
                rows.append(
                    (
                        vessel_title(vessel),
                        reported,
                        amount(f["total"], 0),
                        budget_text(f["budget"]),
                    )
                )
        if category == ME_CYLINDER_OIL:
            headings = [
                "Vessel",
                "Months reported",
                "High BN (L)",
                "Low BN (L)",
                "Total consumption (L)",
                "L/24h running",
                "Budget YTD %",
            ]
            widths = [190, 130, 120, 120, 160, 130, 190]
        elif driven:
            headings = [
                "Vessel",
                "Months reported",
                "Total consumption (L)",
                "L/24h running",
                "Budget YTD %",
            ]
            widths = [220, 150, 170, 150, 220]
        else:
            headings = ["Vessel", "Months reported", "Total consumption (L)", "Budget YTD %"]
            widths = [240, 170, 170, 260]

        def open_vessel(index):
            vessel = entries[index][0]
            if vessel not in self.vessel.cget("values"):
                return
            self.page = "Overview"
            self.vessel.set(vessel)
            self.change_vessel(vessel)

        table = self.section(f"{label} by vessel", "select a row to open that vessel")
        self.table(table, headings, rows, widths, open_vessel)
        rate_note = (
            "L/24h running = each sheet's own L/24h, weighted by ME running hours over the period "
            "(the same figure as the vessel cards); months without rate or hours are left out, not counted as zero. "
            if driven
            else "AE oil is not driven by ME running hours, so no L/24h is shown. "
        )
        self.label(
            table,
            "Months reported = months with this oil on a sheet in use; a missing month is not zero. "
            + rate_note
            + "Budget YTD % = actual vs allowance from 1 January (hours-adjusted for ME-driven oils), only where a "
            "basis is configured; the same figures as each vessel's Budget Performance page.",
            10,
            MUTED,
            wraplength=1000,
            justify="left",
        ).pack(anchor="w", padx=16, pady=(0, 12))

        charts = ctk.CTkFrame(self.body, fg_color="transparent")
        charts.pack(fill="x", pady=(14, 8))
        charts.grid_columnconfigure(0, weight=2, uniform="fleet")
        charts.grid_columnconfigure(1, weight=3, uniform="fleet")
        ranking = self.panel(
            charts, "Ranking", "L/24h running" if driven else "Total litres"
        )
        ranking.grid(row=0, column=0, sticky="nsew", padx=(0, 7))
        items = [
            (vessel_title(vessel), measure(f))
            for vessel, f in entries
            if measure(f) is not None
        ]
        fmt = (lambda v: f"{v:,.1f}") if driven else (lambda v: f"{v:,.0f} L")
        rank = tk.Canvas(
            ranking, height=30 * max(len(items), 1) + 16, bg=WHITE, highlightthickness=0
        )
        rank.pack(fill="x", padx=12, pady=(0, 4))
        rank.bind("<Configure>", lambda _e: draw_ranking(rank, items, color, fmt))
        unranked = len(entries) - len(items)
        if unranked:
            reason = (
                "no ME running hours or consumption reported"
                if driven
                else "no consumption reported"
            )
            self.label(
                ranking,
                f"{unranked} vessel{'s' if unranked > 1 else ''} not ranked: {reason} in the period "
                "(listed in the table above).",
                10,
                MUTED,
                wraplength=380,
                justify="left",
            ).pack(anchor="w", padx=16, pady=(0, 12))
        monthly = self.panel(
            charts,
            f"{'Fleet' if self.fleet_group is None else 'Group'} total by month",
            "Litres",
        )
        monthly.grid(row=0, column=1, sticky="new", padx=(7, 0))
        values = [m["total"] for m in totals["monthly"]]
        notes = [f"{m['vessels']} vsl" for m in totals["monthly"]]
        chart = tk.Canvas(monthly, height=260, bg=WHITE, highlightthickness=0)
        chart.pack(fill="x", padx=12)
        chart.bind(
            "<Configure>",
            lambda _e: draw_bars(chart, months, [(label, color, values)], notes=notes),
        )
        self.label(
            monthly,
            'Sum of the vessels that reported each month; "vsl" = how many. A rise can mean more sheets '
            "arrived, not higher consumption.",
            10,
            MUTED,
            wraplength=560,
            justify="left",
        ).pack(anchor="w", padx=16, pady=(4, 12))

    def manage_groups(self):
        """Create, edit and archive suite-wide vessel groups."""
        root = self.repo.root
        vessels = self.repo.vessels()
        window = self.dialog("Vessel groups", "900x620")
        self.label(window, "Vessel groups", 17, INK, True).pack(
            anchor="w", padx=20, pady=(16, 0)
        )
        self.label(
            window,
            "Groups are shared across NeraVeda. A vessel can belong to several groups; "
            "a group needs at least two vessels.",
            11,
            MUTED,
        ).pack(anchor="w", padx=20, pady=(0, 8))
        body = ctk.CTkFrame(window, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=20)
        body.grid_columnconfigure(1, weight=1)
        body.grid_rowconfigure(0, weight=1)
        listing = ctk.CTkScrollableFrame(
            body,
            width=210,
            fg_color=WHITE,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        listing.grid(row=0, column=0, sticky="ns", padx=(0, 12))
        form = ctk.CTkFrame(
            body, fg_color=WHITE, corner_radius=10, border_width=1, border_color=BORDER
        )
        form.grid(row=0, column=1, sticky="nsew")
        form.grid_columnconfigure((0, 1), weight=1)
        form.grid_rowconfigure(3, weight=1)
        name = self.form_entry(form, 0, 0, "Group name (required)")
        description = self.form_entry(form, 0, 1, "Description")
        self.label(form, "Vessels", 11, MUTED).grid(
            row=2, column=0, sticky="w", padx=12, pady=(8, 0)
        )
        picks = ctk.CTkScrollableFrame(form, fg_color="transparent", height=300)
        picks.grid(row=3, column=0, columnspan=2, sticky="nsew", padx=6)
        chosen = {}
        for index, vessel in enumerate(vessels):
            chosen[vessel] = tk.BooleanVar(value=False)
            ctk.CTkCheckBox(
                picks,
                text=vessel_title(vessel),
                variable=chosen[vessel],
                text_color=INK,
                fg_color=ACCENT,
                hover_color=ACCENT_HOVER,
                border_color="#9FB3C8",
                font=ctk.CTkFont(family="Segoe UI", size=12),
            ).grid(row=index // 3, column=index % 3, sticky="w", padx=10, pady=5)
        history = self.label(form, "", 10, MUTED, wraplength=560, justify="left")
        history.grid(row=4, column=0, columnspan=2, sticky="w", padx=12, pady=(4, 8))
        state = {"id": None}
        actions = ctk.CTkFrame(window, fg_color="transparent")
        actions.pack(fill="x", padx=20, pady=12)

        def load(group=None):
            state["id"] = group["id"] if group else None
            name.delete(0, "end")
            description.delete(0, "end")
            if group:
                name.insert(0, group["name"])
                description.insert(0, group["description"] or "")
            members = set(group["vessels"]) if group else set()
            for vessel, var in chosen.items():
                var.set(vessel in members)
            archive.configure(state="normal" if group else "disabled")
            lines = []
            if group:
                for entry in vessel_groups.group_history(root, group["id"])[-3:]:
                    stamp = datetime.fromisoformat(entry["created_at"]).astimezone()
                    lines.append(
                        f"{entry['action'].capitalize()} by {entry['actor']} on {stamp:%d %b %Y, %H:%M}"
                    )
            history.configure(
                text=(
                    "  ·  ".join(lines)
                    if lines
                    else "New group: tick the vessels to compare."
                )
            )

        def refresh_list(select=None):
            for child in listing.winfo_children():
                child.destroy()
            current = vessel_groups.groups(root)
            ctk.CTkButton(
                listing,
                text="+  New group",
                anchor="w",
                height=32,
                fg_color="transparent",
                hover_color="#E8EFF7",
                text_color=ACCENT,
                font=ctk.CTkFont(family="Segoe UI", size=12, weight="bold"),
                command=lambda: load(None),
            ).pack(fill="x", padx=4, pady=(4, 6))
            for group in current:
                ctk.CTkButton(
                    listing,
                    text=f"{group['name']}  ({len(group['vessels'])})",
                    anchor="w",
                    height=32,
                    fg_color=ACCENT_TINT if group["id"] == select else "transparent",
                    hover_color="#E8EFF7",
                    text_color=INK,
                    font=ctk.CTkFont(family="Segoe UI", size=12),
                    command=lambda g=group: (refresh_list(g["id"]), load(g)),
                ).pack(fill="x", padx=4, pady=1)
            return current

        def after_change(group_id):
            current = refresh_list(group_id)
            load(next((g for g in current if g["id"] == group_id), None))
            if self.page == "Fleet":
                self.show("Fleet")

        def save():
            members = [vessel for vessel, var in chosen.items() if var.get()]
            try:
                group_id = vessel_groups.save_group(
                    root, name.get(), members, description.get(), state["id"]
                )
            except ValueError as error:
                messagebox.showerror("Group not saved", str(error), parent=window)
                return
            self.log_activity(
                f"Vessel group '{' '.join(name.get().split())}' saved with {len(members)} vessels."
            )
            self.fleet_group = group_id
            after_change(group_id)

        def archive_selected():
            if state["id"] is None:
                return
            if not messagebox.askyesno(
                "Archive group",
                f"Archive the group '{name.get()}'? Its history is kept.",
                parent=window,
            ):
                return
            vessel_groups.archive_group(root, state["id"])
            self.log_activity(f"Vessel group '{name.get()}' archived.")
            if self.fleet_group == state["id"]:
                self.fleet_group = None
            after_change(None)

        self.button(actions, "Save group", save).pack(side="right")
        archive = self.button(
            actions, "Archive group", archive_selected, secondary=True
        )
        archive.pack(side="right", padx=(0, 8))
        self.button(actions, "Close", window.destroy, secondary=True).pack(side="left")
        groups = refresh_list(self.fleet_group)
        load(next((g for g in groups if g["id"] == self.fleet_group), None))

    def dialog(self, title, size="640x420"):
        window = ctk.CTkToplevel(self)
        window.title(title)
        window.geometry(size)
        window.configure(fg_color=BG)
        window.transient(self)
        window.after(150, window.grab_set)
        return window

    def form_entry(self, parent, row, column, label, value=None, width=None):
        self.label(parent, label, 11, MUTED).grid(
            row=row * 2, column=column, sticky="w", padx=12, pady=(8, 0)
        )
        entry = ctk.CTkEntry(
            parent,
            height=32,
            border_color=BORDER,
            fg_color=WHITE,
            text_color=INK,
            **({"width": width} if width else {}),
        )
        if value is not None:
            entry.insert(0, f"{value:g}" if isinstance(value, float) else str(value))
        entry.grid(row=row * 2 + 1, column=column, sticky="ew", padx=12, pady=(0, 4))
        return entry

    def edit_parameter(self, vessel):
        current = self.repo.parameter(vessel, "ME_SYSTEM_OIL_FULL_CHARGE")
        quantity, month = self.latest_system_quantity(vessel)
        window = self.dialog(
            f"ME system oil full charge · {vessel_title(vessel)}", "620x330"
        )
        self.label(
            window,
            f"{vessel_title(vessel)} · ME system oil, one full charge",
            17,
            INK,
            True,
        ).pack(anchor="w", padx=20, pady=(16, 0))
        hint = (
            f"Latest sheet ({month_label(month, True)}) reports ME system quantity {litres(quantity)}. "
            if quantity is not None
            else ""
        )
        self.label(
            window,
            hint
            + "Enter the confirmed full-charge quantity; it is not taken from the sheet automatically.",
            11,
            MUTED,
            wraplength=570,
            justify="left",
        ).pack(anchor="w", padx=20, pady=(0, 6))
        form = ctk.CTkFrame(
            window,
            fg_color=WHITE,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        form.pack(fill="x", padx=20)
        form.grid_columnconfigure((0, 1), weight=1)
        value = self.form_entry(
            form, 0, 0, "Full charge (L)", current and current["value"]
        )
        source = self.form_entry(
            form, 0, 1, "Source (required)", current and current["source_reference"]
        )
        remarks = self.form_entry(form, 1, 0, "Remarks", current and current["remarks"])

        def save():
            try:
                self.repo.set_parameter(
                    vessel,
                    "ME_SYSTEM_OIL_FULL_CHARGE",
                    value.get().strip(),
                    source.get(),
                    remarks.get().strip() or None,
                )
            except ValueError as error:
                messagebox.showerror("Not saved", str(error), parent=window)
                return
            self.log_activity(f"ME system oil full charge recorded for {vessel}.")
            window.destroy()
            self.show(self.page)

        self.button(window, "Save", save).pack(anchor="e", padx=20, pady=14)

    def edit_tank(self, tank=None):
        vessels = self.repo.vessels()
        categories = {
            "ME system oil": "ME_SYSTEM_OIL",
            "Cylinder oil · High BN": "ME_CYLINDER_OIL_HIGH_BN",
            "Cylinder oil · Low BN": "ME_CYLINDER_OIL_LOW_BN",
            "AE system oil": "AE_SYSTEM_OIL",
        }
        window = self.dialog("Edit bulk tank" if tank else "Add bulk tank", "720x520")
        self.label(window, "Bulk oil storage tank", 17, INK, True).pack(
            anchor="w", padx=20, pady=(16, 0)
        )
        self.label(
            window,
            "Storage only. Do not include the machinery sump or system quantity.",
            11,
            MUTED,
        ).pack(anchor="w", padx=20, pady=(0, 6))
        form = ctk.CTkFrame(
            window,
            fg_color=WHITE,
            corner_radius=10,
            border_width=1,
            border_color=BORDER,
        )
        form.pack(fill="x", padx=20)
        form.grid_columnconfigure((0, 1, 2), weight=1)
        menu = dict(
            fg_color=WHITE,
            button_color=ACCENT,
            button_hover_color=ACCENT_HOVER,
            text_color=INK,
            height=32,
        )
        self.label(form, "Vessel", 11, MUTED).grid(
            row=0, column=0, sticky="w", padx=12, pady=(8, 0)
        )
        vessel = ctk.CTkOptionMenu(form, values=vessels, **menu)
        vessel.set(
            tank["vessel"]
            if tank
            else (self.vessel.get() if self.vessel.get() in vessels else vessels[0])
        )
        vessel.grid(row=1, column=0, sticky="ew", padx=12)
        if tank:
            vessel.configure(state="disabled")
        self.label(form, "Holds", 11, MUTED).grid(
            row=0, column=1, sticky="w", padx=12, pady=(8, 0)
        )
        holds = ctk.CTkOptionMenu(form, values=list(categories), **menu)
        holds.set(
            next(
                (
                    k
                    for k, v in categories.items()
                    if tank and v == tank["oil_category"]
                ),
                "ME system oil",
            )
        )
        holds.grid(row=1, column=1, sticky="ew", padx=12)
        fields = {}
        for row, column, key, label in (
            (1, 2, "assigned_grade", "Assigned grade"),
            (2, 0, "tank_identifier", "Tank ID"),
            (2, 1, "tank_name", "Tank name"),
            (2, 2, "unit", "Unit"),
            (3, 0, "physical_capacity", "Physical capacity"),
            (3, 1, "usable_capacity", "Usable capacity"),
            (3, 2, "minimum_rob", "Minimum ROB"),
            (4, 0, "safety_stock", "Safety stock"),
            (4, 1, "source_reference", "Source (required)"),
            (4, 2, "remarks", "Remarks"),
        ):
            default = tank.get(key) if tank else ("L" if key == "unit" else None)
            if row == 1:
                self.label(form, label, 11, MUTED).grid(
                    row=0, column=column, sticky="w", padx=12, pady=(8, 0)
                )
                entry = ctk.CTkEntry(
                    form, height=32, border_color=BORDER, fg_color=WHITE, text_color=INK
                )
                if default:
                    entry.insert(0, default)
                entry.grid(row=1, column=column, sticky="ew", padx=12)
                fields[key] = entry
            else:
                fields[key] = self.form_entry(form, row, column, label, default)
        ctk.CTkFrame(form, height=10, fg_color="transparent").grid(row=10, column=0)

        def save():
            values = {k: e.get().strip() for k, e in fields.items()}
            try:
                self.repo.save_tank(
                    vessel.get(),
                    values.pop("tank_identifier"),
                    values.pop("tank_name"),
                    categories[holds.get()],
                    values.pop("physical_capacity"),
                    values.pop("usable_capacity"),
                    values.pop("source_reference"),
                    tank_id=tank["id"] if tank else None,
                    unit=values.pop("unit") or "L",
                    **{k: (v or None) for k, v in values.items()},
                )
            except ValueError as error:
                messagebox.showerror("Not saved", str(error), parent=window)
                return
            self.log_activity(
                f"Tank {'updated' if tank else 'added'} for {vessel.get()}."
            )
            window.destroy()
            self.show(self.page)

        self.button(window, "Save tank", save).pack(anchor="e", padx=20, pady=14)

    def retire_tank(self, tank):
        window = self.dialog(f"Retire tank {tank['tank_identifier']}", "560x260")
        self.label(
            window,
            f"Retire {tank['tank_identifier']} · {tank['tank_name']} ({vessel_title(tank['vessel'])})",
            15,
            INK,
            True,
        ).pack(anchor="w", padx=20, pady=(16, 4))
        self.label(
            window,
            "The tank stays in the history; it stops counting towards capacity from today.",
            11,
            MUTED,
        ).pack(anchor="w", padx=20)
        reason = ctk.CTkEntry(
            window,
            height=32,
            border_color=BORDER,
            fg_color=WHITE,
            placeholder_text="Reason (required)",
        )
        reason.pack(fill="x", padx=20, pady=12)

        def save():
            try:
                self.repo.retire_tank(tank["vessel"], tank["id"], reason.get())
            except ValueError as error:
                messagebox.showerror("Not retired", str(error), parent=window)
                return
            self.log_activity(
                f"Tank {tank['tank_identifier']} retired for {tank['vessel']}."
            )
            window.destroy()
            self.show(self.page)

        self.button(window, "Retire tank", save).pack(anchor="e", padx=20)

    def import_files(self):
        if self.busy:
            return
        paths = filedialog.askopenfilenames(
            parent=self,
            title="Import vessel reports",
            filetypes=[("Supported Excel reports", "*.xlsx")],
        )
        if paths:
            self.start_import(paths)

    def import_folder(self):
        if self.busy:
            return
        folder = filedialog.askdirectory(
            parent=self, title="Select report folder (includes subfolders)"
        )
        if folder:
            paths = [
                p
                for p in Path(folder).rglob("*.xlsx")
                if p.is_file() and not p.name.startswith("~$")
            ]
            self.start_import(paths)

    def log_activity(self, message):
        entry = f"{datetime.now().astimezone():%Y-%m-%d %H:%M:%S}  {message}"
        self.activity_log.append(entry)
        if len(self.activity_log) > 500:
            del self.activity_log[:-500]
        if self.activity_box is not None and self.page == "Activity":
            self.activity_box.configure(state="normal")
            self.activity_box.insert("end", entry + "\n")
            self.activity_box.see("end")
            self.activity_box.configure(state="disabled")

    def render_activity(self):
        self.heading(
            "Activity log",
            "Live Outlook search and import events for this app session. Message bodies and recipients are not collected.",
        )
        panel = self.section("Session Activity", "newest at the bottom")
        self.activity_box = ctk.CTkTextbox(
            panel,
            fg_color=TABLE_HEAD,
            text_color=INK,
            border_width=0,
            height=420,
            corner_radius=8,
            font=("Consolas", 12),
            wrap="word",
        )
        self.activity_box.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        if self.activity_log:
            self.activity_box.insert("end", "\n".join(self.activity_log) + "\n")
            self.activity_box.see("end")
        else:
            self.activity_box.insert(
                "end",
                "No activity yet. Start an Outlook search to see progress here.\n",
            )
        self.activity_box.configure(state="disabled")

    def open_outlook_download(self):
        if self.busy or self.closing:
            return
        dialog = ctk.CTkToplevel(self)
        dialog.title("Get lube-oil reports from Outlook")
        dialog.geometry("660x520")
        dialog.minsize(620, 500)
        dialog.transient(self)
        dialog.grid_columnconfigure(0, weight=1)
        self.label(dialog, "Find the lube-oil Excel source", 23, bold=True).grid(
            row=0, column=0, sticky="w", padx=26, pady=(24, 6)
        )
        self.label(
            dialog,
            "Searches the classic Outlook Inbox and its subfolders for emails whose subject contains "
            "“LUBE OIL STOCK AND CONSUMPTION” within the inclusive received-date range. "
            "Only .xlsx attachments are saved; PDFs and other file types are skipped.",
            13,
            MUTED,
            wraplength=590,
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=26, pady=(0, 12))
        self.label(
            dialog,
            "Workbook vessel and reporting month are read from each attachment. Messages are not moved, "
            "marked read, or otherwise changed.",
            12,
            ACCENT,
            wraplength=590,
            justify="left",
        ).grid(row=2, column=0, sticky="w", padx=26, pady=(0, 14))

        dates = preset_range("Previous Month")
        start_value = tk.StringVar(value=dates[0].strftime("%d-%b-%Y"))
        end_value = tk.StringVar(value=dates[1].strftime("%d-%b-%Y"))
        date_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        date_frame.grid(row=3, column=0, sticky="ew", padx=26, pady=(0, 14))
        date_frame.grid_columnconfigure((0, 1), weight=1)
        for column, (title, variable) in enumerate(
            (("From date", start_value), ("To date", end_value))
        ):
            self.label(date_frame, title, 12, MUTED, True).grid(
                row=0, column=column, sticky="w", padx=(0, 12)
            )
            entry = ctk.CTkEntry(
                date_frame, textvariable=variable, height=38, font=("Segoe UI", 13)
            )
            entry.grid(row=1, column=column, sticky="ew", padx=(0, 12))
            self.button(
                date_frame,
                "Choose date",
                lambda v=variable, t=title: DatePicker(
                    self, f"Choose {t.lower()}", v.get(), v.set
                ),
                secondary=True,
            ).grid(row=2, column=column, sticky="w", padx=(0, 12), pady=(8, 0))

        folder_value = tk.StringVar(
            value=str(DEFAULT_OUTPUT / "Lub Oil Consumption Review Downloads")
        )
        self.label(dialog, "Download location", 12, MUTED, True).grid(
            row=4, column=0, sticky="w", padx=26, pady=(4, 4)
        )
        folder_frame = ctk.CTkFrame(dialog, fg_color="transparent")
        folder_frame.grid(row=5, column=0, sticky="ew", padx=26)
        folder_frame.grid_columnconfigure(0, weight=1)
        ctk.CTkEntry(folder_frame, textvariable=folder_value, height=36).grid(
            row=0, column=0, sticky="ew"
        )

        def choose_folder():
            selected = filedialog.askdirectory(
                parent=dialog, title="Choose download location"
            )
            if selected:
                folder_value.set(selected)

        self.button(
            folder_frame, "Browse", choose_folder, secondary=True, width=90
        ).grid(row=0, column=1, padx=(10, 0))
        self.label(
            dialog,
            "Saved workbooks are archived and used for analysis immediately.",
            12,
            ACCENT,
            wraplength=590,
        ).grid(row=6, column=0, sticky="w", padx=26, pady=(10, 8))
        actions = ctk.CTkFrame(dialog, fg_color="transparent")
        actions.grid(row=7, column=0, sticky="ew", padx=26, pady=(14, 24))
        self.button(actions, "Cancel", dialog.destroy, secondary=True, width=110).pack(
            side="left"
        )

        def begin_download():
            try:
                start, end = parse_range(start_value.get(), end_value.get())
                folder = Path(folder_value.get().strip()).expanduser()
                if not folder_value.get().strip():
                    raise ValueError("Choose a download location.")
                self.download_paths = []
                self.download_error = None
                self.download_summary = None
                self.transfer_notice = None
                self.log_activity(
                    f"Outlook search requested · subject contains {SUBJECT_PHRASE!r} · "
                    f"received {start.date().isoformat()} through {end.date().isoformat()}"
                )
                self.stop.clear()
                self.busy = True
                self.set_transfer_controls(False)
                self.status.configure(
                    text="Connecting to classic Outlook · searching matching mail…"
                )

                def work():
                    try:
                        result = download_outlook_attachments(
                            start.date(),
                            end.date(),
                            folder,
                            emit=lambda kind, **data: self.events.put(
                                ("download", (kind, data))
                            ),
                            stop=self.stop,
                        )
                        self.events.put(
                            (
                                "download",
                                (
                                    "completed",
                                    {
                                        "matching_emails": result.matching_emails,
                                        "skipped_attachments": result.skipped_attachments,
                                    },
                                ),
                            )
                        )
                    except OutlookDownloadError as error:
                        self.events.put(
                            (
                                "download",
                                (
                                    "fatal",
                                    {
                                        "message": str(error),
                                        "paths": [
                                            str(path) for path in error.downloaded_paths
                                        ],
                                    },
                                ),
                            )
                        )
                    except Exception as error:
                        self.events.put(
                            ("download", ("fatal", {"message": str(error)}))
                        )
                    finally:
                        self.events.put(("download", ("finished", None)))

                self.download_thread = threading.Thread(
                    target=work, name="Lub-oil-Outlook", daemon=False
                )
                try:
                    self.download_thread.start()
                except RuntimeError:
                    self.download_thread = None
                    self.busy = False
                    self.set_transfer_controls(True)
                    raise
                dialog.destroy()
            except (ValueError, RuntimeError) as error:
                messagebox.showerror("Download setup", str(error), parent=dialog)

        self.button(actions, "Search Outlook & review", begin_download, width=190).pack(
            side="right"
        )

    def set_transfer_controls(self, enabled):
        state = "normal" if enabled else "disabled"
        self.import_button.configure(state=state)
        self.folder_button.configure(state=state)
        self.download_button.configure(state=state)

    def start_import(self, paths):
        if self.busy:
            return
        self.busy = True
        self.stop.clear()
        self.import_log = []
        self.set_transfer_controls(False)
        self.status.configure(
            text=f"Importing {len(paths)} files · originals preserved · reports are used immediately"
        )

        def work():
            try:
                self.repo.import_paths(
                    paths, lambda r: self.events.put(("file", r)), self.stop
                )
            finally:
                self.events.put(("finished", None))

        threading.Thread(target=work, name="Lub-oil-import", daemon=False).start()

    def poll(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "file":
                    self.import_log.append(payload)
                    self.status.configure(
                        text=f"{len(self.import_log)} files processed · {payload['filename']} · {payload['status']}"
                    )
                    self.log_activity(
                        f"Import {payload['status'].lower()} · {payload['filename']} · {payload['detail']}"
                    )
                elif kind == "finished":
                    self.busy = False
                    if self.closing:
                        self.finish_close_if_ready()
                        continue
                    self.set_transfer_controls(True)
                    self.page = "Reports"
                    self.refresh()
                    if self.transfer_notice:
                        imported = sum(
                            item["status"] == "Imported" for item in self.import_log
                        )
                        duplicates = sum(
                            item["status"] == "Duplicate" for item in self.import_log
                        )
                        failed = sum(
                            item["status"] in ("Failed", "Not usable")
                            for item in self.import_log
                        )
                        self.status.configure(
                            text=(
                                f"{self.transfer_notice} · {imported} imported · "
                                f"{duplicates} duplicate(s) · {failed} import failure(s)."
                            )
                        )
                        self.log_activity(self.status.cget("text"))
                        self.transfer_notice = None
                elif kind == "download":
                    event_kind, data = payload
                    if event_kind == "log":
                        self.log_activity(data["message"])
                        self.status.configure(text=data["message"])
                    elif event_kind == "matched":
                        self.log_activity(
                            f"Matching email · received {data['received']} · subject: {data['subject']}"
                        )
                    elif event_kind == "skipped":
                        self.log_activity(
                            f"Skipped attachment · {data['filename']} · {data['reason']}"
                        )
                    elif event_kind == "saved":
                        path = data["path"]
                        if Path(path).suffix.lower() == ".xlsx":
                            if path not in self.download_paths:
                                self.download_paths.append(path)
                                self.log_activity(f"Saved Excel attachment · {path}")
                        else:
                            self.download_error = (
                                f"Outlook returned an unexpected file type: {path}"
                            )
                            self.log_activity(self.download_error)
                    elif event_kind == "completed":
                        self.download_summary = data
                    elif event_kind == "fatal":
                        self.download_error = data["message"]
                        self.download_paths.extend(data.get("paths", []))
                        self.log_activity(
                            f"Outlook search error · {self.download_error}"
                        )
                    elif event_kind == "finished":
                        self.busy = False
                        if self.closing:
                            self.download_thread = None
                            self.finish_close_if_ready()
                            continue
                        self.download_thread = None
                        if self.download_paths:
                            downloaded = list(dict.fromkeys(self.download_paths))
                            if self.download_error:
                                self.transfer_notice = f"Outlook search stopped with an error: {self.download_error}"
                            else:
                                self.transfer_notice = "Outlook search complete"
                            self.status.configure(
                                text="Importing saved Outlook workbooks to review…"
                            )
                            self.log_activity(self.status.cget("text"))
                            self.start_import(downloaded)
                        else:
                            self.set_transfer_controls(True)
                            if self.download_error:
                                self.status.configure(
                                    text=f"Outlook search failed: {self.download_error}"
                                )
                            elif (
                                self.download_summary
                                and self.download_summary["matching_emails"]
                            ):
                                self.status.configure(
                                    text=(
                                        f"Found {self.download_summary['matching_emails']} matching email(s), "
                                        "but none had a supported .xlsx attachment."
                                    )
                                )
                            else:
                                self.status.configure(
                                    text=(
                                        "No Outlook email subject matched that phrase in the selected "
                                        "received-date range."
                                    )
                                )
                            self.log_activity(self.status.cget("text"))
        except queue.Empty:
            pass
        self.timer = self.after(100, self.poll)

    def close_app(self):
        self.closing = True
        self.stop.set()
        if self.busy:
            self.status.configure(
                text="Finishing the current download or import before closing…"
            )
        self.finish_close_if_ready()

    def finish_close_if_ready(self):
        if (
            self.closing
            and not self.busy
            and (self.download_thread is None or not self.download_thread.is_alive())
        ):
            if self.timer is not None:
                self.after_cancel(self.timer)
                self.timer = None
            self.destroy()


def main(root=None):
    ctk.set_appearance_mode("light")
    ReviewApp(root).mainloop()
