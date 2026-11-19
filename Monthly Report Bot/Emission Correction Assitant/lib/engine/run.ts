// Validation orchestrator. Pure and deterministic: no clock, no randomness, no I/O. The same source tables,
// configuration, exclusions, DNV entries, schema and rule versions always produce the same result.

import { configHash, periodBounds, type ValidationConfig } from "./config"
import { correlate, type Correlation, type DnvFinding } from "./correlate"
import { reconcile, type ReconciliationResult } from "./reconcile"
import { buildBunkerDeliveries, buildLogRecords, type Exclusion } from "./records"
import { buildSequence, type BunkerSource, Collector, type LogSource, type RuleContext } from "./rules/common"
import { runChronology } from "./rules/chronology"
import { runConsumptionChecks, runFuel, type FuelAnalysis } from "./rules/fuel"
import { runCargo, runDistance, runDuration, runMoored, runVoyageDistance } from "./rules/movement"
import { RULE_SET_VERSION, RULES } from "./rules/registry"
import { runBunkerStructural, runLogStructural } from "./rules/structural"
import { reconstructSegments, runSeaPassage, runVoyage, type Segment } from "./rules/voyage"
import { type ColumnMap, DEFAULT_SCHEMA, mapHeaders, schemaById, type SchemaVersion } from "./schema"
import type { Finding, RuleCoverage, SourceKind, SourceTable } from "./types"

export const ENGINE_VERSION = "0.1.0"

export type ValidationInput = Readonly<{
  sources: Readonly<Partial<Record<SourceKind, SourceTable>>>
  config: ValidationConfig
  exclusions?: readonly Exclusion[]
  dnv?: readonly DnvFinding[]
  schemaId?: string
}>

export type ValidationResult = Readonly<{
  engineVersion: string
  ruleSetVersion: string
  schema: Readonly<{ id: string; ovdVersion: string; verified: boolean; note: string; source: string }>
  configHash: string
  inputs: readonly Readonly<{ kind: SourceKind; sha256: string; filename: string; rows: number; format: string }>[]
  coverage: Readonly<{
    sources: Readonly<Record<SourceKind, boolean>>
    rules: readonly RuleCoverage[]
    notes: readonly string[]
  }>
  maps: Readonly<Partial<Record<SourceKind, ColumnMap>>>
  findings: readonly Finding[]
  reconciliation: ReconciliationResult | null
  fuel: readonly FuelAnalysis[]
  segments: Readonly<Partial<Record<SourceKind, readonly Segment[]>>>
  correlations: readonly Correlation[]
  exclusions: readonly Readonly<Exclusion & { found: boolean }>[]
}>

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const

