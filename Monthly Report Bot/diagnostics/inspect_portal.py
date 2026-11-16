"""Read-only live Job Plan inspection. Close the desktop bot before running."""
import argparse
import json
from pathlib import Path
from Ver2_download import ReportSession
from report_catalog import REPORTS_BY_FREQUENCY


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vessel", default="DHT SUNDARBANS")
    parser.add_argument("--frequency", default="Six Monthly")
    args = parser.parse_args()
    session = ReportSession()
    session.log = lambda message: print(message, flush=True)
    results = []
    try:
        page = session.prepare(args.vessel, args.frequency)
        search = page.locator('input[placeholder="Search"]:visible').first
        queries = ["", *REPORTS_BY_FREQUENCY[args.frequency]]
        for query in queries:
            search.fill(query)
            search.press("Enter")
            session._idle(page)
            # Read-only capture; also record immediately visible non-table titles.
            item = {"query": query,
                    "tables": page.locator("tbody:visible tr:visible").all_inner_texts(),
                    "body": page.locator("body").inner_text()}
            results.append(item)
            print(json.dumps(item), flush=True)
    finally:
        folder = Path("diagnostics")
        folder.mkdir(exist_ok=True)
        (folder / "live-job-plan.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        session.close()


if __name__ == "__main__":
    main()
