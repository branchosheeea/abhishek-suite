"use client"

import { ArrowLeft, ChevronDown, Pencil } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { API, type AuditEntry, type Docking, type DockingDetail, formatDay, formatOffset, formatStamp, getJson, PeopleContext, send, STATUS_LABEL, usePeople, who } from "./client"
import { DayGrid } from "./day-grid"
import { DockingForm } from "./docking-form"
import { JobsPanel } from "./jobs-panel"

export function DockingOverview() {
  const { id } = useParams<{ id: string }>()
  const path = `${API}/${id}`
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) => getJson<DockingDetail>(p))
  const [editing, setEditing] = useState(false)

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-9">
        <BackLink />
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error.message}</p>
      </main>
    )
  }
  if (isLoading || !data) return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-9"><p className="text-sm text-muted-foreground">Loading the docking…</p></main>

  const d = data.docking
  const frozen = data.days.some((day) => day.files.length > 0)

  return (
    <PeopleContext value={data.people ?? {}}>
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-4 border-b pb-6">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{d.vessel_name} <span className="font-normal text-muted-foreground">· {d.code}</span></h1>
            <p className="text-sm text-muted-foreground">{d.docking_type} · {d.yard}{d.location ? `, ${d.location}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={d.status === "active" ? "default" : "outline"}>{STATUS_LABEL[d.status]}</Badge>
            {!editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil aria-hidden /> Edit details</Button>}
          </div>
        </div>
        {!editing ? (
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Day 0 (arrival at yard)" value={`${formatDay(d.day0_date)}${d.arrival_time ? `, ${d.arrival_time} LT` : ""}`} />
            <Item label="Planned departure" value={d.planned_departure_date ? formatDay(d.planned_departure_date) : "Not set"} />
            <Item label="Local time at the yard" value={formatOffset(d.utc_offset_minutes)} />
            <Item label="Created" value={`${formatStamp(d.created_at)} by ${who(data.people, d.created_by)}`} />
          </dl>
        ) : (
          <div className="rounded-2xl border bg-card p-5">
            <DockingForm
              initial={d}
              frozen={frozen}
              submitLabel="Save changes"
              onCancel={() => setEditing(false)}
              onSubmit={async (values) => {
                await send<{ docking: Docking }>(path, "PATCH", { ...values, rev: d.rev })
                toast.success("Docking details saved")
                setEditing(false)
                await mutate()
              }}
            />
          </div>
        )}
      </header>

      <DayGrid dockingId={d.id} day0Date={d.day0_date} importable={d.status !== "cancelled"} days={data.days} notes={data.notes} onChanged={() => mutate()} />
      <JobsPanel dockingId={d.id} jobs={data.jobs} notes={data.notes} onChanged={() => mutate()} />
      <ActivityLog dockingId={d.id} version={`${d.rev}-${data.notes.length}-${data.jobs.length}-${data.days.filter((x) => x.id).length}`} />
    </main>
    </PeopleContext>
  )
}

function BackLink() {
  return (
    <Link href="/docking" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden /> All dockings
    </Link>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

const ACTIONS: Record<string, string> = {
  "docking.create": "created the docking", "docking.update": "changed the docking details", "day.no_report": "recorded no report",
  "day.reviewed": "marked a day as reviewed", "job.create": "created a job", "submission.initial": "imported a daily file",
  "submission.revision": "imported a revised file", "submission.amendment": "imported an amended file", "activity.link": "linked an entry to a job",
  "activity.unlink": "removed an entry from a job", "annotation.comment": "added a comment", "annotation.query": "raised a query",
  "annotation.correction": "added a correction", "report.start": "started a daily report", "report.rebuild": "rebuilt a daily report's items from the vessel's entries",
  "report.issue": "issued a daily report",
}

function describe(a: AuditEntry): string {
  const after = (a.after ?? {}) as Record<string, unknown>
  const what = ACTIONS[a.action] ?? a.action
  if (a.action === "job.create" && after.job_no) return `${what} ${after.job_no} — ${after.title}`
  if (a.action.startsWith("submission.") && after.day !== undefined) return `${what}: Day ${after.day} ${after.department} (${after.file})`
  if (a.action === "day.no_report" && after.reason) return `${what}: ${after.reason}`
  if (a.action === "report.start" && after.day !== undefined) return `${what} for Day ${after.day}`
  if (a.action === "report.issue" && after.day !== undefined) return `${what}: Day ${after.day} version ${after.version}${after.reason ? ` (${after.reason})` : ""}`
  return what
}

/** Who did what, from the audit trail (which can never be changed). */
function ActivityLog({ dockingId, version }: { dockingId: string; version: string }) {
  const [open, setOpen] = useState(false)
  const people = usePeople()
  const { data, error } = useSWR(open ? [`${API}/${dockingId}/audit`, version] : null, ([p]: [string, string]) => getJson<{ audit: AuditEntry[] }>(p))
  return (
    <section aria-labelledby="log-title" className="flex flex-col gap-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit items-center gap-1.5 text-lg font-bold">
        <span id="log-title">Activity log</span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {open && data && (
        <ol className="flex flex-col divide-y rounded-xl border bg-card text-sm">
          {[...data.audit].reverse().map((a) => (
            <li key={a.id} className="flex flex-wrap gap-x-3 px-4 py-2">
              <span className="w-40 shrink-0 text-muted-foreground tabular-nums">{formatStamp(a.at)}</span>
              <span className="font-medium">{who(people, a.actor)}</span>
              <span>{describe(a)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
