// Groups E (cargo), F (duration) and G (distance / position). Successive records in submitted order.
// No corrected cargo figure, duration or distance is ever inferred; differences are reported with the calculation.

import { abs, add, cmp, divide, fromInt, isNegative, isZero, max, mul, parseDec, sub, toFixed, toString, ZERO } from "../decimal"
import { eventSpelling, STS_EVENTS } from "../events"
import { geodesicNm } from "../geodesy"
import type { LogRecord } from "../records"
import type { SourceRef } from "../types"
import { at, type Collector, kindLabel, type RuleContext, skippedBetween, skippedCause } from "./common"
import { phasesBefore, reconstructSegments } from "./voyage"

const HOUR = 3_600_000

export function runCargo(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const active = ctx.sequence
  const hasCargo = ctx.log.map.columns.some((m) => m.role?.kind === "cargoMt")
  const hasEvent = ctx.log.map.columns.some((m) => m.role?.kind === "event")
  if (!hasCargo || !hasEvent) {
    c.notExecutable("E01", scope, !hasCargo ? "no cargo column identified" : "no event column identified")
    return
  }
  const tolerance = parseDec(ctx.config.cargoToleranceMt)!
  const phases = phasesBefore(active)
  let evaluated = 0
  for (let i = 1; i < active.length; i += 1) {
    const cur = active[i]
    const prev = active[i - 1]
    const a = prev.cargo?.value
    const b = cur.cargo?.value
    if (a?.state !== "number" || b?.state !== "number") continue
    evaluated += 1
    const change = sub(b.value, a.value)
    if (cmp(abs(change), tolerance) <= 0) continue
    // At sea before this record (a Departure with no Arrival since); an STS operation explains a change.
    const explained = phases[i] !== "sea" || STS_EVENTS.has(prev.eventClass) || STS_EVENTS.has(cur.eventClass)
    if (explained) continue
    // An STS event written with a non-standard spelling (e.g. "Arrival STS") near the change is a likely cause.
    const nearby = active.slice(Math.max(0, i - 2), Math.min(active.length, i + 2))
    const nearMissSts = nearby.filter((r) => { const s = eventSpelling(r.eventRaw); return s.fixed && !s.exact && /STS/.test(s.documented ?? "") })
    const possibleCauses: string[] = []
    if (nearMissSts.length) possibleCauses.push(`An STS operation reported with a non-standard event name: ${nearMissSts.map((r) => `line ${r.ref.line} "${r.eventRaw!.trim()}"`).join(", ")} (rule A08). If so, the cargo change is operational (hypothesis)`)
    const skipped = skippedCause(skippedBetween(ctx, prev, cur))
    if (skipped) possibleCauses.push(skipped)
    c.add("E01", {
      key: [scope, prev.ref.line, cur.ref.line],
      severity: nearMissSts.length ? "warning" : undefined,
      title: `${scope}: cargo changes by ${toString(change)} mt on a sea passage (lines ${prev.ref.line}–${cur.ref.line})`,
      detail: `Cargo ${a.raw.trim()} mt at ${at(prev)} and ${b.raw.trim()} mt at ${at(cur)}. The vessel was at sea (no Arrival since the last Departure) and neither record is an STS event${cur.eventClass === "DEPARTURE" ? "; this Departure follows another Departure without an Arrival" : ""}.`,
      refs: [prev.ref, cur.ref],
      columns: [cur.cargo!.column],
      window: windowOf(prev, cur),
      possibleCauses,
      calculation: {
        formula: "Change = Cargo(i) − Cargo(i−1)",
        inputs: [
          { label: "Cargo before", value: a.raw.trim(), ref: prev.ref, column: prev.cargo!.column },
          { label: "Cargo after", value: b.raw.trim(), ref: cur.ref, column: cur.cargo!.column },
        ],
        steps: [`${b.raw.trim()} − ${a.raw.trim()} = ${toString(change)} mt`],
        result: `${toString(change)} mt`,
        qualifications: ["Only the exact OVD event names Arrival, Departure, STS, ArrivalSTS and DepartureSTS are recognised (Event types sheet, row 2)."],
      },
    })
  }
  c.ran("E01", scope, evaluated)
}

