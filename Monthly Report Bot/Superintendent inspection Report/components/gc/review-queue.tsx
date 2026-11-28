"use client"

// Guarantee Claim Manager · Review Queue: emails NeraVeda could not link to a claim by itself. Each card offers the
// likely resolution (worked out in Python): register a new GC number and link the email, link it to an existing
// claim, link one email to several claims, or mark it not relevant. Saving uses the desktop GC Manager's own rules
// (Repository.resolve_review) with audit under your name; nothing is deleted.

import { ArrowDownLeft, ArrowUpRight, Check, Link2, Plus, X } from "lucide-react"
import { useState } from "react"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { inputStyle } from "./claim-forms"
import { API, formatStamp, getJson, query, REVIEW_LABEL, RequestFailed, type ReviewData, type ReviewItem, send } from "./client"
import { useFrame } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"

export function ReviewQueue() {
  const { vesselParam, refresh } = useFrame()
  const { data, error, isLoading, mutate } = useSWR(`${API}/reviews${query({ vessel: vesselParam })}`, (path: string) => getJson<ReviewData>(path))
  const [done, setDone] = useState<string | null>(null)
  const changed = (message: string) => { setDone(message); void mutate(); void refresh() }
  const counts = new Map<string, number>()
  for (const item of data?.items ?? []) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)

  return (
    <section aria-labelledby="reviews" className="flex flex-col gap-4">
      <div>
        <h2 id="reviews" className="text-lg font-semibold">Review Queue</h2>
        <p className="text-sm text-muted-foreground">Emails NeraVeda could not link to a claim by itself. Choose what each one is; nothing is deleted.</p>
      </div>
      {data && data.items.length > 0 && (
        <p className="text-sm text-muted-foreground">{[...counts.entries()].map(([t, n]) => `${n} ${REVIEW_LABEL[t]?.toLowerCase() ?? t}`).join(" · ")}</p>
      )}
      {done && <p role="status" className="flex items-center gap-1.5 text-sm text-success"><Check className="size-4" aria-hidden /> {done}</p>}
      {error && <ErrorPanel error={error} what="the Review Queue" />}
      {!error && (isLoading || !data) && <Loading label="Loading the Review Queue"><div className="flex flex-col gap-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div></Loading>}
      {data && data.items.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No email waits for review.</p>}
      <ul className="flex flex-col gap-3">
        {data?.items.map((item) => <ReviewCard key={item.id} item={item} data={data} onDone={changed} />)}
      </ul>
    </section>
  )
}

