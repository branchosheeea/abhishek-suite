// Underwater hull inspection and propeller polishing: the same options and wording on the Hull page and in the
// Executive Summary – Structural Condition, so the two never describe the same inspection differently.

import { formatDate } from "../dates"
import { gap, sentence } from "../text"
import type { FieldSpec, SectionInputs } from "../section"
import { flag, phrases, str } from "./common"

export const UW_STATUS = [
  { id: "THIS_ATTENDANCE", label: "Carried out during this attendance" },
  { id: "PREVIOUS", label: "Carried out previously" },
  { id: "PLANNED", label: "Planned" },
  { id: "NOT_POSSIBLE", label: "Arranged but could not be carried out" },
  { id: "IN_DRY_DOCK", label: "Inspected in dry-dock" },
] as const

export const UW_REASON = [
  { id: "CURRENT", label: "Strong currents", phrase: "because of strong currents" },
  { id: "PORT", label: "Port restrictions", phrase: "because of port restrictions" },
  { id: "WEATHER", label: "Weather", phrase: "because of the weather conditions" },
  { id: "TIME", label: "Time constraints", phrase: "because of time constraints" },
] as const

export const UW_FINDINGS = [
  { id: "NO_FOULING", label: "Hull free of significant fouling", phrase: "the hull was free of significant fouling" },
  { id: "MINIMAL_FOULING", label: "Minimal fouling", phrase: "minimal fouling was found" },
  { id: "PARTLY_CLEANED", label: "Hull only partly cleaned", phrase: "the hull was only partly cleaned" },
  { id: "PROP_POLISHED", label: "Propeller slime removed by polishing", phrase: "slime and algae on the propeller were removed by polishing" },
  { id: "SEA_CHESTS", label: "Fouled sea chest gratings cleaned", phrase: "fouled sea chest gratings were cleaned" },
  { id: "AF_GOOD", label: "Antifouling satisfactory (paint maker attended)", phrase: "the paint maker’s representative assessed the antifouling coating as satisfactory" },
  { id: "AF_DEGRADED", label: "Antifouling degradation noted", phrase: "antifouling coating degradation was noted" },
  { id: "RUDDER_ESD", label: "Rudder, propeller and ESD inspected in dock", phrase: "the rudder, propeller and energy-saving device were inspected and found in good condition" },
] as const

const uw = (s: Record<string, unknown>) => str(s, "uwStatus")

/** The underwater fields shared by both sections (same keys, so the Hull page can start from the summary). */
export const UNDERWATER_FIELDS: FieldSpec[] = [
  { kind: "select", key: "uwStatus", label: "Underwater inspection and propeller polishing", options: UW_STATUS, placeholder: "Not reported" },
  { kind: "text", key: "uwPlace", label: "Place", required: true, placeholder: "e.g. Singapore", showIf: (s) => ["THIS_ATTENDANCE", "PREVIOUS", "PLANNED", "NOT_POSSIBLE"].includes(uw(s)) },
  { kind: "date", key: "uwDate", label: "Date", required: true, showIf: (s) => uw(s) === "PREVIOUS" },
  { kind: "date", key: "uwPlannedDate", label: "Date (if known)", showIf: (s) => uw(s) === "PLANNED" || uw(s) === "NOT_POSSIBLE" },
  { kind: "select", key: "uwReason", label: "Reason", required: true, options: UW_REASON, showIf: (s) => uw(s) === "NOT_POSSIBLE" },
  { kind: "confirm", key: "uwSms", label: "Within the SMS six-monthly interval", showIf: (s) => uw(s) === "THIS_ATTENDANCE" || uw(s) === "PREVIOUS" },
  { kind: "multi", key: "uwFindings", label: "Findings", options: UW_FINDINGS, columns: 2, showIf: (s) => ["THIS_ATTENDANCE", "PREVIOUS", "IN_DRY_DOCK"].includes(uw(s)) },
]

export const UNDERWATER_KEYS = UNDERWATER_FIELDS.map((f) => f.key)

/**
 * The underwater-inspection sentence and its findings sentence ("" when nothing is reported).
 * `by` names the diving company; `findingPhrases` lets a section replace the standard finding phrases.
 */
export function underwaterSentences(i: SectionInputs, options: { by?: string; findingPhrases?: string[] } = {}) {
  const status = str(i, "uwStatus")
  const place = str(i, "uwPlace")
  const by = options.by ? ` by ${options.by}` : ""
  const sms = flag(i, "uwSms") ? ", within the six-monthly interval required by the SMS" : ""
  const plannedOn = formatDate(str(i, "uwPlannedDate"))
  let text = ""
  if (status === "THIS_ATTENDANCE") text = sentence(`An underwater hull inspection and propeller polishing were carried out${by} at ${place || gap("place")} during this attendance${sms}`)
  else if (status === "PREVIOUS") {
    const on = formatDate(str(i, "uwDate"))
    text = sentence(`The last underwater hull inspection and propeller polishing were carried out${by} at ${place || gap("place")}${on ? ` on ${on}` : ` ${gap("date")}`}${sms}`)
  } else if (status === "PLANNED") text = sentence(`An underwater hull inspection and propeller polishing are planned at ${place || gap("place")}${plannedOn ? ` on ${plannedOn}` : ""}`)
  else if (status === "NOT_POSSIBLE") {
    const reason = UW_REASON.find((r) => r.id === str(i, "uwReason"))?.phrase
    text = sentence(
      `An underwater hull inspection and propeller polishing arranged at ${place || gap("place")}${plannedOn ? ` on ${plannedOn}` : ""} could not be carried out ${reason ?? gap("reason")}, and will be rearranged at the first opportunity`,
    )
  } else if (status === "IN_DRY_DOCK") text = sentence("The underwater hull and propeller were inspected during the recent dry-docking")
  const found = options.findingPhrases ?? phrases(UW_FINDINGS, (i.uwFindings as string[]) ?? [])
  const findings = text && found.length ? found : []
  return { text, findings }
}

/** Months between the last underwater inspection and the start of the attendance (null when not applicable). */
export function monthsSinceUnderwater(i: SectionInputs, start: string) {
  const date = str(i, "uwDate")
  if (str(i, "uwStatus") !== "PREVIOUS" || !date || !start) return null
  return (Date.parse(start) - Date.parse(date)) / (30.44 * 24 * 3600 * 1000)
}