/**
 * G05: a distance over ground in port must come with maneuvering time — no distance is reported while moored,
 * and moving in port (incl. shifting) is maneuvering (OVD 3.13, Notes on GHG reporting, rows 29 and 34).
 */
export function runMoored(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const hasDistance = ctx.log.map.columns.some((m) => m.role?.kind === "distanceNm")
  const hasEvent = ctx.log.map.columns.some((m) => m.role?.kind === "event")
  if (!hasDistance || !hasEvent) {
    c.notExecutable("G05", scope, !hasDistance ? "no Distance column identified" : "no event column identified")
    return
  }
  const hasManeuvering = ctx.log.map.columns.some((m) => m.role?.kind === "maneuveringHours")
  if (!hasManeuvering) c.partial("G05", scope, "no Time_Elapsed_Maneuvering column; every distance in port is reported except on events named as shifting")
  const active = ctx.sequence
  const phases = phasesBefore(active)
  const hits: LogRecord[] = []
  let evaluated = 0
  active.forEach((r, i) => {
    if (phases[i] !== "port") return
    if (!hasManeuvering && r.eventClass === "SHIFTING") return
    const d = r.distance?.value
    if (d?.state !== "number" || isZero(d.value) || isNegative(d.value)) {
      evaluated += 1
      return
    }
    const m = r.maneuvering?.value
    if (hasManeuvering && m?.state === "invalid") return
    evaluated += 1
    if (!hasManeuvering || m?.state !== "number" || isZero(m.value)) hits.push(r)
  })
  c.ran("G05", scope, evaluated)
  if (hits.length) {
    const maneuveringText = (r: LogRecord) => (!hasManeuvering ? "" : r.maneuvering?.value.state === "number" ? `, maneuvering ${r.maneuvering.value.raw.trim()} h` : ", maneuvering blank")
    c.add("G05", {
      key: [scope],
      title: hasManeuvering
        ? `${scope}: distance in port without maneuvering time on ${hits.length} record(s)`
        : `${scope}: distance reported while in port on ${hits.length} record(s)`,
      detail: hits.slice(0, 8).map((r) => `${r.eventRaw?.trim() ? `${r.eventRaw.trim()} ` : ""}${at(r)}: ${r.distance!.value.raw.trim()} nm${maneuveringText(r)}`).join("; ") + (hits.length > 8 ? ` … ${hits.length - 8} more` : "") +
        `. These records follow an Arrival with no Departure since (the Departure itself included).${hasManeuvering ? " A distance moved in port, e.g. shifting berth, is maneuvering and should come with Time_Elapsed_Maneuvering." : " Shifting berth can explain a distance."}`,
      refs: hits.map((r) => r.ref),
      columns: [hits[0].distance!.column, ...(hasManeuvering && hits[0].maneuvering ? [hits[0].maneuvering.column] : [])],
      window: (() => {
        const t = hits.map((r) => (r.time.state === "ok" ? r.time.ms : null)).filter((x): x is number => x !== null)
        return t.length ? { fromMs: Math.min(...t), toMs: Math.max(...t) } : undefined
      })(),
      possibleCauses: [
        "Shifting or maneuvering in port reported without its maneuvering time (hypothesis)",
        "The distance belongs to the sea passage and was booked on a port record (hypothesis)",
      ],
    })
  }
}

