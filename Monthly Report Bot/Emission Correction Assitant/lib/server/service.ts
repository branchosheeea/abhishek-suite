// Orchestration used by the API routes. Depends only on the store interfaces, so it is tested with in-memory
// stores. The ONLY write that touches original files is SourceStore.register (initial ingestion). Everything else
// writes application-owned diagnostic records.

import { DEFAULT_CONFIG, parseConfig, type ValidationConfig } from "../engine/config"
import { DNV_CATEGORIES, type DnvCategory, type DnvFinding } from "../engine/correlate"
import { runValidation, type ValidationResult } from "../engine/run"
import { DEFAULT_SCHEMA, schemaById } from "../engine/schema"
import type { SourceKind, SourceTable } from "../engine/types"
import { checkImo } from "../engine/values"
import { checkUpload, parseSource } from "../parsers"
import { listSheets } from "../parsers/xlsx"
import {
  type AuditDoc, type DiagnosticStore, type DnvDoc, FINDING_STATUSES, type FindingStatus, type IntegrityCheck,
  type NoteDoc, type RunDoc, type SessionDoc,
} from "./diagnostics"
import { BadRequest, Conflict, IntegrityError, NotFound } from "./errors"
import { sha256, SHA256_PATTERN, type SourceArtifact, type SourceStore } from "./source-store"

export type Services = Readonly<{
  sources: SourceStore
  db: DiagnosticStore
  actor: () => string
  now: () => string
  id: () => string
}>

export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
export const FINDING_ID_PATTERN = /^[A-Z]\d{2}-[0-9a-f]{16}$/
const KINDS: readonly SourceKind[] = ["LA", "BR", "OVDLA"]

export function assertKind(kind: unknown): SourceKind {
  if (typeof kind !== "string" || !KINDS.includes(kind as SourceKind)) throw new BadRequest("kind must be LA, BR or OVDLA.")
  return kind as SourceKind
}

export async function audit(s: Services, action: string, detail: string, sessionId: string | null = null, target: string | null = null) {
  const entry: AuditDoc = { _id: s.id(), at: s.now(), actor: s.actor(), action, sessionId, target, detail }
  await s.db.audit.insert(entry)
}

// ── Sources ──────────────────────────────────────────────────────────────────

/** Parse first (rejecting anything malformed or unsafe), then register the untouched bytes. */
export async function registerSource(s: Services, bytes: Uint8Array, filename: string, kind: SourceKind) {
  const format = checkUpload(bytes, filename, kind)
  const before = sha256(bytes)
  const table = parseSource(bytes, kind, before, filename)
  if (sha256(bytes) !== before) throw new IntegrityError("The upload changed while it was being checked.")
  const { artifact, created } = await s.sources.register(bytes, { kind, filename, format, actor: s.actor(), now: s.now() })
  await audit(s, created ? "source.registered" : "source.duplicate", `${kind} ${filename} (${bytes.length} bytes, SHA-256 ${artifact._id})`, null, artifact._id)
  return { artifact, created, preview: { headers: table.headers, rows: table.rows.length, issues: table.issues.length } }
}

const tableCache = new Map<string, SourceTable>()

/** Read a registered source (hash-verified) and parse it. Parsed tables are frozen, so caching them is safe. */
export async function loadTable(s: Services, id: string, sheet?: string): Promise<{ artifact: SourceArtifact; table: SourceTable; sheets?: string[] }> {
  if (!SHA256_PATTERN.test(id)) throw new BadRequest("Invalid source id.")
  const { artifact, bytes } = await s.sources.read(id)
  const key = `${id}:${sheet ?? ""}`
  let table = tableCache.get(key)
  if (!table) {
    table = parseSource(bytes, artifact.kind, artifact._id, artifact.filename, sheet)
    if (tableCache.size > 50) tableCache.delete(tableCache.keys().next().value!)
    tableCache.set(key, table)
  }
  return { artifact, table, ...(artifact.format === "xlsx" ? { sheets: listSheets(bytes) } : {}) }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

function cleanText(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return ""
    throw new BadRequest(`${field} must be text.`)
  }
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  if (required && !text) throw new BadRequest(`${field} is required.`)
  if (text.length > max) throw new BadRequest(`${field} is longer than ${max} characters.`)
  return text
}

