// Application-owned diagnostic records: validation sessions, runs, DNV entries, finding statuses, notes, links,
// audit history and report metadata. These may be created and updated. They are stored apart from the original
// files, and nothing here can reach the source store: this module never names a source collection.

import type { Collection, Db, Filter } from "mongodb"
import type { ValidationConfig } from "../engine/config"
import type { DnvFinding } from "../engine/correlate"
import type { Exclusion } from "../engine/records"
import type { SourceKind } from "../engine/types"

export type SessionExclusion = Exclusion & Readonly<{ by: string; at: string }>

export type SessionDoc = {
  _id: string
  title: string
  vessel: string
  imo: string | null
  schemaId: string
  config: ValidationConfig
  sources: Partial<Record<SourceKind, string>>
  ovdlaSheet: string | null
  exclusions: SessionExclusion[]
  createdAt: string
  createdBy: string
  updatedAt: string
}

export type IntegrityCheck = Readonly<{ kind: SourceKind; sha256: string; filename: string; ok: boolean; detail?: string }>

export type RunState = "running" | "completed" | "failed" | "integrity-failed"

export type RunDoc = {
  _id: string
  sessionId: string
  state: RunState
  startedAt: string
  finishedAt: string | null
  actor: string
  engineVersion: string
  ruleSetVersion: string
  schemaId: string
  configHash: string
  config: ValidationConfig
  inputs: { kind: SourceKind; sha256: string; filename: string }[]
  exclusions: Exclusion[]
  dnvIds: string[]
  integrity: { before: IntegrityCheck[]; after: IntegrityCheck[] }
  summary: Record<string, number> | null
  error: string | null
  /** The full ValidationResult as JSON text (kept verbatim so a report reproduces exactly what was computed). */
  resultJson: string | null
}

export type DnvDoc = DnvFinding & { _id: string; sessionId: string; createdAt: string; createdBy: string; updatedAt: string; withdrawn: boolean }

export const FINDING_STATUSES = ["New", "Under Investigation", "Awaiting Vessel Clarification", "Reviewed", "Closed"] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export type StatusDoc = { _id: string; sessionId: string; findingId: string; status: FindingStatus; updatedAt: string; updatedBy: string }
export type StatusHistoryDoc = { _id: string; sessionId: string; findingId: string; from: FindingStatus | null; to: FindingStatus; at: string; by: string }
export type NoteDoc = { _id: string; sessionId: string; findingId: string | null; text: string; createdAt: string; createdBy: string }
export type LinkDoc = { _id: string; sessionId: string; a: string; b: string; reason: string; createdAt: string; createdBy: string }
export type AuditDoc = { _id: string; at: string; actor: string; action: string; sessionId: string | null; target: string | null; detail: string }
export type ReportFormat = "json" | "xlsx" | "findings-pdf" | "findings-xlsx"
export type ReportDoc = { _id: string; sessionId: string; runId: string; format: ReportFormat; sha256: string; bytes: number; createdAt: string; createdBy: string }

type Doc = { _id: string }

export interface Table<T extends Doc> {
  insert(doc: T): Promise<void>
  get(id: string): Promise<T | null>
  find(filter: Partial<T>, options?: { sort?: keyof T & string; descending?: boolean; limit?: number }): Promise<T[]>
  update(id: string, patch: Partial<T>): Promise<void>
}

export type DiagnosticStore = Readonly<{
  sessions: Table<SessionDoc>
  runs: Table<RunDoc>
  dnv: Table<DnvDoc>
  statuses: Table<StatusDoc>
  statusHistory: Table<StatusHistoryDoc>
  notes: Table<NoteDoc>
  links: Table<LinkDoc>
  audit: Table<AuditDoc>
  reports: Table<ReportDoc>
}>

export const DIAGNOSTIC_COLLECTIONS = Object.freeze({
  sessions: "sessions",
  runs: "runs",
  dnv: "dnv_findings",
  statuses: "finding_status",
  statusHistory: "finding_status_history",
  notes: "notes",
  links: "finding_links",
  audit: "audit",
  reports: "reports",
})

class MongoTable<T extends Doc> implements Table<T> {
  private readonly collection: () => Promise<Collection<T>>
  constructor(collection: () => Promise<Collection<T>>) {
    this.collection = collection
  }
  async insert(doc: T) {
    await (await this.collection()).insertOne(doc as never)
  }
  async get(id: string) {
    return ((await (await this.collection()).findOne({ _id: id } as Filter<T>)) as T | null) ?? null
  }
  async find(filter: Partial<T>, options: { sort?: keyof T & string; descending?: boolean; limit?: number } = {}) {
    let cursor = (await this.collection()).find(filter as Filter<T>)
    if (options.sort) cursor = cursor.sort({ [options.sort]: options.descending ? -1 : 1 })
    return (await cursor.limit(options.limit ?? 1000).toArray()) as T[]
  }
  async update(id: string, patch: Partial<T>) {
    await (await this.collection()).updateOne({ _id: id } as Filter<T>, { $set: patch as never })
  }
}

