"use client"

// Guarantee Claim Manager · Command Centre, in the same look as the other NeraVeda modules (Inspection Reports,
// Digital Docking): a row of number cards, then claim cards with a status badge, a details line and a progress bar.
// Groups (user's choice, 26 Nov 2026): Your turn, Waiting on others, Ready to close. A claim whose record is not
// confirmed yet is placed where its emails point and marked "From emails", with a one-click Confirm that saves
// exactly those values through the claim rules (history and audit). Every value comes from gc_manager (Python).

import { Check, ChevronRight, Eye, FileClock, Inbox, Mail, ShieldCheck } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { Chips } from "./assessment"
import { API, type ClaimDetail, formatDay, type Group, type GroupRow, type Groups, type Overview, RequestFailed, send } from "./client"
import { useFrame, useHref } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"

export function CommandCentre() {
  const { overview, error, isLoading } = useFrame()
  if (error) return <ErrorPanel error={error} what="the Command Centre" />
  if (isLoading || !overview) return <CommandSkeleton />
  if (!overview.vessel || !overview.groups) return <NoVessel overview={overview} />
  return <Centre groups={overview.groups} open={overview.claims?.open ?? 0} />
}

const SECTIONS: { group: Group; icon: typeof Inbox; empty: string }[] = [
  { group: "YOUR_TURN", icon: Inbox, empty: "Nothing is waiting on you." },
  { group: "WAITING", icon: FileClock, empty: "No claim is waiting on someone else." },
  { group: "READY_TO_CLOSE", icon: ShieldCheck, empty: "No claim looks ready to close." },
  { group: "NOT_SET_UP", icon: Mail, empty: "" },
]

function Centre({ groups, open }: { groups: Groups; open: number }) {
  const href = useHref()
  const unconfirmed = open - groups.confirmed_total
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Your turn" value={groups.counts.YOUR_TURN} href="#group-YOUR_TURN" highlight={groups.counts.YOUR_TURN > 0} />
        <Stat label="Waiting on others" value={groups.counts.WAITING} href="#group-WAITING" />
        <Stat label="Ready to close" value={groups.counts.READY_TO_CLOSE} href="#group-READY_TO_CLOSE" />
        <Stat label="Overdue" value={groups.overdue} warn={groups.overdue > 0} />
      </dl>

      <div className="flex flex-col gap-2">
        {unconfirmed > 0 && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              <b className="text-foreground tabular-nums">{unconfirmed}</b> of {open} claims are placed from their emails and not confirmed yet. Check each card and press <b className="text-foreground">Confirm</b>, or
            </span>
            <Link href={href("/claims/setup")} className="font-medium text-primary underline-offset-4 hover:underline">confirm several in one table</Link>
          </p>
        )}
        <WhatsNew items={groups.whats_new} />
      </div>

      {SECTIONS.filter((s) => s.group !== "NOT_SET_UP" || groups.counts.NOT_SET_UP > 0).map((s) => (
        <GroupSection key={s.group} section={s} groups={groups} />
      ))}
    </div>
  )
}

function Stat({ label, value, href, highlight, warn }: { label: string; value: number; href?: string; highlight?: boolean; warn?: boolean }) {
  const body = (
    <>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("font-mono text-2xl font-semibold tabular-nums", highlight && "text-primary", warn && "text-warning")}>{value}</dd>
    </>
  )
  return href ? (
    <a href={href} className="flex flex-col gap-1 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">{body}</a>
  ) : (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4">{body}</div>
  )
}

function GroupSection({ section, groups }: { section: (typeof SECTIONS)[number]; groups: Groups }) {
  const rows = groups.rows[section.group]
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 6)
  return (
    <section id={`group-${section.group}`} aria-labelledby={`h-${section.group}`} className="flex scroll-mt-4 flex-col gap-3">
      <h2 id={`h-${section.group}`} className="flex flex-wrap items-baseline gap-x-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {groups.labels[section.group]} · {rows.length}
        {section.group === "WAITING" && groups.waiting_by.length > 0 && (
          <span className="font-normal tracking-normal normal-case">{groups.waiting_by.map((w) => `${w.with ?? "Not set"} ${w.count}`).join(" · ")}</span>
        )}
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{section.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((r) => <ClaimCard key={r.claim_id} row={r} icon={section.icon} />)}
        </ul>
      )}
      {rows.length > 6 && (
        <button type="button" onClick={() => setAll(!all)} className="w-fit text-sm font-medium text-primary underline-offset-4 hover:underline">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  )
}

