from pathlib import Path
import re

import pandas as pd
import win32com.client


# ============================================================
# SETTINGS
# ============================================================

TEMP_FOLDER = Path(r"C:\TempBunker")
SHEET_NAME = "2026"

AMBER_LIMIT = 7.5
RED_LIMIT = 10.0

EXCEL_EXTENSIONS = (".xls", ".xlsx", ".xlsm")


# ============================================================
# HELPER FUNCTIONS
# ============================================================

def clean_file_name(file_name):
    """Remove characters that Windows does not allow in file names."""

    return re.sub(r'[<>:"/\\|?*]', "_", file_name)


def create_unique_path(folder, file_name):
    """Avoid overwriting attachments with the same name."""

    file_name = clean_file_name(file_name)
    path = folder / file_name

    counter = 1

    while path.exists():
        path = folder / (
            f"{Path(file_name).stem}_{counter}"
            f"{Path(file_name).suffix}"
        )
        counter += 1

    return path


def get_excel_engine(file_path):
    """Choose the correct reader for old and new Excel formats."""

    if file_path.suffix.lower() == ".xls":
        return "xlrd"

    return "openpyxl"


def get_status(variance):
    """Apply the bunker variance traffic-light limits."""

    absolute_variance = abs(variance)

    if absolute_variance > RED_LIMIT:
        return "RED", "COMMENT REQUIRED"

    if absolute_variance >= AMBER_LIMIT:
        return "AMBER", "REVIEW RECOMMENDED"

    return "GREEN", "ACCEPTABLE"


# ============================================================
# PREPARE TEMPORARY FOLDER
# ============================================================

def prepare_temp_folder():
    """Create the folder and remove files from the previous run."""

    TEMP_FOLDER.mkdir(parents=True, exist_ok=True)

    for item in TEMP_FOLDER.iterdir():

        if item.is_file():

            try:
                item.unlink()

            except Exception as error:
                print(f"Could not delete old file: {item.name}")
                print(f"Reason: {error}")


# ============================================================
# SEARCH FULL OUTLOOK INBOX AND DOWNLOAD EXCEL ATTACHMENTS
# ============================================================

def download_bunker_attachments():

    outlook = win32com.client.Dispatch(
        "Outlook.Application"
    )

    namespace = outlook.GetNamespace("MAPI")
    inbox = namespace.GetDefaultFolder(6)

    messages = inbox.Items
    messages.Sort("[ReceivedTime]", True)

    matching_emails = 0
    emails_with_attachments = 0
    downloaded_files = []

    print()
    print("=" * 70)
    print("SEARCHING FULL OUTLOOK INBOX")
    print("=" * 70)

    for message in messages:

        try:
            subject = str(message.Subject or "")
            subject_lower = subject.lower()

            # Both words must appear in the subject.
            if (
                "fortnightly" not in subject_lower
                or "bunker" not in subject_lower
            ):
                continue

            matching_emails += 1
            attachment_count = message.Attachments.Count

            print()
            print(f"Matching email {matching_emails}")
            print(f"Subject     : {subject}")
            print(f"Received    : {message.ReceivedTime}")
            print(f"Attachments : {attachment_count}")

            if attachment_count == 0:
                continue

            emails_with_attachments += 1

            for number in range(1, attachment_count + 1):

                attachment = message.Attachments.Item(number)
                attachment_name = str(attachment.FileName)

                print(f"Attachment  : {attachment_name}")

                if not attachment_name.lower().endswith(
                    EXCEL_EXTENSIONS
                ):
                    print("Result      : Skipped, not an Excel file")
                    continue

                save_path = create_unique_path(
                    TEMP_FOLDER,
                    attachment_name
                )

                attachment.SaveAsFile(str(save_path))
                downloaded_files.append(save_path)

                print(f"Saved       : {save_path}")

        except Exception as error:
            print()
            print(f"Email could not be processed: {error}")

    print()
    print("=" * 70)
    print("OUTLOOK SEARCH SUMMARY")
    print("=" * 70)
    print(f"Matching bunker emails  : {matching_emails}")
    print(f"Emails with attachments : {emails_with_attachments}")
    print(f"Excel files downloaded  : {len(downloaded_files)}")
    print(f"Temporary folder        : {TEMP_FOLDER}")

    return downloaded_files


# ============================================================
# READ WORKBOOK DETAILS
# ============================================================

def find_latest_date_column(data):

    date_row = None

    for row in range(len(data)):

        first_cell = str(
            data.iloc[row, 0]
        ).strip().upper()

        if first_cell == "DATE":
            date_row = row
            break

    if date_row is None:
        raise ValueError("DATE row not found")

    latest_column = None
    latest_date = None

    for column in range(1, len(data.columns)):

        cell_value = data.iloc[date_row, column]

        parsed_date = pd.to_datetime(
            cell_value,
            errors="coerce"
        )

        if pd.isna(parsed_date):
            continue

        if latest_date is None or parsed_date > latest_date:
            latest_date = parsed_date
            latest_column = column

    if latest_column is None:
        raise ValueError("No report dates found")

    return latest_column, latest_date


def find_vessel_name(data, file_path):

    for row in range(min(10, len(data))):

        value = data.iloc[row, 0]

        if pd.isna(value):
            continue

        text = str(value).strip()

        if text.upper().startswith("DHT "):
            return text

    return file_path.stem