export function runValidation(input: ValidationInput): ValidationResult {
  const schema: SchemaVersion = (input.schemaId && schemaById(input.schemaId)) || DEFAULT_SCHEMA
  const config = input.config
  const exclusions = input.exclusions ?? []
  const period = periodBounds(config)
  const c = new Collector(schema.verified)
  const notes: string[] = []
  if (!schema.verified) notes.push(schema.note)

  const maps: Partial<Record<SourceKind, ColumnMap>> = {}
  const logs: Partial<Record<"LA" | "OVDLA", LogSource>> = {}
  for (const kind of ["LA", "OVDLA"] as const) {
    const table = input.sources[kind]
    if (!table) continue
    const map = mapHeaders(table.headers, kind, schema)
    maps[kind] = map
    logs[kind] = { table, map, records: buildLogRecords(table, map, exclusions) }
  }
  let bunkers: BunkerSource | null = null
  const br = input.sources.BR
  if (br) {
    const map = mapHeaders(br.headers, "BR", schema)
    maps.BR = map
    bunkers = { table: br, map, deliveries: buildBunkerDeliveries(br, map, exclusions) }
  }

  // Group A on every supplied source
  for (const kind of ["LA", "OVDLA"] as const) if (logs[kind]) runLogStructural(logs[kind]!, config.imo, c)
  if (bunkers) runBunkerStructural(bunkers, c)

  // Groups B–G on the selected log sources (LA by default; OVDLA when no LA is supplied)
  let targets = config.logSources.filter((k) => logs[k])
  if (targets.length === 0) {
    const fallback = (["LA", "OVDLA"] as const).filter((k) => logs[k])
    if (fallback.length) {
      targets = [fallback[0]]
      notes.push(`Record rules ran on the ${fallback[0]} because no ${config.logSources.join("/")} source was supplied.`)
    }
  }
  const fuel: FuelAnalysis[] = []
  const segments: Partial<Record<SourceKind, Segment[]>> = {}
  for (const kind of targets) {
    const log = logs[kind]!
    const sequence = buildSequence(log.records, config.sequenceBasis, period)
    const ctx: RuleContext = { config, schema, period, log, bunkers, sequence }
    runChronology(ctx, c)
    runVoyage(ctx, c)
    runSeaPassage(ctx, c)
    fuel.push(runFuel(ctx, c))
    runConsumptionChecks(ctx, c)
    runCargo(ctx, c)
    runDuration(ctx, c)
    runDistance(ctx, c)
    runMoored(ctx, c)
    runVoyageDistance(ctx, c)
    segments[kind] = reconstructSegments(sequence)
  }
  if (targets.length && config.sequenceBasis === "timeline") {
    notes.push("Voyage, fuel, cargo, duration and distance rules read the records in UTC-timestamp order within the reporting period, as OVD processes event reports; records dated outside the period are reported (B03) and not placed in the sequence. Rule B01 checks the submitted row order.")
  }
  if (targets.length === 0) notes.push("No Log Abstract or OVDLA was supplied, so the record rules (chronology, voyage, fuel, cargo, duration, distance) did not run.")

  let reconciliation: ReconciliationResult | null = null
  if (logs.LA && logs.OVDLA) {
    reconciliation = reconcile(logs.LA, logs.OVDLA, { period, nearMatchMinutes: config.nearMatchMinutes }, c)
  } else {
    for (const id of ["R01", "R02", "R03", "R04", "R05"]) c.notExecutable(id, "LA vs OVDLA", `needs both the LA and the OVDLA (${logs.LA ? "OVDLA" : "LA"} missing)`)
  }

  // Rules that never ran at all are listed as not executable, so coverage is complete.
  const seen = new Set(c.coverageList().map((x) => x.ruleId))
  for (const r of RULES) if (!seen.has(r.id)) c.notExecutable(r.id, "session", "required source not supplied")

  const findings = [...c.findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.group.localeCompare(b.group) ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.refs[0]?.kind ?? "").localeCompare(b.refs[0]?.kind ?? "") ||
      (a.refs[0]?.index ?? -1) - (b.refs[0]?.index ?? -1) ||
      a.id.localeCompare(b.id),
  )
  const coverage = c.coverageList()
  const correlations = correlate(input.dnv ?? [], findings, coverage, fuel, { bunkerReportSupplied: !!input.sources.BR })

  const allRefs = new Set(Object.values(input.sources).flatMap((t) => (t ? t.rows.map((r) => `${t.sha256}:${r.line}`) : [])))
  return {
    engineVersion: ENGINE_VERSION,
    ruleSetVersion: RULE_SET_VERSION,
    schema: { id: schema.id, ovdVersion: schema.ovdVersion, verified: schema.verified, note: schema.note, source: schema.source },
    configHash: configHash(config),
    inputs: (["LA", "BR", "OVDLA"] as const)
      .filter((k) => input.sources[k])
      .map((k) => ({ kind: k, sha256: input.sources[k]!.sha256, filename: input.sources[k]!.filename, rows: input.sources[k]!.rows.length, format: input.sources[k]!.format })),
    coverage: { sources: { LA: !!input.sources.LA, BR: !!input.sources.BR, OVDLA: !!input.sources.OVDLA }, rules: coverage, notes },
    maps,
    findings,
    reconciliation,
    fuel,
    segments,
    correlations,
    exclusions: exclusions.map((e) => ({ ...e, found: allRefs.has(`${e.sha256}:${e.line}`) })),
  }
}
