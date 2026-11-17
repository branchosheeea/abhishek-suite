// Executive Summary – Performance.
// Pattern from past reports: speed and consumption against the charter party → cargo operations and off-hire → hull
// and engine performance (since dry-docking, ME test, SFOC, EPL, CII) → recent SIRE / PSC / Flag / Class / audit
// results. Results are stated with their counts, place and date instead of "favourable", so they can be verified.

import { compareIsoDates, formatDate, formatMonthYear } from "../dates"
import { cleanFragment, gap, place, sentence } from "../text"
import { para, type ItemValue, type SectionSpec } from "../section"
import { flag, items, str } from "./common"

const SPEED = [
  { id: "WITHIN_CP", label: "Within charter party warranted figures", phrase: "The vessel’s speed and fuel consumption were within the charter party warranted figures" },
  { id: "SATISFACTORY", label: "Satisfactory", phrase: "The vessel’s speed and fuel consumption performance was satisfactory" },
  { id: "MARGINAL", label: "Marginally outside – monitored", phrase: "The vessel’s speed and fuel consumption were marginally outside the warranted figures and are being monitored" },
  { id: "OUTSIDE", label: "Outside warranted figures – investigating", phrase: "The vessel’s speed and fuel consumption were outside the warranted figures, and the cause is being investigated" },
] as const

const CARGO_OPS = [
  { id: "NO_ISSUES", label: "Completed without issues" },
  { id: "ISSUES", label: "Issues – described in this report" },
] as const

const OFF_HIRE = [
  { id: "NONE", label: "No lost time or unplanned off-hire", phrase: "There was no lost time or unplanned off-hire" },
  { id: "OCCURRED", label: "Off-hire incurred", phrase: "" },
] as const

const HULL = [
  { id: "SATISFACTORY", label: "Satisfactory since last dry-docking" },
  { id: "POST_DOCK", label: "Satisfactory after recent dry-docking" },
  { id: "RESISTANCE", label: "Increased hull resistance observed" },
] as const

const ME_TEST = [
  { id: "TESTED", label: "ME performance test during the attendance" },
  { id: "MONTHLY", label: "Monitored monthly – results satisfactory" },
] as const

const CII = ["A", "B", "C", "D", "E"].map((r) => ({ id: r, label: `CII rating ${r}`, phrase: r }))

const INSPECTION_TYPES = [
  { id: "SIRE", label: "SIRE 2.0 inspection", noun: "SIRE 2.0 inspection", finding: "observation" },
  { id: "PSC", label: "Port State Control inspection", noun: "Port State Control inspection", finding: "deficiency" },
  { id: "USCG", label: "USCG examination", noun: "USCG examination", finding: "deficiency" },
  { id: "FSI", label: "Flag State inspection", noun: "Flag State inspection", finding: "deficiency" },
  { id: "CLASS_ANNUAL", label: "Class annual survey", noun: "Class annual survey", finding: "recommendation" },
  { id: "CLASS_INTERMEDIATE", label: "Class intermediate survey", noun: "Class intermediate survey", finding: "recommendation" },
  { id: "ISM", label: "External ISM audit", noun: "external ISM audit", finding: "non-conformity" },
  { id: "ISPS", label: "ISPS verification", noun: "ISPS verification", finding: "non-conformity" },
  { id: "MLC", label: "MLC inspection", noun: "MLC inspection", finding: "deficiency" },
  { id: "INTERNAL", label: "Internal audit", noun: "internal audit", finding: "non-conformity" },
  { id: "TERMINAL", label: "Terminal inspection", noun: "terminal inspection", finding: "observation" },
] as const

const RESULT = [
  { id: "NIL", label: "Nil findings" },
  { id: "COUNT", label: "With findings (enter number)" },
  { id: "DETENTION", label: "Detention" },
  { id: "AWAITED", label: "Report awaited" },
] as const

