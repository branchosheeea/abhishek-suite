"""Explicit live verification: catalog audit plus isolated test downloads."""
import json
import re
import argparse
from datetime import datetime
from pathlib import Path
from report_catalog import REPORTS_BY_FREQUENCY
from Ver2_download import ReportSession


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--extended", action="store_true")
    parser.add_argument("--puma-only", action="store_true")
    args = parser.parse_args()
    output = Path("diagnostics") / f"backend-verification-{datetime.now():%Y%m%d-%H%M%S}"
    output.mkdir(parents=True)
    session = ReportSession()
    log = (output / "run.log").open("w", encoding="utf-8")
    def progress(message):
        print(message, flush=True)
        log.write(message + "\n")
        log.flush()
    session.log = progress
    audit, runs = [], []
    try:
        for frequency, reports in ({} if args.extended or args.puma_only else REPORTS_BY_FREQUENCY).items():
            page = session.prepare("DHT SUNDARBANS", frequency)
            search = page.locator('input[placeholder="Search"]:visible').first
            search.fill("")
            search.press("Enter")
            session._idle(page)
            visible = page.locator("tbody:visible tr:visible").all_inner_texts()
            for report in reports:
                rows = page.locator("tbody:visible").get_by_text(session._report_pattern(report)).locator(
                    "visible=true").locator("xpath=ancestor::tr[1]")
                item = dict(frequency=frequency, report=report, matches=rows.count())
                audit.append(item)
                progress("AUDIT " + json.dumps(item))
            (output / f"{frequency}-rows.json").write_text(json.dumps(visible, indent=2), encoding="utf-8")
        (output / "audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
        cases = [(v, r, "Six Monthly", "01-Jan-2026", "31-Oct-2026")
                 for v in ("DHT SUNDARBANS", "DHT TAIGA", "DHT TIGER")
                 for r in REPORTS_BY_FREQUENCY["Six Monthly"]]
        if args.extended:
            cases = [(v, r, "Quarterly", "01-May-2026", "31-Oct-2026")
                     for v in ("DHT PANTHER", "DHT PUMA")
                     for r in ("12.04.07.023 - Inventory of Lubricants", "12.07.03.001 - Mooring Matrix")]
            cases += [("DHT SUNDARBANS", r, "Monthly", "01-Oct-2026", "31-Oct-2026")
                      for r in ("M/E & A/E Cooling Water Test Log",
                                "Monthly Oil Record Book Report", "1M BWTS Operation Log Report")]
            cases += [("DHT SUNDARBANS", "Record Of Lifting Gear", "Yearly",
                       "01-Jan-2025", "31-Oct-2026")]
        if args.puma_only:
            cases = [("DHT PUMA", "12.07.03.001 - Mooring Matrix", "Quarterly",
                      "01-May-2026", "31-Oct-2026")]
        for vessel, report, frequency, start, end in cases:
                progress(f"LIVE {vessel} / {report}")
                try:
                    result = session.download_report(vessel, report, frequency,
                        start, end, output_dir=output / "downloads",
                        on_progress=progress)
                    runs.append(dict(vessel=vessel, report=report, success=True,
                                     files=result["downloaded_files"]))
                except Exception as error:
                    runs.append(dict(vessel=vessel, report=report, success=False, error=str(error)))
                progress("RESULT " + json.dumps(runs[-1]))
                (output / "results.json").write_text(json.dumps(runs, indent=2), encoding="utf-8")
    finally:
        session.close()
        log.close()
        print(f"Verification artifacts: {output}", flush=True)


if __name__ == "__main__":
    main()
