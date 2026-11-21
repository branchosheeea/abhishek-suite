"""NeraVeda home: the Fleet Intelligence view and workspace launcher (formerly Abhishek Automation Suite).

The home page shows the latest results each workspace has already saved (suite_services.home_intelligence).
It never fetches from MariApps, Outlook or vessels itself; each workspace stays responsible for its sources,
rules and analysis.
"""
from __future__ import annotations

import functools
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from datetime import datetime
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk

from vessel_report.scroll_input import ScrollRouter
from suite_services import emissions_server, home_intelligence, inspection_server
from suite_services.access.session import AccessDenied, AccessService, PasswordChangeRequired, SessionExpired

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
# Workspace "Open" buttons are tonal (same blue as text on a light tint), so the home page's colour goes to
# what needs attention rather than to seven identical solid buttons.
OPEN_BG = "#E6EEF9"
OPEN_HV = "#D4E2F5"
FOCUS_RING = "#1557A0"
FOCUS_RING_NAV = "#9CC6FF"

# Severity colours are kept apart from module identity colours: they appear only as labelled pills.
SEVERITY_STYLE = {
    home_intelligence.ACTION: ("#FBE9E6", "#8F2414", "▲"),
    home_intelligence.REVIEW: ("#FFF1D6", "#6E4500", "●"),
}
STATE_INK = "#46525F"  # headline colour for anything other than a normal saved result (the text states it)

_MOD: dict[str, dict] = {
    "vessel": {"accent": "#0B7267", "tint": "#E4F3F0", "badge": "VRC"},
    "oil":    {"accent": "#1760D3", "tint": "#E6EFFC", "badge": "LOR"},
    "voyage": {"accent": "#5248C8", "tint": "#EDEAFC", "badge": "VS"},
    "gc":     {"accent": "#A86B10", "tint": "#FCF3E2", "badge": "GCM"},
    "cjc":    {"accent": "#B03A2E", "tint": "#FBECEA", "badge": "CJC"},
    "sir":    {"accent": "#0E6E8C", "tint": "#E2F2F7", "badge": "SIR"},
    "evi":    {"accent": "#2F6B4F", "tint": "#E9F1EC", "badge": "EVI"},
}

CJC_FOLDER = "Critical Jobs Compliance"
SIDEBAR_WIDTH = 248


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
     "Report collection and attachment management from MariApps/PAL.",
     "Open Vessel Report Centre", "Vessel Report Centre"),
    ("oil", "TECHNICAL REVIEW", "02", "Lub Oil Consumption Review",
     "Monthly lube oil consumption and stock review from vessel sheets.",
     "Open Lub Oil Review", "Lub Oil Review"),
    ("voyage", "VOYAGE INTELLIGENCE", "03", "Voyage Summary",
     "Voyage performance, cargo, fuel and bunker view from the noon report.",
     "Open Voyage Summary", "Voyage Summary"),
    ("gc", "CLAIM TRACKING", "04", "Guarantee Claim Manager",
     "Warranty claim register with Outlook evidence and follow-up tracking.",
     "Open Guarantee Claims", "Guarantee Claims"),
    ("cjc", "PMS COMPLIANCE", "05", "Critical Job Compliance",
     "Critical job plan extraction and verification for PMS compliance review.",
     "Open Critical Job Compliance", "Critical Jobs"),
    ("sir", "VESSEL INSPECTION", "06", "Superintendent Inspection Report",
     "Offline inspection reports with photos, cloud sync and PDF export.",
     "Open Inspection Reports", "Superintendent Inspection"),
    ("evi", "EMISSIONS REPORTING", "07", "DNV Emissions Validation",
     "Read-only validation and investigation of DNV emissions reporting. Original files are never changed.",
     "Open Emissions Validation", "Emissions Validation"),
)
TITLES = {key: title for key, _e, _n, title, *_ in WORKSPACES}
OPEN_METHOD = {"vessel": "open_project", "oil": "open_lub_oil", "voyage": "open_voyage_summary",
               "gc": "open_gc_manager", "cjc": "open_critical_jobs", "sir": "open_inspection_reports",
               "evi": "open_emissions_validation"}
BUTTON_ATTR = {"vessel": "launch_button", "oil": "oil_button", "voyage": "voyage_button", "gc": "gc_button",
               "cjc": "cjc_button", "sir": "sir_button", "evi": "evi_button"}
PROCESS_ATTR = {"vessel": "project_process", "oil": "lub_process", "voyage": "voyage_process",
                "gc": "gc_process", "cjc": "cjc_process", "sir": "sir_process", "evi": "evi_process"}
WEB_WORKSPACES = ("sir", "evi")  # served by a local web server; the card button stays usable while running

SIR_LOG = PROJECT_ROOT / "diagnostics" / "superintendent_inspection_server.log"
EVI_LOG = PROJECT_ROOT / "diagnostics" / "emissions_validation_server.log"


def _requires(key):
    """Open a workspace only when the signed-in person may use it (checked on every path: card, review, keyboard)."""
    def wrap(method):
        @functools.wraps(method)
        def inner(self, *args, **kwargs):
            if not self._may_open(key):
                return None
            return method(self, *args, **kwargs)
        return inner
    return wrap


# ── App ───────────────────────────────────────────────────────────────────────

