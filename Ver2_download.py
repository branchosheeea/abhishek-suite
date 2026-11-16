from datetime import datetime
from pathlib import Path
import re

from playwright.sync_api import sync_playwright

# ============================================================
# CONFIGURATION
# ============================================================

PROFILE = Path(__file__).parent / "bot_profile"

MARIAPPS_URL = "https://apps.goodwoodship.com/Home/Landing"


# ============================================================
# DOWNLOAD REPORT FUNCTION
# ============================================================


def download_report(VESSEL_NAME, REPORT_NAME):

    print("====================================")
    print("MONTHLY REPORT BOT")
    print("====================================")
    print(f"Vessel: {VESSEL_NAME}")
    print(f"Report: {REPORT_NAME}")
    print("")

    with sync_playwright() as p:

        context = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE),
            channel="msedge",
            headless=False,
            accept_downloads=True,
        )

        try:
            landing_page = context.pages[0] if context.pages else context.new_page()

            # ====================================================
            # OPEN MARIAPPS
            # ====================================================

            print("Opening MariApps...")

            landing_page.goto(
                MARIAPPS_URL,
                wait_until="domcontentloaded",
                timeout=60000,
            )

            print("Waiting for Microsoft Sign In...")

            sign_in = landing_page.locator("#winuseritem")

            sign_in.wait_for(
                state="visible",
                timeout=30000,
            )

            print("Clicking Microsoft Sign In...")
            sign_in.click()

            print("Waiting for PAL dashboard...")

            landing_page.locator("#mainmenu-btn").wait_for(
                state="visible",
                timeout=60000,
            )

            # ====================================================
            # MAINTENANCE > EQUIPMENT > GENERAL
            # ====================================================

            print("Opening Main Menu...")

            landing_page.locator("#mainmenu-btn").click()

            landing_page.wait_for_timeout(1500)

            print("Opening Maintenance...")

            landing_page.locator("#main-menu-wrappper").get_by_text(
                "Maintenance",
                exact=True,
            ).first.click()

            landing_page.wait_for_timeout(1500)

            print("Opening Equipment...")

            landing_page.locator("#main-menu-wrappper").get_by_text(
                "Equipment",
                exact=True,
            ).first.click()

            landing_page.wait_for_timeout(1500)

            print("Opening General...")

            pages_before = list(context.pages)

            landing_page.get_by_text(
                "General",
                exact=True,
            ).first.click()

            equipment_page = None

            # Wait for a new Equipment Details tab.
            for _ in range(30):

                landing_page.wait_for_timeout(1000)

                for candidate in context.pages:

                    if candidate not in pages_before:
                        equipment_page = candidate
                        break

                if equipment_page is not None:
                    break

            # Reuse Equipment Details if already open.
            if equipment_page is None:

                for candidate in context.pages:

                    if "EquipmentGeneral" in candidate.url:
                        equipment_page = candidate
                        break

            if equipment_page is None:

                raise RuntimeError("Equipment Details tab was not found.")

            equipment_page.bring_to_front()

            equipment_page.wait_for_load_state(
                "domcontentloaded",
                timeout=60000,
            )

            print("Equipment Details opened:")
            print(equipment_page.url)

            # ====================================================
            # SELECT VESSEL
            # ====================================================

            print("Locating vessel selector...")

            vessel_box = (
                equipment_page.locator('input[aria-controls="vesselSearchBox_listbox"]')
                .filter(visible=True)
                .first
            )

            if vessel_box.count() == 0:

                vessel_box = (
                    equipment_page.locator(
                        ".header-vessel " "input.k-input.search-wrapper"
                    )
                    .filter(visible=True)
                    .first
                )

            vessel_box.wait_for(
                state="visible",
                timeout=30000,
            )

            print("Opening vessel selector...")

            vessel_box.click()

            equipment_page.wait_for_timeout(1000)

            # PAL rerenders the vessel control after clicking.
            # Reacquire the locator before typing.
            vessel_box = (
                equipment_page.locator('input[aria-controls="vesselSearchBox_listbox"]')
                .filter(visible=True)
                .first
            )

            if vessel_box.count() == 0:

                vessel_box = (
                    equipment_page.locator(
                        ".header-vessel " "input.k-input.search-wrapper"
                    )
                    .filter(visible=True)
                    .first
                )

            vessel_box.wait_for(
                state="visible",
                timeout=30000,
            )

            print(f"Typing {VESSEL_NAME}...")

            vessel_box.click()
            vessel_box.press("Control+A")
            vessel_box.press("Backspace")

            vessel_box.press_sequentially(
                VESSEL_NAME,
                delay=120,
            )

            equipment_page.wait_for_timeout(3000)

            print(f"Clicking {VESSEL_NAME} result...")

            vessel_result = (
                equipment_page.locator("#vesselSearchBox_listbox")
                .get_by_text(
                    VESSEL_NAME,
                    exact=True,
                )
                .first
            )

            vessel_result.wait_for(
                state="visible",
                timeout=30000,
            )

            vessel_result.click()

            print(f"Waiting for {VESSEL_NAME} " "equipment tree...")

            equipment_page.wait_for_timeout(8000)

            print(f"{VESSEL_NAME} selected successfully.")

            # ====================================================
            # EXPAND A - EQUIPMENT
            # ====================================================

            print("Expanding A - EQUIPMENT...")

            a_text = equipment_page.get_by_text(
                "A - EQUIPMENT",
                exact=False,
            ).first

            a_text.wait_for(
                state="visible",
                timeout=30000,
            )

            a_text.scroll_into_view_if_needed()

            a_row = a_text.locator("xpath=ancestor::li[@role='treeitem'][1]")

            a_expand = a_row.locator("span.k-icon.k-i-expand").first

            a_expand.wait_for(
                state="visible",
                timeout=30000,
            )

            a_expand.click()

            equipment_page.wait_for_timeout(3000)

            print("A - EQUIPMENT expanded successfully.")

            # ====================================================
            # EXPAND B - MISCELLANEOUS / TEMPLATES / CIRCULARS
            # ====================================================

            print("Expanding B - MISCELLANEOUS / " "TEMPLATES / CIRCULARS...")

            b_text = equipment_page.get_by_text(
                "B - MISCELLANEOUS",
                exact=False,
            ).first

            b_text.wait_for(
                state="visible",
                timeout=30000,
            )

            b_text.scroll_into_view_if_needed()

            b_row = b_text.locator("xpath=ancestor::li[@role='treeitem'][1]")

            b_expand = b_row.locator("span.k-icon.k-i-expand").first

            b_expand.wait_for(
                state="visible",
                timeout=30000,
            )

            b_expand.click()

            equipment_page.wait_for_timeout(3000)

            print("B - MISCELLANEOUS / TEMPLATES / " "CIRCULARS expanded successfully.")

            # ====================================================
            # EXPAND M - HSQEN FORMS AND REPORTS
            # ====================================================

            print("Opening M - HSQEN FORMS AND REPORTS...")

            # Retained exactly from the successful version.
            m_text = equipment_page.get_by_text(
                "M - HSQEEn FORMS AND REPORTS",
                exact=False,
            ).first

            m_text.wait_for(
                state="visible",
                timeout=30000,
            )

            m_text.scroll_into_view_if_needed()

            m_treeitem = m_text.locator("xpath=ancestor::li[@role='treeitem'][1]")

            m_expand = m_treeitem.locator("span.k-icon.k-i-expand").first

            m_expand.wait_for(
                state="visible",
                timeout=30000,
            )

            m_expand.click()

            equipment_page.wait_for_timeout(3000)

            print("M - HSQEN FORMS AND REPORTS " "expanded successfully.")

            # ====================================================
            # OPEN M1 - MONTHLY FORMS
            # ====================================================

            print("Opening M1 - Monthly Forms...")

            monthly_forms = equipment_page.get_by_text(
                "M1 - Monthly Forms",
                exact=False,
            ).first

            monthly_forms.wait_for(
                state="visible",
                timeout=30000,
            )

            monthly_forms.scroll_into_view_if_needed()
            monthly_forms.click()

            equipment_page.wait_for_timeout(7000)

            print("M1 - Monthly Forms opened successfully.")

            # Second click retained because it was present
            # in the successful download version.
            print("Opening M1 - Monthly Forms again...")

            monthly_forms = equipment_page.get_by_text(
                "M1 - Monthly Forms",
                exact=False,
            ).first

            monthly_forms.wait_for(
                state="visible",
                timeout=30000,
            )

            monthly_forms.scroll_into_view_if_needed()
            monthly_forms.click()

            equipment_page.wait_for_timeout(7000)

            print("M1 - Monthly Forms opened successfully.")

            # ====================================================
            # OPEN JOB PLAN
            # ====================================================

            print("Opening Job Plan...")

            job_plan = equipment_page.get_by_text(
                "Job Plan",
                exact=True,
            ).first

            job_plan.wait_for(
                state="visible",
                timeout=30000,
            )

            job_plan.click()

            equipment_page.wait_for_timeout(7000)

            print("Job Plan opened successfully.")

            # ====================================================
            # SEARCH SELECTED REPORT
            # ====================================================

            print("Locating Job Plan search box...")

            job_search = (
                equipment_page.locator('input[placeholder="Search"]')
                .filter(visible=True)
                .first
            )

            job_search.wait_for(
                state="visible",
                timeout=30000,
            )

            print(f"Typing {REPORT_NAME}...")

            job_search.click()
            job_search.fill(REPORT_NAME)

            equipment_page.wait_for_timeout(1000)

            print("Pressing Enter to execute search...")

            job_search.press("Enter")

            equipment_page.wait_for_timeout(5000)

            print(f"{REPORT_NAME} search completed.")

            # ====================================================
            # OPEN SELECTED REPORT
            # ====================================================

            print(f"Opening {REPORT_NAME}...")

            selected_job = equipment_page.get_by_text(
                REPORT_NAME,
                exact=True,
            ).first

            selected_job.wait_for(
                state="visible",
                timeout=30000,
            )

            pages_before_job = list(context.pages)

            selected_job.click()

            print("Waiting for Job Order page to open...")

            job_order_page = None

            for _ in range(30):

                equipment_page.wait_for_timeout(1000)

                for candidate in context.pages:

                    if candidate not in pages_before_job:
                        job_order_page = candidate
                        break

                if job_order_page is not None:
                    break

            # Find an already-open Job Order page.
            if job_order_page is None:

                for candidate in context.pages:

                    try:
                        if "Job Order" in candidate.title():
                            job_order_page = candidate
                            break

                    except Exception:
                        pass

            if job_order_page is None:

                raise RuntimeError(f"Job Order page for {REPORT_NAME} " "did not open.")

            job_order_page.bring_to_front()

            job_order_page.wait_for_load_state(
                "domcontentloaded",
                timeout=60000,
            )

            print("Job Order page opened successfully.")

            print(f"Selected report: {REPORT_NAME}")

            print("Job Order title:")
            print(job_order_page.title())

            # Allow PAL time to finish rendering tabs.
            job_order_page.wait_for_timeout(5000)

            # ====================================================
            # OPEN JOB HISTORY
            # ====================================================

            print("Locating Job History...")

            job_history = job_order_page.get_by_text(
                "Job History",
                exact=True,
            ).first

            job_history.wait_for(
                state="visible",
                timeout=30000,
            )

            print("Opening Job History...")

            job_history.click()

            job_order_page.wait_for_timeout(7000)

            print("Job History opened successfully.")

            # ====================================================
            # FIND LATEST COMPLETED JOB ORDER
            # ====================================================

            print("Reviewing Job End Dates...")

            history_rows = job_order_page.locator("tbody tr:visible")

            row_count = history_rows.count()

            print(f"Job History rows found: {row_count}")

            latest_date = None
            latest_row = None

            for i in range(row_count):

                row = history_rows.nth(i)

                end_date_cell = row.locator('td[data-field="jobEndDate"]')

                if end_date_cell.count() == 0:
                    continue

                end_date_text = end_date_cell.inner_text().strip()

                # Ignore pending jobs without Job End Date.
                if not end_date_text:
                    continue

                try:
                    end_date = datetime.strptime(
                        end_date_text,
                        "%d-%b-%Y",
                    )

                except ValueError:
                    continue

                if latest_date is None or end_date > latest_date:
                    latest_date = end_date
                    latest_row = row

            if latest_row is None:

                raise RuntimeError(
                    "No completed Job Order with a " "Job End Date was found."
                )

            print(
                "Latest Job End Date:",
                latest_date.strftime("%d-%b-%Y"),
            )

            # ====================================================
            # GET JOB ORDER NUMBER FROM THE SAME ROW
            # ====================================================

            job_order_cell = latest_row.locator('td[data-field="jobOrderNo"]').first

            job_order_cell.wait_for(
                state="visible",
                timeout=30000,
            )

            job_order_number = job_order_cell.inner_text().strip()

            print(
                "Latest completed Job Order:",
                job_order_number,
            )

            # ====================================================
            # OPEN LATEST COMPLETED JOB ORDER
            # ====================================================

            print("Opening latest completed Job Order...")

            pages_before_latest_job = list(context.pages)

            job_order_link = job_order_cell.locator("a").first

            if job_order_link.count() > 0:
                job_order_link.click()
            else:
                job_order_cell.click()

            job_order_page.wait_for_timeout(7000)

            latest_job_page = None

            # Check whether PAL created another tab.
            for candidate in context.pages:

                if candidate not in pages_before_latest_job:
                    latest_job_page = candidate
                    break

            # If PAL redirected the existing tab, reuse it.
            if latest_job_page is None:
                latest_job_page = job_order_page

            latest_job_page.bring_to_front()

            latest_job_page.wait_for_timeout(5000)

            print("Latest completed Job Order opened.")

            print(
                "Selected Job Order:",
                job_order_number,
            )

            # ====================================================
            # OPEN ATTACHMENTS
            # ====================================================

            print("Locating Attachments tab...")

            attachments_tab = latest_job_page.get_by_text(
                "Attachments",
                exact=True,
            ).first

            attachments_tab.wait_for(
                state="visible",
                timeout=30000,
            )

            print("Opening Attachments...")

            attachments_tab.click()

            latest_job_page.wait_for_timeout(7000)

            print("Attachments opened successfully.")

                    # ==========================================
        # DOWNLOAD ACTUAL ATTACHMENT
        # ==========================================

            print("Reading actual attachment filename...")

            # Locate the attachment row containing the download icon
            download_icon = latest_job_page.locator(
                "a.download-icon"
            ).first

            download_icon.wait_for(
                state="visible",
                timeout=30000
            )

            # Find the attachment row
            attachment_row = download_icon.locator(
                "xpath=ancestor::tr[1]"
            )

            # Read the filename from the same row
            file_name_cell = attachment_row.locator("td").nth(1)

            actual_filename = file_name_cell.inner_text().strip()

            print("Actual MariApps filename:")
            print(actual_filename)

            # Fallback if the grid truncates/doesn't expose filename properly
            if not actual_filename.lower().endswith(
                (".xlsx", ".xls", ".pdf", ".doc", ".docx")
            ):
                actual_filename = (
                    "MAIN ENGINE RUNNING HOURS.xlsx"
                )

            # Temporary testing directory
            download_folder = (
                Path.home()
                / "Downloads"
                / "Monthly Report Bot Test"
            )

            download_folder.mkdir(
                parents=True,
                exist_ok=True
            )

            save_path = download_folder / actual_filename

            print("Starting attachment download...")

            with latest_job_page.expect_download(
                timeout=60000
            ) as download_info:

                download_icon.click()

            download = download_info.value

            print("Playwright temporary filename:")
            print(download.suggested_filename)

            print("Saving actual attachment as:")
            print(save_path)

