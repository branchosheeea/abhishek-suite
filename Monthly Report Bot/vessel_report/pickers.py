"""Native vessel and calendar pickers, using CustomTkinter and the standard library."""
import calendar
import tkinter as tk
from datetime import date, datetime
import customtkinter as ctk

from suite_services.theme import WHITE, INK, MUTED, TEAL, PALE, BORDER


class Picker(ctk.CTkToplevel):
    def __init__(self, owner, title, width, height, anchor=None):
        super().__init__(owner)
        self.owner = owner
        self.title(title)
        self.configure(fg_color=WHITE)
        self.resizable(False, False)
        self.transient(owner)
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.bind("<Escape>", lambda _event: self.close())
        self.update_idletasks()
        scale = self._get_window_scaling()
        pixel_width, pixel_height = int(width * scale), int(height * scale)
        if anchor is not None:
            x = anchor.winfo_rootx()
            y = anchor.winfo_rooty() + anchor.winfo_height() + 4
            if y + pixel_height > self.winfo_screenheight() - 45:
                y = anchor.winfo_rooty() - pixel_height - 32
        else:
            x = owner.winfo_rootx() + (owner.winfo_width() - pixel_width) // 2
            y = owner.winfo_rooty() + (owner.winfo_height() - pixel_height) // 2
        x = max(0, min(x, self.winfo_screenwidth() - pixel_width - 16))
        y = max(32, min(y, self.winfo_screenheight() - pixel_height - 45))
        self.geometry(f"{width}x{height}+{x}+{y}")
        self._activate_id = self.after(60, self.activate)

    def activate(self):
        self._activate_id = None
        self.grab_set()
        self.focus_set()

    def close(self):
        if self._activate_id is not None:
            self.after_cancel(self._activate_id)
        self.grab_release()
        self.destroy()


class VesselPicker(Picker):
    def __init__(self, owner, vessels, selected, on_apply):
        super().__init__(owner, "Choose vessels", 410, 510)
        self.vessels = tuple(sorted(vessels, key=str.casefold))
        self.on_apply = on_apply
        self.variables = {name: tk.BooleanVar(self, value=name in selected) for name in vessels}
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(3, weight=1)
        owner.label(self, "Choose your vessels", 20, INK, True).grid(row=0, column=0, sticky="w", padx=22, pady=(20, 8))
        self._search_var = tk.StringVar(self)
        self.search = ctk.CTkEntry(self, textvariable=self._search_var, placeholder_text="Search vessels...", height=36, border_color=BORDER)
        self.search.grid(row=1, column=0, sticky="ew", padx=22)
        self._search_var.trace_add("write", lambda *_: self.render())
        toolbar = ctk.CTkFrame(self, fg_color="transparent")
        toolbar.grid(row=2, column=0, sticky="ew", padx=22, pady=12)
        owner.button(toolbar, f"Select all {len(vessels)}", lambda: self.set_all(True), secondary=True, width=130).pack(side="left")
        owner.button(toolbar, "Clear all", lambda: self.set_all(False), secondary=True, width=90).pack(side="left", padx=8)
        self.list = ctk.CTkScrollableFrame(self, fg_color="#F6F9FA", corner_radius=10)
        owner.register_scroll_frame(self.list)
        self.list.grid(row=3, column=0, sticky="nsew", padx=22)
        self.list.grid_columnconfigure(0, weight=1)
        self.count = owner.label(self, "", 12, MUTED)
        self.count.grid(row=4, column=0, sticky="w", padx=22, pady=10)
        actions = ctk.CTkFrame(self, fg_color="transparent")
        actions.grid(row=5, column=0, sticky="ew", padx=22, pady=(0, 20))
        owner.button(actions, "Cancel", self.close, secondary=True, width=100).pack(side="left")
        self.apply_button = owner.button(actions, "Apply selection", self.apply, width=170)
        self.apply_button.pack(side="right")
        self.render()

    def render(self):
        for child in self.list.winfo_children():
            child.destroy()
        query = self._search_var.get().strip().casefold()
        visible = [name for name in self.vessels if query in name.casefold()]
        for row, name in enumerate(visible):
            check = ctk.CTkCheckBox(self.list, text=name, variable=self.variables[name], command=self.update_count,
                text_color=INK, fg_color=TEAL, hover_color="#06655F", border_color="#A7B8C0", checkbox_width=20, checkbox_height=20)
            check.grid(row=row, column=0, sticky="w", padx=10, pady=9)
        if not visible:
            self.owner.label(self.list, "No matching vessels", 13, MUTED).grid(row=0, column=0, pady=30)
        self.owner._bind_scroll_tree(self.list)
        self.update_count()

    def update_count(self):
        count = sum(variable.get() for variable in self.variables.values())
        self.count.configure(text=f"{count} of {len(self.vessels)} vessels selected")
        self.apply_button.configure(state="normal" if count else "disabled")

    def set_all(self, selected):
        # All means the entire fleet, including vessels hidden by search.
        for variable in self.variables.values():
            variable.set(selected)
        self.update_count()

    def apply(self):
        selected = tuple(name for name in self.vessels if self.variables[name].get())
        if selected:
            self.on_apply(selected)
            self.close()


