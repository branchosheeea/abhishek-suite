"""Manual desktop smoke check using a read-only snapshot of local reports.

python tests/ui_daily_trend_smoke.py [--capture]
No Outlook access, imports, confirmations or database writes.
"""
import json
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import customtkinter as ctk
from suite_services.storage import runtime_root
from lube_oil.ui import ReviewApp


def descendants(widget):
    for child in widget.winfo_children():
        yield child
        yield from descendants(child)


def main():
    root = runtime_root()
    db = sqlite3.connect((root / "suite.sqlite3").as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute("""SELECT r.*, f.filename, f.sha256, f.archive_path,
            f.imported_at, v.name AS vessel FROM monthly_reports r
            JOIN report_files f ON f.id=r.file_id LEFT JOIN vessels v ON v.id=r.vessel_id
            ORDER BY r.month DESC,r.report_version DESC,r.id DESC""").fetchall()
    finally:
        db.close()
    reports = [dict(r) | {"data": json.loads(r["payload"])} for r in rows]
    assert reports, "Import pilot reports before running this local smoke check."

    class Snapshot:
        def reports(self):
            return reports

    with patch("lube_oil.ui.Repository", return_value=Snapshot()):
        app = ReviewApp()
    errors = []
    app.report_callback_exception = lambda *error: errors.append(error)
    try:
        if any(r.get("vessel") == "DHT IMPALA" for r in reports):
            app.vessel.set("DHT IMPALA")
            app.change_vessel("DHT IMPALA")
        app.show("Consumption")
        app.update()
        selector = next(w for w in descendants(app.body) if isinstance(w, ctk.CTkOptionMenu) and w.cget("values") == ["1M", "3M", "6M", "12M", "Custom"])
        for value in ("1M", "3M", "6M", "12M", "Custom"):
            selector.set(value)
            selector.cget("command")(value)
            app.update()
            assert not errors, errors
        calendars = [w for w in descendants(app.body) if isinstance(w, ctk.CTkButton) and w.cget("text") == "Calendar"]
        calendars[0].invoke()
        app.update()
        for child in app.winfo_children():
            if isinstance(child, ctk.CTkToplevel):
                child.destroy()
        selector.set("12M")
        selector.cget("command")("12M")
        app.update()
        assert not errors, errors
        labels = [w.cget("text") for w in descendants(app.body) if isinstance(w, ctk.CTkLabel)]
        assert any("L/day" in label for label in labels)
        if "--capture" in sys.argv:
            from PIL import ImageGrab
            path = Path("diagnostics/lub_oil_daily_trend.png")
            path.parent.mkdir(exist_ok=True)
            app.lift()
            app.update()
            ImageGrab.grab(bbox=(app.winfo_rootx(), app.winfo_rooty(), app.winfo_rootx() + app.winfo_width(), app.winfo_rooty() + app.winfo_height())).save(path)
            print(path.resolve())
        print("PASS: 1M/3M/6M/12M/custom, calendar popup and daily-rate rendering; source database read-only.")
    finally:
        app.close_app()


if __name__ == "__main__":
    main()
