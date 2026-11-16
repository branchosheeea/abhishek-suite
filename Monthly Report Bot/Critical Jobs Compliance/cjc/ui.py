"""Critical Job Compliance window."""
from __future__ import annotations

import os
import queue
import tkinter as tk
from datetime import date, datetime
from pathlib import Path
from tkinter import messagebox, ttk

import customtkinter as ctk

from report_catalog import DATE_PRESETS, VESSELS
from vessel_report.core import parse_range, preset_range, unique_path
from vessel_report.pickers import DatePicker

from . import config
from .models import display_date
from .store import MISMATCH, NOT_FOUND, VERIFIED, Store
from .worker import ExtractionWorker, RunRequest

# ── Colour tokens (shared with the Neraveda launcher) ────────────────────────
BG, SURFACE, INK, MUTED, FAINT, SEP = "#F3F6F9", "#FFFFFF", "#0F1B2A", "#5F6B7A", "#8A96A5", "#E3E8EE"
NAVY = "#0E2A47"
BTN, BTN_HV = "#1557A0", "#114888"
SOFT, SOFT_HV = "#EAF1F9", "#DCE7F4"
ACCENT, TINT = "#B03A2E", "#FBECEA"
GOOD, GOOD_BG = "#1E7A45", "#E3F4EA"
WARN, WARN_BG = "#94621D", "#FCF3E2"
BAD, BAD_BG = "#B54742", "#FBEAEA"
IDLE_BG = "#EEF1F4"

STAGES = (("open", "Open MariApps"), ("navigate", "Open Job Overview"), ("vessel", "Select and verify vessel"),
          ("filters", "Apply critical filters"), ("extract", "Extract population"),
          ("reconcile", "Reconcile counts"), ("save", "Save to suite"))
STAGE_KEYS = [key for key, _ in STAGES]

COLUMNS = (("equipment_code", "Code", 110, "w"), ("equipment_name", "Equipment", 230, "w"),
           ("title", "Job title", 320, "w"), ("job_type", "Job type", 160, "w"),
           ("frequency", "Frequency", 90, "w"), ("last_done_date", "Last done", 96, "center"),
           ("next_due_date", "Next due", 96, "center"), ("remaining", "Remaining", 86, "center"),
           ("discipline", "Discipline", 140, "w"), ("risk_assessment", "Risk assess.", 84, "center"),
           ("critical_to_safety", "Critical to safety", 128, "center"), ("safety_level", "Safety level", 92, "center"),
           ("priority", "Priority", 80, "center"), ("remark", "Last Job Done remark", 420, "w"))
DATE_COLUMNS = {"last_done_date", "next_due_date"}

STATUS_STYLE = {VERIFIED: (GOOD, GOOD_BG), MISMATCH: (BAD, BAD_BG), NOT_FOUND: (WARN, WARN_BG),
                "Failed": (BAD, BAD_BG), "Stopped": (WARN, WARN_BG), "Running": (BTN, SOFT)}


def font(size=12, bold=False):
    return ctk.CTkFont("Segoe UI", size, weight="bold" if bold else "normal")


