// Source reconciliation: vessel-submitted Log Abstract (LA) vs system-generated OVDLA.
// Match key: IMO + UTC date/time — the key OVD itself uses for event reports (Interface Description 3.13, Notes on
// GHG reporting, rows 6 and 20); Event is compared like any other column. The key is NOT assumed unique in the
// LA: groups with several records on either side are paired only where exactly one fully identical pairing
// exists; everything else stays "ambiguous". An LA row that shares its key with a LATER LA row is classified as
// superseded (OVD keeps the highest row number) — stated, not silently resolved. Neither file is assumed correct.

import { eq } from "./decimal"
import type { LogRecord } from "./records"
import { type ColumnMap, roleKey } from "./schema"
import type { Collector } from "./rules/common"
import { lineList } from "./rules/common"
import type { SourceRef, SourceTable } from "./types"
import { readDate, readNumber, readTime } from "./values"

export type FieldDifference = Readonly<{ column: string; submitted: string; system: string; kind: "value" | "format-only" }>
export type MatchedPair = Readonly<{ submitted: SourceRef; system: SourceRef; differences: readonly FieldDifference[] }>
export type UnmatchedClass = "excluded" | "no-timestamp" | "superseded" | "outside-period" | "after-other-last" | "before-other-first" | "missing"
export type Unmatched = Readonly<{ ref: SourceRef; classification: UnmatchedClass; nearMatch?: SourceRef; minutesApart?: number }>
export type AmbiguousGroup = Readonly<{ key: string; submitted: readonly SourceRef[]; system: readonly SourceRef[] }>

export type ReconciliationResult = Readonly<{
  keyDefinition: string
  commonColumns: readonly string[]
  submittedOnlyColumns: readonly string[]
  systemOnlyColumns: readonly string[]
  counts: Readonly<{
    submitted: number; system: number; matched: number; matchedIdentical: number; matchedWithDifferences: number
    matchedFormatOnly: number; submittedOnly: number; systemOnly: number; ambiguousSubmitted: number; ambiguousSystem: number
  }>
  matches: readonly MatchedPair[]
  submittedOnly: readonly Unmatched[]
  systemOnly: readonly Unmatched[]
  ambiguous: readonly AmbiguousGroup[]
  submittedRange: Readonly<{ firstMs: number; lastMs: number }> | null
  systemRange: Readonly<{ firstMs: number; lastMs: number }> | null
  systemMetadata: Readonly<Record<string, readonly string[]>>
}>

export const UNMATCHED_LABEL: Record<UnmatchedClass, string> = {
  excluded: "Excluded by the user",
  "no-timestamp": "Timestamp not interpretable (cannot be matched)",
  superseded: "Superseded by a later row with the same IMO and UTC minute (OVD keeps the highest row number)",
  "outside-period": "Dated outside the reporting period (anomalous timestamp)",
  "after-other-last": "After the other file's last record (possible processing cut-off — hypothesis)",
  "before-other-first": "Before the other file's first record",
  missing: "Within the other file's date range but not found",
}

type Side = Readonly<{ table: SourceTable; map: ColumnMap; records: readonly LogRecord[] }>

function keyOf(r: LogRecord): string | null {
  if (r.time.state !== "ok") return null
  return `${(r.imoRaw ?? "").trim()}|${r.time.ms}`
}

type ColumnPair = { header: string; a: number; b: number; role: string | null }

function commonColumns(a: Side, b: Side): { pairs: ColumnPair[]; onlyA: string[]; onlyB: string[] } {
  const norm = (h: string) => h.trim().toLowerCase()
  const bIndex = new Map(b.table.headers.map((h, i) => [norm(h), i]))
  const aNames = new Set(a.table.headers.map(norm))
  const pairs: ColumnPair[] = []
  a.table.headers.forEach((h, i) => {
    const j = bIndex.get(norm(h))
    if (j === undefined || h.trim() === "") return
    const ra = a.map.columns[i]?.role
    const rb = b.map.columns[j]?.role
    pairs.push({ header: h.trim(), a: i, b: j, role: ra && rb && roleKey(ra) === roleKey(rb) ? roleKey(ra) : null })
  })
  return {
    pairs,
    onlyA: a.table.headers.filter((h) => h.trim() !== "" && !bIndex.has(norm(h))),
    onlyB: b.table.headers.filter((h) => h.trim() !== "" && !aNames.has(norm(h))),
  }
}

