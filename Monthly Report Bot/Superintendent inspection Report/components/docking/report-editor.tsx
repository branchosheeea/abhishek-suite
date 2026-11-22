"use client"

// The Daily Report to owners for one day. The draft starts from the vessel's entries (with their photos) and the
// previous day's header; the Superintendent edits wording, merges or adds items, picks photos, and fills in what the
// vessel cannot (summary, berth, ETD, weather, timed events). Changes save on their own a moment after typing.
// "Issue" freezes a version: the PDF and the email text are kept exactly as issued. NeraVeda never sends anything:
// the Superintendent copies the text into Outlook, attaches the PDF and sends it.

import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Check, ClipboardCopy, Combine, Download, Eye, FileText, ImagePlus, Plus, RefreshCw, Send, Trash2, X,
} from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import useSWR from "swr"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  dateLine, emailText, issueProblems, type ReportContent, type ReportItem, SECTIONS, type SectionKey,
} from "@/lib/docking/report/content"
import { cn } from "@/lib/utils"
import {
  API, type DayDetailView, type Entry, formatBytes, formatDay, formatStamp, getJson, PeopleContext, type PhotoRef, photoUrl, reportPath,
  type ReportView, send, who,
} from "./client"

type SaveState = "saved" | "pending" | "saving" | "error"
type EntryInfo = Entry & { department: "deck" | "engine" }
const SELECT = "h-7 max-w-full rounded-md border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
const newId = () => crypto.randomUUID()
const sectionLabel = (key: SectionKey) => {
  const s = SECTIONS.find((x) => x.key === key)!
  return s.group ? `${s.group === "DECK" ? "Deck" : "Engine"} · ${s.title.replace("Jobs carried out by ", "")}` : s.title
}

