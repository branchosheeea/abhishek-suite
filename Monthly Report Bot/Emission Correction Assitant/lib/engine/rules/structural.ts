// Group A: structural validation. Reports what is malformed; never repairs it. Repeated problems are grouped
// per column or code (one finding listing every affected line) so a systematic issue stays readable.

import { abs, cmp, isNegative, isZero, parseDec } from "../decimal"
import { eventSpelling, seaPassageAlias } from "../events"
import { canonicalJson } from "../hash"
import type { BunkerDelivery, ValueCell } from "../records"
import type { ColumnMap } from "../schema"
import type { SourceRef, SourceTable } from "../types"
import { checkImo, type NumState } from "../values"
import { type BunkerSource, type Collector, kindLabel, lineList, type LogSource } from "./common"

type Hit = { ref: SourceRef; note?: string }

/** OVD clamps all numbers to ±10,000,000 (Notes on GHG reporting, row 85). */
const OVD_NUMBER_LIMIT = parseDec("10000000")!

function groupAdd(groups: Map<string, Hit[]>, key: string, hit: Hit) {
  const list = groups.get(key)
  if (list) list.push(hit)
  else groups.set(key, [hit])
}

function sample(hits: readonly Hit[], limit = 5): string {
  const shown = hits.slice(0, limit).map((h) => `line ${h.ref.line}${h.note ? `: ${h.note}` : ""}`)
  return shown.join("; ") + (hits.length > limit ? `; … ${hits.length - limit} more` : "")
}

function refForLine(table: SourceTable, line: number): SourceRef | null {
  const row = table.rows.find((r) => r.line === line)
  return row ? { sha256: table.sha256, kind: table.kind, line: row.line, index: row.index } : null
}

function headerChecks(table: SourceTable, map: ColumnMap, c: Collector) {
  const scope = kindLabel(table.kind)
  c.ran("A01", scope, 1)
  for (const missing of map.missingRequired) {
    c.add("A01", {
      key: [table.kind, missing],
      title: `${scope}: required column missing (${missing})`,
      detail: `No header in ${table.filename} maps to "${missing}". Rules that need it cannot run on this file.`,
      refs: [],
    })
  }
  c.ran("A09", scope, map.columns.length)
  const problems: string[] = []
  if (map.duplicateHeaders.length) problems.push(`duplicate headers: ${map.duplicateHeaders.join(", ")}`)
  if (map.whitespaceHeaders.length) problems.push(`headers with surrounding spaces: ${map.whitespaceHeaders.map((h) => JSON.stringify(h)).join(", ")}`)
  if (map.conflictingRoles.length) problems.push(`fields claimed by more than one column (none of them used): ${map.conflictingRoles.join("; ")}`)
  if (problems.length) {
    c.add("A09", { key: [table.kind, "header-problems"], title: `${scope}: header problems`, detail: problems.join(". ") + ".", refs: [] })
  }
  if (map.caseDifferences.length) {
    c.add("A09", {
      key: [table.kind, "case"],
      severity: "info",
      title: `${scope}: ${map.caseDifferences.length} header(s) differ from the documented spelling only in letter case`,
      detail: map.caseDifferences.map((d) => `${d.header} (documented: ${d.documented})`).join(", ") + ". They were mapped; DNV's own export also re-cases headers.",
      refs: [],
      columns: map.caseDifferences.map((d) => d.header),
    })
  }
  if (map.unmapped.length) {
    c.add("A09", {
      key: [table.kind, "unmapped"],
      severity: "info",
      title: `${scope}: ${map.unmapped.length} column(s) not in the interface description`,
      detail: `These headers match no documented field and are shown in the source viewer only: ${map.unmapped.join(", ")}.`,
      refs: [],
    })
  }
}