def read_variance(data, actual_row, latest_column):

    difference_row = actual_row + 2

    if difference_row >= len(data):
        return None

    difference_label = str(
        data.iloc[difference_row, 0]
    ).strip().upper()

    if "DIFFERENCE" not in difference_label:
        return None

    variance = pd.to_numeric(
        data.iloc[difference_row, latest_column],
        errors="coerce"
    )

    # If the Difference cell is blank, calculate it.
    if pd.isna(variance):

        actual_value = pd.to_numeric(
            data.iloc[actual_row, latest_column],
            errors="coerce"
        )

        logbook_value = pd.to_numeric(
            data.iloc[actual_row + 1, latest_column],
            errors="coerce"
        )

        if pd.isna(actual_value) or pd.isna(logbook_value):
            return None

        variance = actual_value - logbook_value

    return round(float(variance), 1)


# ============================================================
# REVIEW ONE EXCEL WORKBOOK
# ============================================================

def review_workbook(file_path):

    engine = get_excel_engine(file_path)

    workbook = pd.ExcelFile(
        file_path,
        engine=engine
    )

    if SHEET_NAME not in workbook.sheet_names:

        print()
        print("=" * 70)
        print(f"FILE    : {file_path.name}")
        print("RESULT  : SKIPPED")
        print(f"REASON  : Sheet '{SHEET_NAME}' not found")

        return None

    data = pd.read_excel(
        file_path,
        sheet_name=SHEET_NAME,
        header=None,
        engine=engine
    )

    vessel_name = find_vessel_name(
        data,
        file_path
    )

    latest_column, latest_date = (
        find_latest_date_column(data)
    )

    results = []

    for row in range(len(data)):

        label = str(
            data.iloc[row, 0]
        ).strip().upper()

        if not label.startswith("ACTUAL "):
            continue

        fuel = label.replace(
            "ACTUAL ",
            ""
        ).strip()

        variance = read_variance(
            data,
            row,
            latest_column
        )

        if variance is None:
            continue

        status, action = get_status(variance)

        results.append(
            {
                "fuel": fuel,
                "variance": variance,
                "status": status,
                "action": action,
            }
        )

    print()
    print("=" * 70)
    print(vessel_name)
    print("FORTNIGHTLY BUNKER REVIEW")
    print("=" * 70)
    print(f"File        : {file_path.name}")
    print(f"Report date : {latest_date:%d %B %Y}")
    print(f"Sheet       : {SHEET_NAME}")
    print()

    if not results:
        print("No recognised variance rows found.")
        return None

    red_items = []
    amber_items = []

    for result in results:

        variance_text = (
            f"{result['variance']:+.1f} MT"
        )

        print(
            f"{result['fuel']:<12}"
            f"{variance_text:<12}"
            f"{result['status']:<9}"
            f"{result['action']}"
        )

        if result["status"] == "RED":
            red_items.append(result)

        elif result["status"] == "AMBER":
            amber_items.append(result)

    print()
    print("RESULT:")

    if not red_items and not amber_items:
        print("All fuel variances are acceptable.")

    if amber_items:
        print(
            f"{len(amber_items)} AMBER warning(s) "
            "require review."
        )

    if red_items:
        print(
            f"{len(red_items)} RED exception(s) "
            "require comments."
        )

    if red_items or amber_items:

        print()
        print("-" * 70)
        print("DRAFT REPLY")
        print("-" * 70)
        print()
        print("Chief Engineer,")
        print()
        print("Good day.")
        print()
        print(
            "The fortnightly bunker report has "
            "been reviewed."
        )
        print()
        print(
            "The following variance(s) require "
            "your attention:"
        )
        print()

        items_for_email = red_items + amber_items

        for number, result in enumerate(
            items_for_email,
            start=1
        ):

            print(
                f"{number}. {result['fuel']} variance: "
                f"{result['variance']:+.1f} MT "
                f"({result['status']})"
            )

        print()
        print(
            "Please review the above and provide "
            "your comments and clarification."
        )
        print()
        print("Regards,")
        print("Abhishek")

    return {
        "vessel": vessel_name,
        "report_date": latest_date,
        "results": results,
    }


# ============================================================
# MAIN PROGRAM
# ============================================================

def main():

    prepare_temp_folder()

    downloaded_files = download_bunker_attachments()

    if not downloaded_files:

        print()
        print(
            "No Excel attachments were downloaded."
        )
        return

    print()
    print("=" * 70)
    print("REVIEWING DOWNLOADED BUNKER FILES")
    print("=" * 70)

    successful_reviews = 0
    failed_reviews = 0
    skipped_reviews = 0

    for file_path in downloaded_files:

        try:
            result = review_workbook(file_path)

            if result is None:
                skipped_reviews += 1
            else:
                successful_reviews += 1

        except Exception as error:

            failed_reviews += 1

            print()
            print("=" * 70)
            print(f"FILE   : {file_path.name}")
            print("RESULT : REVIEW FAILED")
            print(f"ERROR  : {error}")

    print()
    print("=" * 70)
    print("FINAL BATCH SUMMARY")
    print("=" * 70)
    print(
        f"Files downloaded    : "
        f"{len(downloaded_files)}"
    )
    print(
        f"Successfully reviewed: "
        f"{successful_reviews}"
    )
    print(
        f"Skipped             : "
        f"{skipped_reviews}"
    )
    print(
        f"Failed              : "
        f"{failed_reviews}"
    )
    print()
    print(
        "Downloaded files remain in "
        r"C:\TempBunker"
    )


if __name__ == "__main__":
    main()