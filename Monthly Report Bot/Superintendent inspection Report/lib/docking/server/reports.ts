// Digital Docking · the Daily Report to owners (D8: import → Superintendent's review → PDF → the Superintendent sends).
// One working draft per day, built from the vessel's entries and the previous day's report; the Superintendent edits it
// freely. Issuing freezes a version: its content, the email text and the PDF (stored under its hash) never change; a
// correction is a new version with a reason. NeraVeda never sends anything.

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AppError } from "../../server/errors"
import {
  DEFAULT_GREETING, DEFAULT_HEADER_LABELS, DEFAULT_SUMMARY, emailText, emptySections, issueProblems, longDate, MAX_PDF_BYTES, parseContent,
  REPORT_FORMAT, type ReportContent, type ReportContext, type ReportItem, reportPhotos, SECTION_KEYS, type SectionKey,
} from "../report/content"
import { buildReportPdf, type PdfPhoto } from "../report/pdf"
import { call, checkId, peopleNames } from "./api"

export { peopleNames }
import { type Store, tx } from "./db"
import { putFile, readStored } from "./files"
import { type Department, DockingError, getDocking } from "./repo"

const now = () => new Date().toISOString()
type Row = Record<string, unknown>

// ---------------------------------------------------------------- people (names instead of e-mail addresses)

const seen = new Map<string, string>()

/** Remember the name of a signed-in person (written only when it is new or changed). */
export function rememberPerson(store: Store, sub: string, name: string): void {
  const clean = name?.trim()
  if (!sub || !clean || seen.get(sub) === clean) return
  const row = store.db.prepare("SELECT name FROM people WHERE sub = ?").get(sub) as { name: string } | undefined
  if (row?.name !== clean) store.db.prepare("INSERT INTO people(sub, name, updated_at) VALUES(?,?,?) ON CONFLICT(sub) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at").run(sub, clean, now())
  seen.set(sub, clean)
}

// ---------------------------------------------------------------- the day and its entries

type DayRow = { id: string; day_no: number; report_date: string; state: string }

function dayOf(store: Store, dockingId: string, dayNoText: string): DayRow {
  if (!/^\d{1,3}$/.test(dayNoText)) throw new AppError(404, "This day does not exist.")
  call(() => getDocking(store, checkId(dockingId)))
  const day = store.db.prepare("SELECT id, day_no, report_date, state FROM days WHERE docking_id = ? AND day_no = ?").get(dockingId, Number(dayNoText)) as DayRow | undefined
  if (!day) throw new AppError(404, `Day ${Number(dayNoText)} has no report file or record yet, so there is nothing to report on.`)
  return { ...day }
}

type EntryRow = { id: string; department: Department; performed_by: string; area: string; company: string; work_text: string; findings: string }

function sectionFor(department: Department, performedBy: string): SectionKey {
  if (performedBy === "Service engineer") return "service"
  if (performedBy === "Class surveyor") return "class"
  return performedBy === "Yard staff" ? `${department}_yard` : `${department}_ship`
}

/** The report's items as the vessel wrote them: one item per entry with its photos (the staging register is left out). */
export function itemsFromEntries(store: Store, dayId: string): Record<SectionKey, ReportItem[]> {
  const entries = store.db.prepare(`SELECT a.id, s.department, a.performed_by, a.area, a.company, a.work_text, a.findings FROM activities a
    JOIN submissions s ON s.id = a.submission_id WHERE s.day_id = ? AND s.status = 'current' ORDER BY s.department, a.rowid`).all(dayId) as EntryRow[]
  const photos = store.db.prepare("SELECT id FROM photos WHERE activity_id = ? AND link_status = 'linked' ORDER BY slot")
  const sections = emptySections()
  for (const e of entries) {
    if (e.area === "Staging") continue
    const text = [e.work_text.trim(), e.findings.trim()].filter(Boolean).join(" ")
    sections[sectionFor(e.department, e.performed_by)].push({
      id: randomUUID(), text, company: e.company.trim(), photos: (photos.all(e.id) as { id: string }[]).map((p) => p.id), sources: [e.id],
    })
  }
  return sections
}

