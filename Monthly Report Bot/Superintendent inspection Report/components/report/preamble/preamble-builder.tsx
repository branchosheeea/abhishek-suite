"use client"

import { Lock, RotateCcw, Save } from "lucide-react"
import { useMemo } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { useReportEditor } from "@/hooks/use-report-editor"
import { formatDate } from "@/lib/narrative/dates"
import { generatePreamble } from "@/lib/narrative/preamble/generate"
import {
  defaultPreambleInputs,
  normalisePreambleState,
  type PreambleFacts,
  type PreambleInputs,
  type PreambleState,
} from "@/lib/narrative/preamble/model"
import {
  ATTENDANCE_ACTIONS,
  CLOSING_STATEMENTS,
  DEFICIENCY_STATUSES,
  FOCUS_AREAS,
  FOLLOW_UP_METHODS,
  INSPECTION_TYPES,
  LOCATION_TYPES,
  OPENING_MEETINGS,
  OPERATING_CONDITIONS,
  PRIMARY_OBJECTIVES,
  VESSEL_STATUSES,
  findOption,
} from "@/lib/narrative/preamble/options"
import { issuesFor, validatePreamble, type IssueField } from "@/lib/narrative/preamble/validate"
import { placeholderProblems } from "@/lib/narrative/text"
import { NARRATIVE_STATUSES, type NarrativeStatus } from "@/lib/narrative/types"
import type { Report } from "@/lib/form-schema"
import { vesselIdFor } from "@/lib/vessels"
import { AttendanceDetailsForm } from "./attendance-details-form"
import { fieldId } from "./fields"
import type { DetailsField } from "./form-types"
import { InspectionContextForm } from "./inspection-context-form"
import { PreamblePreview, type SavedTextState } from "./preamble-preview"

type Editor = ReturnType<typeof useReportEditor>

type Props = {
  report: Report
  update: Editor["update"]
  saveNow: Editor["saveNow"]
}

function preambleOf(report: Report): PreambleState {
  return normalisePreambleState(report.narratives?.preamble, { port: report.details.port })
}

function factsOf(report: Report): PreambleFacts {
  return { vesselName: report.details.vessel ?? "", startDate: report.details.dateFrom ?? "", endDate: report.details.dateTo ?? "" }
}

const FACT_FIELD_IDS: Record<string, string> = { vessel: "vessel", startDate: "startDate", endDate: "endDate" }