function parseIssueChecks(table: SourceTable, c: Collector) {
  const scope = kindLabel(table.kind)
  c.ran("A02", scope, table.rows.length)
  const byCode = new Map<string, typeof table.issues[number][]>()
  for (const issue of table.issues) byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue])
  for (const [code, issues] of byCode) {
    const refs = issues.map((i) => (i.line ? refForLine(table, i.line) : null)).filter((r): r is SourceRef => r !== null)
    const first = issues[0]
    c.add("A02", {
      key: [table.kind, code],
      severity: first.severity,
      title: `${scope}: ${issues.length === 1 ? first.message.replace(/^(Line|Row) \d+: /, "") : `${issues.length} × ${code.replace(/^\w+\./, "").replace(/-/g, " ")}`}`,
      detail: issues.length === 1 ? first.message : issues.slice(0, 8).map((i) => i.message).join(" ") + (issues.length > 8 ? ` … ${issues.length - 8} more.` : ""),
      refs,
    })
  }
}

type NumericCell = { ref: SourceRef; cell: ValueCell | null; label: string; allowNegative?: boolean }

function numericChecks(scope: string, kind: string, cells: NumericCell[], c: Collector) {
  const invalid = new Map<string, Hit[]>()
  const negative = new Map<string, Hit[]>()
  const padded = new Map<string, Hit[]>()
  const clamped = new Map<string, Hit[]>()
  let evaluated = 0
  for (const { ref, cell, label, allowNegative } of cells) {
    if (!cell) continue
    evaluated += 1
    const v: NumState = cell.value
    const key = `${cell.column}\u0000${label}`
    if (v.state === "invalid") groupAdd(invalid, key, { ref, note: `"${v.raw}" ${v.reason}` })
    else if (v.state === "number") {
      if (!allowNegative && isNegative(v.value)) groupAdd(negative, key, { ref, note: v.raw })
      if (v.trimmed) groupAdd(padded, key, { ref, note: JSON.stringify(v.raw) })
      if (cmp(abs(v.value), OVD_NUMBER_LIMIT) > 0) groupAdd(clamped, key, { ref, note: v.raw })
    }
  }
  c.ran("A05", scope, evaluated)
  c.ran("A06", scope, evaluated)
  for (const [key, hits] of invalid) {
    const [column, label] = key.split("\u0000")
    c.add("A05", { key: [kind, column, "invalid"], title: `${scope}: ${hits.length} value(s) in ${column} are not numbers`, detail: `${label}. ${sample(hits)}. These values are excluded from calculations, not read as zero.`, refs: hits.map((h) => h.ref), columns: [column] })
  }
  for (const [key, hits] of clamped) {
    const [column] = key.split("\u0000")
    c.add("A05", { key: [kind, column, "range"], title: `${scope}: ${hits.length} value(s) in ${column} exceed ±10,000,000`, detail: `OVD clamps numbers to ±10,000,000 (Notes on GHG reporting, row 85). ${sample(hits)}.`, refs: hits.map((h) => h.ref), columns: [column] })
  }
  for (const [key, hits] of padded) {
    const [column] = key.split("\u0000")
    c.add("A05", { key: [kind, column, "padded"], severity: "info", title: `${scope}: ${hits.length} value(s) in ${column} have surrounding spaces`, detail: `They were read as numbers after ignoring the spaces; the stored text is unchanged. ${sample(hits)}.`, refs: hits.map((h) => h.ref), columns: [column] })
  }
  for (const [key, hits] of negative) {
    const [column] = key.split("\u0000")
    c.add("A06", { key: [kind, column], title: `${scope}: ${hits.length} negative value(s) in ${column}`, detail: sample(hits) + ".", refs: hits.map((h) => h.ref), columns: [column] })
  }
}

const positive = (cell: ValueCell | null | undefined) => cell?.value.state === "number" && !isZero(cell.value.value) && !isNegative(cell.value.value)

