// Group D: fuel reconciliation by mass balance, in exact decimal arithmetic.
//
//   Expected closing ROB = Opening ROB + Documented additions − Documented deductions − Reported consumption
//   Residual             = Reported closing ROB − Expected closing ROB
//
// Successive reports follow the submitted row order. A blank value is never read as zero: a blank or invalid ROB
// makes a step not computable; blank consumption fields are left out of the sum and the result is QUALIFIED.
// Consumption = ME + AE + Boiler + Inert_gas + Incinerator columns of the fuel. Cargo heating, DP and DPP
// cargo-pump columns are a portion of that total (OVD 3.13) and are never added.
// Documented additions/deductions = Bunker Report deliveries (negative mass = de-bunkering) whose Fuel_Type maps
// to the fuel category, inside the UTC interval. Transfers, sludge and ROB corrections are not available, and
// every calculation says so. A residual is a reconciliation finding, not proof that a report is wrong.

import { abs, add, cmp, type Dec, divide, fromInt, isNegative, isZero, max, mul, parseDec, sub, sum, toFixed, toString, ZERO } from "../decimal"
import { fuelsOf, type BunkerDelivery, type LogRecord } from "../records"
import type { CalculationInput, Finding, SourceRef } from "../types"
import { at, type Collector, kindLabel, type RuleContext, skippedBetween, skippedCause } from "./common"
import { reconstructSegments, type Segment } from "./voyage"

export type FuelStep = Readonly<{
  fuel: string
  position: number
  prev: SourceRef
  cur: SourceRef
  /** UTC interval of the step, when both timestamps are interpretable. */
  window?: Readonly<{ fromMs: number; toMs: number }>
  status: "computed" | "not-computable"
  reason?: string
  openingRob?: string
  bunkers?: string
  consumption?: string
  expected?: string
  closingRob?: string
  residual?: string
  qualified: boolean
  beyondTolerance: boolean
  findingId?: string
}>

export type SegmentBalance = Readonly<{
  fuel: string
  segment: Segment
  status: "computed" | "not-computable"
  reason?: string
  opening?: Readonly<{ ref: SourceRef; rob: string }>
  closing?: Readonly<{ ref: SourceRef; rob: string }>
  bunkers?: string
  consumption?: string
  expected?: string
  residual?: string
  records: number
  qualified: boolean
  beyondTolerance: boolean
  findingId?: string
}>

export type FuelAnalysis = Readonly<{
  source: string
  fuels: readonly string[]
  steps: readonly FuelStep[]
  segments: readonly SegmentBalance[]
  period: readonly SegmentBalance[]
}>

const STANDING_QUALIFICATION =
  "No internal transfer, sludge or ROB-correction records are available in the supplied data, so they are not included. They are not assumed to be zero in reality."

function causesFor(residual: Dec, hasBunkerReport: boolean): string[] {
  return isNegative(residual)
    ? [
        "Consumption under-reported, or booked against another fuel (hypothesis)",
        hasBunkerReport ? "De-bunkering, sludge disposal or a transfer not in the Bunker Report (hypothesis)" : "De-bunkering, sludge disposal or a transfer (no Bunker Report supplied) (hypothesis)",
        "ROB sounding or correction lowered the reported figure (hypothesis)",
      ]
    : [
        hasBunkerReport ? "A bunker delivery missing from the Bunker Report, or dated outside this interval (hypothesis)" : "A bunker delivery: no Bunker Report was supplied, so deliveries are not included (hypothesis)",
        "Consumption over-reported (hypothesis)",
        "ROB sounding or correction raised the reported figure (hypothesis)",
      ]
}

const HOUR = 3_600_000

type Interval = { fromMs: number; toMs: number }

function windowOf(a: LogRecord, b: LogRecord): Interval | undefined {
  return a.time.state === "ok" && b.time.state === "ok" ? { fromMs: Math.min(a.time.ms, b.time.ms), toMs: Math.max(a.time.ms, b.time.ms) } : undefined
}