/** G06: Σ reported distance of each voyage vs the track through its reported positions. */
export function runVoyageDistance(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const hasDistance = ctx.log.map.columns.some((m) => m.role?.kind === "distanceNm")
  const hasEvent = ctx.log.map.columns.some((m) => m.role?.kind === "event")
  const active = ctx.sequence
  const hasPositions = active.some((r) => r.position !== null)
  if (!hasDistance || !hasEvent || !hasPositions) {
    c.notExecutable("G06", scope, !hasDistance ? "no Distance column identified" : !hasEvent ? "no event column identified" : "no position columns identified")
    return
  }
  const shortTol = parseDec(ctx.config.distanceShortToleranceNm)!
  const pct = parseDec(ctx.config.voyageDistanceDeviationPct)!
  const minExcess = parseDec(ctx.config.distanceExcessMinNm)!
  const upper = add(fromInt(1), divide(pct, fromInt(100), 6))
  let evaluated = 0
  let incomplete = 0
  for (const segment of reconstructSegments(active)) {
    if (segment.type !== "voyage" || !segment.closed || segment.end <= segment.start) continue
    const records = active.slice(segment.start, segment.end + 1)
    const missing: string[] = []
    let track = ZERO
    let reported = ZERO
    for (let i = 0; i < records.length; i += 1) {
      const r = records[i]
      if (r.position?.state !== "ok") { missing.push(`position at line ${r.ref.line}`); continue }
      if (i === 0) continue
      const d = r.distance?.value
      if (d?.state !== "number") missing.push(`distance at line ${r.ref.line}`)
      else reported = add(reported, d.value)
      const prev = records[i - 1]
      if (prev.position?.state !== "ok") continue
      const g = geodesicNm(prev.position.position.lat, prev.position.position.lon, r.position.position.lat, r.position.position.lon)
      if (g === null) { missing.push(`geodesic not converged between lines ${prev.ref.line} and ${r.ref.line}`); continue }
      track = add(track, parseDec(g.toFixed(3))!)
    }
    if (missing.length) { incomplete += 1; continue }
    evaluated += 1
    const first = records[0]
    const last = records[records.length - 1]
    const label = `voyage ${segment.from ?? "?"} → ${segment.to ?? "(no destination)"} (lines ${segment.startRef.line}–${segment.endRef.line})`
    const allowance = max(shortTol, divide(track, fromInt(100), 3))
    const tooShort = cmp(reported, sub(track, allowance)) < 0
    const tooLong = cmp(reported, mul(track, upper)) > 0 && cmp(sub(reported, track), minExcess) > 0
    if (!tooShort && !tooLong) continue
    const deviation = isZero(track) ? null : divide(mul(sub(reported, track), fromInt(100)), track, 2)
    c.add("G06", {
      key: [scope, segment.startRef.line, segment.endRef.line],
      severity: tooShort ? "error" : undefined,
      title: `${scope}: ${label} reports ${toFixed(reported, 1)} nm vs ${toFixed(track, 1)} nm along its reported positions${deviation ? ` (${isNegative(deviation) ? "" : "+"}${toFixed(deviation, 1)}%)` : ""}`,
      detail: tooShort
        ? `The sum of the distances reported from ${at(first)} to ${at(last)} is shorter than the straight-line track through the voyage's ${records.length} reported positions. A distance over ground cannot be shorter than the track; a daily distance is likely missing or too low.`
        : `The sum of the distances reported from ${at(first)} to ${at(last)} exceeds the track through the voyage's ${records.length} reported positions by more than ${ctx.config.voyageDistanceDeviationPct}%. Routing around land, canals or weather between reports makes the sailed distance longer; a duplicated or mistyped daily distance is the other usual cause.`,
      refs: records.map((r) => r.ref),
      columns: [first.distance?.column ?? "Distance", ...first.positionColumns],
      window: windowOf(first, last),
      possibleCauses: [
        ...(() => { const s = skippedCause(skippedBetween(ctx, first, last)); return s ? [`${s}; its distance is then not counted`] : [] })(),
        ...(tooShort
          ? ["A daily distance missing or reported too low (hypothesis)", "A position reported wrongly, lengthening the track — see G03 implied-speed findings in the voyage (hypothesis)"]
          : ["A daily distance duplicated or mistyped (hypothesis)", "A position reported wrongly, shortening the track (hypothesis)", "Routing between reports far from the straight line, e.g. around land (hypothesis)"]),
      ],
      calculation: {
        formula: "Track = Σ WGS-84 geodesics between consecutive reported positions of the voyage; Reported = Σ Distance of the records after the Departure up to the Arrival",
        inputs: [
          { label: "Σ reported distance (nm)", value: toFixed(reported, 1) },
          { label: "Track through reported positions (nm)", value: toFixed(track, 3) },
          { label: "Records in the voyage", value: String(records.length) },
        ],
        steps: [
          `Reported − track = ${toFixed(sub(reported, track), 3)} nm`,
          tooShort ? `Shorter than track − allowance (${toFixed(allowance, 1)} nm)` : `Longer than track × ${toString(upper)} = ${toFixed(mul(track, upper), 1)} nm, by more than ${ctx.config.distanceExcessMinNm} nm`,
        ],
        result: deviation ? `${toFixed(deviation, 2)}%` : `${toFixed(reported, 1)} nm reported, track 0 nm`,
        qualifications: ["The track between reported positions is a lower bound of the sailed route, not the route itself; no AIS track was used.", "DNV's distance-deviation logic is not documented here and may use AIS or other references."],
      },
    })
  }
  c.ran("G06", scope, evaluated)
  if (incomplete) c.partial("G06", scope, `${incomplete} voyage(s) with a blank or invalid position or distance were not evaluated`)
}