function focusField(field: string) {
  const el = document.getElementById(field === "preview" ? "preamble-preview" : fieldId(FACT_FIELD_IDS[field] ?? field))
  if (!el) return
  const target = el.matches("input, select, textarea, section")
    ? el
    : el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, [role=checkbox], button") ?? el
  target.scrollIntoView({ block: "center", behavior: "smooth" })
  target.focus({ preventScroll: true })
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

/** Plain-language list of the selections behind the text, so the user can compare them with the output. */
function describeSelections(inputs: PreambleInputs, facts: PreambleFacts): [string, string][] {
  const label = <T extends { id: string; label: string }>(options: readonly T[], id: string) => findOption(options, id)?.label ?? "—"
  const many = <T extends { id: string; label: string }>(options: readonly T[], ids: readonly string[]) =>
    ids.length ? ids.map((id) => label(options, id)).join("; ") : "—"
  const dates = [formatDate(facts.startDate), formatDate(facts.endDate)].filter(Boolean)
  const location =
    inputs.locationType === "SINGLE"
      ? inputs.location
      : inputs.locationType === "PORT_TO_PORT"
        ? `${inputs.joiningLocation || "?"} → ${inputs.disembarkationLocation || "?"}`
        : inputs.locationType === "SHIPYARD"
          ? [inputs.shipyardName, inputs.shipyardPort, inputs.shipyardCountry].filter(Boolean).join(", ")
          : inputs.locationType === "AT_SEA"
            ? `At sea${inputs.voyageRoute ? ` (${inputs.voyageRoute})` : ""}`
            : inputs.otherLocation
  return [
    ["Vessel", facts.vesselName || "—"],
    ["Inspection type", label(INSPECTION_TYPES, inputs.inspectionType)],
    ["Attendance action", label(ATTENDANCE_ACTIONS, inputs.attendanceAction)],
    ["Dates", dates.length ? [...new Set(dates)].join(" – ") : "—"],
    [label(LOCATION_TYPES, inputs.locationType), location || "—"],
    ["Vessel status", label(VESSEL_STATUSES, inputs.vesselStatus)],
    ["Opening meeting", label(OPENING_MEETINGS, inputs.openingMeeting)],
    ["Primary objectives", many(PRIMARY_OBJECTIVES, inputs.primaryObjectives)],
    ["Operating conditions", label(OPERATING_CONDITIONS, inputs.operatingCondition)],
    ["Additional focus", many(FOCUS_AREAS, inputs.additionalFocusAreas)],
    ["Deficiency status", inputs.deficiencyStatus ? label(DEFICIENCY_STATUSES, inputs.deficiencyStatus) : "Not confirmed"],
    ["Follow-up", many(FOLLOW_UP_METHODS, inputs.followUpMethods)],
    ["Closing", label(CLOSING_STATEMENTS, inputs.closingStatement)],
  ]
}

function timeLabel(ms: number | null) {
  if (!ms) return ""
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function PreambleBuilder({ report, update, saveNow }: Props) {
  const state = useMemo(() => preambleOf(report), [report])
  const facts = useMemo(() => factsOf(report), [report])
  const generated = useMemo(() => generatePreamble(state.inputs, facts), [state.inputs, facts])
  const validation = useMemo(() => validatePreamble(state.inputs, facts, generated), [state.inputs, facts, generated])
  const locked = state.status === "FINAL"

  const savedText = (report.summary.preamble ?? "").trim()
  const savedState: SavedTextState = !savedText
    ? "none"
    : savedText !== state.generatedText.trim()
      ? "other"
      : savedText === generated.text
        ? "current"
        : "outdated"

  /** Applies a change to the preamble state, starting from the latest saved report (never a stale render). */
  const change = (mutate: (current: PreambleState, report: Report) => Partial<PreambleState>, extra?: (r: Report) => Partial<Report>) =>
    update((r) => {
      const current = preambleOf(r)
      const next: PreambleState = { ...current, ...mutate(current, r), updatedAt: Date.now() }
      return { ...r, ...extra?.(r), narratives: { ...r.narratives, preamble: next } }
    })

  const set = (patch: Partial<PreambleInputs>) => {
    if (locked) return
    change((current) => ({ inputs: { ...current.inputs, ...patch } }))
  }

  const setDetail = (field: DetailsField, value: string) => {
    if (locked) return
    update((r) => ({
      ...r,
      details: { ...r.details, [field]: value, ...(field === "vessel" ? { vesselId: vesselIdFor(value) } : {}) },
    }))
  }

  const messages = (field: IssueField) => issuesFor(validation, field)

  /** Writes the generated text into the report. Asks before replacing a preamble that did not come from the builder. */
  const commitText = (status?: NarrativeStatus) => {
    if (validation.errors.length) {
      toast.error("Resolve the highlighted issues first")
      focusField(validation.errors[0].field)
      return false
    }
    const problems = placeholderProblems(generated.text)
    if (problems.length) {
      toast.error(`The text cannot be saved: ${problems[0]}`)
      return false
    }
    if (
      savedState === "other" &&
      !window.confirm(
        "This report already contains a preamble that was not produced by this builder (for example, one written by hand).\n\nReplace it with the generated preamble?",
      )
    ) {
      return false
    }
    const text = generated.text
    const now = Date.now()
    change(
      () => ({ generatedText: text, lastGeneratedAt: now, ...(status ? { status } : {}) }),
      (r) => ({ summary: { ...r.summary, preamble: text } }),
    )
    return true
  }

  const save = () => {
    if (commitText()) toast.success(savedState === "none" ? "Preamble saved to the report" : "Saved preamble regenerated")
  }

  const setStatus = (status: NarrativeStatus) => {
    if (status === state.status) return
    if (status === "FINAL") {
      if (savedState === "current") {
        change(() => ({ status }))
        toast.success("Preamble marked Final")
      } else if (commitText("FINAL")) {
        toast.success("Preamble saved and marked Final")
      }
      return
    }
    change(() => ({ status }))
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
    else toast.success("Preamble copied to the clipboard")
  }

  const reset = () => {
    if (
      !window.confirm(
        "Reset all Preamble selections to their defaults?\n\nVessel and dates (Inspection Details) and any preamble text already saved in the report are kept.",
      )
    ) {
      return
    }
    change(() => ({ status: "DRAFT", inputs: defaultPreambleInputs({ port: report.details.port }) }))
    toast.success("Preamble selections reset")
  }

  const saveDraft = async () => {
    await saveNow()
    toast.success(navigator.onLine ? "Draft saved and synced" : "Draft saved on this device")
  }

  const editFacts = () => {
    const firstError = validation.errors.find((e) => e.field !== "preview")
    focusField(firstError?.field ?? "vessel")
  }

  const formProps = { inputs: state.inputs, facts, set, setDetail, messages, disabled: locked }
  const vessel = facts.vesselName.trim()

  return (
    <div className="@container flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Superintendent Inspection Report</p>
          <h3 className="text-base font-semibold">Executive Summary – Preamble</h3>
          <p className="truncate text-sm text-muted-foreground">
            {vessel || "Vessel not selected"}
            {state.updatedAt > 0 && <> · Last updated {timeLabel(state.updatedAt)}</>}
            {state.lastGeneratedAt && <> · Text saved {timeLabel(state.lastGeneratedAt)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="preamble-status" className="text-xs font-medium text-muted-foreground">
              Report status
            </label>
            <select
              id="preamble-status"
              value={state.status}
              onChange={(e) => setStatus(e.target.value as NarrativeStatus)}
              aria-describedby="preamble-status-hint"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {NARRATIVE_STATUSES.map((status) => (
                <option key={status.id} value={status.id} disabled={status.id === "FINAL" && validation.errors.length > 0 && state.status !== "FINAL"}>
                  {status.id === "FINAL" && validation.errors.length > 0 && state.status !== "FINAL" ? "Final (resolve issues first)" : status.label}
                </option>
              ))}
            </select>
            <span id="preamble-status-hint" className="sr-only">
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
          This preamble is Final, so the selections are locked. Set the status to Draft or Under Review to edit them.
        </p>
      )}

      {savedState === "other" && (
        <details className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            This report already has a preamble that was not produced by the builder. It stays in the report until you save the generated one.
          </summary>
          <p className="mt-2 whitespace-pre-line text-muted-foreground">{report.summary.preamble}</p>
        </details>
      )}

      <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <AttendanceDetailsForm {...formProps} />
          <InspectionContextForm {...formProps} />
        </div>
        <div className="min-w-0 @4xl:sticky @4xl:top-28 @4xl:max-h-[calc(100dvh-8rem)] @4xl:overflow-y-auto">
          <PreamblePreview
            generated={generated}
            validation={validation}
            savedState={savedState}
            locked={locked}
            onCopy={copy}
            onSave={save}
            onEditFacts={editFacts}
            onSelectIssue={focusField}
            selections={describeSelections(state.inputs, facts)}
          />
        </div>
      </div>
    </div>
  )
}
