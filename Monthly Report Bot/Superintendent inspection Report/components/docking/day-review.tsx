"use client"

// One reporting day: the vessel's entries as received (department → who did the work → entries in workbook order),
// each with its photos, its job and the Superintendent's notes; beside it, the day's notes (for a past docking,
// the report that was sent to owners). The vessel's text is never edited here.

import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, FileText, MessageSquare, X } from "lucide-react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AREAS_DRAFT, areasFor } from "@/lib/docking/areas"
import { cn } from "@/lib/utils"
import { API, DAY_LABEL, type DayDetailView, type DepartmentDay, type Entry, formatDay, getJson, type Note, PeopleContext, type PhotoRef, photoUrl, send } from "./client"
import { ImportPanel } from "./import-panel"
import { NoteThread } from "./note-thread"

const SELECT = "h-8 max-w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
const GROUP_ORDER = ["Ship staff", "Yard staff", "Service engineer", "Class surveyor"]
const STAGING = "Staging"
const RECEIVED: Record<string, string> = { email: "email", teams: "Teams", other: "another way" }
type Filter = "all" | "unlinked" | "no_text"
type Viewer = { photos: PhotoRef[]; index: number; caption: string }

export function DayReview() {
  const { id, dayNo } = useParams<{ id: string; dayNo: string }>()
  const path = `${API}/${id}/days/${dayNo}`
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) => getJson<DayDetailView>(p))
  const [department, setDepartment] = useState<"deck" | "engine">("deck")
  const [filter, setFilter] = useState<Filter>("all")
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  if (error) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-9">
        <Link href={`/docking/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" aria-hidden /> Back to the docking</Link>
        <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error.message}</p>
      </main>
    )
  }
  if (isLoading || !data) return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-9"><p className="text-sm text-muted-foreground">Loading the day…</p></main>

  const { docking, day } = data
  const dep = data.departments.find((d) => d.department === department)!
  const dayNotes = data.notes.filter((n) => n.entity === "day")
  const total = (d: DepartmentDay) => ({ entries: d.entries.length, photos: d.entries.reduce((n, e) => n + e.photos.length, 0) })
  const shared = data.departments.some((d) => d.file?.shared)

  async function markReviewed() {
    setBusy(true)
    try {
      await send(`${API}/${id}/days/${day.day_no}`, "POST", { action: "reviewed" })
      toast.success(`Day ${day.day_no} marked as reviewed`)
      await mutate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PeopleContext value={data.people ?? {}}>
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-3 border-b pb-5">
        <Link href={`/docking/${id}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden /> {docking.vessel_name} · {docking.code}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <DayLink id={id} day={data.previous} label="Previous day"><ChevronLeft aria-hidden /></DayLink>
            <h1 className="text-2xl font-bold tracking-tight">Day {day.day_no} <span className="font-normal text-muted-foreground">· {formatDay(day.report_date)}</span></h1>
            <DayLink id={id} day={data.next} label="Next day"><ChevronRight aria-hidden /></DayLink>
            <Badge variant={day.state === "reviewed" ? "default" : "outline"}>{DAY_LABEL[day.state]}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {day.state === "received" && (
              <Button size="sm" disabled={busy} onClick={markReviewed}><CheckCircle2 aria-hidden /> Mark Day {day.day_no} as reviewed</Button>
            )}
            {day.id && (
              <Link href={`/docking/${id}/days/${day.day_no}/report`} className={cn(buttonVariants({ size: "sm", variant: day.state === "received" ? "outline" : "default" }))}>
                <FileText aria-hidden /> Daily report to owners
              </Link>
            )}
          </div>
        </div>
        {day.state === "no_report" && <p className="text-sm"><span className="font-semibold">No report:</span> {day.no_report_reason}</p>}
        {shared && (
          <p className="text-sm text-muted-foreground">
            The vessel sent one workbook for both departments (its own format, before the NeraVeda template): {data.departments.find((d) => d.file)?.file?.file_name}, received by {RECEIVED[data.departments.find((d) => d.file)?.file?.received_via ?? ""] ?? "email"}.
          </p>
        )}
        {docking.status !== "cancelled" && (
          <ImportPanel dockingId={id} day0Date={docking.day0_date} expected={{ dayNo: day.day_no, date: day.report_date }}
            onImported={async (done) => { if (done.day_no === day.day_no) await mutate(); else router.push(`/docking/${id}/days/${done.day_no}`) }} />
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
        <section aria-label="Vessel entries" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Department">
              {data.departments.map((d) => {
                const t = total(d)
                return (
                  <button key={d.department} type="button" role="tab" aria-selected={department === d.department} onClick={() => setDepartment(d.department)}
                    className={cn("rounded-md px-3 py-1 text-sm", department === d.department ? "bg-primary font-semibold text-primary-foreground" : "hover:bg-muted")}>
                    {d.department === "deck" ? "Deck" : "Engine"} <span className="opacity-80">· {t.entries} entries · {t.photos} photos</span>
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Show">
              {([["all", "All"], ["unlinked", "Not linked to a job"], ["no_text", "No description"]] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs", filter === k ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted")}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <DepartmentEntries key={department} dockingId={id} dep={dep} filter={filter} jobs={data.jobs} notes={data.notes} onChanged={() => mutate()} onOpen={setViewer} />
        </section>

        <aside aria-labelledby="day-notes-title" className="flex flex-col gap-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <h2 id="day-notes-title" className="flex items-center gap-1.5 text-lg font-bold"><MessageSquare className="size-4" aria-hidden /> Notes on Day {day.day_no}</h2>
          <p className="text-xs text-muted-foreground">Your notes on the day. For a past docking loaded from email, this holds the report as it was sent to owners.</p>
          {day.id
            ? <NoteThread dockingId={id} entity="day" entityId={day.id} notes={dayNotes} onSaved={() => mutate()} />
            : <p className="text-sm text-muted-foreground">Notes can be added once the day has a report.</p>}
        </aside>
      </div>

      {viewer && <PhotoViewer dockingId={id} viewer={viewer} onClose={() => setViewer(null)} onMove={(step) => setViewer((v) => v && { ...v, index: (v.index + step + v.photos.length) % v.photos.length })} />}
    </main>
    </PeopleContext>
  )
}

function DayLink({ id, day, label, children }: { id: string; day: number | null; label: string; children: ReactNode }) {
  if (day === null) return <span className="inline-flex size-8 items-center justify-center text-muted-foreground/40" aria-hidden>{children}</span>
  return (
    <Link href={`/docking/${id}/days/${day}`} aria-label={`${label} (Day ${day})`} title={`Day ${day}`}
      className="inline-flex size-8 items-center justify-center rounded-lg border hover:bg-muted [&_svg]:size-4">
      {children}
    </Link>
  )
}

function DepartmentEntries({ dockingId, dep, filter, jobs, notes, onChanged, onOpen }: {
  dockingId: string; dep: DepartmentDay; filter: Filter; jobs: DayDetailView["jobs"]; notes: Note[]
  onChanged: () => Promise<unknown>; onOpen: (v: Viewer) => void
}) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, Entry[]>()
    for (const e of dep.entries) {
      if (filter === "unlinked" && e.job) continue
      if (filter === "no_text" && !e.no_text) continue
      const key = e.area === STAGING ? STAGING : e.performed_by || "Other"
      byGroup.set(key, [...(byGroup.get(key) ?? []), e])
    }
    const rank = (k: string) => (k === STAGING ? 99 : GROUP_ORDER.includes(k) ? GROUP_ORDER.indexOf(k) : 50)
    return [...byGroup.entries()].sort((a, b) => rank(a[0]) - rank(b[0]))
  }, [dep.entries, filter])

  if (!dep.file) return <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No {dep.department} file was received for this day.</p>

  return (
    <div className="flex flex-col gap-5">
      {(dep.file.warnings.length > 0 || dep.file.rejected_photos.length > 0) && (
        <div className="flex flex-col gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
          {dep.file.warnings.map((w) => <p key={w} className="flex gap-1.5"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{w}</p>)}
          {dep.file.rejected_photos.length > 0 && <p>{dep.file.rejected_photos.length} photo(s) could not be placed: {dep.file.rejected_photos.slice(0, 3).map((r) => `${r.sheet}!${r.cell} (${r.reason})`).join("; ")}</p>}
        </div>
      )}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No entries match this filter.</p>}
      {groups.map(([group, entries]) => (
        <Group key={group} title={group} entries={entries} collapsed={group === STAGING}>
          {entries.map((e) => (
            <EntryCard key={e.id} dockingId={dockingId} entry={e} department={dep.department} jobs={jobs}
              notes={notes.filter((n) => n.entity === "activity" && n.entity_id === e.id)} onChanged={onChanged} onOpen={onOpen} />
          ))}
        </Group>
      ))}
    </div>
  )
}

function Group({ title, entries, collapsed, children }: { title: string; entries: Entry[]; collapsed: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed)
  const photos = entries.reduce((n, e) => n + e.photos.length, 0)
  return (
    <section className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit items-center gap-1.5 text-left">
        <h3 className="font-bold">{title === STAGING ? "Staging register" : `By ${title.toLowerCase()}`}</h3>
        <span className="text-sm text-muted-foreground">· {entries.length} {entries.length === 1 ? "entry" : "entries"} · {photos} photos</span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {title === STAGING && <p className="text-xs text-muted-foreground">The vessel copies the whole staging list forward every day, so most rows repeat earlier days.</p>}
      {open && <ol className="flex flex-col gap-2">{children}</ol>}
    </section>
  )
}

function EntryCard({ dockingId, entry, department, jobs, notes, onChanged, onOpen }: {
  dockingId: string; entry: Entry; department: "deck" | "engine"; jobs: DayDetailView["jobs"]; notes: Note[]
  onChanged: () => Promise<unknown>; onOpen: (v: Viewer) => void
}) {
  const [showNotes, setShowNotes] = useState(false)
  const caption = entry.no_text ? `${entry.row_ref} (no description)` : `${entry.row_ref} · ${entry.work_text}`
  return (
    <li className={cn("flex flex-col gap-2 rounded-xl border bg-card p-3", entry.no_text && "border-amber-500/40")}>
      <div className="flex items-start gap-3">
        <span className="w-16 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">{entry.row_ref}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {entry.no_text
            ? <p className="text-sm font-medium text-amber-800 dark:text-amber-300">No description on the vessel&apos;s sheet: {entry.photos.length} photo{entry.photos.length === 1 ? "" : "s"} only</p>
            : <p className="text-sm">{entry.work_text}</p>}
          {(entry.location && entry.area === STAGING) || entry.status || entry.findings ? (
            <p className="text-xs text-muted-foreground">
              {[entry.area === STAGING && entry.location, entry.status, entry.findings && `Findings: ${entry.findings}`].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
      {entry.photos.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pl-0 sm:pl-[4.75rem]">
          {entry.photos.map((p, i) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen({ photos: entry.photos, index: i, caption })} className="block rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                {/* eslint-disable-next-line @next/next/no-img-element -- photos are served by the docking API, already small */}
                <img src={photoUrl(dockingId, p.id)} alt={`Photo ${p.slot} of ${entry.row_ref}`} loading="lazy" decoding="async"
                  width={p.width && p.height ? Math.round((80 * p.width) / p.height) : 106} height={80}
                  className="h-20 w-auto rounded-md border bg-muted object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pl-0 sm:pl-[4.75rem]">
        <JobControl dockingId={dockingId} entry={entry} department={department} jobs={jobs} onChanged={onChanged}
          notesButton={
            <button type="button" onClick={() => setShowNotes(!showNotes)} aria-expanded={showNotes} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
              <MessageSquare className="size-3" aria-hidden /> {notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : "Add note"}
            </button>
          } />
        {showNotes && <div className="mt-2"><NoteThread dockingId={dockingId} entity="activity" entityId={entry.id} notes={notes} onSaved={onChanged} /></div>}
      </div>
    </li>
  )
}

function JobControl({ dockingId, entry, department, jobs, onChanged, notesButton }: {
  dockingId: string; entry: Entry; department: "deck" | "engine"; jobs: DayDetailView["jobs"]; onChanged: () => Promise<unknown>; notesButton: ReactNode
}) {
  const [mode, setMode] = useState<"idle" | "new" | "unlink">("idle")
  const [title, setTitle] = useState("")
  const [area, setArea] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const options = jobs.filter((j) => j.department === department)

  async function act(body: Record<string, unknown>, done: (job: { job_no: string } | null) => string) {
    setBusy(true)
    try {
      const { job } = await send<{ job: { job_no: string } | null }>(`${API}/${dockingId}/activities/${entry.id}`, "POST", body)
      toast.success(done(job))
      setMode("idle")
      setReason("")
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    } finally {
      setBusy(false)
    }
  }

  function choose(value: string) {
    if (value === "__new") {
      setTitle(entry.work_text.slice(0, 200))
      setArea(entry.area === STAGING ? STAGING : "")
      setMode("new")
    } else if (value === "") {
      if (entry.job) setMode("unlink")
    } else act({ action: "link", jobId: value }, (job) => `Linked to ${job?.job_no}`)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Job</span>
          <select className={cn(SELECT, "w-72", entry.job && "border-primary/50 font-medium")} value={entry.job?.id ?? ""} disabled={busy} onChange={(e) => choose(e.target.value)}>
            <option value="">Not linked</option>
            {options.map((j) => <option key={j.id} value={j.id}>{j.job_no} · {j.title.length > 60 ? `${j.title.slice(0, 60)}…` : j.title}</option>)}
            <option value="__new">+ New job from this entry…</option>
          </select>
        </label>
        {notesButton}
      </div>
      {mode === "new" && (
        <form className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3" onSubmit={(e: FormEvent) => { e.preventDefault(); act({ action: "new_job", title, area }, (job) => `${job?.job_no} created and linked`) }}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Job title</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Area / system{AREAS_DRAFT && <span className="font-normal text-muted-foreground"> (draft list)</span>}</span>
            <select className={cn(SELECT, "w-full")} value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">Not set</option>
              {areasFor(department).map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create job and link"}</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setMode("idle")}>Cancel</Button>
          </div>
        </form>
      )}
      {mode === "unlink" && entry.job && (
        <form className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/30 p-3" onSubmit={(e: FormEvent) => { e.preventDefault(); act({ action: "unlink", reason }, () => `Removed from ${entry.job?.job_no}`) }}>
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Reason for removing it from {entry.job.job_no}</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus placeholder="e.g. belongs to the ballast eductor job" />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !reason.trim()}>Remove link</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setMode("idle")}>Cancel</Button>
        </form>
      )}
    </div>
  )
}

function PhotoViewer({ dockingId, viewer, onClose, onMove }: { dockingId: string; viewer: Viewer; onClose: () => void; onMove: (step: number) => void }) {
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose()
    else if (e.key === "ArrowRight") onMove(1)
    else if (e.key === "ArrowLeft") onMove(-1)
  }, [onClose, onMove])
  useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onKey])
  const photo = viewer.photos[viewer.index]
  const many = viewer.photos.length > 1
  return (
    <div role="dialog" aria-modal="true" aria-label="Photo" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4" onClick={onClose}>
      <div className="flex max-w-full items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {many && <Button size="icon" variant="secondary" aria-label="Previous photo" onClick={() => onMove(-1)}><ChevronLeft aria-hidden /></Button>}
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the docking API */}
        <img src={photoUrl(dockingId, photo.id)} alt={viewer.caption} className="max-h-[78vh] min-h-[min(60vh,480px)] max-w-[calc(100vw-8rem)] rounded-md bg-black object-contain" />
        {many && <Button size="icon" variant="secondary" aria-label="Next photo" onClick={() => onMove(1)}><ChevronRight aria-hidden /></Button>}
      </div>
      <div className="flex max-w-3xl items-start gap-3 text-sm text-white/90" onClick={(e) => e.stopPropagation()}>
        <p className="flex-1">{viewer.caption}<span className="block text-xs text-white/60">Photo {viewer.index + 1} of {viewer.photos.length}{photo.width && photo.height ? ` · ${photo.width} × ${photo.height} px as sent` : ""}</span></p>
        <Button size="icon" variant="secondary" aria-label="Close" onClick={onClose}><X aria-hidden /></Button>
      </div>
    </div>
  )
}