export function runLogStructural(source: LogSource, sessionImo: string | null, c: Collector) {
  const { table, map, records } = source
  const scope = kindLabel(table.kind)
  headerChecks(table, map, c)
  parseIssueChecks(table, c)
  const rows = records.filter((r) => !r.blank)

  // A03 mandatory values, A10 timestamps
  const blanks = new Map<string, Hit[]>()
  const badTimes: Hit[] = []
  const imoColumn = map.columns.find((m) => m.role?.kind === "imo")
  const eventColumn = map.columns.find((m) => m.role?.kind === "event")
  for (const r of rows) {
    if (imoColumn && (r.imoRaw ?? "").trim() === "") groupAdd(blanks, imoColumn.header, { ref: r.ref })
    if (eventColumn && (r.eventRaw ?? "").trim() === "") groupAdd(blanks, eventColumn.header, { ref: r.ref })
    if (r.time.state === "blank") groupAdd(blanks, r.timeColumns.join(" / ") || "date/time", { ref: r.ref })
    if (r.time.state === "invalid" && r.timeColumns.length) badTimes.push({ ref: r.ref, note: r.time.reason })
  }
  c.ran("A03", scope, rows.length)
  for (const [column, hits] of blanks) {
    c.add("A03", { key: [table.kind, column], title: `${scope}: ${column} blank on ${hits.length} record(s)`, detail: `Lines ${lineList(hits.map((h) => h.ref))}.`, refs: hits.map((h) => h.ref), columns: column.split(" / ") })
  }
  if (rows.length && map.columns.some((m) => m.role?.kind === "date" || m.role?.kind === "datetime")) {
    c.ran("A10", scope, rows.length)
    if (badTimes.length) {
      c.add("A10", { key: [table.kind], title: `${scope}: ${badTimes.length} timestamp(s) could not be interpreted`, detail: `${sample(badTimes)}. These records are left out of chronology, duration and timeline calculations.`, refs: badTimes.map((h) => h.ref), columns: rows[0].timeColumns })
    }
  } else {
    c.notExecutable("A10", scope, "no date/time column identified")
  }

  // A04 IMO
  if (imoColumn) {
    const invalid = new Map<string, Hit[]>()
    const valid = new Map<string, SourceRef[]>()
    for (const r of rows) {
      const raw = r.imoRaw ?? ""
      if (raw.trim() === "") continue
      const check = checkImo(raw)
      if (check.valid) valid.set(check.imo, [...(valid.get(check.imo) ?? []), r.ref])
      else groupAdd(invalid, raw, { ref: r.ref, note: check.reason })
    }
    c.ran("A04", scope, rows.length)
    for (const [raw, hits] of invalid) {
      c.add("A04", { key: [table.kind, "invalid", raw], title: `${scope}: invalid IMO "${raw}" on ${hits.length} record(s)`, detail: `${hits[0].note}. Lines ${lineList(hits.map((h) => h.ref))}.`, refs: hits.map((h) => h.ref), columns: [imoColumn.header] })
    }
    if (valid.size > 1) {
      c.add("A04", { key: [table.kind, "several"], title: `${scope}: ${valid.size} different IMO numbers`, detail: [...valid.entries()].map(([imo, refs]) => `${imo} on ${refs.length} record(s)`).join("; ") + ".", refs: [...valid.values()].flat(), columns: [imoColumn.header] })
    }
    if (sessionImo) {
      const others = [...valid.entries()].filter(([imo]) => imo !== sessionImo)
      if (others.length) {
        c.add("A04", { key: [table.kind, "session", sessionImo], title: `${scope}: IMO differs from the session vessel (${sessionImo})`, detail: others.map(([imo, refs]) => `${imo} on ${refs.length} record(s)`).join("; ") + ".", refs: others.flatMap(([, refs]) => refs), columns: [imoColumn.header] })
      }
    }
  } else {
    c.notExecutable("A04", scope, "no IMO column identified")
  }

  // A05 / A06 numeric
  const numeric: NumericCell[] = []
  for (const r of rows) {
    numeric.push({ ref: r.ref, cell: r.duration, label: "Duration (hours)" }, { ref: r.ref, cell: r.distance, label: "Distance (nm)" }, { ref: r.ref, cell: r.cargo, label: "Cargo (mt)" })
    for (const [fuel, cell] of Object.entries(r.rob)) numeric.push({ ref: r.ref, cell, label: `ROB ${fuel}` })
    for (const [fuel, list] of Object.entries(r.consumption)) for (const cell of list) numeric.push({ ref: r.ref, cell, label: `${cell.consumer} consumption ${fuel}`, allowNegative: fuel === "LNG" })
    for (const [fuel, list] of Object.entries(r.allocations)) for (const cell of list) numeric.push({ ref: r.ref, cell, label: `${cell.purpose} ${fuel}` })
    for (const cell of r.bdnConsumption) numeric.push({ ref: r.ref, cell, label: "Consumption (BDN scheme)" })
  }
  numericChecks(scope, table.kind, numeric, c)

  // A07 exact duplicates (records sharing a timestamp are rule B02)
  if (rows.length) {
    c.ran("A07", scope, rows.length)
    const exact = new Map<string, SourceRef[]>()
    for (const r of rows) {
      const key = canonicalJson(table.rows[r.ref.index].cells)
      exact.set(key, [...(exact.get(key) ?? []), r.ref])
    }
    for (const refs of exact.values()) {
      if (refs.length > 1) c.add("A07", { key: [table.kind, "exact", refs.map((r) => r.line)], title: `${scope}: ${refs.length} identical records`, detail: `Lines ${lineList(refs)} are identical in every column. All are kept and shown; DNV keeps only the last of them (highest row number).`, refs })
    }
  }

  // A08 fixed event spelling
  if (eventColumn) {
    const near = new Map<string, Hit[]>()
    const aliases = new Map<string, Hit[]>()
    for (const r of rows) {
      const spelling = eventSpelling(r.eventRaw)
      if (spelling.fixed && !spelling.exact) groupAdd(near, `${r.eventRaw!.trim()}\u0000${spelling.documented}`, { ref: r.ref })
      else if (!spelling.fixed) {
        const alias = seaPassageAlias(r.eventRaw)
        if (alias) groupAdd(aliases, `${r.eventRaw!.trim()}\u0000${alias === "start" ? "BOSP" : "EOSP"}`, { ref: r.ref })
      }
    }
    c.ran("A08", scope, rows.length)
    for (const [key, hits] of near) {
      const [written, documented] = key.split("\u0000")
      c.add("A08", { key: [table.kind, written], title: `${scope}: event "${written}" should be spelled "${documented}" (${hits.length} record(s))`, detail: `Only the exact spelling is recognised by OVD voyage logic, so these records are not treated as ${documented}. Lines ${lineList(hits.map((h) => h.ref))}.`, refs: hits.map((h) => h.ref), columns: [eventColumn.header] })
    }
    for (const [key, hits] of aliases) {
      const [written, documented] = key.split("\u0000")
      c.add("A08", { key: [table.kind, "alias", written], severity: "info", title: `${scope}: "${written}" is not a documented OVD sea passage event (${hits.length} record(s))`, detail: `The documented spellings are BOSP/BeginOfSeaPassage/FAOP/FullAheadOnPassage and EOSP/EndOfSeaPassage. Rule C09 treats "${written}" as ${documented}; confirm DNV recognises it. Lines ${lineList(hits.map((h) => h.ref))}.`, refs: hits.map((h) => h.ref), columns: [eventColumn.header] })
    }
  } else {
    c.notExecutable("A08", scope, "no event column identified")
  }

  // A11 both consumption schemes on one record
  const hasFuelType = map.columns.some((m) => m.role?.kind === "consumption")
  const hasBdn = map.columns.some((m) => m.role?.kind === "bdnConsumption")
  if (hasFuelType && hasBdn) {
    const mixed: Hit[] = []
    for (const r of rows) {
      const fuelType = Object.values(r.consumption).flat().some((x) => positive(x))
      const bdn = r.bdnConsumption.some((x) => positive(x))
      if (fuelType && bdn) mixed.push({ ref: r.ref })
    }
    c.ran("A11", scope, rows.length)
    if (mixed.length) c.add("A11", { key: [table.kind], title: `${scope}: both consumption schemes used on ${mixed.length} record(s)`, detail: `Lines ${lineList(mixed.map((h) => h.ref))} report consumption by fuel type and by BDN. DNV adds all reported consumption to the total.`, refs: mixed.map((h) => h.ref) })
  } else {
    c.ran("A11", scope, rows.length)
  }

  // A12 duration required with distance or consumption
  const durationColumn = map.columns.find((m) => m.role?.kind === "durationHours")
  if (durationColumn) {
    const missing: Hit[] = []
    for (const r of rows) {
      if (r.duration?.value.state !== "blank") continue
      const reportsSomething = positive(r.distance) || Object.values(r.consumption).flat().some((x) => positive(x)) || r.bdnConsumption.some((x) => positive(x))
      if (reportsSomething) missing.push({ ref: r.ref })
    }
    c.ran("A12", scope, rows.length)
    if (missing.length) c.add("A12", { key: [table.kind], title: `${scope}: ${durationColumn.header} blank on ${missing.length} record(s) that report distance or consumption`, detail: `Lines ${lineList(missing.map((h) => h.ref))}.`, refs: missing.map((h) => h.ref), columns: [durationColumn.header] })
  } else {
    c.notExecutable("A12", scope, "no Time_Since_Previous_Report column identified")
  }
}

