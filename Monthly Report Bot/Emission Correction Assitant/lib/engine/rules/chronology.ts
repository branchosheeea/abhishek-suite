// Group B: chronology. Uses the ORIGINAL row order, which is never changed; the timeline view sorted by
// timestamp is built separately (timeline.ts) for display and correlation only.

import { divide, fromInt, parseDec, toFixed, cmp } from "../decimal"
import type { LogRecord } from "../records"
import { activeRecords, at, type Collector, kindLabel, lineList, type RuleContext } from "./common"

const HOUR = 3_600_000

export function runChronology(ctx: RuleContext, c: Collector) {
  const scope = kindLabel(ctx.log.table.kind)
  const timed = activeRecords(ctx.log.records).filter((r): r is LogRecord & { time: { state: "ok"; ms: number; iso: string } } => r.time.state === "ok")
  if (timed.length === 0) {
    for (const id of ["B01", "B02", "B03", "B04"]) c.notExecutable(id, scope, "no record has an interpretable timestamp")
    return
  }

  // B01 backward timestamps
  c.ran("B01", scope, Math.max(0, timed.length - 1))
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1]
    const cur = timed[i]
    if (cur.time.ms < prev.time.ms) {
      c.add("B01", {
        key: [scope, prev.ref.line, cur.ref.line],
        title: `${scope}: timestamp goes backwards at line ${cur.ref.line}`,
        detail: `${at(cur)} is earlier than the preceding record ${at(prev)}. The row order is kept as submitted.`,
        refs: [prev.ref, cur.ref],
        columns: cur.timeColumns,
        window: { fromMs: Math.min(prev.time.ms, cur.time.ms), toMs: Math.max(prev.time.ms, cur.time.ms) },
      })
    }
  }

  // B02 one event per IMO and UTC minute; DNV keeps the highest row number (Notes on GHG reporting, rows 6, 20)
  c.ran("B02", scope, timed.length)
  const byTime = new Map<string, LogRecord[]>()
  for (const r of timed) {
    const key = `${(r.imoRaw ?? "").trim()}|${r.time.ms}`
    byTime.set(key, [...(byTime.get(key) ?? []), r])
  }
  for (const [key, group] of byTime) {
    if (group.length < 2) continue
    const ms = group[0].time.state === "ok" ? group[0].time.ms : 0
    const kept = group.reduce((a, b) => (b.ref.line > a.ref.line ? b : a))
    c.add("B02", {
      key: [scope, key],
      title: `${scope}: ${group.length} records at ${group[0].time.state === "ok" ? group[0].time.iso : ""}`,
      detail: `Events: ${group.map((r) => `${r.eventRaw ?? "(blank)"} (line ${r.ref.line})`).join(", ")}. DNV keeps only line ${kept.ref.line} (the highest row number) and overwrites the others; the module does not choose.`,
      refs: group.map((r) => r.ref),
      columns: group[0].timeColumns,
      window: { fromMs: ms, toMs: ms },
    })
  }

  // B03 outside the reporting period
  if (!ctx.period) {
    c.notExecutable("B03", scope, "no reporting period set for the session")
  } else {
    const { fromMs, toMs } = ctx.period
    c.ran("B03", scope, timed.length)
    const byYear = new Map<number, LogRecord[]>()
    for (const r of timed) {
      if (r.time.ms < fromMs || r.time.ms > toMs) {
        const year = new Date(r.time.ms).getUTCFullYear()
        byYear.set(year, [...(byYear.get(year) ?? []), r])
      }
    }
    for (const [year, group] of byYear) {
      const times = group.map((r) => (r.time.state === "ok" ? r.time.ms : 0))
      c.add("B03", {
        key: [scope, year],
        title: `${scope}: ${group.length} record(s) dated ${year}, outside the reporting period`,
        detail: `Lines ${lineList(group.map((r) => r.ref))}. They remain in the validation unless excluded by the user, and are kept visible either way.`,
        refs: group.map((r) => r.ref),
        columns: group[0].timeColumns,
        window: { fromMs: Math.min(...times), toMs: Math.max(...times) },
      })
    }
  }

  // B04 long intervals (successive records in submitted order, forward steps only)
  const limit = parseDec(ctx.config.maxReportIntervalHours)!
  c.ran("B04", scope, Math.max(0, timed.length - 1))
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1]
    const cur = timed[i]
    const diff = cur.time.ms - prev.time.ms
    if (diff <= 0) continue
    const hours = divide(fromInt(diff), fromInt(HOUR), 2)
    if (cmp(hours, limit) > 0) {
      c.add("B04", {
        key: [scope, prev.ref.line, cur.ref.line],
        title: `${scope}: ${toFixed(hours, 1)} h between reports (lines ${prev.ref.line}–${cur.ref.line})`,
        detail: `${at(prev)} → ${at(cur)}. Screening threshold ${ctx.config.maxReportIntervalHours} h.`,
        refs: [prev.ref, cur.ref],
        window: { fromMs: prev.time.ms, toMs: cur.time.ms },
      })
    }
  }
}
