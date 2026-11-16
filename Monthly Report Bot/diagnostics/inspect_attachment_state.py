"""Read-only inspection of one MariApps job order attachment state."""
import json
from datetime import datetime
from pathlib import Path

from Ver2_download import ReportSession


def main():
    vessel = "DHT PUMA"
    report = "12.07.03.001 - Mooring Matrix"
    session = ReportSession()
    session.log = lambda message: print(message, flush=True)
    output = Path("diagnostics") / "puma-mooring-attachment-state.json"
    try:
        page = session.prepare(vessel, "Quarterly")
        search = page.locator('input[placeholder="Search"]:visible').first
        search.fill(session._report_query(report))
        search.press("Enter")
        session._idle(page)
        selected = session._find_report(page, report)
        history = session._target_page(page, selected.click, "Job History")
        matches = session._history(history, datetime(2026, 5, 1), datetime(2026, 10, 31), report)
        ended, number = matches[0]
        cell = history.locator('td[data-field="jobOrderNo"]:visible').filter(has_text=number).first
        link = cell.locator("a").first
        detail = session._target_page(history, link.click if link.count() else cell.click, "Attachments")
        detail.get_by_text("Attachments", exact=True).first.click()
        detail.wait_for_timeout(5000)
        data = {
            "vessel": vessel, "report": report, "job_order": number,
            "url": detail.url,
            "download_icons": detail.locator("a.download-icon:visible").count(),
            "no_record_classes": detail.locator(".k-grid-norecords:visible").count(),
            "no_record_texts": detail.get_by_text(
                __import__("re").compile(r"no\s+records?|no\s+data", __import__("re").I)
            ).locator("visible=true").all_inner_texts(),
            "visible_tables": detail.locator("table:visible").all_inner_texts(),
            "visible_buttons": detail.locator("button:visible,a:visible").all_inner_texts(),
            "body": detail.locator("body").inner_text(),
        }
        output.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(json.dumps({k: v for k, v in data.items() if k != "body"}, indent=2), flush=True)
    finally:
        session.close()
        print(f"Saved: {output}", flush=True)


if __name__ == "__main__":
    main()
