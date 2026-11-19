"""Sign-in screen and Admin window for the NeraVeda launcher (CustomTkinter)."""
from __future__ import annotations

import queue
import threading
import tkinter as tk
from dataclasses import replace
from tkinter import messagebox

import customtkinter as ctk

from suite_services.access.entitlements import MODULE_TITLES, MODULES, UserAccess, normalise_email

BG, SURFACE, INK, MUTED, SEP = "#F3F6F9", "#FFFFFF", "#0F1B2A", "#5F6B7A", "#E3E8EE"
NAVY, BTN, BTN_HV, IDLE_BG = "#0E2A47", "#1557A0", "#114888", "#EEF1F4"
CRITICAL, CRITICAL_BG, GOOD, GOOD_BG = "#8F2414", "#FBE9E6", "#1E7A45", "#E3F4EA"


def _font(size=12, bold=False):
    return ctk.CTkFont("Segoe UI", size, weight="bold" if bold else "normal")


def _label(parent, text, size=12, color=INK, bold=False, **kwargs):
    return ctk.CTkLabel(parent, text=text, text_color=color, font=_font(size, bold), anchor="w", justify="left", **kwargs)


class SignInPanel(ctk.CTkFrame):
    """Shown instead of the home screen until the person is signed in."""

    def __init__(self, master, *, on_sign_in, on_code, on_close, needs_setup: bool = False):
        super().__init__(master, fg_color=BG, corner_radius=0)
        card = ctk.CTkFrame(self, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=16, width=460)
        card.place(relx=0.5, rely=0.45, anchor="center")
        brand = ctk.CTkFrame(card, fg_color="transparent")
        brand.pack(fill="x", padx=32, pady=(28, 0))
        mark = ctk.CTkFrame(brand, width=44, height=44, fg_color=BTN, corner_radius=12)
        mark.pack(side="left", padx=(0, 12))
        mark.pack_propagate(False)
        _label(mark, "N", 20, "#FFFFFF", True).pack(expand=True)
        names = ctk.CTkFrame(brand, fg_color="transparent")
        names.pack(side="left")
        _label(names, "NeraVeda", 17, INK, True).pack(anchor="w")
        _label(names, "Fleet Intelligence Suite", 11, MUTED).pack(anchor="w")

        _label(card, "Sign in", 20, INK, True).pack(anchor="w", padx=32, pady=(22, 2))
        self.intro = _label(card, "Use your Goodwood Microsoft work account. Your admin decides which workspaces you can open.",
                            12, MUTED, wraplength=390)
        self.intro.pack(anchor="w", padx=32)
        self.sign_in_button = ctk.CTkButton(card, text="Sign in with Microsoft", command=on_sign_in, height=40, corner_radius=10,
                                            fg_color=BTN, hover_color=BTN_HV, font=_font(12, True))
        self.sign_in_button.pack(fill="x", padx=32, pady=(20, 6))
        self.code_button = ctk.CTkButton(card, text="Sign in with a code instead", command=on_code, height=32, corner_radius=10,
                                         fg_color="transparent", hover_color=IDLE_BG, text_color=BTN, font=_font(11, True))
        self.code_button.pack(fill="x", padx=32)
        self.status = _label(card, "", 11, MUTED, wraplength=390)
        self.status.pack(anchor="w", padx=32, pady=(14, 0))
        self.detail = ctk.CTkTextbox(card, height=0, fg_color=IDLE_BG, text_color=INK, font=_font(11), wrap="word", corner_radius=8)
        self.close_button = ctk.CTkButton(card, text="Close", command=on_close, height=32, corner_radius=10, fg_color=IDLE_BG,
                                          hover_color=SEP, text_color=INK, font=_font(11, True))
        self.close_button.pack(fill="x", padx=32, pady=(14, 26))
        if needs_setup:
            self.sign_in_button.configure(state="disabled")
            self.code_button.configure(state="disabled")
            self.error("Sign-in is not set up on this PC",
                       "NeraVeda requires sign-in, but this PC has no sign-in settings yet. Ask your NeraVeda admin to set it up "
                       "(python -m suite_services.access setup).")

    def busy(self, text: str) -> None:
        self.sign_in_button.configure(state="disabled")
        self.code_button.configure(state="disabled")
        self.status.configure(text=text, text_color=MUTED)

    def ready(self, text: str = "") -> None:
        self.sign_in_button.configure(state="normal")
        self.code_button.configure(state="normal")
        self.status.configure(text=text, text_color=MUTED)

    def _show_detail(self, text: str) -> None:
        self.detail.configure(state="normal", height=70)
        self.detail.delete("1.0", "end")
        self.detail.insert("1.0", text)
        self.detail.configure(state="disabled")
        self.detail.pack(fill="x", padx=32, pady=(8, 0), before=self.close_button)

    def show_code(self, message: str) -> None:
        self.status.configure(text="Complete the sign-in in your browser with this code:", text_color=INK)
        self._show_detail(message)

    def error(self, title: str, text: str, email: str | None = None) -> None:
        self.status.configure(text=title, text_color=CRITICAL)
        extra = f"\n\nSign-in name to give your admin: {email}" if email else ""
        self._show_detail(text + extra)


