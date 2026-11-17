"use client"

// Sign-off: the Superintendent (the person named under Inspected by) signs; the Fleet Manager reviews and approves.
// The report counts as submitted only when every mandatory input is complete and the Fleet Manager has signed.

import { AlertCircle, ArrowRight, BadgeCheck, CircleCheck, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  outstandingBySection,
  outstandingForReview,
  reportStage,
  sectionTitle,
  superintendentName,
  superintendentSignature,
} from "@/lib/completeness"
import { formatDate } from "@/lib/narrative/dates"
import { WORKLIST_ITEMS, type Report, type SectionId } from "@/lib/form-schema"
import { SUPERINTENDENTS } from "@/lib/superintendents"
import { ConditionOverviewCard } from "./condition-overview-card"
import { ComboInput } from "./field-grid"
import { SignaturePad } from "./signature-pad"

type Props = {
  report: Report
  photoCount: number
  onWorklist: (key: string, value: boolean) => void
  onSignoff: (patch: Partial<Report["signoff"]>) => void
  onDetails: (patch: Record<string, string>) => void
  onGoTo: (section: SectionId) => void
}

function Mandatory() {
  return (
    <>
      {" "}
      <span aria-hidden className="text-destructive">*</span>
      <span className="sr-only">(mandatory)</span>
    </>
  )
}

const today = () => new Date().toLocaleDateString("en-CA")