function previousReport(store: Store, dockingId: string, dayNo: number): { day_no: number; content: ReportContent } | null {
  const row = store.db.prepare(`SELECT d.day_no, r.content FROM daily_reports r JOIN days d ON d.id = r.day_id
    WHERE r.docking_id = ? AND d.day_no < ? ORDER BY d.day_no DESC LIMIT 1`).get(dockingId, dayNo) as { day_no: number; content: string } | undefined
  return row ? { day_no: row.day_no, content: JSON.parse(row.content) as ReportContent } : null
}

/** A new draft: header, greeting and carried events from the previous day's report (else from the docking), items from the vessel. */
export function draftFor(store: Store, dockingId: string, day: DayRow): ReportContent {
  const docking = getDocking(store, dockingId)
  const previous = previousReport(store, dockingId, day.day_no)
  const arrival = `${longDate(docking.day0_date)}${docking.arrival_time ? ` / ${docking.arrival_time.replace(":", "")} hrs` : ""} / Day 0`
  const defaults: Record<string, string> = {
    "Berth": "", "Vessel arrival shipyard": arrival, "ETD": docking.planned_departure_date ? longDate(docking.planned_departure_date) : "",
  }
  return {
    format: REPORT_FORMAT,
    greeting: previous?.content.greeting ?? DEFAULT_GREETING,
    summary: DEFAULT_SUMMARY,
    header: previous ? previous.content.header.map((h) => ({ ...h })) : DEFAULT_HEADER_LABELS.map((label) => ({ label, value: defaults[label] ?? "" })),
    events: (previous?.content.events ?? []).filter((e) => e.carry).map((e) => ({ ...e, id: randomUUID() })),
    sections: itemsFromEntries(store, day.id),
  }
}

// ---------------------------------------------------------------- reading

type ReportRow = { id: string; content: string; rev: number; created_by: string; created_at: string; updated_by: string; updated_at: string }
type VersionRow = { id: string; version: number; content: string; email_text: string; pdf_sha256: string; pdf_path: string; pdf_bytes: number; file_name: string; photos: number; reason: string; issued_by: string; issued_at: string }

function reportRow(store: Store, dayId: string): ReportRow | undefined {
  const row = store.db.prepare("SELECT id, content, rev, created_by, created_at, updated_by, updated_at FROM daily_reports WHERE day_id = ?").get(dayId) as ReportRow | undefined
  return row ? { ...row } : undefined
}

function versions(store: Store, dayId: string): VersionRow[] {
  return (store.db.prepare("SELECT * FROM report_versions WHERE day_id = ? ORDER BY version").all(dayId) as VersionRow[]).map((v) => ({ ...v }))
}

function issueBlocker(day: DayRow): string | null {
  if (day.state === "received") return `Mark Day ${day.day_no} as reviewed before issuing its report.`
  if (day.state !== "reviewed" && day.state !== "no_report") return `Day ${day.day_no} has no report file yet.`
  return null
}

