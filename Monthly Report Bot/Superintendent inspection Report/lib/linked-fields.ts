// Fields the form asks for in more than one place. Filling one fills the other, so they cannot disagree:
// • Vessel (Inspection Details) ⇄ Ship name (Principal Particulars): always identical, either can be edited.
//   Reports with Vessel Master particulars (lib/particulars.ts) link Vessel to "vessel_name"; a master vessel is
//   chosen with the picker, not typed, so only a vessel not in the master is renamed here.
// • Port → Inspected by · Place, and Inspection to → Inspected by · Date: copied across until the user enters a
//   different value there; after that the user's own value is kept.

import type { Report } from "./form-schema"
import { nameKey } from "./particulars"
import { vesselIdFor } from "./vessels"

type Section = "details" | "particulars"

/** Applies one field change to the report, together with the fields linked to it. */
export function applyLinkedChange(report: Report, section: Section, key: string, value: string): Report {
  const details = { ...report.details }
  const particulars = { ...report.particulars }

  if ((section === "details" && key === "vessel") || (section === "particulars" && key === nameKey(report))) {
    details.vessel = value
    details.vesselId = vesselIdFor(value)
    particulars[nameKey(report)] = value
    const snapshot = report.vesselSnapshot
    return snapshot ? { ...report, details, particulars, vesselSnapshot: { ...snapshot, name: value } } : { ...report, details, particulars }
  }

  if (section === "details") {
    const previous = report.details[key] ?? ""
    details[key] = value
    if (key === "port" && (!details.inspectedPlace?.trim() || details.inspectedPlace === previous)) details.inspectedPlace = value
    if (key === "dateTo" && (!details.inspectedDate || details.inspectedDate === previous)) details.inspectedDate = value
    return { ...report, details }
  }

  particulars[key] = value
  return { ...report, particulars }
}

/** Vessel and Ship name saved differently by an older version of the app (shown so the user can align them). */
export function vesselNameMismatch(report: Report) {
  if (report.vesselSnapshot) return null
  const vessel = report.details.vessel?.trim() ?? ""
  const ship = report.particulars.shipName?.trim() ?? ""
  return vessel && ship && vessel !== ship ? { vessel, ship } : null
}
