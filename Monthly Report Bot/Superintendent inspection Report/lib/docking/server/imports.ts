// Digital Docking · importing a vessel's daily file from the screen. Two steps, both on the same uploaded bytes:
//   check  – read the workbook and say what would happen (day, entries, photos, new / replacing / unchanged), store nothing;
//   import – do it, through the repository (importSubmission), so the rules are the same as for every other import.
// Today vessels send their own "Work Done" workbook, which holds both departments: each department with content becomes
// that day's Deck or Engine record. The NeraVeda template will be read here as a second format once it is final.

import { createHash } from "node:crypto"
import { AppError } from "../../server/errors"
import { LEGACY_TEMPLATE, LEGACY_VERSION, type LegacyWorkbook, readWorkDoneWorkbook } from "../legacy/workdone"
import { DEFAULT_LIMITS, WorkbookRejected } from "../photos/package"
import { call, checkId } from "./api"
import type { Store } from "./db"
import { dayNumber, DEPARTMENTS, type Department, DockingError, getDocking, importSubmission, type ImportResult, RECEIVED_VIA } from "./repo"

export const MAX_UPLOAD_BYTES = DEFAULT_LIMITS.maxFileBytes
const FORMAT = "Vessel work-done workbook (before the NeraVeda template)"

export type Upload = { data: Buffer; name: string }
export type ImportOptions = {
  /** The day the Superintendent chose when the file's own date is missing or wrong. */
  reportDate?: string
  receivedVia?: string
  correctionReason?: string
}

type Kind = ImportResult["kind"]
export type DepartmentPlan = {
  department: Department
  entries: number; entries_without_text: number; photos: number; photos_rejected: number; sheets: string[]
  /** What importing does to this department of the day; null when the file has nothing for it. */
  kind: Kind | null
  current_file: string | null
}
export type ImportPlan = {
  file: { name: string; bytes: number; sha256: string }
  format: string
  file_date: string | null
  file_day_no: number | null
  report_date: string | null
  day_no: number | null
  day_state: string | null
  departments: DepartmentPlan[]
  warnings: string[]
  /** Anything listed here stops the import. */
  problems: string[]
  needs_reason: boolean
  issued_versions: number
}

/** A file name as the vessel sent it, without any path, control characters or excess length. */
export function cleanFileName(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() ?? ""
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(-200)
  return clean || "workbook.xlsx"
}

