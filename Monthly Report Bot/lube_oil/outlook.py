"""Read matching Excel report attachments from the classic Outlook profile."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
import re
from threading import Event
from typing import Callable

from vessel_report.core import unique_path

SUBJECT_PHRASE = "LUBE OIL STOCK AND CONSUMPTION"
OL_FOLDER_INBOX = 6
OL_MAIL = 43
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED_NAME = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.IGNORECASE)


@dataclass(frozen=True)
class OutlookDownloadResult:
    paths: tuple[Path, ...]
    matching_emails: int
    skipped_attachments: int


class OutlookDownloadError(RuntimeError):
    def __init__(self, message: str, downloaded_paths=()):
        super().__init__(message)
        self.downloaded_paths = tuple(downloaded_paths)


def _safe_filename(name: str) -> str:
    filename = Path(str(name).replace("\\", "/")).name
    filename = INVALID_FILENAME_CHARS.sub("_", filename).strip(" .")
    if WINDOWS_RESERVED_NAME.match(filename):
        filename = "_" + filename
    return filename


def _date_filter(start: date, end: date) -> str:
    start_text = datetime.combine(start, time.min).strftime("%d/%m/%Y %I:%M %p")
    exclusive_end = datetime.combine(end + timedelta(days=1), time.min)
    end_text = exclusive_end.strftime("%d/%m/%Y %I:%M %p")
    return f"[ReceivedTime] >= '{start_text}' AND [ReceivedTime] < '{end_text}'"


def _subject_filter() -> str:
    property_uri = "http://schemas.microsoft.com/mapi/proptag/0x0037001F"
    return f'@SQL="{property_uri}" LIKE \'%{SUBJECT_PHRASE}%\''


def _received_date(received_time: datetime) -> date:
    if received_time.tzinfo is not None:
        return received_time.astimezone().date()
    return received_time.date()


def _inbox_folders(inbox, stop: Event | None):
    pending = [inbox]
    while pending and not (stop and stop.is_set()):
        folder = pending.pop()
        yield folder
        folders = folder.Folders
        for index in range(folders.Count, 0, -1):
            child = folders.Item(index)
            if str(child.Name).casefold() not in {"deleted items", "junk email", "junk e-mail"}:
                pending.append(child)


def _connect_outlook():
    try:
        import pythoncom
        from win32com.client import Dispatch
    except ImportError as error:
        raise RuntimeError(
            "Outlook attachment search requires pywin32. Install the project's requirements "
            "and use classic Outlook for Windows."
        ) from error
    pythoncom.CoInitialize()
    try:
        namespace = Dispatch("Outlook.Application").GetNamespace("MAPI")
    except Exception as error:
        pythoncom.CoUninitialize()
        raise RuntimeError(
            "Could not connect to classic Outlook. Open Outlook, sign in to the intended mailbox, "
            "and try again."
        ) from error
    return namespace, pythoncom.CoUninitialize


def download_outlook_attachments(
    start: date,
    end: date,
    output: Path,
    emit: Callable[..., None] = lambda *_args, **_kwargs: None,
    stop: Event | None = None,
    outlook_factory: Callable[[], object] | None = None,
) -> OutlookDownloadResult:
    """Save .xlsx attachments from matching Inbox mail without changing messages."""
    if start > end:
        raise ValueError("The start date must be on or before the end date.")

    output = Path(output).expanduser()
    output.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    matching_emails = 0
    skipped_attachments = 0
    uninitialize = None

    try:
        if outlook_factory is None:
            namespace, uninitialize = _connect_outlook()
        else:
            namespace = outlook_factory()
        inbox = namespace.GetDefaultFolder(OL_FOLDER_INBOX)

        for folder in _inbox_folders(inbox, stop):
            if stop and stop.is_set():
                break
            items = folder.Items.Restrict(_subject_filter()).Restrict(_date_filter(start, end))
            emit("log", message=f"Searching Outlook folder: {folder.Name} · {items.Count} item(s) in date range")
            for index in range(items.Count, 0, -1):
                if stop and stop.is_set():
                    break
                item = items.Item(index)
                if getattr(item, "Class", None) != OL_MAIL:
                    continue
                received_date = _received_date(item.ReceivedTime)
                if not start <= received_date <= end:
                    continue
                subject = str(getattr(item, "Subject", "") or "")
                if SUBJECT_PHRASE.casefold() not in subject.casefold():
                    continue

                matching_emails += 1
                emit(
                    "matched",
                    received=received_date.isoformat(),
                    subject=subject,
                )
                attachments = item.Attachments
                for attachment_index in range(1, attachments.Count + 1):
                    if stop and stop.is_set():
                        break
                    attachment = attachments.Item(attachment_index)
                    filename = _safe_filename(attachment.FileName)
                    if Path(filename).suffix.casefold() != ".xlsx":
                        skipped_attachments += 1
                        emit("skipped", filename=filename, reason="not an .xlsx workbook")
                        continue
                    destination = unique_path(output, filename)
                    try:
                        attachment.SaveAsFile(str(destination))
                    except Exception:
                        if destination.exists():
                            destination.unlink()
                        raise
                    paths.append(destination)
                    emit("saved", path=str(destination))

        emit(
            "log",
            message=(
                f"Outlook search complete · {matching_emails} matching email(s) · "
                f"{len(paths)} Excel workbook(s) saved · "
                f"{skipped_attachments} non-.xlsx attachment(s) skipped"
            ),
        )
        return OutlookDownloadResult(tuple(paths), matching_emails, skipped_attachments)
    except OutlookDownloadError:
        raise
    except Exception as error:
        raise OutlookDownloadError(
            f"Outlook search could not be completed: {error}", paths
        ) from error
    finally:
        if uninitialize is not None:
            uninitialize()