function ReviewCard({ item, data, onDone }: { item: ReviewItem; data: ReviewData; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<"" | "other" | "multiple" | "irrelevant">("")
  const [claimId, setClaimId] = useState("")
  const [picked, setPicked] = useState<number[]>(item.proposal?.action === "MULTIPLE" ? item.proposal.claims.map((c) => c.id) : [])
  const [notes, setNotes] = useState("")
  const [alsoSame, setAlsoSame] = useState(true)
  const p = item.proposal
  const Arrow = item.direction === "OUTGOING" ? ArrowUpRight : ArrowDownLeft

  const resolve = async (body: Record<string, unknown>, message: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await send<{ linked_emails: number }>(`${API}/reviews/${item.id}`, "POST", body)
      onDone(result.linked_emails > 1 ? `${message} (${result.linked_emails} emails linked).` : `${message}.`)
    } catch (e) {
      setError(e instanceof RequestFailed ? e.message : String(e))
      setBusy(false)
    }
  }
  const vessel = data.vessel?.id
  const small = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")
  const chosen = data.claims.find((c) => String(c.id) === claimId)
  const needsReason = chosen && item.gc_numbers.length === 1 && chosen.gc_number !== item.gc_numbers[0]

  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex gap-3">
        <Arrow className="mt-1 size-4 shrink-0 text-muted-foreground" aria-label={item.direction === "OUTGOING" ? "Sent" : "Received"} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{item.subject}</span>
            <Badge variant="outline">{REVIEW_LABEL[item.type] ?? item.type}</Badge>
          </p>
          <p className="text-xs text-muted-foreground">{item.message_datetime ? formatStamp(item.message_datetime) : "No date"} · {item.reason}</p>
          {item.body_preview && <p className="line-clamp-2 text-sm text-foreground/75">{item.body_preview}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-7">
        {p && (p.action === "REGISTER" || p.action === "LINK") && (
          <>
            <button type="button" disabled={busy || !vessel} className={cn(buttonVariants({ size: "sm" }), "h-9")}
              onClick={() => resolve(p.action === "REGISTER"
                ? { action: "link", register: true, vessel_id: vessel, link_matching: alsoSame && p.same_gc_emails > 0 }
                : { action: "link", claim_id: p.claim_id, vessel_id: vessel, link_matching: alsoSame && p.same_gc_emails > 0 },
                p.action === "REGISTER" ? `${p.gc_number} registered and the email linked` : `Linked to ${p.gc_number}`)}>
              {p.action === "REGISTER" ? <><Plus aria-hidden /> Register {p.gc_number} and link</> : <><Link2 aria-hidden /> Link to {p.gc_number}</>}
            </button>
            {p.same_gc_emails > 0 && (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={alsoSame} onChange={(e) => setAlsoSame(e.target.checked)} className="size-4" />
                also link the {p.same_gc_emails} other {p.same_gc_emails === 1 ? "email" : "emails"} about {p.gc_number}
              </label>
            )}
          </>
        )}
        {p?.action === "MULTIPLE" && <button type="button" onClick={() => setMode(mode === "multiple" ? "" : "multiple")} className={small} aria-expanded={mode === "multiple"}><Link2 aria-hidden /> Link to several claims…</button>}
        <button type="button" onClick={() => setMode(mode === "other" ? "" : "other")} className={small} aria-expanded={mode === "other"}><Link2 aria-hidden /> Link to {p ? "another" : "a"} claim…</button>
        <button type="button" onClick={() => setMode(mode === "irrelevant" ? "" : "irrelevant")} className={cn(small, "text-muted-foreground")} aria-expanded={mode === "irrelevant"}><X aria-hidden /> Not relevant…</button>
      </div>

      {mode === "other" && (
        <form className="ml-7 flex flex-wrap items-end gap-2 rounded-lg border p-3" onSubmit={(e) => {
          e.preventDefault()
          resolve({ action: "link", claim_id: Number(claimId), vessel_id: vessel, notes }, `Linked to ${chosen?.gc_number}`)
        }}>
          <label className="flex min-w-56 flex-col gap-1 text-sm">Claim of {data.vessel?.name}
            <select required value={claimId} onChange={(e) => setClaimId(e.target.value)} className={inputStyle}>
              <option value="">Choose…</option>
              {data.claims.map((c) => <option key={c.id} value={c.id}>{c.gc_number}{c.title ? ` · ${c.title}` : ""}</option>)}
            </select>
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">{needsReason ? "Reason (required: the GC number differs)" : "Reason (optional)"}
            <input value={notes} required={Boolean(needsReason)} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={inputStyle} />
          </label>
          <button type="submit" disabled={busy} className={cn(buttonVariants({ size: "sm" }), "h-10")}>Link</button>
        </form>
      )}

      {mode === "multiple" && p?.action === "MULTIPLE" && (
        <form className="ml-7 flex flex-col gap-2 rounded-lg border p-3 text-sm" onSubmit={(e) => {
          e.preventDefault()
          resolve({ action: "multiple", claim_ids: picked, notes }, `Linked to ${picked.length} claims`)
        }}>
          <div className="flex flex-wrap gap-3">
            {p.claims.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} className="size-4" />
                {c.gc_number}
              </label>
            ))}
          </div>
          {p.missing.length > 0 && <p className="text-xs text-muted-foreground">Not registered yet: {p.missing.join(", ")}.</p>}
          <label className="flex flex-col gap-1">Why this email concerns these claims (required)
            <input required value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={inputStyle} />
          </label>
          <div><button type="submit" disabled={busy || picked.length < 2} className={cn(buttonVariants({ size: "sm" }), "h-9")}>Link to {picked.length} claims</button></div>
        </form>
      )}

      {mode === "irrelevant" && (
        <form className="ml-7 flex flex-wrap items-end gap-2 rounded-lg border p-3" onSubmit={(e) => {
          e.preventDefault()
          resolve({ action: "irrelevant", notes }, "Marked not relevant")
        }}>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">Why it is not relevant (for example: another vessel’s claim)
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className={inputStyle} />
          </label>
          <button type="submit" disabled={busy} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-10")}>Mark not relevant</button>
          <p className="w-full text-xs text-muted-foreground">The email stays stored; it only leaves this queue.</p>
        </form>
      )}

      {error && <p role="alert" className="pl-7 text-sm text-destructive">Not saved: {error}</p>}
    </li>
  )
}
