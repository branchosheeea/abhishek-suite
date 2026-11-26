"use client"

// Guarantee Claim Manager · quick set-up table (user's choice, 26 Nov 2026). One row per open claim, filled from what
// its emails suggest; values still suggested (not yet changed by you) are shown in italics. Tick the rows that are
// right and confirm them together. Each ticked row is saved on its own through the claim rules (one transaction per
// claim, with history and audit, refused if the claim changed meanwhile) and shows ✓ or why it was not saved.

import { Check, CircleAlert, Lightbulb } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { today, useVocabulary } from "./claim-forms"
import { API, type ClaimDetail, type ClaimRow, formatDay, getJson, openStatuses, query, RequestFailed, send, type SetupData, type Suggestion } from "./client"
import { useFrame } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"

type Values = { title: string; waiting_on: string; action_since: string; next_action: string; status: string }
type RowState = { values: Values; ticked: boolean; result: { ok: boolean; message: string } | null }

const isSetUp = (c: ClaimRow) => Boolean(c.owner && c.action_since && c.next_action)
const complete = (v: Values) => v.waiting_on !== "NONE" && Boolean(v.action_since) && v.next_action.trim() !== ""
const pick = (suggestions: Suggestion[], kind: string) => suggestions.find((s) => s.kind === kind)
const proposal = (suggestions: Suggestion[], kind: string, field: string) => pick(suggestions, kind)?.proposed[field] as string | undefined

function startValues(claim: ClaimRow, suggestions: Suggestion[]): Values {
  return {
    title: claim.title ?? proposal(suggestions, "TITLE", "title") ?? "",
    waiting_on: (claim.waiting_on !== "NONE" ? claim.waiting_on : proposal(suggestions, "OWNER", "waiting_on")) ?? "NONE",
    action_since: claim.action_since ?? proposal(suggestions, "PENDING_SINCE", "action_since") ?? "",
    next_action: claim.next_action ?? proposal(suggestions, "NEXT_ACTION", "next_action") ?? "",
    status: proposal(suggestions, "STAGE", "current_status") ?? claim.status,
  }
}

/** The suggestions the row was filled from; the server records each as accepted (same value) or changed. */
function usedKeys(claim: ClaimRow, suggestions: Suggestion[]): string[] {
  return [
    !claim.title && pick(suggestions, "TITLE"), claim.waiting_on === "NONE" && pick(suggestions, "OWNER"),
    !claim.action_since && pick(suggestions, "PENDING_SINCE"), !claim.next_action && pick(suggestions, "NEXT_ACTION"), pick(suggestions, "STAGE"),
  ].filter((s): s is Suggestion => Boolean(s)).map((s) => s.key)
}