/** Insert-only wrapper: for audit, status history and report metadata, which are never edited. */
class AppendOnly<T extends Doc> implements Table<T> {
  private readonly inner: Table<T>
  constructor(inner: Table<T>) {
    this.inner = inner
  }
  insert(doc: T) {
    return this.inner.insert(doc)
  }
  get(id: string) {
    return this.inner.get(id)
  }
  find(filter: Partial<T>, options?: { sort?: keyof T & string; descending?: boolean; limit?: number }) {
    return this.inner.find(filter, options)
  }
  async update(): Promise<void> {
    throw new Error("This record type is append-only.")
  }
}

let indexesReady: Promise<unknown> | undefined

export function mongoDiagnostics(db: () => Promise<Db>): DiagnosticStore {
  const ready = async () => {
    const d = await db()
    indexesReady ??= Promise.all([
      d.collection(DIAGNOSTIC_COLLECTIONS.sessions).createIndex({ updatedAt: -1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.runs).createIndex({ sessionId: 1, startedAt: -1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.dnv).createIndex({ sessionId: 1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.statuses).createIndex({ sessionId: 1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.statusHistory).createIndex({ sessionId: 1, at: 1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.notes).createIndex({ sessionId: 1, createdAt: 1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.links).createIndex({ sessionId: 1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.audit).createIndex({ sessionId: 1, at: -1 }),
      d.collection(DIAGNOSTIC_COLLECTIONS.reports).createIndex({ sessionId: 1, createdAt: -1 }),
    ]).catch((error) => {
      indexesReady = undefined
      throw error
    })
    await indexesReady
    return d
  }
  const table = <T extends Doc>(name: string) => new MongoTable<T>(async () => (await ready()).collection<T>(name))
  return {
    sessions: table<SessionDoc>(DIAGNOSTIC_COLLECTIONS.sessions),
    runs: table<RunDoc>(DIAGNOSTIC_COLLECTIONS.runs),
    dnv: table<DnvDoc>(DIAGNOSTIC_COLLECTIONS.dnv),
    statuses: table<StatusDoc>(DIAGNOSTIC_COLLECTIONS.statuses),
    statusHistory: new AppendOnly(table<StatusHistoryDoc>(DIAGNOSTIC_COLLECTIONS.statusHistory)),
    notes: new AppendOnly(table<NoteDoc>(DIAGNOSTIC_COLLECTIONS.notes)),
    links: new AppendOnly(table<LinkDoc>(DIAGNOSTIC_COLLECTIONS.links)),
    audit: new AppendOnly(table<AuditDoc>(DIAGNOSTIC_COLLECTIONS.audit)),
    reports: new AppendOnly(table<ReportDoc>(DIAGNOSTIC_COLLECTIONS.reports)),
  }
}

class MemoryTable<T extends Doc> implements Table<T> {
  private readonly rows = new Map<string, T>()
  async insert(doc: T) {
    if (this.rows.has(doc._id)) throw new Error(`duplicate _id ${doc._id}`)
    this.rows.set(doc._id, structuredClone(doc))
  }
  async get(id: string) {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : null
  }
  async find(filter: Partial<T>, options: { sort?: keyof T & string; descending?: boolean; limit?: number } = {}) {
    let rows = [...this.rows.values()].filter((r) => Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v))
    if (options.sort) {
      const key = options.sort
      rows = rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (options.descending ? -1 : 1))
    }
    return rows.slice(0, options.limit ?? 1000).map((r) => structuredClone(r))
  }
  async update(id: string, patch: Partial<T>) {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, ...structuredClone(patch) })
  }
}

export function memoryDiagnostics(): DiagnosticStore {
  return {
    sessions: new MemoryTable(),
    runs: new MemoryTable(),
    dnv: new MemoryTable(),
    statuses: new MemoryTable(),
    statusHistory: new AppendOnly(new MemoryTable()),
    notes: new AppendOnly(new MemoryTable()),
    links: new AppendOnly(new MemoryTable()),
    audit: new AppendOnly(new MemoryTable()),
    reports: new AppendOnly(new MemoryTable()),
  }
}
