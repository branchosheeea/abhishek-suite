"use client"

import { ChevronDown, Plus } from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AREAS_DRAFT, areasFor } from "@/lib/docking/areas"
import { cn } from "@/lib/utils"
import { API, formatDay, getJson, type Job, type Note, send, type TimelineEntry } from "./client"
import { NoteThread } from "./note-thread"

const SELECT = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
const DEPARTMENTS = [["deck", "Deck"], ["engine", "Engine"]] as const

/** D5: jobs are created here by the Superintendent; daily activities are linked to them once files are imported. */
export function JobsPanel({ dockingId, jobs, notes, onChanged }: { dockingId: string; jobs: Job[]; notes: Note[]; onChanged: () => Promise<unknown> }) {
  const [adding, setAdding] = useState<"deck" | "engine" | null>(null)
  return (
    <section aria-labelledby="jobs-title" className="flex flex-col gap-3">
      <h2 id="jobs-title" className="text-lg font-bold">Jobs</h2>
      <p className="text-sm text-muted-foreground">
        Jobs are numbered by NeraVeda per department. Each day&apos;s vessel entries will be linked to them during review, building one record per job across all days.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {DEPARTMENTS.map(([dep, label]) => {
          const list = jobs.filter((j) => j.department === dep)
          return (
            <div key={dep} className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold">{label} <span className="font-normal text-muted-foreground">· {list.length}</span></h3>
                {adding !== dep && <Button size="sm" variant="outline" onClick={() => setAdding(dep)}><Plus aria-hidden /> New job</Button>}
              </div>
              {adding === dep && <NewJob dockingId={dockingId} department={dep} onDone={async (created) => { setAdding(null); if (created) await onChanged() }} />}
              {list.length === 0 && adding !== dep && <p className="text-sm text-muted-foreground">No {label.toLowerCase()} jobs yet.</p>}
              <ul className="flex flex-col gap-2">
                {list.map((j) => <JobItem key={j.id} dockingId={dockingId} job={j} notes={notes.filter((n) => n.entity === "job" && n.entity_id === j.id)} onChanged={onChanged} />)}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function NewJob({ dockingId, department, onDone }: { dockingId: string; department: "deck" | "engine"; onDone: (created: boolean) => Promise<void> }) {
  const [title, setTitle] = useState("")
  const [area, setArea] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { job } = await send<{ job: Job }>(`${API}/${dockingId}/jobs`, "POST", { department, title, area })
      toast.success(`${job.job_no} created`)
      await onDone(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The job could not be created.")
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Job title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="e.g. COP discharge valves OP208/209 seat rings" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Area / system{AREAS_DRAFT && <span className="font-normal text-muted-foreground"> (draft list)</span>}</span>
        <select className={SELECT} value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Not set</option>
          {areasFor(department).map((a) => <option key={a}>{a}</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create job"}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDone(false)}>Cancel</Button>
      </div>
    </form>
  )
}

function JobItem({ dockingId, job, notes, onChanged }: { dockingId: string; job: Job; notes: Note[]; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const { data, error } = useSWR(open ? `${API}/${dockingId}/jobs/${job.id}` : null, (path: string) => getJson<{ timeline: TimelineEntry[] }>(path))
  const span = job.first_day === null ? "no activity linked yet" : job.first_day === job.last_day ? `Day ${job.first_day}` : `Day ${job.first_day}–${job.last_day}`

  return (
    <li className="rounded-lg border bg-background">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-start gap-2 rounded-lg p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-xs text-muted-foreground">{job.job_no}</span>
          <span className="font-semibold">{job.title}</span>
          <span className="text-xs text-muted-foreground">{job.area || "Area not set"} · {job.activities} {job.activities === 1 ? "entry" : "entries"} · {span}{notes.length ? ` · ${notes.length} note${notes.length > 1 ? "s" : ""}` : ""}</span>
        </span>
        <ChevronDown className={cn("mt-1 size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t p-3">
          {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
          {data && data.timeline.length === 0 && <p className="text-sm text-muted-foreground">No vessel entries are linked to this job yet. They are linked from the daily reports once importing starts.</p>}
          {data && data.timeline.length > 0 && (
            <ol className="flex flex-col gap-2 text-sm">
              {data.timeline.map((t) => (
                <li key={t.id} className="rounded-md border p-2">
                  <span className="text-xs text-muted-foreground">Day {t.day_no} · {formatDay(t.report_date)} · {t.row_ref}{t.submission_status !== "current" ? " · replaced file: link the row in the new file" : ""} · {t.photos.length} photo{t.photos.length === 1 ? "" : "s"}</span>
                  <p className="whitespace-pre-wrap">{t.work_text}</p>
                  {t.findings && <p className="text-muted-foreground">Findings: {t.findings}</p>}
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-semibold">Notes on {job.job_no}</h4>
            <NoteThread dockingId={dockingId} entity="job" entityId={job.id} notes={notes} onSaved={onChanged} />
          </div>
        </div>
      )}
    </li>
  )
}