async function readBook(upload: Upload): Promise<LegacyWorkbook> {
  try {
    return await readWorkDoneWorkbook(upload.data)
  } catch (error) {
    if (error instanceof WorkbookRejected) throw new AppError(400, error.message)
    throw new AppError(400, "This file could not be read as an Excel workbook. Open it in Excel, save it as .xlsx and try again.")
  }
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

function localToday(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

function planFor(store: Store, dockingId: string, upload: Upload, book: LegacyWorkbook, options: ImportOptions): ImportPlan {
  const docking = call(() => getDocking(store, checkId(dockingId)))
  const sha = createHash("sha256").update(upload.data).digest("hex")
  const warnings = [...book.warnings.filter((w) => !/report date was not found/.test(w))]
  const problems: string[] = []

  if (docking.status === "cancelled") problems.push("This docking is cancelled; files can no longer be imported into it.")

  let reportDate: string | null = book.reportDate
  const chosen = options.reportDate?.trim()
  if (chosen) {
    if (!isDate(chosen)) problems.push("The chosen date must be written as YYYY-MM-DD.")
    else {
      if (book.reportDate && chosen !== book.reportDate) {
        warnings.push(`The file is dated ${book.reportDate}; it is imported as ${chosen} as you chose. Both dates are kept with the record.`)
      }
      reportDate = chosen
    }
  }
  if (!reportDate) problems.push("The file has no report date on its sheets. Choose the day it belongs to.")

  let dayNo: number | null = null
  if (reportDate && isDate(reportDate)) {
    try {
      dayNo = dayNumber(docking.day0_date, reportDate)
    } catch (error) {
      problems.push(error instanceof DockingError ? error.message : "The date is not valid.")
    }
  }
  if (dayNo !== null && book.dayNo !== null && book.dayNo !== dayNo && !chosen) {
    warnings.push(`The file calls itself Day ${book.dayNo}, but ${reportDate} is Day ${dayNo} of this docking (Day 0 = ${docking.day0_date}). NeraVeda numbers days from Day 0.`)
  }
  if (reportDate && isDate(reportDate) && reportDate > localToday(docking.utc_offset_minutes)) {
    warnings.push(`${reportDate} is later than today at the yard. Check the date on the file.`)
  }

  const day = dayNo === null ? undefined
    : (store.db.prepare("SELECT id, state FROM days WHERE docking_id = ? AND day_no = ?").get(docking.id, dayNo) as { id: string; state: string } | undefined)
  const current = (department: Department) => day
    ? (store.db.prepare("SELECT sha256, file_name FROM submissions WHERE day_id = ? AND department = ? AND status = 'current'").get(day.id, department) as { sha256: string; file_name: string } | undefined)
    : undefined

  const departments: DepartmentPlan[] = DEPARTMENTS.map((department) => {
    const part = book[department]
    const sheets = book.sheets.filter((s) => s.department === department)
    const has = part.activities.length > 0 || part.photos.length > 0
    const now = current(department)
    const kind: Kind | null = !has ? null : !now ? "initial" : now.sha256 === sha ? "duplicate" : day?.state === "reviewed" ? "amendment" : "revision"
    return {
      department,
      entries: part.activities.length,
      entries_without_text: part.activities.filter((a) => !a.workText.trim()).length,
      photos: part.photos.filter((p) => p.status === "linked").length,
      photos_rejected: part.photos.filter((p) => p.status === "rejected").length,
      sheets: sheets.map((s) => s.name),
      kind,
      current_file: now?.file_name ?? null,
    }
  })

  const toImport = departments.filter((d) => d.kind && d.kind !== "duplicate")
  if (!departments.some((d) => d.kind)) problems.push("The file has no Deck or Engine entries that NeraVeda can read. Check that the sheet names start with DECK or ENGINE.")
  else if (!toImport.length && dayNo !== null) problems.push(`This exact file is already Day ${dayNo}'s current file. Nothing would change.`)

  if (dayNo !== null) {
    const elsewhere = store.db.prepare(`SELECT s.docking_id, s.department, d.day_no FROM submissions s JOIN days d ON d.id = s.day_id
      WHERE s.sha256 = ? AND NOT (s.docking_id = ? AND d.day_no = ?) LIMIT 1`).get(sha, docking.id, dayNo) as { docking_id: string; department: string; day_no: number } | undefined
    if (elsewhere) {
      problems.push(`This exact file was already imported as the ${elsewhere.department} file of Day ${elsewhere.day_no}${elsewhere.docking_id === docking.id ? "" : " of another docking"}.`)
    }
  }

  const issued = day ? Number((store.db.prepare("SELECT COUNT(*) AS n FROM report_versions WHERE day_id = ?").get(day.id) as { n: number }).n) : 0
  const replacing = toImport.some((d) => d.kind === "revision" || d.kind === "amendment")
  if (replacing && issued) {
    warnings.push(`Day ${dayNo}'s daily report has ${issued === 1 ? "version 1" : `${issued} versions`} issued from the earlier file. Issued versions stay exactly as sent; rebuild the report's items to take in the new entries.`)
  }
  if (toImport.some((d) => d.kind === "amendment")) warnings.push(`Day ${dayNo} was already reviewed. After this import it goes back to "received" for review.`)

  return {
    file: { name: cleanFileName(upload.name), bytes: upload.data.length, sha256: sha },
    format: FORMAT,
    file_date: book.reportDate,
    file_day_no: book.dayNo,
    report_date: reportDate,
    day_no: dayNo,
    day_state: day?.state ?? (dayNo === null ? null : "expected"),
    departments,
    warnings,
    problems,
    needs_reason: toImport.some((d) => d.kind === "amendment"),
    issued_versions: issued,
  }
}

/** Read the file and say what importing it would do. Nothing is stored. */
export async function checkImport(store: Store, dockingId: string, upload: Upload, options: ImportOptions = {}): Promise<ImportPlan> {
  return planFor(store, dockingId, upload, await readBook(upload), options)
}

/** Import the file: each department with content becomes that day's record (initial, revision or amendment). */
export async function runImport(store: Store, dockingId: string, upload: Upload, options: ImportOptions, actor: string) {
  const book = await readBook(upload)
  const plan = planFor(store, dockingId, upload, book, options)
  if (plan.problems.length) throw new AppError(400, plan.problems[0])
  const receivedVia = (options.receivedVia ?? "email") as (typeof RECEIVED_VIA)[number]
  if (!(RECEIVED_VIA as readonly string[]).includes(receivedVia)) throw new AppError(400, `Received via must be one of: ${RECEIVED_VIA.join(", ")}.`)
  const reason = options.correctionReason?.trim() ?? ""
  if (reason.length > 500) throw new AppError(400, "The reason is longer than 500 characters.")
  if (plan.needs_reason && !reason) throw new AppError(400, `Day ${plan.day_no} has been reviewed. Give the reason for replacing its file.`)

  const results: (ImportResult & { department: Department })[] = []
  for (const d of plan.departments) {
    if (!d.kind || d.kind === "duplicate") continue
    const part = book[d.department]
    const result = call(() => importSubmission(store, {
      dockingId, reportDate: plan.report_date!, department: d.department, file: { data: upload.data, name: plan.file.name },
      template: LEGACY_TEMPLATE, templateVersion: LEGACY_VERSION, receivedVia, activities: part.activities, photos: part.photos, combined: true,
      correctionReason: d.kind === "amendment" ? reason : undefined, reviewedBefore: plan.day_state === "reviewed",
      validation: {
        format: FORMAT, warnings: plan.warnings, sheets: book.sheets.filter((s) => s.department === d.department),
        file_date: plan.file_date, file_day_no: plan.file_day_no, imported_as: plan.report_date,
      },
    }, actor))
    results.push({ ...result, department: d.department })
  }
  return { day_no: plan.day_no!, report_date: plan.report_date!, results, warnings: plan.warnings, issued_versions: plan.issued_versions }
}

// ---------------------------------------------------------------- the upload itself

/** The workbook and the form fields of a multipart upload, with the size checked before it is read. */
export async function readUpload(req: Request): Promise<{ upload: Upload; fields: Record<string, string> }> {
  const length = Number(req.headers.get("content-length") ?? "0")
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new AppError(413, `The file is larger than ${MAX_UPLOAD_BYTES / 1048576} MB.`)
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    throw new AppError(400, "The upload could not be read.")
  }
  const file = form.get("file")
  if (!file || typeof file === "string") throw new AppError(400, "Choose the vessel's workbook (.xlsx).")
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(413, `The file is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB.`)
  if (!file.size) throw new AppError(400, "The file is empty.")
  const fields: Record<string, string> = {}
  for (const key of ["reportDate", "receivedVia", "correctionReason"]) {
    const value = form.get(key)
    if (typeof value === "string" && value.length <= 600) fields[key] = value
  }
  return { upload: { data: Buffer.from(await file.arrayBuffer()), name: file.name }, fields }
}