export function SignoffSection({ report, photoCount, onWorklist, onSignoff, onDetails, onGoTo }: Props) {
  const outstanding = outstandingForReview(report, photoCount)
  const bySection = outstandingBySection(outstanding)
  const stage = reportStage(report, photoCount)
  const name = superintendentName(report)
  const signature = superintendentSignature(report)
  const legacyName = report.signoff.superintendentName?.trim() ?? ""
  const inspectedBy = report.details.inspectedBy?.trim() ?? ""
  const fm = {
    name: report.signoff.fleetManagerName ?? "",
    date: report.signoff.fleetManagerDate ?? "",
    signature: report.signoff.fleetManagerSignature ?? "",
  }
  const approved = Boolean(fm.signature)
  const fmLocked = stage === "draft" && !approved
  const reviewEnd = report.details.dateTo || report.details.dateFrom || ""
  const dateProblem =
    fm.date && reviewEnd && fm.date < reviewEnd
      ? "The approval date cannot be before the end of the inspection."
      : fm.date && fm.date > today()
        ? "The approval date cannot be in the future."
        : ""
  const sameReviewer = Boolean(fm.name && name && fm.name.trim().toLowerCase() === name.toLowerCase())

  return (
    <div className="flex flex-col gap-8">
      {/* Submission status */}
      {stage === "draft" ? (
        <section aria-labelledby="signoff-outstanding" className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <h3 id="signoff-outstanding" className="flex items-center gap-2 text-sm font-semibold">
            <AlertCircle className="size-4 text-destructive" aria-hidden />
            DRAFT – {outstanding.length} mandatory {outstanding.length === 1 ? "item" : "items"} outstanding
          </h3>
          <p className="text-sm text-muted-foreground">
            Items marked <span className="text-destructive">*</span> must be completed before the Fleet Manager can approve the report. Until then every PDF is
            watermarked DRAFT.
          </p>
          <ul className="flex flex-col gap-1.5">
            {[...bySection.entries()].map(([section, items]) => (
              <li key={section} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-background px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{sectionTitle(section)}</span>
                  <span className="text-muted-foreground"> – {items.map((i) => i.label).join("; ")}</span>
                </span>
                {section !== "signoff" && (
                  <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onGoTo(section)}>
                    Go to section
                    <ArrowRight aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : stage === "awaiting-approval" ? (
        <p className="flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm font-medium">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          All mandatory items are complete. The report is ready for the Fleet Manager’s review and approval.
        </p>
      ) : (
        <p className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/10 p-4 text-sm font-medium">
          <BadgeCheck className="size-4 text-success" aria-hidden />
          Approved by {fm.name} on {formatDate(fm.date)}. The report is complete and submitted.
        </p>
      )}

      {/* What the Superintendent and the Fleet Manager sign for */}
      <ConditionOverviewCard report={report} />

      {/* Work list confirmation */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Work list confirmation
          <Mandatory />
        </legend>
        {WORKLIST_ITEMS.map((item) => {
          const id = `worklist-${item.key}`
          return (
            <label
              key={item.key}
              htmlFor={id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-4 text-sm leading-relaxed transition-colors hover:bg-muted/60 has-data-checked:border-primary/50 has-data-checked:bg-accent"
            >
              <Checkbox id={id} checked={Boolean(report.worklist[item.key])} onCheckedChange={(v) => onWorklist(item.key, Boolean(v))} className="mt-0.5" />
              <span>
                {item.label}
                <Mandatory />
              </span>
            </label>
          )
        })}
      </fieldset>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Superintendent */}
        <section aria-labelledby="supt-title" className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <div className="flex flex-col gap-0.5">
            <h3 id="supt-title" className="text-sm font-semibold">
              Superintendent
            </h3>
            <p className="text-xs text-muted-foreground">The Superintendent who carried out the inspection signs the report.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Name
              <Mandatory />
            </span>
            {name ? (
              <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-sm">
                <span className="font-medium">{name}</span>
                <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onGoTo("details")}>
                  Change under Inspected by
                </Button>
              </p>
            ) : (
              <p className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive">
                Select the Superintendent under Inspection Details → Inspected by.
                <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onGoTo("details")}>
                  Go to Inspection Details
                </Button>
              </p>
            )}
            {legacyName && inspectedBy && legacyName.toLowerCase() !== inspectedBy.toLowerCase() && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                This report was previously signed off under the name “{legacyName}”. The Superintendent is now taken from Inspected by ({inspectedBy}).
              </p>
            )}
            {legacyName && !inspectedBy && (
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onDetails({ inspectedBy: legacyName })}>
                Use “{legacyName}” as Inspected by
              </Button>
            )}
          </div>
          <SignaturePad
            key={approved ? "supt-locked" : "supt"}
            label="Superintendent’s signature"
            required
            value={signature}
            disabledReason={approved ? "Locked while the Fleet Manager’s approval is in place." : undefined}
            onChange={(v) => onSignoff({ superintendentSignature: v, inspectorSignature: "" })}
          />
        </section>

        {/* Fleet Manager */}
        <section aria-labelledby="fm-title" className="flex flex-col gap-4 rounded-xl border bg-card p-4">
          <div className="flex flex-col gap-0.5">
            <h3 id="fm-title" className="text-sm font-semibold">
              Fleet Manager – review and approval
            </h3>
            <p className="text-xs text-muted-foreground">The Fleet Manager reviews the report and signs it off before submission.</p>
          </div>
          {fmLocked && (
            <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
              Available once all mandatory items are complete and the Superintendent has signed ({outstanding.length} outstanding).
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fm-name" className="text-sm font-medium">
                Name
                <Mandatory />
              </label>
              <ComboInput
                id="fm-name"
                field={{ key: "fleetManagerName", label: "Fleet Manager", options: SUPERINTENDENTS }}
                value={fm.name}
                disabled={fmLocked || approved}
                onChange={(v) => onSignoff({ fleetManagerName: v })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fm-date" className="text-sm font-medium">
                Approval date
                <Mandatory />
              </label>
              <Input
                id="fm-date"
                type="date"
                className="h-10"
                value={fm.date}
                min={reviewEnd || undefined}
                max={today()}
                disabled={fmLocked || approved}
                aria-invalid={dateProblem ? true : undefined}
                aria-describedby={dateProblem ? "fm-date-error" : undefined}
                onChange={(e) => onSignoff({ fleetManagerDate: e.target.value })}
              />
              {dateProblem && (
                <p id="fm-date-error" className="text-xs font-medium text-destructive">
                  {dateProblem}
                </p>
              )}
            </div>
          </div>
          {sameReviewer && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              The Fleet Manager is the same person as the Superintendent. An independent review is normally expected.
            </p>
          )}
          <SignaturePad
            key={fmLocked ? "fm-locked" : approved ? "fm-signed" : "fm-open"}
            label="Fleet Manager’s signature"
            required
            value={fm.signature}
            disabledReason={
              fmLocked
                ? "Available once the report is complete."
                : !fm.name || !fm.date || dateProblem
                  ? "Enter the Fleet Manager’s name and a valid approval date first."
                  : undefined
            }
            onChange={(v) => onSignoff({ fleetManagerSignature: v })}
          />
          {approved && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-1.5 text-success">
                <CircleCheck className="size-4" aria-hidden />
                Approved
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (window.confirm("Withdraw the Fleet Manager’s approval? The report returns to awaiting approval and the PDF will be marked DRAFT.")) {
                    onSignoff({ fleetManagerSignature: "" })
                  }
                }}
              >
                Withdraw approval
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
