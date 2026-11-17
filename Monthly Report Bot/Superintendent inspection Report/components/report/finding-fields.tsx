"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { FINDING_PRIORITIES, RA_STATUSES, type Finding } from "@/lib/form-schema"
import { ClipboardList } from "lucide-react"

const SELECT =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

function Star() {
  return (
    <>
      <span aria-hidden className="text-destructive" title="Mandatory: the report stays DRAFT until this is completed">*</span>
      <span className="sr-only">(mandatory)</span>
    </>
  )
}

type Props = {
  /** Finding reference, e.g. ENG-02. */
  findingRef: string
  finding: Finding
  /** Deficient findings (and critical-test defects) always need a risk assessment status. */
  deficient: boolean
  idPrefix: string
  onChange: (finding: Finding) => void
}

/** Findings-register entry for a Degraded or Deficient item, or a critical-equipment test with a defect. */
export function FindingFields({ findingRef, finding, deficient, idPrefix, onChange }: Props) {
  const set = (patch: Partial<Finding>) => onChange({ ...finding, ...patch })
  const id = (key: string) => `${idPrefix}-finding-${key}`
  const dueNeeded = finding.priority !== "drydock" && finding.status !== "closed"
  const raNeeded = deficient || finding.priority === "immediate"
  const priorityHint = FINDING_PRIORITIES.find((p) => p.value === finding.priority)?.hint

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/40 p-3">
      <legend className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <ClipboardList className="size-3.5" aria-hidden />
        Findings register · <span className="font-mono text-foreground">{findingRef}</span>
      </legend>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("action")} className="text-sm font-medium">
          Corrective action / interim controls <Star />
        </label>
        <Textarea
          id={id("action")}
          value={finding.action}
          onChange={(e) => set({ action: e.target.value })}
          placeholder="What is being done, by whom, and the controls in place until it is rectified…"
          aria-invalid={!finding.action.trim() || undefined}
          className="min-h-16 resize-y text-sm"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("priority")} className="text-sm font-medium">
            Priority <Star />
          </label>
          <select id={id("priority")} value={finding.priority} onChange={(e) => set({ priority: e.target.value as Finding["priority"] })} className={SELECT}>
            <option value="">Select…</option>
            {FINDING_PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {priorityHint && <span className="text-xs text-muted-foreground">{priorityHint}</span>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("due")} className="text-sm font-medium">
            Due date {dueNeeded && <Star />}
          </label>
          <Input id={id("due")} type="date" value={finding.dueDate} onChange={(e) => set({ dueDate: e.target.value })} className="h-10" />
          {!dueNeeded && <span className="text-xs text-muted-foreground">Not needed for {finding.status === "closed" ? "a closed finding" : "Next dry-docking"}</span>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("ra")} className="text-sm font-medium">
            Risk assessment {raNeeded && <Star />}
          </label>
          <select id={id("ra")} value={finding.raStatus} onChange={(e) => set({ raStatus: e.target.value as Finding["raStatus"] })} className={SELECT}>
            <option value="">Select…</option>
            {RA_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("raRef")} className="text-sm font-medium">
            RA number {finding.raStatus === "completed" && <Star />}
          </label>
          <Input
            id={id("raRef")}
            value={finding.raRef}
            onChange={(e) => set({ raRef: e.target.value })}
            placeholder={finding.raStatus === "notRequired" ? "—" : "e.g. RA-2026-017"}
            disabled={finding.raStatus === "notRequired"}
            className="h-10"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("defectRef")} className="text-sm font-medium">
            Defect list (DDRL / PMS) no.
          </label>
          <Input id={id("defectRef")} value={finding.defectRef} onChange={(e) => set({ defectRef: e.target.value })} placeholder="Optional" className="h-10" />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={id("status")} className="text-sm font-medium">
            Status
          </label>
          <select id={id("status")} value={finding.status} onChange={(e) => set({ status: e.target.value as Finding["status"] })} className={SELECT}>
            <option value="open">Open</option>
            <option value="closed">Closed during the attendance</option>
          </select>
        </div>

        <label className="flex min-h-10 cursor-pointer items-center gap-2.5 self-end text-sm sm:col-span-2">
          <Checkbox checked={finding.safetyCritical} onCheckedChange={(checked) => set({ safetyCritical: checked === true })} />
          Safety-critical (equipment or system under ISM Code 10.3)
        </label>
      </div>
    </fieldset>
  )
}
