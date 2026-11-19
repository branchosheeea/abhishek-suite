"use client"

// Import of OVD Admin validation items from screenshots. The screenshot is read by the local OCR engine on this
// computer; the items are shown for review next to the image, and only added when the user clicks Add.

import { useCallback, useEffect, useRef, useState } from "react"
import { DNV_CATEGORIES, type DnvCategory } from "@/lib/engine/correlate"
import { missingAgainstTotals, type OvdAdminItem, sameItem, segmentText, toDnvEntry } from "@/lib/ocr/ovd-admin"
import type { ScreenshotResponse } from "@/lib/server/screenshot"
import { send, sendImage } from "../api"
import { Banner, Button, Card, cn, inputClass, Pill } from "../ui"
import type { Ctx } from "./types"

type Shot = { key: string; name: string; url: string; state: "reading" | "done" | "failed"; error?: string; result?: ScreenshotResponse }

type Draft = {
  key: string
  shot: string
  include: boolean
  duplicateOf: string | null
  repeat: boolean
  item: OvdAdminItem
  severity: "error" | "warning"
  category: DnvCategory
  message: string
  eventLocal: string
  eventName: string
  fuel: string
}

const MAX_BYTES = 15 * 1024 * 1024

async function toPng(file: Blob): Promise<Blob> {
  if (file.type === "image/png") return file
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be converted to PNG."))), "image/png"))
}

const localOf = (iso: string | null) => (iso ? iso.slice(0, 16) : "")

