"use client"

import { AlertTriangle, Check, Copy, PencilLine, RefreshCw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { GeneratedPreamble } from "@/lib/narrative/preamble/generate"
import type { ValidationResult } from "@/lib/narrative/types"
import { cn } from "@/lib/utils"
import { ValidationSummary } from "./validation-summary"

export type SavedTextState = "none" | "current" | "outdated" | "other"

type Props = {
  generated: GeneratedPreamble
  validation: ValidationResult
  savedState: SavedTextState
  locked: boolean
  onCopy: () => void
  onSave: () => void
  onEditFacts: () => void
  onSelectIssue: (field: string) => void
  selections: [string, string][]
}

const SAVED_LABEL: Record<SavedTextState, string> = {
  none: "Not yet saved to the report",
  current: "Saved to the report",
  outdated: "Preview differs from the saved preamble",
  other: "The report holds a different preamble",
}

export function PreamblePreview({ generated, validation, savedState, locked, onCopy, onSave, onEditFacts, onSelectIssue, selections }: Props) {
  const blocked = validation.errors.length > 0
  const saveLabel = savedState === "none" ? "Save preamble" : savedState === "current" ? "Saved" : "Regenerate saved preamble"

  return (
    <section id="preamble-preview" tabIndex={-1} aria-labelledby="preamble-preview-title" className="flex flex-col gap-3 rounded-xl border bg-card p-4 outline-none">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="preamble-preview-title" className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Generated preamble
        </h3>
        <p className="flex items-center gap-3 font-mono text-xs text-muted-foreground tabular-nums">
          <span>{generated.wordCount} words</span>
          <span className="flex items-center gap-1">
            {savedState === "current" ? <Check className="size-3.5 text-success" aria-hidden /> : <AlertTriangle className="size-3.5 text-amber-600" aria-hidden />}
            {SAVED_LABEL[savedState]}
          </span>
        </p>
      </header>

      <ValidationSummary validation={validation} onSelect={onSelectIssue} />

      <article aria-label="Preamble text" className="flex flex-col gap-3 rounded-lg border bg-background p-4 text-[15px] leading-relaxed text-pretty">
        {generated.paragraphs.map((paragraph) => (
          <div
            key={paragraph.id}
            className={cn(
              "rounded-md border-l-2 pl-3",
              paragraph.incomplete ? "border-amber-500 bg-amber-500/5" : "border-transparent",
            )}
          >
            {paragraph.incomplete && (
              <p className="mb-1 flex items-center gap-1 font-sans text-[11px] font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle className="size-3" aria-hidden />
                {paragraph.title}: incomplete
              </p>
            )}
            <p>
              {paragraph.segments.map((segment, i) =>
                "gap" in segment ? (
                  <mark
                    key={i}
                    className="mx-0.5 rounded border border-dashed border-amber-600 bg-amber-100 px-1 font-sans text-xs text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
                  >
                    <span className="sr-only">Missing: </span>
                    {segment.gap}
                  </mark>
                ) : (
                  <span key={i}>{segment.text}</span>
                ),
              )}
            </p>
          </div>
        ))}
      </article>
      <p className="text-[11px] text-muted-foreground">
        Highlighted markers show missing information. They are never copied or saved; the sentence is shortened instead.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={onSave} disabled={blocked || locked || savedState === "current"}>
          {savedState === "outdated" || savedState === "other" ? <RefreshCw aria-hidden /> : savedState === "current" ? <Check aria-hidden /> : <Save aria-hidden />}
          {saveLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCopy}>
          <Copy aria-hidden />
          Copy to clipboard
        </Button>
        <Button type="button" variant="ghost" onClick={onEditFacts} disabled={locked}>
          <PencilLine aria-hidden />
          Edit supporting facts
        </Button>
      </div>
      {blocked && <p className="text-xs text-muted-foreground">Resolve the issues above to save the preamble text. Your selections are saved automatically.</p>}
      {locked && <p className="text-xs text-muted-foreground">This preamble is Final. Set the status to Draft or Under Review to change it.</p>}

      <details className="rounded-lg border bg-background p-3 text-xs">
        <summary className="cursor-pointer font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Selections used for this text
        </summary>
        <dl className="mt-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
          {selections.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  )
}
