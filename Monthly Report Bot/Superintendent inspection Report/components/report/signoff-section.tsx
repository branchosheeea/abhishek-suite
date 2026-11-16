"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { WORKLIST_ITEMS, type Report } from "@/lib/form-schema"
import { SignaturePad } from "./signature-pad"

type Props = {
  report: Report
  onWorklist: (key: string, value: boolean) => void
  onSignoff: (patch: Partial<Report["signoff"]>) => void
}

export function SignoffSection({ report, onWorklist, onSignoff }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Work list confirmation
        </legend>
        {WORKLIST_ITEMS.map((item) => {
          const id = `worklist-${item.key}`
          return (
            <label
              key={item.key}
              htmlFor={id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 text-sm leading-relaxed transition-colors hover:bg-muted/60 has-data-checked:border-primary/50 has-data-checked:bg-accent"
            >
              <Checkbox
                id={id}
                checked={Boolean(report.worklist[item.key])}
                onCheckedChange={(v) => onWorklist(item.key, Boolean(v))}
                className="mt-0.5"
              />
              <span>{item.label}</span>
            </label>
          )
        })}
      </fieldset>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <h3 className="text-sm font-semibold">Superintendent engineer</h3>
          <div className="flex flex-col gap-2">
            <Label htmlFor="supt-name">Name</Label>
            <Input
              id="supt-name"
              value={report.signoff.superintendentName}
              onChange={(e) => onSignoff({ superintendentName: e.target.value })}
              placeholder="Full name"
              className="h-10"
            />
          </div>
          <SignaturePad
            label="Superintendent signature"
            value={report.signoff.superintendentSignature}
            onChange={(v) => onSignoff({ superintendentSignature: v })}
          />
        </div>
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <h3 className="text-sm font-semibold">Inspector</h3>
          <p className="text-sm text-muted-foreground">
            Signed by <span className="font-medium text-foreground">{report.details.inspectedBy || "the inspector named in Details"}</span>.
          </p>
          <SignaturePad
            label="Inspector signature"
            value={report.signoff.inspectorSignature}
            onChange={(v) => onSignoff({ inspectorSignature: v })}
          />
        </div>
      </div>
    </div>
  )
}
