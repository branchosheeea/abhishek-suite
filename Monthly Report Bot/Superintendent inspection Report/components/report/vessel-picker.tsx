"use client"

// Vessel (Inspection Details) for reports with Vessel Master particulars: a fleet vessel from the Vessel Master, or
// "Other vessel" typed by hand. Choosing a vessel fills Principal Particulars (lib/particulars.ts).

import { Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useVesselActions, useVesselList } from "@/hooks/use-vessel-master"
import type { Report } from "@/lib/form-schema"
import { applyLinkedChange } from "@/lib/linked-fields"

const OTHER = "__other__"
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })

export function VesselPicker({ report, update, id }: { report: Report; update: (mutator: (draft: Report) => Report) => void; id: string }) {
  const { list } = useVesselList()
  const { choose, chooseOther, busy } = useVesselActions(report, update)
  const s = report.vesselSnapshot
  const other = s?.source === "not-in-master"
  const selected = other ? OTHER : (s?.vesselId ?? "")
  const vessels = (list?.data ?? []).filter((v) => v.selectable || v.vesselId === s?.vesselId)
  // The chosen vessel stays listed even when the list cannot be loaded (offline, nothing saved yet).
  const options = s?.vesselId && !vessels.some((v) => v.vesselId === s.vesselId) ? [{ vesselId: s.vesselId, name: s.name }, ...vessels] : vessels

  return (
    <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-1">
      <Label htmlFor={id} className="text-sm font-medium">
        <span>
          Vessel <span aria-hidden className="text-destructive" title="Mandatory: the report stays DRAFT until this is completed">*</span>
          <span className="sr-only">(mandatory)</span>
        </span>
      </Label>
      <div className="relative">
        <select
          id={id}
          value={selected}
          disabled={busy}
          onChange={(e) => {
            const value = e.target.value
            if (value === OTHER) chooseOther()
            else {
              const entry = list?.data.find((v) => v.vesselId === value)
              if (entry) void choose(entry)
            }
          }}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 dark:bg-input/30"
        >
          <option value="" disabled>Select the vessel…</option>
          {options.map((v) => (
            <option key={v.vesselId} value={v.vesselId}>{v.name}</option>
          ))}
          <option value={OTHER}>Other vessel (not in the Vessel Master)</option>
        </select>
        {busy && <Loader2 className="absolute top-3 right-8 size-4 animate-spin text-muted-foreground" aria-hidden />}
      </div>
      {other && (
        <Input
          id={`${id}-other`}
          aria-label="Vessel name (not in the Vessel Master)"
          value={report.details.vessel ?? ""}
          onChange={(e) => update((r) => applyLinkedChange(r, "details", "vessel", e.target.value))}
          placeholder="Vessel name"
          autoFocus={!report.details.vessel}
          className="h-10"
        />
      )}
      <p className="text-xs leading-snug text-muted-foreground">
        {other
          ? "Not in the Vessel Master: enter its particulars by hand in Principal Particulars."
          : list === undefined
            ? "Loading the Vessel Master…"
            : list === null
              ? "The Vessel Master cannot be reached and no copy is saved on this device. Choose “Other vessel”, or open the report while online."
              : list.source === "cache"
                ? `Offline: vessel list saved on this device on ${when(list.fetchedAt)}. Also fills Principal Particulars.`
                : "Fills Principal Particulars from the Vessel Master."}
      </p>
    </div>
  )
}
