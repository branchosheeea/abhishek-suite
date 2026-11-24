"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useVesselList } from "@/hooks/use-vessel-master"
import { FLEET_VESSELS } from "@/lib/vessels"
import { type Docking, formatOffset, OFFSETS, STATUS_LABEL, suggestCode } from "./client"

const TYPES = ["Special survey", "Intermediate survey", "Other"] as const
const SELECT = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30"

export type DockingFormValues = {
  vesselName: string; code: string; yard: string; location: string; dockingType: string; utcOffsetMinutes: number
  day0Date: string; arrivalTime: string; plannedDepartureDate: string; status: Docking["status"]
}

export function valuesOf(d?: Docking): DockingFormValues {
  return {
    vesselName: d?.vessel_name ?? "", code: d?.code ?? "", yard: d?.yard ?? "", location: d?.location ?? "",
    dockingType: d?.docking_type ?? "Special survey", utcOffsetMinutes: d?.utc_offset_minutes ?? 480, day0Date: d?.day0_date ?? "",
    arrivalTime: d?.arrival_time ?? "", plannedDepartureDate: d?.planned_departure_date ?? "", status: d?.status ?? "planned",
  }
}

/**
 * New docking, or its details. `frozen`: files have been imported, so vessel, code and Day 0 (which number the days)
 * cannot change — the server refuses it too.
 */
export function DockingForm({ initial, frozen, submitLabel, onSubmit, onCancel }: {
  initial?: Docking; frozen?: boolean; submitLabel: string
  onSubmit: (values: DockingFormValues) => Promise<void>; onCancel?: () => void
}) {
  const [v, setV] = useState<DockingFormValues>(valuesOf(initial))
  const [codeTouched, setCodeTouched] = useState(Boolean(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  // Vessels from the Vessel Master (saved copy when offline); the fixed fleet list if it cannot be read. The docking's own vessel stays listed.
  const { list } = useVesselList()
  const names = list?.data.filter((x) => x.selectable).map((x) => x.name) ?? [...FLEET_VESSELS]
  const fleet = v.vesselName && !names.includes(v.vesselName) ? [v.vesselName, ...names] : names
  const set = <K extends keyof DockingFormValues>(key: K, value: DockingFormValues[K]) => {
    setV((old) => {
      const next = { ...old, [key]: value }
      if (!codeTouched && (key === "vesselName" || key === "day0Date" || key === "dockingType")) next.code = suggestCode(next.vesselName, next.day0Date, next.dockingType)
      return next
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await onSubmit(v)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label="Vessel" id="dd-vessel">
        <select id="dd-vessel" className={SELECT} value={v.vesselName} disabled={frozen} required onChange={(e) => set("vesselName", e.target.value)}>
          <option value="">Choose the vessel…</option>
          {fleet.map((name) => <option key={name}>{name}</option>)}
        </select>
      </Field>
      <Field label="Docking type" id="dd-type">
        <select id="dd-type" className={SELECT} value={v.dockingType} onChange={(e) => set("dockingType", e.target.value)}>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Docking code" id="dd-code" hint="Used in job numbers, e.g. LEO-2025-SS-D-001">
        <Input id="dd-code" value={v.code} disabled={frozen} maxLength={24} required
          onChange={(e) => { setCodeTouched(true); set("code", e.target.value.toUpperCase()) }} />
      </Field>
      <Field label="Yard" id="dd-yard">
        <Input id="dd-yard" value={v.yard} maxLength={120} required placeholder="e.g. CIMC Changhong" onChange={(e) => set("yard", e.target.value)} />
      </Field>
      <Field label="Location" id="dd-location">
        <Input id="dd-location" value={v.location} maxLength={120} placeholder="e.g. Zhoushan, China" onChange={(e) => set("location", e.target.value)} />
      </Field>
      <Field label="Local time at the yard" id="dd-offset" hint="Used to convert reported local times">
        <select id="dd-offset" className={SELECT} value={v.utcOffsetMinutes} onChange={(e) => set("utcOffsetMinutes", Number(e.target.value))}>
          {OFFSETS.map((m) => <option key={m} value={m}>{formatOffset(m)}</option>)}
        </select>
      </Field>
      <Field label="Day 0 — arrival date at the yard" id="dd-day0" hint="Day N = N days after this date">
        <Input id="dd-day0" type="date" value={v.day0Date} disabled={frozen} required onChange={(e) => set("day0Date", e.target.value)} />
      </Field>
      <Field label="Arrival time (local)" id="dd-arrival">
        <Input id="dd-arrival" type="time" value={v.arrivalTime} onChange={(e) => set("arrivalTime", e.target.value)} />
      </Field>
      <Field label="Planned departure" id="dd-departure">
        <Input id="dd-departure" type="date" value={v.plannedDepartureDate} min={v.day0Date || undefined} onChange={(e) => set("plannedDepartureDate", e.target.value)} />
      </Field>
      {initial && (
        <Field label="Status" id="dd-status">
          <select id="dd-status" className={SELECT} value={v.status} onChange={(e) => set("status", e.target.value as Docking["status"])}>
            {Object.entries(STATUS_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </Field>
      )}
      {frozen && (
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
          Vessel, code and Day 0 are fixed because daily files have been imported: they number the days.
        </p>
      )}
      {error && <p role="alert" className="text-sm font-medium text-destructive sm:col-span-2 lg:col-span-3">{error}</p>}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : submitLabel}</Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </form>
  )
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}
