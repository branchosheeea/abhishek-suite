"use client"

import { useMemo, useState } from "react"
import { EVIDENCE_LABEL, RULE_GROUP_LABEL, type EvidenceClass, type Finding, type RuleGroup } from "@/lib/engine/types"
import { RULE_BY_ID } from "@/lib/engine/rules/registry"
import { type FindingFilter, matchesFilter } from "@/lib/export/findings-filter"
import { formatTime, send } from "../api"
import { Button, Card, cn, Empty, inputClass, Pill, severityTone } from "../ui"
import { ExportFindings } from "./export-findings"
import { type Ctx, STATUS_OPTIONS } from "./types"

export function FindingsPanel({ ctx, selected, onSelect }: { ctx: Ctx; selected: string | null; onSelect: (id: string | null) => void }) {
  const { result, data } = ctx
  const [group, setGroup] = useState<RuleGroup | "">("")
  const [severity, setSeverity] = useState<FindingFilter["severity"]>("")
  const [evidence, setEvidence] = useState<EvidenceClass | "">("")
  const [status, setStatus] = useState("")
  const [query, setQuery] = useState("")
  const [exporting, setExporting] = useState(false)
  const statusOf = useMemo(() => new Map(data.investigation.statuses.map((s) => [s.findingId, s.status])), [data.investigation.statuses])
  const filter: FindingFilter = useMemo(() => ({ group, severity, evidence, status, query }), [group, severity, evidence, status, query])
  const findings = useMemo(() => (result?.findings ?? []).filter((f) => matchesFilter(f, (id) => statusOf.get(id) ?? "New", filter)), [result, filter, statusOf])
  if (!result) return <Empty>Run the validation to list findings.</Empty>
  const current = findings.find((f) => f.id === selected) ?? result.findings.find((f) => f.id === selected) ?? null

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {exporting && ctx.run && <ExportFindings ctx={ctx} filter={filter} shown={findings.length} onClose={() => setExporting(false)} />}
      <Card
        title={`Findings (${findings.length} of ${result.findings.length})`}
        actions={
          <>
            <input className={cn(inputClass, "w-48")} placeholder="Search text, rule or line" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search findings" />
            <Button variant="secondary" onClick={() => setExporting(true)} disabled={!ctx.run || ctx.run.state !== "completed"} title="Export the findings to Excel or PDF">Export</Button>
          </>
        }
      >
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <select className={inputClass} value={group} onChange={(e) => setGroup(e.target.value as RuleGroup | "")} aria-label="Rule group">
            <option value="">All groups</option>
            {(Object.keys(RULE_GROUP_LABEL) as RuleGroup[]).map((g) => <option key={g} value={g}>{g} · {RULE_GROUP_LABEL[g]}</option>)}
          </select>
          <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value as FindingFilter["severity"])} aria-label="Severity">
            <option value="">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option>
          </select>
          <select className={inputClass} value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceClass | "")} aria-label="Evidence">
            <option value="">All evidence</option>
            {(Object.keys(EVIDENCE_LABEL) as EvidenceClass[]).map((k) => <option key={k} value={k}>{EVIDENCE_LABEL[k]}</option>)}
          </select>
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Investigation status">
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        {findings.length === 0 ? <Empty>No finding matches the filters.</Empty> : (
          <ul className="flex max-h-[70vh] flex-col divide-y overflow-auto">
            {findings.map((f) => (
              <li key={f.id}>
                <button onClick={() => onSelect(f.id)} className={cn("flex w-full flex-col gap-1 px-2 py-2.5 text-left hover:bg-muted", f.id === selected && "bg-info-bg")}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={severityTone(f.severity)}>{f.severity}</Pill>
                    <span className="font-mono text-xs text-muted-foreground">{f.ruleId}</span>
                    <span className="text-xs text-muted-foreground">{EVIDENCE_LABEL[f.evidence]}{f.schemaVerified ? "" : " (unverified schema)"}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{statusOf.get(f.id) ?? "New"}</span>
                  </span>
                  <span className="text-sm font-semibold">{f.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {current ? <FindingDetail key={current.id} ctx={ctx} f={current} status={statusOf.get(current.id) ?? "New"} /> : <Card title="Finding detail"><Empty>Select a finding to see its source records, calculation and investigation.</Empty></Card>}
    </div>
  )
}

function FindingDetail({ ctx, f, status }: { ctx: Ctx; f: Finding; status: string }) {
  const { data } = ctx
  const def = RULE_BY_ID.get(f.ruleId)
  const [note, setNote] = useState("")
  const [linkTo, setLinkTo] = useState("")
  const [linkReason, setLinkReason] = useState("")
  const notes = data.investigation.notes.filter((n) => n.findingId === f.id)
  const history = data.investigation.history.filter((h) => h.findingId === f.id)
  const links = data.investigation.links.filter((l) => l.a === f.id || l.b === f.id)
  const sid = data.session._id

  const call = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      await ctx.reload()
    } catch (e) {
      ctx.setError((e as Error).message)
    }
  }

  return (
    <Card title={<span className="flex flex-wrap items-center gap-2"><Pill tone={severityTone(f.severity)}>{f.severity}</Pill>{f.ruleId} · {def?.name}</span>}>
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <h3 className="text-base font-bold">{f.title}</h3>
          <p className="mt-1">{f.detail}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Evidence: <strong>{EVIDENCE_LABEL[f.evidence]}</strong>{!f.schemaVerified && " · computed through the superseded provisional schema"} · rule {f.ruleId} v{f.ruleVersion} · {RULE_GROUP_LABEL[f.group]}
            {def?.specReference ? ` · reference: ${def.specReference}` : " · no DNV specification reference (independent check)"}
          </p>
        </div>

        {f.refs.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">SOURCE RECORDS</h4>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {groupRefs(f).map(([kind, lines]) => (
                <Button key={kind} variant="secondary" className="h-7 text-xs" onClick={() => ctx.focus(f.refs.filter((r) => r.kind === kind), f.columns)}>
                  {kind} {kind === "OVDLA" ? "rows" : "lines"} {lines.slice(0, 8).join(", ")}{lines.length > 8 ? ` +${lines.length - 8}` : ""} →
                </Button>
              ))}
            </div>
            {f.columns && <p className="mt-1 text-xs text-muted-foreground">Columns: {f.columns.join(", ")}</p>}
          </div>
        )}

        {f.calculation && (
          <div className="rounded-lg border p-3">
            <h4 className="text-xs font-bold text-muted-foreground">CALCULATION</h4>
            <p className="mt-1 text-xs">{f.calculation.formula}</p>
            <table className="mt-2 w-full text-xs">
              <tbody className="divide-y">
                {f.calculation.inputs.map((i, n) => (
                  <tr key={n}>
                    <td className="py-1 pr-3">{i.label}</td>
                    <td className="pr-3 text-right font-mono tabular-nums">{i.value}</td>
                    <td className="text-muted-foreground">{i.ref ? <button className="text-primary hover:underline" onClick={() => ctx.focus([i.ref!], i.column ? [i.column] : undefined)}>{i.ref.kind} {i.ref.kind === "OVDLA" ? "row" : "line"} {i.ref.line}</button> : null}{i.column ? ` · ${i.column}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="mt-2 font-mono text-xs">{f.calculation.steps.map((s) => <li key={s}>{s}</li>)}</ul>
            <p className="mt-1 text-sm font-bold">Result: {f.calculation.result}</p>
            {f.calculation.qualifications.length > 0 && (
              <div className="mt-2 rounded-md bg-info-bg px-2.5 py-2 text-xs">
                <p className="font-semibold">Qualifications</p>
                <ul className="list-disc pl-4">{f.calculation.qualifications.map((q) => <li key={q}>{q}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        {f.possibleCauses && f.possibleCauses.length > 0 && (
          <div>
            <h4 className="text-xs font-bold text-muted-foreground">POSSIBLE CAUSES (HYPOTHESES — NOT VERIFIED)</h4>
            <ul className="mt-1 list-disc pl-5 text-sm">{f.possibleCauses.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        )}

        <div>
          <h4 className="text-xs font-bold text-muted-foreground">RECOMMENDED CHECK</h4>
          <p className="mt-1">{f.recommendation}</p>
        </div>

        <div className="flex flex-col gap-2 border-t pt-3">
          <label className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Investigation status
            <select className={cn(inputClass, "w-auto")} value={status} onChange={(e) => call(() => send("POST", `/api/sessions/${sid}/findings/${f.id}/status`, { status: e.target.value }))}>
              {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          {history.length > 0 && <ul className="text-xs text-muted-foreground">{history.map((h) => <li key={h._id}>{formatTime(h.at)} · {h.by}: {h.from ?? "New"} → {h.to}</li>)}</ul>}

          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void call(async () => { await send("POST", `/api/sessions/${sid}/notes`, { findingId: f.id, text: note }); setNote("") }) }}>
            <textarea className={`${inputClass} h-16 py-1.5`} placeholder="Add an investigation note (kept separately from the source data; notes are never edited or deleted)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
            <Button type="submit" variant="secondary" disabled={!note.trim()}>Add note</Button>
          </form>
          {notes.length > 0 && <ul className="flex flex-col gap-1.5">{notes.map((n) => <li key={n._id} className="rounded-md bg-muted px-2.5 py-1.5 text-xs"><span className="text-muted-foreground">{formatTime(n.createdAt)} · {n.createdBy}</span><br />{n.text}</li>)}</ul>}

          <details className="text-xs">
            <summary className="cursor-pointer font-semibold text-primary">Link to a related finding ({links.length})</summary>
            {links.map((l) => <p key={l._id} className="mt-1">{l.a === f.id ? l.b : l.a}: {l.reason}</p>)}
            <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void call(async () => { await send("POST", `/api/sessions/${sid}/notes`, { link: { a: f.id, b: linkTo, reason: linkReason } }); setLinkTo(""); setLinkReason("") }) }}>
              <select className={inputClass} value={linkTo} onChange={(e) => setLinkTo(e.target.value)} required>
                <option value="">Choose a finding…</option>
                {(ctx.result?.findings ?? []).filter((x) => x.id !== f.id).map((x) => <option key={x.id} value={x.id}>{x.ruleId} · {x.title.slice(0, 80)}</option>)}
              </select>
              <input className={inputClass} placeholder="Evidence for the link (required)" value={linkReason} onChange={(e) => setLinkReason(e.target.value)} required maxLength={1000} />
              <Button type="submit" variant="secondary">Link findings</Button>
            </form>
          </details>
        </div>
      </div>
    </Card>
  )
}

function groupRefs(f: Finding): [string, number[]][] {
  const m = new Map<string, number[]>()
  for (const r of f.refs) m.set(r.kind, [...new Set([...(m.get(r.kind) ?? []), r.line])])
  return [...m.entries()]
}
