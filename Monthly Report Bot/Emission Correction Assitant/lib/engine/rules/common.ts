// Shared machinery for rules: a collector that builds findings with deterministic ids and records coverage
// (which rules ran, on how many items, and which could not run and why).

import type { ValidationConfig } from "../config"
import { stableId } from "../hash"
import type { BunkerDelivery, LogRecord } from "../records"
import type { ColumnMap, SchemaVersion } from "../schema"
import type { Calculation, EvidenceClass, Finding, RuleCoverage, Severity, SourceRef, SourceTable } from "../types"
import { rule } from "./registry"

export type LogSource = Readonly<{ table: SourceTable; map: ColumnMap; records: readonly LogRecord[] }>
export type BunkerSource = Readonly<{ table: SourceTable; map: ColumnMap; deliveries: readonly BunkerDelivery[] }>

export type RuleContext = Readonly<{
  config: ValidationConfig
  schema: SchemaVersion
  period: Readonly<{ fromMs: number; toMs: number }> | null
  log: LogSource
  bunkers: BunkerSource | null
  /** Records the voyage, fuel, cargo, duration and distance rules read, in order (see config.sequenceBasis). */
  sequence: readonly LogRecord[]
}>

export type FindingInput = Readonly<{
  /** Distinguishes findings of the same rule on the same records (e.g. the fuel or column). */
  key: unknown
  title: string
  detail: string
  refs: readonly SourceRef[]
  columns?: readonly string[]
  fuel?: string
  window?: Readonly<{ fromMs: number; toMs: number }>
  calculation?: Calculation
  severity?: Severity
  evidence?: EvidenceClass
  recommendation?: string
  possibleCauses?: readonly string[]
}>

type MutableCoverage = { ruleId: string; ruleVersion: string; status: RuleCoverage["status"]; reason?: string; evaluated: number; findings: number; scopes: Set<string> }

export class Collector {
  readonly findings: Finding[] = []
  private readonly coverage = new Map<string, MutableCoverage>()
  private readonly schemaVerified: boolean

  constructor(schemaVerified: boolean) {
    this.schemaVerified = schemaVerified
  }

  private entry(ruleId: string): MutableCoverage {
    let c = this.coverage.get(ruleId)
    if (!c) {
      c = { ruleId, ruleVersion: rule(ruleId).version, status: "executed", evaluated: 0, findings: 0, scopes: new Set() }
      this.coverage.set(ruleId, c)
    }
    return c
  }

  /** Mark a rule as run on a scope (e.g. "LA"), counting the items it evaluated. */
  ran(ruleId: string, scope: string, evaluated: number) {
    const c = this.entry(ruleId)
    c.evaluated += evaluated
    c.scopes.add(scope)
  }

  notExecutable(ruleId: string, scope: string, reason: string) {
    const c = this.entry(ruleId)
    c.scopes.add(scope)
    const text = `${scope}: ${reason}`
    if (c.status === "executed" && c.evaluated === 0) c.status = "not-executable"
    else c.status = "partial"
    c.reason = c.reason ? `${c.reason}; ${text}` : text
  }

  partial(ruleId: string, scope: string, reason: string) {
    const c = this.entry(ruleId)
    c.scopes.add(scope)
    c.status = "partial"
    const text = `${scope}: ${reason}`
    c.reason = c.reason ? `${c.reason}; ${text}` : text
  }

