"use client"

import { useEffect, useState } from "react"
import { UNMATCHED_LABEL, type UnmatchedClass } from "@/lib/engine/reconcile"
import type { SourceRef } from "@/lib/engine/types"
import { formatTime, get } from "../api"
import { Banner, Button, Card, cn, Empty, Pill, Stat } from "../ui"
import type { Ctx } from "./types"

type Row = { line: number; cells: string[] }
type Table = { headers: string[]; rows: Row[] }

export function Reconciliation({ ctx }: { ctx: Ctx }) {
  const rec = ctx.result?.reconciliation
  const [compare, setCompare] = useState<{ la?: SourceRef; ovdla?: SourceRef } | null>(null)
  if (!ctx.result) return <Empty>Run the validation to reconcile the submitted LA with the system-generated OVDLA.</Empty>
  if (!rec) return <Banner tone="info" title="Reconciliation not run">It needs both the vessel-submitted Log Abstract and the system-generated OVDLA. Attach both under Sources.</Banner>

  const c = rec.counts
  const groups = (list: typeof rec.submittedOnly) => {
    const m = new Map<UnmatchedClass, typeof list>()
    for (const u of list) m.set(u.classification, [...(m.get(u.classification) ?? []), u])
    return [...m.entries()]
  }
  const valueDiffs = rec.matches.filter((m) => m.differences.some((d) => d.kind === "value"))
  const formatDiffs = rec.matches.filter((m) => m.differences.length && m.differences.every((d) => d.kind === "format-only"))

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="LA records" value={c.submitted} />
        <Stat label="OVDLA records" value={c.system} />
        <Stat label="Matched, identical" value={c.matchedIdentical} />
        <Stat label="Matched, values differ" value={c.matchedWithDifferences} />
        <Stat label="Matched, format only" value={c.matchedFormatOnly} />
        <Stat label="Only in LA" value={c.submittedOnly} />
        <Stat label="Only in OVDLA" value={c.systemOnly} />
      </section>
      <p className="text-xs text-muted-foreground">
        Match key: {rec.keyDefinition}. Duplicate keys are paired only where one fully identical pairing exists; the rest stay ambiguous ({c.ambiguousSubmitted} LA / {c.ambiguousSystem} OVDLA).
        {rec.systemRange && ` OVDLA covers ${formatTime(new Date(rec.systemRange.firstMs).toISOString())} to ${formatTime(new Date(rec.systemRange.lastMs).toISOString())}.`}
        {Object.entries(rec.systemMetadata).map(([k, v]) => ` ${k}: ${v.slice(0, 3).join(", ")}${v.length > 3 ? "…" : ""}.`)}
      </p>
      {(rec.submittedOnlyColumns.length > 0 || rec.systemOnlyColumns.length > 0) && (
        <p className="text-xs text-muted-foreground">Columns only in the LA: {rec.submittedOnlyColumns.join(", ") || "none"} · only in the OVDLA: {rec.systemOnlyColumns.join(", ") || "none"}.</p>
      )}

      {compare && <SideBySide ctx={ctx} la={compare.la} ovdla={compare.ovdla} onClose={() => setCompare(null)} />}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Only in the submitted LA">
          {rec.submittedOnly.length === 0 ? <Empty>None.</Empty> : groups(rec.submittedOnly).map(([cls, list]) => (
            <Group key={cls} label={UNMATCHED_LABEL[cls]} hypothesis={cls === "after-other-last"} items={list.map((u) => ({ text: `LA line ${u.ref.line}${u.nearMatch ? ` · near OVDLA row ${u.nearMatch.line} (${u.minutesApart} min)` : ""}`, onClick: () => setCompare({ la: u.ref, ovdla: u.nearMatch }) }))} />
          ))}
        </Card>
        <Card title="Only in the system-generated OVDLA">
          {rec.systemOnly.length === 0 ? <Empty>None.</Empty> : groups(rec.systemOnly).map(([cls, list]) => (
            <Group key={cls} label={UNMATCHED_LABEL[cls]} hypothesis={cls === "after-other-last"} items={list.map((u) => ({ text: `OVDLA row ${u.ref.line}${u.nearMatch ? ` · near LA line ${u.nearMatch.line} (${u.minutesApart} min)` : ""}`, onClick: () => setCompare({ ovdla: u.ref, la: u.nearMatch }) }))} />
          ))}
        </Card>
      </div>

      <Card title={`Matched records with value differences (${valueDiffs.length})`}>
        {valueDiffs.length === 0 ? <Empty>No value differences across the {c.matched} matched records in the {rec.commonColumns.length} common columns.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-3">LA line</th><th className="pr-3">OVDLA row</th><th className="pr-3">Column</th><th className="pr-3">LA value</th><th className="pr-3">OVDLA value</th><th /></tr></thead>
              <tbody className="divide-y">
                {valueDiffs.flatMap((m) => m.differences.filter((d) => d.kind === "value").map((d) => (
                  <tr key={`${m.submitted.line}-${d.column}`}>
                    <td className="py-1 pr-3 font-mono">{m.submitted.line}</td><td className="pr-3 font-mono">{m.system.line}</td><td className="pr-3">{d.column}</td>
                    <td className="pr-3 font-mono">{d.submitted || "·"}</td><td className="pr-3 font-mono">{d.system || "·"}</td>
                    <td><Button variant="ghost" className="h-7" onClick={() => setCompare({ la: m.submitted, ovdla: m.system })}>Compare</Button></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Neither value is assumed correct. Establish which one DNV holds and why they differ.</p>
      </Card>

      {formatDiffs.length > 0 && (
        <Card title={`Formatting-only differences (${formatDiffs.length})`}>
          <p className="text-xs text-muted-foreground">Numerically or temporally equal values written differently (e.g. “1.50” vs “1.5”, a text date vs an Excel date). Listed for completeness; no value differs.</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-xs">
            {formatDiffs.slice(0, 60).map((m) => <li key={m.submitted.line}><button className="text-primary hover:underline" onClick={() => setCompare({ la: m.submitted, ovdla: m.system })}>LA {m.submitted.line} ↔ OVDLA {m.system.line}</button></li>)}
          </ul>
        </Card>
      )}

      {rec.ambiguous.length > 0 && (
        <Card title={`Ambiguous matches (${rec.ambiguous.length})`}>
          <ul className="flex flex-col gap-1 text-xs">
            {rec.ambiguous.map((g) => <li key={g.key}>LA lines {g.submitted.map((r) => r.line).join(", ")} ↔ OVDLA rows {g.system.map((r) => r.line).join(", ")} <span className="text-muted-foreground">(not paired)</span></li>)}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Group({ label, items, hypothesis }: { label: string; items: { text: string; onClick: () => void }[]; hypothesis?: boolean }) {
  return (
    <details className="mb-2" open={items.length <= 12}>
      <summary className="cursor-pointer text-sm font-semibold">
        {label} ({items.length}) {hypothesis && <Pill tone="info">hypothesis</Pill>}
      </summary>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {items.map((i) => <li key={i.text}><button className="text-primary hover:underline" onClick={i.onClick}>{i.text}</button></li>)}
      </ul>
    </details>
  )
}

function SideBySide({ ctx, la, ovdla, onClose }: { ctx: Ctx; la?: SourceRef; ovdla?: SourceRef; onClose: () => void }) {
  const [tables, setTables] = useState<{ la?: Table; ovdla?: Table }>({})
  const { sources, ovdlaSheet } = ctx.data.session
  useEffect(() => {
    const load = async (sha: string | undefined, sheet?: string | null) => (sha ? (await get<{ table: Table }>(`/api/sources/${sha}${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`)).table : undefined)
    Promise.all([load(sources.LA), load(sources.OVDLA, ovdlaSheet)]).then(([a, b]) => setTables({ la: a, ovdla: b })).catch((e) => ctx.setError((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources.LA, sources.OVDLA, ovdlaSheet])
  const laRow = la ? tables.la?.rows.find((r) => r.line === la.line) : undefined
  const yRow = ovdla ? tables.ovdla?.rows.find((r) => r.line === ovdla.line) : undefined
  const headers = [...new Set([...(tables.la?.headers ?? []), ...(tables.ovdla?.headers ?? [])].map((h) => h.trim()).filter(Boolean))]
  const value = (t: Table | undefined, row: Row | undefined, h: string) => {
    if (!t || !row) return undefined
    const i = t.headers.findIndex((x) => x.trim().toLowerCase() === h.toLowerCase())
    return i < 0 ? undefined : row.cells[i] ?? ""
  }
  return (
    <Card title={`Side-by-side: ${la ? `LA line ${la.line}` : "no LA record"} ↔ ${ovdla ? `OVDLA row ${ovdla.line}` : "no OVDLA record"}`} actions={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="max-h-[50vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr><th className="py-1 pr-3">Column</th><th className="pr-3">Submitted LA</th><th>System OVDLA</th></tr></thead>
          <tbody className="divide-y">
            {headers.map((h) => {
              const a = value(tables.la, laRow, h)
              const b = value(tables.ovdla, yRow, h)
              const differs = a !== undefined && b !== undefined && a !== b
              return (
                <tr key={h} className={cn(differs && "bg-warning-bg")}>
                  <td className="py-1 pr-3 font-semibold">{h}</td>
                  <td className="pr-3 font-mono whitespace-pre">{a === undefined ? <span className="text-muted-foreground">—</span> : a || "·"}</td>
                  <td className="font-mono whitespace-pre">{b === undefined ? <span className="text-muted-foreground">—</span> : b || "·"}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Original text from both registered files. Highlighted rows differ in text (which may be formatting only). “—” means the column or record is absent.</p>
    </Card>
  )
}