class AutomationSuite(ctk.CTk):

    def __init__(self, access=None):
        super().__init__()
        self.title("NeraVeda")
        self._fit_to_screen()
        self.minsize(980, 600)
        self.configure(fg_color=BG)
        # Sign-in and rights (suite_services.access). Tests pass a FakeAccess; local mode keeps the old behaviour.
        self.access = access if access is not None else AccessService.from_config()
        self._allowed = []
        self._signin_events = queue.Queue()
        self._access_events = queue.Queue()
        self.signin_panel = None
        self.sir_target = self.evi_target = "/"
        self.sir_port = self.evi_port = None
        self.protocol("WM_DELETE_WINDOW", self.on_close)

        self.project_process = None
        self.lub_process     = None
        self.voyage_process  = None
        self.gc_process      = None
        self.cjc_process     = None
        self.sir_process     = None
        self.sir_mode        = None
        self.sir_url         = None
        self.sir_events      = queue.Queue()
        self.evi_process     = None
        self.evi_mode        = None
        self.evi_url         = None
        self.evi_events      = queue.Queue()
        self.intel           = None   # None while the first load is running
        self.intel_events    = queue.Queue()
        self._intel_busy     = False
        self._intel_again    = None   # None, or fetch_sir flag for a queued reload
        self.scroll_router   = ScrollRouter(self)
        self.running         = {key: False for key, *_ in WORKSPACES}
        self.columns         = None
        self.content_width   = 900
        self.attention_limit = 4
        self.attention_rows  = []
        self.tiles           = {}
        self._nav_rows       = {}
        self._dashboard_built = False

        if self.access.cached() is not None:
            self._build_dashboard()
        else:
            self._show_signin()

    # ── Sign-in ───────────────────────────────────────────────────────────────

    def _show_signin(self):
        from suite_services.access.ui import SignInPanel
        methods = getattr(self.access, "signin_methods", {"microsoft": True, "password": False})
        self.signin_panel = SignInPanel(self, on_sign_in=self._sign_in_interactive, on_code=self._sign_in_with_code,
                                        on_password=self._sign_in_with_password, on_close=self.destroy, methods=methods,
                                        needs_setup=bool(getattr(self.access, "needs_setup", False)))
        self.signin_panel.pack(fill="both", expand=True)
        if not getattr(self.access, "needs_setup", False) and methods.get("microsoft"):
            self._run_signin(self.access.try_silent, "Checking for a signed-in Microsoft account…", silent=True)

    def _sign_in_with_password(self, email, password, new_password=None):
        text = "Setting your password and signing in…" if new_password else "Checking your NeraVeda ID and password…"
        self._run_signin(lambda: self.access.sign_in_with_password(email, password, new_password), text)

    def _window_handle(self):
        try:
            import ctypes
            return ctypes.windll.user32.GetAncestor(self.winfo_id(), 2) or None
        except Exception:
            return None

    def _sign_in_interactive(self):
        handle = self._window_handle()
        self._run_signin(lambda: self.access.sign_in(handle), "Complete the sign-in in the Microsoft window or browser…")

    def _sign_in_with_code(self):
        self._run_signin(lambda: self.access.sign_in_with_code(lambda message: self._signin_events.put(("code", message))),
                         "Getting a sign-in code…")

    def _run_signin(self, fn, text, silent=False):
        self.signin_panel.busy(text)

        def work():
            try:
                self._signin_events.put(("done", fn(), silent))
            except PasswordChangeRequired as error:
                self._signin_events.put(("change", error, silent))
            except AccessDenied as error:
                self._signin_events.put(("denied", error, silent))
            except Exception as error:
                self._signin_events.put(("failed", error, silent))
        threading.Thread(target=work, daemon=True).start()
        self.after(200, self._poll_signin)

    def _poll_signin(self):
        try:
            event = self._signin_events.get_nowait()
        except queue.Empty:
            self.after(200, self._poll_signin)
            return
        except tk.TclError:
            return
        kind, value = event[0], event[1]
        if kind == "code":
            self.signin_panel.show_code(value)
            self.after(200, self._poll_signin)
        elif kind == "done" and value is not None:
            self.signin_panel.destroy()
            self.signin_panel = None
            self._build_dashboard()
        elif kind == "done":
            self.signin_panel.ready("")  # no cached Microsoft account: wait for the person to sign in
        elif kind == "change":
            self.signin_panel.ready()
            self.signin_panel.ask_new_password(str(value))
        elif kind == "denied":
            email = getattr(value, "email", None)
            self.signin_panel.ready()
            self.signin_panel.clear_password()
            self.signin_panel.error("No access to NeraVeda" if email else "Not signed in", str(value), email)
        elif event[2]:
            self.signin_panel.ready("")  # a failed silent attempt is not an error worth showing
        else:
            self.signin_panel.ready()
            self.signin_panel.error("Sign-in did not complete", str(value))

    # ── Home screen ──────────────────────────────────────────────────────────

    def _build_dashboard(self):
        self._dashboard_built = True
        self._allowed = [key for key in home_intelligence.ORDER if self.access.allows(key)]
        sidebar = ctk.CTkFrame(self, width=SIDEBAR_WIDTH, fg_color=NAVY, corner_radius=0)
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

        # One card per workspace (what it knows, when, what needs attention, Open), then the attention list.
        self._build_workspaces(page)
        self._build_attention(page)
        self._build_footer(page, row=5)
        self._build_sidebar(sidebar)

        self._layout(self._logical_width())
        self.bind("<Configure>", self._on_resize, add="+")
        self.scroll_router.attach(page)
        self.render_intelligence()
        self.refresh_intelligence(fetch_sir=True)
        self._schedule_access_refresh()

    def _fit_to_screen(self):
        """1240x800 where it fits; otherwise the available screen, so nothing sits under the taskbar."""
        try:
            scale = ctk.ScalingTracker.get_window_scaling(self)
            width = min(1240, int(self.winfo_screenwidth() / scale) - 40)
            height = min(800, int(self.winfo_screenheight() / scale) - 90)
        except Exception:
            width, height = 1240, 800
        self.geometry(f"{max(width, 980)}x{max(height, 600)}")
        self._initial_size = (max(width, 980), max(height, 600))

    def _logical_width(self):
        return self._initial_size[0]

    # ── Header (fixed) ────────────────────────────────────────────────────────

    def _build_header(self, bar):
        """One compact band: page title and date on the left, who is signed in on the right."""
        bar.grid_columnconfigure(0, weight=1)
        hour = datetime.now().hour
        greeting = "Good morning" if hour < 12 else "Good afternoon" if hour < 18 else "Good evening"
        self._txt(bar, "Fleet Intelligence", 20, INK, True).grid(row=0, column=0, sticky="sw", padx=36, pady=(14, 0))
        self._txt(bar, f"{greeting}  ·  {datetime.now():%A, %d %B %Y}", 11, MUTED).grid(
            row=1, column=0, sticky="nw", padx=36, pady=(3, 12))

        # Who is signed in, and what they can do here (name and note, then the buttons beside them)
        self.user_box = ctk.CTkFrame(bar, fg_color="transparent")
        self.user_box.grid(row=0, column=1, rowspan=2, sticky="e", padx=(12, 36), pady=(10, 8))
        who = ctk.CTkFrame(self.user_box, fg_color="transparent")
        who.pack(side="left")
        self.user_name = self._txt(who, "", 12, INK, True, justify="right")
        self.user_name.pack(anchor="e")
        self.user_note = self._txt(who, "", 10, MUTED, justify="right")
        self.user_note.pack(anchor="e", pady=(2, 0))
        # height/width 1: with no button shown (local mode) the frame must not keep CTkFrame's default 200 px,
        # which stretched the whole header.
        actions = ctk.CTkFrame(self.user_box, fg_color="transparent", height=1, width=1)
        actions.pack(side="left", padx=(14, 0))
        self.admin_button = ctk.CTkButton(
            actions, text="Admin", command=self.open_admin, width=74, height=28, corner_radius=8, fg_color=IDLE_BG,
            hover_color=SEP, text_color=BTN, border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"))
        self.sign_out_button = ctk.CTkButton(
            actions, text="Sign out", command=self.sign_out, width=82, height=28, corner_radius=8, fg_color=IDLE_BG,
            hover_color=SEP, text_color=INK, border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"))
        self.password_button = ctk.CTkButton(
            actions, text="Change password", command=self.change_password, width=128, height=28, corner_radius=8, fg_color=IDLE_BG,
            hover_color=SEP, text_color=BTN, border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"))
        self._focusable(self.admin_button)
        self._focusable(self.password_button)
        self._focusable(self.sign_out_button)
        self._update_user_box()

    def _update_user_box(self):
        access = self.access
        if getattr(access, "local_mode", False):
            self.user_name.configure(text=access.user_label)
            self.user_note.configure(text="Sign-in not set up · all workspaces (local mode)")
            self.admin_button.pack_forget()
            self.password_button.pack_forget()
            self.sign_out_button.pack_forget()
            return
        self.user_name.configure(text=access.user_label)
        note = "Admin" if access.is_admin else ""
        if access.offline:
            when = ""
            session = getattr(access, "session", None)
            if session is not None:
                when = f" (last checked {datetime.fromtimestamp(session.verified_at):%d %b %H:%M})"
            note = "Offline: working from your last checked rights" + when
        self.user_note.configure(text=note)
        self.admin_button.pack_forget()
        self.password_button.pack_forget()
        self.sign_out_button.pack_forget()
        if access.can_administer:
            self.admin_button.pack(side="left", padx=(0, 6))
        if getattr(access, "password_user", False):
            self.password_button.pack(side="left", padx=(0, 6))
        self.sign_out_button.pack(side="left")

    # ── Sidebar ───────────────────────────────────────────────────────────────

    def _build_sidebar(self, sidebar):
        brand = ctk.CTkFrame(sidebar, fg_color="transparent")
        brand.pack(fill="x", padx=22, pady=(20, 0))
        mark = ctk.CTkFrame(brand, width=46, height=46, fg_color=BTN, corner_radius=14)
        mark.pack(side="left", padx=(0, 14))
        mark.pack_propagate(False)
        self._lbl(mark, "N", 22, "#FFFFFF", True).pack(expand=True)
        info = ctk.CTkFrame(brand, fg_color="transparent")
        info.pack(side="left", anchor="center")
        self._lbl(info, "NeraVeda", 16, "#FFFFFF", True).pack(anchor="w")
        self._lbl(info, "Fleet Intelligence Suite", 11, NAV_MUTE).pack(anchor="w")

        ctk.CTkFrame(sidebar, height=1, fg_color=NAV_HV).pack(fill="x", padx=20, pady=(16, 10))
        self._nav_item(sidebar, None, "Home", self.scroll_home, active=True)
        self._txt(sidebar, "WORKSPACES", 10, NAV_MUTE, True).pack(anchor="w", padx=26, pady=(12, 6))
        for key, *_rest, nav_name in WORKSPACES:
            if key not in self._allowed:
                continue  # workspaces this person may not use are not shown at all
            card = self._card_by_key[key]
            self._nav_rows[key] = self._nav_item(sidebar, key, nav_name, lambda c=card: self._scroll_to(c))

        ctk.CTkFrame(sidebar, fg_color="transparent").pack(fill="both", expand=True)
        ctk.CTkFrame(sidebar, height=1, fg_color=NAV_HV).pack(fill="x", padx=20, pady=(0, 12))
        self.sidebar_tagline = self._txt(sidebar, "Smarter Data.\nSharper Decisions.\nSmoother Sailing.", 12,
                                         NAV_TEXT, justify="left")
        self.sidebar_tagline.pack(anchor="w", padx=26)
        self._txt(sidebar, "v2026  ·  AKG", 10, NAV_MUTE).pack(anchor="w", padx=26, pady=(6, 16))
        self._tagline_shown = True

    def _nav_item(self, sidebar, key, name, cmd, active=False):
        row = ctk.CTkFrame(sidebar, fg_color=NAV_HV if active else "transparent", corner_radius=10,
                           cursor="hand2", height=37, border_width=0, border_color=FOCUS_RING_NAV)
        row.pack(fill="x", padx=14, pady=1)
        row.pack_propagate(False)
        if key is None:
            badge = ctk.CTkFrame(row, width=28, height=28, fg_color=NAVY if active else NAV_HV, corner_radius=8)
            glyph, glyph_color = "⌂", "#FFFFFF"
        else:
            badge = ctk.CTkFrame(row, width=28, height=28, fg_color=_MOD[key]["tint"], corner_radius=8)
            glyph, glyph_color = _MOD[key]["badge"], _MOD[key]["accent"]
        badge.pack(side="left", padx=(10, 12))
        badge.pack_propagate(False)
        initials = ctk.CTkLabel(badge, text=glyph, text_color=glyph_color,
                                font=ctk.CTkFont("Segoe UI", 15 if key is None else 8, weight="bold"))
        initials.pack(expand=True)
        lbl = ctk.CTkLabel(row, text=name, text_color="#FFFFFF" if active else NAV_TEXT, anchor="w",
                           font=ctk.CTkFont("Segoe UI", 13, weight="bold" if active else "normal"))
        lbl.pack(side="left")
        rest = NAV_HV if active else "transparent"
        _on  = lambda _: row.configure(fg_color=NAV_HV)
        _off = lambda _: row.configure(fg_color=rest)
        _clk = lambda _: cmd()
        for w in (row, badge, initials, lbl):
            w.bind("<Enter>", _on, add="+")
            w.bind("<Leave>", _off, add="+")
            w.bind("<Button-1>", _clk, add="+")
        # Keyboard: Tab reaches each item, Enter/Space activates it, focus shows a ring.
        tk.Frame.configure(row, takefocus=1)
        tk.Frame.bind(row, "<FocusIn>", lambda _: row.configure(border_width=2), "+")
        tk.Frame.bind(row, "<FocusOut>", lambda _: row.configure(border_width=0), "+")
        tk.Frame.bind(row, "<Return>", _clk, "+")
        tk.Frame.bind(row, "<space>", _clk, "+")
        return row

    def scroll_home(self):
        try:
            self.page._parent_canvas.yview_moveto(0)
        except Exception:
            pass

    def _scroll_to(self, widget):
        def _do():
            try:
                self.update_idletasks()
                canvas = self.page._parent_canvas
                sf     = self.page  # CTkScrollableFrame is itself the frame inside the canvas
                y      = widget.winfo_rooty() - sf.winfo_rooty()
                total  = sf.winfo_reqheight()
                vis    = canvas.winfo_height()
                if total > vis:
                    canvas.yview_moveto(max(0.0, (y - 20) / total))
            except Exception:
                pass
        self.after(80, _do)

    def _ensure_visible(self, widget):
        """Scroll the page so a keyboard-focused widget is on screen."""
        try:
            canvas = self.page._parent_canvas
            frame = self.page  # CTkScrollableFrame is itself the frame inside the canvas
            total = frame.winfo_reqheight()
            if total <= canvas.winfo_height():
                return
            top = widget.winfo_rooty() - frame.winfo_rooty()
            bottom = top + widget.winfo_height()
            first, last = canvas.yview()
            if top < first * total or bottom > last * total:
                canvas.yview_moveto(max(0.0, (top - 40) / total))
        except Exception:
            pass

    # ── Section scaffolding ───────────────────────────────────────────────────

    def _section_header(self, page, row, title, caption, pady=(14, 8)):
        bar = ctk.CTkFrame(page, fg_color="transparent")
        bar.grid(row=row, column=0, sticky="ew", padx=(20, 14), pady=pady)
        bar.grid_columnconfigure(1, weight=1)
        self._txt(bar, title, 15, INK, True).grid(row=0, column=0, sticky="w")
        caption_label = self._txt(bar, caption, 11, MUTED)
        caption_label.grid(row=0, column=1, sticky="w", padx=(12, 0))
        return bar

    # ── Needs attention ───────────────────────────────────────────────────────

    def _build_attention(self, page):
        self._section_header(page, 2, "Needs attention", "From the latest completed review in each workspace",
                             pady=(16, 8))
        self.attention_box = ctk.CTkFrame(page, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=12)
        self.attention_box.grid(row=3, column=0, sticky="ew", padx=(20, 14))
        self.attention_more = self._txt(page, "", 11, MUTED, justify="left")
        self.attention_more.grid(row=4, column=0, sticky="w", padx=(24, 14), pady=(5, 0))

    def _render_attention(self):
        for child in self.attention_box.winfo_children():
            child.destroy()
        self.attention_rows = []
        if self.intel is None:
            self._lbl(self.attention_box, "Loading saved results…", 12, MUTED).pack(anchor="w", padx=16, pady=14)
            self.attention_more.configure(text="")
            return
        shown, hidden = home_intelligence.top_attention(self.intel, self.attention_limit)
        if not shown:
            unread = [home_intelligence.NAMES[k] for k in self._allowed
                      if self.intel[k].state in ("not_connected", "none", "error", "failed")]
            text = "No attention item in the saved results NeraVeda can read."
            if unread:
                text += " Not included because no completed result is available: " + ", ".join(unread) + "."
            self._lbl(self.attention_box, text, 12, MUTED, justify="left",
                      wraplength=self.content_width - 40).pack(anchor="w", padx=16, pady=14)
        for index, item in enumerate(shown):
            if index:
                ctk.CTkFrame(self.attention_box, height=1, fg_color=SEP).pack(fill="x", padx=14)
            self.attention_rows.append(self._attention_row(item))
        if hidden:
            parts = [f"{count} more in {home_intelligence.NAMES[key]}" for key, count in
                     sorted(hidden.items(), key=lambda kv: home_intelligence.ORDER.index(kv[0]))]
            self.attention_more.configure(text=" · ".join(parts) + ". Open the workspace to review all items.")
        else:
            self.attention_more.configure(text="")
        self._place_attention_rows()
        self.scroll_router.attach(self.attention_box)

    def _attention_row(self, item):
        row = ctk.CTkFrame(self.attention_box, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=8)
        row.grid_columnconfigure(1, weight=1)
        background, foreground, icon = SEVERITY_STYLE[item.severity]
        ctk.CTkLabel(row, text=f"{icon}  {home_intelligence.SEVERITY_LABEL[item.severity]}", fg_color=background,
                     text_color=foreground, corner_radius=8, height=24, width=136,
                     font=ctk.CTkFont("Segoe UI", 10, weight="bold")).grid(row=0, column=0, sticky="nw", pady=(1, 0))
        text = ctk.CTkFrame(row, fg_color="transparent")
        text.grid(row=0, column=1, sticky="ew", padx=(12, 12))
        title = self._txt(text, f"{item.vessel}  ·  {item.issue}", 12, INK, True, justify="left")
        title.pack(anchor="w")
        reason = self._txt(text, item.reason, 11, MUTED, justify="left")
        reason.pack(anchor="w", pady=(3, 0))
        source = ctk.CTkFrame(row, fg_color="transparent")
        self._txt(source, home_intelligence.NAMES[item.workspace], 11, INK, True).pack(anchor="w")
        provenance = self._txt(source, f"{item.period} · {item.processed}", 10, MUTED, justify="left")
        provenance.pack(anchor="w", pady=(3, 0))
        button = ctk.CTkButton(row, text="Review  →", command=lambda i=item: self.review(i), width=96, height=30,
                               corner_radius=8, fg_color=IDLE_BG, hover_color=SEP, text_color=BTN,
                               border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"))
        button.grid(row=0, column=3, sticky="ne")
        self._focusable(button, page_widget=True)
        return {"row": row, "source": source, "title": title, "reason": reason, "reason_text": item.reason,
                "provenance": provenance}

    def _place_attention_rows(self):
        narrow = self.content_width < 820
        text_width = self.content_width - 136 - 96 - 64 - (0 if narrow else 220)
        width = max(220, text_width)
        reason_chars = max(40, int(width / 6.2))  # one line of reason; the workspace holds the full detail
        for entry in self.attention_rows:
            if narrow:
                entry["row"].grid_columnconfigure(2, minsize=0)
                entry["source"].grid(row=1, column=1, sticky="w", padx=(12, 12), pady=(4, 0))
            else:
                # Same source column on every row (grid minsize is in raw pixels, so apply display scaling).
                entry["row"].grid_columnconfigure(2, minsize=int(236 * ctk.ScalingTracker.get_widget_scaling(self)))
                entry["source"].grid(row=0, column=2, sticky="nw", padx=(0, 14))
            entry["title"].configure(wraplength=width)
            text = entry["reason_text"]
            if len(text) > reason_chars:
                text = text[:reason_chars - 1].rstrip() + "…"
            entry["reason"].configure(text=text, wraplength=width + 60)
            entry["provenance"].configure(wraplength=width if narrow else 216)
        self.attention_more.configure(wraplength=self.content_width - 20)

    def review(self, item):
        """Open the workspace that produced an attention item."""
        if not self._may_open(item.workspace):
            return
        if item.workspace == "sir":
            self.open_inspection_reports(item.target)
            return
        if item.workspace == "evi":
            self.open_emissions_validation(item.target)
            return
        process = getattr(self, PROCESS_ATTR[item.workspace])
        if process is not None and process.poll() is None:
            messagebox.showinfo("Already open", f"{TITLES[item.workspace]} is already open in its own window.",
                                parent=self)
            return
        getattr(self, OPEN_METHOD[item.workspace])()

    # ── Workspaces ────────────────────────────────────────────────────────────

    def _build_workspaces(self, page):
        bar = self._section_header(page, 0, "Workspaces", "Latest saved result from each workspace · not live data",
                                   pady=(14, 8))
        self.reload_button = ctk.CTkButton(
            bar, text="Reload saved results", command=lambda: self.refresh_intelligence(fetch_sir=True),
            fg_color="transparent", hover_color=IDLE_BG, text_color=BTN, height=28, width=150, corner_radius=8,
            border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"))
        self.reload_button.grid(row=0, column=2, sticky="e")
        self._focusable(self.reload_button)

        self.grid_host = ctk.CTkFrame(page, fg_color="transparent")
        self.grid_host.grid(row=1, column=0, sticky="ew", padx=(20, 14))
        cards = {}
        for key, _eyebrow, _number, title, _description, button_text, _ in WORKSPACES:
            cards[key] = self._workspace_card(key, title, button_text)
        # The saved-result text of each card, by workspace (home_intelligence.ORDER).
        self.tiles = {key: {"frame": card, "headline": card.headline, "detail": card.context,
                            "freshness": card.freshness, "chip": card.chip} for key, (card, _button) in cards.items()}
        self._vessel_card, self.launch_button = cards["vessel"]
        self._oil_card, self.oil_button = cards["oil"]
        self._voyage_card, self.voyage_button = cards["voyage"]
        self._gc_card, self.gc_button = cards["gc"]
        self._cjc_card, self.cjc_button = cards["cjc"]
        self._sir_card, self.sir_button = cards["sir"]
        self._evi_card, self.evi_button = cards["evi"]
        self._cards = [self._vessel_card, self._oil_card, self._voyage_card, self._gc_card, self._cjc_card,
                       self._sir_card, self._evi_card]
        self._card_by_key = {key: card for key, (card, _button) in cards.items()}
        self.no_workspace_note = self._txt(
            self.grid_host, "No workspace is assigned to you yet. Ask your NeraVeda admin to add the workspaces you need.",
            12, MUTED, justify="left")
        self.sir_stop_button = ctk.CTkButton(
            self._sir_card.foot, text="Stop server", command=self.stop_inspection_reports, width=104, height=34,
            corner_radius=9, fg_color=IDLE_BG, hover_color=SEP, text_color=INK, border_color=FOCUS_RING,
            font=ctk.CTkFont("Segoe UI", 11, weight="bold"),
        )
        self._focusable(self.sir_stop_button, page_widget=True)
        self.evi_stop_button = ctk.CTkButton(
            self._evi_card.foot, text="Stop server", command=self.stop_emissions_validation, width=104, height=34,
            corner_radius=9, fg_color=IDLE_BG, hover_color=SEP, text_color=INK, border_color=FOCUS_RING,
            font=ctk.CTkFont("Segoe UI", 11, weight="bold"),
        )
        self._focusable(self.evi_stop_button, page_widget=True)

    def _workspace_card(self, key, title, button_text):
        """Badge and name; what the workspace last saved (headline, detail, when); how many items need
        attention; and the Open action. Empty lines are hidden, so every card reads top to bottom."""
        m = _MOD[key]
        card = ctk.CTkFrame(self.grid_host, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=12)

        head = ctk.CTkFrame(card, fg_color="transparent")
        head.pack(fill="x", padx=14, pady=(12, 0))
        head.grid_columnconfigure(1, weight=1)
        badge = ctk.CTkFrame(head, width=32, height=32, fg_color=m["tint"], corner_radius=9)
        badge.grid(row=0, column=0, sticky="w")
        badge.pack_propagate(False)
        self._lbl(badge, m["badge"], 9, m["accent"], True).pack(expand=True)
        card.title = self._txt(head, title, 13, INK, True, justify="left")
        card.title.grid(row=0, column=1, sticky="w", padx=(10, 0))

        body = ctk.CTkFrame(card, fg_color="transparent")
        body.pack(fill="x", padx=14, pady=(10, 0))
        card.headline = self._txt(body, "Loading saved results…", 13, MUTED, True, justify="left")
        card.headline.grid(row=0, column=0, sticky="w")
        card.context = self._txt(body, "", 11, MUTED, justify="left")
        card.context.grid(row=1, column=0, sticky="w", pady=(3, 0))
        card.freshness = self._txt(body, "", 10, FAINT, justify="left")
        card.freshness.grid(row=2, column=0, sticky="w", pady=(3, 0))
        # How many items of this workspace need attention; a click goes to the list below.
        card.chip = ctk.CTkLabel(body, text="", corner_radius=8, height=22, cursor="hand2",
                                 font=ctk.CTkFont("Segoe UI", 10, weight="bold"))
        card.chip.grid(row=3, column=0, sticky="w", pady=(8, 0))
        card.chip.bind("<Button-1>", lambda _e: self._scroll_to(self.attention_box), add="+")
        for label in (card.context, card.freshness, card.chip):
            label.grid_remove()

        # Spacer that keeps the buttons on one line across a row of cards; padx keeps it off the card border.
        ctk.CTkFrame(card, fg_color="transparent", height=1).pack(fill="both", expand=True, padx=2)
        foot = card.foot = ctk.CTkFrame(card, fg_color="transparent")
        foot.pack(fill="x", padx=14, pady=(12, 12))
        button = ctk.CTkButton(
            foot, text=button_text, command=getattr(self, OPEN_METHOD[key]),
            fg_color=OPEN_BG, hover_color=OPEN_HV, text_color=BTN, text_color_disabled=MUTED,
            height=32, corner_radius=8, border_color=FOCUS_RING, font=ctk.CTkFont("Segoe UI", 11, weight="bold"),
        )
        button.pack(side="left")
        self._focusable(button, page_widget=True)
        return card, button

    def _build_footer(self, page, row):
        f = ctk.CTkFrame(page, fg_color="transparent")
        f.grid(row=row + 1, column=0, sticky="ew", padx=(20, 14), pady=(18, 22))
        ctk.CTkFrame(f, height=1, fg_color=SEP).pack(fill="x")
        self.footer_note = self._txt(
            f, "NeraVeda Home shows the latest results each workspace has saved. It does not fetch from MariApps, "
               "Outlook or vessels; open a workspace to fetch and process new data.", 10, MUTED, justify="left")
        self.footer_note.pack(anchor="w", pady=(10, 0))

    # ── Layout ────────────────────────────────────────────────────────────────

    def _layout(self, window_width):
        """Workspace cards 4-up on very wide windows, 3-up on wide, 2-up on laptops, 1-up when narrow.
        Order never changes."""
        content = max(420, int(window_width) - SIDEBAR_WIDTH - 70)
        self.content_width = content
        columns = 4 if content >= 1280 else 3 if content >= 860 else 2 if content >= 540 else 1
        visible_cards = [self._card_by_key[key] for key in self._allowed]
        if columns != self.columns:
            self.columns = columns
            self._grid(self.grid_host, visible_cards, columns, gap=14)
            if visible_cards:
                self.no_workspace_note.grid_forget()
            else:
                self.no_workspace_note.grid(row=0, column=0, columnspan=columns, sticky="w", pady=(4, 8))
        card_text = (content - 14 * (columns - 1)) // columns - 30
        for card in self._cards:
            card.title.configure(wraplength=max(140, card_text - 44))
            for label in (card.headline, card.context, card.freshness):
                label.configure(wraplength=max(160, card_text))
        self.footer_note.configure(wraplength=max(400, content - 20))
        self._place_attention_rows()

    @staticmethod
    def _grid(host, widgets, columns, gap):
        for index in range(4):
            host.grid_columnconfigure(index, weight=1 if index < columns else 0,
                                      uniform="cells" if index < columns else "")
        for index, widget in enumerate(widgets):
            row, column = divmod(index, columns)
            left = 0 if column == 0 else gap // 2
            right = 0 if column == columns - 1 else gap // 2
            widget.grid(row=row, column=column, sticky="nsew", padx=(left, right), pady=(0, gap))

    def _on_resize(self, event):
        if event.widget is not self:
            return
        # Configure events report physical pixels; compare in logical (unscaled) pixels.
        scale = ctk.ScalingTracker.get_window_scaling(self)
        width, height = event.width / scale, event.height / scale
        limit = 3 if height < 740 else 4
        show_tagline = height >= 720  # the sidebar must not overflow on short windows
        if show_tagline != self._tagline_shown:
            self._tagline_shown = show_tagline
            if show_tagline:
                self.sidebar_tagline.pack(anchor="w", padx=26, before=self.sidebar_tagline.master.pack_slaves()[-1])
            else:
                self.sidebar_tagline.pack_forget()
        if abs(width - (self.content_width + SIDEBAR_WIDTH + 70)) > 6:
            self._layout(width)
        if limit != self.attention_limit:
            self.attention_limit = limit
            if self.intel is not None:
                self._render_attention()

    # ── Intelligence ──────────────────────────────────────────────────────────

    def refresh_intelligence(self, fetch_sir=False):
        """Reload saved results in the background. With fetch_sir, also refresh the cached Inspection
        Reports summary if its server is running (nothing is started for this)."""
        if self._intel_busy:
            self._intel_again = bool(self._intel_again) or fetch_sir
            return
        self._intel_busy = True
        self.reload_button.configure(state="disabled", text="Reloading…")

        allowed = self.access.allows

        def work():
            note = evi_note = None
            if fetch_sir:
                if allowed("sir"):
                    try:
                        port = inspection_server.server_port()
                        if inspection_server.probe(port) == "sir":
                            home_intelligence.fetch_inspection_summary(port, headers=self.access.service_headers("sir"))
                    except Exception as error:
                        note = f"Latest summary fetch failed ({type(error).__name__}); showing the previous summary"
                if allowed("evi"):
                    try:
                        port = emissions_server.server_port()
                        if emissions_server.probe(port) == "evi":
                            home_intelligence.fetch_emissions_summary(port, headers=self.access.service_headers("evi"))
                    except Exception as error:
                        evi_note = f"Latest summary fetch failed ({type(error).__name__}); showing the previous summary"
            result = home_intelligence.load_all(allowed=allowed)
            if note and result["sir"].state == "ok":
                result["sir"].freshness = note
            if evi_note and result["evi"].state == "ok":
                result["evi"].freshness = evi_note
            self.intel_events.put(result)

        threading.Thread(target=work, daemon=True).start()
        self.after(150, self._poll_intelligence)

    def _poll_intelligence(self):
        try:
            result = self.intel_events.get_nowait()
        except queue.Empty:
            self.after(150, self._poll_intelligence)
            return
        except tk.TclError:
            return
        self.intel = result
        self._intel_busy = False
        try:
            self.reload_button.configure(state="normal", text="Reload saved results")
            self.render_intelligence()
        except tk.TclError:
            return  # window closed while loading
        if self._intel_again is not None:
            again, self._intel_again = self._intel_again, None
            self.refresh_intelligence(fetch_sir=again)

    @staticmethod
    def _show_text(label, text, color=None):
        """Set a card line, hiding it when empty so cards have no blank gaps."""
        label.configure(text=text, **({"text_color": color} if color else {}))
        if text:
            label.grid()
        else:
            label.grid_remove()

    @staticmethod
    def attention_chip(items):
        """(text, severity) for a card's attention count, or None. Action outranks review, as in the list."""
        actions = sum(1 for item in items if item.severity == home_intelligence.ACTION)
        reviews = len(items) - actions
        if not items:
            return None
        if actions:
            text = f"{actions} need{'s' if actions == 1 else ''} action" + (f" · {reviews} to review" if reviews else "")
            return text, home_intelligence.ACTION
        return f"{reviews} to review", home_intelligence.REVIEW

    def render_intelligence(self):
        for key in home_intelligence.ORDER:
            intel = self.intel.get(key) if self.intel else None
            card = self._card_by_key[key]
            if intel is None:
                self._show_text(card.headline, "Loading saved results…", MUTED)
                self._show_text(card.context, "")
                self._show_text(card.freshness, "")
                card.chip.grid_remove()
                continue
            # Non-normal states say so in words ("Not connected to Home", "Not yet processed",
            # "Could not read saved results"…), so colour is never the only signal.
            ok = intel.state == "ok"
            self._show_text(card.headline, intel.headline, INK if ok else STATE_INK)
            self._show_text(card.context, intel.context)
            self._show_text(card.freshness, intel.freshness)
            chip = self.attention_chip(intel.attention)
            if chip is None:
                card.chip.grid_remove()
            else:
                background, foreground, icon = SEVERITY_STYLE[chip[1]]
                card.chip.configure(text=f"  {icon}  {chip[0]}  ", fg_color=background, text_color=foreground)
                card.chip.grid()
        self._render_attention()

    # ── Running state ─────────────────────────────────────────────────────────

    def _set_running(self, key, running):
        self.running[key] = running
        if key in WEB_WORKSPACES:
            return  # a web workspace's button stays usable while running ("Open in browser")
        button = getattr(self, BUTTON_ATTR[key], None)
        if button is not None:
            # An open workspace reads as "already open" (neutral), not as a dimmed primary action.
            button.configure(fg_color=IDLE_BG if running else OPEN_BG, text_color_disabled=MUTED)

    # ── Widget helpers ────────────────────────────────────────────────────────

    def _focusable(self, button, page_widget=False):
        """Tab focus, a visible focus ring, and Enter/Space activation for a CTkButton."""
        tk.Frame.configure(button, takefocus=1)

        def focus_in(_):
            button.configure(border_width=2)
            if page_widget:
                self._ensure_visible(button)

        tk.Frame.bind(button, "<FocusIn>", focus_in, "+")
        tk.Frame.bind(button, "<FocusOut>", lambda _: button.configure(border_width=0), "+")
        tk.Frame.bind(button, "<Return>", lambda _: button.invoke(), "+")
        tk.Frame.bind(button, "<space>", lambda _: button.invoke(), "+")

    @staticmethod
    def _lbl(parent, text, size=13, color=INK, bold=False, **kwargs):
        return ctk.CTkLabel(
            parent, text=text, text_color=color,
            font=ctk.CTkFont("Segoe UI", size, weight="bold" if bold else "normal"),
            anchor="w", **kwargs,
        )

    @staticmethod
    def _txt(parent, text, size=12, color=INK, bold=False, **kwargs):
        """A label sized to its text (CTkLabel otherwise reserves at least 28 px)."""
        return AutomationSuite._lbl(parent, text, size, color, bold, height=1, **kwargs)

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

    @_requires("vessel")
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

    @_requires("oil")
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

    @_requires("voyage")
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

    @_requires("gc")
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

    @_requires("cjc")
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

    # ── Process checks (a closed workspace may have saved new results) ────────

    def check_project_process(self):
        if self.project_process is not None and self.project_process.poll() is None:
            self.after(1000, self.check_project_process)
        else:
            self.launch_button.configure(state="normal", text="Open Vessel Report Centre")
            self._set_running("vessel", False)

    def check_lub_process(self):
        if self.lub_process is not None and self.lub_process.poll() is None:
            self.after(1000, self.check_lub_process)
        else:
            self.oil_button.configure(state="normal", text="Open Lub Oil Review")
            self._set_running("oil", False)
            self.refresh_intelligence()

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
            self.refresh_intelligence()

    def check_cjc_process(self):
        if self.cjc_process is not None and self.cjc_process.poll() is None:
            self.after(1000, self.check_cjc_process)
        else:
            self.cjc_button.configure(state="normal", text="Open Critical Job Compliance")
            self._set_running("cjc", False)
            self.refresh_intelligence()

    # ── Superintendent Inspection Report (local web server) ────────────────────

    # ── Web workspaces: signed entry and servers started with this launcher's secret ──

    def _open_web(self, key, port, target):
        """Open the workspace in the browser through a short-lived signed entry link (same localhost origin)."""
        try:
            webbrowser.open(self.access.web_entry_url(key, port, target))
        except SessionExpired as error:
            self._end_session(str(error))
        except Exception as error:  # never fail silently: the person would see nothing happen
            messagebox.showerror("Could not open the workspace", f"NeraVeda could not open {TITLES.get(key, key)} in the browser:\n{error}", parent=self)

    def _adopt_or_restart(self, key, port, title, stop_listener):
        """A server of this workspace is already listening (started outside this NeraVeda session). Use it if it
        accepts this launcher's tickets; otherwise offer to restart it. True when the caller should start one."""
        if self.access.server_accepts(key, port):
            return False
        if not messagebox.askokcancel(
                f"Restart {title}",
                f"{title} is already running from an earlier session that NeraVeda cannot sign you in to.\n\n"
                "NeraVeda will restart it now. Inspection drafts saved in the browser and emissions sessions are kept.",
                parent=self):
            return None
        if not stop_listener(port):
            messagebox.showerror("Could not restart", f"NeraVeda could not stop the program on port {port}. "
                                 "Close it (or restart the PC) and try again.", parent=self)
            return None
        return True

    @_requires("sir")
    def open_inspection_reports(self, path=None):
        port = inspection_server.server_port()
        target = "/" + (path or inspection_server.INSPECTIONS_PATH).lstrip("/")
        if self.sir_process is not None and self.sir_process.poll() is None:
            if self.sir_mode is not None:  # already serving: open another browser tab
                self._open_web("sir", port, target)
            return
        state = inspection_server.probe(port)
        if state == "sir":  # started earlier, outside this dashboard session
            start = self._adopt_or_restart("sir", port, "Superintendent Inspection Report", inspection_server.stop_listener)
            if start is None:
                return
            if not start:
                self._open_web("sir", port, target)
                self.refresh_intelligence(fetch_sir=True)
                return
            state = None
        if state == "other":
            messagebox.showerror(
                "Port in use",
                f"Another program is using port {port}, which the inspection app needs.\n\n"
                "Close that program and try again. Reports saved in the browser belong to "
                f"{inspection_server.app_url(port)}, so changing the port (SIR_PORT) would hide existing drafts.",
                parent=self)
            return
        try:
            SIR_LOG.parent.mkdir(exist_ok=True)
            self.sir_process, mode = inspection_server.start_server(
                PROJECT_ROOT, port, SIR_LOG, secret=self.access.web_secret("sir", rotate=True), extra_env=self.access.db_env("sir"))
        except Exception as error:  # e.g. Node missing, dependencies not installed, protected storage unavailable
            messagebox.showerror("Could not open Superintendent Inspection Report", str(error), parent=self)
            return
        self.sir_mode = None
        self.sir_target, self.sir_port = target, port
        self.sir_button.configure(state="disabled", text="Starting server…")
        process = self.sir_process

        def wait():
            self.sir_events.put((process, mode, inspection_server.wait_until_ready(process, port)))
        threading.Thread(target=wait, daemon=True).start()
        self.after(250, self.poll_sir_start)

    def poll_sir_start(self):
        try:
            process, mode, ready = self.sir_events.get_nowait()
        except queue.Empty:
            self.after(250, self.poll_sir_start)
            return
        if process is not self.sir_process:
            return  # stopped while starting
        if not ready:
            inspection_server.stop_server(process)
            self.sir_process = None
            self._reset_sir()
            messagebox.showerror(
                "Superintendent Inspection Report did not start",
                f"The local server did not become ready.\n\nDetails: {SIR_LOG}", parent=self)
            return
        self.sir_mode = mode
        self.sir_button.configure(state="normal", text="Open in browser")
        self.sir_stop_button.pack(side="left", padx=(10, 0))
        self._set_running("sir", True)
        # The entry ticket is minted now, not when the button was pressed: a first start can take minutes.
        self._open_web("sir", self.sir_port or inspection_server.server_port(), self.sir_target)
        self.refresh_intelligence(fetch_sir=True)
        self.after(1000, self.check_sir_process)

    def check_sir_process(self):
        if self.sir_process is not None and self.sir_process.poll() is None:
            self.after(1000, self.check_sir_process)
        elif self.sir_mode is not None:
            self.sir_process = None
            self._reset_sir()

    def stop_inspection_reports(self):
        # Keep the summary current before the server goes away.
        try:
            port = inspection_server.server_port()
            if self.access.allows("sir") and inspection_server.probe(port) == "sir":
                home_intelligence.fetch_inspection_summary(port, timeout=5, headers=self.access.service_headers("sir"))
        except Exception:
            pass
        inspection_server.stop_server(self.sir_process)
        self.sir_process = None
        self._reset_sir()
        self.refresh_intelligence()

    def _reset_sir(self):
        self.sir_mode = None
        self.sir_button.configure(state="normal", text="Open Inspection Reports")
        self.sir_stop_button.pack_forget()
        self._set_running("sir", False)

    # ── DNV Emissions Validation (local web server, port 3001) ──────────────────

    @_requires("evi")
    def open_emissions_validation(self, path=None):
        port = emissions_server.server_port()
        target = "/" + (path or "").lstrip("/")
        if self.evi_process is not None and self.evi_process.poll() is None:
            if self.evi_mode is not None:  # already serving: open another browser tab
                self._open_web("evi", port, target)
            return
        state = emissions_server.probe(port)
        if state == "evi":  # started earlier, outside this dashboard session
            start = self._adopt_or_restart("evi", port, "Emissions Validation", emissions_server.stop_listener)
            if start is None:
                return
            if not start:
                self._open_web("evi", port, target)
                self.refresh_intelligence(fetch_sir=True)
                return
            state = None
        if state == "other":
            messagebox.showerror(
                "Port in use",
                f"Another program is using port {port}, which Emissions Validation needs.\n\n"
                "Close that program, or set EMISSIONS_PORT to a free port, and try again.", parent=self)
            return
        try:
            EVI_LOG.parent.mkdir(exist_ok=True)
            self.evi_process, mode = emissions_server.start_server(
                PROJECT_ROOT, port, EVI_LOG, secret=self.access.web_secret("evi", rotate=True), extra_env=self.access.db_env("evi"))
        except Exception as error:  # e.g. Node missing, dependencies not installed, protected storage unavailable
            messagebox.showerror("Could not open Emissions Validation", str(error), parent=self)
            return
        self.evi_mode = None
        self.evi_target, self.evi_port = target, port
        self.evi_button.configure(state="disabled", text="Starting server…")
        process = self.evi_process

        def wait():
            self.evi_events.put((process, mode, emissions_server.wait_until_ready(process, port)))
        threading.Thread(target=wait, daemon=True).start()
        self.after(250, self.poll_evi_start)

    def poll_evi_start(self):
        try:
            process, mode, ready = self.evi_events.get_nowait()
        except queue.Empty:
            self.after(250, self.poll_evi_start)
            return
        if process is not self.evi_process:
            return  # stopped while starting
        if not ready:
            emissions_server.stop_server(process)
            self.evi_process = None
            self._reset_evi()
            messagebox.showerror(
                "Emissions Validation did not start",
                f"The local server did not become ready.\n\nDetails: {EVI_LOG}", parent=self)
            return
        self.evi_mode = mode
        self.evi_button.configure(state="normal", text="Open in browser")
        self.evi_stop_button.pack(side="left", padx=(10, 0))
        self._set_running("evi", True)
        self._open_web("evi", self.evi_port or emissions_server.server_port(), self.evi_target)
        self.refresh_intelligence(fetch_sir=True)
        self.after(1000, self.check_evi_process)

    def check_evi_process(self):
        if self.evi_process is not None and self.evi_process.poll() is None:
            self.after(1000, self.check_evi_process)
        elif self.evi_mode is not None:
            self.evi_process = None
            self._reset_evi()

    def stop_emissions_validation(self):
        # Keep the Home summary current before the server goes away.
        try:
            port = emissions_server.server_port()
            if self.access.allows("evi") and emissions_server.probe(port) == "evi":
                home_intelligence.fetch_emissions_summary(port, timeout=5, headers=self.access.service_headers("evi"))
        except Exception:
            pass
        emissions_server.stop_server(self.evi_process)
        self.evi_process = None
        self._reset_evi()
        self.refresh_intelligence()

    def _reset_evi(self):
        self.evi_mode = None
        self.evi_button.configure(state="normal", text="Open Emissions Validation")
        self.evi_stop_button.pack_forget()
        self._set_running("evi", False)

    # ── Access rights while NeraVeda is open ──────────────────────────────────

    def _may_open(self, key):
        if self.access.allows(key):
            return True
        if not self.access.signed_in:
            self._end_session("Your NeraVeda session has ended.")
        else:
            messagebox.showinfo("No access", f"You do not have access to {TITLES.get(key, key)}.\n\n"
                                "Ask your NeraVeda admin if you need it.", parent=self)
        return False

    def _schedule_access_refresh(self):
        if getattr(self.access, "local_mode", False):
            return
        session = getattr(self.access, "session", None)
        minutes = getattr(session, "refresh_minutes", 15) or 15
        self.after(int(minutes * 60_000), self._refresh_access)

    def _refresh_access(self):
        def work():
            try:
                self._access_events.put(("ok", self.access.refresh()))
            except Exception as error:
                self._access_events.put(("error", error))
        threading.Thread(target=work, daemon=True).start()
        self.after(500, self._poll_access)

    def _poll_access(self):
        try:
            kind, value = self._access_events.get_nowait()
        except queue.Empty:
            self.after(500, self._poll_access)
            return
        except tk.TclError:
            return
        if kind == "error":
            self._end_session(str(value) if isinstance(value, (AccessDenied, SessionExpired))
                              else f"NeraVeda could not check your access: {value}")
            return
        self._apply_access()
        self._schedule_access_refresh()

    def _apply_access(self):
        """Apply changed rights: removed workspaces disappear now; added ones appear after a restart."""
        allowed = [key for key in home_intelligence.ORDER if self.access.allows(key)]
        removed = [key for key in self._allowed if key not in allowed]
        added = [key for key in allowed if key not in self._allowed]
        for key in removed:
            self._card_by_key[key].grid_forget()
            row = self._nav_rows.pop(key, None)
            if row is not None:
                row.pack_forget()
            if key in WEB_WORKSPACES:
                port = inspection_server.server_port() if key == "sir" else emissions_server.server_port()
                self.access.revoke_web(key, port)  # open browser tabs lose their session
        self._allowed = [key for key in self._allowed if key in allowed]
        if removed:
            self.columns = None
            self._layout(self._logical_width())
            self.refresh_intelligence()
        self._update_user_box()
        if added:
            self.user_note.configure(text="New workspaces were added for you: restart NeraVeda to see them.")

    def _stop_servers(self):
        for key, process, server in (("sir", self.sir_process, inspection_server), ("evi", self.evi_process, emissions_server)):
            if process is not None and process.poll() is None:
                try:
                    self.access.revoke_web(key, server.server_port())
                except Exception:
                    pass
                server.stop_server(process)
        self.sir_process = self.evi_process = None

    def _end_session(self, message):
        """Rights withdrawn or the session ended: stop the web servers and close (reopen to sign in)."""
        try:
            messagebox.showwarning("NeraVeda", f"{message}\n\nNeraVeda will close. Open it again to sign in.", parent=self)
        except tk.TclError:
            pass
        self._stop_servers()
        self.destroy()

    def sign_out(self):
        servers = [process for process in (self.sir_process, self.evi_process) if process is not None and process.poll() is None]
        text = "Sign out of NeraVeda?"
        if servers:
            text += "\n\nThe Inspection Reports / Emissions Validation servers are stopped. Workspace windows that are already open stay open until you close them."
        if not messagebox.askokcancel("Sign out", text, parent=self):
            return
        self._stop_servers()
        try:
            self.access.sign_out()
        finally:
            self.destroy()

    def change_password(self):
        if not getattr(self.access, "password_user", False):
            return
        from suite_services.access.ui import ChangePasswordDialog
        ChangePasswordDialog(self, self.access)

    def open_admin(self):
        if not self.access.can_administer:
            return
        try:
            from suite_services.access.ui import AdminWindow
            AdminWindow(self, self.access)
        except Exception as error:
            messagebox.showerror("Admin", f"The people list could not be opened:\n{error}", parent=self)

    def on_close(self):
        servers = [name for name, process in (("Superintendent Inspection Report", self.sir_process),
                                               ("Emissions Validation", self.evi_process))
                   if process is not None and process.poll() is None]
        if servers:
            if not messagebox.askokcancel(
                    "Close NeraVeda",
                    f"Closing NeraVeda stops the {' and '.join(servers)} server{'s' if len(servers) > 1 else ''}.\n\n"
                    "Inspection drafts stay saved in the browser; emissions sessions and findings stay in their database.",
                    parent=self):
                return
            inspection_server.stop_server(self.sir_process)
            emissions_server.stop_server(self.evi_process)
            self.sir_process = self.evi_process = None
        self.destroy()

    def open_project_folder(self):
        try:
            os.startfile(str(PROJECT_ROOT))
        except OSError as error:
            messagebox.showerror("Could not open project folder", str(error), parent=self)


if __name__ == "__main__":
    ctk.set_appearance_mode("light")
    ctk.set_default_color_theme("blue")
    AutomationSuite().mainloop()
