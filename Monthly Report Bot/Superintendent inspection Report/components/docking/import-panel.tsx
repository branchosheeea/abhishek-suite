"use client"

// Import a vessel's daily workbook: choose (or drop) the file, see what NeraVeda read from it and what it would change,
// then import. The file is read twice on the server (check, then import) and stored only on import.

import { AlertTriangle, FileSpreadsheet, Loader2, Upload, X } from "lucide-react"
import { type DragEvent, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { API, formatBytes, formatDay, type ImportDone, type ImportPlan, upload } from "./client"

const SELECT = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
const VIA = [["email", "Email"], ["teams", "Teams"], ["other", "Other"]] as const
const DEPT = { deck: "Deck", engine: "Engine" } as const

type Expected = { dayNo: number; date: string }

export function ImportPanel({ dockingId, day0Date, expected, onImported, className }: {
  dockingId: string
  day0Date: string
  /** The day the screen is showing: the file's date is compared with it. */
  expected?: Expected
  onImported: (done: ImportDone) => unknown
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button size="sm" variant="outline" className={cn("w-fit", className)} onClick={() => setOpen(true)}>
        <Upload aria-hidden /> {expected ? `Import a file for Day ${expected.dayNo}` : "Import a daily file"}
      </Button>
    )
  }
  return <ImportForm dockingId={dockingId} day0Date={day0Date} expected={expected} onClose={() => setOpen(false)} onImported={onImported} className={className} />
}

