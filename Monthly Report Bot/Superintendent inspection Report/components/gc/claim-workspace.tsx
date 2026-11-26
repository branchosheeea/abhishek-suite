"use client"

// Guarantee Claim Manager · one claim: the controlled record, its story (recorded events and status changes, never
// emails), the emails as source evidence, and the change panel (edit, status, snooze, close or reopen).

import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Paperclip } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { type ReactNode, useState } from "react"
import useSWR from "swr"
import { cn } from "@/lib/utils"
import { BallFacts, Badges, Provenance, Reasons, SuggestionCard } from "./assessment"
import { ClaimActions } from "./claim-forms"
import { FollowUpReview } from "./claim-inspector"
import { API, type ClaimDetail, type Email, formatDay, formatStamp, getJson } from "./client"
import { useFrame, useHref } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton, Value } from "./states"

export function ClaimWorkspace() {
  const { id } = useParams<{ id: string }>()
  const href = useHref()
  const { refresh } = useFrame()
  const { data, error, isLoading, mutate } = useSWR(`${API}/claims/${encodeURIComponent(id)}`, (path: string) => getJson<ClaimDetail>(path))
  const saved = (detail: ClaimDetail) => { void mutate(detail, { revalidate: false }); void refresh() }

  return (
    <div className="flex flex-col gap-5">
      <Link href={href("/claims/register")} className="inline-flex h-10 w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Claim Register
      </Link>
      {error && <ErrorPanel error={error} what="this claim" />}
      {!error && (isLoading || !data) && (
        <Loading label="Loading the claim">
          <Skeleton className="h-10 w-1/2" />
          <div className="mt-5 grid gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
        </Loading>
      )}
      {data && <Claim detail={data} actions={<ClaimActions detail={data} onSaved={saved} onReload={() => void mutate()} />} />}
    </div>
  )
}