class ComplianceApp(ctk.CTk):

    def __init__(self, store: Store | None = None, session_factory=None):
        super().__init__()
        self.title("Critical Job Compliance · Neraveda")
        self.geometry("1240x800")
        self.minsize(980, 600)
        self.configure(fg_color=BG)
        self.after(50, lambda: self.state("zoomed"))  # the population table needs the room
        self.events: queue.Queue = queue.Queue()
        self.store = store or Store()
        self.store.mark_interrupted_runs()
        self.worker = ExtractionWorker(self.emit, self.store, session_factory)
        self.closing = False
        self.current_run_id = None
        self.current_plans: list[dict] = []
        self.history: dict[str, int] = {}
        self.stage_rows: dict[str, tuple] = {}
        self.active_stage = None

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(4, weight=1)
        self._build_header()
        self._build_setup()
        self._build_progress()
        self._build_reconciliation()
        self._build_results()
        self._build_log()

        self.apply_preset()
        self.refresh_history(select_latest=True)
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.after(100, self.poll_events)

    # ── Helpers used by the shared pickers ────────────────────────────────────

    def label(self, parent, text, size=12, color=INK, bold=False, **kwargs):
        return ctk.CTkLabel(parent, text=text, text_color=color, font=font(size, bold), anchor="w", **kwargs)

    def button(self, parent, text, command, secondary=False, **kwargs):
        kwargs.setdefault("height", 36)
        return ctk.CTkButton(parent, text=text, command=command, corner_radius=9, font=font(12, True),
                             fg_color=SOFT if secondary else BTN, hover_color=SOFT_HV if secondary else BTN_HV,
                             text_color=BTN if secondary else "#FFFFFF", text_color_disabled="#9AA8B8", **kwargs)

    def card(self, parent, **kwargs):
        return ctk.CTkFrame(parent, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=14, **kwargs)

    def chip(self, parent, text, fg=MUTED, bg=IDLE_BG):
        return ctk.CTkLabel(parent, text=f"  {text}  ", text_color=fg, fg_color=bg, corner_radius=8, height=26,
                            font=font(11, True))

    # ── Layout ─────────────────────────────────────────────────────────────────

    def _build_header(self):
        bar = ctk.CTkFrame(self, fg_color=NAVY, corner_radius=0, height=64)
        bar.grid(row=0, column=0, sticky="ew")
        bar.grid_propagate(False)
        bar.grid_columnconfigure(1, weight=1)
        mark = ctk.CTkFrame(bar, width=40, height=40, fg_color=TINT, corner_radius=11)
        mark.grid(row=0, column=0, rowspan=2, padx=(24, 12), pady=12)
        mark.pack_propagate(False)
        ctk.CTkLabel(mark, text="CJC", text_color=ACCENT, font=font(11, True)).pack(expand=True)
        self.label(bar, "Critical Job Compliance", 17, "#FFFFFF", True).grid(row=0, column=1, sticky="sw", pady=(10, 0))
        self.label(bar, "PMS critical equipment jobs · MariApps / PAL Job Overview", 11, "#8FA6BE").grid(
            row=1, column=1, sticky="nw", pady=(0, 10))
        self.session_chip = ctk.CTkLabel(bar, text="  Edge not started  ", text_color="#D3DFEB", fg_color="#173A5E",
                                         corner_radius=10, height=28, font=font(11, True))
        self.session_chip.grid(row=0, column=2, rowspan=2, padx=24)

    def _build_setup(self):
        run = self.card(self)
        run.grid(row=1, column=0, sticky="ew", padx=20, pady=(14, 0))
        run.grid_columnconfigure(3, weight=1)
        self.label(run, "NEW COMPLIANCE RUN", 10, ACCENT, True).grid(row=0, column=0, columnspan=5, sticky="w",
                                                                  padx=20, pady=(12, 4))
        self.label(run, "Vessel", 11, MUTED).grid(row=1, column=0, sticky="w", padx=(20, 8))
        self.label(run, "Review period", 11, MUTED).grid(row=1, column=1, columnspan=2, sticky="w", padx=8)
        self.vessel_var = tk.StringVar(self, value="")
        self.vessel_menu = ctk.CTkOptionMenu(run, values=sorted(VESSELS, key=str.casefold), variable=self.vessel_var,
                                             width=190, **self._menu_style())
        self.vessel_menu.set("Select vessel")
        self.vessel_menu.grid(row=2, column=0, sticky="w", padx=(20, 8), pady=(2, 0))
        self.preset_var = tk.StringVar(self, value="Previous Month")
        ctk.CTkOptionMenu(run, values=DATE_PRESETS, variable=self.preset_var, command=self.apply_preset, width=160,
                          **self._menu_style()).grid(row=2, column=1, sticky="w", padx=8, pady=(2, 0))
        dates = ctk.CTkFrame(run, fg_color="transparent")
        dates.grid(row=2, column=2, sticky="w", padx=8, pady=(2, 0))
        self.start_var = tk.StringVar(self)
        self.end_var = tk.StringVar(self)
        self.start_entry = self._date_entry(dates, self.start_var, "Review start", 0)
        self.label(dates, "–", 12, MUTED).grid(row=0, column=1, padx=4)
        self.end_entry = self._date_entry(dates, self.end_var, "Review end", 2)
        self.start_button = self.button(run, "Start compliance run", self.start_run, width=190, height=36)
        self.start_button.grid(row=2, column=4, sticky="e", padx=20, pady=(2, 0))

        chips = ctk.CTkFrame(run, fg_color="transparent")
        chips.grid(row=3, column=0, columnspan=5, sticky="w", padx=20, pady=(10, 12))
        self.label(chips, "Confirmed filter set", 11, MUTED).pack(side="left", padx=(0, 10))
        for text in config.CRITICAL_JOB_FILTERS.summary():
            self.chip(chips, text, ACCENT, TINT).pack(side="left", padx=(0, 6))
        self.label(chips, "   Review period is recorded with the run for the execution-review stages.",
                   10, FAINT).pack(side="left")

    def _menu_style(self):
        return dict(height=34, corner_radius=9, fg_color=SURFACE, button_color=SOFT, button_hover_color=SOFT_HV,
                    text_color=INK, font=font(12), dropdown_font=font(12), dynamic_resizing=False)

    def _build_progress(self):
        strip = self.card(self)
        strip.grid(row=2, column=0, sticky="ew", padx=20, pady=(10, 0))
        strip.grid_columnconfigure(1, weight=1)
        self.run_chip = self.chip(strip, "Idle")
        self.run_chip.grid(row=0, column=0, sticky="w", padx=(16, 12), pady=10)
        steps = ctk.CTkFrame(strip, fg_color="transparent")
        steps.grid(row=0, column=1, sticky="w", pady=10)
        for index, (key, text) in enumerate(STAGES):
            if index:
                ctk.CTkFrame(steps, width=18, height=2, fg_color=SEP).pack(side="left", padx=6)
            dot = ctk.CTkLabel(steps, text="", width=10, height=10, fg_color=IDLE_BG, corner_radius=5)
            dot.pack(side="left", padx=(0, 6))
            name = self.label(steps, text, 11, MUTED)
            name.pack(side="left")
            self.stage_rows[key] = (dot, name)
        # Pause banner (hidden until the session needs attention)
        self.pause = ctk.CTkFrame(strip, fg_color=WARN_BG, corner_radius=10)
        self.pause.grid_columnconfigure(0, weight=1)
        self.pause_text = self.label(self.pause, "", 11, WARN, justify="left", wraplength=700)
        self.pause_text.grid(row=0, column=0, sticky="w", padx=12, pady=8)
        self.sign_in_button = self.button(self.pause, "Show sign-in", self.worker.show_sign_in, secondary=True, height=30)
        self.resume_button = self.button(self.pause, "Resume", lambda: self.worker.resume(), height=30)
        self.reopen_button = self.button(self.pause, "Reopen Edge", lambda: self.worker.resume(reopen=True), height=30)
        self.cancel_button = self.button(self.pause, "Cancel run", self.worker.cancel, secondary=True, height=30)

    def _date_entry(self, parent, variable, title, column):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        frame.grid(row=0, column=column, sticky="w")
        entry = ctk.CTkEntry(frame, textvariable=variable, width=118, height=34, corner_radius=9, border_color=SEP,
                             font=font(12))
        entry.grid(row=0, column=0)
        pick = ctk.CTkButton(frame, text="▾", width=30, height=34, corner_radius=9, fg_color=SOFT, hover_color=SOFT_HV,
                             text_color=BTN, font=font(12, True),
                             command=lambda: DatePicker(self, title, variable.get(), lambda v: self._picked(variable, v), entry))
        pick.grid(row=0, column=1, padx=(4, 0))
        entry.bind("<KeyRelease>", lambda _e: self.preset_var.set("Custom Range"), add="+")
        return entry

    def _picked(self, variable, value):
        variable.set(value)
        self.preset_var.set("Custom Range")

    def _build_reconciliation(self):
        band = self.card(self)
        band.grid(row=3, column=0, sticky="ew", padx=20, pady=(10, 0))
        band.grid_columnconfigure(0, weight=1)
        titles = ctk.CTkFrame(band, fg_color="transparent")
        titles.grid(row=0, column=0, sticky="w", padx=20, pady=10)
        self.recon_title = self.label(titles, "No run selected", 14, INK, True)
        self.recon_title.pack(anchor="w")
        self.recon_sub = self.label(titles, "Start a run or choose one from history below.", 11, MUTED)
        self.recon_sub.pack(anchor="w")
        self.metric_displayed = self._metric(band, "Displayed in portal", 1)
        self.metric_extracted = self._metric(band, "Extracted", 2)
        self.metric_checks = self._metric(band, "Checks passed", 3)
        self.recon_badge = self.chip(band, "—")
        self.recon_badge.grid(row=0, column=4, padx=(6, 10))
        self.checks_button = self.button(band, "View checks", self.show_checks, secondary=True, height=30, width=110)
        self.checks_button.grid(row=0, column=5, padx=(0, 20))
        self.check_lines: list[str] = []

    def _metric(self, parent, caption, column):
        frame = ctk.CTkFrame(parent, fg_color="transparent")
        frame.grid(row=0, column=column, padx=12, pady=8)
        value = self.label(frame, "—", 20, INK, True)
        value.pack(anchor="w")
        self.label(frame, caption, 10, MUTED).pack(anchor="w")
        return value

    def _build_results(self):
        panel = self.card(self)
        panel.grid(row=4, column=0, sticky="nsew", padx=20, pady=(10, 0))
        panel.grid_columnconfigure(0, weight=1)
        panel.grid_rowconfigure(1, weight=1)
        bar = ctk.CTkFrame(panel, fg_color="transparent")
        bar.grid(row=0, column=0, sticky="ew", padx=16, pady=(12, 8))
        bar.grid_columnconfigure(1, weight=1)
        self.label(bar, "CRITICAL JOB PLAN POPULATION", 10, ACCENT, True).grid(row=0, column=0, sticky="w")
        self.history_var = tk.StringVar(self, value="")
        self.history_menu = ctk.CTkOptionMenu(bar, values=["No runs yet"], variable=self.history_var,
                                              command=self.choose_history, width=420, height=32, corner_radius=9,
                                              fg_color=SURFACE, button_color=SOFT, button_hover_color=SOFT_HV,
                                              text_color=INK, font=font(11), dropdown_font=font(11),
                                              dynamic_resizing=False)
        self.history_menu.grid(row=0, column=2, padx=(8, 0))
        # No textvariable: CustomTkinter hides the placeholder when one is attached.
        self.search = ctk.CTkEntry(bar, placeholder_text="Search equipment, job, remark…", width=240,
                                   height=32, corner_radius=9, border_color=SEP, font=font(11))
        self.search.grid(row=0, column=3, padx=(8, 0))
        self.search.bind("<KeyRelease>", lambda _e: self.render_table(), add="+")
        self.export_button = self.button(bar, "Export to Excel", self.export, secondary=True, height=32, width=130)
        self.export_button.grid(row=0, column=4, padx=(8, 0))

        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("CJC.Treeview", font=("Segoe UI", 10), rowheight=26, background=SURFACE,
                        fieldbackground=SURFACE, foreground=INK, borderwidth=0)
        style.configure("CJC.Treeview.Heading", font=("Segoe UI", 10, "bold"), background="#F1F4F8",
                        foreground=MUTED, relief="flat", padding=(6, 6))
        style.map("CJC.Treeview", background=[("selected", "#DCE7F4")], foreground=[("selected", INK)])
        holder = tk.Frame(panel, background=SURFACE)
        holder.grid(row=1, column=0, sticky="nsew", padx=12, pady=(0, 6))
        holder.grid_columnconfigure(0, weight=1)
        holder.grid_rowconfigure(0, weight=1)
        self.table = ttk.Treeview(holder, columns=[c[0] for c in COLUMNS], show="headings", style="CJC.Treeview")
        for key, heading, width, anchor in COLUMNS:
            self.table.heading(key, text=heading, command=lambda k=key: self.sort_by(k))
            self.table.column(key, width=width, minwidth=60, anchor=anchor, stretch=key in {"title", "remark"})
        self.table.tag_configure("odd", background="#FAFBFD")
        ys = ttk.Scrollbar(holder, orient="vertical", command=self.table.yview)
        xs = ttk.Scrollbar(holder, orient="horizontal", command=self.table.xview)
        self.table.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        self.table.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")
        self.table.bind("<Double-1>", self.show_plan)
        self.table_caption = self.label(panel, "", 10, FAINT)
        self.table_caption.grid(row=2, column=0, sticky="w", padx=16, pady=(0, 10))
        self.sort_key, self.sort_reverse = "equipment_code", False

    def _build_log(self):
        bar = ctk.CTkFrame(self, fg_color="transparent")
        bar.grid(row=5, column=0, sticky="ew", padx=20, pady=(8, 12))
        bar.grid_columnconfigure(1, weight=1)
        self.log_button = self.button(bar, "Show activity log", self.toggle_log, secondary=True, height=28, width=140)
        self.log_button.grid(row=0, column=0, sticky="w")
        self.last_log = self.label(bar, "", 10, FAINT)
        self.last_log.grid(row=0, column=1, sticky="w", padx=12)
        self.log_box = ctk.CTkTextbox(bar, height=140, fg_color=SURFACE, border_width=1, border_color=SEP,
                                      font=ctk.CTkFont("Consolas", 10), text_color=INK)
        self.log_box.configure(state="disabled")

    # ── Toggles ───────────────────────────────────────────────────────────────

    def show_checks(self):
        """Reconciliation evidence in its own window, so the population table keeps its space."""
        window = ctk.CTkToplevel(self)
        window.title(f"Reconciliation checks · {self.recon_title.cget('text')}")
        window.geometry("820x520")
        window.configure(fg_color=SURFACE)
        window.transient(self)
        self.label(window, self.recon_title.cget("text"), 15, INK, True).pack(anchor="w", padx=22, pady=(18, 0))
        self.label(window, self.recon_badge.cget("text").strip(), 11, MUTED).pack(anchor="w", padx=22)
        box = ctk.CTkTextbox(window, fg_color="#F8FAFC", border_width=0, font=font(11), text_color=INK, wrap="word")
        box.pack(fill="both", expand=True, padx=22, pady=16)
        box.insert("end", "\n".join(self.check_lines) or "No run selected.")
        box.configure(state="disabled")
        window.after(60, window.focus_set)

    def toggle_log(self):
        if self.log_box.winfo_ismapped():
            self.log_box.grid_forget()
            self.log_button.configure(text="Show activity log")
        else:
            self.log_box.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(8, 0))
            self.log_button.configure(text="Hide activity log")

    # ── Review period ─────────────────────────────────────────────────────────

    def apply_preset(self, _value=None):
        values = preset_range(self.preset_var.get())
        if values:
            start, end = values
            self.start_var.set(start.strftime("%d-%b-%Y"))
            self.end_var.set(end.strftime("%d-%b-%Y"))

    # ── Run control ───────────────────────────────────────────────────────────

    def start_run(self):
        vessel = self.vessel_var.get()
        if vessel not in VESSELS:
            messagebox.showwarning("Choose a vessel", "Select the vessel to review.", parent=self)
            return
        try:
            start, end = parse_range(self.start_var.get(), self.end_var.get())
            request = RunRequest(vessel, start.date(), end.date())
            self.worker.submit(request)
        except (ValueError, RuntimeError) as error:
            messagebox.showwarning("Cannot start", str(error), parent=self)
            return
        self.set_running(True)
        self.reset_stages()
        self.append_log(f"Starting {vessel}, review period {start:%d-%b-%Y} to {end:%d-%b-%Y}.")

    def set_running(self, running):
        self.start_button.configure(state="disabled" if running else "normal",
                                    text="Run in progress…" if running else "Start compliance run")
        self.vessel_menu.configure(state="disabled" if running else "normal")
        self.history_menu.configure(state="disabled" if running else "normal")
        self._set_chip(self.run_chip, "Running" if running else "Idle", *(STATUS_STYLE["Running"] if running else (MUTED, IDLE_BG)))
        if not running:
            self.hide_pause()

    def reset_stages(self):
        self.active_stage = None
        for dot, name in self.stage_rows.values():
            dot.configure(fg_color=IDLE_BG)
            name.configure(text_color=MUTED, font=font(11))

    def mark_stage(self, key, state="active"):
        if key not in self.stage_rows:
            return
        index = STAGE_KEYS.index(key)
        if state == "active":
            for earlier in STAGE_KEYS[:index]:
                self._paint_stage(earlier, "done")
            self.active_stage = key
        self._paint_stage(key, state)

    def _paint_stage(self, key, state):
        dot, name = self.stage_rows[key]
        colour = {"active": BTN, "done": GOOD, "failed": BAD, "warn": WARN}[state]
        dot.configure(fg_color=colour)
        name.configure(text_color=INK if state != "failed" else BAD, font=font(11, state == "active"))

    def show_pause(self, reason, message):
        self.pause_text.configure(text=message)
        for widget in (self.sign_in_button, self.resume_button, self.reopen_button, self.cancel_button):
            widget.grid_forget()
        buttons = ([self.sign_in_button, self.resume_button] if reason == "auth" else [self.reopen_button])
        for column, widget in enumerate(buttons + [self.cancel_button], start=1):
            widget.grid(row=0, column=column, padx=(0, 8), pady=8)
        self.pause.grid(row=1, column=0, columnspan=2, sticky="ew", padx=12, pady=(0, 10))
        self._set_chip(self.run_chip, "Needs attention", WARN, WARN_BG)

    def hide_pause(self):
        self.pause.grid_forget()

    # ── Worker events ─────────────────────────────────────────────────────────

    def emit(self, kind, **data):
        self.events.put((kind, data))

    def poll_events(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                self.handle_event(kind, data)
        except queue.Empty:
            pass
        if self.closing and self.worker.closed.is_set():
            self.destroy()
            return
        self.after(100, self.poll_events)

    def handle_event(self, kind, data):
        if kind == "log":
            self.append_log(data["message"])
        elif kind == "session":
            state = data.get("state")
            if state == "stage":
                self.mark_stage(data["stage"])
            elif state == "opened":
                self._set_chip(self.session_chip, "Edge session open", "#D3DFEB", "#1E4D3A")
                self.append_log(data.get("message", ""))
            elif state == "ready":
                self.append_log(data.get("message", ""))
            elif data.get("message"):
                self.append_log(data["message"])
        elif kind == "stage":
            self.mark_stage(data["stage"])
        elif kind == "started":
            self.append_log(f"Run {data['run_id']} recorded for {data['vessel']}.")
        elif kind == "paused":
            self.show_pause(data["reason"], data["message"])
            self.append_log(f"Paused: {data['message']}")
        elif kind == "resumed":
            self.hide_pause()
            self._set_chip(self.run_chip, "Running", *STATUS_STYLE["Running"])
            self.append_log("Session restored; restarting the extraction from a clean report.")
        elif kind == "finished":
            self.finish_run(data)
        elif kind == "fatal":
            self.append_log(data["message"])
            self.set_running(False)
            self._set_chip(self.session_chip, "Edge stopped", "#F3C9C6", "#5A2421")
            if not self.closing:
                messagebox.showerror("Browser worker stopped", data["message"], parent=self)
        elif kind == "worker_closed":
            self._set_chip(self.session_chip, "Edge closed", "#D3DFEB", "#173A5E")

    def finish_run(self, data):
        status, message = data["status"], data.get("message") or ""
        self.set_running(False)
        if status == VERIFIED:
            for key in STAGE_KEYS:
                self._paint_stage(key, "done")
        elif status == MISMATCH:
            for key in STAGE_KEYS:
                self._paint_stage(key, "done")
            self._paint_stage("reconcile", "failed")
        elif self.active_stage:
            self._paint_stage(self.active_stage, "failed" if status != NOT_FOUND else "warn")
        self._set_chip(self.run_chip, status, *STATUS_STYLE.get(status, (MUTED, IDLE_BG)))
        if message:
            self.append_log(f"{status}: {message}")
        self.refresh_history(select=data.get("run_id"))
        if status == NOT_FOUND:
            messagebox.showwarning("Vessel not found", message, parent=self)
        elif status in {"Failed"}:
            messagebox.showerror("Run failed", message or "The run did not complete.", parent=self)
        elif status == MISMATCH:
            messagebox.showwarning(
                "Reconciliation failed",
                "The extracted rows did not reconcile with the portal. The rows are saved as evidence but are "
                "not a verified population. Open 'Show checks' for details.", parent=self)

    # ── History and display ───────────────────────────────────────────────────

    def refresh_history(self, select=None, select_latest=False):
        runs = self.store.runs()
        self.history = {}
        for run in runs:
            started = datetime.fromisoformat(run["started_at"]).strftime("%d-%b-%Y %H:%M")
            count = run["extracted_count"] if run["extracted_count"] is not None else "–"
            text = f"#{run['id']}  ·  {run['vessel_name']}  ·  {started}  ·  {run['status']}  ·  {count} plans"
            self.history[text] = run["id"]
        values = list(self.history) or ["No runs yet"]
        self.history_menu.configure(values=values)
        target = select if select is not None else (runs[0]["id"] if select_latest and runs else None)
        if target is not None:
            for text, run_id in self.history.items():
                if run_id == target:
                    self.history_var.set(text)
                    self.load_run(run_id)
                    return
        if not runs:
            self.history_var.set("No runs yet")

    def choose_history(self, text):
        if text in self.history:
            self.load_run(self.history[text])

    def load_run(self, run_id):
        run = self.store.run(run_id)
        if run is None:
            return
        self.current_run_id = run_id
        self.current_run = run
        self.current_plans = self.store.plans(run_id)
        status = run["status"]
        period = f"{display_date(run['review_start'])} to {display_date(run['review_end'])}"
        started = datetime.fromisoformat(run["started_at"]).strftime("%d-%b-%Y %H:%M")
        self.recon_title.configure(text=f"{run['vessel_name']}  ·  Run #{run_id}")
        self.recon_sub.configure(text=f"Review period {period}  ·  extracted {started} by {run['actor']}"
                                      + (f"  ·  {run['error']}" if run.get("error") else ""))
        recon = run.get("reconciliation")
        self.metric_displayed.configure(text="—" if run["displayed_count"] is None else f"{run['displayed_count']:,}")
        self.metric_extracted.configure(text="—" if run["extracted_count"] is None else f"{run['extracted_count']:,}")
        if recon:
            passed = sum(1 for c in recon["checks"] if c["passed"])
            self.metric_checks.configure(text=f"{passed}/{len(recon['checks'])}",
                                         text_color=GOOD if passed == len(recon["checks"]) else BAD)
        else:
            self.metric_checks.configure(text="—", text_color=INK)
        badge = {VERIFIED: "Reconciled · verified population", MISMATCH: "Not reconciled · evidence only"}.get(status, status)
        self._set_chip(self.recon_badge, badge, *STATUS_STYLE.get(status, (MUTED, IDLE_BG)))
        lines = []
        if recon:
            for check in recon["checks"]:
                lines.append(f"{'✔' if check['passed'] else '✘'}  {check['name']} — {check['detail']}")
        else:
            lines.append(run.get("error") or "No reconciliation recorded for this run.")
        self.check_lines = lines
        self.render_table()

    def sort_by(self, key):
        self.sort_reverse = not self.sort_reverse if self.sort_key == key else False
        self.sort_key = key
        self.render_table()

    def render_table(self):
        self.table.delete(*self.table.get_children())
        needle = self.search.get().strip().casefold()
        rows = [p for p in self.current_plans
                if not needle or needle in " ".join(str(p.get(c[0]) or "") for c in COLUMNS).casefold()]
        rows.sort(key=lambda p: (str(p.get(self.sort_key) or ""), p["equipment_code"] or "", p["title"] or ""),
                  reverse=self.sort_reverse)
        for index, plan in enumerate(rows):
            values = [display_date(plan[k]) if k in DATE_COLUMNS else (plan.get(k) or "") for k, *_ in COLUMNS]
            self.table.insert("", "end", iid=plan["job_plan_id"], values=values, tags=("odd",) if index % 2 else ())
        total = len(self.current_plans)
        shown = f"{len(rows)} of {total}" if needle else f"{total}"
        self.table_caption.configure(
            text=f"{shown} Job Plan(s). Double-click a row for full detail. Dates are shown as the portal shows them."
            if total else "No Job Plans for this run.")
        self.export_button.configure(state="normal" if total else "disabled")

    def show_plan(self, _event=None):
        selected = self.table.selection()
        if not selected:
            return
        plan = next((p for p in self.current_plans if p["job_plan_id"] == selected[0]), None)
        if plan is None:
            return
        window = ctk.CTkToplevel(self)
        window.title(plan["title"] or "Job Plan")
        window.geometry("640x560")
        window.configure(fg_color=SURFACE)
        window.transient(self)
        self.label(window, plan["title"] or "", 15, INK, True, wraplength=590, justify="left").pack(
            anchor="w", padx=22, pady=(18, 2))
        self.label(window, f"{plan['equipment_code']} · {plan['equipment_name']}", 11, MUTED,
                   wraplength=590, justify="left").pack(anchor="w", padx=22)
        box = ctk.CTkTextbox(window, fg_color="#F8FAFC", border_width=0, font=font(11), wrap="word")
        box.pack(fill="both", expand=True, padx=22, pady=16)
        names = {"job_plan_id": "Job Plan id", "maintenance_type": "Maintenance type", "last_done_hrs": "Last done hrs",
                 "next_due_hrs": "Next due hrs", "since_last_done": "Since last done",
                 "maintenance_cause": "Maintenance cause", "job_assigned": "Job assigned to"}
        for key, heading, *_ in COLUMNS:
            names.setdefault(key, heading)
        for key, heading in names.items():
            if key == "remark":
                continue
            value = display_date(plan[key]) if key in DATE_COLUMNS else plan.get(key)
            box.insert("end", f"{heading}:  {value or '—'}\n")
        box.insert("end", f"\nLast Job Done remark:\n{plan.get('remark') or '—'}\n")
        box.configure(state="disabled")

    # ── Export ────────────────────────────────────────────────────────────────

    def export(self):
        if not self.current_plans or self.current_run_id is None:
            return
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        run = self.current_run
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Critical Job Plans"
        headers = [heading for _, heading, *_ in COLUMNS] + ["Job Plan id", "Maintenance type", "Job assigned to"]
        sheet.append(headers)
        for plan in sorted(self.current_plans, key=lambda p: (p["equipment_code"] or "", p["title"] or "")):
            values = [datetime.fromisoformat(plan[k]) if k in DATE_COLUMNS and plan[k] else plan.get(k) or ""
                      for k, *_ in COLUMNS]
            sheet.append(values + [plan["job_plan_id"], plan["maintenance_type"], plan["job_assigned"]])
        header_fill = PatternFill("solid", fgColor="0E2A47")
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = header_fill
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        date_columns = [i + 1 for i, (k, *_) in enumerate(COLUMNS) if k in DATE_COLUMNS]
        for row in sheet.iter_rows(min_row=2):
            for index in date_columns:
                row[index - 1].number_format = "DD-MMM-YYYY"
        for index, (_, _, width, _) in enumerate(COLUMNS, start=1):
            sheet.column_dimensions[sheet.cell(1, index).column_letter].width = max(10, width / 7)
        sheet.freeze_panes = "C2"
        sheet.auto_filter.ref = sheet.dimensions

        info = workbook.create_sheet("Run")
        recon = run.get("reconciliation") or {}
        rows = [("Vessel", run["vessel_name"]), ("Run", run["id"]), ("Status", run["status"]),
                ("Review period", f"{display_date(run['review_start'])} to {display_date(run['review_end'])}"),
                ("Extracted at", run["started_at"]), ("Extracted by", run["actor"]),
                ("Displayed in portal", run["displayed_count"]), ("Extracted", run["extracted_count"]),
                ("Filter set", config.CRITICAL_JOB_FILTERS.name)]
        rows += [(label, value) for label, value in run["filter_profile"].get("selects", {}).items()]
        rows += [("Equipment node", run["filter_profile"].get("equipment_node")),
                 ("Show sublevel equipment", run["filter_profile"].get("show_sublevel")), ("", "")]
        rows += [(("PASS " if c["passed"] else "FAIL ") + c["name"], c["detail"]) for c in recon.get("checks", [])]
        for row in rows:
            info.append(row)
        info.column_dimensions["A"].width = 42
        info.column_dimensions["B"].width = 110
        for cell in info["A"]:
            cell.font = Font(bold=True)

        folder = config.EXPORT_ROOT
        folder.mkdir(parents=True, exist_ok=True)
        name = f"{run['vessel_name']} - Critical Job Plans - run {run['id']} - {date.today():%Y-%m-%d}.xlsx"
        path = unique_path(folder, name)
        try:
            workbook.save(path)
        except OSError as error:
            messagebox.showerror("Export failed", str(error), parent=self)
            return
        self.append_log(f"Exported {path}")
        if messagebox.askyesno("Exported", f"Saved:\n{path}\n\nOpen it now?", parent=self):
            os.startfile(str(path))

    # ── Misc ──────────────────────────────────────────────────────────────────

    @staticmethod
    def _set_chip(chip, text, fg, bg):
        chip.configure(text=f"  {text}  ", text_color=fg, fg_color=bg)

    def append_log(self, message):
        if not message:
            return
        line = f"{datetime.now():%H:%M:%S}  {message}"
        self.last_log.configure(text=line[:160])
        self.log_box.configure(state="normal")
        self.log_box.insert("end", line + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def on_close(self):
        if self.closing:
            return
        if self.worker.busy.is_set() and not messagebox.askyesno(
                "Run in progress", "A compliance run is in progress. Stop it and close?", parent=self):
            return
        self.closing = True
        self.worker.shutdown()
        self.title("Closing… · Critical Job Compliance")
        self.after(20_000, self.destroy)  # never hang on a stuck browser

    def destroy(self):
        if getattr(self, "_destroyed", False):
            return
        self._destroyed = True
        super().destroy()


def main():
    ctk.set_appearance_mode("light")
    ctk.set_default_color_theme("blue")
    ComplianceApp().mainloop()