const CLOSURE = [
  { id: "CLOSED", label: "All closed", one: "which has been closed", many: "all of which have been closed" },
  { id: "IN_PROGRESS", label: "Corrective actions in progress", one: "with corrective action in progress", many: "with corrective actions in progress" },
] as const

const PLURAL: Record<string, string> = { observation: "observations", deficiency: "deficiencies", recommendation: "recommendations", "non-conformity": "non-conformities" }

function count(n: number, noun: string) {
  return `${n} ${n === 1 ? noun : PLURAL[noun] ?? `${noun}s`}`
}

function inspectionSentence(item: ItemValue) {
  const type = INSPECTION_TYPES.find((t) => t.id === item.type)
  if (!type) return gap("inspection type")
  const by = cleanFragment(item.by as string)
  const place = cleanFragment(item.place as string)
  const date = formatDate(item.date as string)
  const subject = `The ${type.noun}${by ? ` by ${by}` : ""}${place ? ` at ${place}${place.includes(",") ? "," : ""}` : ""}${date ? ` on ${date}` : ""}`
  const negatives = Number(item.count)
  const positives = Number(item.positive)
  const kpi = item.kpi === true ? ", in line with the Company’s KPI" : ""
  switch (item.result) {
    case "NIL": {
      const pos = type.id === "SIRE" && positives > 0 ? ` and ${count(positives, "positive observation")}` : ""
      return sentence(`${subject} was completed with nil ${PLURAL[type.finding]}${pos}${kpi}`)
    }
    case "COUNT": {
      if (!Number.isFinite(negatives) || negatives < 1) return sentence(`${subject} was completed ${gap("number of findings")}`)
      const noun = type.id === "SIRE" ? "negative observation" : type.finding
      const pos = type.id === "SIRE" && positives > 0 ? ` and ${count(positives, "positive observation")}` : ""
      const closureOption = CLOSURE.find((c) => c.id === item.closure)
      const closure = closureOption ? (negatives === 1 ? closureOption.one : closureOption.many) : ""
      return sentence(`${subject} was completed with ${count(negatives, noun)}${pos}${closure ? `, ${closure}` : ""}${kpi}`)
    }
    case "DETENTION":
      return sentence(`${subject} resulted in a detention`)
    case "AWAITED":
      return sentence(`${subject} was completed, and the report is awaited`)
    default:
      return gap("inspection result")
  }
}

