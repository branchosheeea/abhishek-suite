"""Launcher dashboard for Neraveda (formerly Abhishek Automation Suite)."""
from __future__ import annotations

import os
import queue
import sqlite3
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk

from vessel_report.scroll_input import ScrollRouter
from suite_services.storage import runtime_root

PROJECT_ROOT = Path(__file__).resolve().parent

# ── Colour tokens (shared language with the Lube Oil workspace) ─────────────
BG       = "#F3F6F9"
SURFACE  = "#FFFFFF"
INK      = "#0F1B2A"
MUTED    = "#5F6B7A"
FAINT    = "#8A96A5"
SEP      = "#E3E8EE"
NAVY     = "#0E2A47"
NAV_HV   = "#173A5E"
NAV_TEXT = "#D3DFEB"
NAV_MUTE = "#8FA6BE"
GOOD     = "#1E7A45"
GOOD_BG  = "#E3F4EA"
IDLE_BG  = "#EEF1F4"

# Single unified action colour — one action colour, no rainbow
BTN     = "#1557A0"
BTN_HV  = "#114888"

TWO_COLUMN_WIDTH = 1180  # window width at which the cards sit two-up

_MOD: dict[str, dict] = {
    "vessel": {"accent": "#0B7267", "tint": "#E4F3F0", "badge": "VRC"},
    "oil":    {"accent": "#1760D3", "tint": "#E6EFFC", "badge": "LOR"},
    "voyage": {"accent": "#5248C8", "tint": "#EDEAFC", "badge": "VS"},
    "gc":     {"accent": "#A86B10", "tint": "#FCF3E2", "badge": "GCM"},
    "cjc":    {"accent": "#B03A2E", "tint": "#FBECEA", "badge": "CJC"},
}

CJC_FOLDER = "Critical Jobs Compliance"


# ── Module launchers ──────────────────────────────────────────────────────────

def _project_python(project_root):
    env = project_root / ".venv" / "Scripts" / "python.exe"
    return str(env) if env.is_file() else sys.executable