export function runBunkerStructural(source: BunkerSource, c: Collector) {
  const { table, map, deliveries } = source
  const scope = kindLabel(table.kind)
  headerChecks(table, map, c)
  parseIssueChecks(table, c)
  const blanks: Hit[] = []
  const badTimes: Hit[] = []
  const noFuel: Hit[] = []
  const unmappedFuel = new Map<string, Hit[]>()
  const debunker: Hit[] = []
  for (const d of deliveries) {
    if (d.time.state === "blank") blanks.push({ ref: d.ref })
    if (d.time.state === "invalid") badTimes.push({ ref: d.ref, note: d.time.reason })
    if (!d.fuelRaw) noFuel.push({ ref: d.ref })
    else if (!d.fuel) groupAdd(unmappedFuel, d.fuelRaw, { ref: d.ref })
    if (d.mass.value.state === "number" && isNegative(d.mass.value.value)) debunker.push({ ref: d.ref, note: d.mass.value.raw })
  }
  c.ran("A03", scope, deliveries.length)
  if (blanks.length) c.add("A03", { key: [table.kind, "time"], title: `${scope}: delivery date/time blank on ${blanks.length} record(s)`, detail: `Lines ${lineList(blanks.map((h) => h.ref))}. These deliveries cannot be placed in a reporting interval.`, refs: blanks.map((h) => h.ref) })
  if (noFuel.length) c.add("A03", { key: [table.kind, "fuel"], title: `${scope}: Fuel_Type blank on ${noFuel.length} record(s)`, detail: `Lines ${lineList(noFuel.map((h) => h.ref))}.`, refs: noFuel.map((h) => h.ref) })
  for (const [fuel, hits] of unmappedFuel) {
    c.add("A03", { key: [table.kind, "category", fuel], severity: "info", title: `${scope}: fuel type "${fuel}" has no Log Abstract fuel category (${hits.length} delivery/ies)`, detail: `The "Fuel types" sheet gives no fuel-type-scheme category for it, so these deliveries are not used in the fuel balances. Lines ${lineList(hits.map((h) => h.ref))}.`, refs: hits.map((h) => h.ref) })
  }
  if (debunker.length) c.add("A06", { key: [table.kind, "debunkering"], severity: "info", title: `${scope}: ${debunker.length} de-bunkering record(s) (negative mass)`, detail: `Negative mass is how OVD records de-bunkering (Notes on GHG reporting, row 17). ${sample(debunker)}.`, refs: debunker.map((h) => h.ref) })
  c.ran("A10", scope, deliveries.length)
  if (badTimes.length) c.add("A10", { key: [table.kind], title: `${scope}: ${badTimes.length} delivery timestamp(s) could not be interpreted`, detail: sample(badTimes) + ".", refs: badTimes.map((h) => h.ref) })
  numericChecks(scope, table.kind, deliveries.map((d: BunkerDelivery) => ({ ref: d.ref, cell: d.mass, label: `Bunkered mass${d.fuelRaw ? ` ${d.fuelRaw}` : ""}`, allowNegative: true })), c)
  if (map.columns.every((m) => m.role?.kind !== "bunkerMass" && m.role?.kind !== "bunkerByFuel")) {
    c.notExecutable("A05", scope, "no bunker quantity column identified")
  }
}