export function runFuel(ctx: RuleContext, c: Collector): FuelAnalysis {
  const scope = kindLabel(ctx.log.table.kind)
  const active = ctx.sequence
  const robFuels = fuelsOf(active).filter((f) => active.some((r) => r.rob[f]))
  const empty: FuelAnalysis = { source: scope, fuels: [], steps: [], segments: [], period: [] }
  if (robFuels.length === 0 || active.length === 0) {
    for (const id of ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08"]) c.notExecutable(id, scope, "no fuel-type ROB columns identified")
    return empty
  }
  const tolerance = parseDec(ctx.config.fuelToleranceMt)!
  const deliveries: readonly BunkerDelivery[] | null = ctx.bunkers ? ctx.bunkers.deliveries.filter((d) => !d.excluded) : null
  if (!ctx.bunkers) {
    c.partial("D02", scope, "no Bunker Report supplied; bunkering and de-bunkering are not included and every balance is qualified")
    c.partial("D04", scope, "no Bunker Report supplied; bunkering and de-bunkering are not included and every balance is qualified")
    c.notExecutable("D05", scope, "no Bunker Report supplied")
  } else {
    const unmapped = deliveries!.filter((d) => !d.fuel).length
    if (unmapped) c.partial("D02", scope, `${unmapped} Bunker Report delivery/ies have a fuel type without a Log Abstract category and were not used`)
  }

  /** Documented deliveries of the fuel in (from, to]; null if the interval cannot be placed. */
  const bunkersIn = (fuel: string, a: LogRecord, b: LogRecord, qualifications: string[], inputs: CalculationInput[]): { total: Dec; refs: SourceRef[] } | null => {
    if (!deliveries) {
      qualifications.push("No Bunker Report was supplied, so any bunkering or de-bunkering in this interval is not included.")
      return { total: ZERO, refs: [] }
    }
    if (a.time.state !== "ok" || b.time.state !== "ok") {
      qualifications.push("A timestamp of this interval cannot be interpreted, so documented deliveries could not be placed in it.")
      return { total: ZERO, refs: [] }
    }
    if (b.time.ms < a.time.ms) {
      qualifications.push("The timestamps of this interval go backwards, so documented deliveries could not be placed in it.")
      return { total: ZERO, refs: [] }
    }
    let total = ZERO
    const refs: SourceRef[] = []
    for (const d of deliveries) {
      if (d.fuel !== fuel || d.time.state !== "ok" || d.time.ms <= a.time.ms || d.time.ms > b.time.ms) continue
      if (d.mass.value.state === "number") {
        total = add(total, d.mass.value.value)
        refs.push(d.ref)
        inputs.push({ label: `Bunker ${isNegative(d.mass.value.value) ? "de-bunkering" : "delivery"} ${d.fuelRaw ?? fuel}${d.bdn ? ` (BDN ${d.bdn})` : ""}`, value: d.mass.value.raw.trim(), ref: d.ref, column: d.mass.column })
      } else {
        qualifications.push(`The delivery at Bunker Report line ${d.ref.line} has no valid quantity and is not included.`)
      }
    }
    return { total, refs }
  }

  /** Σ consumption of the fuel on one record. null + reason when a value is invalid. */
  const consumptionOn = (r: LogRecord, fuel: string, qualifications: string[], inputs: CalculationInput[]): Dec | { invalid: string } => {
    const cells = r.consumption[fuel] ?? []
    const values: Dec[] = []
    const blanks: string[] = []
    for (const x of cells) {
      if (x.value.state === "invalid") return { invalid: `${x.column} "${x.value.raw}" invalid at line ${r.ref.line}` }
      if (x.value.state === "blank") blanks.push(x.column)
      else {
        values.push(x.value.value)
        if (!isZero(x.value.value)) inputs.push({ label: `${x.consumer.replace(/_/g, " ")} consumption ${fuel}`, value: x.value.raw.trim(), ref: r.ref, column: x.column })
      }
    }
    if (cells.length && blanks.length === cells.length) qualifications.push(`All ${cells.length} ${fuel} consumption fields at line ${r.ref.line} are blank ("not reported"); nothing is added for that record — blank is not a measured zero.`)
    else if (blanks.length) qualifications.push(`${blanks.length} of ${cells.length} ${fuel} consumption fields at line ${r.ref.line} are blank (${blanks.join(", ")}); they are left out of the sum, not read as zero.`)
    return sum(values)
  }

  // D01 opening ROB, D07 closing ROB (Notes on GHG reporting, row 16)
  const inPeriod = (r: LogRecord) => !ctx.period || (r.time.state === "ok" && r.time.ms >= ctx.period.fromMs && r.time.ms <= ctx.period.toMs)
  const periodRecords = active.filter(inPeriod)
  const usedFuels = robFuels.filter((fuel) => periodRecords.some((r) =>
    (r.rob[fuel]?.value.state === "number" && !isZero((r.rob[fuel].value as { value: Dec }).value)) ||
    (r.consumption[fuel] ?? []).some((x) => x.value.state === "number" && !isZero(x.value.value))))
  const first = periodRecords[0]
  const last = periodRecords[periodRecords.length - 1]
  c.ran("D01", scope, usedFuels.length)
  for (const [ruleId, record, word] of [["D01", first, "opening"], ["D07", last, "closing"]] as const) {
    if (!record) continue
    if (ruleId === "D07") {
      if (!ctx.period) {
        c.notExecutable("D07", scope, "no reporting period set for the session")
        continue
      }
      if (record.time.state !== "ok" || ctx.period.toMs - record.time.ms > 2 * 24 * HOUR) {
        c.notExecutable("D07", scope, `the data ends ${record.time.state === "ok" ? `on ${record.time.iso.slice(0, 10)}` : "with an uninterpretable timestamp"}, before the end of the reporting period`)
        continue
      }
      c.ran("D07", scope, usedFuels.length)
    }
    for (const fuel of usedFuels) {
      const v = record.rob[fuel]?.value
      if (v && v.state !== "number") {
        c.add(ruleId, {
          key: [scope, fuel],
          fuel,
          title: `${scope}: ${word} ${fuel} ROB missing at line ${record.ref.line}`,
          detail: `The ${ruleId === "D01" ? "first" : "last"} record of the reporting period (${at(record)}) has ${fuel} ROB ${v.state === "blank" ? "blank" : `"${v.raw}" (${v.reason})`}, while ${fuel} is reported in the period. OVD requires ROB at the beginning and end of the reporting period.`,
          refs: [record.ref],
          columns: [record.rob[fuel].column],
          window: record.time.state === "ok" ? { fromMs: record.time.ms, toMs: record.time.ms } : undefined,
        })
      }
    }
  }

  // D08 allocations (portion of total) must not exceed the total of the same fuel
  let allocationsEvaluated = 0
  const overAllocated = new Map<string, { ref: SourceRef; note: string; column: string }[]>()
  for (const r of active) {
    for (const [fuel, cells] of Object.entries(r.allocations)) {
      const total = sum((r.consumption[fuel] ?? []).flatMap((x) => (x.value.state === "number" ? [x.value.value] : [])))
      for (const cell of cells) {
        if (cell.value.state !== "number" || isZero(cell.value.value)) continue
        allocationsEvaluated += 1
        if (cmp(cell.value.value, total) > 0) {
          const key = `${fuel}\u0000${cell.purpose}`
          overAllocated.set(key, [...(overAllocated.get(key) ?? []), { ref: r.ref, note: `${cell.value.raw.trim()} > ${toString(total)}`, column: cell.column }])
        }
      }
    }
  }
  c.ran("D08", scope, allocationsEvaluated)
  for (const [key, hits] of overAllocated) {
    const [fuel, purpose] = key.split("\u0000")
    c.add("D08", {
      key: [scope, fuel, purpose],
      fuel,
      title: `${scope}: ${purpose} ${fuel} exceeds the total ${fuel} consumption on ${hits.length} record(s)`,
      detail: `${purpose} consumption is a portion of the total and must also be reported in ME/AE/Boiler/Inert gas consumption. ${hits.slice(0, 6).map((h) => `line ${h.ref.line}: ${h.note} mt`).join("; ")}${hits.length > 6 ? ` … ${hits.length - 6} more` : ""}.`,
      refs: hits.map((h) => h.ref),
      columns: [...new Set(hits.map((h) => h.column))],
    })
  }

  // D02 / D03 / D06 / D05 successive steps
  const steps: FuelStep[] = []
  for (const fuel of robFuels) {
    if ((active[0].consumption[fuel] ?? []).length === 0) {
      c.partial("D02", scope, `no consumption column for ${fuel}; its balance assumes nothing was consumed`)
    }
    const notComputable: { prev: LogRecord; cur: LogRecord; reason: string }[] = []
    c.ran("D02", scope, active.length - 1)
    c.ran("D03", scope, active.length - 1)
    c.ran("D06", scope, active.length - 1)
    for (let i = 1; i < active.length; i += 1) {
      const prev = active[i - 1]
      const cur = active[i]
      const robPrev = prev.rob[fuel]?.value
      const robCur = cur.rob[fuel]?.value
      const window = windowOf(prev, cur)
      const qualifications: string[] = []
      const inputs: CalculationInput[] = []
      const reasons: string[] = []
      if (!robPrev || robPrev.state !== "number") reasons.push(`opening ROB ${robPrev?.state === "invalid" ? `"${robPrev.raw}" invalid` : "blank"} at line ${prev.ref.line}`)
      if (!robCur || robCur.state !== "number") reasons.push(`closing ROB ${robCur?.state === "invalid" ? `"${robCur.raw}" invalid` : "blank"} at line ${cur.ref.line}`)
      const consumption = consumptionOn(cur, fuel, qualifications, inputs)
      if ("invalid" in consumption) reasons.push(consumption.invalid)
      if (reasons.length || robPrev?.state !== "number" || robCur?.state !== "number" || "invalid" in consumption) {
        notComputable.push({ prev, cur, reason: reasons.join("; ") })
        steps.push({ fuel, position: i, prev: prev.ref, cur: cur.ref, ...(window ? { window } : {}), status: "not-computable", reason: reasons.join("; "), qualified: false, beyondTolerance: false })
        continue
      }
      inputs.unshift(
        { label: `Opening ROB ${fuel}`, value: robPrev.raw.trim(), ref: prev.ref, column: prev.rob[fuel].column },
        { label: `Closing ROB ${fuel}`, value: robCur.raw.trim(), ref: cur.ref, column: cur.rob[fuel].column },
      )
      const bunkers = bunkersIn(fuel, prev, cur, qualifications, inputs)!
      const expected = sub(add(robPrev.value, bunkers.total), consumption)
      const residual = sub(robCur.value, expected)
      const beyond = cmp(abs(residual), tolerance) > 0
      const step: FuelStep = {
        fuel, position: i, prev: prev.ref, cur: cur.ref, ...(window ? { window } : {}), status: "computed",
        openingRob: toString(robPrev.value), bunkers: toString(bunkers.total), consumption: toString(consumption),
        expected: toString(expected), closingRob: toString(robCur.value), residual: toString(residual),
        qualified: qualifications.length > 0, beyondTolerance: beyond,
      }
      let findingId: string | undefined
      if (beyond) {
        const causes = causesFor(residual, !!deliveries)
        const skipped = skippedCause(skippedBetween(ctx, prev, cur))
        if (skipped) causes.unshift(skipped)
        let d05: { delivery: BunkerDelivery; distanceH: string } | null = null
        if (deliveries && window) {
          const prox = ctx.config.bunkerProximityHours * HOUR
          for (const d of deliveries) {
            if (d.fuel !== fuel || d.time.state !== "ok" || d.mass.value.state !== "number") continue
            const t = d.time.ms
            if ((t > window.fromMs && t <= window.toMs) || t < window.fromMs - prox || t > window.toMs + prox) continue
            const mass = abs(d.mass.value.value)
            if (cmp(abs(sub(abs(residual), mass)), max(tolerance, mul(mass, parseDec("0.02")!))) <= 0) {
              d05 = { delivery: d, distanceH: (t < window.fromMs ? (window.fromMs - t) / HOUR : (t - window.toMs) / HOUR).toFixed(1) }
              break
            }
          }
        }
        if (d05) causes.unshift(`A ${d05.delivery.fuelRaw ?? fuel} delivery of ${d05.delivery.mass.value.raw.trim()} mt (Bunker Report line ${d05.delivery.ref.line}) is dated ${d05.distanceH} h outside this interval (hypothesis: timing difference)`)
        const finding: Finding = c.add("D02", {
          key: [scope, fuel, prev.ref.line, cur.ref.line],
          fuel,
          title: `${scope}: ${fuel} residual ${toString(residual)} mt between lines ${prev.ref.line} and ${cur.ref.line}`,
          detail: `Reported ${fuel} ROB at ${at(cur)} is ${toString(robCur.value)} mt; the balance from ${at(prev)} gives ${toString(expected)} mt. Residual ${toString(residual)} mt exceeds the ${ctx.config.fuelToleranceMt} mt screening threshold.` + (qualifications.length ? " The result is qualified (see calculation)." : ""),
          refs: [prev.ref, cur.ref, ...bunkers.refs],
          columns: [cur.rob[fuel].column, ...(cur.consumption[fuel] ?? []).map((x) => x.column)],
          window,
          calculation: {
            formula: "Expected closing ROB = Opening ROB + Documented additions − Documented deductions − Reported consumption; Residual = Reported closing ROB − Expected",
            inputs,
            steps: [`Expected = ${toString(robPrev.value)} + (${toString(bunkers.total)}) − ${toString(consumption)} = ${toString(expected)} mt`, `Residual = ${toString(robCur.value)} − ${toString(expected)} = ${toString(residual)} mt`],
            result: `${toString(residual)} mt`,
            qualifications: [...qualifications, STANDING_QUALIFICATION],
          },
          possibleCauses: causes,
        })
        findingId = finding.id
        if (d05) {
          c.add("D05", {
            key: [scope, fuel, prev.ref.line, cur.ref.line, d05.delivery.ref.line],
            fuel,
            title: `${scope}: ${fuel} delivery near the residual at lines ${prev.ref.line}–${cur.ref.line}`,
            detail: `Bunker Report line ${d05.delivery.ref.line} (${d05.delivery.mass.value.raw.trim()} mt${d05.delivery.time.state === "ok" ? `, ${d05.delivery.time.iso}` : ""}) is ${d05.distanceH} h outside the interval and close in size to the residual of ${toString(residual)} mt. This is a hypothesis; the delivery has not been moved.`,
            refs: [prev.ref, cur.ref, d05.delivery.ref],
            window,
          })
        }
      }
      if (isNegative(expected)) {
        c.add("D06", {
          key: [scope, fuel, prev.ref.line, cur.ref.line],
          fuel,
          title: `${scope}: ${fuel} consumption exceeds available fuel at line ${cur.ref.line}`,
          detail: `Opening ROB ${toString(robPrev.value)} + documented bunkers ${toString(bunkers.total)} − consumption ${toString(consumption)} = ${toString(expected)} mt (negative).`,
          refs: [prev.ref, cur.ref, ...bunkers.refs],
          window,
          calculation: {
            formula: "Available = Opening ROB + Documented additions; Available − Reported consumption < 0",
            inputs,
            steps: [`${toString(robPrev.value)} + (${toString(bunkers.total)}) − ${toString(consumption)} = ${toString(expected)} mt`],
            result: `${toString(expected)} mt`,
            qualifications: [...qualifications, STANDING_QUALIFICATION],
          },
        })
      }
      steps.push(findingId ? { ...step, findingId } : step)
    }
    if (notComputable.length) {
      c.add("D03", {
        key: [scope, fuel],
        fuel,
        title: `${scope}: ${fuel} balance not computable for ${notComputable.length} step(s)`,
        detail: notComputable.slice(0, 8).map((n) => `lines ${n.prev.ref.line}→${n.cur.ref.line}: ${n.reason}`).join("; ") + (notComputable.length > 8 ? ` … ${notComputable.length - 8} more` : "") + ".",
        refs: [...new Map(notComputable.flatMap((n) => [n.prev.ref, n.cur.ref]).map((r) => [r.line, r])).values()],
      })
    }
  }

  // D04 port stays, voyages and the period: Opening ROB (first reported in the segment) + documented bunkers −
  // all consumption reported after it, up to the closing ROB (last reported in the segment).
  type Detail = { balance: SegmentBalance; qualifications: string[]; inputs: CalculationInput[]; bunkerRefs: SourceRef[] }
  const notComputable = (b: SegmentBalance): Detail => ({ balance: b, qualifications: [], inputs: [], bunkerRefs: [] })

  const balance = (fuel: string, segment: Segment): Detail => {
    let open = -1
    let close = -1
    for (let p = segment.start; p <= segment.end; p += 1) {
      if (active[p].rob[fuel]?.value.state === "number") {
        if (open < 0) open = p
        close = p
      }
    }
    const records = segment.end - segment.start + 1
    if (open < 0 || close <= open) {
      return notComputable({ fuel, segment, status: "not-computable", reason: open < 0 ? `no ${fuel} ROB reported in the segment` : `only one ${fuel} ROB reported in the segment`, records, qualified: false, beyondTolerance: false })
    }
    const qualifications: string[] = []
    const inputs: CalculationInput[] = []
    if (open !== segment.start) qualifications.push(`${fuel} ROB is not reported at the start of the segment (line ${active[segment.start].ref.line}); the balance opens at line ${active[open].ref.line}.`)
    if (close !== segment.end) qualifications.push(`${fuel} ROB is not reported at the end of the segment (line ${active[segment.end].ref.line}); the balance closes at line ${active[close].ref.line}.`)
    const consumed: Dec[] = []
    const blankRecords: number[] = []
    for (let p = open + 1; p <= close; p += 1) {
      const q: string[] = []
      const value = consumptionOn(active[p], fuel, q, inputs)
      if ("invalid" in value) return notComputable({ fuel, segment, status: "not-computable", reason: value.invalid, records, qualified: false, beyondTolerance: false })
      if (q.length) blankRecords.push(active[p].ref.line)
      consumed.push(value)
    }
    if (blankRecords.length) qualifications.push(`${fuel} consumption fields are blank on ${blankRecords.length} record(s) (lines ${blankRecords.slice(0, 10).join(", ")}${blankRecords.length > 10 ? " …" : ""}); blanks are left out of the sum, not read as zero.`)
    const consumption = sum(consumed)
    const opening = active[open].rob[fuel].value as { value: Dec; raw: string }
    const closing = active[close].rob[fuel].value as { value: Dec; raw: string }
    const bunkers = bunkersIn(fuel, active[open], active[close], qualifications, inputs)!
    const expected = sub(add(opening.value, bunkers.total), consumption)
    const residual = sub(closing.value, expected)
    return {
      balance: {
        fuel, segment, status: "computed",
        opening: { ref: active[open].ref, rob: toString(opening.value) }, closing: { ref: active[close].ref, rob: toString(closing.value) },
        bunkers: toString(bunkers.total), consumption: toString(consumption), expected: toString(expected), residual: toString(residual),
        records, qualified: qualifications.length > 0, beyondTolerance: cmp(abs(residual), tolerance) > 0,
      },
      qualifications,
      inputs,
      bunkerRefs: bunkers.refs,
    }
  }

  const report = ({ balance: b, qualifications, inputs, bunkerRefs }: Detail, label: string): SegmentBalance => {
    if (b.status !== "computed" || !b.beyondTolerance) return b
    const openRec = active.find((r) => r.ref === b.opening!.ref)!
    const closeRec = active.find((r) => r.ref === b.closing!.ref)!
    const residual = parseDec(b.residual!)!
    const finding = c.add("D04", {
      key: [scope, b.fuel, b.segment.type, b.opening!.ref.line, b.closing!.ref.line],
      fuel: b.fuel,
      title: `${scope}: ${b.fuel} residual ${b.residual} mt over the ${label}`,
      detail: `Opening ${b.fuel} ROB ${b.opening!.rob} mt (${at(openRec)}) + documented bunkers ${b.bunkers} − consumption ${b.consumption} = ${b.expected} mt expected; ${b.closing!.rob} mt reported (${at(closeRec)}). Residual ${b.residual} mt exceeds the ${ctx.config.fuelToleranceMt} mt screening threshold.` + (b.segment.closed || b.segment.type === "unknown" ? "" : " The segment is open-ended in the data."),
      refs: [b.opening!.ref, b.closing!.ref, ...bunkerRefs],
      columns: [closeRec.rob[b.fuel].column],
      window: windowOf(openRec, closeRec),
      calculation: {
        formula: "Expected closing ROB = Opening ROB + Documented additions − Documented deductions − Σ Reported consumption (all records after the opening ROB, up to the closing ROB)",
        inputs: [
          { label: `Opening ROB ${b.fuel}`, value: b.opening!.rob, ref: b.opening!.ref, column: openRec.rob[b.fuel].column },
          { label: `Closing ROB ${b.fuel}`, value: b.closing!.rob, ref: b.closing!.ref, column: closeRec.rob[b.fuel].column },
          ...inputs,
        ],
        steps: [`Expected = ${b.opening!.rob} + (${b.bunkers}) − ${b.consumption} = ${b.expected} mt`, `Residual = ${b.closing!.rob} − ${b.expected} = ${b.residual} mt`],
        result: `${b.residual} mt`,
        qualifications: [...qualifications, STANDING_QUALIFICATION],
      },
      possibleCauses: causesFor(residual, !!deliveries),
    })
    return { ...b, findingId: finding.id }
  }

  const segments = reconstructSegments(active)
  const segmentBalances: SegmentBalance[] = []
  const periodBalances: SegmentBalance[] = []
  const hasEvent = ctx.log.map.columns.some((m) => m.role?.kind === "event")
  for (const fuel of robFuels) {
    if (hasEvent) {
      for (const segment of segments) {
        if (segment.type === "unknown" || segment.end <= segment.start) continue
        const label = segment.type === "voyage" ? `voyage ${segment.from ?? "?"} → ${segment.to ?? "(no destination)"} (lines ${segment.startRef.line}–${segment.endRef.line})` : `port stay at ${segment.from ?? "?"} (lines ${segment.startRef.line}–${segment.endRef.line})`
        segmentBalances.push(report(balance(fuel, segment), label))
      }
    }
    const startPos = active.findIndex(inPeriod)
    let endPos = -1
    for (let p = active.length - 1; p >= 0; p -= 1) if (inPeriod(active[p])) { endPos = p; break }
    if (startPos >= 0 && endPos > startPos) {
      const whole: Segment = { type: "unknown", start: startPos, end: endPos, from: null, to: null, startRef: active[startPos].ref, endRef: active[endPos].ref, closed: false }
      periodBalances.push(report(balance(fuel, whole), ctx.period ? "reporting period" : "whole log"))
    }
  }
  c.ran("D04", scope, segmentBalances.length + periodBalances.length)
  if (!hasEvent) c.partial("D04", scope, "no event column, so voyages and port stays cannot be reconstructed (period balance only)")
  if (deliveries) c.ran("D05", scope, steps.filter((s) => s.beyondTolerance).length)

  return { source: scope, fuels: robFuels, steps, segments: segmentBalances, period: periodBalances }
}

/** Median of decimal values (sorted copy; even count → mean of the middle two). */
function median(values: readonly Dec[]): Dec {
  const sorted = [...values].sort(cmp)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : divide(add(sorted[mid - 1], sorted[mid]), fromInt(2), 6)
}

type SegmentRate = {
  segment: Segment
  label: string
  consumption: Dec
  hours: Dec
  rate: Dec
  byFuel: { fuel: string; total: Dec }[]
  qualifications: string[]
  first: LogRecord
  last: LogRecord
}

/**
 * D09 consumption rate per voyage / port stay vs the other segments of the same kind, and D10 cargo heating vs
 * boiler consumption. Screening checks: DNV's own "Consumption deviation" and "CII: FC boiler" logic is not
 * documented; these are independent calculations under stated assumptions.
 */
export function runConsumptionChecks(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const active = ctx.sequence
  const fuels = fuelsOf(active)

  // D10: Cargo_heating_Consumption_F > Boiler_Consumption_F on the same record
  const hasHeating = active.some((r) => Object.values(r.allocations).some((cells) => cells.some((x) => x.purpose === "Cargo heating")))
  const hasBoiler = active.some((r) => Object.values(r.consumption).some((cells) => cells.some((x) => x.consumer === "Boiler")))
  if (!hasHeating || !hasBoiler) {
    c.notExecutable("D10", scope, !hasHeating ? "no Cargo_heating_Consumption columns identified" : "no Boiler_Consumption columns identified")
  } else {
    let evaluated = 0
    const hits = new Map<string, { record: LogRecord; heating: string; boiler: string; columns: string[] }[]>()
    for (const r of active) {
      for (const [fuel, cells] of Object.entries(r.allocations)) {
        const heating = cells.find((x) => x.purpose === "Cargo heating")
        if (!heating || heating.value.state !== "number" || isZero(heating.value.value)) continue
        const boiler = (r.consumption[fuel] ?? []).find((x) => x.consumer === "Boiler")
        if (!boiler || boiler.value.state === "invalid") continue
        evaluated += 1
        const boilerValue = boiler.value.state === "number" ? boiler.value.value : ZERO
        if (cmp(heating.value.value, boilerValue) > 0) {
          hits.set(fuel, [...(hits.get(fuel) ?? []), { record: r, heating: heating.value.raw.trim(), boiler: boiler.value.state === "number" ? boiler.value.raw.trim() : "blank", columns: [heating.column, boiler.column] }])
        }
      }
    }
    c.ran("D10", scope, evaluated)
    for (const [fuel, list] of hits) {
      const times = list.map((h) => (h.record.time.state === "ok" ? h.record.time.ms : null)).filter((t): t is number => t !== null)
      c.add("D10", {
        key: [scope, fuel],
        fuel,
        title: `${scope}: ${fuel} cargo heating exceeds ${fuel} boiler consumption on ${list.length} record(s)`,
        detail: list.slice(0, 8).map((h) => `${at(h.record)}: cargo heating ${h.heating} mt > boiler ${h.boiler}`).join("; ") + (list.length > 8 ? ` … ${list.length - 8} more` : "") + ".",
        refs: list.map((h) => h.record.ref),
        columns: [...new Set(list.flatMap((h) => h.columns))],
        ...(times.length ? { window: { fromMs: Math.min(...times), toMs: Math.max(...times) } } : {}),
        calculation: {
          formula: "Cargo_heating_Consumption_F − Boiler_Consumption_F > 0 on the same record",
          inputs: list.slice(0, 20).flatMap((h) => [
            { label: `Cargo heating ${fuel}`, value: h.heating, ref: h.record.ref, column: h.columns[0] },
            { label: `Boiler ${fuel}`, value: h.boiler, ref: h.record.ref, column: h.columns[1] },
          ]),
          steps: list.slice(0, 20).map((h) => `line ${h.record.ref.line}: ${h.heating} > ${h.boiler}`),
          result: `${list.length} record(s)`,
          qualifications: [
            "OVD 3.13 describes cargo heating as a portion of ME/AE/Boiler/IGG consumption; on most tankers the boilers produce it, so heating above boiler consumption usually means one of the two figures is wrong. If the vessel heats cargo from another consumer, this finding does not apply.",
            "A blank boiler consumption is shown as \"blank\" and compared as nothing reported.",
          ],
        },
      })
    }
  }

  // D09: consumption per hour of each voyage / port stay vs the median of the other segments of the same type
  const hasEvent = ctx.log.map.columns.some((m) => m.role?.kind === "event")
  const hasDuration = ctx.log.map.columns.some((m) => m.role?.kind === "durationHours")
  const hasConsumption = active.some((r) => Object.keys(r.consumption).length > 0)
  if (!hasEvent || !hasDuration || !hasConsumption) {
    c.notExecutable("D09", scope, !hasEvent ? "no event column identified" : !hasDuration ? "no Time_Since_Previous_Report column identified" : "no consumption columns identified")
    return
  }
  const factor = parseDec(ctx.config.consumptionDeviationFactor)!
  const minHours = fromInt(6)
  const inPeriod = (r: LogRecord) => !ctx.period || (r.time.state === "ok" && r.time.ms >= ctx.period.fromMs && r.time.ms <= ctx.period.toMs)
  const rates: SegmentRate[] = []
  let notComputable = 0
  for (const segment of reconstructSegments(active)) {
    if (segment.type === "unknown" || segment.end <= segment.start) continue
    const first = active[segment.start]
    const last = active[segment.end]
    if (!inPeriod(first) || !inPeriod(last)) continue
    const qualifications: string[] = []
    const totals = new Map<string, Dec>()
    let hours = ZERO
    let ok = true
    for (let p = segment.start + 1; p <= segment.end; p += 1) {
      const r = active[p]
      const d = r.duration?.value
      if (d?.state === "number") hours = add(hours, d.value)
      else {
        const prev = active[p - 1]
        if (d?.state === "invalid" || prev.time.state !== "ok" || r.time.state !== "ok" || r.time.ms < prev.time.ms) { ok = false; break }
        hours = add(hours, divide(fromInt(r.time.ms - prev.time.ms), fromInt(HOUR), 4))
        qualifications.push(`Duration blank at line ${r.ref.line}; the UTC time since the previous record is used.`)
      }
      for (const fuel of fuels) {
        for (const x of r.consumption[fuel] ?? []) {
          if (x.value.state === "invalid") { ok = false; break }
          if (x.value.state === "number") totals.set(fuel, add(totals.get(fuel) ?? ZERO, x.value.value))
        }
        if (!ok) break
      }
      if (!ok) break
    }
    if (!ok || cmp(hours, minHours) < 0) { notComputable += ok ? 0 : 1; continue }
    const consumption = sum([...totals.values()])
    const label = segment.type === "voyage" ? `voyage ${segment.from ?? "?"} → ${segment.to ?? "(no destination)"} (lines ${segment.startRef.line}–${segment.endRef.line})` : `port stay at ${segment.from ?? "?"} (lines ${segment.startRef.line}–${segment.endRef.line})`
    rates.push({ segment, label, consumption, hours, rate: divide(consumption, hours, 4), byFuel: [...totals].filter(([, t]) => !isZero(t)).map(([fuel, total]) => ({ fuel, total })), qualifications, first, last })
  }
  let evaluated = 0
  for (const type of ["voyage", "port"] as const) {
    const ofType = rates.filter((r) => r.segment.type === type)
    if (ofType.length < 3) {
      c.partial("D09", scope, `only ${ofType.length} ${type === "voyage" ? "voyage(s)" : "port stay(s)"} of at least 6 h with computable consumption; at least 3 are needed for a comparison`)
      continue
    }
    for (const s of ofType) {
      evaluated += 1
      const others = ofType.filter((o) => o !== s)
      const typical = median(others.map((o) => o.rate))
      const limit = mul(typical, factor)
      if (isZero(typical) || cmp(s.rate, limit) <= 0) continue
      const ratio = divide(s.rate, typical, 2)
      const kind = type === "voyage" ? "voyages" : "port stays"
      c.add("D09", {
        key: [scope, type, s.segment.startRef.line, s.segment.endRef.line],
        title: `${scope}: ${s.label} burns ${toFixed(s.rate, 3)} mt/h, ${toFixed(ratio, 2)}× the median of the other ${kind}`,
        detail: `${toString(s.consumption)} mt of fuel in ${toFixed(s.hours, 1)} h (${at(s.first)} to ${at(s.last)}). The median of the other ${others.length} ${kind} in the period is ${toFixed(typical, 3)} mt/h; the screening threshold is ${ctx.config.consumptionDeviationFactor}×. Heavy cargo heating, discharge, tank cleaning or weather can explain a high rate.`,
        refs: [s.first.ref, s.last.ref],
        columns: [...new Set(active.slice(s.segment.start + 1, s.segment.end + 1).flatMap((r) => Object.values(r.consumption).flat().filter((x) => x.value.state === "number" && !isZero(x.value.value)).map((x) => x.column)))],
        window: windowOf(s.first, s.last),
        possibleCauses: [
          "A consumption figure entered with a misplaced decimal or in the wrong unit (hypothesis)",
          "Consumption of several days booked on one report of the segment (hypothesis)",
          "Higher activity in this segment, e.g. cargo heating, discharge, tank cleaning or adverse weather (hypothesis)",
        ],
        calculation: {
          formula: "Rate = Σ consumption (ME + AE + Boiler + Inert gas + Incinerator, all fuels) ÷ Σ Time_Since_Previous_Report over the records after the segment's opening event; compared with the median rate of the other segments of the same type × factor",
          inputs: [
            ...s.byFuel.map((f) => ({ label: `Σ consumption ${f.fuel} (mt)`, value: toString(f.total) })),
            { label: "Σ hours", value: toFixed(s.hours, 4) },
            ...others.map((o) => ({ label: `Other: ${o.label} (mt/h)`, value: toFixed(o.rate, 4), ref: o.segment.startRef })),
          ],
          steps: [
            `Rate = ${toString(s.consumption)} ÷ ${toFixed(s.hours, 4)} = ${toFixed(s.rate, 4)} mt/h`,
            `Median of the other ${others.length} ${kind} = ${toFixed(typical, 4)} mt/h; limit = ${toFixed(typical, 4)} × ${ctx.config.consumptionDeviationFactor} = ${toFixed(limit, 4)} mt/h`,
            `Ratio = ${toFixed(ratio, 2)}×`,
          ],
          result: `${toFixed(s.rate, 4)} mt/h (${toFixed(ratio, 2)}×)`,
          qualifications: [
            ...s.qualifications,
            "Blank consumption fields are left out of the sum, not read as zero. Cargo heating, DP and DPP columns are portions of the total and are not added.",
            "This is a screening comparison between segments of the same vessel; DNV's consumption-deviation logic is not documented here and may use other references.",
          ],
        },
      })
    }
  }
  c.ran("D09", scope, evaluated)
  if (notComputable) c.partial("D09", scope, `${notComputable} segment(s) had an invalid consumption or duration value and were not compared`)
}