function windowOf(prev: LogRecord, cur: LogRecord) {
  return prev.time.state === "ok" && cur.time.state === "ok" ? { fromMs: Math.min(prev.time.ms, cur.time.ms), toMs: Math.max(prev.time.ms, cur.time.ms) } : undefined
}

export function runDuration(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  if (!ctx.log.map.columns.some((m) => m.role?.kind === "durationHours")) {
    c.notExecutable("F01", scope, "no Time_Since_Previous_Report column identified")
    return
  }
  const tolerance = parseDec(ctx.config.durationToleranceHours)!
  const active = ctx.sequence
  let evaluated = 0
  let blank = 0
  for (let i = 1; i < active.length; i += 1) {
    const prev = active[i - 1]
    const cur = active[i]
    const reported = cur.duration?.value
    if (!reported || reported.state !== "number") {
      if (reported?.state === "blank") blank += 1
      continue
    }
    if (prev.time.state !== "ok" || cur.time.state !== "ok") continue
    evaluated += 1
    const elapsed = divide(fromInt(cur.time.ms - prev.time.ms), fromInt(HOUR), 4)
    const difference = sub(reported.value, elapsed)
    if (cmp(abs(difference), tolerance) <= 0) continue
    const skipped = skippedCause(skippedBetween(ctx, prev, cur))
    c.add("F01", {
      key: [scope, prev.ref.line, cur.ref.line],
      ...(skipped ? { possibleCauses: [skipped] } : {}),
      title: `${scope}: reported duration ${reported.raw.trim()} h vs ${toFixed(elapsed, 2)} h elapsed (line ${cur.ref.line})`,
      detail: `UTC time from ${at(prev)} to ${at(cur)} is ${toFixed(elapsed, 4)} h; the record reports ${reported.raw.trim()} h (difference ${toFixed(difference, 4)} h).`,
      refs: [prev.ref, cur.ref],
      columns: [cur.duration!.column, ...cur.timeColumns],
      window: windowOf(prev, cur),
      calculation: {
        formula: "Difference = Reported hours − (t(i) − t(i−1)) / 3600 s",
        inputs: [
          { label: "Previous timestamp (UTC)", value: prev.time.iso, ref: prev.ref },
          { label: "Timestamp (UTC)", value: cur.time.iso, ref: cur.ref },
          { label: "Reported duration (h)", value: reported.raw.trim(), ref: cur.ref, column: cur.duration!.column },
        ],
        steps: [`Elapsed = ${toFixed(elapsed, 4)} h`, `Difference = ${reported.raw.trim()} − ${toFixed(elapsed, 4)} = ${toFixed(difference, 4)} h`],
        result: `${toFixed(difference, 4)} h`,
        qualifications: ["The duration should equal the hours since the previous event report (Notes on GHG reporting, row 25); the previous event is taken from the sequence basis in use."],
      },
    })
  }
  c.ran("F01", scope, evaluated)
  if (blank) c.partial("F01", scope, `${blank} record(s) with a blank duration were not evaluated`)
}

