"""Execution evidence from MariApps: Job History, Job Order attachments and Postponed Jobs.

Facts observed live (16-Nov-2026):
- Maintenance > Reports > Job History lists one row per Job Order, with vessel, date range
  (#FromDate/#ToDate), job status and Risk Assessment filters. Rows carry jobplanId, due and
  original due dates, job end date, approval, overdue reason and the attachment count.
- Clicking a Job Order link opens JobOrderDetails in a new tab (sometimes only on a second
  click). The page fetches its own attachment list as JSON; we read that response passively.
  That list also includes Job Plan documents, so it is reconciled against the Job Order count.
- Maintenance > Reports > Postponed Jobs lists every postponement request with its approval
  status, request date, approval date and 'Auto Approved By Vessel'. Completed jobs are
  excluded by default and must be included.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

from playwright.sync_api import Error as PlaywrightError

from vessel_report.downloader import PAGE_TIMEOUT_MS

from .models import Check, parse_record_count
from .portal import JobOverviewSession

JH_PATH, JH_MARK, JH_GRID = ("Maintenance", "Reports", "Job History"), "JobHistoryReport", "#jobHistoryGrid"
PP_PATH, PP_MARK, PP_GRID = ("Maintenance", "Reports", "Postponed Jobs"), "/Maintenance/PostponedJob", "#postponeGrid"
JH_STATUSES = ("COMPLETED", "COMPLETED NOT APPROVED")
POSTPONEMENT_LOOKBACK_DAYS = 730
DETAIL_ATTEMPTS = 3


def _ds(grid):
    return f"jQuery('{grid}').data('kendoGrid').dataSource"


def _vm(grid):
    return f"ko.contextFor(document.querySelector('{grid}')).$root"


@dataclass
class GridEvidence:
    """What a report returned, for reconciliation."""
    name: str
    count_label: str | None
    total: int | None
    rows: list[dict]
    dom_rows: int
    payloads: list[dict]
    vessel_box: str
    vessel: str
    expected: dict = field(default_factory=dict)
    key: str = "jobOrderNo"

    def checks(self) -> list[Check]:
        shown = parse_record_count(self.count_label)
        checks = [Check(f"{self.name}: vessel selected", self.vessel_box.strip() == self.vessel,
                        f"Vessel box shows '{self.vessel_box.strip()}'."),
                  Check(f"{self.name}: record count displayed", shown is not None, f"Label: '{self.count_label}'."),
                  Check(f"{self.name}: rows match displayed count",
                        shown is not None and self.total == shown == len(self.rows) == self.dom_rows,
                        f"Displayed {shown}, grid total {self.total}, extracted {len(self.rows)}, rendered {self.dom_rows}.")]
        final = (self.payloads[-1].get("gridServerOperations") or {}) if self.payloads else {}
        checks.append(Check(f"{self.name}: read without page boundaries",
                            shown is not None and final.get("page") == 1 and (final.get("pageSize") or 0) >= shown,
                            f"Final read page {final.get('page')}, size {final.get('pageSize')}."))
        wrong = {k: (p.get(k), v) for p in self.payloads for k, v in self.expected.items() if p.get(k) != v}
        checks.append(Check(f"{self.name}: portal received the filters", bool(self.payloads) and not wrong,
                            "All requests carried the expected filters." if self.payloads and not wrong
                            else f"Unexpected: {wrong}" if wrong else "No request observed."))
        keys = [r.get(self.key) for r in self.rows]
        if self.key == "jobOrderNo":
            dupes = len(keys) - len(set(keys))
            checks.append(Check(f"{self.name}: Job Orders unique", dupes == 0 and all(keys), f"{dupes} duplicate(s)."))
        return checks


class ComplianceSession(JobOverviewSession):
    """Adds the execution review to the proven Job Overview session."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.history_page = None

    # ── Shared grid mechanics ──────────────────────────────────────────────────

    def _capture_reads(self, page, must_contain):
        reads = []

        def on_request(request):
            if request.method == "POST" and "ServiceRouter/POST" in request.url:
                try:
                    payload = json.loads(request.post_data or "{}")
                except ValueError:
                    return
                if isinstance(payload, dict) and must_contain in payload:
                    reads.append(payload)
        page.on("request", on_request)
        return reads

    def _grid_ready(self, page, grid):
        page.locator(grid).wait_for(state="attached")
        self._wait(lambda: page.evaluate(f"() => !!(window.jQuery && window.ko && {_ds(grid)})"), page, f"{grid} grid")
        self._idle(page)

    def _settle(self, page, grid, description):
        self._idle(page)
        self._wait(lambda: parse_record_count(self._count_label(page)) == page.evaluate(f"() => {_ds(grid)}.total()"),
                   page, description)
        self._idle(page)

    def _show_all(self, page, grid, reads, description):
        """Click Show, then read the whole result in one request (portal paging is unstable)."""
        reads.clear()
        page.locator(".btn-icon-apply-search-result:visible").first.click()
        self._wait(lambda: reads, page, f"{description} request", timeout=60)
        self._settle(page, grid, description)
        total = page.evaluate(f"() => {_ds(grid)}.total()")
        if total > page.evaluate(f"() => {_ds(grid)}.pageSize()"):
            self.log(f"{total} {description} rows; reading them in one request.")
            reads.clear()
            page.evaluate(f"n => {_ds(grid)}.pageSize(n)", total)
            self._wait(lambda: any((r.get("gridServerOperations") or {}).get("pageSize") == total for r in reads),
                       page, f"{description} single read", timeout=60)
            self._settle(page, grid, description)
        rows = page.evaluate(f"() => {_ds(grid)}.data().map(r => r.toJSON())")
        dom = page.locator(f"{grid} .k-grid-content tbody tr[data-uid]").count()
        return rows, dom

    @staticmethod
    def _fill_date(page, locator, value):
        box = locator.first
        box.click()
        box.fill(value)
        box.press("Tab")

    # ── Job History ────────────────────────────────────────────────────────────

    def extract_history(self, vessel, start: date, end: date):
        page = self._open_report(JH_PATH, JH_MARK)
        self.history_page = page
        self._grid_ready(page, JH_GRID)
        reads = self._capture_reads(page, "selectedJobStatusOptions")
        self._select_report_vessel(page, vessel, tree=False)
        self._fill_date(page, page.locator("#FromDate"), f"{start:%d-%b-%Y}")
        self._fill_date(page, page.locator("#ToDate"), f"{end:%d-%b-%Y}")
        self._idle(page)
        # Job status: completed jobs, approved or not (the second is itself a finding).
        statuses = page.evaluate("""wanted => {
            const sel = [...document.querySelectorAll('select')].find(s => /selectedJobStatusOptions/.test(s.getAttribute('data-bind') || ''));
            const ids = [...sel.options].filter(o => wanted.includes(o.text.trim().toUpperCase())).map(o => o.value);
            return ids; }""", list(JH_STATUSES))
        if len(statuses) != len(JH_STATUSES):
            raise RuntimeError(f"Job History status options changed: found ids {statuses} for {JH_STATUSES}.")
        page.evaluate(f"""ids => {{ const vm = {_vm(JH_GRID)}; vm.selectedJobStatusOptions(ids);
            const sel = [...document.querySelectorAll('select')].find(s => /selectedJobStatusOptions/.test(s.getAttribute('data-bind') || ''));
            if (window.jQuery && jQuery(sel).selectpicker) jQuery(sel).selectpicker('refresh'); }}""", statuses)
        page.evaluate(f"() => {{ {_vm(JH_GRID)}.jobHistory.riskAssessementId('Y'); }}")
        self.log(f"Job History: {vessel}, {start:%d-%b-%Y} to {end:%d-%b-%Y}, completed jobs, Risk Assessment = YES.")
        rows, dom = self._show_all(page, JH_GRID, reads, "Job History")
        status_value = ",".join(statuses)
        return GridEvidence("Job History", self._count_label(page), page.evaluate(f"() => {_ds(JH_GRID)}.total()"),
                            rows, dom, list(reads), self._vessel_box(page).input_value(), vessel,
                            expected={"riskAssessementId": "Y", "selectedJobStatusOptions": status_value})

    def list_attachments(self, job_order_no, job_order_id):
        """Open the Job Order and read the attachment list the page itself requests."""
        page = self.history_page
        uid = page.evaluate(f"no => ({_ds(JH_GRID)}.data().find(r => r.jobOrderNo === no) || {{}}).uid", job_order_no)
        if not uid:
            raise RuntimeError(f"Job Order {job_order_no} is not in the Job History grid.")
        link = page.locator(f'{JH_GRID} tr[data-uid="{uid}"] a.celljoborder').first
        captured = []

        def on_response(response):
            url = response.url
            if ("coTableName%3DPM_JOB_ORDER" in url and "attachmentType%3DJOB" in url
                    and f"headerId%3D{job_order_id}" in url):
                try:
                    captured.append(response.json())
                except Exception:
                    captured.append(None)
        self.context.on("response", on_response)
        detail = None
        try:
            for attempt in range(DETAIL_ATTEMPTS):
                before = set(self.context.pages)
                page.bring_to_front()
                link.scroll_into_view_if_needed()
                link.click()
                try:
                    detail = self._wait(lambda: next((p for p in self.context.pages
                                                      if p not in before and "JobOrderDetails" in p.url), None),
                                        page, f"Job Order {job_order_no}", timeout=12)
                    break
                except TimeoutError:
                    self.log(f"Job Order {job_order_no} did not open; retrying ({attempt + 1}).")
            if detail is None:
                raise RuntimeError(f"Job Order {job_order_no} did not open.")
            self._job_pages.add(detail)
            self._wait(lambda: captured, detail, f"attachments of {job_order_no}", timeout=45)
            if captured[-1] is None or not isinstance(captured[-1], list):
                raise RuntimeError(f"Attachment list for {job_order_no} was not readable.")
            return [dict(file_name=str(f.get("fileName") or ""), mime=str(f.get("mimeType") or ""),
                         size=str(f.get("fileSize") or "")) for f in captured[-1]]
        finally:
            self.context.remove_listener("response", on_response)
            if detail is not None and not detail.is_closed():
                detail.close()
            self._job_pages.discard(detail)
            self.active = page

    # ── Postponed Jobs ─────────────────────────────────────────────────────────

    def extract_postponements(self, vessel, start: date, end: date):
        page = self._open_report(PP_PATH, PP_MARK)
        self._grid_ready(page, PP_GRID)
        reads = self._capture_reads(page, "excludeCompletedJobs")
        self._select_report_vessel(page, vessel, tree=False)
        since = start - timedelta(days=POSTPONEMENT_LOOKBACK_DAYS)
        # The first visible pair is 'Postponed Date Between' (the page reuses ids for the next pair).
        self._fill_date(page, page.locator("#newFromDate:visible"), f"{since:%d-%b-%Y}")
        self._fill_date(page, page.locator("#newToDate:visible"), f"{end:%d-%b-%Y}")
        page.evaluate(f"""() => {{ const p = {_vm(PP_GRID)}.postponedJobs;
            for (const k of Object.keys(p)) if (/exclude/i.test(k) && ko.isObservable(p[k])) {{
                const v = ko.unwrap(p[k]); p[k](typeof v === 'boolean' ? false : 'N'); }} }}""")
        self.log(f"Postponed Jobs: {vessel}, requested {since:%d-%b-%Y} to {end:%d-%b-%Y}, including completed jobs.")
        rows, dom = self._show_all(page, PP_GRID, reads, "Postponed Jobs")
        evidence = GridEvidence("Postponed Jobs", self._count_label(page), page.evaluate(f"() => {_ds(PP_GRID)}.total()"),
                                rows, dom, list(reads), self._vessel_box(page).input_value(), vessel,
                                expected={"excludeCompletedJobs": "N", "approvalFlag": "ALL"}, key="postPoneId")
        page.close()
        self.active = self.history_page
        return evidence
