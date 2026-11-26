"use client"

// Guarantee Claim Manager · how the shared rule results look. Display only: every value here (class, reasons, due,
// age, next action and its provenance) arrives from gc_manager/command.py. State is always shown with words and an
// icon as well as colour, and the four next-action labels each have their own icon so they cannot be confused.

import { CalendarClock, CircleDashed, Clock, Lightbulb, MessageSquareQuote, ShieldCheck, Siren, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { type Assessment, days, formatDay, type NextAction, type Reason, type Suggestion } from "./client"

const CLASS_STYLE: Record<number, { icon: typeof Siren; className: string }> = {
  1: { icon: Siren, className: "border-destructive/40 bg-destructive/10 text-destructive" },
  2: { icon: TriangleAlert, className: "border-warning/60 bg-warning/15 text-warning-foreground dark:text-warning" },
  3: { icon: CalendarClock, className: "border-primary/40 bg-primary/10 text-primary" },
  4: { icon: CircleDashed, className: "border-border bg-muted text-muted-foreground" },
}

export function ClassBadge({ assessment, compact }: { assessment: Assessment; compact?: boolean }) {
  if (!assessment.klass || !assessment.class_label) return <span className="text-xs text-muted-foreground">No intervention</span>
  const style = CLASS_STYLE[assessment.klass]
  const Icon = style.icon
  return (
    <span className={cn("inline-flex w-fit items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap", style.className)}>
      <Icon className="size-3.5" aria-hidden />
      {compact ? `P${assessment.klass}` : assessment.class_label}
    </span>
  )
}

export function ReviewBadge() {
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-muted-foreground">
      <Lightbulb className="size-3.5" aria-hidden /> Review required
    </span>
  )
}

export function Badges({ assessment }: { assessment: Assessment }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ClassBadge assessment={assessment} />
      {assessment.review && assessment.klass !== 4 && <ReviewBadge />}
      {assessment.snoozed_until && (
        <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden /> Snoozed until {formatDay(assessment.snoozed_until)}
        </span>
      )}
    </span>
  )
}

const PROVENANCE: Record<NextAction["kind"], { icon: typeof ShieldCheck; className: string }> = {
  CONTROLLED: { icon: ShieldCheck, className: "border-success/50 bg-success/10 text-success" },
  REMINDER: { icon: CalendarClock, className: "border-primary/40 bg-primary/10 text-primary" },
  SUGGESTED: { icon: Lightbulb, className: "border-dashed border-warning/70 bg-warning/10 text-warning-foreground dark:text-warning" },
  NOT_ESTABLISHED: { icon: CircleDashed, className: "border-border text-muted-foreground" },
}

/** Where the next action comes from: CONTROLLED ACTION, DETERMINISTIC REMINDER, SUGGESTED ACTION or ACTION NOT ESTABLISHED. */
export function Provenance({ action }: { action: NextAction }) {
  const style = PROVENANCE[action.kind]
  const Icon = style.icon
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-bold tracking-wide uppercase", style.className)}>
      <Icon className="size-3.5" aria-hidden /> {action.label}
    </span>
  )
}

/** The recorded title; if none, the title the emails suggest, marked as a suggestion; else "Title not recorded". */
export function ClaimTitle({ title, assessment, className }: { title: string | null; assessment?: Assessment; className?: string }) {
  if (title) return <span className={className}>{title}</span>
  const suggested = assessment?.suggested.title
  if (!suggested) return <span className={cn("text-muted-foreground italic", className)}>Title not recorded</span>
  return (
    <span className={className}>
      <span className="italic">{suggested}</span>
      <span className="ml-1.5 inline-flex translate-y-[-1px] items-center rounded border border-dashed px-1 align-middle text-[10px] font-semibold tracking-wide text-muted-foreground not-italic uppercase">suggested</span>
    </span>
  )
}

/** The verified owner group, or "Owner not established" with the suggested one beside it. */
export function OwnerText({ assessment }: { assessment: Assessment }) {
  if (assessment.owner) return <>{assessment.owner}</>
  return (
    <>
      Owner not established
      {assessment.suggested.owner && <span className="font-normal normal-case"> · suggested: {assessment.suggested.owner}</span>}
    </>
  )
}

const CHIP_TONE: Record<string, string> = {
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
  warn: "border-warning/60 bg-warning/15 text-warning-foreground dark:text-warning",
  info: "border-primary/40 bg-primary/10 text-primary",
  muted: "border-border text-muted-foreground",
}