export function DnvImport({ ctx }: { ctx: Ctx }) {
  const session = ctx.data.session
  const [shots, setShots] = useState<Shot[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const counter = useRef(0)
  const draftsRef = useRef<Draft[]>([])
  draftsRef.current = drafts
  const shotsRef = useRef<Shot[]>([])
  shotsRef.current = shots

  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), [])

  const read = useCallback(async (file: File) => {
    const key = `s${(counter.current += 1)}`
    const name = file.name && file.name !== "image.png" ? file.name : `Pasted screenshot ${counter.current}`
    const url = URL.createObjectURL(file)
    setShots((list) => [...list, { key, name, url, state: "reading" }])
    try {
      if (!file.type.startsWith("image/")) throw new Error("Only images can be read here.")
      if (file.size > MAX_BYTES) throw new Error("The screenshot is larger than 15 MB.")
      const png = await toPng(file)
      const result = await sendImage<ScreenshotResponse>(`/api/sessions/${session._id}/dnv/screenshot`, png, name)
      const fresh: Draft[] = []
      result.items.forEach((item, i) => {
        const earlier = [...draftsRef.current, ...fresh].some((d) => sameItem({ category: d.category, eventUtc: d.item.eventUtc, fromUtc: d.item.fromUtc, toUtc: d.item.toUtc, description: d.message }, item))
        fresh.push({
          key: `${key}:${i}`, shot: key, include: !item.duplicateOf && !earlier, duplicateOf: item.duplicateOf, repeat: earlier, item,
          severity: item.severity, category: item.category, message: item.message, eventLocal: localOf(item.eventUtc), eventName: item.eventName ?? "", fuel: item.fuel ?? "",
        })
      })
      setDrafts((list) => [...list, ...fresh])
      setShots((list) => list.map((s) => (s.key === key ? { ...s, state: "done", result } : s)))
    } catch (error) {
      setShots((list) => list.map((s) => (s.key === key ? { ...s, state: "failed", error: (error as Error).message } : s)))
    }
  }, [session._id])

  const addFiles = useCallback((files: File[]) => {
    setAdded(null)
    for (const file of files) queue.current = queue.current.then(() => read(file))
  }, [read])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"))
      if (!files.length) return
      e.preventDefault()
      addFiles(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [addFiles])

  const update = (key: string, patch: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  function discard() {
    shots.forEach((s) => URL.revokeObjectURL(s.url))
    setShots([])
    setDrafts([])
    setConfirmed(false)
  }

  const reading = shots.some((s) => s.state === "reading")
  const chosen = drafts.filter((d) => d.include)
  const results = shots.flatMap((s) => (s.result ? [s.result] : []))
  const vessel = results.find((r) => r.vessel.imo)?.vessel ?? null
  const period = results.find((r) => r.period)?.period ?? null
  const canSetImo = !!vessel?.imo && !session.imo
  const canSetPeriod = !!period && !session.config.period
  const totals = results.find((r) => r.totals.issues !== null || r.totals.warnings !== null)?.totals ?? null
  const missing = reading ? null : missingAgainstTotals(totals, drafts.filter((d) => !d.repeat).map((d) => d.item))

  async function applyVessel() {
    try {
      await send("PATCH", `/api/sessions/${session._id}`, { ...(canSetImo ? { imo: vessel!.imo } : {}), ...(canSetPeriod ? { config: { period } } : {}) })
      await ctx.reload()
    } catch (error) {
      ctx.setError((error as Error).message)
    }
  }

  async function addChosen() {
    setBusy(true)
    try {
      const items = chosen.map((d) => {
        const shot = shots.find((s) => s.key === d.shot)!
        const eventUtc = d.eventLocal ? `${d.eventLocal}Z` : null
        return toDnvEntry(
          { ...d.item, severity: d.severity, category: d.category, message: d.message.trim(), eventUtc, eventName: d.eventName.trim() || null, fuel: d.fuel.trim().toUpperCase() || null },
          shot.result!.vessel.imo ?? session.imo,
          { sha256: shot.result!.sha256, name: shot.name, reader: shot.result!.engine },
          confirmed,
        )
      })
      const res = await send<{ added: number }>("POST", `/api/sessions/${session._id}/dnv`, { items })
      discard()
      setAdded(res.added)
      await ctx.reload()
    } catch (error) {
      ctx.setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Import from OVD Admin screenshots"
      actions={shots.length > 0 && <Button variant="ghost" className="h-8" onClick={discard} disabled={busy}>Discard all</Button>}
    >
      <div
        className={cn("flex flex-col gap-3 rounded-xl border-2 border-dashed px-4 py-4 transition-colors", dragging ? "border-primary bg-info-bg" : "border-border")}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles([...e.dataTransfer.files]) }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-9 cursor-pointer items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90">
            Choose screenshots
            <input type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple className="sr-only" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = "" }} />
          </label>
          <p className="text-sm">
            or press <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">Ctrl</kbd>+<kbd className="rounded border bg-muted px-1.5 font-mono text-xs">V</kbd> on this page to paste one, or drop image files here.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          In OVD Admin, expand the vessel so the checks are listed, press <strong>Win+Shift+S</strong> and select the list (vessel row, UnderWay/InPort rows and the items). Several screenshots can be added one after another while you scroll; repeated rows are recognised.
          The screenshot is read on this computer — it is not sent to the internet or to any AI service.
        </p>
      </div>

      {added !== null && (
        <div className="mt-3"><Banner tone="good" title={`${added} DNV item(s) added.`}>Click <strong>Run validation</strong> (top right) to check them against the vessel files.</Banner></div>
      )}

      {shots.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {shots.map((s) => (
            <figure key={s.key} className="flex w-48 flex-col gap-1 rounded-lg border p-2 text-xs">
              <a href={s.url} target="_blank" rel="noreferrer" title="Open the screenshot full size">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.name} className="h-24 w-full rounded object-cover object-left-top" />
              </a>
              <figcaption className="truncate font-semibold" title={s.name}>{s.name}</figcaption>
              {s.state === "reading" && <Pill tone="info">Reading on this computer… (≈15 s)</Pill>}
              {s.state === "done" && <Pill tone="good">{s.result!.items.length} item(s) · {(s.result!.ms / 1000).toFixed(0)} s</Pill>}
              {s.state === "failed" && <span className="text-critical">{s.error}</span>}
            </figure>
          ))}
        </div>
      )}

      {results.flatMap((r) => r.warnings).length > 0 && (
        <div className="mt-3">
          <Banner tone="warning" title="Check before adding">
            <ul className="list-disc pl-5">{[...new Set(results.flatMap((r) => r.warnings))].map((w) => <li key={w}>{w}</li>)}</ul>
          </Banner>
        </div>
      )}

      {missing && totals && (
        <div className="mt-3">
          {missing.issues + missing.warnings > 0 ? (
            <Banner tone="warning" title={`${[missing.issues && `${missing.issues} issue(s)`, missing.warnings && `${missing.warnings} warning(s)`].filter(Boolean).join(" and ")} not captured yet`}>
              OVD Admin shows {totals.issues ?? "?"} issue(s) and {totals.warnings ?? "?"} warning(s) for this vessel. Scroll further down in OVD Admin and paste another screenshot of the rest of the list; rows that appear twice are recognised.
            </Banner>
          ) : (
            <Banner tone="good" title={`All ${totals.issues ?? 0} issue(s) and ${totals.warnings ?? 0} warning(s) that OVD Admin shows have been read.`} />
          )}
        </div>
      )}

      {(canSetImo || canSetPeriod) && (
        <div className="mt-3">
          <Banner tone="info" title={`The screenshot shows ${vessel?.name ?? "the vessel"}${vessel?.imo ? `, IMO ${vessel.imo}` : ""}${period ? `, reporting period ${period.from} – ${period.to}` : ""}.`}>
            This session has no {canSetImo && canSetPeriod ? "IMO or reporting period" : canSetImo ? "IMO" : "reporting period"} yet.{" "}
            <Button variant="secondary" className="ml-1 h-7" onClick={applyVessel}>Use {canSetImo && canSetPeriod ? "them" : "it"} for this session</Button>
          </Banner>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm font-semibold">Review the items read from the screenshot{shots.length > 1 ? "s" : ""} — correct anything misread, untick what you don't want.</p>
          <ul className="flex flex-col gap-2">
            {drafts.map((d) => (
              <li key={d.key} className={cn("grid gap-2 rounded-lg border p-3", !d.include && "opacity-60")}>
                <div className="flex flex-wrap items-center gap-2">
                  <input type="checkbox" className="size-4" checked={d.include} onChange={(e) => update(d.key, { include: e.target.checked })} aria-label="Add this item" />
                  <select className={cn(inputClass, "h-8 w-28")} value={d.severity} onChange={(e) => update(d.key, { severity: e.target.value as Draft["severity"] })} aria-label="Severity">
                    <option value="error">Error</option>
                    <option value="warning">Warning</option>
                  </select>
                  <select className={cn(inputClass, "h-8 w-auto min-w-64 flex-1")} value={d.category} onChange={(e) => update(d.key, { category: e.target.value as DnvCategory })} aria-label="Check">
                    {Object.entries(DNV_CATEGORIES).map(([id, c]) => <option key={id} value={id}>{c.label}</option>)}
                  </select>
                  <input type="datetime-local" className={cn(inputClass, "h-8 w-48")} value={d.eventLocal} onChange={(e) => update(d.key, { eventLocal: e.target.value })} aria-label="Event time (UTC)" title="Event time (UTC)" />
                  <input className={cn(inputClass, "h-8 w-28")} value={d.eventName} onChange={(e) => update(d.key, { eventName: e.target.value })} placeholder="Event" aria-label="Event" />
                </div>
                <textarea className={cn(inputClass, "h-auto min-h-14 py-1.5")} rows={2} value={d.message} onChange={(e) => update(d.key, { message: e.target.value })} aria-label="Message" />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{d.item.checkName !== DNV_CATEGORIES[d.category].label ? `OVD Admin: ${d.item.checkName} · ` : ""}{segmentText(d.item.segment) ?? "no UnderWay/InPort row visible"}</span>
                  <label className="flex items-center gap-1">Fuel <input className={cn(inputClass, "h-7 w-20")} value={d.fuel} onChange={(e) => update(d.key, { fuel: e.target.value })} /></label>
                  {d.item.severitySource !== "icon" && <Pill tone="warning">Severity not read from the icon — check</Pill>}
                  {d.item.uncertain.length > 0 && <Pill tone="warning">Unclear text: {d.item.uncertain.slice(0, 4).join(", ")}</Pill>}
                  {!d.eventLocal && !d.item.fromUtc && <Pill tone="warning">No time read — enter it</Pill>}
                  {d.duplicateOf && <Pill tone="neutral">Already entered</Pill>}
                  {d.repeat && <Pill tone="neutral">Also in an earlier screenshot</Pill>}
                </div>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I have compared these items with the screenshot{shots.length > 1 ? "s" : ""}. Mark them as confirmed DNV evidence (otherwise they are added as unconfirmed and can be confirmed later).</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={addChosen} disabled={busy || reading || chosen.length === 0}>{busy ? "Adding…" : `Add ${chosen.length} item(s) to this session`}</Button>
            {reading && <span className="text-xs text-muted-foreground">Waiting for the screenshot(s) still being read…</span>}
          </div>
        </div>
      )}
    </Card>
  )
}
