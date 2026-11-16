"""Manual desktop smoke check: python tests/ui_smoke.py [--capture]. No portal access."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import subprocess
import time
from datetime import datetime
import customtkinter as ctk
from vessel_report import ui as bot_ui
from vessel_report.core import BatchRequest, ReportJob, DownloadError


class FakeSession:
    launches = 0

    def __init__(self, on_state=None):
        FakeSession.launches += 1
        self.on_state = on_state
        self.closed = False

    def download_report(self, *args, **kwargs):
        calls.append(args)
        kwargs["on_progress"]("Simulated download for UI verification")
        if mode == "partial" and len(calls) == 1:
            raise DownloadError("Simulated attachment failure", ["partial.xlsx"])
        if mode == "stop":
            app.stop_event.set()
        return {"downloaded_files": ["example.xlsx"]}

    def pump(self):
        return None

    def close(self):
        self.closed = True

ctk.set_appearance_mode("light")
app = bot_ui.ReportApp()
errors = []
app.report_callback_exception = lambda *args: errors.append(args)
app.update()
assert app.download_button.cget("state") == "disabled"
app.search.set("KPI")
assert len(app.visible_reports()) == 1
app.select_visible(True)
monthly_report = "05.05.00.001- KPI - Ship Report"
monthly_row = app.report_rows[monthly_report][0]
assert app.vessels == ()
assert app.download_button.cget("state") == "disabled"
app.set_vessels(("DHT LEOPARD",))
assert app.download_button.cget("state") == "normal"
app.frequency.set("Quarterly")
app.change_frequency()
assert monthly_row.winfo_manager() == ""
assert not app.selected_reports()
app.frequency.set("Monthly")
app.change_frequency()
assert app.report_rows[monthly_report][0] is monthly_row
assert monthly_row.winfo_manager() == "grid"
assert len(app.selected_reports()) == 1
app.preset.set("Custom Range")
app.apply_preset()
app.start_date.set("31-Feb-2026")
assert app.download_button.cget("state") == "disabled"
app.preset.set("Previous Month")
app.apply_preset()

# Vessel chooser uses draft selection until Apply; search never changes Select all scope.
from report_catalog import VESSELS
picker = app.open_vessels()
app.update()
picker.search.insert(0, "LEOPARD")
picker.render()
picker.set_all(True)
assert sum(v.get() for v in picker.variables.values()) == len(VESSELS)
picker.apply()
assert app.vessels == tuple(sorted(VESSELS, key=str.casefold))
assert f"{len(VESSELS)} jobs" in app.download_button.cget("text")
picker = app.open_vessels()
picker.set_all(False)
assert picker.apply_button.cget("state") == "disabled"
picker.close()
assert len(app.vessels) == len(VESSELS)
app.set_vessels(("DHT LEOPARD", "DHT IMPALA"))
assert "2 jobs" in app.download_button.cget("text")
app.set_vessels(())
assert app.download_button.cget("state") == "disabled"
app.set_vessels(("DHT LEOPARD",))
# Both calendars support leap days, month boundaries and manual year changes.
app.preset.set("Custom Range")
app.apply_preset()
app.start_date.set("01-Feb-2024")
app.end_date.set("31-Mar-2024")
assert all(b.cget("state") == "normal" for b in app.calendar_buttons)
picker = app.open_calendar(app.start_date, "From")
app.update()
assert 29 in picker.day_buttons
picker.day_buttons[29].invoke()
assert app.start_date.get() == "29-Feb-2024"
picker = app.open_calendar(app.end_date, "To")
picker.year_var.set("2025")
picker.change_year()
picker.month_var.set("January")
picker.change_month("January")
picker.shift_month(-1)
assert (picker.year, picker.month) == (2024, 12)
picker.day_buttons[31].invoke()
assert app.end_date.get() == "31-Dec-2024"
picker = app.open_calendar(app.start_date, "From")
picker.year_var.set("not a year")
picker.change_year()
assert picker.year_var.get() == "2024"
picker.close()
app.start_date.set("01-Jan-2025")
assert app.download_button.cget("state") == "disabled"
app.preset.set("Previous Month")
app.apply_preset()
assert all(b.cget("state") == "normal" for b in app.calendar_buttons)
picker = app.open_calendar(app.start_date, "From")
assert picker is not None
picker.close()
assert app.preset.get() == "Previous Month"
picker = app.open_calendar(app.start_date, "From")
picker.day_buttons[1].invoke()
assert app.preset.get() == "Custom Range"

calls = []
mode = "partial"
app.worker.session_factory = FakeSession
request = BatchRequest(("DHT LEOPARD", "DHT IMPALA"), "Monthly", ("First test report", "Second test report"), datetime(2026, 10, 1), datetime(2026, 10, 31), Path("test-output-not-created"))

def drain():
    deadline = time.monotonic() + 10
    while app.running and time.monotonic() < deadline:
        app.update()
        time.sleep(0.01)
    assert not app.running, "Batch did not settle"
    app.update()

app.start_batch(request)
assert app.open_vessels() is None
assert all(button.cget("state") == "disabled" for button in app.calendar_buttons)
drain()
assert len(app.results) == 4
assert {item["vessel"] for item in app.results} == {"DHT LEOPARD", "DHT IMPALA"}
assert app.metrics["files"].cget("text") == "04"
assert app.failed_jobs == [ReportJob("DHT LEOPARD", "First test report")]
assert app.retry_button.cget("state") == "normal"
app.set_vessels(("DHT IMPALA",))
app.retry_failed()
drain()
assert app.last_request.vessels == ("DHT LEOPARD", "DHT IMPALA")
assert app.last_request.jobs == (ReportJob("DHT LEOPARD", "First test report"),)
assert app.last_request.output == request.output
assert not app.failed_jobs
assert app.retry_button.cget("state") == "disabled"
assert FakeSession.launches == 1
mode = "stop"
app.start_batch(request)
assert app.open_vessels() is None
assert all(button.cget("state") == "disabled" for button in app.calendar_buttons)
drain()
assert len(app.results) == 1
assert app.status.cget("text") == "Run stopped"
assert app.download_button.cget("state") == "normal"
assert not errors, errors
# Verify the primary action and footer remain inside the window at minimum size.
app.geometry("980x660")
app.show_page("reports")
app.update()
for widget in (app.download_button, app.progress_bar):
    assert widget.winfo_rooty() + widget.winfo_height() <= app.winfo_rooty() + app.winfo_height()
print("GUI smoke passed: vessel selection/all/cancel, calendar leap days/navigation, validation, downloads, retry, stop and layout.", flush=True)
for timer in app.tk.call("after", "info"):
    app.tk.call("after", "cancel", timer)
app.destroy()

if "--capture" in sys.argv:
    # A clean startup preview, without simulated results.
    app = bot_ui.ReportApp()
    app.attributes("-topmost", True)
    Path("docs").mkdir(exist_ok=True)
    def capture():
        script = """Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(WIDTH, HEIGHT)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen(XPOS, YPOS, 0, 0, $bitmap.Size)
$bitmap.Save('docs/workspace.png', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
""".replace("WIDTH", str(app.winfo_width())).replace("HEIGHT", str(app.winfo_height())).replace("XPOS", str(app.winfo_rootx())).replace("YPOS", str(app.winfo_rooty()))
        process = subprocess.Popen(["powershell", "-NoProfile", "-Command", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        def check():
            if process.poll() is None:
                app.after(100, check)
            else:
                output, error = process.communicate()
                print(output, error, flush=True)
                app.destroy()
        app.after(100, check)
    app.after(1200, capture)
    app.mainloop()