function Claim({ detail, actions }: { detail: ClaimDetail; actions: ReactNode }) {
  const { claim, vessel, story, history, emails } = detail
  const events = [
    ...story.map((e) => ({ key: `e${e.id}`, at: e.event_date, title: e.title, text: e.description, by: e.created_by, source: "Recorded event" })),
    ...history
      .filter((h) => h.previous_status !== null)
      .map((h) => ({
        key: `h${h.id}`, at: h.changed_at,
        title: h.previous_status !== h.new_status ? `Status: ${h.previous_status} → ${h.new_status}` : `Action owner: ${h.previous_waiting_on} → ${h.new_waiting_on}`,
        text: h.reason, by: h.changed_by, source: h.source === "MANUAL" ? "Recorded change" : h.source,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{vessel.name}</p>
        <h2 className="text-[26px] leading-tight font-bold tracking-tight">
          {claim.gc_number} <span className="font-semibold text-foreground/80">· <Value value={claim.title} /></span>
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-md border px-2 py-0.5 font-medium">{claim.status_label}</span>
          <span className="text-muted-foreground">Action owner:</span>
          {claim.owner ? <span className="font-semibold">{claim.owner}</span> : <span className="text-muted-foreground italic">Not established</span>}
        </p>
      </header>

      {actions}

      {claim.assessment && (
        <div className="grid gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Section eyebrow="POSITION" title="Who has the ball, and why it is surfaced">
            <Badges assessment={claim.assessment} />
            <BallFacts assessment={claim.assessment} className="mt-3" />
            {claim.assessment.reasons.length > 0 && <div className="mt-4"><Reasons reasons={claim.assessment.reasons} /></div>}
            {claim.assessment.next_action && (
              <div className="mt-4 rounded-xl border bg-muted/30 p-3">
                <Provenance action={claim.assessment.next_action} />
                <p className="mt-2 text-sm">{claim.assessment.next_action.text}</p>
              </div>
            )}
            {detail.follow_up_review && <div className="mt-4"><FollowUpReview review={detail.follow_up_review} /></div>}
          </Section>
          <Section eyebrow="SUGGESTIONS FROM EMAILS" title={`${detail.suggestions.length} to review`} subtitle="Not verified; nothing changes until you confirm">
            {detail.suggestions.length === 0 ? <p className="text-sm text-muted-foreground">No suggestion: the emails give no clear position.</p> : (
              <div className="grid gap-2 xl:grid-cols-2">{detail.suggestions.map((s) => <SuggestionCard key={s.key} suggestion={s} />)}</div>
            )}
          </Section>
        </div>
      )}

      <div className="grid gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-5">
          <Section eyebrow="CONTROLLED RECORD" title="What the claim record holds">
            <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
              <Row label="Equipment / system"><Value value={claim.equipment_system} /></Row>
              <Row label="Defect"><Value value={claim.defect_description} /></Row>
              <Row label="Responsible party"><Value value={claim.responsible_party} /></Row>
              <Row label="Next required action"><Value value={claim.next_action} /></Row>
              <Row label="Pending since"><DayValue value={claim.action_since} /></Row>
              <Row label="Follow-up due date"><DayValue value={claim.next_follow_up_date} /></Row>
              <Row label="Promised dispatch"><DayValue value={claim.promised_dispatch_date} /></Row>
              <Row label="Expected delivery"><DayValue value={claim.expected_delivery_date} /></Row>
              <Row label="Service attendance"><DayValue value={claim.service_attendance_date} /></Row>
              <Row label="Rectification"><DayValue value={claim.rectification_date} /></Row>
              <Row label="Reported / submitted"><DayValue value={claim.date_reported} /> / <DayValue value={claim.date_submitted} /></Row>
              {claim.closure_date && <Row label="Closed"><DayValue value={claim.closure_date} /></Row>}
              <Row label="Priority">{claim.priority === "NORMAL" ? "Normal (default)" : claim.priority}</Row>
              <Row label="Guarantee period">
                {vessel.guarantee_expiry_date ? <>{vessel.guarantee_start_date ? `${formatDay(vessel.guarantee_start_date)} – ` : "Expires "}{formatDay(vessel.guarantee_expiry_date)}</> : <Value value={null} />}
              </Row>
              <Row label="Notes"><Value value={claim.notes} /></Row>
              <Row label="Registered">{formatStamp(claim.created_at)}{claim.created_by ? ` by ${claim.created_by}` : ""}</Row>
            </dl>
          </Section>

          <Section eyebrow="CLAIM STORY" title="Recorded events and changes" subtitle="Emails are evidence, not story events">
            <ol className="flex flex-col gap-3 border-l pl-4">
              {events.map((e) => (
                <li key={e.key} className="relative text-sm">
                  <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-foreground/60" />
                  <p className="font-medium">{e.title}</p>
                  {e.text && <p className="text-foreground/80">{e.text}</p>}
                  <p className="text-xs text-muted-foreground">{formatStamp(e.at)} · {e.source}{e.by ? ` · ${e.by}` : ""}</p>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <Section eyebrow="SOURCE EVIDENCE" title={`Emails (${emails.length})`} subtitle="Stored copies; the first lines are shown">
          {emails.length === 0 ? (
            <p className="text-sm text-muted-foreground">No email is linked to this claim.</p>
          ) : (
            <ol className="flex flex-col divide-y">
              {[...emails].reverse().map((e) => <EmailItem key={e.id} email={e} />)}
            </ol>
          )}
        </Section>
      </div>
    </>
  )
}

export function EmailItem({ email, claimLink }: { email: Email; claimLink?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const outgoing = email.direction === "OUTGOING"
  const Arrow = outgoing ? ArrowUpRight : ArrowDownLeft
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full min-w-0 items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Arrow className={cn("mt-0.5 size-4 shrink-0", outgoing ? "text-primary" : "text-muted-foreground")} aria-label={outgoing ? "Sent" : "Received"} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="truncate text-sm font-medium">{outgoing ? "You" : email.sender_name || email.sender_address || "Unknown sender"}</span>
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{email.message_datetime ? formatStamp(email.message_datetime) : "No date"}</span>
          </span>
          <span className="flex items-center gap-1.5 text-sm text-foreground/80">
            <span className="truncate">{email.subject}</span>
            {email.has_attachments && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has attachments (not stored)" />}
          </span>
          <span className={cn("mt-1 block text-xs leading-relaxed text-muted-foreground", !open && "line-clamp-2")}>{email.body_preview || "No preview stored."}</span>
        </span>
      </button>
      {claimLink && <div className="mt-1.5 pl-7">{claimLink}</div>}
    </li>
  )
}

function Section({ eyebrow, title, subtitle, children }: { eyebrow: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <p className="text-[11px] font-bold tracking-wider text-muted-foreground">{eyebrow}</p>
      <h3 className="mt-1 mb-3 text-base font-semibold">{title}{subtitle && <span className="ml-2 text-xs font-normal text-muted-foreground">{subtitle}</span>}</h3>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function DayValue({ value }: { value: string | null }) {
  return <Value value={value}>{value && formatDay(value)}</Value>
}