function cleanImo(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string") throw new BadRequest("IMO must be text.")
  const check = checkImo(value)
  if (!check.valid) throw new BadRequest(`IMO ${check.reason}.`)
  return check.imo
}

export async function createSession(s: Services, input: { title?: unknown; vessel?: unknown; imo?: unknown; period?: unknown }) {
  const vessel = cleanText(input.vessel, "Vessel", 80)
  const imo = cleanImo(input.imo)
  const config = parseConfig({ ...DEFAULT_CONFIG, imo, period: input.period ?? null })
  const now = s.now()
  const title = cleanText(input.title, "Title", 120, false) || `${vessel}${config.period ? ` ${config.period.from} – ${config.period.to}` : ""}`
  const doc: SessionDoc = {
    _id: s.id(), title, vessel, imo, schemaId: DEFAULT_SCHEMA.id, config, sources: {}, ovdlaSheet: null,
    exclusions: [], createdAt: now, createdBy: s.actor(), updatedAt: now,
  }
  await s.db.sessions.insert(doc)
  await audit(s, "session.created", `${title} (${vessel}${imo ? `, IMO ${imo}` : ""})`, doc._id)
  return doc
}

export async function getSession(s: Services, id: string) {
  if (!ID_PATTERN.test(id)) throw new BadRequest("Invalid session id.")
  const doc = await s.db.sessions.get(id)
  if (!doc) throw new NotFound("Session not found")
  return doc
}

export type SessionPatch = {
  title?: unknown
  vessel?: unknown
  imo?: unknown
  config?: unknown
  attach?: { kind?: unknown; sha256?: unknown }
  detach?: unknown
  ovdlaSheet?: unknown
  exclude?: { sha256?: unknown; line?: unknown; reason?: unknown }
  include?: { sha256?: unknown; line?: unknown }
}

/** Changes the SESSION record only (which sources it uses, settings, exclusions). Never a source file. */
export async function updateSession(s: Services, id: string, patch: SessionPatch) {
  const session = await getSession(s, id)
  const next: SessionDoc = structuredClone(session)
  const changes: string[] = []
  if (patch.title !== undefined) {
    next.title = cleanText(patch.title, "Title", 120)
    changes.push(`title "${next.title}"`)
  }
  if (patch.vessel !== undefined) {
    next.vessel = cleanText(patch.vessel, "Vessel", 80)
    changes.push(`vessel ${next.vessel}`)
  }
  if (patch.imo !== undefined) {
    next.imo = cleanImo(patch.imo)
    next.config = parseConfig({ ...next.config, imo: next.imo })
    changes.push(`IMO ${next.imo ?? "cleared"}`)
  }
  if (patch.config !== undefined) {
    if (!patch.config || typeof patch.config !== "object") throw new BadRequest("config must be an object.")
    next.config = parseConfig({ ...next.config, ...(patch.config as object), imo: next.imo })
    changes.push("configuration")
  }
  if (patch.attach) {
    const kind = assertKind(patch.attach.kind)
    const sha = typeof patch.attach.sha256 === "string" ? patch.attach.sha256 : ""
    const artifact = await s.sources.get(sha)
    if (!artifact) throw new NotFound("Source not found")
    if (artifact.kind !== kind) throw new Conflict(`That file is registered as ${artifact.kind}, not ${kind}.`)
    next.sources[kind] = sha
    if (kind === "OVDLA") next.ovdlaSheet = null
    changes.push(`${kind} → ${artifact.filename} (${sha.slice(0, 12)}…)`)
  }
  if (patch.detach !== undefined) {
    const kind = assertKind(patch.detach)
    delete next.sources[kind]
    changes.push(`${kind} detached (the registered file itself is kept)`)
  }
  if (patch.ovdlaSheet !== undefined) {
    next.ovdlaSheet = patch.ovdlaSheet === null ? null : cleanText(patch.ovdlaSheet, "Sheet", 31)
    changes.push(`OVDLA sheet ${next.ovdlaSheet ?? "default"}`)
  }
  if (patch.exclude) {
    const sha = String(patch.exclude.sha256 ?? "")
    const line = Number(patch.exclude.line)
    const reason = cleanText(patch.exclude.reason, "Exclusion reason", 300)
    if (!Object.values(next.sources).includes(sha)) throw new BadRequest("Exclusions must refer to a source attached to this session.")
    if (!Number.isInteger(line) || line < 1) throw new BadRequest("line must be a positive whole number.")
    if (next.exclusions.some((e) => e.sha256 === sha && e.line === line)) throw new Conflict("That record is already excluded.")
    next.exclusions.push({ sha256: sha, line, reason, by: s.actor(), at: s.now() })
    changes.push(`excluded line ${line} of ${sha.slice(0, 12)}…: ${reason}`)
  }
  if (patch.include) {
    const sha = String(patch.include.sha256 ?? "")
    const line = Number(patch.include.line)
    const before = next.exclusions.length
    next.exclusions = next.exclusions.filter((e) => !(e.sha256 === sha && e.line === line))
    if (next.exclusions.length === before) throw new NotFound("Exclusion not found")
    changes.push(`re-included line ${line} of ${sha.slice(0, 12)}…`)
  }
  if (changes.length === 0) return session
  next.updatedAt = s.now()
  const { _id, ...rest } = next
  await s.db.sessions.update(_id, rest)
  await audit(s, "session.updated", changes.join("; "), id)
  return next
}

