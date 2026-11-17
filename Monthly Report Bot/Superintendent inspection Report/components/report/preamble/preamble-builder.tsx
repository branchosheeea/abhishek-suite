"use client"

import { useMemo } from "react"
import type { useReportEditor } from "@/hooks/use-report-editor"
import type { Report } from "@/lib/form-schema"
import { formatDate } from "@/lib/narrative/dates"
import { generatePreamble } from "@/lib/narrative/preamble/generate"
import { defaultPreambleInputs, normalisePreambleState, type PreambleFacts, type PreambleInputs } from "@/lib/narrative/preamble/model"
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
import { applyLinkedChange } from "@/lib/linked-fields"
import { NarrativeShell } from "../narrative/narrative-shell"
import { useNarrativeState } from "../narrative/use-narrative-state"
import { AttendanceDetailsForm } from "./attendance-details-form"
import { fieldId } from "./fields"
import type { DetailsField } from "./form-types"
import { InspectionContextForm } from "./inspection-context-form"

type Editor = ReturnType<typeof useReportEditor>

type Props = {
  report: Report
  update: Editor["update"]
  saveNow: Editor["saveNow"]
}

const normalise = (raw: unknown, report: Report) => normalisePreambleState(raw, { port: report.details.port })

function factsOf(report: Report): PreambleFacts {
  return { vesselName: report.details.vessel ?? "", startDate: report.details.dateFrom ?? "", endDate: report.details.dateTo ?? "" }
}

function focusField(field: string) {
  const el = document.getElementById(field === "preview" ? "narrative-preview" : fieldId(field))
  if (!el) return
  const target = el.matches("input, select, textarea, section")
    ? el
    : el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, [role=checkbox], button") ?? el
  target.scrollIntoView({ block: "center", behavior: "smooth" })
  target.focus({ preventScroll: true })
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

export function PreambleBuilder({ report, update, saveNow }: Props) {
  const { state, locked, change, setInputs } = useNarrativeState(report, update, "preamble", normalise)
  const facts = useMemo(() => factsOf(report), [report])
  const generated = useMemo(() => generatePreamble(state.inputs, facts), [state.inputs, facts])
  const validation = useMemo(() => validatePreamble(state.inputs, facts, generated), [state.inputs, facts, generated])

  const setDetail = (field: DetailsField, value: string) => {
    if (locked) return
    update((r) => applyLinkedChange(r, "details", field, value))
  }

  const formProps = {
    inputs: state.inputs,
    facts,
    set: setInputs,
    setDetail,
    messages: (field: IssueField) => issuesFor(validation, field),
    disabled: locked,
  }

  return (
    <NarrativeShell
      report={report}
      saveNow={saveNow}
      summaryKey="preamble"
      heading="Executive Summary – Preamble"
      state={state}
      change={change}
      defaultInputs={() => defaultPreambleInputs({ port: report.details.port })}
      generated={generated}
      validation={validation}
      selections={describeSelections(state.inputs, facts)}
      focusIssue={focusField}
      firstField="vessel"
    >
      <AttendanceDetailsForm {...formProps} />
      <InspectionContextForm {...formProps} />
    </NarrativeShell>
  )
}