function ClaimCard({ row: r, icon: Icon }: { row: GroupRow; icon: typeof Inbox }) {
  const { inspect, refresh } = useFrame()
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const confirm = async () => {
    if (!r.confirm) return
    setState({ busy: true, error: null })
    try {
      await send<ClaimDetail>(`${API}/claims/${r.claim_id}/setup`, "POST", { ...r.confirm, status: r.confirm.status ?? undefined })
      setState({ busy: false, error: null })
      void refresh()
    } catch (e) {
      setState({ busy: false, error: e instanceof RequestFailed ? e.message : String(e) })
    }
  }
  const meta = [
    r.with ? `With ${r.with}` : "Owner not set",
    r.since && `since ${formatDay(r.since)}${r.days !== null ? ` (${r.days} days)` : ""}`,
  ].filter(Boolean).join(" · ")
  return (
    <li className="group relative flex flex-col gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 sm:flex-row sm:items-center">
      <span className="hidden size-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground sm:flex">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={(e) => inspect(r.claim_id, e.currentTarget)}
            className="truncate text-left font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50">
            {r.gc_number} · {r.title ?? "Title not recorded"}
          </button>
          {r.confirmed
            ? <Badge variant="outline" className="border-success/50 text-success">Confirmed</Badge>
            : <Badge variant="outline" className="border-warning/60 text-warning-foreground dark:text-warning">From emails</Badge>}
          {r.close_source === "RECORD" && <Badge variant="outline">From the claim record</Badge>}
          <Chips chips={r.chips} />
        </div>
        <p className="truncate text-sm text-muted-foreground">{meta}</p>
        {r.next_step && <p className="line-clamp-2 text-sm"><span className="text-muted-foreground">Next: </span>{r.next_step}</p>}
        {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
        {state.error && <p role="alert" className="text-xs text-destructive">Not saved: {state.error}</p>}
      </div>
      <div className="flex items-center gap-3 sm:w-48">
        <div className="flex flex-1 flex-col gap-1">
          <Progress value={r.progress} className="h-1.5" aria-label={`${r.gc_number} stage`} />
          <span className="truncate text-xs text-muted-foreground" title={r.stage}>{r.stage}</span>
        </div>
      </div>
      <div className="relative z-10 flex items-center gap-1">
        {r.confirm && (
          <button type="button" onClick={confirm} disabled={state.busy}
            className={cn(buttonVariants({ size: "sm" }), "h-9")} title="Save what the emails say as the claim's record (history and audit kept)">
            <Check aria-hidden /> {state.busy ? "Saving…" : "Confirm"}
          </button>
        )}
        <button type="button" onClick={(e) => inspect(r.claim_id, e.currentTarget)} aria-label={`Open ${r.gc_number}`}
          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}>
          <ChevronRight aria-hidden />
        </button>
      </div>
    </li>
  )
}

function WhatsNew({ items }: { items: Groups["whats_new"] }) {
  const { inspect, refresh } = useFrame()
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle")
  const mark = async () => {
    setState("busy")
    try {
      await send(`${API}/review-mark`, "POST")
      setState("idle")
      void refresh()
    } catch {
      setState("failed")
    }
  }
  if (items.length === 0) return null
  const shown = items.slice(0, 10)
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <Eye className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">New emails since you last looked:</span>
      {shown.map((i, n) => (
        <span key={i.claim_id}>
          <button type="button" onClick={(e) => inspect(i.claim_id, e.currentTarget)} className="font-medium text-primary underline-offset-4 hover:underline">{i.gc_number}</button>
          {n < shown.length - 1 && ","}
        </span>
      ))}
      {items.length > 10 && <span className="text-muted-foreground">and {items.length - 10} more</span>}
      <button type="button" onClick={mark} disabled={state === "busy"} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-1 h-8")}>
        {state === "busy" ? "Saving…" : "Mark as seen"}
      </button>
      {state === "failed" && <span className="text-destructive">Not saved. Try again.</span>}
    </p>
  )
}

function NoVessel({ overview }: { overview: Overview }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
      <Inbox className="size-10 text-muted-foreground" aria-hidden />
      <p className="font-medium">No tracked vessel has guarantee claims yet</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {overview.scope.all_vessels ? "Every vessel is tracked, but no claim is registered." : `Tracked: ${overview.scope.tracked.join(", ")}. Register a claim in GC Manager, or change the tracked vessels in its Settings.`}
      </p>
    </div>
  )
}

function CommandSkeleton() {
  return (
    <Loading label="Loading the Command Centre">
      <div className="flex flex-col gap-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[74px]" />)}</div>
        <div className="flex flex-col gap-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      </div>
    </Loading>
  )
}
