"""Date validation and UI-independent batch processing."""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Event

DEFAULT_OUTPUT = Path.home() / "Downloads" / "Vessel Report Centre Downloads"


def preset_range(name, today=None):
    today = today or date.today()
    if name == "Previous Month":
        end = today.replace(day=1) - timedelta(days=1)
        return end.replace(day=1), end
    if name == "Current Month":
        return today.replace(day=1), today
    if name in {"Last 3 Months", "Last 6 Months", "Last 12 Months"}:
        year, month = divmod(today.year * 12 + today.month - int(name.split()[1]), 12)
        return date(year, month + 1, 1), today
    if name == "Year to Date":
        return date(today.year, 1, 1), today
    if name == "Previous Year":
        return date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)
    return None


def parse_range(start, end):
    try:
        values = tuple(datetime.strptime(v.strip(), "%d-%b-%Y") for v in (start, end))
    except ValueError:
        raise ValueError("Use DD-MMM-YYYY, for example 01-Oct-2026.") from None
    if values[0] > values[1]:
        raise ValueError("The start date must be on or before the end date.")
    return values


def unique_path(folder, filename):
    candidate = folder / filename
    count = 2
    while candidate.exists():
        candidate = folder / f"{Path(filename).stem} ({count}){Path(filename).suffix}"
        count += 1
    return candidate


class DownloadError(RuntimeError):
    def __init__(self, message, downloaded_files=()):
        super().__init__(message)
        self.downloaded_files = list(downloaded_files)


class NoDataError(RuntimeError):
    """A valid vessel/report has no downloadable data for the requested range."""
    def __init__(self, message, status="No data"):
        super().__init__(message)
        self.status = status


class SessionInterrupted(DownloadError):
    """Recoverable authentication/browser loss; do not fail the whole queue."""
    def __init__(self, reason, message, downloaded_files=()):
        super().__init__(message, downloaded_files)
        self.reason = reason


@dataclass(frozen=True)
class ReportJob:
    vessel: str
    report: str


@dataclass(frozen=True)
class BatchRequest:
    vessels: tuple[str, ...]
    frequency: str
    reports: tuple[str, ...]
    start: datetime
    end: datetime
    output: Path
    retry_jobs: tuple[ReportJob, ...] | None = None
    attachment_extensions: tuple[str, ...] | None = None

    def __post_init__(self):
        # Accept the original single-vessel positional interface as well.
        vessels = (self.vessels,) if isinstance(self.vessels, str) else tuple(self.vessels)
        object.__setattr__(self, "vessels", tuple(dict.fromkeys(vessels)))
        object.__setattr__(self, "reports", tuple(dict.fromkeys(self.reports)))
        if self.attachment_extensions is not None:
            extensions = tuple(dict.fromkeys(ext.lower() if ext.startswith(".") else "." + ext.lower()
                                             for ext in self.attachment_extensions))
            if not extensions or any(not ext[1:].isalnum() for ext in extensions):
                raise ValueError("Attachment filters must contain valid file extensions.")
            object.__setattr__(self, "attachment_extensions", extensions)
        if not self.vessels or not self.reports:
            raise ValueError("Select at least one vessel and one report.")
        if self.start > self.end:
            raise ValueError("The start date must be on or before the end date.")
        if self.retry_jobs is not None:
            jobs = tuple(dict.fromkeys(self.retry_jobs))
            if not jobs or any(job.vessel not in self.vessels or job.report not in self.reports for job in jobs):
                raise ValueError("Retry jobs must belong to the original request.")
            object.__setattr__(self, "retry_jobs", jobs)

    @property
    def jobs(self):
        if self.retry_jobs is not None:
            return self.retry_jobs
        return tuple(ReportJob(vessel, report) for vessel in self.vessels for report in self.reports)

    def retry(self, jobs):
        return BatchRequest(self.vessels, self.frequency, self.reports, self.start, self.end,
                            self.output, tuple(jobs), self.attachment_extensions)


def run_batch(request, emit, stop: Event, downloader=None, recover=None):
    """Process immutable jobs; a recovery callback can pause/retry the current job.

    Attachment receipts live across recovery attempts, but not separate user runs.
    The desktop worker supplies its long-lived session; standalone callers own one
    session for the duration of this batch.
    """
    completed = files = failed = 0
    jobs = request.jobs
    owned_session = None
    try:
        if downloader is None:
            from .downloader import ReportSession
            owned_session = ReportSession()
            downloader = owned_session.download_report
        for job in jobs:
            if stop.is_set():
                break
            emit("started", vessel=job.vessel, report=job.report)
            receipts = {}
            interrupted_stop = False
            while True:
                try:
                    options = dict(output_dir=request.output,
                        on_progress=lambda message: emit("log", message=f"{job.vessel} / {job.report} | {message}"))
                    if request.attachment_extensions is not None:
                        options["attachment_extensions"] = request.attachment_extensions
                    if recover is not None:
                        options["receipts"] = receipts
                    result = downloader(job.vessel, job.report, request.frequency, request.start, request.end, **options)
                    paths = result.get("downloaded_files", [])
                    files += len(paths)
                    emit("result", vessel=job.vessel, report=job.report, status="Downloaded", paths=paths, error="")
                    break
                except SessionInterrupted as error:
                    paths = list(dict.fromkeys([*receipts.values(), *error.downloaded_files]))
                    if recover is None:
                        files += len(paths)
                        raise
                    if recover(error, job, receipts, completed, files + len(paths)):
                        continue
                    files += len(paths)
                    if paths:
                        emit("result", vessel=job.vessel, report=job.report, status="Stopped (partial)", paths=paths, error="")
                    interrupted_stop = True
                    stop.set()
                    break
                except NoDataError as empty:
                    emit("log", message=f"{job.vessel} / {job.report} | {empty}")
                    emit("result", vessel=job.vessel, report=job.report,
                         status=empty.status, paths=[], error="")
                    break
                except Exception as error:
                    paths = list(dict.fromkeys([*receipts.values(), *getattr(error, "downloaded_files", [])]))
                    files += len(paths)
                    failed += 1
                    emit("result", vessel=job.vessel, report=job.report, status="Needs attention", paths=paths, error=str(error))
                    break
            if interrupted_stop:
                break
            completed += 1
            emit("progress", completed=completed, files=files, failed=failed)
    except Exception as error:
        emit("fatal", message=str(error))
    finally:
        if owned_session is not None:
            owned_session.close()
        emit("finished", stopped=stop.is_set() and completed < len(jobs), completed=completed, files=files, failed=failed)