function compareCell(pair: ColumnPair, a: Side, ra: LogRecord, b: Side, rb: LogRecord): FieldDifference | null {
  const rowA = a.table.rows[ra.ref.index]
  const rowB = b.table.rows[rb.ref.index]
  const va = rowA.cells[pair.a] ?? ""
  const vb = rowB.cells[pair.b] ?? ""
  if (va === vb) return null
  const metaA = { type: rowA.types?.[pair.a], dateFormatted: rowA.dateFormatted?.[pair.a] }
  const metaB = { type: rowB.types?.[pair.b], dateFormatted: rowB.dateFormatted?.[pair.b] }
  const fmt = (kind: FieldDifference["kind"]): FieldDifference => ({ column: pair.header, submitted: va, system: vb, kind })
  if (va.trim() === vb.trim()) return fmt("format-only")
  if (pair.role === "date") {
    const da = readDate(va, metaA, a.table.meta.date1904)
    const db = readDate(vb, metaB, b.table.meta.date1904)
    if (da.ok === true && db.ok === true) return fmt(da.ms === db.ms ? "format-only" : "value")
  }
  if (pair.role === "time") {
    const ta = readTime(va, metaA)
    const tb = readTime(vb, metaB)
    if (ta.ok === true && tb.ok === true) return fmt(ta.ms === tb.ms ? "format-only" : "value")
  }
  const na = readNumber(va)
  const nb = readNumber(vb)
  if (na.state === "number" && nb.state === "number") return fmt(eq(na.value, nb.value) ? "format-only" : "value")
  return fmt("value")
}

function range(records: readonly LogRecord[]): { firstMs: number; lastMs: number } | null {
  let first = Infinity
  let last = -Infinity
  for (const r of records) {
    if (r.blank || r.excluded || r.time.state !== "ok") continue
    first = Math.min(first, r.time.ms)
    last = Math.max(last, r.time.ms)
  }
  return Number.isFinite(first) ? { firstMs: first, lastMs: last } : null
}