class DatePicker(Picker):
    def __init__(self, owner, title, value, on_select, anchor=None):
        super().__init__(owner, title, 330, 370, anchor)
        self.on_select = on_select
        try:
            self.selected = datetime.strptime(value.strip(), "%d-%b-%Y").date()
        except ValueError:
            self.selected = date.today()
        self.year, self.month = self.selected.year, self.selected.month
        self.month_var = tk.StringVar(self, value=calendar.month_name[self.month])
        self.year_var = tk.StringVar(self, value=str(self.year))
        self.grid_columnconfigure(0, weight=1)
        owner.label(self, title, 17, INK, True).grid(row=0, column=0, sticky="w", padx=16, pady=(16, 10))
        navigation = ctk.CTkFrame(self, fg_color="transparent")
        navigation.grid(row=1, column=0, sticky="ew", padx=16)
        self.previous = owner.button(navigation, "<", lambda: self.shift_month(-1), secondary=True, width=30)
        self.previous.pack(side="left")
        ctk.CTkOptionMenu(navigation, values=list(calendar.month_name)[1:], variable=self.month_var, command=self.change_month,
            width=116, height=36, fg_color=PALE, button_color=TEAL, text_color=INK).pack(side="left", padx=5)
        # Year is a dropdown like the month; its range follows the year being viewed.
        self.year_menu = ctk.CTkOptionMenu(navigation, values=self.year_options(), variable=self.year_var,
            command=lambda _value: self.change_year(), width=84, height=36, fg_color=PALE, button_color=TEAL,
            text_color=INK)
        self.year_menu.pack(side="left", padx=(0, 5))
        self.next = owner.button(navigation, ">", lambda: self.shift_month(1), secondary=True, width=30)
        self.next.pack(side="left")
        self.days = ctk.CTkFrame(self, fg_color="transparent")
        self.days.grid(row=2, column=0, sticky="ew", padx=16, pady=10)
        self.days.grid_columnconfigure(tuple(range(7)), weight=1, uniform="day")
        self.day_buttons = {}
        footer = ctk.CTkFrame(self, fg_color="transparent")
        footer.grid(row=3, column=0, sticky="ew", padx=16)
        owner.button(footer, "Today", lambda: self.choose(date.today()), secondary=True, width=90).pack(side="left")
        owner.button(footer, "Cancel", self.close, secondary=True, width=90).pack(side="right")
        self.render()

    YEARS_BEFORE, YEARS_AFTER = 15, 10

    def year_options(self):
        """Years around today, widened to include the year being viewed."""
        today = date.today().year
        first = max(1, min(today - self.YEARS_BEFORE, self.year - 5))
        last = min(9999, max(today + self.YEARS_AFTER, self.year + 5))
        return [str(year) for year in range(first, last + 1)]

    def change_month(self, value):
        self.month = list(calendar.month_name).index(value)
        self.change_year()

    def change_year(self, _event=None):
        try:
            year = int(self.year_var.get())
            if not 1 <= year <= 9999:
                raise ValueError()
            self.year = year
        except ValueError:
            pass
        self.year_var.set(str(self.year))
        self.render()

    def shift_month(self, delta):
        index = (self.year - 1) * 12 + self.month - 1 + delta
        if 0 <= index < 9999 * 12:
            year, month = divmod(index, 12)
            self.year, self.month = year + 1, month + 1
            self.year_var.set(str(self.year))
            self.month_var.set(calendar.month_name[self.month])
            self.render()

    def render(self):
        for child in self.days.winfo_children():
            child.destroy()
        self.day_buttons.clear()
        for col, name in enumerate(("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su")):
            self.owner.label(self.days, name, 11, MUTED).grid(row=0, column=col, pady=(0, 5))
        weeks = calendar.Calendar(firstweekday=0).monthdayscalendar(self.year, self.month)
        for row in range(6):
            for col in range(7):
                day = weeks[row][col] if row < len(weeks) else 0
                if not day:
                    ctk.CTkFrame(self.days, height=30, width=34, fg_color="transparent").grid(row=row + 1, column=col)
                    continue
                value = date(self.year, self.month, day)
                selected = value == self.selected
                button = ctk.CTkButton(self.days, text=str(day), width=34, height=30, corner_radius=6,
                    fg_color=TEAL if selected else PALE if value == date.today() else WHITE,
                    text_color=WHITE if selected else INK, hover_color="#BBDDD7",
                    command=lambda value=value: self.choose(value))
                button.grid(row=row + 1, column=col, padx=1, pady=1)
                self.day_buttons[day] = button
        if str(self.year) not in self.year_menu.cget("values"):
            self.year_menu.configure(values=self.year_options())
        self.previous.configure(state="disabled" if (self.year, self.month) == (1, 1) else "normal")
        self.next.configure(state="disabled" if (self.year, self.month) == (9999, 12) else "normal")

    def choose(self, value):
        self.on_select(value.strftime("%d-%b-%Y"))
        self.close()