def _launch(args, cwd):
    """Popen without a visible console window on Windows."""
    return subprocess.Popen(
        args, cwd=str(cwd),
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def start_vessel_report_manager(project_root=PROJECT_ROOT):
    if not (project_root / "vessel_report" / "__main__.py").is_file():
        raise FileNotFoundError("Vessel Report Centre module was not found.")
    return _launch([_project_python(project_root), "-m", "vessel_report"], project_root)


def start_lub_oil_review(project_root=PROJECT_ROOT):
    if not (project_root / "lube_oil" / "__main__.py").is_file():
        raise FileNotFoundError("Lub Oil Consumption Review module was not found.")
    return _launch([_project_python(project_root), "-m", "lube_oil"], project_root)


def start_voyage_summary(project_root=PROJECT_ROOT):
    if not (project_root / "voyage_summary" / "__main__.py").is_file():
        raise FileNotFoundError("Voyage Summary module was not found.")
    return _launch([_project_python(project_root), "-m", "voyage_summary"], project_root)


def start_gc_manager(project_root=PROJECT_ROOT):
    if not (project_root / "gc_manager" / "__main__.py").is_file():
        raise FileNotFoundError("Guarantee Claim Manager module was not found.")
    return _launch([_project_python(project_root), "-m", "gc_manager"], project_root)


def start_critical_job_compliance(project_root=PROJECT_ROOT):
    folder = project_root / CJC_FOLDER
    if not (folder / "__main__.py").is_file():
        raise FileNotFoundError("Critical Job Compliance module was not found.")
    return _launch([_project_python(project_root), str(folder)], project_root)


# Workspace catalogue: key, eyebrow, number, title, description, button text, sidebar name
WORKSPACES = (
    ("vessel", "REPORT COLLECTION", "01", "Vessel Report Centre",
     "Collect vessel reports from MariApps/PAL, organise attachments and track each run.",
     "Open Vessel Report Centre", "Vessel Report Centre"),
    ("oil", "TECHNICAL REVIEW", "02", "Lub Oil Consumption Review",
     "Track lube oil consumption and stock from the vessels' monthly sheets.",
     "Open Lub Oil Review", "Lub Oil Review"),
    ("voyage", "VOYAGE INTELLIGENCE", "03", "Voyage Summary",
     "Monitor performance, cargo efficiency, fuel burn and vessel status in one operational view.",
     "Open Voyage Summary", "Voyage Summary"),
    ("gc", "CLAIM TRACKING", "04", "Guarantee Claim Manager",
     "Register vessel warranty claims, review Outlook evidence and track follow-ups.",
     "Open Guarantee Claims", "Guarantee Claims"),
    ("cjc", "PMS COMPLIANCE", "05", "Critical Job Compliance",
     "Extract and verify the Critical Job Plan population from MariApps for evidence-based compliance review.",
     "Open Critical Job Compliance", "Critical Jobs"),
)


# ── App ───────────────────────────────────────────────────────────────────────

class AutomationSuite(ctk.CTk):

    def __init__(self):
        super().__init__()
        self.title("Neraveda")
        self.geometry("1240x800")
        self.minsize(980, 640)
        self.configure(fg_color=BG)

        self.project_process = None
        self.lub_process     = None
        self.voyage_process  = None
        self.gc_process      = None
        self.cjc_process     = None
        self.health_events   = queue.Queue()
        self.scroll_router   = ScrollRouter(self)
        self.running         = {key: False for key, *_ in WORKSPACES}
        self.status_pills    = {}
        self.nav_status      = {}
        self.descriptions    = []
        self.columns         = None

        sidebar = ctk.CTkFrame(self, width=248, fg_color=NAVY, corner_radius=0)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        right = ctk.CTkFrame(self, fg_color=BG, corner_radius=0)
        right.pack(side="left", fill="both", expand=True)

        # Fixed header — always visible, never scrolls
        header = ctk.CTkFrame(right, fg_color=BG, corner_radius=0)
        header.pack(fill="x", side="top")
        self._build_header(header)
        ctk.CTkFrame(right, height=1, fg_color=SEP, corner_radius=0).pack(fill="x", side="top", padx=36)

        page = self.page = ctk.CTkScrollableFrame(
            right, fg_color=BG, corner_radius=0,
            scrollbar_button_color="#C3CAD3",
            scrollbar_button_hover_color="#A9B2BD",
        )
        page.pack(fill="both", expand=True, padx=(12, 4))
        page.grid_columnconfigure(0, weight=1)

        self.grid_host = ctk.CTkFrame(page, fg_color="transparent")
        self.grid_host.grid(row=0, column=0, sticky="ew", padx=(20, 14), pady=(18, 0))

        cards = {}
        for key, eyebrow, number, title, description, button_text, _ in WORKSPACES:
            cards[key] = self._workspace_card(key, eyebrow, number, title, description, button_text)
        self._vessel_card, self.launch_button = cards["vessel"]
        self._oil_card, self.oil_button = cards["oil"]
        self._voyage_card, self.voyage_button = cards["voyage"]
        self._gc_card, self.gc_button = cards["gc"]
        self._cjc_card, self.cjc_button = cards["cjc"]
        self._cards = [self._vessel_card, self._oil_card, self._voyage_card, self._gc_card, self._cjc_card]
        self._add_oil_chips()

        self._build_coming_soon(page, row=1)
        self._build_footer(page, row=2)
        self._build_sidebar(sidebar)

        self._layout(1)
        self.bind("<Configure>", self._on_resize, add="+")
        self.scroll_router.attach(page)
        self._update_summary()
        self.refresh_oil_health()

    # ── Header (fixed) ────────────────────────────────────────────────────────

    def _build_header(self, bar):
        bar.grid_columnconfigure(0, weight=1)
        hour = datetime.now().hour
        greeting = "Good morning" if hour < 12 else "Good afternoon" if hour < 18 else "Good evening"
        self._lbl(bar, f"{greeting}  ·  {datetime.now():%A, %d %B %Y}", 11, FAINT).grid(
            row=0, column=0, sticky="w", padx=36, pady=(26, 2))
        self._lbl(bar, "Every report. One clear view.", 26, INK, True).grid(
            row=1, column=0, sticky="w", padx=36)
        self.subtitle = self._lbl(
            bar,
            "Five focused workspaces for vessel reporting, technical review, voyage intelligence, warranty tracking "
            "and PMS compliance.",
            12, MUTED, justify="left", wraplength=560,
        )
        self.subtitle.grid(row=2, column=0, columnspan=2, sticky="w", padx=36, pady=(4, 20))
        self.summary_chip = ctk.CTkLabel(
            bar, text="4 ACTIVE", fg_color=GOOD_BG, text_color=GOOD, corner_radius=14, height=30,
            font=ctk.CTkFont("Segoe UI", 11, weight="bold"),
        )
        self.summary_chip.grid(row=1, column=1, sticky="e", padx=(0, 36))

    # ── Sidebar ───────────────────────────────────────────────────────────────

    def _build_sidebar(self, sidebar):
        brand = ctk.CTkFrame(sidebar, fg_color="transparent")
        brand.pack(fill="x", padx=22, pady=(28, 0))
        mark = ctk.CTkFrame(brand, width=46, height=46, fg_color=BTN, corner_radius=14)
        mark.pack(side="left", padx=(0, 14))
        mark.pack_propagate(False)
        self._lbl(mark, "N", 22, "#FFFFFF", True).pack(expand=True)
        info = ctk.CTkFrame(brand, fg_color="transparent")
        info.pack(side="left", anchor="center")
        self._lbl(info, "Neraveda", 16, "#FFFFFF", True).pack(anchor="w")
        self._lbl(info, "Automation Suite", 11, NAV_MUTE).pack(anchor="w")

        ctk.CTkFrame(sidebar, height=1, fg_color=NAV_HV).pack(fill="x", padx=20, pady=(24, 18))
        self._lbl(sidebar, "WORKSPACES", 10, NAV_MUTE, True).pack(anchor="w", padx=26, pady=(0, 8))
        for (key, *_rest, nav_name), card in zip(WORKSPACES, self._cards):
            self._nav_item(sidebar, key, nav_name, lambda c=card: self._scroll_to(c))

        ctk.CTkFrame(sidebar, fg_color="transparent").pack(fill="both", expand=True)
        ctk.CTkFrame(sidebar, height=1, fg_color=NAV_HV).pack(fill="x", padx=20, pady=(0, 14))
        self._lbl(sidebar, "Smarter Data.\nSharper Decisions.\nSmoother Sailing.", 13, NAV_TEXT, justify="left").pack(anchor="w", padx=26)
        self._lbl(sidebar, "v2026  ·  AKG", 10, NAV_MUTE).pack(anchor="w", padx=26, pady=(8, 24))

    def _nav_item(self, sidebar, key, name, cmd):
        m = _MOD[key]
        row = ctk.CTkFrame(sidebar, fg_color="transparent", corner_radius=10, cursor="hand2", height=44)
        row.pack(fill="x", padx=14, pady=2)
        row.pack_propagate(False)
        badge = ctk.CTkFrame(row, width=30, height=30, fg_color=m["tint"], corner_radius=8)
        badge.pack(side="left", padx=(10, 12))
        badge.pack_propagate(False)
        initials = ctk.CTkLabel(badge, text=m["badge"], text_color=m["accent"],
                                font=ctk.CTkFont("Segoe UI", 8, weight="bold"))
        initials.pack(expand=True)
        lbl = ctk.CTkLabel(row, text=name, text_color=NAV_TEXT, anchor="w", font=ctk.CTkFont("Segoe UI", 13))
        lbl.pack(side="left")
        status = ctk.CTkFrame(row, width=8, height=8, fg_color="transparent", corner_radius=4)
        status.pack(side="right", padx=14)
        self.nav_status[key] = status
        _on  = lambda _: row.configure(fg_color=NAV_HV)
        _off = lambda _: row.configure(fg_color="transparent")
        _clk = lambda _: cmd()
        for w in (row, badge, initials, lbl):
            w.bind("<Enter>", _on, add="+")
            w.bind("<Leave>", _off, add="+")
            w.bind("<Button-1>", _clk, add="+")

    def _scroll_to(self, widget):
        def _do():
            try:
                self.update_idletasks()
                canvas = self.page._parent_canvas
                sf     = self.page._scrollable_frame
                y      = widget.winfo_rooty() - sf.winfo_rooty()
                total  = sf.winfo_reqheight()
                vis    = canvas.winfo_height()
                if total > vis:
                    canvas.yview_moveto(max(0.0, (y - 20) / total))
            except Exception:
                pass
        self.after(80, _do)

    # ── Workspace cards ───────────────────────────────────────────────────────

    def _workspace_card(self, key, eyebrow, number, title, description, button_text):
        m = _MOD[key]
        card = ctk.CTkFrame(self.grid_host, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=16)
        ctk.CTkFrame(card, height=4, fg_color=m["accent"], corner_radius=2).pack(fill="x", padx=18, pady=(10, 0))

        head = ctk.CTkFrame(card, fg_color="transparent")
        head.pack(fill="x", padx=22, pady=(16, 0))
        badge = ctk.CTkFrame(head, width=50, height=50, fg_color=m["tint"], corner_radius=14)
        badge.pack(side="left")
        badge.pack_propagate(False)
        self._lbl(badge, m["badge"], 12, m["accent"], True).pack(expand=True)
        titles = ctk.CTkFrame(head, fg_color="transparent")
        titles.pack(side="left", fill="x", expand=True, padx=(14, 8))
        self._lbl(titles, f"{eyebrow}  ·  WORKSPACE {number}", 9, m["accent"], True).pack(anchor="w")
        self._lbl(titles, title, 18, INK, True).pack(anchor="w", pady=(2, 0))
        status = ctk.CTkLabel(head, text="Ready", fg_color=IDLE_BG, text_color=MUTED, corner_radius=11,
                              height=24, width=78, font=ctk.CTkFont("Segoe UI", 10, weight="bold"))
        status.pack(side="right", anchor="n")
        self.status_pills[key] = status

        desc = self._lbl(card, description, 12, MUTED, justify="left", wraplength=440)
        desc.pack(anchor="w", padx=22, pady=(12, 0))
        self.descriptions.append(desc)
        # Optional info row (chips); packed only by cards that use it, so empty cards stay compact.
        card.meta = ctk.CTkFrame(card, fg_color="transparent", height=1)
        card.meta_anchor = desc

        ctk.CTkFrame(card, fg_color="transparent", height=1).pack(fill="both", expand=True)
        ctk.CTkFrame(card, height=1, fg_color=SEP).pack(fill="x", padx=22, pady=(14, 0))
        foot = ctk.CTkFrame(card, fg_color="transparent")
        foot.pack(fill="x", padx=22, pady=(14, 18))
        button = ctk.CTkButton(
            foot, text=button_text, command=getattr(self, {
                "vessel": "open_project", "oil": "open_lub_oil",
                "voyage": "open_voyage_summary", "gc": "open_gc_manager",
                "cjc": "open_critical_jobs"}[key]),
            fg_color=BTN, hover_color=BTN_HV, text_color="#FFFFFF", text_color_disabled="#E6EDF5",
            height=40, corner_radius=10, font=ctk.CTkFont("Segoe UI", 12, weight="bold"),
        )
        button.pack(side="left")
        self._lbl(foot, "Opens in its own window", 10, FAINT).pack(side="right")
        return card, button

    def _add_oil_chips(self):
        self._oil_card.meta.pack(anchor="w", padx=22, pady=(10, 0), after=self._oil_card.meta_anchor)
        chip_font = ctk.CTkFont("Segoe UI", 11, weight="bold")
        chip = dict(fg_color=_MOD["oil"]["tint"], text_color=_MOD["oil"]["accent"], corner_radius=8, height=26,
                    font=chip_font)
        self.latest_value = ctk.CTkLabel(self._oil_card.meta, text="Latest: —", **chip)
        self.latest_value.pack(side="left", padx=(0, 8))
        self.reports_value = ctk.CTkLabel(self._oil_card.meta, text="Reports: —", **chip)
        self.reports_value.pack(side="left")

    def _layout(self, columns):
        """Two-up grid on wide windows, a single column on narrow ones. Order never changes."""
        if columns == self.columns:
            return
        self.columns = columns
        for index in range(2):
            self.grid_host.grid_columnconfigure(index, weight=1 if index < columns else 0,
                                                uniform="cards" if index < columns else "")
        for index, card in enumerate(self._cards):
            row, column = divmod(index, columns)
            card.grid(row=row, column=column, sticky="nsew",
                      padx=(0, 9) if columns == 2 and column == 0 else (9, 0) if columns == 2 else 0,
                      pady=(0, 18))
        wrap = 430 if columns == 2 else 560
        for label in self.descriptions:
            label.configure(wraplength=wrap)
        self.subtitle.configure(wraplength=900 if columns == 2 else 560)

    def _on_resize(self, event):
        if event.widget is self:
            # Configure events report physical pixels; compare in logical (unscaled) pixels.
            width = event.width / ctk.ScalingTracker.get_window_scaling(self)
            self._layout(2 if width >= TWO_COLUMN_WIDTH else 1)

    def _build_coming_soon(self, page, row):
        band = ctk.CTkFrame(page, fg_color="transparent")
        band.grid(row=row, column=0, sticky="ew", padx=(20, 14), pady=(0, 0))
        band.grid_columnconfigure(0, weight=1, uniform="ph")
        band.grid_columnconfigure(1, weight=1, uniform="ph")
        for col in range(2):
            ph = ctk.CTkFrame(band, fg_color="transparent", border_width=1, border_color="#D5DCE4", corner_radius=16)
            ph.grid(row=0, column=col, sticky="ew", padx=(0, 9) if col == 0 else (9, 0))
            inner = ctk.CTkFrame(ph, fg_color="transparent")
            inner.pack(expand=True, pady=26)
            plus = ctk.CTkFrame(inner, width=30, height=30, fg_color=IDLE_BG, corner_radius=15)
            plus.pack(side="left", padx=(0, 10))
            plus.pack_propagate(False)
            self._lbl(plus, "+", 15, FAINT, True).pack(expand=True)
            self._lbl(inner, "Workspace coming soon", 12, FAINT).pack(side="left")

    def _build_footer(self, page, row):
        f = ctk.CTkFrame(page, fg_color="transparent")
        f.grid(row=row, column=0, sticky="ew", padx=(20, 14), pady=(22, 24))
        ctk.CTkFrame(f, height=1, fg_color=SEP).pack(fill="x")
        self._lbl(f, "ABHISHEK AUTOMATION SUITE  ·  BUILT FOR OPERATIONAL CLARITY",
                  9, FAINT, True).pack(anchor="w", pady=(10, 0))

    # ── Running state ─────────────────────────────────────────────────────────

    def _set_running(self, key, running):
        self.running[key] = running
        pill = self.status_pills.get(key)
        if pill is not None:
            pill.configure(text="● Running" if running else "Ready",
                           fg_color=GOOD_BG if running else IDLE_BG, text_color=GOOD if running else MUTED)
        dot = self.nav_status.get(key)
        if dot is not None:
            dot.configure(fg_color="#4ADE80" if running else "transparent")
        button = {"vessel": "launch_button", "oil": "oil_button", "voyage": "voyage_button", "gc": "gc_button",
                  "cjc": "cjc_button"}.get(key)
        if button and hasattr(self, button):
            # An open workspace reads as "already open", not as a dimmed primary action.
            getattr(self, button).configure(fg_color=GOOD_BG if running else BTN,
                                            text_color_disabled=GOOD if running else "#E6EDF5")
        self._update_summary()

    def _update_summary(self):
        open_count = sum(self.running.values())
        text = f"{len(WORKSPACES)} WORKSPACES" + (f"  ·  {open_count} OPEN" if open_count else "")
        self.summary_chip.configure(text=f"  {text}  ")

    # ── Widget helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _lbl(parent, text, size=13, color=INK, bold=False, **kwargs):
        return ctk.CTkLabel(
            parent, text=text, text_color=color,
            font=ctk.CTkFont("Segoe UI", size, weight="bold" if bold else "normal"),
            anchor="w", **kwargs,
        )

    # Legacy aliases for test compatibility
    @staticmethod
    def label(parent, text, size=13, color=INK, bold=False, **kwargs):
        return AutomationSuite._lbl(parent, text, size, color, bold, **kwargs)

    @staticmethod
    def pill(parent, text, background, foreground):
        return ctk.CTkLabel(parent, text=text, fg_color=background, text_color=foreground,
                            corner_radius=8, height=29,
                            font=ctk.CTkFont("Segoe UI", 10, weight="bold"))

    @staticmethod
    def action_button(parent, text, command, secondary=False, **kwargs):
        fg  = "#E9F5F2" if secondary else "#0C796F"
        hov = "#DDEFEA" if secondary else "#09645C"
        txt = "#0C796F" if secondary else "#FFFFFF"
        return ctk.CTkButton(parent, text=text, command=command, height=40, corner_radius=10,
                             fg_color=fg, hover_color=hov, text_color=txt,
                             font=ctk.CTkFont("Segoe UI", 12, weight="bold"), **kwargs)

    # ── Open actions ──────────────────────────────────────────────────────────

    def open_project(self):
        if self.project_process is not None and self.project_process.poll() is None:
            return
        try:
            self.project_process = start_vessel_report_manager()
        except OSError as error:
            messagebox.showerror("Could not open project", str(error), parent=self)
            return
        self.launch_button.configure(state="disabled", text="Vessel Report Centre is open")
        self._set_running("vessel", True)
        self.after(1000, self.check_project_process)

    def open_lub_oil(self):
        if self.lub_process is not None and self.lub_process.poll() is None:
            return
        try:
            self.lub_process = start_lub_oil_review()
        except OSError as error:
            messagebox.showerror("Could not open module", str(error), parent=self)
            return
        self.oil_button.configure(state="disabled", text="Lub Oil Review is open")
        self._set_running("oil", True)
        self.after(1000, self.check_lub_process)

    def open_voyage_summary(self):
        if self.voyage_process is not None and self.voyage_process.poll() is None:
            return
        try:
            self.voyage_process = start_voyage_summary()
        except OSError as error:
            messagebox.showerror("Could not open voyage summary", str(error), parent=self)
            return
        self.voyage_button.configure(state="disabled", text="Voyage Summary is open")
        self._set_running("voyage", True)
        self.after(1000, self.check_voyage_process)

    def open_gc_manager(self):
        if self.gc_process is not None and self.gc_process.poll() is None:
            return
        try:
            self.gc_process = start_gc_manager()
        except OSError as error:
            messagebox.showerror("Could not open Guarantee Claim Manager", str(error), parent=self)
            return
        self.gc_button.configure(state="disabled", text="Guarantee Claims is open")
        self._set_running("gc", True)
        self.after(1000, self.check_gc_process)

    def open_critical_jobs(self):
        if self.cjc_process is not None and self.cjc_process.poll() is None:
            return
        try:
            self.cjc_process = start_critical_job_compliance()
        except OSError as error:
            messagebox.showerror("Could not open Critical Job Compliance", str(error), parent=self)
            return
        self.cjc_button.configure(state="disabled", text="Critical Job Compliance is open")
        self._set_running("cjc", True)
        self.after(1000, self.check_cjc_process)

    def check_cjc_process(self):
        if self.cjc_process is not None and self.cjc_process.poll() is None:
            self.after(1000, self.check_cjc_process)
        else:
            self.cjc_button.configure(state="normal", text="Open Critical Job Compliance")
            self._set_running("cjc", False)

    # ── Health polling ────────────────────────────────────────────────────────

    def check_lub_process(self):
        if self.lub_process is not None and self.lub_process.poll() is None:
            self.after(1000, self.check_lub_process)
        else:
            self.oil_button.configure(state="normal", text="Open Lub Oil Review")
            self._set_running("oil", False)
            self.refresh_oil_health()

    def refresh_oil_health(self):
        def read():
            database = runtime_root() / "suite.sqlite3"
            if not database.is_file():
                self.health_events.put((None, 0))
                return
            try:
                db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)
                try:
                    latest, active = db.execute(
                        "SELECT MAX(month),COUNT(*) FROM monthly_reports WHERE is_active=1"
                    ).fetchone()
                    self.health_events.put((latest, active))
                finally:
                    db.close()
            except (sqlite3.Error, ValueError):
                self.health_events.put(None)
        threading.Thread(target=read, daemon=True).start()
        self.after(100, self.poll_oil_health)

    def poll_oil_health(self):
        try:
            health = self.health_events.get_nowait()
        except queue.Empty:
            self.after(100, self.poll_oil_health)
            return
        if health is None:
            self.latest_value.configure(text="Latest: Unavailable")
            self.reports_value.configure(text="Reports: —")
            return
        latest, active = health
        if latest:
            try:
                latest = datetime.strptime(latest + "-01", "%Y-%m-%d").strftime("%b %Y")
            except ValueError:
                pass
        self.latest_value.configure(text=f"Latest sheet: {latest or 'No data'}")
        self.reports_value.configure(text=f"{active:,} reports in use")

    def check_project_process(self):
        if self.project_process is not None and self.project_process.poll() is None:
            self.after(1000, self.check_project_process)
        else:
            self.launch_button.configure(state="normal", text="Open Vessel Report Centre")
            self._set_running("vessel", False)

    def check_voyage_process(self):
        if self.voyage_process is not None and self.voyage_process.poll() is None:
            self.after(1000, self.check_voyage_process)
        else:
            self.voyage_button.configure(state="normal", text="Open Voyage Summary")
            self._set_running("voyage", False)

    def check_gc_process(self):
        if self.gc_process is not None and self.gc_process.poll() is None:
            self.after(1000, self.check_gc_process)
        else:
            self.gc_button.configure(state="normal", text="Open Guarantee Claims")
            self._set_running("gc", False)

    def open_project_folder(self):
        try:
            os.startfile(str(PROJECT_ROOT))
        except OSError as error:
            messagebox.showerror("Could not open project folder", str(error), parent=self)


if __name__ == "__main__":
    ctk.set_appearance_mode("light")
    ctk.set_default_color_theme("blue")
    AutomationSuite().mainloop()