/** Short plain facts ("Overdue 16 days", "Due 2 Dec"): the words carry the meaning, colour only helps. */
export function Chips({ chips }: { chips: { text: string; tone: string }[] }) {
  if (chips.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((c) => <span key={c.text} className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap", CHIP_TONE[c.tone] ?? CHIP_TONE.muted)}>{c.text}</span>)}
    </span>
  )
}

/** An email suggestion in words, always marked as something to check. */
export function Note({ text }: { text: string | null }) {
  if (!text) return null
  return <span className="flex items-start gap-1.5 text-[13px] text-foreground/80"><Lightbulb className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span>{text}</span></span>
}

/** Who has the ball, for how long, and when it is due: verified facts, or "Not established". */
export function BallFacts({ assessment, className }: { assessment: Assessment; className?: string }) {
  const a = assessment
  return (
    <dl className={cn("grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm", className)}>
      <Fact label="With">{a.owner ?? <Missing>Not set</Missing>}</Fact>
      <Fact label="Since">{a.pending_since ? <>{formatDay(a.pending_since)}{a.age_days !== null && <Hint>{days(a.age_days)}</Hint>}</> : <Missing>Not set</Missing>}</Fact>
      <Fact label="Due">
        {a.due ? <>{formatDay(a.due.date)}<Hint>{a.due.label.toLowerCase()}</Hint></> : <Missing>Not set</Missing>}
      </Fact>
      {a.due_state === "OVERDUE" && <Fact label="Overdue"><b className="text-destructive">{days(a.overdue_days)}</b></Fact>}
      {a.due_state === "DUE_TODAY" && <Fact label="Overdue"><b>Due today</b></Fact>}
      {a.warranty && <Fact label="Guarantee">{a.warranty.days_left < 0 ? `Expired ${formatDay(a.warranty.expiry_date)}` : `${days(a.warranty.days_left)} left (${formatDay(a.warranty.expiry_date)})`}</Fact>}
    </dl>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground italic">{children}</span>
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="ml-1.5 text-xs text-muted-foreground">{children}</span>
}

const CATEGORY: Record<Reason["category"], string> = { ACTION: "Fact", FOLLOW_UP: "Fact", RECORD: "Missing", REVIEW: "Check" }

/** "Why am I seeing this?": every active reason, verified ones first, each with its kind in words. */
export function Reasons({ reasons, limit }: { reasons: Reason[]; limit?: number }) {
  const shown = limit ? reasons.slice(0, limit) : reasons
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {shown.map((r) => (
        <li key={r.code} className="flex items-start gap-2">
          <span className={cn("mt-px w-16 shrink-0 rounded border px-1 text-center text-[11px] font-semibold uppercase",
            r.category === "REVIEW" ? "border-dashed text-muted-foreground" : r.category === "RECORD" ? "text-muted-foreground" : "text-foreground")}>
            {CATEGORY[r.category]}
          </span>
          <span>{r.text}</span>
        </li>
      ))}
      {limit && reasons.length > limit && <li className="pl-[4.5rem] text-xs text-muted-foreground">+{reasons.length - limit} more</li>}
    </ul>
  )
}

/** One suggestion with the email sentence it rests on. Never phrased as a change that happened. */
export function SuggestionCard({ suggestion, compact }: { suggestion: Suggestion; compact?: boolean }) {
  const s = suggestion
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-dashed p-3 text-sm">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">{s.kind_label} · suggestion</span>
        {s.evidence_date && <span className="text-xs text-muted-foreground">{formatDay(s.evidence_date)}</span>}
      </p>
      <p className="font-semibold">{s.kind === "PENDING_SINCE" ? formatDay(s.proposal) : s.proposal}</p>
      <p className="text-foreground/80">{s.reason}</p>
      {s.quote && (
        <blockquote className="flex gap-2 border-l-2 pl-2.5 text-[13px] text-foreground/80 italic">
          <MessageSquareQuote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground not-italic" aria-hidden />
          <span>“{s.quote}”</span>
        </blockquote>
      )}
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Source: {s.evidence_direction === "OUTGOING" ? "email sent by your office" : `email from ${s.evidence_author}`} · {s.evidence_subject}
        </p>
      )}
    </div>
  )
}