export function reconcile(
  submitted: Side,
  system: Side,
  options: { period: { fromMs: number; toMs: number } | null; nearMatchMinutes: number },
  c: Collector,
): ReconciliationResult {
  const { pairs, onlyA, onlyB } = commonColumns(submitted, system)
  const sRows = submitted.records.filter((r) => !r.blank)
  const yRows = system.records.filter((r) => !r.blank)
  const groups = new Map<string, { s: LogRecord[]; y: LogRecord[] }>()
  const sNoKey: LogRecord[] = []
  const yNoKey: LogRecord[] = []
  for (const r of sRows) {
    const k = keyOf(r)
    if (k === null) sNoKey.push(r)
    else (groups.get(k) ?? groups.set(k, { s: [], y: [] }).get(k)!).s.push(r)
  }
  for (const r of yRows) {
    const k = keyOf(r)
    if (k === null) yNoKey.push(r)
    else (groups.get(k) ?? groups.set(k, { s: [], y: [] }).get(k)!).y.push(r)
  }

  const differencesOf = (a: LogRecord, b: LogRecord) =>
    pairs.map((p) => compareCell(p, submitted, a, system, b)).filter((d): d is FieldDifference => d !== null)

  const matches: MatchedPair[] = []
  const ambiguous: AmbiguousGroup[] = []
  const sLeft: LogRecord[] = [...sNoKey]
  const yLeft: LogRecord[] = [...yNoKey]
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (g.s.length === 1 && g.y.length === 1) {
      matches.push({ submitted: g.s[0].ref, system: g.y[0].ref, differences: differencesOf(g.s[0], g.y[0]) })
      continue
    }
    if (g.s.length === 0) {
      yLeft.push(...g.y)
      continue
    }
    if (g.y.length === 0) {
      sLeft.push(...g.s)
      continue
    }
    // Several records share the key: pair only unique, fully equal (value-identical) counterparts.
    const equal = (a: LogRecord, b: LogRecord) => differencesOf(a, b).every((d) => d.kind === "format-only")
    const usedY = new Set<LogRecord>()
    const restS: LogRecord[] = []
    for (const a of g.s) {
      const candidates = g.y.filter((b) => !usedY.has(b) && equal(a, b))
      const rivals = candidates.length === 1 ? g.s.filter((other) => other !== a && equal(other, candidates[0])) : []
      if (candidates.length === 1 && rivals.length === 0) {
        usedY.add(candidates[0])
        matches.push({ submitted: a.ref, system: candidates[0].ref, differences: differencesOf(a, candidates[0]) })
      } else {
        restS.push(a)
      }
    }
    const restY = g.y.filter((b) => !usedY.has(b))
    if (restS.length && restY.length) ambiguous.push({ key, submitted: restS.map((r) => r.ref), system: restY.map((r) => r.ref) })
    else {
      sLeft.push(...restS)
      yLeft.push(...restY)
    }
  }

  const sRange = range(sRows)
  const yRange = range(yRows)
  const laterSameKey = (r: LogRecord, rows: readonly LogRecord[]) => {
    const k = keyOf(r)
    return k !== null && rows.some((o) => o !== r && keyOf(o) === k && o.ref.line > r.ref.line)
  }
  const classify = (r: LogRecord, other: { firstMs: number; lastMs: number } | null): UnmatchedClass => {
    if (r.excluded) return "excluded"
    if (r.time.state !== "ok") return "no-timestamp"
    if (laterSameKey(r, r.ref.kind === "OVDLA" ? yRows : sRows)) return "superseded"
    if (options.period && (r.time.ms < options.period.fromMs || r.time.ms > options.period.toMs)) return "outside-period"
    if (other && r.time.ms > other.lastMs) return "after-other-last"
    if (other && r.time.ms < other.firstMs) return "before-other-first"
    return "missing"
  }
  const near = (r: LogRecord, pool: readonly LogRecord[]) => {
    if (r.time.state !== "ok") return undefined
    let best: { ref: SourceRef; minutes: number } | undefined
    for (const o of pool) {
      if (o.time.state !== "ok" || (o.imoRaw ?? "").trim() !== (r.imoRaw ?? "").trim() || (o.eventRaw ?? "").trim().toLowerCase() !== (r.eventRaw ?? "").trim().toLowerCase()) continue
      const minutes = Math.abs(o.time.ms - r.time.ms) / 60_000
      if (minutes <= options.nearMatchMinutes && (!best || minutes < best.minutes)) best = { ref: o.ref, minutes }
    }
    return best
  }
  const toUnmatched = (r: LogRecord, otherRange: typeof sRange, pool: readonly LogRecord[]): Unmatched => {
    const n = near(r, pool)
    return { ref: r.ref, classification: classify(r, otherRange), ...(n ? { nearMatch: n.ref, minutesApart: Math.round(n.minutes) } : {}) }
  }
  const submittedOnly = sLeft.sort((a, b) => a.ref.index - b.ref.index).map((r) => toUnmatched(r, yRange, yLeft))
  const systemOnly = yLeft.sort((a, b) => a.ref.index - b.ref.index).map((r) => toUnmatched(r, sRange, sLeft))

  // Metadata of the system file (e.g. Last_Updated) to help explain cut-offs.
  const systemMetadata: Record<string, string[]> = {}
  for (const col of system.map.columns) {
    if (col.role?.kind !== "metadata") continue
    const values = new Set<string>()
    for (const r of yRows) {
      const v = (system.table.rows[r.ref.index].cells[col.index] ?? "").trim()
      if (v) values.add(v)
      if (values.size > 20) break
    }
    systemMetadata[col.header.trim()] = [...values]
  }

  const withValue = matches.filter((m) => m.differences.some((d) => d.kind === "value"))
  const formatOnly = matches.filter((m) => m.differences.length > 0 && m.differences.every((d) => d.kind === "format-only"))

  // Findings
  c.ran("R01", "LA vs OVDLA", sRows.length)
  c.ran("R02", "LA vs OVDLA", yRows.length)
  c.ran("R03", "LA vs OVDLA", matches.length)
  c.ran("R04", "LA vs OVDLA", groups.size)
  c.ran("R05", "LA vs OVDLA", matches.length)
  const byClass = (list: readonly Unmatched[]) => {
    const m = new Map<UnmatchedClass, Unmatched[]>()
    for (const u of list) m.set(u.classification, [...(m.get(u.classification) ?? []), u])
    return m
  }
  for (const [cls, list] of byClass(submittedOnly)) {
    c.add("R01", {
      key: ["LA", cls],
      severity: cls === "excluded" || cls === "superseded" ? "info" : undefined,
      evidence: cls === "after-other-last" ? "hypothesis" : cls === "superseded" ? "official-interface" : undefined,
      title: `${list.length} LA record(s) not in the OVDLA: ${UNMATCHED_LABEL[cls].toLowerCase()}`,
      detail: `LA lines ${lineList(list.map((u) => u.ref))}.` + (cls === "after-other-last" && yRange ? ` The OVDLA's last record is ${new Date(yRange.lastMs).toISOString().replace(".000Z", "Z")}.` : "") + (list.some((u) => u.nearMatch) ? ` ${list.filter((u) => u.nearMatch).length} have an OVDLA record with the same event within ${options.nearMatchMinutes} min.` : ""),
      refs: list.map((u) => u.ref),
    })
  }
  for (const [cls, list] of byClass(systemOnly)) {
    c.add("R02", {
      key: ["OVDLA", cls],
      severity: cls === "excluded" ? "info" : undefined,
      evidence: cls === "after-other-last" ? "hypothesis" : undefined,
      title: `${list.length} OVDLA record(s) not in the LA: ${UNMATCHED_LABEL[cls].toLowerCase()}`,
      detail: `OVDLA rows ${lineList(list.map((u) => u.ref))}.`,
      refs: list.map((u) => u.ref),
    })
  }
  const byColumn = (list: readonly MatchedPair[], kind: FieldDifference["kind"]) => {
    const m = new Map<string, MatchedPair[]>()
    for (const pair of list) for (const d of pair.differences) if (d.kind === kind) m.set(d.column, [...(m.get(d.column) ?? []), pair])
    return m
  }
  for (const [column, list] of byColumn(withValue, "value")) {
    const examples = list.slice(0, 5).map((p) => {
      const d = p.differences.find((x) => x.column === column)!
      return `LA line ${p.submitted.line} "${d.submitted}" vs OVDLA row ${p.system.line} "${d.system}"`
    })
    c.add("R03", {
      key: [column],
      title: `${column} differs on ${list.length} matched record(s)`,
      detail: examples.join("; ") + (list.length > 5 ? ` … ${list.length - 5} more` : "") + ". Neither value is assumed correct.",
      refs: list.flatMap((p) => [p.submitted, p.system]),
      columns: [column],
    })
  }
  for (const [column, list] of byColumn(formatOnly.concat(withValue), "format-only")) {
    c.add("R05", {
      key: [column],
      title: `${column} written differently on ${list.length} matched record(s)`,
      detail: `Values are equal but formatted differently, e.g. ${list.slice(0, 3).map((p) => { const d = p.differences.find((x) => x.column === column)!; return `"${d.submitted}" vs "${d.system}"` }).join(", ")}.`,
      refs: list.flatMap((p) => [p.submitted, p.system]),
      columns: [column],
    })
  }
  for (const g of ambiguous) {
    const highest = g.submitted.reduce((a, b) => (b.line > a.line ? b : a))
    c.add("R04", {
      key: [g.key],
      title: `Ambiguous match: ${g.submitted.length} LA and ${g.system.length} OVDLA record(s) share one IMO and UTC minute`,
      detail: `LA lines ${lineList(g.submitted)}; OVDLA rows ${lineList(g.system)}. They were not paired. Under OVD's rule DNV would keep LA line ${highest.line} (the highest row number), but the OVDLA does not match it exactly.`,
      refs: [...g.submitted, ...g.system],
    })
  }

  return {
    keyDefinition: "IMO + UTC date/time, the OVD event key (Notes on GHG reporting, rows 6 and 20); Event is compared as a field",
    commonColumns: pairs.map((p) => p.header),
    submittedOnlyColumns: onlyA,
    systemOnlyColumns: onlyB,
    counts: {
      submitted: sRows.length,
      system: yRows.length,
      matched: matches.length,
      matchedIdentical: matches.length - withValue.length - formatOnly.length,
      matchedWithDifferences: withValue.length,
      matchedFormatOnly: formatOnly.length,
      submittedOnly: submittedOnly.length,
      systemOnly: systemOnly.length,
      ambiguousSubmitted: ambiguous.reduce((n, g) => n + g.submitted.length, 0),
      ambiguousSystem: ambiguous.reduce((n, g) => n + g.system.length, 0),
    },
    matches,
    submittedOnly,
    systemOnly,
    ambiguous,
    submittedRange: sRange,
    systemRange: yRange,
    systemMetadata,
  }
}
