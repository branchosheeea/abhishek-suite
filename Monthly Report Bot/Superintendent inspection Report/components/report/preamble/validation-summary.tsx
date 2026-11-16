"use client"

import { AlertCircle, AlertTriangle, CircleCheck } from "lucide-react"
import type { ValidationResult } from "@/lib/narrative/types"

type Props = { validation: ValidationResult; onSelect: (field: string) => void }

export function ValidationSummary({ validation, onSelect }: Props) {
  const { errors, warnings } = validation
  const ready = errors.length === 0
  return (
    <section aria-label="Validation" className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <p role="status" className="flex items-center gap-2 text-sm font-medium">
        {ready ? (
          <>
            <CircleCheck className="size-4 text-success" aria-hidden />
            Ready to finalise
            {warnings.length > 0 && <span className="font-normal text-muted-foreground">· {warnings.length} to review</span>}
          </>
        ) : (
          <>
            <AlertCircle className="size-4 text-destructive" aria-hidden />
            {errors.length} {errors.length === 1 ? "issue" : "issues"} to resolve before finalising
            {warnings.length > 0 && <span className="font-normal text-muted-foreground">· {warnings.length} to review</span>}
          </>
        )}
      </p>
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="flex flex-col gap-1 text-xs">
          {errors.map((issue) => (
            <li key={`e-${issue.field}-${issue.message}`}>
              <button
                type="button"
                onClick={() => onSelect(issue.field)}
                className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-destructive outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  <span className="sr-only">Error: </span>
                  {issue.message}
                </span>
              </button>
            </li>
          ))}
          {warnings.map((issue) => (
            <li key={`w-${issue.field}-${issue.message}`}>
              <button
                type="button"
                onClick={() => onSelect(issue.field)}
                className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-amber-800 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 dark:text-amber-300"
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  <span className="sr-only">Warning: </span>
                  {issue.message}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