// ── Validation runs ──────────────────────────────────────────────────────────

async function checkIntegrity(s: Services, kind: SourceKind, id: string): Promise<{ check: IntegrityCheck; bytes?: Uint8Array; artifact?: SourceArtifact }> {
  try {
    const { artifact, bytes } = await s.sources.read(id)
    return { check: { kind, sha256: id, filename: artifact.filename, ok: true }, bytes, artifact }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error"
    return { check: { kind, sha256: id, filename: "", ok: false, detail } }
  }
}

export async function runSession(s: Services, sessionId: string): Promise<RunDoc> {
  const session = await getSession(s, sessionId)
  const kinds = KINDS.filter((k) => session.sources[k])
  if (kinds.length === 0) throw new BadRequest("Attach at least one source file before running the validation.")
  const dnvDocs = (await s.db.dnv.find({ sessionId })).filter((d) => !d.withdrawn)
  const schema = schemaById(session.schemaId) ?? DEFAULT_SCHEMA
  const run: RunDoc = {
    _id: s.id(), sessionId, state: "running", startedAt: s.now(), finishedAt: null, actor: s.actor(),
    engineVersion: "", ruleSetVersion: "", schemaId: schema.id, configHash: "", config: session.config,
    inputs: [], exclusions: session.exclusions.map(({ sha256: sha, line, reason }) => ({ sha256: sha, line, reason })),
    dnvIds: dnvDocs.map((d) => d.id), integrity: { before: [], after: [] }, summary: null, error: null, resultJson: null,
  }
  await s.db.runs.insert(run)
  await audit(s, "run.started", `Validation run ${run._id} on ${kinds.join(", ")}`, sessionId, run._id)

  const finish = async (patch: Partial<RunDoc>, action: string, detail: string) => {
    const done = { ...run, ...patch, finishedAt: s.now() }
    const { _id, ...rest } = done
    await s.db.runs.update(_id, rest)
    await audit(s, action, detail, sessionId, run._id)
    return done
  }

  try {
    // 1. Verify every source before use.
    const sources: Partial<Record<SourceKind, SourceTable>> = {}
    const before: IntegrityCheck[] = []
    for (const kind of kinds) {
      const { check, bytes, artifact } = await checkIntegrity(s, kind, session.sources[kind]!)
      before.push(check)
      if (!check.ok || !bytes || !artifact) continue
      sources[kind] = parseSource(bytes, kind, artifact._id, artifact.filename, kind === "OVDLA" ? session.ovdlaSheet ?? undefined : undefined)
      run.inputs.push({ kind, sha256: artifact._id, filename: artifact.filename })
    }
    if (before.some((c) => !c.ok)) {
      return await finish({ state: "integrity-failed", integrity: { before, after: [] }, error: before.filter((c) => !c.ok).map((c) => `${c.kind}: ${c.detail}`).join("; ") }, "run.integrity-failed", "A registered source failed its integrity check before validation; the run was stopped.")
    }

    // 2. Validate (pure, deterministic).
    const dnv: DnvFinding[] = dnvDocs.map(({ _id: _i, sessionId: _s, createdAt: _c, createdBy: _b, updatedAt: _u, withdrawn: _w, ...d }) => d)
    const result = runValidation({ sources, config: session.config, exclusions: run.exclusions, dnv, schemaId: schema.id })

    // 3. Verify every source again after use.
    const after: IntegrityCheck[] = []
    for (const kind of kinds) after.push((await checkIntegrity(s, kind, session.sources[kind]!)).check)
    if (after.some((c) => !c.ok)) {
      return await finish({ state: "integrity-failed", integrity: { before, after }, error: "A source failed its integrity check after validation. Results were withheld." }, "run.integrity-failed", "A registered source failed its integrity check after validation; results withheld.")
    }

    return await finish(
      {
        state: "completed", engineVersion: result.engineVersion, ruleSetVersion: result.ruleSetVersion, configHash: result.configHash,
        integrity: { before, after }, summary: summarise(result), resultJson: JSON.stringify(result),
      },
      "run.completed",
      `${result.findings.length} finding(s); sources verified before and after.`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error"
    return await finish({ state: "failed", error: message }, "run.failed", message)
  }
}

export function summarise(result: ValidationResult): Record<string, number> {
  const count = (pred: (f: ValidationResult["findings"][number]) => boolean) => result.findings.filter(pred).length
  return {
    findings: result.findings.length,
    errors: count((f) => f.severity === "error"),
    warnings: count((f) => f.severity === "warning"),
    info: count((f) => f.severity === "info"),
    fuel: count((f) => f.group === "D" && f.severity !== "info"),
    reconciliation: count((f) => f.group === "R" && f.severity !== "info"),
    hypotheses: count((f) => f.evidence === "hypothesis"),
    dnv: result.correlations.length,
    dnvReproduced: result.correlations.filter((c) => c.outcome === "independently-reproduced").length,
    dnvNotReproduced: result.correlations.filter((c) => c.outcome === "not-reproduced").length,
    dnvUnresolved: result.correlations.filter((c) => c.outcome === "unresolved").length,
    rulesNotExecutable: result.coverage.rules.filter((r) => r.status === "not-executable").length,
  }
}

export async function getRun(s: Services, sessionId: string, runId: string) {
  if (!ID_PATTERN.test(runId)) throw new BadRequest("Invalid run id.")
  const run = await s.db.runs.get(runId)
  if (!run || run.sessionId !== sessionId) throw new NotFound("Run not found")
  return run
}

export async function listRuns(s: Services, sessionId: string) {
  const runs = await s.db.runs.find({ sessionId }, { sort: "startedAt", descending: true, limit: 50 })
  return runs.map(({ resultJson: _r, ...rest }) => rest)
}

// ── DNV findings (entered or imported by the user) ──────────────────────────

function parseDnv(input: Record<string, unknown>, id: string): DnvFinding {
  const category = input.category as DnvCategory
  if (!(category in DNV_CATEGORIES)) throw new BadRequest("Unknown DNV category.")
  if (input.severity !== "error" && input.severity !== "warning") throw new BadRequest("severity must be error or warning.")
  const iso = (v: unknown, field: string) => {
    if (v === null || v === undefined || v === "") return null
    if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(v)) throw new BadRequest(`${field} must be a UTC date-time (YYYY-MM-DDTHH:MMZ).`)
    return v
  }
  const quantity = input.quantity === null || input.quantity === undefined || input.quantity === "" ? null : cleanText(input.quantity, "Quantity", 40)
  const method = input.entryMethod ?? "manual"
  if (method !== "manual" && method !== "import" && method !== "screenshot") throw new BadRequest("entryMethod must be manual, import or screenshot.")
  const ports = Array.isArray(input.portCodes) ? input.portCodes : typeof input.portCodes === "string" ? input.portCodes.split(/[,\s]+/) : []
  let evidence: DnvFinding["evidence"] = null
  if (input.evidence !== undefined && input.evidence !== null) {
    const e = input.evidence as Record<string, unknown>
    if (typeof e !== "object" || typeof e.sha256 !== "string" || !SHA256_PATTERN.test(e.sha256)) throw new BadRequest("evidence.sha256 must be a SHA-256 hex digest.")
    evidence = { sha256: e.sha256, name: cleanText(e.name, "Screenshot name", 200, false) || null, reader: cleanText(e.reader, "Reader", 200) }
  }
  return {
    id,
    category,
    severity: input.severity,
    description: cleanText(input.description, "Description", 2000),
    imo: cleanImo(input.imo),
    fromUtc: iso(input.fromUtc, "From"),
    toUtc: iso(input.toUtc, "To"),
    eventUtc: iso(input.eventUtc, "Event time"),
    voyageOrPortStay: cleanText(input.voyageOrPortStay, "Voyage / port stay", 200, false) || null,
    portCodes: ports.map((p) => cleanText(p, "Port code", 12)).filter(Boolean).slice(0, 20),
    fuel: cleanText(input.fuel, "Fuel", 20, false).toUpperCase() || null,
    quantity,
    entryMethod: method,
    // Manual entries are typed by the user from DNV's screen; screenshot/import entries need explicit confirmation.
    confirmed: method === "manual" ? input.confirmed !== false : input.confirmed === true,
    evidence,
  }
}

