"use client"

// Principal Particulars from the Vessel Master (reports with a vesselSnapshot; lib/particulars.ts has the rules).
// Each field says where its value comes from: the master (VERIFIED / PROVISIONAL), an offered value the
// Superintendent chose ("Use this value"), or their own entry. Values the master does not release are left empty with
// the reason. "Refresh from Vessel Master" shows every difference before anything changes.

import { Flag as FlagIcon, Loader2, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FlagForm } from "@/components/vessels/flag-form"
import { useRecordedBy } from "@/hooks/use-vessel-master"
import type { FieldDef, Report, SnapshotField } from "@/lib/form-schema"
import { applyRefresh, confirmOffer, fromMaster, originOf, PARTICULARS_GROUPS_V2, refreshPlan, setParticular, type RefreshRow } from "@/lib/particulars"
import { fetchVesselView } from "@/lib/vessel-cache"
import type { VesselView } from "@/lib/vessel-master/view"
import { cn } from "@/lib/utils"

type Update = (mutator: (draft: Report) => Report) => void

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "")
const STATUS_STYLE: Record<string, string> = {
  VERIFIED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PROVISIONAL: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  CONFLICT: "bg-destructive/10 text-destructive",
  MISSING: "text-muted-foreground",
}

export function ParticularsV2({ report, update, go }: { report: Report; update: Update; go: (section: "details") => void }) {
  const by = useRecordedBy(report)
  const s = report.vesselSnapshot!
  const master = fromMaster(s)
  const [refresh, setRefresh] = useState<{ view: VesselView; fetchedAt: string; rows: RefreshRow[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [flagging, setFlagging] = useState<string | null>(null)

  const checkRefresh = async () => {
    if (!s.vesselId) return
    setChecking(true)
    try {
      const result = await fetchVesselView(s.vesselId)
      if (!result || result.source !== "network") {
        toast.error("The Vessel Master cannot be reached. Refresh when online.")
        return
      }
      const rows = refreshPlan(report, result.data)
      if (!rows.length) {
        if (result.data.revision !== s.masterRevision || s.source !== "master") {
          update((r) => applyRefresh(r, result.data, "master", result.fetchedAt, by, new Date().toISOString()))
        }
        toast.success("Principal Particulars match the Vessel Master. Nothing to change.")
        return
      }
      setRefresh({ view: result.data, fetchedAt: result.fetchedAt, rows })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <SourceBanner report={report} onChooseVessel={() => go("details")} onRefresh={checkRefresh} checking={checking} />

      {refresh && (
        <RefreshPanel
          rows={refresh.rows}
          revision={refresh.view.revision}
          onCancel={() => setRefresh(null)}
          onApply={() => {
            update((r) => applyRefresh(r, refresh.view, "master", refresh.fetchedAt, by, new Date().toISOString()))
            setRefresh(null)
            toast.success("Principal Particulars refreshed from the Vessel Master. Your own entries were kept.")
          }}
        />
      )}

      {PARTICULARS_GROUPS_V2.map((group) => (
        <fieldset key={group.title} className="flex flex-col gap-4">
          <legend className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.title}
            {group.title?.startsWith("F ·") && s.basisLabel && <span className="ml-2 normal-case tracking-normal">({s.basisLabel})</span>}
          </legend>
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((field) => (
              <ParticularField
                key={field.key}
                report={report}
                field={field}
                locked={field.key === "vessel_name" && master}
                onChange={(value) => update((r) => setParticular(r, field.key, value, by, new Date().toISOString()))}
                onUseOffer={() => update((r) => confirmOffer(r, field.key, by, new Date().toISOString()))}
                flagging={flagging === field.key}
                onFlag={master ? () => setFlagging(flagging === field.key ? null : field.key) : undefined}
                onFlagDone={() => setFlagging(null)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

function SourceBanner({ report, onChooseVessel, onRefresh, checking }: { report: Report; onChooseVessel: () => void; onRefresh: () => void; checking: boolean }) {
  const s = report.vesselSnapshot!
  const box = "flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
  if (s.source === "none") {
    return (
      <div className={cn(box, "border-dashed bg-muted/40")}>
        <p>Choose the vessel in Inspection Details. Its particulars are then filled in from the Vessel Master.</p>
        <Button size="sm" variant="outline" onClick={onChooseVessel}>Choose vessel</Button>
      </div>
    )
  }
  if (s.source === "pending") {
    return (
      <div className={cn(box, "border-amber-500/50 bg-amber-500/10")} role="status">
        <p>
          <strong>Vessel particulars pending.</strong> {s.name} was chosen while this device could not reach the Vessel Master and had no saved copy.
          They are filled in as soon as the report is open while online. Approval waits until then.
        </p>
      </div>
    )
  }
  if (s.source === "not-in-master") {
    return (
      <div className={cn(box, "bg-muted/40")}>
        <p>{s.name || "This vessel"} is not in the Vessel Master: enter its particulars by hand.</p>
      </div>
    )
  }
  return (
    <div className={cn(box, "bg-muted/40")}>
      <p className="text-pretty">
        {s.source === "offline-cache"
          ? `From the Vessel Master copy saved on this device (fetched ${when(s.fetchedAt)}).`
          : `From the Vessel Master (revision ${s.masterRevision}), captured ${when(s.capturedAt)}.`}{" "}
        Later changes in the master do not alter this report; Refresh compares first.{" "}
        <Link href="/inspections/vessels" className="underline underline-offset-2">Vessel Master</Link>
      </p>
      <Button size="sm" variant="outline" onClick={onRefresh} disabled={checking} className="shrink-0">
        {checking ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        Refresh from Vessel Master
      </Button>
    </div>
  )
}

const OUTCOME: Record<RefreshRow["outcome"], string> = {
  updated: "Updated to the master's value",
  cleared: "Cleared (no longer released)",
  kept: "Kept (your entry)",
  unchanged: "No change in the report",
}

function RefreshPanel({ rows, revision, onApply, onCancel }: { rows: RefreshRow[]; revision: number; onApply: () => void; onCancel: () => void }) {
  const cell = (f: SnapshotField | null) => (f ? `${f.value || "—"} · ${f.status}` : "—")
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4" aria-labelledby="refresh-heading">
      <h3 id="refresh-heading" className="font-semibold">Changes in the Vessel Master (revision {revision})</h3>
      <p className="text-sm text-muted-foreground">Nothing changes until you apply. Values you entered yourself are kept.</p>
      <div className="overflow-x-auto rounded-lg border bg-background">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Field</th>
              <th className="px-3 py-2 font-medium">In this report</th>
              <th className="px-3 py-2 font-medium">Master when captured</th>
              <th className="px-3 py-2 font-medium">Master now</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t align-top">
                <td className="px-3 py-2 font-medium">{r.label}</td>
                <td className="px-3 py-2">{r.reportValue || "—"}</td>
                <td className="px-3 py-2 text-muted-foreground">{cell(r.before)}</td>
                <td className="px-3 py-2">{cell(r.after)}</td>
                <td className="px-3 py-2">{OUTCOME[r.outcome]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button onClick={onApply}>Apply changes</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  )
}

function ParticularField({ report, field, locked, onChange, onUseOffer, flagging, onFlag, onFlagDone }: {
  report: Report
  field: FieldDef
  locked: boolean
  onChange: (value: string) => void
  onUseOffer: () => void
  flagging: boolean
  onFlag?: () => void
  onFlagDone: () => void
}) {
  const s = report.vesselSnapshot!
  const id = `particulars-${field.key}`
  const value = report.particulars[field.key] ?? ""
  const m = s.fields[field.key]
  const origin = originOf(report, field.key)
  const entered = s.entered[field.key]
  const confirmed = s.confirmed[field.key]
  const master = fromMaster(s)

  return (
    <div className={cn("flex flex-col gap-2", field.span === 3 && "sm:col-span-2 lg:col-span-3")}>
      <Label htmlFor={id} className="text-sm font-medium">
        <span>
          {field.label}
          {field.required && (
            <>
              {" "}
              <span aria-hidden className="text-destructive" title="Mandatory: the report stays DRAFT until this is completed">*</span>
              <span className="sr-only">(mandatory)</span>
            </>
          )}
        </span>
        {field.unit && <span className="font-normal text-muted-foreground">({field.unit})</span>}
      </Label>
      <div className="relative">
        <Input
          id={id}
          value={value}
          readOnly={locked}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-source`}
          className={cn("h-10", field.unit && "pr-20", locked && "bg-muted/50")}
        />
        {field.unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-muted-foreground">{field.unit}</span>
        )}
      </div>
      <div id={`${id}-source`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug text-muted-foreground">
        {locked && <span>Change the vessel in Inspection Details.</span>}
        {!locked && origin === "master" && m && (
          <>
            <Badge variant="outline" className={STATUS_STYLE[m.status]}>{m.status}</Badge>
            <span>From the Vessel Master</span>
          </>
        )}
        {origin === "confirmed" && m && confirmed && (
          <>
            <Badge variant="outline" className={STATUS_STYLE[m.status]}>{m.status}</Badge>
            <span>Master value used by {confirmed.by}</span>
          </>
        )}
        {origin === "entered" && master && (
          <span>
            Entered by {entered?.by ?? "you"}
            {m?.value && m.value !== value ? ` · master: ${m.value} (${m.status})` : ""}
            {entered?.flag === "sent" ? " · reported to the office" : entered?.flag === "pending" ? " · will be reported to the office" : ""}
          </span>
        )}
        {origin === "empty" && m?.release === "offer" && m.value && (
          <>
            <span>
              Master: <span className="font-mono text-foreground">{m.value}</span> ({m.status}, not yet verified)
            </span>
            <Button type="button" size="xs" variant="outline" onClick={onUseOffer}>Use this value</Button>
          </>
        )}
        {origin === "empty" && m?.release === "withhold" && m.value && (
          <span className="text-amber-700 dark:text-amber-400" title={m.reasons.join("\n")}>
            Not released ({m.physicalVerification ? "physical verification required" : m.status.toLowerCase()}): {m.value}. Enter the value you verified.
          </span>
        )}
        {origin === "empty" && master && !m?.value && s.source !== "pending" && <span>Not in the Vessel Master.</span>}
        {onFlag && (
          <button type="button" onClick={onFlag} className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline" aria-expanded={flagging}>
            <FlagIcon className="size-3" aria-hidden />
            Report issue
          </button>
        )}
      </div>
      {flagging && s.vesselId && (
        <FlagForm vesselId={s.vesselId} field={field.key} label={field.label} masterValue={m?.value ?? ""} reportId={report.id} proposed={origin === "entered" ? value : ""} onDone={onFlagDone} onCancel={onFlagDone} />
      )}
    </div>
  )
}
