"use client"

import { CheckCircle2, FileSpreadsheet, MessageSquare } from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { API, type Day, DAY_LABEL, formatDay, formatStamp, type Note, send, todayIso } from "./client"
import { NoteThread } from "./note-thread"

const STATE_STYLE: Record<Day["state"], string> = {
  expected: "border-dashed text-muted-foreground",
  received: "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  reviewed: "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300",
  no_report: "border-border bg-muted text-muted-foreground",
}

export function DayGrid({ dockingId, days, notes, onChanged }: { dockingId: string; days: Day[]; notes: Note[]; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState<number | null>(null)
  const today = todayIso()
  const counts = days.reduce((acc, d) => ({ ...acc, [d.state]: (acc[d.state] ?? 0) + 1 }), {} as Record<string, number>)

  return (
    <section aria-labelledby="days-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="days-title" className="text-lg font-bold">Reporting days</h2>
        <p className="text-xs text-muted-foreground">
          {(["received", "reviewed", "no_report", "expected"] as const).map((s) => `${counts[s] ?? 0} ${DAY_LABEL[s].toLowerCase()}`).join(" · ")}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Each day expects a Deck and an Engine file. Importing the vessel&apos;s daily workbooks comes next, once the workbook layout is final; until then days show as expected.
      </p>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {days.map((d) => {
          const dayNotes = notes.filter((n) => n.entity === "day" && n.entity_id === d.id)
          const isOpen = open === d.day_no
          return (
            <li key={d.day_no} className={cn("flex flex-col rounded-xl border bg-card", isOpen && "sm:col-span-2 lg:col-span-4")}>
              <button type="button" onClick={() => setOpen(isOpen ? null : d.day_no)} aria-expanded={isOpen}
                className="flex items-start justify-between gap-2 rounded-xl p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="flex flex-col">
                  <span className="font-bold">Day {d.day_no}{d.report_date === today && <span className="ml-1.5 text-xs font-semibold text-primary">today</span>}</span>
                  <span className="text-xs text-muted-foreground">{formatDay(d.report_date)}</span>
                  <span className="mt-1 flex gap-1 text-xs text-muted-foreground">
                    {(["deck", "engine"] as const).map((dep) => (
                      <span key={dep} className={cn("inline-flex items-center gap-0.5", d.files.some((f) => f.department === dep) && "font-semibold text-foreground")}>
                        <FileSpreadsheet className="size-3" aria-hidden />{dep === "deck" ? "Deck" : "Engine"}{d.files.some((f) => f.department === dep) ? " ✓" : ""}
                      </span>
                    ))}
                    {dayNotes.length > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare className="size-3" aria-hidden />{dayNotes.length}</span>}
                  </span>
                </span>
                <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold", STATE_STYLE[d.state])}>{DAY_LABEL[d.state]}</span>
              </button>
              {isOpen && <DayDetail dockingId={dockingId} day={d} notes={dayNotes} future={d.report_date > today} onChanged={onChanged} />}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function DayDetail({ dockingId, day, notes, future, onChanged }: { dockingId: string; day: Day; notes: Note[]; future: boolean; onChanged: () => Promise<unknown> }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true)
    try {
      await send(`${API}/${dockingId}/days/${day.day_no}`, "POST", body)
      toast.success(done)
      setReason("")
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t p-4">
      {day.files.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {day.files.map((f) => (
            <li key={f.department}><span className="font-semibold">{f.department === "deck" ? "Deck" : "Engine"}:</span> {f.file_name} · imported {formatStamp(f.imported_at)} · via {f.received_via}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No file received for this day.</p>
      )}
      {day.state === "no_report" && <p className="text-sm"><span className="font-semibold">No report:</span> {day.no_report_reason}</p>}

      {day.state === "received" && (
        <div>
          <Button size="sm" disabled={busy} onClick={() => act({ action: "reviewed" }, `Day ${day.day_no} marked as reviewed`)}>
            <CheckCircle2 aria-hidden /> Mark Day {day.day_no} as reviewed
          </Button>
        </div>
      )}
      {day.files.length === 0 && day.state !== "no_report" && !future && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); act({ action: "no_report", reason }, `Day ${day.day_no}: no report recorded`) }}>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">No report for this day — reason</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Arrived 2100 LT; immigration pending, no work" />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !reason.trim()}>Record no report</Button>
        </form>
      )}

      {day.id ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Notes on Day {day.day_no}</h3>
          <NoteThread dockingId={dockingId} entity="day" entityId={day.id} notes={notes} onSaved={onChanged} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Notes can be added once the day has a report or a &quot;no report&quot; record.</p>
      )}
    </div>
  )
}