export const DNV_BATCH_LIMIT = 200

/** Adds several DNV entries (e.g. read from OVD Admin screenshots). All are validated before any is stored. */
export async function addDnvBatch(s: Services, sessionId: string, items: unknown) {
  await getSession(s, sessionId)
  if (!Array.isArray(items) || items.length === 0) throw new BadRequest("items must be a non-empty list.")
  if (items.length > DNV_BATCH_LIMIT) throw new BadRequest(`At most ${DNV_BATCH_LIMIT} entries can be added at once.`)
  const parsed = items.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadRequest(`Entry ${i + 1} is not an object.`)
    try {
      return parseDnv(item as Record<string, unknown>, s.id())
    } catch (error) {
      throw error instanceof BadRequest ? new BadRequest(`Entry ${i + 1}: ${error.message}`) : error
    }
  })
  const now = s.now()
  const docs: DnvDoc[] = []
  for (const finding of parsed) {
    const doc: DnvDoc = { ...finding, _id: finding.id, sessionId, createdAt: now, createdBy: s.actor(), updatedAt: now, withdrawn: false }
    await s.db.dnv.insert(doc)
    await audit(s, "dnv.added", `${DNV_CATEGORIES[finding.category].label}: ${finding.description.slice(0, 120)}${finding.evidence ? ` [screenshot ${finding.evidence.sha256.slice(0, 12)}]` : ""}`, sessionId, finding.id)
    docs.push(doc)
  }
  return { added: docs.length, dnv: docs }
}

