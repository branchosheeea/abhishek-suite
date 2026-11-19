"use client"

import { useMemo, useRef, useState } from "react"
import type { FuelStep } from "@/lib/engine/rules/fuel"
import { Card, cn, Empty, Pill } from "../ui"
import type { Ctx } from "./types"

export function VoyageFuel({ ctx }: { ctx: Ctx }) {
  const analyses = ctx.result?.fuel ?? []
  const [sourceIndex, setSourceIndex] = useState(0)
  const analysis = analyses[sourceIndex]
  const [fuel, setFuel] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "flagged">("flagged")
  if (!ctx.result) return <Empty>Run the validation to reconstruct voyages and fuel balances.</Empty>
  if (!analysis || analysis.fuels.length === 0) return <Empty>No fuel balance was calculated: no ROB columns were identified in the log source.</Empty>
  const activeFuel = fuel && analysis.fuels.includes(fuel) ? fuel : analysis.fuels[0]
  const steps = analysis.steps.filter((s) => s.fuel === activeFuel)
  const shown = filter === "all" ? steps : steps.filter((s) => s.beyondTolerance || s.status === "not-computable" || s.qualified)
  const toleranceText = ctx.run?.config.fuelToleranceMt ?? ctx.data.session.config.fuelToleranceMt
  const tolerance = Number(toleranceText) // chart scale only; findings use the exact decimal
  const segments = analysis.segments.filter((s) => s.fuel === activeFuel)
  const period = analysis.period.find((p) => p.fuel === activeFuel)

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {analyses.length > 1 && (
          <div role="group" aria-label="Log source" className="flex gap-1">
            {analyses.map((a, i) => <button key={a.source} aria-pressed={i === sourceIndex} onClick={() => setSourceIndex(i)} className={cn("rounded-md border px-2.5 py-1 text-sm", i === sourceIndex && "border-primary bg-info-bg font-semibold text-primary")}>{a.source}</button>)}
          </div>
        )}
        <div role="group" aria-label="Fuel" className="flex gap-1">
          {analysis.fuels.map((f) => <button key={f} aria-pressed={f === activeFuel} onClick={() => setFuel(f)} className={cn("rounded-md border px-2.5 py-1 text-sm", f === activeFuel && "border-primary bg-info-bg font-semibold text-primary")}>{f}</button>)}
        </div>
        {period && (
          <span className="text-sm text-muted-foreground">
            Reporting period: {period.status === "computed" ? <>residual <strong className="text-foreground">{period.residual} mt</strong> (lines {period.opening!.ref.line}–{period.closing!.ref.line}{period.qualified ? ", qualified" : ""})</> : <>no period balance — {period.reason}</>}
          </span>
        )}
      </div>

      <Card title={`${activeFuel} residual per reporting step (mt)`}>
        <ResidualChart steps={steps} tolerance={tolerance} onOpen={(id) => ctx.openFinding(id)} />
        <p className="mt-2 text-xs text-muted-foreground">
          Residual = reported closing ROB − (opening ROB + documented bunkers − reported consumption), exact decimals. Threshold ±{toleranceText} mt (as used in this run) is a screening threshold, not a DNV tolerance. Successive steps follow the submitted row order.
        </p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card
          title="Balance steps"
          actions={
            <select className="h-8 rounded-lg border border-input bg-card px-2 text-xs" value={filter} onChange={(e) => setFilter(e.target.value as "all" | "flagged")} aria-label="Steps shown">
              <option value="flagged">Beyond threshold, qualified or not computable</option>
              <option value="all">All steps</option>
            </select>
          }
        >
          {shown.length === 0 ? <Empty>No step to show with this filter.</Empty> : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr><th className="py-1 pr-2">Lines</th><th className="pr-2 text-right">Opening</th><th className="pr-2 text-right">Bunkers</th><th className="pr-2 text-right">Consumption</th><th className="pr-2 text-right">Expected</th><th className="pr-2 text-right">Reported</th><th className="pr-2 text-right">Residual</th><th>Status</th></tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {shown.map((s) => (
                    <tr key={s.position}>
                      <td className="py-1 pr-2"><button className="font-mono text-primary hover:underline" onClick={() => ctx.focus([s.prev, s.cur])}>{s.prev.line}→{s.cur.line}</button></td>
                      {s.status === "computed" ? (
                        <>
                          <td className="pr-2 text-right font-mono">{s.openingRob}</td><td className="pr-2 text-right font-mono">{s.bunkers}</td><td className="pr-2 text-right font-mono">{s.consumption}</td>
                          <td className="pr-2 text-right font-mono">{s.expected}</td><td className="pr-2 text-right font-mono">{s.closingRob}</td><td className="pr-2 text-right font-mono font-semibold">{s.residual}</td>
                        </>
                      ) : (
                        <td colSpan={6} className="pr-2 text-muted-foreground">{s.reason}</td>
                      )}
                      <td className="whitespace-nowrap">
                        <span className="flex flex-wrap gap-1">
                          {s.status === "not-computable" && <Pill>Not computable</Pill>}
                          {s.beyondTolerance && (s.findingId ? <button onClick={() => ctx.openFinding(s.findingId!)}><Pill tone="warning">Beyond threshold</Pill></button> : <Pill tone="warning">Beyond threshold</Pill>)}
                          {s.qualified && <Pill tone="info">Qualified</Pill>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Voyages and port stays">
          {segments.length === 0 ? <Empty>No voyage or port stay reconstructed (no departure/arrival events identified).</Empty> : (
            <ul className="flex flex-col divide-y text-xs">
              {segments.map((b) => (
                <li key={`${b.segment.type}-${b.segment.start}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <button className="text-left" onClick={() => ctx.focus([b.segment.startRef, b.segment.endRef])}>
                    <span className="block font-semibold text-primary">{b.segment.type === "voyage" ? `Voyage ${b.segment.from ?? "?"} → ${b.segment.to ?? "?"}` : `Port stay ${b.segment.from ?? "?"}`}</span>
                    <span className="text-muted-foreground">lines {b.segment.startRef.line}–{b.segment.endRef.line} · {b.records} record(s){b.segment.closed ? "" : " · open-ended"}{b.qualified ? " · qualified" : ""}</span>
                  </button>
                  {b.status === "computed" ? (
                    b.findingId ? <button onClick={() => ctx.openFinding(b.findingId!)}><Pill tone="warning">{b.residual} mt</Pill></button> : <span className="font-mono tabular-nums">{b.residual} mt</span>
                  ) : <Pill>{b.reason}</Pill>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted-foreground">Voyage = Departure to the next Arrival; port stay = Arrival to the next Departure (exact OVD event names only). Missing events are never invented.</p>
        </Card>
      </div>
    </div>
  )
}

const H = 220
const PAD = { top: 12, right: 12, bottom: 22, left: 52 }

function ResidualChart({ steps, tolerance, onOpen }: { steps: readonly FuelStep[]; tolerance: number; onOpen: (id: string) => void }) {
  const ref = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 960
  const values = useMemo(() => steps.map((s) => (s.status === "computed" ? Number(s.residual) : null)), [steps])
  const extent = Math.max(tolerance * 2, ...values.map((v) => (v === null ? 0 : Math.abs(v))))
  const ticks = niceTicks(extent)
  const yMax = ticks[ticks.length - 1]
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const band = plotW / Math.max(1, steps.length)
  const barW = Math.max(1, Math.min(24, band - 2))
  const y = (v: number) => PAD.top + plotH / 2 - (v / yMax) * (plotH / 2)
  const zero = y(0)

  const pick = (clientX: number) => {
    const svg = ref.current
    if (!svg) return
    const box = svg.getBoundingClientRect()
    const x = ((clientX - box.left) / box.width) * W - PAD.left
    const i = Math.floor(x / band)
    setHover(i >= 0 && i < steps.length ? i : null)
  }

  if (steps.length === 0) return <Empty>No balance step for this fuel.</Empty>
  const h = hover !== null ? steps[hover] : null

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: "var(--chart-accent)" }} />Beyond ±{tolerance} mt threshold</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: "var(--chart-muted)" }} />Within threshold</span>
        <span><span className="mr-1 inline-block size-2.5 rounded-full border-2 align-middle" style={{ borderColor: "var(--chart-muted)" }} />Not computable</span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none"
        role="img"
        aria-label={`Residual per step: ${values.filter((v) => v !== null && Math.abs(v) > tolerance).length} of ${steps.length} steps beyond the threshold, ${values.filter((v) => v === null).length} not computable.`}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onClick={() => h?.findingId && onOpen(h.findingId)}
      >
        {ticks.flatMap((t) => (t === 0 ? [0] : [t, -t])).map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="currentColor" className="text-muted-foreground tabular-nums">{fmt(t)}</text>
          </g>
        ))}
        {[tolerance, -tolerance].map((t) => <line key={t} x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--chart-muted)" strokeDasharray="4 3" strokeWidth={1} />)}
        {steps.map((s, i) => {
          const cx = PAD.left + i * band + band / 2
          const v = values[i]
          if (v === null) return <circle key={i} cx={cx} cy={zero} r={Math.min(4, Math.max(2, band / 2 - 0.5))} fill="none" stroke="var(--chart-muted)" strokeWidth={1.5} />
          if (v === 0) return null
          const top = y(v)
          return <path key={i} d={barPath(cx - barW / 2, barW, zero, top)} fill={Math.abs(v) > tolerance ? "var(--chart-accent)" : "var(--chart-muted)"} opacity={hover === null || hover === i ? 1 : 0.55} />
        })}
        {hover !== null && <line x1={PAD.left + hover * band + band / 2} x2={PAD.left + hover * band + band / 2} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--chart-axis)" strokeWidth={1} />}
        <text x={PAD.left} y={H - 6} fontSize="10" fill="currentColor" className="text-muted-foreground">Line {steps[0].cur.line}</text>
        <text x={W - PAD.right} y={H - 6} fontSize="10" textAnchor="end" fill="currentColor" className="text-muted-foreground">Line {steps[steps.length - 1].cur.line}</text>
      </svg>
      {/* Keyboard access: one focusable control per flagged step (the table below lists every step). */}
      <div className="sr-only">
        {steps.map((s, i) => (s.beyondTolerance || s.status === "not-computable") && (
          <button key={i} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => s.findingId && onOpen(s.findingId)}>
            {s.status === "computed" ? `Residual ${s.residual} mt, lines ${s.prev.line} to ${s.cur.line}` : `Not computable, lines ${s.prev.line} to ${s.cur.line}`}
          </button>
        ))}
      </div>
      {h && (
        <div role="status" className="pointer-events-none absolute top-8 right-2 max-w-xs rounded-lg border bg-card px-3 py-2 text-xs shadow-sm">
          {h.status === "computed" ? (
            <>
              <p><strong className="text-sm tabular-nums">{h.residual} mt</strong> residual</p>
              <p className="text-muted-foreground">Lines {h.prev.line} → {h.cur.line}</p>
              <p className="text-muted-foreground tabular-nums">Expected {h.expected} · reported {h.closingRob}</p>
              <p className="text-muted-foreground">{h.beyondTolerance ? "Beyond threshold · click to open the finding" : "Within threshold"}{h.qualified ? " · qualified" : ""}</p>
            </>
          ) : (
            <>
              <p><strong className="text-sm">Not computable</strong></p>
              <p className="text-muted-foreground">Lines {h.prev.line} → {h.cur.line}: {h.reason}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Bar from the baseline with a 4px rounded data end and a square base. */
function barPath(x: number, w: number, base: number, end: number): string {
  const r = Math.min(4, w / 2, Math.abs(end - base))
  if (end < base) return `M${x},${base} V${end + r} Q${x},${end} ${x + r},${end} H${x + w - r} Q${x + w},${end} ${x + w},${end + r} V${base} Z`
  return `M${x},${base} V${end - r} Q${x},${end} ${x + r},${end} H${x + w - r} Q${x + w},${end} ${x + w},${end - r} V${base} Z`
}

function niceTicks(extent: number): number[] {
  const raw = extent / 2
  const mag = 10 ** Math.floor(Math.log10(raw || 1))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  return [0, step, step * 2]
}

function fmt(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)
}
