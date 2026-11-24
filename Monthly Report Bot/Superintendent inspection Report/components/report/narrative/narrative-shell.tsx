"use client"

// Shared frame for every controlled-narrative section: header (status, save draft, reset), Final lock, protection of
// text not produced by the builder, the form beside a live preview, and the copy / save actions.

import { Lock, RotateCcw, Save } from "lucide-react"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { useReportEditor } from "@/hooks/use-report-editor"
import type { Report } from "@/lib/form-schema"
import type { GeneratedNarrative } from "@/lib/narrative/section"
import { placeholderProblems } from "@/lib/narrative/text"
import { NARRATIVE_STATUSES, type NarrativeState, type NarrativeStatus, type ValidationResult } from "@/lib/narrative/types"
import { PreamblePreview, type SavedTextState } from "../preamble/preamble-preview"
import type { StateChange } from "./use-narrative-state"

type Editor = ReturnType<typeof useReportEditor>

type Props<S extends NarrativeState<Record<string, unknown>>> = {
  report: Report
  saveNow: Editor["saveNow"]
  summaryKey: string
  /** Reads / writes the saved text; default `report.summary[summaryKey]`. */
  readText?: (report: Report) => string
  writeText?: (report: Report, text: string) => Partial<Report>
  heading: string
  description?: string
  state: S
  change: StateChange<S>
  defaultInputs: () => S["inputs"]
  generated: GeneratedNarrative
  validation: ValidationResult
  selections: [string, string][]
  focusIssue: (field: string) => void
  firstField: string
  children: ReactNode
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

function timeLabel(ms: number | null) {
  if (!ms) return ""
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function NarrativeShell<S extends NarrativeState<Record<string, unknown>>>({
  report,
  saveNow,
  summaryKey,
  readText,
  writeText,
  heading,
  description,
  state,
  change,
  defaultInputs,
  generated,
  validation,
  selections,
  focusIssue,
  firstField,
  children,
}: Props<S>) {
  const locked = state.status === "FINAL"
  const readSaved = readText ?? ((r: Report) => r.summary[summaryKey] ?? "")
  const writeSaved = writeText ?? ((r: Report, text: string) => ({ summary: { ...r.summary, [summaryKey]: text } }))
  const savedText = readSaved(report).trim()
  const savedState: SavedTextState = !savedText
    ? "none"
    : savedText !== state.generatedText.trim()
      ? "other"
      : savedText === generated.text
        ? "current"
        : "outdated"

  /** Writes the generated text into the report field. Asks before replacing text that did not come from the builder. */
  const commitText = (status?: NarrativeStatus) => {
    if (validation.errors.length) {
      toast.error("Resolve the highlighted issues first")
      focusIssue(validation.errors[0].field)
      return false
    }
    if (!generated.text) {
      toast.error("There is no text to save yet")
      return false
    }
    const problems = placeholderProblems(generated.text)
    if (problems.length) {
      toast.error(`The text cannot be saved: ${problems[0]}`)
      return false
    }
    if (
      savedState === "other" &&
      !window.confirm("This report already contains text here that was not produced by this builder (for example, typed by hand).\n\nReplace it with the generated text?")
    ) {
      return false
    }
    const text = generated.text
    const now = Date.now()
    change(
      () => ({ generatedText: text, lastGeneratedAt: now, ...(status ? { status } : {}) }) as Partial<S>,
      (r) => writeSaved(r, text),
    )
    return true
  }

  const save = () => {
    if (commitText()) toast.success(savedState === "none" ? "Saved to the report" : "Saved text regenerated")
  }

  const setStatus = (status: NarrativeStatus) => {
    if (status === state.status) return
    if (status === "FINAL") {
      if (savedState === "current") {
        change(() => ({ status }) as Partial<S>)
        toast.success("Marked Final")
      } else if (commitText("FINAL")) {
        toast.success("Saved and marked Final")
      }
      return
    }
    change(() => ({ status }) as Partial<S>)
  }

  const copy = async () => {
    if (placeholderProblems(generated.text).length) {
      toast.error("The text still contains a placeholder and cannot be copied")
      return
    }
    if (!(await copyText(generated.text))) {
      toast.error("Could not copy to the clipboard")
      return
    }
    if (validation.errors.length) toast.warning("Copied. Some required details are still missing, so those parts are left out.")
    else toast.success("Copied to the clipboard")
  }

  const reset = () => {
    if (!window.confirm("Reset all selections in this section to their defaults?\n\nText already saved in the report is kept.")) return
    change(() => ({ status: "DRAFT", inputs: defaultInputs() }) as Partial<S>)
    toast.success("Selections reset")
  }

  const saveDraft = async () => {
    await saveNow()
    toast.success(navigator.onLine ? "Draft saved and synced" : "Draft saved on this device")
  }

  const editFacts = () => {
    const firstError = validation.errors.find((e) => e.field !== "preview")
    focusIssue(firstError?.field ?? firstField)
  }

  const finalBlocked = validation.errors.length > 0 && state.status !== "FINAL"
  const vessel = (report.details.vessel ?? "").trim()

  return (
    <div className="@container flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Superintendent Inspection Report</p>
          <h3 className="text-base font-semibold">{heading}</h3>
          <p className="truncate text-sm text-muted-foreground">
            {vessel || "Vessel not selected"}
            {state.updatedAt > 0 && <> · Last updated {timeLabel(state.updatedAt)}</>}
            {state.lastGeneratedAt && <> · Text saved {timeLabel(state.lastGeneratedAt)}</>}
          </p>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${summaryKey}-status`} className="text-xs font-medium text-muted-foreground">
              Status
            </label>
            <select
              id={`${summaryKey}-status`}
              value={state.status}
              onChange={(e) => setStatus(e.target.value as NarrativeStatus)}
              aria-describedby={`${summaryKey}-status-hint`}
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {NARRATIVE_STATUSES.map((status) => (
                <option key={status.id} value={status.id} disabled={status.id === "FINAL" && finalBlocked}>
                  {status.id === "FINAL" && finalBlocked ? "Final (resolve issues first)" : status.label}
                </option>
              ))}
            </select>
            <span id={`${summaryKey}-status-hint`} className="sr-only">
              Final saves the generated text and locks the selections. It is available only when there are no issues to resolve.
            </span>
          </div>
          <Button type="button" variant="outline" onClick={saveDraft}>
            <Save aria-hidden />
            Save draft
          </Button>
          <Button type="button" variant="ghost" onClick={reset} disabled={locked}>
            <RotateCcw aria-hidden />
            Reset
          </Button>
        </div>
      </header>

      {locked && (
        <p className="flex items-center gap-2 rounded-lg border bg-muted/60 px-3 py-2 text-sm">
          <Lock className="size-4 shrink-0" aria-hidden />
          This section is Final, so the selections are locked. Set the status to Draft or Under Review to edit them.
        </p>
      )}

      {savedState === "other" && (
        <details className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            This report already has text here that was not produced by the builder. It stays in the report until you save the generated text.
          </summary>
          <p className="mt-2 whitespace-pre-line text-muted-foreground">{readSaved(report)}</p>
        </details>
      )}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        <div className="min-w-0 @4xl:sticky @4xl:top-28 @4xl:max-h-[calc(100dvh-8rem)] @4xl:overflow-y-auto">
          <PreamblePreview
            generated={generated}
            validation={validation}
            savedState={savedState}
            locked={locked}
            onCopy={copy}
            onSave={save}
            onEditFacts={editFacts}
            onSelectIssue={focusIssue}
            selections={selections}
          />
        </div>
      </div>
    </div>
  )
}