function photoBytes(store: Store, ids: string[]): number {
  if (!ids.length) return 0
  const rows = store.db.prepare(`SELECT sha256, bytes FROM photos WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { sha256: string; bytes: number }[]
  return [...new Map(rows.map((r) => [r.sha256, Number(r.bytes)])).values()].reduce((a, b) => a + b, 0)
}

function newerFile(store: Store, dayId: string, row: ReportRow): { file_name: string; imported_at: string } | null {
  const rebuilt = store.db.prepare("SELECT MAX(at) AS at FROM audit WHERE action = 'report.rebuild' AND entity_id = ?").get(row.id) as { at: string | null }
  const built = rebuilt.at && rebuilt.at > row.created_at ? rebuilt.at : row.created_at
  const file = store.db.prepare(`SELECT file_name, imported_at FROM submissions WHERE day_id = ? AND status = 'current' AND imported_at > ?
    ORDER BY imported_at DESC LIMIT 1`).get(dayId, built) as { file_name: string; imported_at: string } | undefined
  return file ? { ...file } : null
}

/** The day's report: the working draft (if started), every issued version, and what stands in the way of issuing. */
export function reportView(store: Store, dockingId: string, dayNoText: string) {
  const day = dayOf(store, dockingId, dayNoText)
  const row = reportRow(store, day.id)
  const issued = versions(store, day.id)
  const last = issued.at(-1)
  const content = row ? (JSON.parse(row.content) as ReportContent) : null
  const previous = previousReport(store, dockingId, day.day_no)
  return {
    // a vessel file imported after the items were last built from the entries: the draft does not show it yet
    newer_file: row ? newerFile(store, day.id, row) : null,
    day: { id: day.id, day_no: day.day_no, report_date: day.report_date, state: day.state },
    report: row && content
      ? { id: row.id, rev: row.rev, content, created_by: row.created_by, created_at: row.created_at, updated_by: row.updated_by, updated_at: row.updated_at,
          changed_since_issue: last ? last.content !== row.content : null }
      : null,
    versions: issued.map((v) => ({ version: v.version, file_name: v.file_name, pdf_bytes: v.pdf_bytes, photos: v.photos, reason: v.reason, issued_by: v.issued_by, issued_at: v.issued_at, email_text: v.email_text })),
    carried_from_day: previous?.day_no ?? null,
    issue_blocker: issueBlocker(day),
    max_pdf_bytes: MAX_PDF_BYTES,
    photo_bytes: content ? photoBytes(store, reportPhotos(content)) : 0,
    people: peopleNames(store),
  }
}

// ---------------------------------------------------------------- changing the draft

function requireActor(actor: string) {
  if (!actor?.trim()) throw new DockingError("Every change needs the signed-in person.")
}

function audit(store: Store, actor: string, action: string, entityId: string, dockingId: string, after: unknown) {
  store.db.prepare("INSERT INTO audit(at, actor, action, entity, entity_id, docking_id, before, after) VALUES(?,?,?,?,?,?,?,?)")
    .run(now(), actor, action, "daily_report", entityId, dockingId, null, JSON.stringify(after ?? null))
}

/** Every photo and entry the report refers to must belong to this docking. */
function checkReferences(store: Store, dockingId: string, content: ReportContent) {
  const items = SECTION_KEYS.flatMap((k) => content.sections[k])
  const photos = [...new Set(items.flatMap((i) => i.photos))]
  const sources = [...new Set(items.flatMap((i) => i.sources))]
  const count = (table: string, ids: string[], extra = "") => ids.length
    ? Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE docking_id = ? ${extra} AND id IN (${ids.map(() => "?").join(",")})`).get(dockingId, ...ids) as { n: number }).n)
    : 0
  if (count("photos", photos, "AND stored_path IS NOT NULL") !== photos.length) throw new DockingError("The report refers to a photo that is not part of this docking. Reload the page.")
  if (count("activities", sources) !== sources.length) throw new DockingError("The report refers to a vessel entry that is not part of this docking. Reload the page.")
}