export function ReportEditor() {
  const { id, dayNo } = useParams<{ id: string; dayNo: string }>()
  const path = reportPath(id, dayNo)
  const { data, error, isLoading, mutate } = useSWR(path, (p: string) => getJson<ReportView>(p), { revalidateOnFocus: false })
  const day = useSWR(`${API}/${id}/days/${dayNo}`, (p: string) => getJson<DayDetailView>(p), { revalidateOnFocus: false })

  const [content, setContent] = useState<ReportContent | null>(null)
  const contentRef = useRef<ReportContent | null>(null)
  const savedRef = useRef<ReportContent | null>(null)
  const loadedRef = useRef<ReportContent | null>(null)
  const revRef = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef<Promise<void> | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState("")
  const [photoBytes, setPhotoBytes] = useState(0)
  const [busy, setBusy] = useState(false)

  /** Take the server's view as the current state (first load, start, rebuild, issue). */
  const adopt = useCallback((view: ReportView) => {
    if (view.report) {
      contentRef.current = view.report.content
      savedRef.current = view.report.content
      loadedRef.current = view.report.content
      revRef.current = view.report.rev
      setContent(view.report.content)
    }
    setPhotoBytes(view.photo_bytes)
    setSaveState("saved")
  }, [])

  useEffect(() => {
    if (data && contentRef.current === null && data.report) adopt(data)
  }, [data, adopt])

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    while (inflight.current) await inflight.current
    const sent = contentRef.current
    if (!sent || sent === savedRef.current) return
    setSaveState("saving")
    inflight.current = (async () => {
      try {
        const res = await send<{ rev: number; photo_bytes: number }>(path, "POST", { action: "save", rev: revRef.current, content: sent })
        revRef.current = res.rev
        savedRef.current = sent
        setPhotoBytes(res.photo_bytes)
        setSaveError("")
        setSaveState(contentRef.current === sent ? "saved" : "pending")
      } catch (err) {
        setSaveState("error")
        setSaveError(err instanceof Error ? err.message : "The report could not be saved.")
        throw err
      } finally {
        inflight.current = null
      }
    })()
    await inflight.current
    if (contentRef.current !== savedRef.current) await flush()
  }, [path])

  const edit = useCallback((fn: (c: ReportContent) => void) => {
    if (!contentRef.current) return
    const next = structuredClone(contentRef.current)
    fn(next)
    contentRef.current = next
    setContent(next)
    setSaveState("pending")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush().catch(() => undefined), 800)
  }, [flush])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (contentRef.current !== savedRef.current) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

  const entries = useMemo(() => {
    const map = new Map<string, EntryInfo>()
    for (const d of day.data?.departments ?? []) for (const e of d.entries) map.set(e.id, { ...e, department: d.department })
    return map
  }, [day.data])
  const photoRefs = useMemo(() => {
    const map = new Map<string, PhotoRef>()
    for (const e of entries.values()) for (const p of e.photos) map.set(p.id, p)
    return map
  }, [entries])

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true)
    try {
      await flush()
      const view = await send<ReportView>(path, "POST", { ...body, rev: revRef.current })
      adopt(view)
      await mutate(view, { revalidate: false })
      toast.success(done)
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
      return false
    } finally {
      setBusy(false)
    }
  }

  const back = (
    <Link href={`/docking/${id}/days/${dayNo}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden /> {day.data ? `${day.data.docking.vessel_name} · Day ${dayNo} entries` : `Day ${dayNo} entries`}
    </Link>
  )
  if (error) {
    return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-9">{back}<p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error.message}</p></main>
  }
  if (isLoading || !data) return <main className="mx-auto max-w-7xl px-4 py-8 sm:px-9"><p className="text-sm text-muted-foreground">Loading the report…</p></main>

  const ctx = { dayNo: data.day.day_no, reportDate: data.day.report_date }

  if (!data.report || !content) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-9">
        {back}
        <h1 className="text-2xl font-bold tracking-tight">Day {data.day.day_no} daily report <span className="font-normal text-muted-foreground">· {formatDay(data.day.report_date)}</span></h1>
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5">
          <p className="text-sm">The draft starts from what the vessel sent for Day {data.day.day_no}: one item per entry, with its photos, under Deck, Engine, Class and service engineers, as in your daily email. The staging register is left out.</p>
          <p className="text-sm text-muted-foreground">
            {data.carried_from_day !== null
              ? `The greeting, header lines (berth, dock entry, ETD, weather…) and the timed events you marked to carry come from the Day ${data.carried_from_day} report.`
              : "This is the first report of the docking: the header starts from the docking details (arrival, planned departure)."}
          </p>
          <Button className="w-fit" disabled={busy} onClick={async () => {
            setBusy(true)
            try {
              const view = await send<ReportView>(path, "POST", { action: "start" })
              adopt(view)
              await mutate(view, { revalidate: false })
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "The report could not be started.")
            } finally {
              setBusy(false)
            }
          }}>
            <FileText aria-hidden /> {busy ? "Starting…" : `Start the Day ${data.day.day_no} report`}
          </Button>
        </section>
      </main>
    )
  }

  const report = data.report
  const last = data.versions.at(-1)
  const problems = issueProblems(content)

  return (
    <PeopleContext value={data.people}>
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-9">
        <header className="flex flex-col gap-3 border-b pb-5">
          {back}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Day {data.day.day_no} daily report <span className="font-normal text-muted-foreground">· {formatDay(data.day.report_date)}</span></h1>
              {last
                ? <Badge>{`Version ${last.version} issued`}</Badge>
                : <Badge variant="outline">Draft</Badge>}
              {last && (report.changed_since_issue || content !== loadedRef.current) && <Badge variant="outline">Changed since version {last.version}</Badge>}
            </div>
            <SaveStatus state={saveState} error={saveError} updated={report.updated_at} onRetry={() => void flush().catch(() => undefined)} />
          </div>
          {data.newer_file && (
            <div role="status" className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <p className="flex gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                <span>The vessel&apos;s file <span className="font-medium">{data.newer_file.file_name}</span> was imported {formatStamp(data.newer_file.imported_at)}, after these items were drafted. The items below still show the earlier entries.</span>
              </p>
              <RebuildItems busy={busy} onRebuild={() => act({ action: "rebuild" }, "Items rebuilt from the vessel's new entries")} />
            </div>
          )}
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card title="Opening">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Greeting <span className="font-normal text-muted-foreground">(email only)</span></span>
                <Textarea value={content.greeting} maxLength={500} className="min-h-12" onChange={(e) => edit((c) => { c.greeting = e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Summary of the day</span>
                <Textarea value={content.summary} maxLength={8000} className="min-h-20" placeholder="Weather, delays, what owners should know first…" onChange={(e) => edit((c) => { c.summary = e.target.value })} />
              </label>
            </Card>

            <Card title="Header" note={data.carried_from_day !== null ? `Carried from the Day ${data.carried_from_day} report; change what moved.` : undefined}>
              <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 text-sm">
                <span className="text-muted-foreground">Date</span>
                <span className="px-2.5 py-1 font-medium">{dateLine(ctx)}</span>
                <span />
                {content.header.map((h, i) => (
                  <HeaderRow key={i} label={h.label} value={h.value}
                    onLabel={(v) => edit((c) => { c.header[i].label = v })} onValue={(v) => edit((c) => { c.header[i].value = v })}
                    onRemove={() => edit((c) => { c.header.splice(i, 1) })} />
                ))}
              </div>
              <Button size="sm" variant="outline" className="w-fit" disabled={content.header.length >= 20} onClick={() => edit((c) => { c.header.push({ label: "", value: "" }) })}><Plus aria-hidden /> Add a line</Button>
              <p className="text-xs text-muted-foreground">Lines with no value are left out of the report.</p>
            </Card>

            <Card title="Timed events" note="Arrival, dock entry, undocking… one line per event, e.g. “2018 LT: Pilot onboard”.">
              {content.events.map((e, i) => (
                <div key={e.id} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Input value={e.title} maxLength={120} placeholder="Heading, e.g. 17th Oct 2025:" className="font-medium" onChange={(ev) => edit((c) => { c.events[i].title = ev.target.value })} />
                    <IconButton label="Remove this block" onClick={() => edit((c) => { c.events.splice(i, 1) })}><Trash2 /></IconButton>
                  </div>
                  <Textarea value={e.text} maxLength={4000} className="min-h-16 font-mono text-xs md:text-xs" placeholder="2018 LT: Pilot onboard" onChange={(ev) => edit((c) => { c.events[i].text = ev.target.value })} />
                  <label className="flex w-fit items-center gap-2 text-xs">
                    <input type="checkbox" checked={e.carry} onChange={(ev) => edit((c) => { c.events[i].carry = ev.target.checked })} />
                    Carry to the next day&apos;s report
                  </label>
                </div>
              ))}
              <Button size="sm" variant="outline" className="w-fit" disabled={content.events.length >= 20} onClick={() => edit((c) => { c.events.push({ id: newId(), title: "", text: "", carry: false }) })}><Plus aria-hidden /> Add events</Button>
            </Card>

            {SECTIONS.map((s, index) => (
              <SectionEditor key={s.key} sectionKey={s.key} showGroup={Boolean(s.group) && SECTIONS[index - 1]?.group !== s.group}
                items={content.sections[s.key]} dockingId={id} entries={entries} photoRefs={photoRefs} day={day.data ?? null} edit={edit} />
            ))}

            <RebuildItems busy={busy} onRebuild={() => act({ action: "rebuild" }, "Items rebuilt from the vessel's entries")} />
          </div>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
            <IssuePanel view={data} problems={problems} photoBytes={photoBytes} saveState={saveState} busy={busy} path={path}
              onIssue={(reason) => act({ action: "issue", reason }, `Version ${(last?.version ?? 0) + 1} issued. Copy the email text and attach the PDF.`)} dockingId={id} />
            <Versions view={data} path={path} />
            <EmailPreview text={emailText(content, ctx)} />
          </aside>
        </div>
      </main>
    </PeopleContext>
  )
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div>
        <h2 className="font-bold">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 [&_svg]:size-3.5" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

function HeaderRow({ label, value, onLabel, onValue, onRemove }: { label: string; value: string; onLabel: (v: string) => void; onValue: (v: string) => void; onRemove: () => void }) {
  return (
    <>
      <Input value={label} maxLength={60} placeholder="Label" aria-label="Header label" className="h-8 text-muted-foreground" onChange={(e) => onLabel(e.target.value)} />
      <Input value={value} maxLength={300} placeholder="—" aria-label={label || "Header value"} className="h-8" onChange={(e) => onValue(e.target.value)} />
      <IconButton label={`Remove ${label || "this line"}`} onClick={onRemove}><X /></IconButton>
    </>
  )
}

function SaveStatus({ state, error, updated, onRetry }: { state: SaveState; error: string; updated: string; onRetry: () => void }) {
  if (state === "error") {
    return (
      <p role="alert" className="flex max-w-xl items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="size-4 shrink-0" aria-hidden /> Not saved: {error}
        <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
      </p>
    )
  }
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      {state === "saved" ? `Saved · ${formatStamp(updated)}` : state === "saving" ? "Saving…" : "Unsaved changes…"}
    </p>
  )
}

function SectionEditor({ sectionKey, showGroup, items, dockingId, entries, photoRefs, day, edit }: {
  sectionKey: SectionKey; showGroup: boolean; items: ReportItem[]; dockingId: string; entries: Map<string, EntryInfo>; photoRefs: Map<string, PhotoRef>
  day: DayDetailView | null; edit: (fn: (c: ReportContent) => void) => void
}) {
  const section = SECTIONS.find((s) => s.key === sectionKey)!
  const [focus, setFocus] = useState<string | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const photos = items.reduce((n, i) => n + i.photos.length, 0)
  const at = (c: ReportContent, itemId: string) => c.sections[sectionKey].findIndex((i) => i.id === itemId)

  function remove(item: ReportItem) {
    const snapshot: { content?: ReportContent } = {}
    edit((c) => {
      snapshot.content = structuredClone(c)
      c.sections[sectionKey].splice(at(c, item.id), 1)
    })
    toast("Item deleted", { action: { label: "Undo", onClick: () => edit((c) => { if (snapshot.content) Object.assign(c, snapshot.content) }) } })
  }

  return (
    <section className="flex flex-col gap-2">
      {showGroup && <h2 className="mt-2 rounded-md bg-primary px-3 py-1 text-sm font-bold tracking-wide text-primary-foreground">{section.group}</h2>}
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-bold">{section.title}</h3>
          <span className="text-xs text-muted-foreground">{items.length} {items.length === 1 ? "item" : "items"} · {photos} photos{!items.length && " · left out of the report while empty"}</span>
        </div>
        {items.length > 0 && (
          <ol className="flex flex-col gap-2">
            {items.map((item, i) => (
              <ItemEditor key={item.id} item={item} index={i} count={items.length} sectionKey={sectionKey} dockingId={dockingId} entries={entries} photoRefs={photoRefs}
                autoFocus={focus === item.id}
                onText={(v) => edit((c) => { c.sections[sectionKey][at(c, item.id)].text = v })}
                onCompany={(v) => edit((c) => { c.sections[sectionKey][at(c, item.id)].company = v })}
                onMove={(step) => edit((c) => {
                  const list = c.sections[sectionKey]
                  const from = at(c, item.id)
                  const [moved] = list.splice(from, 1)
                  list.splice(from + step, 0, moved)
                })}
                onMerge={() => edit((c) => {
                  const list = c.sections[sectionKey]
                  const from = at(c, item.id)
                  const above = list[from - 1]
                  above.text = [above.text.trim(), item.text.trim()].filter(Boolean).join(" ")
                  above.photos = [...new Set([...above.photos, ...item.photos])]
                  above.sources = [...new Set([...above.sources, ...item.sources])]
                  above.company ||= item.company
                  list.splice(from, 1)
                })}
                onSection={(target) => edit((c) => {
                  const [moved] = c.sections[sectionKey].splice(at(c, item.id), 1)
                  c.sections[target].push(moved)
                })}
                onRemovePhoto={(photoId) => edit((c) => {
                  const it = c.sections[sectionKey][at(c, item.id)]
                  it.photos = it.photos.filter((p) => p !== photoId)
                })}
                onPick={() => setPicking(item.id)}
                onDelete={() => remove(item)} />
            ))}
          </ol>
        )}
        <Button size="sm" variant="outline" className="w-fit" disabled={items.length >= 200} onClick={() => {
          const itemId = newId()
          edit((c) => { c.sections[sectionKey].push({ id: itemId, text: "", company: "", photos: [], sources: [] }) })
          setFocus(itemId)
        }}><Plus aria-hidden /> Add an item</Button>
      </div>
      {picking && day && (
        <PhotoPicker dockingId={dockingId} day={day} selected={items.find((i) => i.id === picking)?.photos ?? []}
          onToggle={(photoId) => edit((c) => {
            const it = c.sections[sectionKey][at(c, picking)]
            if (!it) return
            it.photos = it.photos.includes(photoId) ? it.photos.filter((p) => p !== photoId) : [...it.photos, photoId]
          })}
          onClose={() => setPicking(null)} />
      )}
    </section>
  )
}

function ItemEditor({ item, index, count, sectionKey, dockingId, entries, photoRefs, autoFocus, onText, onCompany, onMove, onMerge, onSection, onRemovePhoto, onPick, onDelete }: {
  item: ReportItem; index: number; count: number; sectionKey: SectionKey; dockingId: string; entries: Map<string, EntryInfo>; photoRefs: Map<string, PhotoRef>
  autoFocus: boolean; onText: (v: string) => void; onCompany: (v: string) => void; onMove: (step: number) => void; onMerge: () => void
  onSection: (key: SectionKey) => void; onRemovePhoto: (id: string) => void; onPick: () => void; onDelete: () => void
}) {
  const sources = item.sources.map((s) => entries.get(s)).filter((e): e is EntryInfo => Boolean(e))
  const vesselText = sources.map((e) => e.work_text.trim()).filter(Boolean).join(" ")
  const empty = !item.text.trim()
  return (
    <li className={cn("flex flex-col gap-2 rounded-xl border p-3", empty && "border-amber-500/50 bg-amber-500/5")}>
      <div className="flex items-start gap-2">
        <span className="w-6 shrink-0 pt-2 text-right text-sm font-semibold tabular-nums">{index + 1}.</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {sectionKey === "service" && (
            <Input value={item.company} maxLength={80} placeholder="Company, e.g. Alphatron" aria-label={`Company for item ${index + 1}`} className="h-8 w-64 max-w-full font-medium" onChange={(e) => onCompany(e.target.value)} />
          )}
          <Textarea value={item.text} maxLength={2000} autoFocus={autoFocus} aria-label={`Item ${index + 1}`} className="min-h-10"
            placeholder={item.photos.length ? "The vessel sent photos only: describe the work" : "Describe the work"} onChange={(e) => onText(e.target.value)} />
          {empty && <p className="text-xs text-amber-800 dark:text-amber-300">No text yet. Describe the work, merge it into the item above, or delete it before issuing.</p>}
          {sources.length > 0 && vesselText !== item.text.trim() && (
            <p className="text-xs text-muted-foreground"><span className="font-semibold">Vessel&apos;s text{sources.length > 1 ? ` (${sources.length} entries)` : ""}:</span> {vesselText || "none (photos only)"}</p>
          )}
          {!item.sources.length && <p className="text-xs text-muted-foreground">Added by you (not from a vessel entry).</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-8">
        {item.photos.map((p, n) => {
          const ref = photoRefs.get(p)
          return (
            <div key={p} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- photos are served by the docking API, already small */}
              <img src={photoUrl(dockingId, p)} alt={`Photo ${n + 1} of item ${index + 1}`} loading="lazy" decoding="async"
                width={ref?.width && ref.height ? Math.round((64 * ref.width) / ref.height) : 85} height={64} className="h-16 w-auto rounded-md border bg-muted object-cover" />
              <button type="button" aria-label={`Remove photo ${n + 1} from item ${index + 1}`} title="Remove from the report"
                onClick={() => onRemovePhoto(p)}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-foreground shadow-sm hover:bg-destructive hover:text-white">
                <X className="size-3" aria-hidden />
              </button>
            </div>
          )
        })}
        <Button type="button" size="sm" variant="outline" className="h-16 border-dashed" onClick={onPick}><ImagePlus aria-hidden /> Photos</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-8">
        <IconButton label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></IconButton>
        <IconButton label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></IconButton>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={index === 0} onClick={onMerge} title="Join this item to the one above (text, photos and vessel entries)">
          <Combine aria-hidden /> Merge with item above
        </Button>
        <select className={SELECT} aria-label="Move to another section" value="" onChange={(e) => e.target.value && onSection(e.target.value as SectionKey)}>
          <option value="">Move to…</option>
          {SECTIONS.filter((s) => s.key !== sectionKey).map((s) => <option key={s.key} value={s.key}>{sectionLabel(s.key)}</option>)}
        </select>
        <span className="flex-1" />
        <IconButton label="Delete this item" onClick={onDelete}><Trash2 /></IconButton>
      </div>
    </li>
  )
}

function PhotoPicker({ dockingId, day, selected, onToggle, onClose }: {
  dockingId: string; day: DayDetailView; selected: string[]; onToggle: (id: string) => void; onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const chosen = new Set(selected)
  return (
    <div role="dialog" aria-modal="true" aria-label="Choose photos" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col gap-3 rounded-2xl border bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-bold">Photos for this item</h2>
            <p className="text-xs text-muted-foreground">All photos the vessel sent for Day {day.day.day_no}. Click to add or remove; {selected.length} chosen.</p>
          </div>
          <Button size="sm" onClick={onClose}><Check aria-hidden /> Done</Button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto pr-1">
          {day.departments.map((d) => (
            <section key={d.department} className="flex flex-col gap-2">
              <h3 className="text-sm font-bold">{d.department === "deck" ? "Deck" : "Engine"}</h3>
              {d.entries.filter((e) => e.photos.length).map((e) => (
                <div key={e.id} className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground"><span className="font-mono">{e.row_ref}</span> · {e.performed_by || e.area} · {e.no_text ? "(no description)" : e.work_text}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {e.photos.map((p) => {
                      const on = chosen.has(p.id)
                      return (
                        <button key={p.id} type="button" aria-pressed={on} onClick={() => onToggle(p.id)}
                          className={cn("relative rounded-md border-2 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50", on ? "border-primary" : "border-transparent")}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- served by the docking API */}
                          <img src={photoUrl(dockingId, p.id)} alt={`${e.row_ref} photo ${p.slot}`} loading="lazy" decoding="async" className="h-16 w-auto rounded bg-muted object-cover"
                            width={p.width && p.height ? Math.round((64 * p.width) / p.height) : 85} height={64} />
                          {on && <span className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" aria-hidden /></span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

function RebuildItems({ busy, onRebuild }: { busy: boolean; onRebuild: () => Promise<boolean> }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" className="w-fit text-muted-foreground" onClick={() => setAsking(true)}>
        <RefreshCw aria-hidden /> Rebuild the items from the vessel&apos;s entries…
      </Button>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p>All items are replaced by the vessel&apos;s current entries and photos, for example after a corrected file. Your wording, merges and photo choices in the items are lost. Opening, header and timed events stay.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={async () => { if (await onRebuild()) setAsking(false) }}>Rebuild items</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking(false)}>Cancel</Button>
      </div>
    </div>
  )
}

function IssuePanel({ view, problems, photoBytes, saveState, busy, path, dockingId, onIssue }: {
  view: ReportView; problems: ReturnType<typeof issueProblems>; photoBytes: number; saveState: SaveState; busy: boolean; path: string; dockingId: string
  onIssue: (reason: string) => Promise<boolean>
}) {
  const [reason, setReason] = useState("")
  const last = view.versions.at(-1)
  const next = (last?.version ?? 0) + 1
  const estimate = photoBytes + 80 * 1024
  const ratio = estimate / view.max_pdf_bytes
  const saving = saveState !== "saved"
  const blocked = Boolean(view.issue_blocker) || problems.length > 0 || saving || (Boolean(last) && !reason.trim())
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <h2 className="font-bold">Issue to owners</h2>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs"><span>PDF size, about</span><span className="font-medium tabular-nums">{formatBytes(estimate)} of {formatBytes(view.max_pdf_bytes)}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className={cn("h-full rounded-full", ratio > 1 ? "bg-destructive" : ratio > 0.8 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        {ratio > 1 && <p className="text-xs text-destructive">Too large for owners&apos; mail. Remove some photos.</p>}
      </div>
      <a href={`${path}/pdf`} target="_blank" rel="noopener" aria-disabled={saving}
        className={cn(buttonVariants({ size: "sm", variant: "outline" }), "w-fit", saving && "pointer-events-none opacity-50")}>
        <Eye aria-hidden /> {saving ? "Saving…" : "Preview the PDF (draft)"}
      </a>
      {view.issue_blocker && (
        <p className="flex gap-1.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{view.issue_blocker}{view.day.state === "received" && <> <Link href={`/docking/${dockingId}/days/${view.day.day_no}`} className="underline">Open Day {view.day.day_no}</Link></>}</span>
        </p>
      )}
      {problems.length > 0 && (
        <div className="flex flex-col gap-1 text-sm text-amber-800 dark:text-amber-300">
          <p className="flex gap-1.5 font-medium"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> To fix before issuing ({problems.length}):</p>
          <ul className="ml-6 list-disc text-xs">
            {problems.slice(0, 6).map((p) => <li key={p.where}>{p.where} {p.message}</li>)}
            {problems.length > 6 && <li>and {problems.length - 6} more</li>}
          </ul>
        </div>
      )}
      {last && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">What changed in version {next}?</span>
          <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Class attendance added" />
        </label>
      )}
      <Button disabled={busy || blocked} onClick={async () => { if (await onIssue(reason)) setReason("") }}>
        <Send aria-hidden /> {busy ? "Issuing…" : `Issue version ${next}`}
      </Button>
      <p className="text-xs text-muted-foreground">Issuing keeps this version&apos;s PDF and email text exactly as they are. NeraVeda does not send anything: copy the text into your email and attach the PDF.</p>
    </section>
  )
}

function Versions({ view, path }: { view: ReportView; path: string }) {
  if (!view.versions.length) return null
  async function copy(text: string, version: number) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Email text of version ${version} copied. Paste it into Outlook and attach the PDF.`)
    } catch {
      toast.error("The browser did not allow copying. Select the text in the preview and copy it.")
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
      <h2 className="font-bold">Issued versions</h2>
      <ol className="flex flex-col divide-y">
        {[...view.versions].reverse().map((v) => (
          <li key={v.version} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
            <p className="text-sm"><span className="font-semibold">Version {v.version}</span> · {formatStamp(v.issued_at)} · {who(view.people, v.issued_by)}</p>
            <p className="text-xs text-muted-foreground">{v.file_name} · {formatBytes(v.pdf_bytes)} · {v.photos} photos{v.reason ? ` · ${v.reason}` : ""}</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => copy(v.email_text, v.version)}><ClipboardCopy aria-hidden /> Copy email text</Button>
              <a href={`${path}/versions/${v.version}?download=1`} className={buttonVariants({ size: "sm", variant: "outline" })}><Download aria-hidden /> PDF</a>
              <a href={`${path}/versions/${v.version}`} target="_blank" rel="noopener" className={buttonVariants({ size: "sm", variant: "ghost" })}><Eye aria-hidden /> Open</a>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function EmailPreview({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
      <button type="button" className="flex items-center justify-between text-left font-bold" aria-expanded={open} onClick={() => setOpen(!open)}>
        Email text (draft) <span className="text-xs font-normal text-primary">{open ? "Hide" : "Show"}</span>
      </button>
      {open && <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-sans text-xs leading-relaxed">{text}</pre>}
      {!open && <p className="text-xs text-muted-foreground">{text.split("\n").length} lines, {text.length.toLocaleString()} characters</p>}
    </section>
  )
}