  add(ruleId: string, input: FindingInput): Finding {
    const def = rule(ruleId)
    const refs = [...input.refs].sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index)
    const finding: Finding = {
      id: stableId(ruleId, [def.version, input.key, refs.map((r) => [r.sha256, r.line])]),
      ruleId,
      ruleVersion: def.version,
      group: def.group,
      severity: input.severity ?? def.severity,
      evidence: input.evidence ?? def.evidence,
      title: input.title,
      detail: input.detail,
      refs,
      ...(input.columns?.length ? { columns: input.columns } : {}),
      ...(input.fuel ? { fuel: input.fuel } : {}),
      ...(input.window ? { window: input.window } : {}),
      ...(input.calculation ? { calculation: input.calculation } : {}),
      recommendation: input.recommendation ?? def.recommendation,
      ...(input.possibleCauses?.length ? { possibleCauses: input.possibleCauses } : {}),
      schemaVerified: this.schemaVerified,
    }
    this.findings.push(finding)
    this.entry(ruleId).findings += 1
    return finding
  }

  coverageList(): RuleCoverage[] {
    return [...this.coverage.values()]
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
      .map(({ scopes: _scopes, ...c }) => c)
  }
}

export function lineList(refs: readonly SourceRef[], limit = 12): string {
  const lines = refs.map((r) => r.line)
  const shown = lines.slice(0, limit).join(", ")
  return lines.length > limit ? `${shown} and ${lines.length - limit} more` : shown
}

export function kindLabel(kind: string): string {
  return kind === "LA" ? "LA" : kind === "OVDLA" ? "OVDLA" : kind === "BR" ? "Bunker Report" : kind
}

/** Records in submitted order, excluding user exclusions and blank lines. */
export function activeRecords(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((r) => !r.excluded && !r.blank)
}

/**
 * The sequence the record rules read.
 * timeline: interpretable timestamps inside the period (when set), ordered by UTC time then row; of several rows
 *   with the same IMO and minute only the highest row is kept, as OVD does (Notes on GHG reporting, rows 6, 20).
 * submitted: the file's row order.
 */
export function buildSequence(records: readonly LogRecord[], basis: "timeline" | "submitted", period: { fromMs: number; toMs: number } | null): LogRecord[] {
  const active = activeRecords(records)
  if (basis === "submitted") return active
  const timed = active.filter((r) => r.time.state === "ok" && (!period || (r.time.ms >= period.fromMs && r.time.ms <= period.toMs)))
  const latest = new Map<string, LogRecord>()
  for (const r of timed) {
    const key = `${(r.imoRaw ?? "").trim()}|${(r.time as { ms: number }).ms}`
    const kept = latest.get(key)
    if (!kept || r.ref.line > kept.ref.line) latest.set(key, r)
  }
  return [...latest.values()].sort((a, b) => (a.time as { ms: number }).ms - (b.time as { ms: number }).ms || a.ref.index - b.ref.index)
}

/**
 * Records that sit between two sequence records in the FILE but are not in the sequence (dated outside the period,
 * timestamp not interpretable, or superseded). Used to state a hypothesis; nothing is moved or corrected.
 */
export function skippedBetween(ctx: RuleContext, a: LogRecord, b: LogRecord): LogRecord[] {
  if (ctx.config.sequenceBasis !== "timeline") return []
  const lo = Math.min(a.ref.index, b.ref.index)
  const hi = Math.max(a.ref.index, b.ref.index)
  if (hi - lo <= 1) return []
  const inSequence = new Set(ctx.sequence.map((r) => r.ref.index))
  return ctx.log.records.filter((r) => r.ref.index > lo && r.ref.index < hi && !inSequence.has(r.ref.index) && !r.excluded && !r.blank)
}

export function skippedCause(skipped: readonly LogRecord[]): string | null {
  if (skipped.length === 0) return null
  const parts = skipped.slice(0, 6).map((r) => `line ${r.ref.line} (${r.eventRaw?.trim() || "no event"}, ${r.time.state === "ok" ? r.time.iso.slice(0, 16).replace("T", " ") : "timestamp not interpretable"})`)
  return `In the file, ${parts.join(", ")}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""} sit between these records but are dated outside the reporting period or cannot be placed by time, so OVD does not see them here (hypothesis: mistyped year or time)`
}

export function at(record: LogRecord): string {
  return `line ${record.ref.line}${record.time.state === "ok" ? ` (${record.time.iso})` : ""}`
}
