"use client"

// Guarantee Claim Manager · Claim Inspector: a side panel on the right (about 440 px) so the Command Centre stays in
// place. Not modal: the page behind still works. Opening moves focus into the panel, Esc closes it, and focus returns
// to the row that opened it (spec 26 and 36). Everything shown comes from the same claim view as the full workspace.

import { ArrowRight, Copy, X } from "lucide-react"
import Link from "next/link"
import { type ReactNode, useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BallFacts, Chips, ClaimTitle, Note, Provenance, Reasons } from "./assessment"
import { API, type ClaimDetail, formatStamp, getJson } from "./client"
import { EmailItem } from "./claim-workspace"
import { useFrame } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"
import { SuggestionActions } from "./suggestion-actions"

export function ClaimInspector({ claimId, href, onClose }: { claimId: number; href: (path: string) => string; onClose: () => void }) {
  const { data, error, isLoading, mutate } = useSWR(`${API}/claims/${claimId}`, (path: string) => getJson<ClaimDetail>(path))
  const { refresh } = useFrame()
  const changed = () => { void mutate(); void refresh() }
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    heading.current?.focus()
  }, [claimId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const claim = data?.claim
  const a = claim?.assessment
  return (
    <aside
      role="complementary"
      aria-label="Claim Inspector"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[460px] flex-col border-l bg-background shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <p className="text-[11px] font-bold tracking-wider text-muted-foreground">CLAIM INSPECTOR</p>
          <h2 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
            {claim ? claim.gc_number : "Loading claim"}
          </h2>
          {claim && (
            <p className="text-sm text-foreground/80">
              <ClaimTitle title={claim.title} assessment={claim.assessment} />{claim.equipment_system && <> · {claim.equipment_system}</>}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Close the Claim Inspector (Esc)" className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <X className="size-5" aria-hidden />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {error && <ErrorPanel error={error} what="this claim" />}
        {!error && (isLoading || !data) && (
          <Loading label="Loading the claim">
            <div className="flex flex-col gap-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-36" /><Skeleton className="h-24" /><Skeleton className="h-40" /></div>
          </Loading>
        )}
        {data && claim && a && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Chips chips={a.chips} />
              <p className="text-sm"><span className="text-muted-foreground">Stage: </span><span className="font-medium">{claim.status_label}</span></p>
              <Note text={a.note} />
            </div>

            <Block title="With · since · due">
              <BallFacts assessment={a} />
            </Block>

            {a.reasons.length > 0 && (
              <Block title="Why it is listed">
                <Reasons reasons={a.reasons} />
              </Block>
            )}

            {a.next_action && (
              <Block title="Next step">
                <Provenance action={a.next_action} />
                <p className="mt-2 text-[15px] leading-relaxed">{a.next_action.text}</p>
                {a.next_action.kind === "SUGGESTED" && <p className="mt-1 text-xs text-muted-foreground">Confirm it in the set-up table or with Edit record.</p>}
              </Block>
            )}

            {data.follow_up_review && <FollowUpReview review={data.follow_up_review} />}

            {data.suggestions.length > 0 && (
              <Block title={`What the emails say (${data.suggestions.length})`} note="To check. Nothing changes until you act.">
                <div className="flex flex-col gap-3">
                  {[...data.suggestions].sort((x, y) => ["CLOSURE", "CONFLICT", "LINK"].indexOf(y.kind) - ["CLOSURE", "CONFLICT", "LINK"].indexOf(x.kind))
                    .map((s) => <SuggestionActions key={s.key} claimId={claim.id} updatedAt={claim.updated_at} suggestion={s} onChanged={changed} compact />)}
                </div>
              </Block>
            )}

            <Block title="History" note="Recorded events only">
              <ol className="flex flex-col gap-2 border-l pl-3 text-sm">
                {[...data.story.map((e) => ({ k: `e${e.id}`, at: e.event_date, t: e.title })),
                  ...data.history.filter((h) => h.previous_status !== null).map((h) => ({ k: `h${h.id}`, at: h.changed_at, t: h.reason }))]
                  .sort((x, y) => x.at.localeCompare(y.at))
                  .map((e) => (
                    <li key={e.k}><span className="font-medium">{e.t}</span><span className="block text-xs text-muted-foreground">{formatStamp(e.at)}</span></li>
                  ))}
              </ol>
            </Block>

            <Block title={`Evidence · ${data.emails.length} emails`} note="Newest first">
              {data.emails.length === 0 ? <p className="text-sm text-muted-foreground">No email is linked to this claim.</p> : (
                <ol className="flex flex-col divide-y">{[...data.emails].reverse().slice(0, 5).map((e) => <EmailItem key={e.id} email={e} />)}</ol>
              )}
            </Block>
          </div>
        )}
      </div>

      <div className="border-t px-5 py-3">
        <div className="flex gap-2">
          {a?.primary_target === "SETUP" && (
            <Link href={`${href("/claims/setup")}#claim-${claimId}`} className={cn(buttonVariants({ size: "lg" }), "h-10 flex-1 px-4")}>Set up this claim</Link>
          )}
          <Link href={href(`/claims/${claimId}`)} className={cn(buttonVariants({ size: "lg", variant: a?.primary_target === "SETUP" ? "outline" : "default" }), "h-10 flex-1 px-4")}>
            Open claim to edit <ArrowRight aria-hidden />
          </Link>
        </div>
      </div>
    </aside>
  )
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-bold tracking-wider text-muted-foreground uppercase">
        {title}{note && <span className="ml-2 font-normal tracking-normal normal-case">{note}</span>}
      </h3>
      {children}
    </section>
  )
}

/** Spec 28: NeraVeda prepares a draft; you edit it, copy it and send it from Outlook yourself. Nothing is sent. */
export function FollowUpReview({ review }: { review: { objective: string; last_position: string | null; draft: string } }) {
  const [draft, setDraft] = useState(review.draft)
  const [copied, setCopied] = useState(false)
  useEffect(() => setDraft(review.draft), [review.draft])
  return (
    <Block title="Follow-up review" note="Draft only. NeraVeda never sends email.">
      <p className="text-sm"><span className="text-muted-foreground">Objective: </span>{review.objective}</p>
      {review.last_position && <p className="mt-1 text-sm"><span className="text-muted-foreground">Last substantive position: </span>“{review.last_position}”</p>}
      <label className="mt-2 block text-sm">
        <span className="sr-only">Draft follow-up</span>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={7} className="w-full rounded-lg border bg-background p-2.5 text-sm leading-relaxed" />
      </label>
      <button
        type="button"
        onClick={async () => { try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { setCopied(false) } }}
        className={cn(buttonVariants({ variant: "outline", size: "lg" }), "mt-2 h-10 px-4")}
      >
        <Copy aria-hidden /> {copied ? "Copied" : "Copy draft"}
      </button>
    </Block>
  )
}
