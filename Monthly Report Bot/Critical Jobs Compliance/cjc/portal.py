"""Job Overview Report automation, built on the proven Vessel Report Centre session.

Reused unchanged from vessel_report.downloader.ReportSession: Microsoft SSO
sign-in, 401/sign-in detection, Edge loss detection, condition polling (_wait),
AJAX/loader idle detection (_idle), the header vessel box and the main-menu
retry. Only the Job Overview specifics live here.
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from playwright.sync_api import Error as PlaywrightError, sync_playwright

from vessel_report.core import NoDataError, SessionInterrupted
from vessel_report.downloader import MARIAPPS_URL, PAGE_TIMEOUT_MS, ReportSession

from . import config
from .config import FilterProfile
from .models import Extraction, PortalError, parse_record_count

DS = f"jQuery('{config.GRID}').data('kendoGrid').dataSource"


class JobOverviewSession(ReportSession):
    """All methods must run on the worker thread that creates this object."""

    def __init__(self, on_state=None, playwright_factory=sync_playwright, profile=None):
        super().__init__(on_state=on_state, playwright_factory=playwright_factory)
        self.profile_dir = profile or config.PROFILE
        self.job_overview = None
        self._grid_reads: list[dict] = []
        self._listening = []  # pages that already report grid reads (never register twice)

    # ── Browser session (same flow as ReportSession.open, own profile) ────────

    def open(self, *, reopen=False):
        self._assert_thread()
        if self._browser_ok():
            return
        if self._launched and not reopen:
            raise SessionInterrupted("browser", "Edge is no longer available. Reopen it to resume.")
        self.close()
        self._launched = True
        self._lost = False
        try:
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self._playwright = self._factory().start()
            self.context = self._playwright.chromium.launch_persistent_context(
                user_data_dir=str(self.profile_dir), channel="msedge", headless=False, accept_downloads=False)
            self.context.set_default_timeout(PAGE_TIMEOUT_MS)
            self.context.on("close", self._closed)
            self.context.on("response", self._response)
            self.landing = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.active = self.landing
            self.on_state(state="opened", message="Edge session opened. It is reused until the window closes.")
            for attempt in range(3):
                try:
                    self.landing.goto(MARIAPPS_URL, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                    break
                except PlaywrightError as error:
                    # A freshly started profile can abort its first navigation while it restores.
                    if "ERR_ABORTED" not in str(error) or attempt == 2:
                        raise
                    self.landing.wait_for_timeout(1000)
        except PlaywrightError as error:
            self._lost = True
            raise SessionInterrupted("browser", f"Could not open Edge: {error}") from error
        self._initial_sign_in()

    def resume(self, *, reopen=False):
        super().resume(reopen=reopen)
        self.job_overview = None  # re-open the report from a verified dashboard

    def close(self):
        super().close()
        self.job_overview = None
        self._grid_reads = []
        self._listening = []

    # ── Navigation ─────────────────────────────────────────────────────────────

    def _listen(self, page):
        if not any(page is seen for seen in self._listening):
            page.on("request", self._record_grid_read)
            self._listening.append(page)

    def _ready(self, page):
        self._idle(page)
        page.locator(config.GRID).wait_for(state="attached")
        self._wait(lambda: page.evaluate(f"() => !!(window.jQuery && window.ko && {DS})"), page, "Job Overview grid")
        self._idle(page)

    def _job_overview_page(self):
        """A freshly loaded Job Overview tab. Reusing a used grid gave stale rows after a
        vessel change (live, 15-Nov-2026), so every extraction starts from a reload."""
        self._check(self.active)
        if self._live(self.job_overview) and config.JOB_OVERVIEW_URL_MARKER in self.job_overview.url:
            page = self.job_overview
            self.log("Reloading Job Overview for a clean grid.")
            page.reload(wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
            self._check(page)
            self.active = page
            self._ready(page)
            return page
        report = self._open_report(config.MENU_PATH, config.JOB_OVERVIEW_URL_MARKER)
        self._listen(report)
        self.job_overview = report
        self._ready(report)
        return report

    def _open_report(self, menu_path, url_marker):
        """Open a report from the main menu (proven retry) and return its new tab.
        Any earlier tab of the same report is closed first, so the result is always fresh."""
        for stale in [p for p in self.context.pages if url_marker in p.url and not p.is_closed()]:
            stale.close()
        if not self._live(self.landing):
            raise SessionInterrupted("browser", "The navigation tab was closed. Reopen Edge to resume.")
        page = self.landing
        self.log("Opening " + " > ".join(menu_path) + ".")
        menu = page.locator("#main-menu-wrappper")
        first, *rest = menu_path
        top = menu.get_by_text(first, exact=True).locator("visible=true").first
        for attempt in range(3):
            if not top.is_visible():
                page.locator("#mainmenu-btn").click()
            try:
                top.wait_for(state="visible", timeout=10_000)
                break
            except PlaywrightError:
                if attempt == 2:
                    raise
                self.log("Main menu did not open; retrying.")
        top.click()
        for item in rest:
            menu.get_by_text(item, exact=True).locator("visible=true").first.click()

        def find():
            for candidate in self.context.pages:
                if url_marker in candidate.url and not candidate.is_closed():
                    return candidate
            return None
        report = self._wait(find, page, f"{menu_path[-1]} tab")
        self.active = report
        report.bring_to_front()
        self._idle(report)
        return report

    def _record_grid_read(self, request):
        if request.method != "POST" or config.GRID_READ_URL not in request.url:
            return
        try:
            payload = json.loads(request.post_data or "{}")
        except ValueError:
            return
        if isinstance(payload, dict) and "gridServerOperations" in payload and "chkSubEquips" in payload:
            self._grid_reads.append(payload)

    # ── Vessel, tree and filters ───────────────────────────────────────────────

    @staticmethod
    def _tree_root(page):
        # The first visible tree label is the root: 'All Vessels' before selection, then the vessel.
        texts = [t.strip() for t in page.locator(".k-treeview .k-in").locator("visible=true").all_inner_texts()
                 if t.strip()]
        return texts[0] if texts else ""

    def _select_report_vessel(self, page, vessel, tree=True):
        self._idle(page)
        if self._vessel_box(page).input_value().strip() == vessel and (not tree or self._tree_root(page) == vessel):
            self.log(f"Keeping active vessel {vessel}.")
            return
        self.log(f"Selecting {vessel}.")
        self._vessel_box(page).click()
        box = self._vessel_box(page)
        box.fill("")
        box.press_sequentially(vessel, delay=20)
        listbox = page.locator("#vesselSearchBox_listbox")
        try:
            listbox.wait_for(state="visible", timeout=10_000)
        except PlaywrightError:
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.") from None
        if listbox.get_by_text("No data found", exact=False).is_visible():
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.")
        option = listbox.get_by_text(vessel, exact=True)
        try:
            option.first.wait_for(state="attached", timeout=10_000)
        except PlaywrightError:
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.") from None
        option.first.scroll_into_view_if_needed()
        option.first.click()
        self._wait(lambda: self._vessel_box(page).input_value().strip() == vessel, page, f"selected vessel {vessel}")
        # The equipment tree reloads asynchronously; wait until it belongs to this vessel.
        if tree:
            self._wait(lambda: self._tree_root(page) == vessel, page, f"equipment tree for {vessel}")
        self._idle(page)

    def _select_equipment_node(self, page, node):
        self.log(f"Selecting equipment node {node}.")
        tree = page.locator(".k-treeview")
        target = tree.get_by_text(node, exact=True).locator("visible=true").first
        target.wait_for(state="visible")
        target.click()
        self._idle(page)
        self._wait(lambda: node in [t.strip() for t in tree.locator(".k-state-selected").all_inner_texts()],
                   page, f"{node} selected")
        # A real node id is required; the vessel root sends -1 and returns nothing.
        self._wait(lambda: (page.evaluate(
            "() => { const c = ko.contextFor(document.querySelector('%s')); "
            "const v = c && c.$root.jobOverview && ko.unwrap(c.$root.jobOverview.equipmentId); "
            "return typeof v === 'number' && v > 0; }" % config.GRID)), page, f"{node} equipment id")
        self._idle(page)

    @staticmethod
    def _select(page, label):
        group = page.locator("div.form-group").filter(
            has=page.locator("label", has_text=re.compile(rf"^\s*{re.escape(label)}\s*$")))
        select = group.locator("select")
        if select.count() != 1:
            raise PortalError(f"Expected one '{label}' filter on Job Overview, found {select.count()}.")
        return select

    def _selected_text(self, page, label):
        return self._select(page, label).evaluate("s => s.selectedIndex >= 0 ? s.options[s.selectedIndex].text.trim() : ''")

    def _apply_profile(self, page, profile: FilterProfile):
        self.log("Applying filters: " + "; ".join(profile.summary()) + ".")
        for label in config.ALL_SELECTS:
            wanted = profile.option_for(label)
            if self._selected_text(page, label) != wanted:
                self._select(page, label).select_option(label=wanted)
        for selector, wanted in ((config.SUBLEVEL_CHECKBOX, profile.show_sublevel),
                                 (config.OVERDUE_CHECKBOX, profile.show_overdue)):
            box = page.locator(selector)
            if box.is_checked() != wanted:
                box.set_checked(wanted)
        self._idle(page)

    def _readback(self, page):
        return {label: self._selected_text(page, label) for label in config.ALL_SELECTS}

    # ── Load the complete population ──────────────────────────────────────────

    @staticmethod
    def _count_label(page):
        texts = [t.strip() for t in page.locator("text=/\\d[\\d,]*\\s+records?\\s+found/i")
                 .locator("visible=true").all_inner_texts() if t.strip()]
        if len(set(texts)) > 1:
            raise PortalError(f"Job Overview shows conflicting record counts: {texts}.")
        return texts[0] if texts else None

    def _settled(self, page, description):
        # The label and the grid update separately; wait until they agree.
        self._idle(page)
        self._wait(lambda: parse_record_count(self._count_label(page)) == page.evaluate(f"() => {DS}.total()"),
                   page, description)
        self._idle(page)

    def _show(self, page):
        self._grid_reads.clear()
        page.locator(config.APPLY_BUTTON).first.click()
        self._wait(lambda: any(p["gridServerOperations"].get("page") == 1 for p in self._grid_reads),
                   page, "Job Overview data request", timeout=30)
        self._settled(page, "record count")

    def _load_all(self, page, total):
        """Read the whole population in one server request.

        The grid pages 100 rows at a time with endless scrolling, but the server's
        paging order is not stable: on 15-Nov-2026 page 2 repeated two page-1 rows
        and silently omitted two others (DHT IMPALA, 187 rows). A single read has no
        page boundary, so it cannot duplicate or drop rows. Same filters, same
        transport; only the page size changes.
        """
        page_size = page.evaluate(f"() => {DS}.pageSize()")
        if total > page_size:
            self.log(f"{total} rows exceed the portal page of {page_size}; reading them in one request.")
            self._grid_reads.clear()
            page.evaluate(f"n => {DS}.pageSize(n)", total)
            self._wait(lambda: any(p["gridServerOperations"].get("pageSize") == total for p in self._grid_reads),
                       page, "single-page data request", timeout=30)
            self._settled(page, "complete population")
        return page.evaluate(f"() => {DS}.data().map(r => r.toJSON())")

    # ── Public operation ──────────────────────────────────────────────────────

    def extract_population(self, vessel, profile: FilterProfile = config.CRITICAL_JOB_FILTERS, *, on_progress=None):
        """Return an Extraction with all evidence. Reconciliation is the caller's decision."""
        self._assert_thread()
        self.log = on_progress or print
        stage = lambda name: self.on_state(state="stage", stage=name)
        try:
            stage("open")
            self.open()
            stage("navigate")
            page = self._job_overview_page()
            stage("vessel")
            self._select_report_vessel(page, vessel)
            stage("filters")
            self._select_equipment_node(page, profile.equipment_node)
            self._apply_profile(page, profile)
            readback = self._readback(page)
            sublevel = page.locator(config.SUBLEVEL_CHECKBOX).is_checked()
            overdue = page.locator(config.OVERDUE_CHECKBOX).is_checked()
            stage("extract")
            self._show(page)
            label = self._count_label(page)
            total = page.evaluate(f"() => {DS}.total()")
            self.log(f"Portal reports: {label}.")
            rows = self._load_all(page, total)
            dom_rows = page.locator(f"{config.GRID} .k-grid-content tbody tr[data-uid]").count()
            selected = [t.strip() for t in page.locator(".k-treeview .k-state-selected").all_inner_texts()]
            extraction = Extraction(
                vessel=vessel,
                vessel_box_value=self._vessel_box(page).input_value(),
                tree_root=self._tree_root(page),
                selected_node=selected[0] if selected else "",
                count_label=self._count_label(page),  # re-read after loading: must not have changed
                datasource_total=page.evaluate(f"() => {DS}.total()"),
                rows=rows,
                dom_row_count=dom_rows,
                read_payloads=list(self._grid_reads),
                filter_readback=readback,
                sublevel_checked=sublevel,
                overdue_checked=overdue,
            )
            self.log(f"Extracted {len(rows)} rows; {dom_rows} rendered.")
            return extraction
        except (SessionInterrupted, NoDataError):
            self.job_overview = None
            raise
        except Exception as error:
            try:
                self._check(self.active)
            except SessionInterrupted as interruption:
                self.job_overview = None
                raise interruption from error
            self._record_failure(vessel, error)
            self.job_overview = None
            raise PortalError(str(error)) from error

    def _record_failure(self, vessel, error):
        """Save only visible facts, never cookies, tokens or page HTML."""
        try:
            config.DIAGNOSTICS.mkdir(parents=True, exist_ok=True)
            page = self.job_overview
            data = {"vessel": vessel, "error": str(error), "at": datetime.now().isoformat(timespec="seconds"),
                    "url": page.url if self._live(page) else None,
                    "count_label": self._count_label(page) if self._live(page) else None,
                    "grid_reads": self._grid_reads[-5:]}
            path = config.DIAGNOSTICS / f"job-overview-{datetime.now():%Y%m%d-%H%M%S}.json"
            path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
            self.log(f"Diagnostics saved: {path}")
        except Exception as failure:
            self.log(f"Could not save diagnostics: {failure}")
