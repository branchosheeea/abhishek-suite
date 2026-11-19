// Group C: voyage and port continuity, and the reconstruction of voyages / port stays used by the fuel
// balances. Works in submitted row order. Missing events are reported, never invented.
//
// Documented semantics (OVD 3.13, Notes on GHG reporting, rows 11 and 21): a voyage runs from Departure (from
// berth) to the next Arrival (at berth). On a Departure, Voyage_From is the port being left. On an Arrival,
// Voyage_From and Voyage_To are the previous port and the new port. An unknown Voyage_To is left empty.

import { seaPassageAlias } from "../events"
import type { LogRecord } from "../records"
import type { SourceRef } from "../types"
import { at, type Collector, kindLabel, lineList, type RuleContext, skippedBetween, skippedCause } from "./common"

export type Segment = Readonly<{
  type: "voyage" | "port" | "unknown"
  /** Positions in the active-record list (inclusive). */
  start: number
  end: number
  from: string | null
  to: string | null
  startRef: SourceRef
  endRef: SourceRef
  /** False when the segment is open-ended (no closing arrival / departure in the data). */
  closed: boolean
}>

/** Voyage = Departure … next Arrival; port stay = Arrival … next Departure. Only exact OVD event names count. */
export function reconstructSegments(active: readonly LogRecord[]): Segment[] {
  const segments: Segment[] = []
  let start = 0
  let type: Segment["type"] = "unknown"
  let from: string | null = null
  let to: string | null = null
  const close = (end: number, closed: boolean) => {
    if (end >= start && active.length) segments.push({ type, start, end, from, to, startRef: active[start].ref, endRef: active[end].ref, closed })
  }
  active.forEach((r, i) => {
    if (r.eventClass === "DEPARTURE") {
      if (i > 0) close(i, type !== "unknown")
      start = i
      type = "voyage"
      from = r.voyageFrom
      to = r.voyageTo
    } else if (r.eventClass === "ARRIVAL") {
      if (i > 0) close(i, type !== "unknown")
      start = i
      type = "port"
      from = r.voyageTo
      to = r.voyageTo
    }
  })
  if (active.length) close(active.length - 1, false)
  return segments
}

/**
 * Where the vessel was BEFORE each record: "sea" after a Departure with no Arrival since, "port" after an
 * Arrival with no Departure since, "unknown" before the first of either.
 */
export function phasesBefore(active: readonly LogRecord[]): ("sea" | "port" | "unknown")[] {
  let phase: "sea" | "port" | "unknown" = "unknown"
  return active.map((r) => {
    const before = phase
    if (r.eventClass === "DEPARTURE") phase = "sea"
    else if (r.eventClass === "ARRIVAL") phase = "port"
    return before
  })
}

const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/
const COUNTRY = /^[A-Z]{2}$/
const PLACEHOLDER = /^(TBD|TBA|TBC|UNKNOWN|UNK|N\/?A|NONE|NIL|-+|\?+)$/i

