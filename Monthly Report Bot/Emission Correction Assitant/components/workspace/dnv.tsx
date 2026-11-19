"use client"

import { useState } from "react"
import { DNV_CATEGORIES, OUTCOME_LABEL, type DnvCategory } from "@/lib/engine/correlate"
import { send } from "../api"
import { Banner, Button, Card, Empty, Field, inputClass, Pill, type Tone } from "../ui"
import { DnvImport } from "./dnv-import"
import type { Ctx, DnvEntry } from "./types"

const OUTCOME_TONE: Record<string, Tone> = { "independently-reproduced": "warning", "not-reproduced": "neutral", unresolved: "info" }

function categoryHint(category: DnvCategory): string {
  const c = DNV_CATEGORIES[category]
  if (c.rules.length === 0) return category === "AIS" ? "No AIS data is available, so this item stays Unresolved." : "No independent check covers this; it is recorded and stays Unresolved."
  return `Compared with checks ${c.rules.join(", ")}${c.scope === "segment" ? " over the voyage / port stay containing the event time" : " within ±24 h of the event time"}.`
}

const EMPTY = { category: "FUEL_AVAILABLE" as DnvCategory, severity: "error", description: "", eventUtc: "", fromUtc: "", toUtc: "", fuel: "", quantity: "", portCodes: "", voyageOrPortStay: "", imo: "", entryMethod: "manual", confirmed: true }