export function startReport(store: Store, dockingId: string, dayNoText: string, actor: string) {
  requireActor(actor)
  const day = dayOf(store, dockingId, dayNoText)
  call(() => tx(store.db, () => {
    if (reportRow(store, day.id)) throw new DockingError(`Day ${day.day_no} already has a report. Reload the page.`)
    const id = randomUUID()
    const stamp = now()
    const content = draftFor(store, dockingId, day)
    store.db.prepare("INSERT INTO daily_reports(id, docking_id, day_id, content, rev, created_by, created_at, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, dockingId, day.id, JSON.stringify(content), 1, actor, stamp, actor, stamp)
    const items = SECTION_KEYS.reduce((n, k) => n + content.sections[k].length, 0)
    audit(store, actor, "report.start", id, dockingId, { day: day.day_no, items, photos: reportPhotos(content).length })
  }))
  return reportView(store, dockingId, dayNoText)
}

function update(store: Store, dockingId: string, day: DayRow, rev: number, content: ReportContent, actor: string): { rev: number; updated_at: string } {
  const row = reportRow(store, day.id)
  if (!row) throw new DockingError(`Day ${day.day_no} has no report yet.`)
  if (row.rev !== rev) throw new DockingError("This report was changed in another window. Reload the page to see the latest version (your last change was not saved).")
  checkReferences(store, dockingId, content)
  const stamp = now()
  store.db.prepare("UPDATE daily_reports SET content = ?, rev = rev + 1, updated_by = ?, updated_at = ? WHERE id = ? AND rev = ?").run(JSON.stringify(content), actor, stamp, row.id, rev)
  return { rev: rev + 1, updated_at: stamp }
}

/** Save the draft (sent by the editor a moment after each change). Drafts are working copies: saves are not audited one by one. */
export function saveReport(store: Store, dockingId: string, dayNoText: string, rev: number, value: unknown, actor: string) {
  requireActor(actor)
  const day = dayOf(store, dockingId, dayNoText)
  let content: ReportContent
  try {
    content = parseContent(value)
  } catch (error) {
    throw new AppError(400, (error as Error).message)
  }
  const saved = call(() => tx(store.db, () => update(store, dockingId, day, rev, content, actor)))
  return { ...saved, photo_bytes: photoBytes(store, reportPhotos(content)) }
}

/** Build the items again from the vessel's current entries (e.g. after a corrected file); header, summary and events stay. */
export function rebuildItems(store: Store, dockingId: string, dayNoText: string, rev: number, actor: string) {
  requireActor(actor)
  const day = dayOf(store, dockingId, dayNoText)
  call(() => tx(store.db, () => {
    const row = reportRow(store, day.id)
    if (!row) throw new DockingError(`Day ${day.day_no} has no report yet.`)
    const content = { ...(JSON.parse(row.content) as ReportContent), sections: itemsFromEntries(store, day.id) }
    update(store, dockingId, day, rev, content, actor)
    audit(store, actor, "report.rebuild", row.id, dockingId, { day: day.day_no })
  }))
  return reportView(store, dockingId, dayNoText)
}

// ---------------------------------------------------------------- PDF and issuing

let logoCache: Buffer | null | undefined

function logo(): Buffer | null {
  if (logoCache !== undefined) return logoCache
  const path = join(process.cwd(), "public", "logo.png")
  logoCache = existsSync(path) ? readFileSync(path) : null
  return logoCache
}

function photoLoader(store: Store, dockingId: string) {
  const get = store.db.prepare("SELECT stored_path, sha256, format, width, height FROM photos WHERE id = ? AND docking_id = ?")
  return (id: string): PdfPhoto | null => {
    const row = get.get(id, dockingId) as { stored_path: string | null; sha256: string; format: string | null; width: number | null; height: number | null } | undefined
    if (!row?.stored_path) return null
    return { data: readStored(store, row.stored_path, row.sha256), format: row.format ?? "", width: row.width, height: row.height, sha256: row.sha256 }
  }
}

function localStamp(iso: string, offsetMinutes: number): string {
  const t = new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString()
  return `${longDate(t.slice(0, 10))} ${t.slice(11, 13)}${t.slice(14, 16)} LT`
}

function context(day: DayRow): ReportContext {
  return { dayNo: day.day_no, reportDate: day.report_date }
}

/** The working draft as a PDF, marked DRAFT on every page. */
export function previewPdf(store: Store, dockingId: string, dayNoText: string): { data: Buffer; file_name: string } {
  const day = dayOf(store, dockingId, dayNoText)
  const docking = getDocking(store, dockingId)
  const row = reportRow(store, day.id)
  if (!row) throw new AppError(404, `Day ${day.day_no} has no report yet.`)
  const data = buildReportPdf({ content: JSON.parse(row.content), context: context(day), docking, photo: photoLoader(store, dockingId), stamp: { draft: true }, logo: logo() })
  return { data, file_name: `DRAFT ${fileName(docking.vessel_name, day, 0)}` }
}

function fileName(vessel: string, day: DayRow, version: number): string {
  const d = new Date(`${day.report_date}T00:00:00Z`)
  const date = `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`
  return `${vessel} - Daily Report - Day ${String(day.day_no).padStart(2, "0")} - ${date}${version > 1 ? ` (v${version})` : ""}.pdf`.replace(/[\\/:*?"<>|]/g, "_")
}

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** Freeze the draft as the next version: content, email text and PDF are stored and never change. */
export function issueReport(store: Store, dockingId: string, dayNoText: string, rev: number, reason: string, actor: string, actorName: string) {
  requireActor(actor)
  const day = dayOf(store, dockingId, dayNoText)
  const docking = getDocking(store, dockingId)
  const blocker = issueBlocker(day)
  if (blocker) throw new AppError(400, blocker)
  const row = reportRow(store, day.id)
  if (!row) throw new AppError(400, `Day ${day.day_no} has no report yet.`)
  if (row.rev !== rev) throw new AppError(400, "This report was changed in another window. Reload the page before issuing.")
  const content = JSON.parse(row.content) as ReportContent
  const problems = issueProblems(content)
  if (problems.length) {
    throw new AppError(400, `Before issuing: ${problems.slice(0, 3).map((p) => `${p.where} ${p.message}`).join(" ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}`)
  }
  const earlier = versions(store, day.id)
  const last = earlier.at(-1)
  if (last && last.content === row.content) throw new AppError(400, `Nothing has changed since version ${last.version}.`)
  if (last && !reason.trim()) throw new AppError(400, `Version ${last.version} was already issued. Say what changed in version ${last.version + 1}.`)
  const version = (last?.version ?? 0) + 1
  const issuedAt = now()
  const ctx = context(day)
  const pdf = buildReportPdf({
    content, context: ctx, docking, photo: photoLoader(store, dockingId), logo: logo(),
    stamp: { draft: false, version, issuedBy: actorName.trim() || actor, issuedAt: localStamp(issuedAt, docking.utc_offset_minutes) },
  })
  if (pdf.length > MAX_PDF_BYTES) {
    throw new AppError(400, `The PDF would be ${MB(pdf.length)}, more than the ${MB(MAX_PDF_BYTES)} owners' mail allows. Remove some photos and issue again.`)
  }
  const file = putFile(store, "reports", pdf, "pdf")
  const name = fileName(docking.vessel_name, day, version)
  const photos = reportPhotos(content).length
  call(() => tx(store.db, () => {
    if (reportRow(store, day.id)?.rev !== rev) throw new DockingError("This report was changed in another window. Reload the page before issuing.")
    store.db.prepare(`INSERT INTO report_versions(id, report_id, docking_id, day_id, version, content, email_text, pdf_sha256, pdf_path, pdf_bytes, file_name, photos,
      reason, issued_by, issued_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), row.id, dockingId, day.id, version, row.content, emailText(content, ctx), file.sha256, file.path, pdf.length, name, photos, reason.trim(), actor, issuedAt)
    audit(store, actor, "report.issue", row.id, dockingId, { day: day.day_no, version, file: name, bytes: pdf.length, photos, reason: reason.trim() || undefined })
  }))
  return reportView(store, dockingId, dayNoText)
}

/** An issued version's PDF, checked against its hash. */
export function versionPdf(store: Store, dockingId: string, dayNoText: string, versionText: string): { data: Buffer; file_name: string } {
  const day = dayOf(store, dockingId, dayNoText)
  if (!/^\d{1,4}$/.test(versionText)) throw new AppError(404, "This version does not exist.")
  const row = store.db.prepare("SELECT pdf_path, pdf_sha256, file_name FROM report_versions WHERE day_id = ? AND version = ?").get(day.id, Number(versionText)) as
    { pdf_path: string; pdf_sha256: string; file_name: string } | undefined
  if (!row) throw new AppError(404, "This version does not exist.")
  return { data: readStored(store, row.pdf_path, row.pdf_sha256), file_name: row.file_name }
}

/** POST body of the report route: { action: "start" | "save" | "rebuild" | "issue", rev?, content?, reason? }. */
export function reportActionFrom(store: Store, dockingId: string, dayNoText: string, body: Row, actor: string, actorName: string) {
  const action = body.action
  const rev = body.rev
  const needRev = () => {
    if (typeof rev !== "number" || !Number.isInteger(rev)) throw new AppError(400, "Reload the page before changing the report.")
    return rev
  }
  if (action === "start") return startReport(store, dockingId, dayNoText, actor)
  if (action === "save") return saveReport(store, dockingId, dayNoText, needRev(), body.content, actor)
  if (action === "rebuild") return rebuildItems(store, dockingId, dayNoText, needRev(), actor)
  if (action === "issue") {
    const reason = body.reason ?? ""
    if (typeof reason !== "string" || reason.length > 500) throw new AppError(400, "The reason must be text of at most 500 characters.")
    return issueReport(store, dockingId, dayNoText, needRev(), reason, actor, actorName)
  }
  throw new AppError(400, "Action must be one of: start, save, rebuild, issue.")
}

/** Content-Disposition for a PDF download (the file name may hold any vessel name). */
export function pdfHeaders(fileName: string, inline: boolean): HeadersInit {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }
}