export function runVoyage(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const map = ctx.log.map
  const hasEvent = map.columns.some((m) => m.role?.kind === "event")
  const fromCol = map.columns.find((m) => m.role?.kind === "voyageFrom")?.header
  const toCol = map.columns.find((m) => m.role?.kind === "voyageTo")?.header
  const cargoCol = map.columns.find((m) => m.role?.kind === "cargoMt")?.header
  const active = ctx.sequence
  if (!hasEvent) {
    for (const id of ["C01", "C02", "C03", "C04", "C06", "C07"]) c.notExecutable(id, scope, "no event column identified")
  }
  if (!fromCol || !toCol) {
    for (const id of ["C01", "C02", "C04", "C05", "C07", "C08"]) c.notExecutable(id, scope, "Voyage_From / Voyage_To columns not identified")
  }

  if (hasEvent) {
    let phase: "unknown" | "sea" | "port" = "unknown"
    let lastDeparture: LogRecord | null = null
    let lastArrival: LogRecord | null = null
    let drift: LogRecord[] = []
    let stsOpen: LogRecord | null = null
    const causes = (a: LogRecord, b: LogRecord) => {
      const cause = skippedCause(skippedBetween(ctx, a, b))
      return cause ? { possibleCauses: [cause] } : {}
    }
    const flushDrift = () => {
      if (lastDeparture && drift.length && fromCol && toCol) {
        c.add("C02", {
          key: [scope, lastDeparture.ref.line, drift.map((r) => r.ref.line)],
          title: `${scope}: voyage ports change during the passage from line ${lastDeparture.ref.line}`,
          detail: `Departure ${at(lastDeparture)} declares ${lastDeparture.voyageFrom ?? "?"} → ${lastDeparture.voyageTo ?? "(empty)"}; ` +
            drift.slice(0, 6).map((r) => `line ${r.ref.line} shows ${r.voyageFrom ?? "?"} → ${r.voyageTo ?? "?"}`).join("; ") + (drift.length > 6 ? ` … ${drift.length - 6} more` : "") + ".",
          refs: [lastDeparture.ref, ...drift.map((r) => r.ref)],
          columns: [fromCol, toCol],
          window: windowOf([lastDeparture, ...drift]),
        })
      }
      drift = []
    }
    for (const r of active) {
      if (r.eventClass === "DEPARTURE") {
        flushDrift()
        if (phase === "sea" && lastDeparture) {
          c.add("C03", { key: [scope, "dep", lastDeparture.ref.line, r.ref.line], title: `${scope}: two departures without an arrival (lines ${lastDeparture.ref.line}, ${r.ref.line})`, detail: `${at(lastDeparture)} and ${at(r)} are both departures; no Arrival is reported between them.`, refs: [lastDeparture.ref, r.ref], window: windowOf([lastDeparture, r]), ...causes(lastDeparture, r) })
        }
        // C01: the port being left must be the previous port of call — the port of the preceding Arrival or, when
        // no Arrival was reported since the last Departure, the port that Departure left.
        const previousPort = phase === "port" && lastArrival ? lastArrival.voyageTo : phase === "sea" && lastDeparture ? lastDeparture.voyageFrom : null
        const previousRef = phase === "port" ? lastArrival : lastDeparture
        if (fromCol && toCol && previousPort && r.voyageFrom && previousRef && previousPort !== r.voyageFrom) {
          c.add("C01", { key: [scope, previousRef.ref.line, r.ref.line], title: `${scope}: departure from ${r.voyageFrom} does not match the previous port ${previousPort}`, detail: `${phase === "port" ? `Arrival ${at(previousRef)} is at ${previousPort}` : `The previous departure ${at(previousRef)} left ${previousPort} and no Arrival is reported since`}; departure ${at(r)} has Voyage_From ${r.voyageFrom}. A port call may be missing.`, refs: [previousRef.ref, r.ref], columns: [fromCol, toCol], window: windowOf([previousRef, r]), ...causes(previousRef, r) })
        }
        lastDeparture = r
        phase = "sea"
      } else if (r.eventClass === "ARRIVAL") {
        flushDrift()
        if (phase === "port" && lastArrival) {
          c.add("C03", { key: [scope, "arr", lastArrival.ref.line, r.ref.line], title: `${scope}: two arrivals without a departure (lines ${lastArrival.ref.line}, ${r.ref.line})`, detail: `${at(lastArrival)} and ${at(r)} are both arrivals; no Departure is reported between them.`, refs: [lastArrival.ref, r.ref], window: windowOf([lastArrival, r]) })
        }
        if (phase === "sea" && lastDeparture && toCol && lastDeparture.voyageTo && r.voyageTo && lastDeparture.voyageTo !== r.voyageTo) {
          c.add("C04", { key: [scope, lastDeparture.ref.line, r.ref.line], title: `${scope}: arrival at ${r.voyageTo}, destination declared ${lastDeparture.voyageTo}`, detail: `Departure ${at(lastDeparture)} declared Voyage_To ${lastDeparture.voyageTo}; arrival ${at(r)} has Voyage_To ${r.voyageTo}.`, refs: [lastDeparture.ref, r.ref], columns: [toCol], window: windowOf([lastDeparture, r]) })
        }
        // C07: the arrival's previous port must be the port the voyage departed from.
        if (phase === "sea" && lastDeparture && fromCol && lastDeparture.voyageFrom && r.voyageFrom && lastDeparture.voyageFrom !== r.voyageFrom) {
          c.add("C07", { key: [scope, lastDeparture.ref.line, r.ref.line], title: `${scope}: arrival gives previous port ${r.voyageFrom}, voyage departed from ${lastDeparture.voyageFrom}`, detail: `Departure ${at(lastDeparture)} has Voyage_From ${lastDeparture.voyageFrom}; arrival ${at(r)} has Voyage_From ${r.voyageFrom}.`, refs: [lastDeparture.ref, r.ref], columns: [fromCol], window: windowOf([lastDeparture, r]), ...causes(lastDeparture, r) })
        }
        lastArrival = r
        phase = "port"
      } else if (phase === "sea" && lastDeparture && fromCol && toCol) {
        const changed = (r.voyageFrom && lastDeparture.voyageFrom && r.voyageFrom !== lastDeparture.voyageFrom) || (r.voyageTo && lastDeparture.voyageTo && r.voyageTo !== lastDeparture.voyageTo)
        if (changed) drift.push(r)
      }
      // C06 STS pairing and DepartureSTS cargo
      if (r.eventClass === "ARRIVAL_STS") {
        if (stsOpen) c.add("C06", { key: [scope, "open", stsOpen.ref.line], title: `${scope}: ArrivalSTS at line ${stsOpen.ref.line} has no DepartureSTS`, detail: `${at(stsOpen)} is followed by another ArrivalSTS (${at(r)}) without a DepartureSTS between them.`, refs: [stsOpen.ref, r.ref], window: windowOf([stsOpen, r]) })
        stsOpen = r
      } else if (r.eventClass === "DEPARTURE_STS") {
        if (!stsOpen) c.add("C06", { key: [scope, "orphan", r.ref.line], title: `${scope}: DepartureSTS at line ${r.ref.line} without an ArrivalSTS`, detail: `${at(r)} ends an STS operation that was not reported with ArrivalSTS.`, refs: [r.ref], window: windowOf([r]) })
        if (cargoCol && r.cargo?.value.state === "blank") c.add("C06", { key: [scope, "cargo", r.ref.line], title: `${scope}: DepartureSTS at line ${r.ref.line} has no Cargo_Mt`, detail: `DepartureSTS must report Cargo_Mt as for a regular Departure (Notes on GHG reporting, row 15).`, refs: [r.ref], columns: [cargoCol], window: windowOf([r]) })
        stsOpen = null
      }
    }
    flushDrift()
    if (stsOpen) c.add("C06", { key: [scope, "unclosed", stsOpen.ref.line], title: `${scope}: ArrivalSTS at line ${stsOpen.ref.line} has no DepartureSTS`, detail: `${at(stsOpen)} begins an STS operation that is never reported as ended.`, refs: [stsOpen.ref], window: windowOf([stsOpen]) })
    for (const id of ["C03", "C06"]) c.ran(id, scope, active.length)
    if (fromCol && toCol) for (const id of ["C01", "C02", "C04", "C07"]) c.ran(id, scope, active.length)
  }

  if (fromCol && toCol) {
    const odd = new Map<string, SourceRef[]>()
    const placeholder = new Map<string, SourceRef[]>()
    const countryNoPosition: LogRecord[] = []
    for (const r of active) {
      for (const code of [r.voyageFrom, r.voyageTo]) {
        if (!code) continue
        if (PLACEHOLDER.test(code)) placeholder.set(code, [...(placeholder.get(code) ?? []), r.ref])
        else if (COUNTRY.test(code)) {
          if ((r.eventClass === "ARRIVAL" || r.eventClass === "DEPARTURE") && r.position?.state !== "ok") countryNoPosition.push(r)
        } else if (!UNLOCODE.test(code)) odd.set(code, [...(odd.get(code) ?? []), r.ref])
      }
    }
    c.ran("C05", scope, active.length)
    c.ran("C08", scope, active.length)
    const uniq = (refs: SourceRef[]) => [...new Map(refs.map((x) => [x.line, x])).values()]
    for (const [code, refs] of odd) {
      c.add("C05", { key: [scope, code], title: `${scope}: port code "${code}" is not a UN/LOCODE`, detail: `Used on lines ${lineList(uniq(refs))}.`, refs: uniq(refs), columns: [fromCol, toCol] })
    }
    if (countryNoPosition.length) {
      c.add("C05", { key: [scope, "country"], title: `${scope}: country-code-only port on ${countryNoPosition.length} Arrival/Departure without a position`, detail: `A 2-letter country code needs a reported position on the Arrival/Departure (Notes on GHG reporting, row 78). Lines ${lineList(countryNoPosition.map((r) => r.ref))}.`, refs: countryNoPosition.map((r) => r.ref), columns: [fromCol, toCol] })
    }
    for (const [text, refs] of placeholder) {
      c.add("C08", { key: [scope, text.toUpperCase()], title: `${scope}: placeholder port text "${text}"`, detail: `Leave the field empty when the port is not known; text such as TBD or Unknown leads to errors (Notes on GHG reporting, row 21). Lines ${lineList(uniq(refs))}.`, refs: uniq(refs), columns: [fromCol, toCol] })
    }
  }
}