class AdminWindow(ctk.CTkToplevel):
    """People and their workspaces. Every save is checked against the version loaded and audited centrally."""

    def __init__(self, master, access):
        super().__init__(master)
        self.title("NeraVeda · People and access")
        self.geometry("980x640")
        self.minsize(860, 560)
        self.configure(fg_color=BG)
        self.access = access
        self.store = access.admin_store()
        self.events: queue.Queue = queue.Queue()
        self.people: list[UserAccess] = []
        self.current: UserAccess | None = None
        self.creating = False
        self.module_vars = {m: tk.BooleanVar(value=False) for m in MODULES}
        self.admin_var = tk.BooleanVar(value=False)
        self.active_var = tk.BooleanVar(value=True)
        self._build()
        self.transient(master)
        self.after(50, self.lift)
        self.reload()

    # ── layout ──
    def _build(self):
        top = ctk.CTkFrame(self, fg_color=BG)
        top.pack(fill="x", padx=20, pady=(16, 6))
        _label(top, "People and access", 18, INK, True).pack(side="left")
        self.protection = _label(top, "Checking database permissions…", 11, MUTED)
        self.protection.pack(side="right")

        body = ctk.CTkFrame(self, fg_color=BG)
        body.pack(fill="both", expand=True, padx=20, pady=(0, 16))
        body.grid_columnconfigure(0, weight=2, uniform="cols")
        body.grid_columnconfigure(1, weight=3, uniform="cols")
        body.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(body, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=12)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        bar = ctk.CTkFrame(left, fg_color="transparent")
        bar.pack(fill="x", padx=12, pady=(12, 6))
        self.search = ctk.CTkEntry(bar, placeholder_text="Search name or email", height=32)
        self.search.pack(side="left", fill="x", expand=True)
        self.search.bind("<KeyRelease>", lambda _e: self._render_people())
        self.add_button = ctk.CTkButton(bar, text="Add person", width=104, height=32, command=self.new_person, fg_color=BTN, hover_color=BTN_HV, font=_font(11, True))
        self.add_button.pack(side="left", padx=(8, 0))
        self.people_frame = ctk.CTkScrollableFrame(left, fg_color="transparent")
        self.people_frame.pack(fill="both", expand=True, padx=6, pady=(0, 10))

        right = ctk.CTkFrame(body, fg_color=SURFACE, border_width=1, border_color=SEP, corner_radius=12)
        right.grid(row=0, column=1, sticky="nsew")
        form = ctk.CTkScrollableFrame(right, fg_color="transparent")
        form.pack(fill="both", expand=True, padx=8, pady=8)
        self.heading = _label(form, "Choose a person, or add one.", 15, INK, True)
        self.heading.pack(anchor="w", padx=10, pady=(6, 10))
        _label(form, "Sign-in name (work email)", 11, MUTED, True).pack(anchor="w", padx=10)
        self.email = ctk.CTkEntry(form, height=32)
        self.email.pack(fill="x", padx=10, pady=(2, 8))
        _label(form, "Name", 11, MUTED, True).pack(anchor="w", padx=10)
        self.name = ctk.CTkEntry(form, height=32)
        self.name.pack(fill="x", padx=10, pady=(2, 10))
        flags = ctk.CTkFrame(form, fg_color="transparent")
        flags.pack(fill="x", padx=10, pady=(0, 8))
        ctk.CTkSwitch(flags, text="Active (may sign in)", variable=self.active_var, font=_font(12)).pack(side="left", padx=(0, 18))
        ctk.CTkSwitch(flags, text="Admin (manages people)", variable=self.admin_var, font=_font(12)).pack(side="left")
        _label(form, "Workspaces", 11, MUTED, True).pack(anchor="w", padx=10, pady=(6, 2))
        grid = ctk.CTkFrame(form, fg_color="transparent")
        grid.pack(fill="x", padx=10)
        for index, module in enumerate(MODULES):
            ctk.CTkCheckBox(grid, text=MODULE_TITLES[module], variable=self.module_vars[module], font=_font(12)).grid(
                row=index // 2, column=index % 2, sticky="w", padx=(0, 16), pady=4)
        _label(form, "Reason for the change (recorded in the audit)", 11, MUTED, True).pack(anchor="w", padx=10, pady=(12, 2))
        self.reason = ctk.CTkEntry(form, height=32, placeholder_text="e.g. joined the technical team")
        self.reason.pack(fill="x", padx=10)
        actions = ctk.CTkFrame(form, fg_color="transparent")
        actions.pack(fill="x", padx=10, pady=(12, 4))
        self.save_button = ctk.CTkButton(actions, text="Save", width=110, height=34, command=self.save, fg_color=BTN, hover_color=BTN_HV, font=_font(12, True))
        self.save_button.pack(side="left")
        self.status = _label(actions, "", 11, MUTED, wraplength=380)
        self.status.pack(side="left", padx=(12, 0))
        _label(form, "Recent changes", 11, MUTED, True).pack(anchor="w", padx=10, pady=(14, 2))
        self.audit_box = ctk.CTkTextbox(form, height=170, fg_color=IDLE_BG, text_color=INK, font=_font(10), wrap="word")
        self.audit_box.pack(fill="x", padx=10, pady=(0, 6))
        self._set_form(None)

    # ── background calls (Atlas) ──
    def _run(self, kind, fn):
        def work():
            try:
                self.events.put((kind, fn(), None))
            except Exception as error:  # shown to the admin; never crashes the launcher
                self.events.put((kind, None, error))
        threading.Thread(target=work, daemon=True).start()
        self.after(120, self._poll)

    def _poll(self):
        try:
            kind, value, error = self.events.get_nowait()
        except queue.Empty:
            self.after(120, self._poll)
            return
        except tk.TclError:
            return
        try:
            self._handle(kind, value, error)
        except tk.TclError:
            return

    def _handle(self, kind, value, error):
        if kind == "privileges":
            self.protection.configure(text=f"Database credential: {value['summary']}" if not error else "Database permissions could not be checked",
                                      text_color=MUTED if not error and not value.get("can_remove") else CRITICAL)
        elif kind == "people":
            if error:
                self.status.configure(text=f"Could not load people: {error}", text_color=CRITICAL)
                return
            self.people = value
            self._render_people()
            if self.current is not None:
                self._select(next((p for p in self.people if p.email == self.current.email), None))
        elif kind == "audit":
            self.audit_box.configure(state="normal")
            self.audit_box.delete("1.0", "end")
            rows = value or []
            self.audit_box.insert("1.0", "\n".join(
                f"{a.get('at', '')[:16].replace('T', ' ')}  {a.get('actor', {}).get('email', '?')}  {a.get('action', '')}  {a.get('target', '')}  "
                f"{' '.join(a.get('changes') or [])}{'  — ' + a['reason'] if a.get('reason') else ''}" for a in rows) or "No changes recorded yet.")
            self.audit_box.configure(state="disabled")
        elif kind == "save":
            self.save_button.configure(state="normal")
            if error:
                self.status.configure(text=str(error), text_color=CRITICAL)
                return
            self.current, self.creating = value, False
            self.status.configure(text=f"Saved {value.email}.", text_color=GOOD)
            self.reason.delete(0, "end")
            self.reload()

    def reload(self):
        self._run("privileges", self.store.privileges)
        self._run("people", self.store.list_users)
        self._run("audit", lambda: self.store.audit(limit=60, target=self.current.email if self.current else None))

    # ── list and form ──
    def _render_people(self):
        for child in self.people_frame.winfo_children():
            child.destroy()
        query = self.search.get().strip().lower()
        for person in self.people:
            if query and query not in person.email and query not in person.name.lower():
                continue
            text = f"{person.name or person.email}\n{person.email}"
            tags = ([] if person.active else ["inactive"]) + (["admin"] if person.admin else []) + [f"{len(person.modules)} workspace(s)"]
            row = ctk.CTkButton(self.people_frame, text=f"{text}\n{' · '.join(tags)}", anchor="w", height=58, corner_radius=8,
                                fg_color=IDLE_BG if self.current and person.email == self.current.email else "transparent",
                                hover_color=IDLE_BG, text_color=INK if person.active else MUTED, font=_font(11),
                                command=lambda p=person: self._select(p))
            row.pack(fill="x", pady=2)

    def _set_form(self, person: UserAccess | None):
        self.email.configure(state="normal")
        self.email.delete(0, "end")
        self.name.delete(0, "end")
        if person is not None:
            self.email.insert(0, person.email)
            self.email.configure(state="disabled")
            self.name.insert(0, person.name)
        self.active_var.set(person.active if person else True)
        self.admin_var.set(person.admin if person else False)
        for module, var in self.module_vars.items():
            var.set(bool(person) and module in person.modules)
        self.save_button.configure(state="normal" if (person is not None or self.creating) else "disabled")

    def _select(self, person: UserAccess | None):
        self.current, self.creating = person, False
        self.heading.configure(text=f"{person.name or person.email}" if person else "Choose a person, or add one.")
        self.status.configure(text="")
        self._set_form(person)
        self._render_people()
        self._run("audit", lambda: self.store.audit(limit=60, target=person.email if person else None))

    def new_person(self):
        self.current, self.creating = None, True
        self.heading.configure(text="Add a person")
        self.status.configure(text="Enter the exact Microsoft sign-in name (work email).", text_color=MUTED)
        self._set_form(None)
        self.email.focus_set()

    def form_value(self) -> UserAccess:
        email = normalise_email(self.email.get())
        base = self.current if self.current is not None else UserAccess(email=email)
        return replace(base, email=email, name=self.name.get().strip(), active=bool(self.active_var.get()),
                       admin=bool(self.admin_var.get())).with_modules([m for m, v in self.module_vars.items() if v.get()])

    def save(self):
        try:
            person = self.form_value()
        except ValueError as error:
            self.status.configure(text=str(error), text_color=CRITICAL)
            return
        me = self.access.acting_as()
        if self.current is not None and person.email == me["email"] and self.current.admin and not person.admin:
            self.status.configure(text="You cannot remove your own admin right. Ask another admin.", text_color=CRITICAL)
            return
        if not person.modules and person.active and not person.admin:
            if not messagebox.askyesno("No workspaces", f"{person.email} will be able to sign in but open no workspace. Save anyway?", parent=self):
                return
        expected = None if self.current is None else self.current.rev
        reason = self.reason.get().strip()
        self.save_button.configure(state="disabled")
        self.status.configure(text="Saving…", text_color=MUTED)
        self._run("save", lambda: self.store.save_user(me, person, expected, reason))