export function RegisterSetup() {
  const { vesselParam, refresh, inspect } = useFrame()
  const vocab = useVocabulary()
  const { data, error, isLoading, mutate } = useSWR(`${API}/setup${query({ vessel: vesselParam })}`, (path: string) => getJson<SetupData>(path))
  const [showAll, setShowAll] = useState(false)
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [saving, setSaving] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const all = data?.claims ?? []
  const done = all.filter((i) => isSetUp(i.claim)).length
  const items = all.filter((i) => showAll || !isSetUp(i.claim))
  const rowKey = (c: ClaimRow) => `${c.id}:${c.updated_at}`

  // Rows start from the record and the suggestions; a claim saved (new updated_at) starts again from its record.
  useEffect(() => {
    if (!data) return
    setRows((old) => {
      const next: Record<string, RowState> = {}
      for (const { claim, suggestions } of data.claims) {
        const key = rowKey(claim)
        next[key] = old[key] ?? { values: startValues(claim, suggestions), ticked: false, result: null }
      }
      return next
    })
  }, [data])

  const ticked = useMemo(() => items.filter((i) => rows[rowKey(i.claim)]?.ticked), [items, rows])
  const update = (claim: ClaimRow, change: Partial<RowState>) => setRows((r) => ({ ...r, [rowKey(claim)]: { ...r[rowKey(claim)], ...change } }))

  const confirm = async () => {
    setSaving(true)
    const results: Record<number, { ok: boolean; message: string }> = {}
    for (const { claim, suggestions } of ticked) {
      const v = rows[rowKey(claim)].values
      try {
        await send<ClaimDetail>(`${API}/claims/${claim.id}/setup`, "POST", {
          fields: { title: v.title.trim() || null, waiting_on: v.waiting_on, action_since: v.action_since || null, next_action: v.next_action.trim() || null },
          status: v.status !== claim.status ? v.status : undefined, used: usedKeys(claim, suggestions), rejected: [], expected_updated_at: claim.updated_at,
        })
        results[claim.id] = { ok: true, message: "Saved" }
      } catch (e) {
        results[claim.id] = { ok: false, message: e instanceof RequestFailed ? e.message : String(e) }
      }
    }
    setRows((r) => {
      const next = { ...r }
      for (const { claim } of ticked) next[rowKey(claim)] = { ...next[rowKey(claim)], ticked: !results[claim.id].ok, result: results[claim.id] }
      return next
    })
    const saved = Object.values(results).filter((r) => r.ok).length
    const failed = Object.values(results).length - saved
    setSummary(`${saved} saved${failed ? `, ${failed} not saved (see the rows marked in red)` : ""}.`)
    setSaving(false)
    await mutate()
    void refresh()
  }

  const tickAllComplete = () => setRows((r) => {
    const next = { ...r }
    for (const { claim } of items) if (complete(next[rowKey(claim)]?.values ?? startValues(claim, []))) next[rowKey(claim)] = { ...next[rowKey(claim)], ticked: true }
    return next
  })

  return (
    <section aria-labelledby="setup" className="flex flex-col gap-4 pb-20">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="setup" className="text-lg font-semibold">Set up claims</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Each row is filled from the claim’s emails (<i>italics</i> = suggested). Correct anything wrong, tick the rows that are right, and confirm.
            Saved with history under your name.
          </p>
        </div>
        {data && (
          <div className="flex items-center gap-3 text-sm">
            <span className="tabular-nums"><b>{done}</b> of {all.length} set up</span>
            <label className="flex items-center gap-2"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="size-4" /> Show set-up claims too</label>
          </div>
        )}
      </div>

      {error && <ErrorPanel error={error} what="the set-up table" />}
      {!error && (isLoading || !data) && <Loading label="Reading the claims and their emails"><Skeleton className="h-96" /></Loading>}
      {data && items.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Every open claim is set up.</p>}

      {data && items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full min-w-[1180px] text-sm">
            <caption className="sr-only">Claims to set up, filled from their emails</caption>
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="w-10 px-3 py-2.5 font-medium"><span className="sr-only">Tick</span></th>
                <th scope="col" className="px-2 py-2.5 font-medium">Claim</th>
                <th scope="col" className="w-40 px-2 py-2.5 font-medium">With</th>
                <th scope="col" className="w-36 px-2 py-2.5 font-medium">Since</th>
                <th scope="col" className="px-2 py-2.5 font-medium">Next step</th>
                <th scope="col" className="w-48 px-2 py-2.5 font-medium">Stage</th>
                <th scope="col" className="w-72 px-3 py-2.5 font-medium">Why (from the email)</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ claim, suggestions }) => {
                const state = rows[rowKey(claim)]
                if (!state) return null
                const v = state.values
                const ready = complete(v)
                const set = (field: keyof Values) => (e: { target: { value: string } }) => update(claim, { values: { ...v, [field]: e.target.value }, result: null })
                const suggested = (field: keyof Values, kind: string, key: string) => proposal(suggestions, kind, key) !== undefined && v[field] === proposal(suggestions, kind, key)
                const cell = (on: boolean) => cn("h-9 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50", on && "italic")
                const why = pick(suggestions, "OWNER") ?? pick(suggestions, "NEXT_ACTION") ?? suggestions[0]
                const flags = suggestions.filter((s) => s.kind === "CLOSURE" || s.kind === "LINK" || s.kind === "CONFLICT")
                return (
                  <tr key={claim.id} className={cn("border-b align-top last:border-0", state.ticked && "bg-primary/5")}>
                    <td className="px-3 py-3">
                      <input type="checkbox" checked={state.ticked} disabled={!ready || saving} onChange={(e) => update(claim, { ticked: e.target.checked })}
                        aria-label={`Tick ${claim.gc_number}`} title={ready ? "Tick to confirm" : "Fill With, Since and Next step first"} className="mt-2 size-4" />
                    </td>
                    <td className="px-2 py-3">
                      <button type="button" onClick={(e) => inspect(claim.id, e.currentTarget)} className="text-left font-semibold text-primary underline-offset-4 hover:underline">{claim.gc_number}</button>
                      <input value={v.title} onChange={set("title")} maxLength={2000} placeholder="Title" aria-label={`${claim.gc_number} title`}
                        className={cn(cell(suggested("title", "TITLE", "title")), "mt-1")} />
                      {state.result && (
                        <p className={cn("mt-1 flex items-start gap-1 text-xs", state.result.ok ? "text-success" : "text-destructive")}>
                          {state.result.ok ? <Check className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5 shrink-0" aria-hidden />} {state.result.message}
                        </p>
                      )}
                    </td>
                    <td className="px-2 py-3">
                      <select value={v.waiting_on} onChange={set("waiting_on")} aria-label={`${claim.gc_number} with`} className={cell(suggested("waiting_on", "OWNER", "waiting_on"))}>
                        {(vocab?.waiting_on ?? [v.waiting_on]).map((w) => <option key={w} value={w}>{vocab?.owner_labels[w] ?? w}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-3">
                      <input type="date" value={v.action_since} max={today()} onChange={set("action_since")} aria-label={`${claim.gc_number} since`}
                        className={cell(suggested("action_since", "PENDING_SINCE", "action_since"))} />
                    </td>
                    <td className="px-2 py-3">
                      <textarea value={v.next_action} onChange={set("next_action")} rows={2} maxLength={2000} aria-label={`${claim.gc_number} next step`}
                        className={cn(cell(suggested("next_action", "NEXT_ACTION", "next_action")), "h-auto py-1.5")} />
                    </td>
                    <td className="px-2 py-3">
                      <select value={v.status} onChange={set("status")} aria-label={`${claim.gc_number} stage`} className={cell(suggested("status", "STAGE", "current_status"))}>
                        {(vocab ? openStatuses(vocab) : [v.status]).map((s) => <option key={s} value={s}>{vocab?.labels[s] ?? s}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {why ? (
                        <>
                          <p className="text-muted-foreground">{why.evidence_date ? formatDay(why.evidence_date) : ""} · {why.evidence_direction === "OUTGOING" ? "you wrote" : `${why.evidence_author} wrote`}:</p>
                          <p className="line-clamp-3 italic" title={why.quote}>“{why.quote}”</p>
                        </>
                      ) : <p className="text-muted-foreground">No suggestion in the emails.</p>}
                      {flags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {flags.map((s) => (
                            <button key={s.key} type="button" onClick={(e) => inspect(claim.id, e.currentTarget)}
                              className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] hover:bg-muted">
                              <Lightbulb className="size-3" aria-hidden />
                              {s.kind === "CLOSURE" ? "Says it can be closed" : s.kind === "LINK" ? "Email also names this claim" : `Typo? ${String(s.proposed.mentioned)}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && items.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
          <span className="text-sm tabular-nums"><b>{ticked.length}</b> ticked</span>
          <button type="button" onClick={tickAllComplete} disabled={saving} className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-10 px-4")}>Tick all filled rows</button>
          <button type="button" onClick={confirm} disabled={saving || ticked.length === 0} className={cn(buttonVariants({ size: "lg" }), "h-10 px-4")}>
            <Check aria-hidden /> {saving ? "Saving…" : `Confirm ${ticked.length} ticked`}
          </button>
          {summary && <span role="status" className="text-sm font-medium">{summary}</span>}
          <span className="text-xs text-muted-foreground">Closing, linking and typo checks are in the side panel: click the GC number or a hint.</span>
        </div>
      )}
    </section>
  )
}