function ImportForm({ dockingId, day0Date, expected, onClose, onImported, className }: {
  dockingId: string; day0Date: string; expected?: Expected; onClose: () => void; onImported: (done: ImportDone) => unknown; className?: string
}) {
  const path = `${API}/${dockingId}/import`
  const [file, setFile] = useState<File | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [date, setDate] = useState("")
  const [via, setVia] = useState("email")
  const [reason, setReason] = useState("")
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)

  const form = (f: File, reportDate: string, extra: Record<string, string> = {}) => {
    const data = new FormData()
    data.set("file", f)
    if (reportDate) data.set("reportDate", reportDate)
    for (const [k, v] of Object.entries(extra)) data.set(k, v)
    return data
  }

  async function check(f: File, reportDate: string) {
    setChecking(true)
    setError("")
    try {
      let result = (await upload<{ plan: ImportPlan }>(`${path}?mode=check`, form(f, reportDate))).plan
      // a file without a date: try the day this screen is showing
      if (!reportDate && !result.file_date && expected) {
        reportDate = expected.date
        result = (await upload<{ plan: ImportPlan }>(`${path}?mode=check`, form(f, reportDate))).plan
      }
      setDate(reportDate)
      setPlan(result)
    } catch (err) {
      setPlan(null)
      setError(err instanceof Error ? err.message : "The file could not be checked.")
    } finally {
      setChecking(false)
    }
  }

  function choose(f: File | undefined) {
    if (!f) return
    if (!/\.xlsx$/i.test(f.name)) {
      setError(`${f.name} is not an Excel workbook (.xlsx).`)
      return
    }
    setFile(f)
    setReason("")
    void check(f, "")
  }

  async function run() {
    if (!file || !plan) return
    setImporting(true)
    try {
      const done = await upload<ImportDone>(path, form(file, date, { receivedVia: via, correctionReason: reason }))
      const depts = done.results.map((r) => DEPT[r.department]).join(" and ")
      toast.success(`Day ${done.day_no}: ${depts} imported`)
      onClose()
      await onImported(done)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The import did not work.")
    } finally {
      setImporting(false)
    }
  }

  function drop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    choose(e.dataTransfer.files?.[0])
  }

  const mismatch = Boolean(plan && expected && plan.file_date && plan.file_date !== expected.date)
  const blocked = !plan || plan.problems.length > 0 || checking || importing || (plan.needs_reason && !reason.trim())

  return (
    <section aria-label="Import a daily file" className={cn("flex flex-col gap-3 rounded-xl border bg-card p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Import the vessel&apos;s daily file</h3>
          <p className="text-xs text-muted-foreground">The workbook as the vessel sent it (.xlsx, up to 50 MB). Nothing is stored until you press Import.</p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose}><X aria-hidden /></Button>
      </div>

      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={drop}
        className={cn("flex cursor-pointer items-center gap-3 rounded-lg border border-dashed p-3 text-sm hover:bg-muted/40 focus-within:ring-3 focus-within:ring-ring/50", dragging && "border-primary bg-primary/5")}>
        <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          {file ? <><span className="font-medium break-all">{file.name}</span> <span className="text-muted-foreground">· {formatBytes(file.size)}</span></> : "Choose the workbook, or drop it here"}
        </span>
        <span className="text-xs font-semibold text-primary">{file ? "Choose another" : "Choose file"}</span>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
          onChange={(e) => { choose(e.target.files?.[0]); e.target.value = "" }} />
      </label>

      {checking && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the workbook…</p>}
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      {plan && !checking && file && (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-base font-bold">
              {plan.day_no !== null && plan.report_date ? <>Day {plan.day_no} <span className="font-normal text-muted-foreground">· {formatDay(plan.report_date)}</span></> : "Which day is this file?"}
            </p>
            <p className="text-xs text-muted-foreground">
              {plan.file_date ? `Dated ${formatDay(plan.file_date)} on the sheets` : "No date found on the sheets"}{plan.file_day_no !== null ? ` · calls itself Day ${plan.file_day_no}` : ""} · {plan.format}
            </p>
          </div>

          {mismatch && expected && (
            <fieldset className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <legend className="px-1 text-xs font-semibold">The file&apos;s date is not Day {expected.dayNo}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="import-date" checked={!date} onChange={() => void check(file, "")} />
                Import as the file says: {formatDay(plan.file_date!)}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="import-date" checked={date === expected.date} onChange={() => void check(file, expected.date)} />
                Import as Day {expected.dayNo} ({formatDay(expected.date)}): the date on the file is wrong
              </label>
            </fieldset>
          )}
          {!plan.file_date && (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Report date</span>
              <input type="date" className={SELECT} min={day0Date} value={date} onChange={(e) => { setDate(e.target.value); if (e.target.value) void check(file, e.target.value) }} />
            </label>
          )}

          <ul className="flex flex-col divide-y rounded-lg border text-sm">
            {plan.departments.map((d) => (
              <li key={d.department} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
                <span>
                  <span className="font-semibold">{DEPT[d.department]}</span>
                  {d.kind ? (
                    <span className="text-muted-foreground">
                      {" "}· {d.entries} entries{d.entries_without_text ? ` (${d.entries_without_text} without a description)` : ""} · {d.photos} photos
                      {d.photos_rejected ? ` · ${d.photos_rejected} pictures left out` : ""}
                    </span>
                  ) : <span className="text-muted-foreground"> · nothing in this file</span>}
                </span>
                {d.kind && <KindLabel kind={d.kind} current={d.current_file} />}
              </li>
            ))}
          </ul>

          {plan.problems.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {plan.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          {plan.warnings.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              {plan.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />{w}</li>)}
            </ul>
          )}

          {plan.problems.length === 0 && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Received by</span>
                <select className={SELECT} value={via} onChange={(e) => setVia(e.target.value)}>
                  {VIA.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </label>
              {plan.needs_reason && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Why is the reviewed file being replaced?</span>
                  <Textarea value={reason} maxLength={500} className="min-h-14" placeholder="e.g. Vessel resent the file with the missing engine photos" onChange={(e) => setReason(e.target.value)} />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={blocked} onClick={run}>
                  {importing ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />} Import into Day {plan.day_no}
                </Button>
                <Button size="sm" variant="outline" disabled={importing} onClick={onClose}>Cancel</Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function KindLabel({ kind, current }: { kind: NonNullable<ImportPlan["departments"][number]["kind"]>; current: string | null }) {
  const text = {
    initial: "New for this day",
    revision: `Replaces ${current} (not reviewed yet)`,
    amendment: `Replaces ${current}; the day was reviewed`,
    duplicate: "Same as the current file: no change",
  }[kind]
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold",
      kind === "initial" ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300"
        : kind === "duplicate" ? "text-muted-foreground" : "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300")}>
      {text}
    </span>
  )
}
