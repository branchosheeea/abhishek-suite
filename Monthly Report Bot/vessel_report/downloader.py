"""MariApps automation with an explicitly owned, reusable Edge session."""
from datetime import datetime
from pathlib import Path
from threading import get_ident
from time import monotonic
from urllib.parse import urlparse
from uuid import uuid4
import re
import json
import os

from playwright.sync_api import sync_playwright, Error as PlaywrightError
from .core import DEFAULT_OUTPUT, DownloadError, NoDataError, SessionInterrupted, existing_copy, file_sha256, history_check, unique_path

PROFILE = Path(__file__).parent.parent / "profiles" / "bot_profile"
PAGE_TIMEOUT_MS = 90_000
DOWNLOAD_TIMEOUT_MS = 120_000
MARIAPPS_URL = "https://apps.goodwoodship.com/Home/Landing"
FORM_FOLDERS = {"Monthly": "M1 - Monthly Forms", "Quarterly": "M3 - Quarterly Forms",
                "Six Monthly": "M6 - Six Monthly Forms", "Yearly": "M12 - Yearly Forms"}


class ReportSession:
    """All methods must run on the worker thread that creates this object."""
    def __init__(self, on_state=None, playwright_factory=sync_playwright):
        self._owner = get_ident()
        self._factory = playwright_factory
        self._playwright = None
        self.context = None
        self.landing = None
        self.equipment = None
        self.equipment_url = None
        self.active = None
        self.current_vessel = None
        self.current_frequency = None
        self._job_pages = set()
        self._needs_restore = False
        self._launched = False
        self._lost = False
        self._auth_expired = False
        self.on_state = on_state or (lambda **_data: None)
        self.log = lambda _message: None

    def _assert_thread(self):
        if get_ident() != self._owner:
            raise RuntimeError("Browser operations must stay on their owning worker thread.")

    def _closed(self, _context):
        self._lost = True

    def _response(self, response):
        # A forbidden report (403) is not treated as an expired login.
        if response.status == 401 and urlparse(response.url).hostname == urlparse(MARIAPPS_URL).hostname:
            self._auth_expired = True

    def _live(self, page):
        return page is not None and not page.is_closed()

    def _browser_ok(self):
        if self.context is None or self._lost:
            return False
        try:
            return bool(self.context.pages)
        except PlaywrightError:
            return False

    def _login_page(self, page):
        if not self._live(page):
            return False
        host = urlparse(page.url).hostname or ""
        return (host in {"login.microsoftonline.com", "login.live.com"}
                or page.locator("#winuseritem").is_visible())

    def _dashboard(self, page):
        return self._live(page) and page.locator("#mainmenu-btn").is_visible() and not self._login_page(page)

    def _check(self, page=None):
        if not self._browser_ok():
            raise SessionInterrupted("browser", "Edge was closed or disconnected. Reopen it to resume the queue.")
        if self._auth_expired or (page is not None and self._login_page(page)):
            raise SessionInterrupted("auth", "MariApps needs sign-in. Sign in in Edge, then click Resume.")

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
            self._playwright = self._factory().start()
            self.context = self._playwright.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE), channel="msedge", headless=False, accept_downloads=True)
            self.context.set_default_timeout(PAGE_TIMEOUT_MS)
            self.context.on("close", self._closed)
            self.context.on("response", self._response)
            self.landing = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.active = self.landing
            self.on_state(state="opened", message="Edge session opened. It will be reused until the app closes.")
            self.landing.goto(MARIAPPS_URL, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        except PlaywrightError as error:
            self._lost = True
            raise SessionInterrupted("browser", f"Could not open Edge: {error}") from error
        self._initial_sign_in()

    def _initial_sign_in(self):
        # A cached authenticated dashboard skips sign-in completely.
        self._wait(lambda: self._dashboard(self.landing) or self._login_page(self.landing), self.landing,
                   "MariApps landing page", check_auth=False)
        if self._dashboard(self.landing):
            return
        if self.landing.locator("#winuseritem").is_visible():
            self.log("Starting Microsoft sign-in for this browser session.")
            self.landing.locator("#winuseritem").click()
        # SSO may complete immediately; interactive MFA is handled by the pause UI.
        try:
            self._wait(lambda: self._dashboard(self.landing), self.landing, "authenticated dashboard",
                       timeout=10, check_auth=False)
        except TimeoutError:
            raise SessionInterrupted("auth", "Complete Microsoft sign-in in Edge, then click Resume.") from None

    def _wait(self, predicate, page, description, timeout=PAGE_TIMEOUT_MS / 1000, check_auth=True):
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            self._check(page if check_auth else None) if check_auth else self._check_browser_only()
            value = predicate()
            if value:
                return value
            pump = page if self._live(page) else self.landing
            if self._live(pump):
                pump.wait_for_timeout(100)  # Poll an explicit condition, not a fixed navigation delay.
            else:
                raise SessionInterrupted("browser", "The working browser tab was closed. Reopen Edge to resume.")
        raise TimeoutError(f"Timed out after {timeout:g}s waiting for {description}.")

    def _check_browser_only(self):
        if not self._browser_ok():
            raise SessionInterrupted("browser", "Edge was closed. Reopen it to resume.")

    def _idle(self, page):
        self._check(page)
        page.wait_for_function("""() => {
            const active = e => {
                if (!e.offsetWidth && !e.offsetHeight) return false;
                const s = window.getComputedStyle(e);
                return s.display !== 'none'
                    && s.visibility !== 'hidden'
                    && parseFloat(s.opacity ?? '1') > 0.05;
            };
            if (document.readyState === 'loading') return false;
            if ([...document.querySelectorAll('#loading-container,.form-loader,.k-loading-mask')].some(active)) return false;
            // Allow up to 3 s for jQuery AJAX to settle; ignore persistent background polling.
            if (window.jQuery && window.jQuery.active > 0) {
                if (!window._idleJqStart) window._idleJqStart = Date.now();
                if (Date.now() - window._idleJqStart <= 3000) return false;
                window._idleJqStart = undefined;
                return true;
            }
            window._idleJqStart = undefined;
            return true;
        }""", timeout=PAGE_TIMEOUT_MS)
        self._check(page)

    def pump(self):
        """Dispatch Playwright events while the command queue is idle."""
        self._assert_thread()
        if self._browser_ok():
            try:
                self.context.pages[0].wait_for_timeout(30)
            except PlaywrightError:
                self._lost = True

    def show_sign_in(self):
        self._assert_thread()
        self._check_browser_only()
        for page in reversed(self.context.pages):
            if self._login_page(page):
                page.bring_to_front()
                return
        if not self._live(self.landing):
            self.landing = self.context.new_page()
        if self._auth_expired:
            self.landing.goto(MARIAPPS_URL, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        self.landing.bring_to_front()
        if self.landing.locator("#winuseritem").is_visible():
            self.landing.locator("#winuseritem").click()

    def resume(self, *, reopen=False):
        self._assert_thread()
        if reopen:
            self.open(reopen=True)
        else:
            self._check_browser_only()
        # Refresh an authenticated application page to verify the server session,
        # rather than trusting a stale dashboard left visible after a 401.
        candidates = [p for p in self.context.pages if self._dashboard(p)]
        if not candidates:
            raise SessionInterrupted("auth", "Sign-in is not complete yet. Finish it in Edge, then Resume.")
        page = candidates[0]
        self._auth_expired = False
        page.reload(wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        self._wait(lambda: self._dashboard(page), page, "authenticated dashboard")
        self.landing = page
        self._cleanup_job_tabs()
        self.active = page
        self._invalidate()
        self._needs_restore = True
        self.on_state(state="ready", message="Authenticated session restored; continuing unfinished work.")

    def _invalidate(self):
        self.current_vessel = None
        self.current_frequency = None

    def _target_page(self, source, click, marker, *, job_page=True):
        before = set(self.context.pages)
        source_url = source.url
        marker_was_visible = source.get_by_text(marker, exact=True).first.is_visible()
        click()
        def find():
            new_pages = [p for p in self.context.pages if p not in before and not p.is_closed()]
            for page in new_pages:
                if job_page:
                    self._job_pages.add(page)
                if self._login_page(page):
                    raise SessionInterrupted("auth", "The report redirected to sign-in. Sign in and Resume.")
                if page.get_by_text(marker, exact=True).first.is_visible():
                    return page
            if (not new_pages and self._live(source)
                    and (not marker_was_visible or source.url != source_url)
                    and source.get_by_text(marker, exact=True).first.is_visible()):
                return source
            return None
        page = self._wait(find, source, marker)
        self.active = page
        page.bring_to_front()
        self._idle(page)
        return page

    def _equipment_page(self):
        self._check(self.active)
        if self._live(self.equipment) and not self._needs_restore:
            return self.equipment
        self._invalidate()
        if self._live(self.equipment) and self.equipment_url:
            self.equipment.goto(self.equipment_url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
            self.active = self.equipment
            self._idle(self.equipment)
        else:
            if not self._live(self.landing):
                raise SessionInterrupted("browser", "The navigation tab was closed. Reopen Edge to resume.")
            page = self.landing
            self.log("Opening Equipment / General in the existing session.")
            # The menu wrapper itself has zero height, so wait on a visible item instead.
            menu = page.locator("#main-menu-wrappper")
            maintenance = menu.get_by_text("Maintenance", exact=True).locator("visible=true").first
            for attempt in range(3):
                if not maintenance.is_visible():
                    page.locator("#mainmenu-btn").click()
                try:
                    maintenance.wait_for(state="visible", timeout=10_000)
                    break
                except PlaywrightError:
                    if attempt == 2:
                        raise
                    self.log("Main menu did not open; retrying.")
            maintenance.click()
            menu.get_by_text("Equipment", exact=True).locator("visible=true").first.click()
            before = set(self.context.pages)
            menu.get_by_text("General", exact=True).locator("visible=true").first.click()
            def find():
                for candidate in self.context.pages:
                    if candidate not in before or candidate is page:
                        if "EquipmentGeneral" in candidate.url:
                            return candidate
                return None
            self.equipment = self._wait(find, page, "Equipment Details tab")
            self.active = self.equipment
            self._idle(self.equipment)
            self.equipment_url = self.equipment.url
        self._needs_restore = False
        return self.equipment

    def _vessel_box(self, page):
        return page.locator('input[aria-controls="vesselSearchBox_listbox"]:visible, .header-vessel input.k-input.search-wrapper:visible').first

    def _select_vessel(self, page, vessel):
        self._idle(page)
        if self._vessel_box(page).input_value().strip() == vessel:
            self.log(f"Keeping active vessel {vessel}.")
            self.current_vessel = vessel
            self.current_frequency = None
            return
        self.log(f"Selecting {vessel}.")
        self._vessel_box(page).click()
        box = self._vessel_box(page)
        box.fill("")
        box.press_sequentially(vessel, delay=20)
        listbox = page.locator("#vesselSearchBox_listbox")
        try:
            listbox.wait_for(state="visible", timeout=10000)
        except PlaywrightError:
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.")
        if listbox.get_by_text("No data found", exact=False).is_visible():
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.")
        option = listbox.get_by_text(vessel, exact=True)
        try:
            option.first.wait_for(state="attached", timeout=10000)
        except PlaywrightError:
            raise NoDataError(f"Vessel '{vessel}' was not found in the portal vessel list.")
        try:
            option.first.scroll_into_view_if_needed()
        except Exception:
            pass
        option.first.click()
        self._wait(lambda: self._vessel_box(page).input_value().strip() == vessel, page, f"selected vessel {vessel}")
        self._idle(page)
        page.get_by_text("A - EQUIPMENT", exact=False).first.wait_for(state="visible")
        self.current_vessel = vessel
        self.current_frequency = None

    def _open_frequency(self, page, frequency):
        for label in ("A - EQUIPMENT", "B - MISCELLANEOUS", "M - HSQEEn FORMS AND REPORTS"):
            text = page.get_by_text(label, exact=False).first
            text.wait_for(state="visible")
            text.scroll_into_view_if_needed()
            row = text.locator("xpath=ancestor::li[@role='treeitem'][1]")
            expand = row.locator("span.k-icon.k-i-expand").first
            if expand.is_visible():
                expand.click()
                self._idle(page)
        folder = page.get_by_text(FORM_FOLDERS[frequency], exact=False).first
        folder.scroll_into_view_if_needed()
        folder.click()
        self._idle(page)
        # PAL's established workflow selects the folder first, then opens it.
        folder.click()
        self._idle(page)
        page.get_by_text("Job Plan", exact=True).first.click()
        page.locator('input[placeholder="Search"]:visible').first.wait_for(state="visible")
        self._idle(page)
        self.current_frequency = frequency

    def prepare(self, vessel, frequency):
        self.open()
        page = self._equipment_page()
        if self.current_vessel != vessel:
            self._select_vessel(page, vessel)
        if self.current_frequency != frequency:
            self.log(f"Opening {FORM_FOLDERS[frequency]}.")
            self._open_frequency(page, frequency)
        return page

    def _find_report(self, page, report):
        # Hidden grids and the equipment tree can repeat the same title.
        # Only visible table results are eligible Job Plan matches.
        matches = page.locator("tbody:visible").get_by_text(self._report_pattern(report)).locator("visible=true")
        try:
            matches.first.wait_for(state="visible")
        except PlaywrightError:
            self._record_lookup_failure(page, report)
            raise
        rows = matches.locator("xpath=ancestor::tr[1]")
        count = rows.count()
        if count != 1:
            raise RuntimeError(
                f"Expected one visible Job Plan result for {report}, found {count}; "
                "refusing ambiguous selection.")
        links = matches.locator("xpath=ancestor-or-self::a")
        if links.count() == 1:
            return links
        # Prefer the title cell when the reference occupies a separate cell.
        title = re.sub(r"^\d+(?:\.\d+)+\s*-?\s*", "", report)
        titles = rows.get_by_text(self._report_pattern(title)).locator("visible=true")
        return titles.first if titles.count() else matches.first

    @staticmethod
    def _report_pattern(report):
        """Exact identity with case/spacing/dash tolerance; never fuzzy matching."""
        if report in {"Vent Heads Inspections And Overhauling", "Vent Heads Inspections And Overhauling Report"}:
            return re.compile(r"^\s*Vent\s+Heads\s+Inspections\s+And\s+Overhauling(?:\s+Report)?\s*$", re.IGNORECASE)
        aliases = {
            "M/E & A/E Cooling Water Test Log": ["M/E Cooling Water Test Log"],
            "Monthly Oil Record Book Report": ["Monthly Oil Record Book Report 1M"],
            "1M BWTS Operation Log Report": ["BWTS Operation Log Report"],
            "14.14.05.001 - Battery Condition & load test": ["14.14.05.001 - Battery Condition & load test report"],
            "14.34.00.001 - Inventory of Precision Measuring": ["14.34.00.001 - Inventory of Precision Measuring Instruments"],
            "12.04.07.021 - LO Stock and consumption report": [
                "12.04.07.021 - LUBE OIL STOCK AND CONSUMPTION",
                "12.04.07.021 - LUBE OIL STOCK AND CONSUMPTION REPORT",
                "12.04.07.021 - LUB OIL STOCK AND CONSUMPTION",
                "12.04.07.021 - LUB OIL STOCK AND CONSUMPTION REPORT",
                "LUBE OIL STOCK AND CONSUMPTION",
                "LUBE OIL STOCK AND CONSUMPTION REPORT",
                "LUB OIL STOCK AND CONSUMPTION",
                "LUB OIL STOCK AND CONSUMPTION REPORT",
            ],
        }
        if report in aliases:
            variants = [report, *aliases[report]]
            patterns = []
            for variant in variants:
                # Build each explicit observed variant without fuzzy suffixes.
                parts = re.match(r"^(\d+(?:\.\d+)+)\s*-?\s*(.+)$", variant)
                title = parts.group(2) if parts else variant
                body = r"\s+".join(re.escape(word) for word in title.split())
                if parts:
                    body = rf"(?:(?:{re.escape(parts.group(1))}\s*[-–—]?\s*)?{body}|{re.escape(parts.group(1))})"
                patterns.append(body)
            return re.compile(r"^\s*(?:" + "|".join(patterns) + r")\s*$", re.IGNORECASE)
        parts = re.match(r"^(\d+(?:\.\d+)+)\s*-?\s*(.+)$", report)
        def text_pattern(text):
            return r"\s+".join(re.escape(word) for word in text.split())
        if parts:
            code, title = parts.groups()
            body = rf"(?:{re.escape(code)}\s*[-–—]?\s*)?{text_pattern(title)}"
            body = rf"(?:{body}|{re.escape(code)})"
        else:
            body = text_pattern(report)
        return re.compile(rf"^\s*{body}\s*$", re.IGNORECASE)

    @staticmethod
    def _report_query(report):
        reference = re.match(r"^(\d+(?:\.\d+)+)", report)
        if reference:
            return reference.group(1)
        return {
            "M/E & A/E Cooling Water Test Log": "Cooling Water Test Log",
            "1M BWTS Operation Log Report": "BWTS Operation Log Report",
        }.get(report, report)

    def _record_lookup_failure(self, page, report):
        """Save only visible lookup data, never cookies, tokens, or page HTML."""
        try:
            folder = Path(__file__).parent.parent / "diagnostics"
            folder.mkdir(exist_ok=True)
            path = folder / f"report-lookup-{datetime.now():%Y%m%d-%H%M%S-%f}.json"
            data = {
                "report": report, "vessel": self.current_vessel,
                "frequency": self.current_frequency,
                "visible_rows": page.locator("tbody:visible tr:visible").all_inner_texts(),
                "search_values": page.locator('input[placeholder="Search"]:visible').evaluate_all(
                    "(inputs) => inputs.map(input => input.value)"),
            }
            path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self.log(f"Report lookup diagnostics saved: {path}")
        except Exception as error:
            self.log(f"Could not capture report lookup diagnostics: {error}")

    @staticmethod
    def _attachment_state(page):
        if page.locator("a.download-icon:visible").count():
            return "files"
        empty_tabs = page.get_by_text(
            re.compile(r"^\s*Attachments\s*0\s*$", re.IGNORECASE)
        ).locator("visible=true")
        if empty_tabs.count() or page.locator(".k-grid-norecords:visible").count():
            return "empty"
        return None

    def _cleanup_job_tabs(self):
        # Only pages opened by this report are disposable. Keep the navigation tab.
        for page in tuple(self._job_pages):
            try:
                if self._live(page) and page not in (self.equipment, self.landing):
                    page.close()
            except PlaywrightError:
                pass
        self._job_pages.clear()
        self.active = self.equipment if self._live(self.equipment) else self.landing

    def close(self):
        self._assert_thread()
        try:
            if self.context is not None:
                self.context.close()
        except PlaywrightError:
            pass
        finally:
            self.context = None
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                finally:
                    self._playwright = None
            self.landing = self.equipment = self.active = None
            self.equipment_url = None
            self._job_pages.clear()
            self._invalidate()
            self._auth_expired = False
            self._needs_restore = False

    @staticmethod
    def _report_row_matches(row, report):
        """Require an exact report title or reference in a history row.

        A folder-level history can include every report at that frequency.
        Never infer row identity from the search box or selected folder.
        """
        pattern = ReportSession._report_pattern(report)
        return any(pattern.fullmatch(text)
                   for text in row.locator("td").all_inner_texts())

    # The Job History grid (Kendo), found by its job-order column. Read through the grid's own data source, as Critical
    # Job Compliance does: a single read of every row has no page boundary to miss rows at (audit P1-4).
    _HISTORY_GRID = """() => {
        if (!window.jQuery) return null
        const visible = (e) => e.offsetParent !== null
        for (const element of jQuery('.k-grid').toArray().filter(visible)) {
            const grid = jQuery(element).data('kendoGrid')
            if (grid && grid.columns && grid.columns.some((c) => c.field === 'jobOrderNo')) return grid
        }
        return null
    }"""

    def _history_grid_info(self, page):
        try:
            return page.evaluate(f"() => {{ const g = ({self._HISTORY_GRID})(); "
                                 f"return g ? {{ total: g.dataSource.total(), pageSize: g.dataSource.pageSize() || 0 }} : null }}")
        except PlaywrightError:
            return None

    def _load_all_history(self, page):
        """Ask the grid for every Job History row at once when they span more than one page. Returns (total, page
        size), or (None, None) when the grid could not be read (then a visible pager stops the report: core.history_check)."""
        info = self._history_grid_info(page)
        if not info:
            return None, None
        total, size = int(info.get("total") or 0), int(info.get("pageSize") or 0)
        if size and total > size:
            self.log(f"Job History has {total} job orders over several pages of {size}; reading them all.")
            page.evaluate(f"n => ({self._HISTORY_GRID})().dataSource.pageSize(n)", total)
            self._idle(page)
            self._wait(lambda: page.locator('tbody tr:visible td[data-field="jobOrderNo"]').count() >= total,
                       page, "all Job History rows")
        return total, size

    def _history(self, page, start, end, report):
        page.get_by_text("Job History", exact=True).first.click()
        self._idle(page)
        self._wait(lambda: page.locator('td[data-field="jobEndDate"]:visible').count()
            or page.locator('.k-grid-norecords:visible').count(), page, "Job History rows")
        total, page_size = self._load_all_history(page)
        matches = []
        excluded = 0
        read = 0
        rows = page.locator("tbody tr:visible")
        for index in range(rows.count()):
            row = rows.nth(index)
            date_cell = row.locator('td[data-field="jobEndDate"]')
            number_cell = row.locator('td[data-field="jobOrderNo"]').first
            if not date_cell.count() or not number_cell.count():
                continue
            read += 1
            number = number_cell.inner_text().strip()
            try:
                ended = datetime.strptime(date_cell.inner_text().strip(), "%d-%b-%Y")
            except ValueError:
                continue
            if number and start <= ended <= end:
                if self._report_row_matches(row, report):
                    matches.append((ended, number))
                else:
                    excluded += 1
        # Grid not readable: an enabled "next/last page" button on a visible pager (older and newer Kendo markup) means
        # rows may be missing. On a single page every pager button is disabled.
        pager = ":is(.k-pager-wrap, .k-pager):visible .k-pager-nav:not(.k-state-disabled):not(.k-disabled)"
        more_pages = bool(page.locator(pager).count()) if total is None else False
        problem = history_check(total, page_size, read, more_pages)
        if problem:
            raise RuntimeError(problem)
        self.log(f"Verified {len(matches)} job orders for {report}; excluded {excluded} unrelated or unverified rows.")
        if excluded and not matches:
            raise RuntimeError(
                f"Job History did not identify any rows as {report}. "
                "No attachments downloaded: report identity could not be verified.")
        return sorted(set(matches))

    @staticmethod
    def _receipt_paths(receipts):
        return list(dict.fromkeys(receipts.values()))

    @staticmethod
    def _attachment_matches(filename, extensions):
        return extensions is None or Path(filename).suffix.lower() in extensions

    def _save_attachment(self, key, receipts, folder, filename, get_download, attachment_extensions=None):
        saved = receipts.get(key)
        if saved and Path(saved).is_file() and Path(saved).stat().st_size > 0:
            self.log(f"Already saved before pause: {saved}")
            return saved
        if saved:
            del receipts[key]
        download = get_download()
        if not self._attachment_matches(download.suggested_filename, attachment_extensions):
            self.log(f"Skipped attachment whose downloaded file type did not match: {download.suggested_filename}")
            return None
        filename = re.sub(r'[<>:"/\\|?*]', "_", filename or download.suggested_filename).strip().rstrip(". ")
        if not filename:
            filename = "attachment"
        if not Path(filename).suffix:
            filename += Path(download.suggested_filename).suffix
        # Long OneDrive paths can exceed the legacy Windows MAX_PATH limit.
        if os.name == "nt" and len(str((folder / filename).absolute())) >= 240:
            absolute = str(folder.resolve())
            if not absolute.startswith("\\\\?\\"):
                folder = Path("\\\\?\\UNC\\" + absolute[2:] if absolute.startswith("\\\\")
                              else "\\\\?\\" + absolute)
        folder.mkdir(parents=True, exist_ok=True)
        # Saved under a temporary name first: if an earlier run already saved exactly this file here (same content,
        # same name or a numbered copy of it), that file is used and no " (2)" copy is added (audit P1-4).
        temporary = folder / f".vrc-download-{uuid4().hex}.part"
        try:
            download.save_as(temporary)
            if not temporary.is_file() or temporary.stat().st_size == 0:
                raise RuntimeError(f"Downloaded file was not saved correctly: {folder / filename}")
            earlier = existing_copy(folder, filename, file_sha256(temporary), temporary.stat().st_size,
                                    exclude=receipts.values())
            if earlier is not None:
                receipts[key] = str(earlier)
                self.log(f"Same file already saved by an earlier run: {earlier}")
                return str(earlier)
            path = unique_path(folder, filename)
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()
        # Record before subsequent navigation/callbacks can fail.
        receipts[key] = str(path)
        self.log(f"Saved: {path}")
        return str(path)

    def download_report(self, VESSEL_NAME, REPORT_NAME, FORM_FREQUENCY, START_DATE, END_DATE,
                        *, output_dir=None, on_progress=None, receipts=None,
                        attachment_extensions=None):
        self._assert_thread()
        if FORM_FREQUENCY not in FORM_FOLDERS:
            raise ValueError(f"Unsupported report frequency: {FORM_FREQUENCY}")
        start = datetime.strptime(START_DATE.strip(), "%d-%b-%Y") if isinstance(START_DATE, str) else START_DATE
        end = datetime.strptime(END_DATE.strip(), "%d-%b-%Y") if isinstance(END_DATE, str) else END_DATE
        if start > end:
            raise ValueError("From Date cannot be later than To Date.")
        receipts = {} if receipts is None else receipts
        self.log = on_progress or print
        interrupted = False
        downloaded_jobs = []
        try:
            page = self.prepare(VESSEL_NAME, FORM_FREQUENCY)
            if self._vessel_box(page).input_value().strip() != VESSEL_NAME:
                raise RuntimeError(f"Vessel verification failed for {VESSEL_NAME}; no attachments downloaded.")
            self.log(f"Searching {REPORT_NAME} in the existing session.")
            search = page.locator('input[placeholder="Search"]:visible').first
            query = self._report_query(REPORT_NAME)
            self.log(f"Job Plan search: {query}")
            search.fill(query)
            search.press("Enter")
            self._idle(page)
            selected = self._find_report(page, REPORT_NAME)
            report_page = self._target_page(page, selected.click, "Job History")
            if report_page is self.equipment:
                self._needs_restore = True
            matches = self._history(report_page, start, end, REPORT_NAME)
            if not matches:
                raise NoDataError(
                    f"No completed Job Order found between {start:%d-%b-%Y} and "
                    f"{end:%d-%b-%Y} for {VESSEL_NAME} / {REPORT_NAME}.")
            for ended, number in matches:
                self._check(report_page)
                self.log(f"Processing Job Order {number} ({ended:%d-%b-%Y}).")
                cell = report_page.locator('td[data-field="jobOrderNo"]:visible').filter(has_text=re.compile(r"^\s*" + re.escape(number) + r"\s*$"))
                if cell.count() != 1 or not self._report_row_matches(cell.locator("xpath=ancestor::tr[1]"), REPORT_NAME):
                    raise RuntimeError(f"Job Order {number} no longer uniquely matches {REPORT_NAME}; stopping this report.")
                cell.wait_for(state="visible")
                link = cell.locator("a").first
                detail = self._target_page(report_page, link.click if link.count() else cell.click, "Attachments")
                detail.get_by_text("Attachments", exact=True).first.click()
                self._idle(detail)
                state = self._wait(lambda: self._attachment_state(detail), detail, "attachments")
                count = detail.locator("a.download-icon:visible").count()
                if state == "empty" or not count:
                    self.log(f"Job Order {number} has no attachments in MariApps; skipped.")
                    count = 0
                occurrences = {}
                saved_count = 0
                for index in range(count):
                    self._check(detail)
                    icon = detail.locator("a.download-icon:visible").nth(index)
                    row = icon.locator("xpath=ancestor::tr[1]")
                    filename = row.locator("td").nth(1).inner_text().strip()
                    if not self._attachment_matches(filename, attachment_extensions):
                        self.log(f"Skipped non-matching attachment: {filename or '(unnamed)'}")
                        continue
                    # Prefer stable application IDs; otherwise use visible row
                    # metadata plus occurrence to distinguish identical attachments.
                    identity = icon.get_attribute("data-attachment-id") or icon.get_attribute("data-id")
                    identity = identity or " ".join(row.inner_text().split())
                    occurrence = occurrences.get(identity, 0)
                    occurrences[identity] = occurrence + 1
                    key = (VESSEL_NAME, REPORT_NAME, number, identity, occurrence)
                    def get_download():
                        with detail.expect_download(timeout=DOWNLOAD_TIMEOUT_MS) as pending:
                            icon.click()
                        return pending.value
                    folder = Path(output_dir or DEFAULT_OUTPUT) / VESSEL_NAME / ended.strftime("%Y-%m")
                    saved = self._save_attachment(
                        key, receipts, folder, filename, get_download,
                        attachment_extensions=attachment_extensions,
                    )
                    saved_count += saved is not None
                downloaded_jobs.append(dict(job_order_number=number, job_end_date=ended.strftime("%d-%b-%Y"),
                                            attachment_count=saved_count))
                if detail is not report_page:
                    detail.close()
                    self._job_pages.discard(detail)
                    self.active = report_page
                else:
                    detail.go_back(wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                    detail.get_by_text("Job History", exact=True).first.click()
                    self._idle(detail)
            paths = self._receipt_paths(receipts)
            if not paths and not any(job["attachment_count"] for job in downloaded_jobs) and attachment_extensions is None:
                raise NoDataError("Matching Job Orders were found, but none had attachments in MariApps.",
                                  status="No attachments")
            if attachment_extensions is not None and not paths:
                raise NoDataError(
                    "Matching Job Orders were found, but none contained an attachment with the requested file type.",
                    status="No matching Excel attachments")
            return dict(success=True, vessel_name=VESSEL_NAME, report_name=REPORT_NAME,
                form_frequency=FORM_FREQUENCY, job_orders=downloaded_jobs,
                downloaded_files=paths, file_count=len(paths), file_path=paths[0] if paths else "")
        except NoDataError:
            raise
        except SessionInterrupted as error:
            interrupted = True
            self._needs_restore = True
            self._invalidate()
            raise SessionInterrupted(error.reason, str(error), self._receipt_paths(receipts)) from error
        except Exception as error:
            # A timeout alone is a report failure, not evidence of expired login.
            try:
                self._check(self.active)
            except SessionInterrupted as interruption:
                interrupted = True
                self._needs_restore = True
                self._invalidate()
                raise SessionInterrupted(interruption.reason, str(interruption), self._receipt_paths(receipts)) from error
            self._needs_restore = True
            self._invalidate()
            raise DownloadError(str(error), self._receipt_paths(receipts)) from error
        finally:
            # Leave authentication tabs available while the queue is paused.
            if not interrupted:
                self._cleanup_job_tabs()


def download_report(VESSEL_NAME, REPORT_NAME, FORM_FREQUENCY, START_DATE, END_DATE,
                    *, output_dir=None, on_progress=None):
    """Standalone compatibility wrapper. The desktop app uses ReportSession directly."""
    session = ReportSession()
    try:
        return session.download_report(VESSEL_NAME, REPORT_NAME, FORM_FREQUENCY, START_DATE, END_DATE,
            output_dir=output_dir, on_progress=on_progress)
    finally:
        session.close()


if __name__ == "__main__":
    download_report("DHT IMPALA", "Unmanned Engine Room Alarms Report", "Monthly", "01-Oct-2026", "31-Oct-2026")
