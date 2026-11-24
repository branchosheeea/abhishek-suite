"use client"

// "Report master data issue": recorded for the office to review (POST /api/vessels/[id]/flags). The master itself is
// not changed. Used on the Vessel Master page and next to each particular in a report.

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { apiFetch } from "@/lib/api"

export async function postFlag(vesselId: string, body: { field: string; proposedValue: string; reason: string; source?: string; reportId?: string }) {
  const res = await apiFetch(`/api/vessels/${vesselId}/flags`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? "The issue could not be recorded.")
  return data.flag as { flagId: string }
}

export function FlagForm({ vesselId, field, label, masterValue, reportId, proposed = "", onDone, onCancel }: {
  vesselId: string
  field: string
  label: string
  masterValue: string
  reportId?: string
  proposed?: string
  onDone: () => void
  onCancel?: () => void
}) {
  const [proposedValue, setProposed] = useState(proposed)
  const [reason, setReason] = useState("")
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const id = `flag-${field}`
  const submit = async () => {
    setBusy(true)
    try {
      await postFlag(vesselId, { field, proposedValue, reason, source, ...(reportId ? { reportId } : {}) })
      toast.success("Issue recorded for review. The Vessel Master is unchanged until the office corrects it.")
      onDone()
    } catch (e) {
      toast.error(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "The server cannot be reached. Try again when connected.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <p className="text-sm sm:col-span-2">
        Report an issue with <span className="font-medium">{label}</span>: master value <span className="font-mono">{masterValue || "—"}</span>
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-value`}>Correct value (if known)</Label>
        <Input id={`${id}-value`} value={proposedValue} onChange={(e) => setProposed(e.target.value)} maxLength={500} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-source`}>Source (certificate, drawing, document)</Label>
        <Input id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value)} maxLength={500} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-reason`}>Why is it wrong or missing? *</Label>
        <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required className="min-h-20" />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || reason.trim().length < 5}>Record issue</Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}