export function DnvPanel({ ctx }: { ctx: Ctx }) {
  const { data, result } = ctx
  const [form, setForm] = useState({ ...EMPTY, imo: data.session.imo ?? "" })
  const [busy, setBusy] = useState(false)
  const runIncludes = new Set(ctx.run?.dnvIds ?? [])

  // datetime-local gives "YYYY-MM-DDTHH:MM" (or with seconds); the value is entered as UTC.
  const toIso = (v: string) => (v.length === 16 ? `${v}:00Z` : `${v}Z`)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await send("POST", `/api/sessions/${data.session._id}/dnv`, {
        ...form,
        eventUtc: form.eventUtc ? toIso(form.eventUtc) : null,
        fromUtc: form.fromUtc ? toIso(form.fromUtc) : null,
        toUtc: form.toUtc ? toIso(form.toUtc) : null,
        confirmed: form.entryMethod === "manual" ? true : form.confirmed,
      })
      setForm({ ...EMPTY, imo: data.session.imo ?? "" })
      await ctx.reload()
    } catch (error) {
      ctx.setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unconfirmed = data.dnv.filter((d) => !d.confirmed && !d.withdrawn)

  async function confirmAll() {
    if (!confirm(`Confirm ${unconfirmed.length} entries as matching DNV's own screen? Only do this after comparing them with OVD Admin.`)) return
    try {
      for (const d of unconfirmed) await send("PATCH", `/api/sessions/${data.session._id}/dnv/${d.id}`, { action: "confirm" })
      await ctx.reload()
    } catch (error) {
      ctx.setError((error as Error).message)
    }
  }

  async function act(d: DnvEntry, action: "confirm" | "withdraw") {
    if (action === "withdraw" && !confirm("Withdraw this DNV entry? It stays in the audit history and is excluded from later runs.")) return
    try {
      await send("PATCH", `/api/sessions/${data.session._id}/dnv/${d.id}`, { action })
      await ctx.reload()
    } catch (error) {
      ctx.setError((error as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-5">
    <DnvImport ctx={ctx} />
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card
        title={`DNV errors and warnings in this session${data.dnv.length ? ` (${data.dnv.filter((d) => !d.withdrawn).length})` : ""}`}
        actions={unconfirmed.length > 1 && <Button variant="secondary" className="h-8" onClick={confirmAll}>Confirm all {unconfirmed.length}</Button>}
      >
        {data.dnv.length === 0 ? (
          <Empty>No DNV result entered yet. Enter each error or warning as OVD Admin / DNV Emissions Connect shows it (one row per item); the module then checks whether the independent rules reproduce it. Nothing is sent back to DNV.</Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {data.dnv.map((d) => {
              const c = result?.correlations.find((x) => x.dnvId === d.id)
              return (
                <li key={d.id} className={d.withdrawn ? "py-3 opacity-60" : "py-3"}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={d.severity === "error" ? "critical" : "warning"}>DNV {d.severity}</Pill>
                    <span className="text-sm font-semibold">{DNV_CATEGORIES[d.category].label}</span>
                    <Pill tone="neutral" icon={false}>DNV Reported</Pill>
                    {c && runIncludes.has(d.id) && <Pill tone={OUTCOME_TONE[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Pill>}
                    {!c || !runIncludes.has(d.id) ? !d.withdrawn && <Pill tone="info">Not in the selected run — run again</Pill> : null}
                    {!d.confirmed && <Pill tone="warning">Transcription not confirmed</Pill>}
                    {d.withdrawn && <Pill>Withdrawn</Pill>}
                  </div>
                  <p className="mt-1 text-sm">{d.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {[d.eventUtc && `event ${d.eventUtc}`, d.fromUtc && `from ${d.fromUtc}`, d.toUtc && `to ${d.toUtc}`, d.fuel && `fuel ${d.fuel}`, d.quantity && `quantity ${d.quantity}`, d.portCodes.length > 0 && `ports ${d.portCodes.join(", ")}`, d.voyageOrPortStay, d.evidence ? `read from ${d.evidence.name ?? "a screenshot"} (SHA-256 ${d.evidence.sha256.slice(0, 12)}…) by ${d.createdBy}` : `${d.entryMethod} entry by ${d.createdBy}`].filter(Boolean).join(" · ")}
                  </p>
                  {c && runIncludes.has(d.id) && (
                    <div className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs">
                      <p>{c.explanation}</p>
                      {c.matchedFindings.length > 0 && (
                        <p className="mt-1">
                          {c.outcome === "independently-reproduced" ? "Reproducing findings:" : "Independent findings in the window (not a reproduction):"}{" "}
                          {c.matchedFindings.map((id) => <button key={id} className="mr-2 font-mono text-primary hover:underline" onClick={() => ctx.openFinding(id)}>{id}</button>)}
                        </p>
                      )}
                      {c.possibleCauses.length > 0 && (
                        <div className="mt-1">
                          <p className="font-semibold">Possible causes (hypotheses, not verified):</p>
                          <ul className="list-disc pl-5">{c.possibleCauses.map((p) => <li key={p}>{p}</li>)}</ul>
                        </div>
                      )}
                      {c.relatedDnvIds.length > 0 && <p className="mt-1">Related DNV items (share a source record): {c.relatedDnvIds.length}</p>}
                    </div>
                  )}
                  {!d.withdrawn && (
                    <div className="mt-2 flex gap-2">
                      {!d.confirmed && <Button variant="secondary" className="h-8" onClick={() => act(d, "confirm")}>Confirm matches DNV</Button>}
                      <Button variant="ghost" className="h-8" onClick={() => act(d, "withdraw")}>Withdraw</Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Add one item by hand">
        <form onSubmit={add} className="flex flex-col gap-3">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
            <Field label="Check (as named in OVD Admin)" hint={categoryHint(form.category)}>
              <select className={inputClass} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as DnvCategory })}>
                {Object.entries(DNV_CATEGORIES).map(([id, c]) => <option key={id} value={id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Severity">
              <select className={inputClass} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
              </select>
            </Field>
          </div>
          <Field label="Message (as DNV states it)">
            <textarea className={`${inputClass} h-20 py-1.5`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={2000} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Event time (UTC)" hint="The date and time shown on the OVD Admin row.">
              <input type="datetime-local" className={inputClass} value={form.eventUtc} onChange={(e) => setForm({ ...form, eventUtc: e.target.value })} />
            </Field>
            <Field label="Segment" hint="UnderWay or InPort, as on the row.">
              <input className={inputClass} list="dnv-segments" value={form.voyageOrPortStay} onChange={(e) => setForm({ ...form, voyageOrPortStay: e.target.value })} placeholder="UnderWay / InPort" />
              <datalist id="dnv-segments"><option value="UnderWay" /><option value="InPort" /></datalist>
            </Field>
          </div>
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Or give a time window instead (DNV Emissions Connect lists)</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="From (UTC)"><input type="datetime-local" className={inputClass} value={form.fromUtc} onChange={(e) => setForm({ ...form, fromUtc: e.target.value })} /></Field>
              <Field label="To (UTC)"><input type="datetime-local" className={inputClass} value={form.toUtc} onChange={(e) => setForm({ ...form, toUtc: e.target.value })} /></Field>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">When an event time is given it is used and the window is kept for reference only.</p>
          </details>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Fuel"><input className={inputClass} value={form.fuel} onChange={(e) => setForm({ ...form, fuel: e.target.value })} placeholder="e.g. LFO" /></Field>
            <Field label="Quantity"><input className={inputClass} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="as stated" /></Field>
            <Field label="IMO"><input className={inputClass} value={form.imo} onChange={(e) => setForm({ ...form, imo: e.target.value })} /></Field>
          </div>
          <Field label="Port codes"><input className={inputClass} value={form.portCodes} onChange={(e) => setForm({ ...form, portCodes: e.target.value })} placeholder="SGSIN, NLRTM" /></Field>
          <Field label="Entered from" hint="Screenshot transcriptions stay unconfirmed until you confirm them against DNV's own screen.">
            <select className={inputClass} value={form.entryMethod} onChange={(e) => setForm({ ...form, entryMethod: e.target.value, confirmed: e.target.value === "manual" })}>
              <option value="manual">Typed from DNV Emissions Connect</option>
              <option value="screenshot">Transcribed from a screenshot</option>
              <option value="import">Imported list</option>
            </select>
          </Field>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Add DNV entry"}</Button>
          <p className="text-xs text-muted-foreground">Times are UTC. DNV entries are diagnostic records; they never change a source file. Run the validation again to correlate new entries.</p>
        </form>
        {!data.session.imo && <div className="mt-3"><Banner tone="info" title="Tip">Set the vessel IMO in Settings so DNV entries and files can be checked against it.</Banner></div>}
      </Card>
    </div>
    </div>
  )
}