export function runDistance(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const active = ctx.sequence
  const hasPositions = active.some((r) => r.position !== null)
  if (!hasPositions) {
    for (const id of ["G01", "G02", "G03", "G04"]) c.notExecutable(id, scope, "no position columns identified")
    return
  }
  // G04 invalid positions
  const invalid: { ref: SourceRef; reason: string }[] = []
  for (const r of active) if (r.position?.state === "invalid") invalid.push({ ref: r.ref, reason: r.position.reason })
  c.ran("G04", scope, active.length)
  if (invalid.length) {
    c.add("G04", {
      key: [scope],
      title: `${scope}: ${invalid.length} position(s) invalid or incomplete`,
      detail: invalid.slice(0, 6).map((x) => `line ${x.ref.line}: ${x.reason}`).join("; ") + (invalid.length > 6 ? ` … ${invalid.length - 6} more` : "") + ".",
      refs: invalid.map((x) => x.ref),
      columns: active[0].positionColumns,
    })
  }
  const hasDistance = ctx.log.map.columns.some((m) => m.role?.kind === "distanceNm")
  if (!hasDistance) {
    c.notExecutable("G01", scope, "no Distance column identified")
    c.notExecutable("G02", scope, "no Distance column identified")
  }
  const shortTol = parseDec(ctx.config.distanceShortToleranceNm)!
  const factor = parseDec(ctx.config.distanceExcessFactor)!
  const minExcess = parseDec(ctx.config.distanceExcessMinNm)!
  const maxSpeed = parseDec(ctx.config.maxPlausibleSpeedKn)!
  let evaluatedDistance = 0
  let evaluatedSpeed = 0
  let unconverged = 0
  for (let i = 1; i < active.length; i += 1) {
    const prev = active[i - 1]
    const cur = active[i]
    if (prev.position?.state !== "ok" || cur.position?.state !== "ok") continue
    const g = geodesicNm(prev.position.position.lat, prev.position.position.lon, cur.position.position.lat, cur.position.position.lon)
    if (g === null) {
      unconverged += 1
      continue
    }
    const geo = parseDec(g.toFixed(3))!
    const posText = (r: LogRecord) => (r.position?.state === "ok" ? `${r.position.position.lat.toFixed(4)}, ${r.position.position.lon.toFixed(4)}` : "")
    const reported = cur.distance?.value
    if (hasDistance && reported?.state === "number") {
      evaluatedDistance += 1
      const skipped = skippedCause(skippedBetween(ctx, prev, cur))
      const base = {
        refs: [prev.ref, cur.ref],
        columns: [cur.distance!.column, ...cur.positionColumns],
        window: windowOf(prev, cur),
        ...(skipped ? { possibleCauses: [`${skipped}; the reported distance then covers only the last leg`] } : {}),
      }
      const inputs = [
        { label: "Position before", value: posText(prev), ref: prev.ref },
        { label: "Position after", value: posText(cur), ref: cur.ref },
        { label: "Reported distance (nm)", value: reported.raw.trim(), ref: cur.ref, column: cur.distance!.column },
      ]
      // Allowance: the larger of the absolute setting and 1% of the geodesic (positions are reported to 0.1').
      const allowance = max(shortTol, divide(geo, fromInt(100), 3))
      if (cmp(reported.value, sub(geo, allowance)) < 0) {
        c.add("G01", {
          key: [scope, prev.ref.line, cur.ref.line],
          title: `${scope}: reported ${reported.raw.trim()} nm is shorter than the ${toFixed(geo, 1)} nm geodesic (line ${cur.ref.line})`,
          detail: `The shortest path between the positions at ${at(prev)} and ${at(cur)} is ${toFixed(geo, 1)} nm (WGS-84). A distance over ground cannot be shorter (allowance ${toFixed(allowance, 1)} nm).`,
          ...base,
          calculation: { formula: "Geodesic (WGS-84, Vincenty inverse) between the two reported positions; allowance = max(setting, 1% of geodesic)", inputs, steps: [`Geodesic = ${toFixed(geo, 3)} nm`, `Reported − geodesic = ${toFixed(sub(reported.value, geo), 3)} nm`], result: `${toFixed(sub(reported.value, geo), 3)} nm`, qualifications: ["Distance is the distance over ground since the previous event report (Log abstract, row 30; Notes on GHG reporting, row 34)."] },
        })
      } else if (cmp(reported.value, mul(geo, factor)) > 0 && cmp(sub(reported.value, geo), minExcess) > 0) {
        const samePosition = geo.m === 0n
        const ratio = samePosition ? null : toFixed(divide(reported.value, geo, 3), 3)
        c.add("G02", {
          key: [scope, prev.ref.line, cur.ref.line],
          title: `${scope}: reported ${reported.raw.trim()} nm vs ${toFixed(geo, 1)} nm geodesic (line ${cur.ref.line})`,
          detail: samePosition
            ? `Both records (${at(prev)}, ${at(cur)}) report the same position, yet ${reported.raw.trim()} nm is reported. A position may not have been updated, or the vessel returned to the same point.`
            : `Reported distance is more than ${ctx.config.distanceExcessFactor}× the geodesic between ${at(prev)} and ${at(cur)}. Routing around land, canals or weather can explain this; no AIS track was used.`,
          ...base,
          calculation: {
            formula: "Ratio = Reported ÷ Geodesic",
            inputs,
            steps: [`Geodesic = ${toFixed(geo, 3)} nm`, ratio ? `Ratio = ${ratio}` : "Ratio not defined: the geodesic is 0 nm"],
            result: ratio ? `${ratio}×` : `${reported.raw.trim()} nm reported between identical positions`,
            qualifications: ["Straight-line distance is a lower bound, not the sailed route."],
          },
        })
      }
    }
    if (prev.time.state === "ok" && cur.time.state === "ok" && cur.time.ms > prev.time.ms) {
      evaluatedSpeed += 1
      const hours = divide(fromInt(cur.time.ms - prev.time.ms), fromInt(HOUR), 6)
      const speed = divide(geo, hours, 2)
      if (cmp(speed, maxSpeed) > 0) {
        const skipped = skippedCause(skippedBetween(ctx, prev, cur))
        c.add("G03", {
          key: [scope, prev.ref.line, cur.ref.line],
          ...(skipped ? { possibleCauses: [skipped] } : {}),
          title: `${scope}: implied speed ${toFixed(speed, 1)} kn between lines ${prev.ref.line} and ${cur.ref.line}`,
          detail: `${toFixed(geo, 1)} nm (geodesic) in ${toFixed(hours, 2)} h from ${at(prev)} to ${at(cur)}. A position or a timestamp is likely wrong.`,
          refs: [prev.ref, cur.ref],
          columns: [...cur.positionColumns, ...cur.timeColumns],
          window: windowOf(prev, cur),
          calculation: { formula: "Implied speed = Geodesic ÷ Elapsed hours", inputs: [{ label: "Position before", value: posText(prev), ref: prev.ref }, { label: "Position after", value: posText(cur), ref: cur.ref }, { label: "Elapsed (h)", value: toFixed(hours, 4) }], steps: [`${toFixed(geo, 3)} ÷ ${toFixed(hours, 4)} = ${toFixed(speed, 2)} kn`], result: `${toFixed(speed, 2)} kn`, qualifications: [] },
        })
      }
    }
  }
  if (hasDistance) {
    c.ran("G01", scope, evaluatedDistance)
    c.ran("G02", scope, evaluatedDistance)
  }
  c.ran("G03", scope, evaluatedSpeed)
  if (unconverged) c.partial("G01", scope, `${unconverged} step(s) between nearly antipodal positions were not evaluated`)
}
