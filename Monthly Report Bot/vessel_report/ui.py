"""Vessel Report Centre desktop workspace. Run: python -m vessel_report."""
from __future__ import annotations
import os
import queue
import re
import time
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox
import customtkinter as ctk
from report_catalog import VESSELS, REPORTS_BY_FREQUENCY, DATE_PRESETS
from .core import DEFAULT_OUTPUT, BatchRequest, ReportJob, parse_range, preset_range, run_batch
from .pickers import VesselPicker, DatePicker
from .worker import SessionWorker
from .scroll_input import ScrollRouter

from suite_services.theme import BG, WHITE, INK, MUTED, BORDER, TEAL, TEAL_HOVER, PALE, NAVY, AMBER, RED
FREQUENCIES = {"Monthly": "M1", "Quarterly": "M3", "Six Monthly": "M6", "Yearly": "M12"}


class ReportApp(ctk.CTk):
    def __init__(self, session_factory=None):
        super().__init__()
        self.title("Vessel Report Centre | Report workspace")
        # Keep the workspace usable on compact displays with Windows DPI scaling.
        device_scale = self._get_window_scaling() / ctk.ScalingTracker.window_scaling
        target_scale = min(device_scale, self.winfo_screenwidth() / 1280, self.winfo_screenheight() / 800)
        ctk.set_widget_scaling(target_scale / device_scale)
        ctk.set_window_scaling(target_scale / device_scale)
        scale = self._get_window_scaling()
        width = min(1380, int(self.winfo_screenwidth() / scale) - 32)
        height = min(900, int(self.winfo_screenheight() / scale) - 64)
        self.geometry(f"{width}x{height}+10+10")
        self.minsize(min(980, width), min(660, height))
        self.configure(fg_color=BG)
        self.running = False
        self.close_when_done = False
        self.events = queue.Queue()
        self.worker = SessionWorker(self.emit, session_factory)
        self.stop_event = self.worker.stop_event
        self.paused_reason = None
        self.closing = False
        self.last_request = None
        self.failed_jobs = []
        self.results = []
        self.log_lines = []
        self.started_at = 0.0
        self.output = DEFAULT_OUTPUT
        self.frequency = tk.StringVar(value="Monthly")
        self.vessels = ()
        self.active_picker = None
        self.search = tk.StringVar()
        self.preset = tk.StringVar(value="Previous Month")
        self.start_date = tk.StringVar()
        self.end_date = tk.StringVar()
        self.selection = {name: tk.BooleanVar(value=False) for items in REPORTS_BY_FREQUENCY.values() for name in items}
        self.controls = []
        self.row_widgets = []
        self.report_rows = {}
        self.empty_report_label = None
        self.scroll_router = ScrollRouter(self)
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)
        self.build_sidebar()
        self.build_workspace()
        self.apply_preset()
        self.render_reports()
        self.search.trace_add("write", lambda *_: self.render_reports())
        self.start_date.trace_add("write", lambda *_: self.update_selection())
        self.end_date.trace_add("write", lambda *_: self.update_selection())
        self.bind("<Control-f>", self.focus_search)
        self.bind("<Control-Return>", lambda _: self.start_batch())
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.poll_timer = self.after(100, self.poll_events)

    def label(self, parent, text, size=13, color=INK, bold=False, **kwargs):
        kwargs.setdefault("height", 0)
        return ctk.CTkLabel(parent, text=text, text_color=color,
            font=ctk.CTkFont(family="Segoe UI", size=size, weight="bold" if bold else "normal"), **kwargs)

    def button(self, parent, text, command, secondary=False, **kwargs):
        return ctk.CTkButton(parent, text=text, command=command, height=36, corner_radius=8,
            fg_color=PALE if secondary else TEAL, hover_color="#D6EBE6" if secondary else TEAL_HOVER,
            text_color=TEAL if secondary else WHITE,
            font=ctk.CTkFont(family="Segoe UI", size=13, weight="bold"), **kwargs)

    def card(self, parent, **kwargs):
        return ctk.CTkFrame(parent, fg_color=WHITE, corner_radius=14, border_width=1, border_color=BORDER, **kwargs)

    def build_sidebar(self):
        rail = ctk.CTkFrame(self, width=168, fg_color=NAVY, corner_radius=0)
        rail.grid(row=0, column=0, sticky="nsew")
        rail.grid_propagate(False)
        rail.grid_columnconfigure(0, weight=1)
        rail.grid_rowconfigure(5, weight=1)
        self.label(rail, "VR", 26, WHITE, True, fg_color=TEAL, corner_radius=12, width=52, height=52).grid(row=0, column=0, sticky="w", padx=24, pady=(30, 14))
        self.label(rail, "Vessel\nReport\nManager", 18, WHITE, True, justify="left", anchor="w").grid(row=1, column=0, sticky="w", padx=24)
        self.label(rail, "FLEET OPERATIONS", 10, "#91ADB8", True).grid(row=2, column=0, sticky="w", padx=24, pady=(10, 38))
        self.nav_reports = self.button(rail, "Reports", lambda: self.show_page("reports"), anchor="w", width=128)
        self.nav_reports.grid(row=3, column=0, padx=20, pady=5)
        self.nav_activity = self.button(rail, "Run activity", lambda: self.show_page("activity"), anchor="w", width=128)
        self.nav_activity.grid(row=4, column=0, padx=20, pady=5)
        note = ctk.CTkFrame(rail, fg_color="#1C3B48", corner_radius=10)
        note.grid(row=6, column=0, sticky="ew", padx=18, pady=18)
        self.label(note, "Your fleet.\nIn one place.", 15, WHITE, True, justify="left").pack(anchor="w", padx=14, pady=(14, 6))
        self.label(note, "Reports ready\nfor review.", 12, "#ACC2CB", justify="left").pack(anchor="w", padx=14, pady=(0, 14))
        guide = ctk.CTkButton(rail, text="Quick guide", command=self.show_guide, fg_color="transparent", hover_color="#284954", text_color="#BDD0D8", anchor="w", height=36)
        guide.grid(row=7, column=0, sticky="ew", padx=20, pady=(0, 20))

    def build_workspace(self):
        workspace = ctk.CTkFrame(self, fg_color="transparent")
        workspace.grid(row=0, column=1, sticky="nsew", padx=20, pady=18)
        workspace.grid_columnconfigure(0, weight=1)
        workspace.grid_rowconfigure(2, weight=1)
        header = ctk.CTkFrame(workspace, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", pady=(0, 20))
        header.grid_columnconfigure(0, weight=1)
        self.label(header, "OPERATIONS  /  REPORT CENTER", 10, MUTED, True).grid(row=0, column=0, sticky="w")
        self.label(header, "Vessel reports", 30, INK, True).grid(row=1, column=0, sticky="w", pady=(4, 2))
        self.label(header, "Find the right reports. Bring every attachment together.", 13, MUTED).grid(row=2, column=0, sticky="w")
        self.status = self.label(header, "Ready", 12, TEAL, True, fg_color=PALE, corner_radius=14, width=140, height=30)
        self.status.grid(row=0, column=1, rowspan=2, sticky="e")
        self.button(header, "Open downloads", self.open_output, secondary=True, width=160).grid(row=2, column=1, sticky="e")
        metrics = ctk.CTkFrame(workspace, fg_color="transparent")
        metrics.grid(row=1, column=0, sticky="ew", pady=(0, 20))
        metrics.grid_columnconfigure((0, 1, 2), weight=1, uniform="metric")
        self.metrics = {}
        for i, (key, title, caption) in enumerate([("selected", "Reports selected", "Next download"), ("files", "Files saved", "Latest run"), ("failed", "Needs attention", "Latest run")]):
            card = self.card(metrics, height=94)
            card.grid(row=0, column=i, sticky="ew", padx=(0 if i == 0 else 7, 0 if i == 2 else 7))
            card.grid_columnconfigure(0, weight=1)
            self.label(card, title, 12, MUTED).grid(row=0, column=0, columnspan=2, sticky="w", padx=18, pady=(12, 0))
            value = self.label(card, "00", 28, TEAL if i != 2 else INK, True)
            value.grid(row=1, column=0, sticky="w", padx=18, pady=(0, 10))
            self.label(card, caption, 10, MUTED).grid(row=1, column=1, sticky="se", padx=18, pady=(0, 16))
            self.metrics[key] = value
        body = ctk.CTkFrame(workspace, fg_color="transparent")
        body.grid(row=2, column=0, sticky="nsew")
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(0, weight=1)
        self.library = self.card(body)
        self.library.grid(row=0, column=0, sticky="nsew", padx=(0, 18))
        self.library.grid_columnconfigure(0, weight=1)
        self.library.grid_rowconfigure(4, weight=1)
        self.label(self.library, "Reports", 18, INK, True).grid(row=0, column=0, sticky="w", padx=16, pady=(12, 10))
        tabs = ctk.CTkSegmentedButton(self.library, values=list(FREQUENCIES), variable=self.frequency,
            command=self.change_frequency, height=30, selected_color="#CEEAE4", selected_hover_color="#BCDFD7",
            unselected_color="#EDF2F4", unselected_hover_color=BORDER, fg_color="#EDF2F4", text_color=INK)
        tabs.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 8))
        self.controls.append(tabs)
        toolbar = ctk.CTkFrame(self.library, fg_color="transparent")
        toolbar.grid(row=3, column=0, sticky="ew", padx=16, pady=(0, 8))
        toolbar.grid_columnconfigure(0, weight=1)
        self.search_entry = ctk.CTkEntry(toolbar, placeholder_text="Search name or code", height=30, corner_radius=6, border_width=1, border_color=BORDER, fg_color="#F8FAFB")
        self.search_entry.grid(row=0, column=0, sticky="ew", padx=(0, 8))
        self.search_entry.bind("<KeyRelease>", lambda _event: self.search.set(self.search_entry.get()))
        select = self.button(toolbar, "Select visible", lambda: self.select_visible(True), secondary=True, width=102)
        select.configure(height=30)
        select.grid(row=0, column=1)
        clear = ctk.CTkButton(toolbar, text="Clear", command=lambda: self.select_visible(False), width=48, height=30, fg_color="transparent", hover_color=BG, text_color=MUTED)
        clear.grid(row=0, column=2, padx=(5, 0))
        self.controls.extend([self.search_entry, select, clear])
        self.report_list = ctk.CTkScrollableFrame(self.library, fg_color=WHITE, corner_radius=0)
        self.register_scroll_frame(self.report_list)
        self.report_list.grid(row=4, column=0, sticky="nsew", padx=12, pady=(0, 6))
        self.report_list.grid_columnconfigure(0, weight=1)
        self.list_footer = self.label(self.library, "", 11, MUTED)
        self.list_footer.grid(row=5, column=0, sticky="w", padx=16, pady=(2, 8))
        self.build_activity(body)
        self.build_setup(body)
        self.build_progress(workspace)
        self.show_page("reports")

    def build_setup(self, body):
        panel = self.card(body, width=294)
        panel.grid(row=0, column=1, sticky="nsew")
        panel.grid_propagate(False)
        panel.grid_columnconfigure(0, weight=1)
        panel.grid_rowconfigure(0, weight=1)
        form = ctk.CTkScrollableFrame(panel, fg_color=WHITE, corner_radius=12)
        self.register_scroll_frame(form)
        form.grid(row=0, column=0, sticky="nsew", padx=6, pady=8)
        form.grid_columnconfigure(0, weight=1)
        self.label(form, "Download setup", 19, INK, True).grid(row=0, column=0, sticky="w", padx=12, pady=(10, 3))
        self.label(form, "One run. Across your fleet.", 12, MUTED).grid(row=1, column=0, sticky="w", padx=12, pady=(0, 20))
        self.label(form, "01   Vessels", 12, INK, True).grid(row=2, column=0, sticky="w", padx=12)
        self.vessel_button = self.button(form, "Choose vessels / Change", self.open_vessels, secondary=True)
        self.vessel_button.grid(row=3, column=0, sticky="ew", padx=12, pady=(7, 18))
        self.label(form, "02   Date range", 12, INK, True).grid(row=4, column=0, sticky="w", padx=12)
        preset = ctk.CTkOptionMenu(form, values=DATE_PRESETS, variable=self.preset, command=self.apply_preset, height=38, fg_color=BG, button_color=BORDER, button_hover_color="#C9D9DF", text_color=INK, dropdown_fg_color=WHITE, dropdown_text_color=INK, dropdown_hover_color=PALE)
        preset.grid(row=5, column=0, sticky="ew", padx=12, pady=(7, 10))
        dates = ctk.CTkFrame(form, fg_color="transparent")
        dates.grid(row=6, column=0, sticky="ew", padx=12)
        dates.grid_columnconfigure((0, 1), weight=1, uniform="dates")
        self.date_entries = []
        self.calendar_buttons = []
        for col, (title, variable) in enumerate([("From", self.start_date), ("To", self.end_date)]):
            self.label(dates, title, 11, MUTED).grid(row=0, column=col, sticky="w", padx=(0 if col == 0 else 5, 0))
            field = ctk.CTkFrame(dates, fg_color=WHITE, border_width=1, border_color=BORDER, corner_radius=6)
            field.grid(row=1, column=col, sticky="ew", padx=(0 if col == 0 else 5, 5 if col == 0 else 0))
            field.grid_columnconfigure(0, weight=1)
            entry = ctk.CTkEntry(field, textvariable=variable, height=32, width=78,
                font=("Segoe UI", 11), border_width=0, corner_radius=0, fg_color=WHITE)
            entry.grid(row=0, column=0, sticky="ew", padx=(4, 0), pady=2)
            entry.bind("<Alt-Down>", lambda _event, v=variable, t=title: self.open_calendar(v, t))
            entry.bind("<Button-1>", lambda _event, v=variable, t=title:
                self.open_calendar(v, t) if self.preset.get() != "Custom Range" else None)
            self.date_entries.append(entry)
            calendar_button = ctk.CTkButton(field, text="▦", command=lambda v=variable, t=title: self.open_calendar(v, t),
                width=24, height=30, corner_radius=4, fg_color=WHITE, hover_color=PALE,
                text_color=TEAL, font=("Segoe UI", 18))
            calendar_button.grid(row=0, column=1, padx=(0, 3), pady=2)
            self.calendar_buttons.append(calendar_button)
        self.date_hint = self.label(form, "Based on Job End Date (inclusive)", 11, MUTED, wraplength=235, justify="left")
        self.date_hint.grid(row=7, column=0, sticky="w", padx=12, pady=(6, 18))
        self.label(form, "03   Save location", 12, INK, True).grid(row=8, column=0, sticky="w", padx=12)
        self.folder_label = self.label(form, str(self.output), 11, MUTED, wraplength=230, justify="left", anchor="w")
        self.folder_label.grid(row=9, column=0, sticky="ew", padx=12, pady=(7, 8))
        choose = self.button(form, "Change folder...", self.choose_folder, secondary=True)
        choose.grid(row=10, column=0, sticky="ew", padx=12, pady=(0, 14))
        self.label(form, "Organized by vessel and job month.", 11, MUTED).grid(row=11, column=0, sticky="w", padx=12)
        self.controls.extend([self.vessel_button, preset, choose])
        action = ctk.CTkFrame(panel, fg_color="#F7FAFA", corner_radius=10)
        action.grid(row=1, column=0, sticky="ew", padx=14, pady=(4, 14))
        self.summary = self.label(action, "Select reports to get started", 12, INK, True, wraplength=235)
        self.summary.pack(fill="x", padx=12, pady=(12, 8))
        self.download_button = self.button(action, "Download reports", self.start_batch)
        self.download_button.configure(height=42)
        self.download_button.pack(fill="x", padx=12, pady=(0, 8))
        self.label(action, "One Edge session for all your downloads", 10, MUTED).pack(pady=(0, 10))

    def build_activity(self, body):
        self.activity = self.card(body)
        self.activity.grid_columnconfigure(0, weight=1)
        self.activity.grid_rowconfigure(2, weight=1)
        head = ctk.CTkFrame(self.activity, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=20, pady=(18, 5))
        head.grid_columnconfigure(0, weight=1)
        self.label(head, "Run activity", 19, INK, True).grid(row=0, column=0, sticky="w")
        self.retry_button = self.button(head, "Retry failed", self.retry_failed, secondary=True, width=105)
        self.retry_button.grid(row=0, column=1)
        self.retry_button.configure(state="disabled")
        self.activity_caption = self.label(self.activity, "Results and live steps from your latest run appear here.", 12, MUTED, wraplength=400, justify="left")
        self.activity_caption.grid(row=1, column=0, sticky="w", padx=20, pady=(0, 10))
        self.activity_tabs = ctk.CTkTabview(self.activity, fg_color=WHITE, segmented_button_selected_color="#CEEAE4", segmented_button_selected_hover_color="#BCDFD7", text_color=INK)
        self.activity_tabs.grid(row=2, column=0, sticky="nsew", padx=12, pady=(0, 12))
        results = self.activity_tabs.add("Results")
        logs = self.activity_tabs.add("Live log")
        self.result_list = ctk.CTkScrollableFrame(results, fg_color=WHITE)
        self.register_scroll_frame(self.result_list)
        self.result_list.pack(fill="both", expand=True)
        self.result_list.grid_columnconfigure(0, weight=1)
        self.label(self.result_list, "No downloads yet\n\nChoose reports from the library to start your first run.", 13, MUTED, wraplength=350, justify="center").grid(row=0, column=0, pady=60, padx=15)
        self.log_box = ctk.CTkTextbox(logs, fg_color="#F5F8FA", text_color=INK, font=("Consolas", 11), wrap="word", state="disabled")
        self.log_box.pack(fill="both", expand=True)
        self.button(self.activity, "Export run log...", self.export_log, secondary=True).grid(row=3, column=0, sticky="w", padx=20, pady=(0, 16))

    def build_progress(self, workspace):
        progress = self.card(workspace)
        progress.grid(row=3, column=0, sticky="ew", pady=(18, 0))
        progress.grid_columnconfigure(0, weight=1)
        self.progress_title = self.label(progress, "Ready when you are", 13, INK, True)
        self.progress_title.grid(row=0, column=0, sticky="w", padx=18, pady=(12, 0))
        self.elapsed = self.label(progress, "", 11, MUTED)
        self.elapsed.grid(row=0, column=1, sticky="e", padx=18, pady=(12, 0))
        self.progress_detail = self.label(progress, "Select vessels, choose reports, and set a date range.", 11, MUTED, anchor="w", wraplength=550)
        self.progress_detail.grid(row=1, column=0, sticky="ew", padx=18, pady=(2, 7))
        self.stop_button = self.button(progress, "Stop after report", self.stop_batch, secondary=True, width=145)
        self.stop_button.grid(row=1, column=1, rowspan=2, padx=18, pady=(0, 12))
        self.stop_button.configure(state="disabled")
        self.progress_bar = ctk.CTkProgressBar(progress, height=5, progress_color=TEAL, fg_color=BORDER)
        self.progress_bar.grid(row=2, column=0, sticky="ew", padx=18, pady=(0, 14))
        self.progress_bar.set(0)
        self.recovery_controls = ctk.CTkFrame(progress, fg_color="transparent")
        self.recovery_controls.grid(row=3, column=0, columnspan=2, sticky="w", padx=18, pady=(0, 12))
        self.sign_in_button = self.button(self.recovery_controls, "Sign in in Edge", self.show_sign_in, secondary=True, width=145)
        self.sign_in_button.grid(row=0, column=0, padx=(0, 10))
        self.resume_button = self.button(self.recovery_controls, "Resume", self.resume_session, width=225)
        self.resume_button.grid(row=0, column=1)
        self.recovery_controls.grid_remove()

    def register_scroll_frame(self, frame):
        self._bind_scroll_tree(frame)

    def _bind_scroll_tree(self, widget):
        self.scroll_router.attach(widget)
    def show_page(self, page):
        self.page = page
        self.library.grid_remove()
        self.activity.grid_remove()
        (self.library if page == "reports" else self.activity).grid(row=0, column=0, sticky="nsew", padx=(0, 18))
        for button, active in [(self.nav_reports, page == "reports"), (self.nav_activity, page == "activity")]:
            button.configure(fg_color=TEAL if active else "transparent", hover_color=TEAL_HOVER if active else "#284954", text_color=WHITE if active else "#BDD0D8")

    def focus_search(self, _event=None):
        self.show_page("reports")
        if not self.running:
            self.search_entry.focus_set()
        return "break"

    def visible_reports(self):
        query = self.search.get().strip().casefold()
        return sorted(
            (name for name in REPORTS_BY_FREQUENCY[self.frequency.get()]
             if query in name.casefold() or query in self.report_display(name)[0].casefold()),
            key=lambda name: self.report_display(name)[0].casefold(),
        )

    @staticmethod
    def report_display(name):
        """Presentation only: selection and browser searches use the original."""
        match = re.match(r"^(\d+(?:\.\d+)+)\s*-?\s*(.+)$", name)
        code, title = match.groups() if match else ("", name)
        aliases = {
            "KPI - Ship Report": "Ship KPI",
            "Record Sheet for Ozone Depleting Substances (ODS)": "Ozone-depleting substances (ODS)",
            "Stock of Paint Record": "Paint stock",
            "Evaluation reports for Drills & Training Exercises": "Drills & training evaluation",
            "CRITICAL TEST AND CHECKS": "Critical tests & checks",
            "CRITICAL EQUIPMENT PERFORMANCE": "Critical equipment performance",
        }
        return aliases.get(title, title), code

    @staticmethod
    def fit_report_title(label, event):
        # Wrap to the available column instead of a fixed 340-pixel width.
        width = max(80, int(event.width / label._get_widget_scaling()) - 165)
        if getattr(label, "_report_wrap", None) != width:
            label._report_wrap = width
            label.after_idle(lambda: label.configure(wraplength=width) if label.winfo_exists() else None)

    def selected_reports(self):
        return tuple(name for name in REPORTS_BY_FREQUENCY[self.frequency.get()] if self.selection[name].get())

    def change_frequency(self, _value=None):
        had_search = bool(self.search.get())
        self.search_entry.delete(0, "end")
        if had_search:
            self.search.set("")
        else:
            self.render_reports()

    def render_reports(self):
        frequency_reports = REPORTS_BY_FREQUENCY[self.frequency.get()]
        for index, name in enumerate(frequency_reports):
            if name not in self.report_rows:
                self.report_rows[name] = self.create_report_row(name)
                self.report_rows[name][0].grid(row=index, column=0, sticky="ew", padx=2, pady=1)

        reports = self.visible_reports()
        visible = set(reports)
        self.row_widgets.clear()
        for index, name in enumerate(reports):
            row, check = self.report_rows[name]
            row.grid(row=index, column=0, sticky="ew", padx=2, pady=1)
            row.configure(fg_color=PALE if self.selection[name].get() else "#F8FAFB")
            check.configure(state="disabled" if self.running else "normal")
            self.row_widgets.append((name, row, check))
        for name, (row, _) in self.report_rows.items():
            if name not in visible:
                row.grid_remove()
        if not reports:
            if self.empty_report_label is None:
                self.empty_report_label = self.label(
                    self.report_list,
                    "No matching reports\nTry a shorter name or a report code.",
                    13,
                    MUTED,
                    justify="center",
                )
            self.empty_report_label.grid(row=0, column=0, pady=60)
        elif self.empty_report_label is not None:
            self.empty_report_label.grid_remove()
        self.update_selection()

    def create_report_row(self, name):
        row = ctk.CTkFrame(self.report_list, fg_color="#F8FAFB", corner_radius=4)
        row.grid_columnconfigure(1, weight=1)
        check = ctk.CTkCheckBox(row, text="", variable=self.selection[name], command=self.update_selection, width=18, height=18, checkbox_width=16, checkbox_height=16, corner_radius=4, fg_color=TEAL, hover_color=TEAL_HOVER, border_color="#A7B8C0")
        check.grid(row=0, column=0, padx=(10, 9), pady=8)
        display_name, code = self.report_display(name)
        title = self.label(row, display_name, 13, INK, wraplength=280, justify="left", anchor="w", width=1)
        title.grid(row=0, column=1, sticky="ew", padx=(0, 10), pady=7)
        row.bind("<Configure>", lambda event, label=title: self.fit_report_title(label, event))
        reference = self.label(row, code, 10, MUTED, anchor="e", width=108)
        reference.grid(row=0, column=2, sticky="e", padx=(0, 10))
        reference.bind("<Button-1>", lambda _event, report=name: self.toggle_report(report))
        row.bind("<Button-1>", lambda _event, report=name: self.toggle_report(report))
        title.bind("<Button-1>", lambda _event, report=name: self.toggle_report(report))
        self._bind_scroll_tree(row)
        return row, check

    def toggle_report(self, name):
        if not self.running:
            self.selection[name].set(not self.selection[name].get())
            self.update_selection()

    def select_visible(self, selected):
        if not self.running:
            for name in self.visible_reports():
                self.selection[name].set(selected)
            self.update_selection()

    def update_selection(self):
        count = len(self.selected_reports())
        self.metrics["selected"].configure(text=f"{count:02}")
        self.list_footer.configure(text=f"{len(self.visible_reports())} reports  ·  {count} selected")
        vessel_count = len(self.vessels)
        jobs = count * vessel_count
        vessel_text = "Choose vessels" if not vessel_count else "All vessels selected" if vessel_count == len(VESSELS) else self.vessels[0] if vessel_count == 1 else f"{vessel_count} vessels selected"
        self.vessel_button.configure(text=f"{vessel_text} / Change")
        self.summary.configure(text=f"{vessel_count} vessel{'s' if vessel_count != 1 else ''} x {count} report{'s' if count != 1 else ''} = {jobs} jobs" if count else "Select reports to get started")
        valid = True
        try:
            parse_range(self.start_date.get(), self.end_date.get())
            self.date_hint.configure(text="Based on Job End Date (inclusive)", text_color=MUTED)
        except ValueError as error:
            valid = False
            self.date_hint.configure(text=str(error), text_color=RED)
        self.download_button.configure(state="normal" if jobs and valid and not self.running else "disabled", text=f"Download {jobs} job{'s' if jobs != 1 else ''}" if jobs else "Select vessels and reports")
        for name, row, _ in self.row_widgets:
            row.configure(fg_color=PALE if self.selection[name].get() else "#F8FAFB")

    def apply_preset(self, _value=None):
        dates = preset_range(self.preset.get())
        if dates:
            self.start_date.set(dates[0].strftime("%d-%b-%Y"))
            self.end_date.set(dates[1].strftime("%d-%b-%Y"))
        for entry in self.date_entries:
            entry.configure(state="normal" if dates is None and not self.running else "disabled")
        for button in self.calendar_buttons:
            button.configure(state="disabled" if self.running else "normal")
        self.update_selection()

    def dismiss_picker(self):
        if self.active_picker is not None and self.active_picker.winfo_exists():
            self.active_picker.close()
        self.active_picker = None

    def open_vessels(self):
        if self.running:
            return None
        self.dismiss_picker()
        self.active_picker = VesselPicker(self, VESSELS, self.vessels, self.set_vessels)
        return self.active_picker

    def set_vessels(self, vessels):
        if not self.running:
            self.vessels = tuple(sorted((name for name in VESSELS if name in vessels), key=str.casefold))
            self.update_selection()

    def open_calendar(self, variable, title):
        if self.running:
            return None
        self.dismiss_picker()
        index = 0 if variable is self.start_date else 1
        self.active_picker = DatePicker(self, f"Choose {title.lower()} date", variable.get(),
            lambda value: self.choose_calendar_date(variable, value),
            anchor=self.calendar_buttons[index].master)
        return self.active_picker

    def choose_calendar_date(self, variable, value):
        if self.running:
            return
        self.preset.set("Custom Range")
        variable.set(value)
        self.apply_preset()

    def choose_folder(self):
        folder = filedialog.askdirectory(parent=self, title="Choose download folder", initialdir=str(self.output if self.output.exists() else Path.home()))
        if folder:
            self.output = Path(folder)
            self.folder_label.configure(text=str(self.output))

    def open_output(self):
        folder = self.last_request.output if self.last_request else self.output
        if not folder.exists():
            messagebox.showinfo("Downloads", "This folder will be created when the first attachment is saved.", parent=self)
            return
        try:
            os.startfile(str(folder))
        except OSError as error:
            messagebox.showerror("Cannot open folder", str(error), parent=self)

    def set_running(self, running):
        self.running = running
        for widget in self.controls:
            widget.configure(state="disabled" if running else "normal")
        for _, _, check in self.row_widgets:
            check.configure(state="disabled" if running else "normal")
        self.stop_button.configure(state="normal" if running else "disabled", text="Stop after report")
        self.retry_button.configure(state="normal" if not running and self.failed_jobs else "disabled")
        self.apply_preset()

    def start_batch(self, request=None):
        if self.running or self.closing:
            return
        if request is None:
            if not self.selected_reports() or not self.vessels:
                return
            try:
                start, end = parse_range(self.start_date.get(), self.end_date.get())
            except ValueError:
                self.update_selection()
                return
            request = BatchRequest(self.vessels, self.frequency.get(), self.selected_reports(), start, end, self.output)
        self.dismiss_picker()
        self.last_request = request
        self.failed_jobs = []
        self.results = []
        self.log_lines = []
        for child in self.result_list.winfo_children():
            child.destroy()
        self.log_box.configure(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.configure(state="disabled")
        self.metrics["files"].configure(text="00")
        self.metrics["failed"].configure(text="00", text_color=INK)
        self.stop_event.clear()
        self.started_at = time.monotonic()
        self.fatal_error = False
        self.set_running(True)
        self.status.configure(text="Downloading", fg_color=PALE, text_color=TEAL)
        self.progress_bar.set(0)
        self.progress_title.configure(text=f"Preparing {len(request.jobs)} vessel/report jobs")
        self.activity_caption.configure(text=f"{len(set(job.vessel for job in request.jobs))} vessels / {len(request.jobs)} jobs / {request.start:%d %b %Y} - {request.end:%d %b %Y}")
        self.show_page("activity")
        self.activity_tabs.set("Live log")
        self.append_log(f"Run started | {', '.join(request.vessels)} | {request.frequency} | {request.start:%d-%b-%Y} to {request.end:%d-%b-%Y}")
        self.append_log(f"Save location: {request.output}")
        if self.worker.closed.is_set():
            self.worker = SessionWorker(self.emit, self.worker.session_factory)
            self.stop_event = self.worker.stop_event
        self.worker.submit(request)

    def emit(self, kind, **data):
        self.events.put((kind, data))

    def append_log(self, message):
        if not message.strip() or set(message.strip()) == {"="}:
            return
        line = f"{datetime.now():%H:%M:%S}  {message}"
        self.log_lines.append(line)
        self.log_box.configure(state="normal")
        self.log_box.insert("end", line + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def add_result(self, result):
        self.results.append(result)
        if result["error"]:
            self.failed_jobs.append(ReportJob(result["vessel"], result["report"]))
        card = ctk.CTkFrame(self.result_list, fg_color="#FFF5EC" if result["error"] else PALE, corner_radius=9)
        card.grid(row=len(self.results), column=0, sticky="ew", padx=3, pady=5)
        title = self.label(card, f"{result['vessel']} / {result['report']}", 12, INK, True, wraplength=340, justify="left", anchor="w")
        title.pack(fill="x", padx=12, pady=(12, 5))
        self.label(card, f"{result['status']} / {len(result['paths'])} file(s) saved", 11, AMBER if result["error"] else TEAL, True).pack(anchor="w", padx=12, pady=(0, 10))
        if result["error"]:
            error_label = self.label(card, result["error"], 11, AMBER, wraplength=340, justify="left", anchor="w")
            error_label.pack(fill="x", padx=12, pady=(0, 12))
        self.append_log(f"{result['status']} | {result['vessel']} | {result['report']} | {len(result['paths'])} file(s)" + (f"\n{result['error']}" if result["error"] else ""))

    def poll_events(self):
        for _ in range(150):
            try:
                kind, data = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                self.append_log(data["message"])
                self.progress_detail.configure(text=data["message"][:100])
            elif kind == "session":
                self.append_log(data["message"])
            elif kind == "paused":
                self.paused_reason = data["reason"]
                self.metrics["files"].configure(text=f"{data['files']:02}")
                self.status.configure(text="Paused", fg_color="#FFF3DF", text_color=AMBER)
                self.progress_title.configure(text="Queue paused - your progress is saved")
                self.progress_detail.configure(text=data["message"])
                self.append_log(data["message"])
                self.recovery_controls.grid()
                if self.paused_reason == "browser":
                    self.sign_in_button.grid_remove()
                else:
                    self.sign_in_button.grid()
                self.resume_button.configure(text="Reopen browser and resume" if self.paused_reason == "browser" else "Resume", state="normal")
                self.stop_button.configure(text="Stop queue", state="normal")
            elif kind == "resumed":
                self.paused_reason = None
                self.recovery_controls.grid_remove()
                self.status.configure(text="Downloading", fg_color=PALE, text_color=TEAL)
                self.stop_button.configure(text="Stop after report", state="normal")
                self.append_log(f"Resuming {data['vessel']} / {data['report']}")
            elif kind == "worker_closed":
                if self.closing:
                    self.destroy()
                    return
            elif kind == "started":
                self.progress_title.configure(text="Downloading report")
                self.progress_detail.configure(text=f"{data['vessel']} / {data['report']}"[:100])
            elif kind == "result":
                self.add_result(data)
            elif kind == "progress":
                self.metrics["files"].configure(text=f"{data['files']:02}")
                self.metrics["failed"].configure(text=f"{data['failed']:02}", text_color=AMBER if data["failed"] else INK)
                self.progress_bar.set(data["completed"] / len(self.last_request.jobs))
                self.progress_title.configure(text=f"{data['completed']} of {len(self.last_request.jobs)} jobs processed")
            elif kind == "fatal":
                self.fatal_error = True
                self.append_log(data["message"])
                self.failed_jobs = list(self.last_request.jobs) if self.last_request else []
            elif kind == "finished":
                self.paused_reason = None
                self.recovery_controls.grid_remove()
                self.set_running(False)
                title = "Run stopped" if data["stopped"] else "Completed with issues" if data["failed"] or self.fatal_error else "Download complete"
                warning = data["stopped"] or data["failed"] or self.fatal_error
                self.status.configure(text=title, text_color=AMBER if warning else TEAL, fg_color="#FFF3DF" if warning else PALE)
                self.progress_title.configure(text=title)
                self.progress_detail.configure(text=f"{data['completed']} of {len(self.last_request.jobs)} jobs processed / {data['files']} files saved / {data['failed']} jobs need attention")
                self.append_log(title)
                self.activity_tabs.set("Results")
                if self.fatal_error and not self.results:
                    self.activity_tabs.set("Live log")
                if self.close_when_done:
                    self.begin_shutdown()
        if self.running:
            seconds = int(time.monotonic() - self.started_at)
            self.elapsed.configure(text=f"{seconds // 60:02}:{seconds % 60:02} elapsed")
        self.poll_timer = self.after(100, self.poll_events)

    def stop_batch(self):
        if self.running:
            self.worker.stop()
            self.stop_button.configure(state="disabled", text="Stopping queue..." if self.paused_reason else "Stopping after report...")
            self.status.configure(text="Stopping", text_color=AMBER, fg_color="#FFF3DF")
            self.append_log("Stopping the paused queue." if self.paused_reason else "Stop requested. The current report will finish; remaining reports will not start.")

    def retry_failed(self):
        if self.last_request and self.failed_jobs and not self.running:
            r = self.last_request
            self.start_batch(r.retry(self.failed_jobs))

    def export_log(self):
        if not self.log_lines:
            messagebox.showinfo("Run log", "Start a download to create a run log.", parent=self)
            return
        target = filedialog.asksaveasfilename(parent=self, title="Export run log", defaultextension=".txt", initialfile=f"report-run-{datetime.now():%Y%m%d-%H%M}.txt", filetypes=[("Text file", "*.txt")])
        if target:
            try:
                Path(target).write_text("\n".join(self.log_lines) + "\n", encoding="utf-8")
            except OSError as error:
                messagebox.showerror("Could not export log", str(error), parent=self)

    def show_guide(self):
        messagebox.showinfo("Quick guide", "1. Choose a frequency and select reports. Search by name or form code. Selections are remembered per frequency; each run uses the current frequency.\n\n2. Choose one, multiple, or all vessels and a date range. In Custom Range, use either Calendar button or type DD-MMM-YYYY. The last 3/6/12 months include the current partial month.\n\n3. Choose a save folder and start downloading. Edge stays open across batches. If sign-in expires, use Sign in in Edge, finish sign-in, then Resume. If Edge closes, use Reopen browser and resume.\n\n4. Review Results or Live log. Stop after report finishes the active report before stopping. Retry failed repeats only failed vessel/report pairs using the original dates and folder; already saved files are retained and may be downloaded again with numbered names.\n\nJob History currently reads loaded visible rows only. Additional pages may require a separate retrieval.\n\nShortcuts: Ctrl+F to search / Ctrl+Enter to download.", parent=self)

    def show_sign_in(self):
        if self.paused_reason:
            self.worker.show_sign_in()

    def resume_session(self):
        if self.paused_reason and not self.closing:
            self.resume_button.configure(state="disabled")
            self.worker.resume(reopen=self.paused_reason == "browser")

    def begin_shutdown(self):
        if not self.closing:
            self.closing = True
            self.status.configure(text="Closing Edge")
            self.download_button.configure(state="disabled")
            self.worker.shutdown()

    def on_close(self):
        if self.closing:
            return
        if self.running:
            prompt = "Stop the paused queue and close Edge?" if self.paused_reason else "Finish the current report, stop the remaining queue, and then close Edge?"
            if messagebox.askyesno("Download in progress", prompt, parent=self):
                self.close_when_done = True
                self.begin_shutdown()
        else:
            self.begin_shutdown()

    def destroy(self):
        # Also covers programmatic window teardown. No Playwright call runs here.
        if hasattr(self, "worker") and not self.worker.closed.is_set():
            self.worker.shutdown()
        if hasattr(self, "poll_timer"):
            self.after_cancel(self.poll_timer)
        super().destroy()


def main():
    ctk.set_appearance_mode("light")
    ctk.set_default_color_theme("blue")
    ReportApp().mainloop()


if __name__ == "__main__":
    main()