export const PERFORMANCE_SECTION: SectionSpec = {
  id: "performance",
  summaryKey: "performance",
  title: "Performance",
  tab: "Performance",
  description: "Commercial and technical performance, with inspection results stated precisely.",
  groups: [
    {
      title: "Speed, consumption and charter party",
      fields: [
        { kind: "select", key: "speed", label: "Speed and consumption", required: true, options: SPEED, placeholder: "Select…", wide: true },
        { kind: "confirm", key: "cpMet", label: "All charter party requirements were met" },
        { kind: "select", key: "cargoOps", label: "Recent cargo operations", options: CARGO_OPS, placeholder: "Not stated" },
        { kind: "text", key: "cargoPlace", label: "Where (optional)", placeholder: "e.g. Quanzhou, China", showIf: (s) => !!str(s, "cargoOps") },
        { kind: "select", key: "offHire", label: "Lost time / off-hire", options: OFF_HIRE, placeholder: "Not stated" },
        { kind: "text", key: "offHireDetails", label: "Off-hire details", required: true, placeholder: "e.g. 2.5 days for main engine liner repairs at Singapore", showIf: (s) => str(s, "offHire") === "OCCURRED", wide: true },
      ],
    },
    {
      title: "Hull and engine performance",
      fields: [
        { kind: "select", key: "hull", label: "Hull performance", options: HULL, placeholder: "Not stated" },
        { kind: "date", key: "lastDryDock", label: "Last dry-docking (month)", showIf: (s) => str(s, "hull") === "SATISFACTORY" },
        { kind: "select", key: "meTest", label: "Main engine performance", options: ME_TEST, placeholder: "Not stated" },
        { kind: "text", key: "meRpm", label: "Test at (rpm)", placeholder: "e.g. 70", showIf: (s) => str(s, "meTest") === "TESTED" },
        { kind: "confirm", key: "seaTrial", label: "Compared with sea-trial results", showIf: (s) => str(s, "meTest") === "TESTED" },
        { kind: "text", key: "sfoc", label: "SFOC, ISO-corrected (g/kWh, optional)", placeholder: "e.g. 158.5" },
        { kind: "confirm", key: "condition", label: "Scavenge / piston-ring inspections, cylinder condition and lube oil analyses are satisfactory" },
        { kind: "confirm", key: "epl", label: "Engine Power Limitation (EEXI) fitted" },
        { kind: "text", key: "eplLimit", label: "Limited MCR", required: true, placeholder: "e.g. 19,433 kW at 66 rpm", showIf: (s) => flag(s, "epl") },
        { kind: "select", key: "cii", label: "Attained CII rating", options: CII, placeholder: "Not stated" },
        { kind: "text", key: "ciiYear", label: "For the year", required: true, placeholder: "e.g. 2025", showIf: (s) => !!str(s, "cii") },
        { kind: "confirm", key: "seemp", label: "SEEMP energy-efficiency measures are implemented in line with the Company’s environmental and energy policy" },
      ],
    },
    {
      title: "Inspections, audits and surveys",
      fields: [
        {
          kind: "items",
          key: "inspections",
          label: "Recent results",
          itemLabel: "Inspection",
          addLabel: "Add inspection or audit",
          max: 8,
          fields: [
            { kind: "select", key: "type", label: "Type", required: true, options: INSPECTION_TYPES, placeholder: "Select…" },
            { kind: "text", key: "by", label: "By (optional)", placeholder: "e.g. IMT, Chevron, Marshall Islands" },
            { kind: "text", key: "place", label: "Place", placeholder: "e.g. Quanzhou, China" },
            { kind: "date", key: "date", label: "Date" },
            { kind: "select", key: "result", label: "Result", required: true, options: RESULT, placeholder: "Select…" },
            { kind: "text", key: "count", label: "Number of findings", required: true, placeholder: "e.g. 3", showIf: (s) => s.result === "COUNT" },
            { kind: "text", key: "positive", label: "Positive observations (SIRE 2.0)", placeholder: "e.g. 2", showIf: (s) => s.type === "SIRE" && (s.result === "COUNT" || s.result === "NIL") },
            { kind: "select", key: "closure", label: "Close-out", options: CLOSURE, placeholder: "Not stated", showIf: (s) => s.result === "COUNT" },
            { kind: "confirm", key: "kpi", label: "In line with the Company’s KPI", showIf: (s) => s.result === "NIL" || s.result === "COUNT" },
          ],
        },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i) {
    // 1. Commercial
    const speed = SPEED.find((o) => o.id === str(i, "speed"))?.phrase
    const cp = flag(i, "cpMet") ? sentence("All charter party requirements were met") : ""
    const where = str(i, "cargoPlace")
    const cargoOps = str(i, "cargoOps")
    const cargo =
      cargoOps === "NO_ISSUES"
        ? sentence(`Recent cargo operations${where ? ` at ${place(where)}` : ""} were completed without issues`)
        : cargoOps === "ISSUES"
          ? sentence(`Issues during recent cargo operations${where ? ` at ${place(where)}` : ""} are described in this report`)
          : ""
    const offHire =
      str(i, "offHire") === "NONE"
        ? sentence(OFF_HIRE[0].phrase)
        : str(i, "offHire") === "OCCURRED"
          ? sentence(`Off-hire was incurred: ${str(i, "offHireDetails") || gap("details")}`)
          : ""

    // 2. Hull and engine
    const hull = str(i, "hull")
    const dock = formatMonthYear(str(i, "lastDryDock"))
    const hullText =
      hull === "SATISFACTORY"
        ? sentence(`Hull performance since the last dry-docking${dock ? ` in ${dock}` : ""} has been satisfactory`)
        : hull === "POST_DOCK"
          ? sentence("Hull performance has been satisfactory following the recent dry-docking, hull painting and propeller polishing")
          : hull === "RESISTANCE"
            ? sentence("Increased hull resistance has been observed, with the normal continuous rating reached at a lower engine speed, and hull cleaning is under consideration")
            : ""
    const rpm = str(i, "meRpm").replace(/\s*rpm$/i, "")
    const meText =
      str(i, "meTest") === "TESTED"
        ? sentence(`A main engine performance test was carried out during the attendance${rpm ? ` at ${rpm} rpm` : ""}${flag(i, "seaTrial") ? ", and the results were compared with the sea-trial data" : ""}`)
        : str(i, "meTest") === "MONTHLY"
          ? sentence("Main engine performance is monitored monthly, and recent results are satisfactory")
          : ""
    const sfoc = str(i, "sfoc").replace(/\s*g\/?kwh$/i, "")
    const sfocText = sfoc ? sentence(`The ISO-corrected specific fuel oil consumption was ${sfoc} g/kWh`) : ""
    const condition = flag(i, "condition")
      ? sentence("Scavenge-port and piston-ring inspection reports, cylinder condition monitoring and lube oil analysis results are satisfactory")
      : ""
    const epl = flag(i, "epl") ? sentence(`The main engine is fitted with an Engine Power Limitation for EEXI compliance, limiting the MCR to ${str(i, "eplLimit") || gap("limited MCR")}`) : ""
    const cii = str(i, "cii") ? sentence(`The attained CII rating for ${str(i, "ciiYear") || gap("year")} is ${str(i, "cii")}`) : ""
    const seemp = flag(i, "seemp") ? sentence("Energy-efficiency measures under the SEEMP are implemented in line with the Company’s environmental and energy management policy") : ""

    // 3. Inspections
    const inspections = items(i, "inspections").map(inspectionSentence)

    return [
      para("commercial", "Speed, consumption and charter party", [speed ? sentence(speed) : gap("speed and consumption"), cp, cargo, offHire]),
      para("technical", "Hull and engine performance", [hullText, meText, sfocText, condition, epl, cii, seemp]),
      para("inspections", "Inspections, audits and surveys", [...inspections, sentence(str(i, "note"))]),
    ]
  },

  validate(i, ctx, { warn, error }) {
    if (flag(i, "cpMet") && (str(i, "speed") === "OUTSIDE" || str(i, "offHire") === "OCCURRED")) {
      warn("narr-performance-cpMet", "“All charter party requirements were met” conflicts with the speed / off-hire selection.")
    }
    const cii = str(i, "cii")
    if (cii === "D" || cii === "E") {
      warn("narr-performance-cii", "A CII rating of E, or D for three consecutive years, requires a corrective action plan in SEEMP Part III.")
    }
    const sfoc = str(i, "sfoc")
    if (sfoc && !/^\d{2,3}(\.\d{1,2})?$/.test(sfoc.replace(/\s*g\/?kwh$/i, ""))) error("narr-performance-sfoc", "Enter the SFOC as a number, e.g. 158.5.")
    items(i, "inspections").forEach((item, index) => {
      const id = (key: string) => `narr-performance-inspections-${index}-${key}`
      if (item.result === "COUNT" && !/^\d{1,3}$/.test(String(item.count ?? "").trim())) error(id("count"), "Enter the number of findings as a whole number.")
      if (item.positive && !/^\d{1,3}$/.test(String(item.positive).trim())) error(id("positive"), "Enter a whole number.")
      if (item.result === "DETENTION") warn(id("result"), "A detention must also be reported under Significant Problems and to the Company.")
      if ((compareIsoDates(item.date as string, ctx.endDate || ctx.startDate) ?? -1) > 0) warn(id("date"), "This date is after the attendance.")
    })
  },
}
