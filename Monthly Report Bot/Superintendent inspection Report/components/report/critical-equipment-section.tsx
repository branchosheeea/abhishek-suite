"use client"

import { FieldGroups } from "@/components/report/field-grid"
import { Textarea } from "@/components/ui/textarea"
import { criticalOverview, findingRef } from "@/lib/condition-overview"
import {
  CRITICAL_EQUIPMENT_ITEMS,
  MANAGEMENT_SECTION_GROUPS,
  createEmptyReport,
  emptyFinding,
  isCriticalTested,
  type CriticalResult,
} from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { FindingFields } from "./finding-fields"

type Choice = "none" | "satisfactory" | "defect"

const CHOICES: { value: Choice; label: string; active: string }[] = [
  { value: "none", label: "Not tested", active: "border-slate-400/45 bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  { value: "satisfactory", label: "Satisfactory", active: "border-emerald-500/45 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" },
  { value: "defect", label: "Defect found", active: "border-rose-500/45 bg-rose-500/10 text-rose-800 dark:text-rose-300" },
]

export function CriticalEquipmentSection({
  values,
  results,
  onChange,
  onResult,
}: {
  values: Record<string, string>
  results: Record<string, CriticalResult>
  onChange: (key: string, value: string) => void
  onResult: (key: string, result: CriticalResult) => void
}) {
  const description = MANAGEMENT_SECTION_GROUPS.critical[0].description
  const summary = criticalOverview({ ...createEmptyReport("critical"), management: values, criticalResults: results })

  const choose = (item: (typeof CRITICAL_EQUIPMENT_ITEMS)[number], choice: Choice) => {
    const existing = results[item.key] ?? { result: "" }
    onChange(item.key, choice === "none" ? "" : "true")
    item.legacyKeys?.forEach((key) => onChange(key, ""))
    if (choice === "none") onResult(item.key, { ...existing, result: "" })
    else if (choice === "satisfactory") onResult(item.key, { ...existing, result: "satisfactory" })
    else onResult(item.key, { ...existing, result: "defect", finding: existing.finding ?? emptyFinding(true) })
  }

  return (
    <div className="flex flex-col gap-6">
      {description && (
        <p className="rounded-lg border border-dashed bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}

      <fieldset className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Tests carried out and their results</legend>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Tested <span className="font-mono font-semibold text-foreground">{summary.tested}</span> of {summary.total} · Satisfactory{" "}
          <span className="font-mono font-semibold text-foreground">{summary.satisfactory}</span> · Defects{" "}
          <span className={cn("font-mono font-semibold", summary.defects ? "text-destructive" : "text-foreground")}>{summary.defects}</span>
          {summary.notRecorded > 0 && (
            <>
              {" "}· <span className="font-semibold text-destructive">{summary.notRecorded} without a result *</span>
            </>
          )}
        </p>

        <ol className="flex flex-col divide-y">
          {CRITICAL_EQUIPMENT_ITEMS.map((item, index) => {
            const result = results[item.key]
            const tested = isCriticalTested(item, values) || Boolean(result?.result)
            const choice: Choice | "" = result?.result || (tested ? "" : "none")
            const labelId = `critical-${item.key}-label`
            return (
              <li key={item.key} className="flex flex-col gap-3 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span id={labelId} className="text-sm leading-snug">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{findingRef("critical", index)}</span>
                    {item.label}
                  </span>
                  <div role="radiogroup" aria-labelledby={labelId} className="grid shrink-0 grid-cols-3 gap-1.5">
                    {CHOICES.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        role="radio"
                        aria-checked={choice === c.value}
                        onClick={() => choose(item, c.value)}
                        className={cn(
                          "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                          choice === c.value ? c.active : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                        )}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
                {tested && !result?.result && (
                  <p className="text-xs font-medium text-destructive">* Tested: record the result (Satisfactory or Defect found).</p>
                )}
                {result?.result === "defect" && (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`critical-${item.key}-defect`} className="text-sm font-medium">
                        Defect found <span aria-hidden className="text-destructive">*</span>
                        <span className="sr-only">(mandatory)</span>
                      </label>
                      <Textarea
                        id={`critical-${item.key}-defect`}
                        value={result.description ?? ""}
                        onChange={(e) => onResult(item.key, { ...result, description: e.target.value })}
                        placeholder="What failed, the test criterion and the reading or behaviour observed…"
                        aria-invalid={!result.description?.trim() || undefined}
                        className="min-h-16 resize-y text-sm"
                      />
                    </div>
                    <FindingFields
                      findingRef={findingRef("critical", index)}
                      finding={result.finding ?? emptyFinding(true)}
                      deficient
                      idPrefix={`critical-${item.key}`}
                      onChange={(finding) => onResult(item.key, { ...result, finding })}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </fieldset>

      <FieldGroups
        groups={[{ title: "Test Results and Parameters", fields: MANAGEMENT_SECTION_GROUPS.critical[0].fields }]}
        values={values}
        idPrefix="critical"
        onChange={onChange}
      />
    </div>
  )
}