# ==========================================
# CREATE VESSEL / MONTH FOLDER
# ==========================================

            vessel_folder_name = VESSEL_NAME


            # Example actual attachment name:
            # 004.01 - MAIN ENGINE RUNNING HOURS - MAN - OCT' 2026.xlsx

            filename_upper = actual_filename.upper()

            month_map = {
                "JAN": "01",
                "FEB": "02",
                "MAR": "03",
                "APR": "04",
                "MAY": "05",
                "JUN": "06",
                "JUL": "07",
                "AUG": "08",
                "SEP": "09",
                "OCT": "10",
                "NOV": "11",
                "DEC": "12",
            }

            month_number = None
            year_number = None

            for month_text, month_value in month_map.items():
                if month_text in filename_upper:
                    month_number = month_value
                    break

            year_match = re.search(r"\b(20\d{2})\b", filename_upper)

            if year_match:
                year_number = year_match.group(1)

            if month_number and year_number:
                period_folder = f"{year_number}-{month_number}"
            else:
                period_folder = "Unknown Period"


            # ==========================================
            # ROOT DOWNLOAD FOLDER
            # ==========================================

            root_download_folder = (
                Path.home()
                / "Downloads"
                / "Monthly Report Bot Downloads"
            )

            save_folder = (
                root_download_folder
                / vessel_folder_name
                / period_folder
            )

            save_folder.mkdir(
                parents=True,
                exist_ok=True
            )


            # ==========================================
            # SAVE ACTUAL ATTACHMENT
            # ==========================================

            save_path = (
                save_folder
                / actual_filename
            )

            print("Saving attachment to:")
            print(save_path)

            download.save_as(save_path)


            # ==========================================
            # VERIFY FILE
            # ==========================================

            if not save_path.exists():
                raise RuntimeError(
                    f"Downloaded file was not saved: {save_path}"
                )

            file_size = save_path.stat().st_size

            if file_size <= 0:
                raise RuntimeError(
                    f"Downloaded file is empty: {save_path}"
                )

            print("")
            print("DOWNLOAD SUCCESSFUL")
            print(f"Vessel: {vessel_folder_name}")
            print(f"Period: {period_folder}")
            print(f"File: {actual_filename}")
            print(f"Size: {file_size / 1024:.1f} KB")
            print(f"Saved to: {save_path}")

            print("")
            print("====================================")
            print("DOWNLOAD COMPLETED")
            print("====================================")
            print("Saved file:")
            print(save_path)

            # Verify file exists and isn't empty
            if save_path.exists():

                file_size = save_path.stat().st_size

                print(
                    f"Saved file size: "
                    f"{file_size / 1024:.1f} KB"
                )

                if file_size == 0:
                    raise RuntimeError(
                        "Downloaded attachment is empty."
                    )

            else:
                raise RuntimeError(
                    "Attachment was not saved."
                )

            # Return information for the future UI.
            return {
                "success": True,
                "vessel_name": VESSEL_NAME,
                "report_name": REPORT_NAME,
                "job_order_number": job_order_number,
                "job_end_date": latest_date.strftime("%d-%b-%Y"),
                "file_path": str(save_path),
                "file_size": save_path.stat().st_size,
            }

        except Exception as error:

            print("")
            print("====================================")
            print("BOT STOPPED")
            print("====================================")
            print(error)

            raise

        finally:

            context.close()


# ============================================================
# DIRECT TEST
# ============================================================

if __name__ == "__main__":

    download_report(
        "DHT IMPALA",
        "Unmanned Engine Room Alarms Report",
    )