/** C09: BOSP/EOSP (and documented alternatives) consistent with the Departure/Arrival sequence. */
export function runSeaPassage(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  if (!ctx.log.map.columns.some((m) => m.role?.kind === "event")) {
    c.notExecutable("C09", scope, "no event column identified")
    return
  }
  const active = ctx.sequence
  const kindOf = (r: LogRecord): "start" | "end" | null =>
    r.eventClass === "BEGIN_SEA_PASSAGE" ? "start" : r.eventClass === "END_SEA_PASSAGE" ? "end" : seaPassageAlias(r.eventRaw)
  if (!active.some((r) => kindOf(r))) {
    c.notExecutable("C09", scope, "no sea passage start/end events (BOSP/EOSP) are reported")
    return
  }
  const name = (r: LogRecord) => `${r.eventRaw?.trim() ?? ""} ${at(r)}`
  const causes = (a: LogRecord, b: LogRecord) => {
    const cause = skippedCause(skippedBetween(ctx, a, b))
    return cause ? { possibleCauses: [cause] } : {}
  }
  let phase: "unknown" | "sea" | "port" = "unknown"
  let lastArrival: LogRecord | null = null
  let open: LogRecord | null = null
  // The finding's time window is the record that is inconsistent (the one OVD Admin lists), not the whole passage.
  const add = (key: unknown[], title: string, detail: string, records: LogRecord[], flagged: LogRecord) =>
    c.add("C09", {
      key: [scope, ...key], title: `${scope}: ${title}`, detail, refs: records.map((r) => r.ref),
      window: flagged.time.state === "ok" ? { fromMs: flagged.time.ms, toMs: flagged.time.ms } : windowOf(records),
      ...(records.length > 1 ? causes(records[0], records[records.length - 1]) : {}),
    })
  for (const r of active) {
    const k = kindOf(r)
    if (r.eventClass === "DEPARTURE") {
      if (open) add(["dep", open.ref.line, r.ref.line], `sea passage started at line ${open.ref.line} is still open at the Departure (line ${r.ref.line})`, `${name(open)} starts a sea passage; the next Arrival/Departure event is the Departure ${at(r)}, with no EOSP between them.`, [open, r], open)
      open = null
      phase = "sea"
    } else if (r.eventClass === "ARRIVAL") {
      if (open) add(["arr", open.ref.line, r.ref.line], `sea passage started at line ${open.ref.line} is not ended by EOSP before the Arrival (line ${r.ref.line})`, `${name(open)} starts a sea passage; the next Arrival/Departure event is the Arrival ${at(r)}, with no EOSP between them. The EOSP may be missing, or reported after the Arrival.`, [open, r], open)
      open = null
      lastArrival = r
      phase = "port"
    } else if (k === "start") {
      if (phase === "port" && lastArrival) add(["start-port", lastArrival.ref.line, r.ref.line], `sea passage starts in port (line ${r.ref.line})`, `${name(r)} comes after the Arrival ${at(lastArrival)} with no Departure in between.`, [lastArrival, r], r)
      else if (open) add(["start-twice", open.ref.line, r.ref.line], `second sea passage start at line ${r.ref.line} without an end`, `${name(open)} already started a sea passage; ${name(r)} starts another with no EOSP between them.`, [open, r], r)
      open = r
    } else if (k === "end") {
      if (phase === "port" && lastArrival) add(["end-port", lastArrival.ref.line, r.ref.line], `EOSP at line ${r.ref.line} after the Arrival at line ${lastArrival.ref.line}`, `${name(r)} ends a sea passage although the vessel arrived at ${at(lastArrival)} with no Departure since. The Arrival time or the EOSP time may be wrong, or an event is missing.`, [lastArrival, r], r)
      else if (!open) add(["end-unopened", r.ref.line], `EOSP at line ${r.ref.line} without a sea passage start`, `${name(r)} ends a sea passage that was not started by BOSP (or a documented alternative) after the last Departure.`, [r], r)
      open = null
    }
  }
  c.ran("C09", scope, active.length)
}

function windowOf(records: readonly LogRecord[]) {
  const times = records.map((r) => (r.time.state === "ok" ? r.time.ms : null)).filter((t): t is number => t !== null)
  return times.length ? { fromMs: Math.min(...times), toMs: Math.max(...times) } : undefined
}
