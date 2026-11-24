"use client"

// "Verify on board": the Superintendent checks the value against a ship's document and records the evidence. The
// Vessel Master value becomes VERIFIED at once (POST /api/vessels/[id]/verify; rules in lib/vessel-master/verify.ts).

import { ShieldCheck } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch } from "@/lib/api"
import { DOCUMENT_TYPES } from "@/lib/vessel-master/evidence"
import type { VesselView } from "@/lib/vessel-master/view"

const IDENTITY = new Set(["vessel_name", "imo"])
const today = () => new Date().toLocaleDateString("en-CA")

export function VerifyForm({ vesselId, field, label, unit, value, reportId, onVerified, onCancel }: {
  vesselId: string
  field: string
  label: string
  unit?: string | null
  /** The value to verify, prefilled (the report's value, else the master's). */
  value: string
  reportId?: string
  onVerified: (vessel: VesselView) => void
  onCancel: () => void
}) {
  const [verified, setVerified] = useState(value)
  const [documentType, setDocumentType] = useState("")
  const [documentRef, setDocumentRef] = useState("")
  const [documentDate, setDocumentDate] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const id = `verify-${field}`
  const identity = IDENTITY.has(field)

  const submit = async () => {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/vessels/${vesselId}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field, value: verified, documentType, documentRef, documentDate, note, ...(reportId ? { reportId } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? "The verification could not be recorded.")
      toast.success(`${label} is now VERIFIED in the Vessel Master.`)
      onVerified(body.vessel as VesselView)
    } catch (e) {
      toast.error(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "The server cannot be reached. Verify when connected.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 sm:grid-cols-2"
      onSubmit={(e) => { e.preventDefault(); void submit() }}
    >
      <p className="text-sm sm:col-span-2">
        <span className="font-medium">Verify {label} on board.</span> Check it against the ship&apos;s document and record which one. The Vessel
        Master value becomes VERIFIED for every new report, with your name and this evidence.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-value`}>Value on the document{unit ? ` (${unit})` : ""} *</Label>
        <Input id={`${id}-value`} value={verified} onChange={(e) => setVerified(e.target.value)} readOnly={identity} maxLength={500} required />
        {identity && <span className="text-xs text-muted-foreground">Identifies the vessel: can be confirmed here, not changed.</span>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-doc`}>Document *</Label>
        <select
          id={`${id}-doc`}
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value)}
          required
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="">Select…</option>
          {DOCUMENT_TYPES.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-ref`}>Document number / reference *</Label>
        <Input id={`${id}-ref`} value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} maxLength={200} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-date`}>Document date</Label>
        <Input id={`${id}-date`} type="date" value={documentDate} max={today()} onChange={(e) => setDocumentDate(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-note`}>Note</Label>
        <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. sighted original in the Master's office" />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || !verified.trim() || !documentType || !documentRef.trim()}>
          <ShieldCheck aria-hidden />
          Record as VERIFIED
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