export async function addDnv(s: Services, sessionId: string, input: Record<string, unknown>) {
  await getSession(s, sessionId)
  const id = s.id()
  const finding = parseDnv(input, id)
  const now = s.now()
  const doc: DnvDoc = { ...finding, _id: id, sessionId, createdAt: now, createdBy: s.actor(), updatedAt: now, withdrawn: false }
  await s.db.dnv.insert(doc)
  await audit(s, "dnv.added", `${DNV_CATEGORIES[finding.category].label}: ${finding.description.slice(0, 120)}`, sessionId, id)
  return doc
}

export async function listDnv(s: Services, sessionId: string) {
  return s.db.dnv.find({ sessionId }, { sort: "createdAt" })
}

export async function updateDnv(s: Services, sessionId: string, dnvId: string, input: Record<string, unknown>) {
  if (!ID_PATTERN.test(dnvId)) throw new BadRequest("Invalid DNV id.")
  const existing = await s.db.dnv.get(dnvId)
  if (!existing || existing.sessionId !== sessionId) throw new NotFound("DNV entry not found")
  let patch: Partial<DnvDoc>
  let action: string
  if (input.action === "confirm") {
    patch = { confirmed: true }
    action = "dnv.confirmed"
  } else if (input.action === "withdraw") {
    patch = { withdrawn: true }
    action = "dnv.withdrawn"
  } else {
    const parsed = parseDnv({ ...existing, ...input, entryMethod: existing.entryMethod, confirmed: input.confirmed ?? existing.confirmed }, dnvId)
    patch = parsed
    action = "dnv.edited"
  }
  await s.db.dnv.update(dnvId, { ...patch, updatedAt: s.now() })
  await audit(s, action, `DNV entry ${dnvId}`, sessionId, dnvId)
  return { ...existing, ...patch }
}

// ── Investigation (statuses, notes, links) ──────────────────────────────────

export async function setFindingStatus(s: Services, sessionId: string, findingId: string, status: unknown) {
  await getSession(s, sessionId)
  if (!FINDING_ID_PATTERN.test(findingId)) throw new BadRequest("Invalid finding id.")
  if (!FINDING_STATUSES.includes(status as FindingStatus)) throw new BadRequest(`status must be one of: ${FINDING_STATUSES.join(", ")}.`)
  const key = `${sessionId}:${findingId}`
  const existing = await s.db.statuses.get(key)
  const now = s.now()
  if (existing) await s.db.statuses.update(key, { status: status as FindingStatus, updatedAt: now, updatedBy: s.actor() })
  else await s.db.statuses.insert({ _id: key, sessionId, findingId, status: status as FindingStatus, updatedAt: now, updatedBy: s.actor() })
  await s.db.statusHistory.insert({ _id: s.id(), sessionId, findingId, from: existing?.status ?? null, to: status as FindingStatus, at: now, by: s.actor() })
  await audit(s, "finding.status", `${findingId}: ${existing?.status ?? "New"} → ${status}`, sessionId, findingId)
  return { findingId, status }
}

export async function addNote(s: Services, sessionId: string, input: { findingId?: unknown; text?: unknown }) {
  await getSession(s, sessionId)
  const findingId = input.findingId === undefined || input.findingId === null || input.findingId === "" ? null : String(input.findingId)
  if (findingId && !FINDING_ID_PATTERN.test(findingId)) throw new BadRequest("Invalid finding id.")
  const doc: NoteDoc = { _id: s.id(), sessionId, findingId, text: cleanText(input.text, "Note", 5000), createdAt: s.now(), createdBy: s.actor() }
  await s.db.notes.insert(doc)
  await audit(s, "note.added", `${findingId ?? "session"}: ${doc.text.slice(0, 80)}`, sessionId, findingId)
  return doc
}

export async function linkFindings(s: Services, sessionId: string, input: { a?: unknown; b?: unknown; reason?: unknown }) {
  await getSession(s, sessionId)
  const a = String(input.a ?? "")
  const b = String(input.b ?? "")
  if (!FINDING_ID_PATTERN.test(a) || !FINDING_ID_PATTERN.test(b) || a === b) throw new BadRequest("Two different finding ids are required.")
  const doc = { _id: s.id(), sessionId, a, b, reason: cleanText(input.reason, "Evidence for the link", 1000), createdAt: s.now(), createdBy: s.actor() }
  await s.db.links.insert(doc)
  await audit(s, "finding.linked", `${a} ↔ ${b}: ${doc.reason.slice(0, 80)}`, sessionId, a)
  return doc
}

export async function investigation(s: Services, sessionId: string) {
  const [statuses, history, notes, links] = await Promise.all([
    s.db.statuses.find({ sessionId }),
    s.db.statusHistory.find({ sessionId }, { sort: "at" }),
    s.db.notes.find({ sessionId }, { sort: "createdAt" }),
    s.db.links.find({ sessionId }, { sort: "createdAt" }),
  ])
  return { statuses, history, notes, links }
}

export async function listAudit(s: Services, sessionId: string) {
  return s.db.audit.find({ sessionId }, { sort: "at", descending: true, limit: 500 })
}
