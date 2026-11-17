// Executive Summary – Significant Problems.
// Each problem follows the chain the best past reports use: system → defect → impact → actions taken → expected
// completion → dispensation / Condition of Class validity. "None" is never accepted silently while the report itself
// records items rated Deficient.

import { compareIsoDates, formatDate } from "../dates"
import { cleanFragment, gap, joinClauses, lowerFirst, sentence } from "../text"
import { para, type ItemValue, type SectionSpec } from "../section"
import { deficientItems, flag, itemNames, items, str } from "./common"

const STATUS = [
  { id: "NONE", label: "No significant problems" },
  { id: "LISTED", label: "Significant problems identified" },
] as const

export const PROBLEM_SYSTEMS = [
  { id: "BWTS", label: "Ballast water management system", noun: "Ballast water management system" },
  { id: "EGCS", label: "Exhaust gas cleaning system", noun: "Exhaust gas cleaning system" },
  { id: "SCR", label: "SCR system", noun: "SCR system" },
  { id: "MAIN_ENGINE", label: "Main engine", noun: "Main engine" },
  { id: "GENERATORS", label: "Diesel generators", noun: "Diesel generators" },
  { id: "ELECTRICAL", label: "Switchboards and electrical distribution", noun: "Switchboards and electrical distribution" },
  { id: "BOILERS", label: "Boilers", noun: "Boilers" },
  { id: "STEERING", label: "Steering gear", noun: "Steering gear" },
  { id: "CARGO", label: "Cargo system", noun: "Cargo system" },
  { id: "IGS", label: "Inert gas system", noun: "Inert gas system" },
  { id: "NAVIGATION", label: "Navigation equipment", noun: "Navigation equipment" },
  { id: "GMDSS", label: "GMDSS / radio equipment", noun: "GMDSS and radio equipment" },
  { id: "LSA", label: "Life-saving appliances", noun: "Life-saving appliances" },
  { id: "FFA", label: "Fire-fighting appliances", noun: "Fire-fighting appliances" },
  { id: "LIFTING", label: "Lifting appliances and loose gear", noun: "Lifting appliances and loose gear" },
  { id: "HULL", label: "Hull and structure", noun: "Hull and structure" },
  { id: "MOORING", label: "Mooring equipment", noun: "Mooring equipment" },
  { id: "POLLUTION", label: "Pollution-prevention equipment", noun: "Pollution-prevention equipment" },
  { id: "ACCOMMODATION", label: "Accommodation", noun: "Accommodation" },
  { id: "OTHER", label: "Other", noun: "" },
] as const

/** Defects in these systems are frequently detainable at Port State Control. */
const SAFETY_CRITICAL = ["LSA", "FFA", "NAVIGATION", "GMDSS", "STEERING", "POLLUTION"]

const IMPACT = [
  { id: "NO_EFFECT", label: "No current effect on operations", phrase: "with no current effect on operations" },
  { id: "REDUNDANCY", label: "Reduced redundancy", phrase: "reducing redundancy" },
  { id: "RESTRICTION", label: "Operational restriction", phrase: "restricting operations" },
  { id: "COMPLIANCE", label: "Affects regulatory compliance", phrase: "affecting regulatory compliance" },
  { id: "SAFETY", label: "Affects safety", phrase: "affecting safety" },
  { id: "OFF_HIRE", label: "Risk of off-hire", phrase: "with a risk of off-hire" },
] as const

const ACTIONS = [
  { id: "RECTIFY", label: "Vessel instructed to rectify", phrase: "the vessel has been instructed to rectify the defect" },
  { id: "SPARES", label: "Spares ordered", phrase: "spares have been ordered" },
  { id: "ENGINEER", label: "Service engineer arranged", phrase: "a service engineer has been arranged" },
  { id: "MAKER", label: "Maker’s support consulted", phrase: "the maker’s technical support has been consulted" },
  { id: "NEXT_PORT", label: "Repair at the next port", phrase: "repairs are planned at the next port" },
  { id: "TEMP_REPAIR", label: "Temporary repair done", phrase: "temporary repairs have been carried out" },
  { id: "DRY_DOCK", label: "Repair at the next dry-docking", phrase: "repairs are planned at the next dry-docking" },
  { id: "RISK_ASSESSED", label: "Risk assessed, interim measures in place", phrase: "a risk assessment has been carried out and interim measures are in place" },
  { id: "CLASS_INFORMED", label: "Classification Society informed", phrase: "the Classification Society has been informed" },
  { id: "COC", label: "Condition of Class imposed", phrase: "a Condition of Class has been imposed" },
  { id: "DISPENSATION", label: "Flag dispensation obtained", phrase: "a dispensation has been obtained from the Flag Administration" },
  { id: "COMPANY", label: "Reported to the Company", phrase: "the matter has been reported to the Company" },
  { id: "DDRL", label: "Entered in the DDRL", phrase: "the defect has been entered in the DDRL" },
] as const

function problemParagraph(item: ItemValue, index: number) {
  const system = PROBLEM_SYSTEMS.find((s) => s.id === item.system)
  const name = system?.id === "OTHER" ? cleanFragment(item.otherSystem as string) : system?.noun
  const description = lowerFirst(cleanFragment(item.description as string))
  if (!name || !description) return `${index + 1}. ${gap("system and description")}`
  const impact = IMPACT.find((o) => o.id === item.impact)?.phrase
  const chosen = Array.isArray(item.actions) ? (item.actions as string[]) : []
  const validUntil = formatDate(item.validUntil as string)
  const actions = ACTIONS.filter((a) => chosen.includes(a.id)).map((a) => {
    if (a.id === "DISPENSATION" && validUntil) return `${a.phrase}, valid until ${validUntil}`
    if (a.id === "COC" && validUntil) return `${a.phrase}, due by ${validUntil}`
    return a.phrase
  })
  const expected = formatDate(item.expected as string)
  const lead = sentence(`${name}: ${description}${impact ? `, ${impact}` : ""}`)
  const follow = [actions.length ? sentence(joinClauses(actions)) : "", expected ? sentence(`Completion is expected by ${expected}`) : ""].filter(Boolean).join(" ")
  return `${index + 1}. ${[lead, follow].filter(Boolean).join(" ")}`
}

export const PROBLEMS_SECTION: SectionSpec = {
  id: "significantProblems",
  summaryKey: "problems",
  title: "Significant Problems",
  tab: "Significant problems",
  description: "Defects and issues that need Company attention, each with its impact, actions and dates.",
  groups: [
    {
      title: "Significant problems",
      fields: [
        { kind: "select", key: "status", label: "Status", required: true, options: STATUS, placeholder: "Select…" },
        {
          kind: "confirm",
          key: "defectsHandedOver",
          label: "Defects found during the inspection are in the DDRL and the worklist for close-out",
          showIf: (s) => str(s, "status") === "NONE",
        },
        {
          kind: "items",
          key: "problems",
          label: "Problems",
          itemLabel: "Problem",
          addLabel: "Add problem",
          max: 10,
          required: true,
          showIf: (s) => str(s, "status") === "LISTED",
          fields: [
            { kind: "select", key: "system", label: "System", required: true, options: PROBLEM_SYSTEMS, placeholder: "Select…" },
            { kind: "text", key: "otherSystem", label: "System name", required: true, showIf: (s) => s.system === "OTHER" },
            {
              kind: "text",
              key: "description",
              label: "Defect",
              required: true,
              placeholder: "e.g. inoperative because of a defective C2E cell",
              hint: "Follows “<System>:”, so start in lower case.",
              wide: true,
            },
            { kind: "select", key: "impact", label: "Impact", options: IMPACT, placeholder: "Not stated" },
            { kind: "multi", key: "actions", label: "Actions taken", options: ACTIONS, columns: 2, wide: true },
            { kind: "date", key: "expected", label: "Completion expected by" },
            {
              kind: "date",
              key: "validUntil",
              label: "Dispensation valid until / CoC due by",
              required: true,
              showIf: (s) => Array.isArray(s.actions) && ((s.actions as string[]).includes("DISPENSATION") || (s.actions as string[]).includes("COC")),
            },
          ],
        },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i) {
    const status = str(i, "status")
    if (status === "NONE") {
      return [
        para("summary", "Significant problems", [
          sentence("No significant problems were identified during the attendance"),
          flag(i, "defectsHandedOver") ? sentence("Defects identified during the inspection have been entered in the DDRL and the inspection worklist for close-out by the ship’s staff") : "",
          sentence(str(i, "note")),
        ]),
      ]
    }
    if (status === "LISTED") {
      const problems = items(i, "problems")
      return [
        para("summary", "Significant problems", [problems.length ? sentence(`The following significant ${problems.length === 1 ? "problem was" : "problems were"} identified`).replace(/\.$/, ":") : gap("problems")]),
        ...problems.map((item, index) => para(`problem-${index + 1}`, `Problem ${index + 1}`, [problemParagraph(item, index)])),
        para("note", "Note", [sentence(str(i, "note"))]),
      ]
    }
    return [para("summary", "Significant problems", [gap("status")])]
  },

  validate(i, ctx, { warn }) {
    const action = deficientItems(ctx)
    if (str(i, "status") === "NONE" && action.length) {
      warn("narr-significantProblems-status", `“No significant problems” is selected, but ${itemNames(action)} ${action.length === 1 ? "is" : "are"} rated Deficient in this report.`)
    }
    const end = ctx.endDate || ctx.startDate
    items(i, "problems").forEach((item, index) => {
      const id = (key: string) => `narr-significantProblems-problems-${index}-${key}`
      const until = item.validUntil as string
      const order = compareIsoDates(until, end)
      if (until && order !== null && order < 0) warn(id("validUntil"), "This dispensation / Condition of Class date has already passed.")
      else if (until && end && order !== null && (Date.parse(until) - Date.parse(end)) / 86400000 <= 30) {
        warn(id("validUntil"), "Expires within 30 days of the attendance. Confirm the follow-up plan.")
      }
      const actions = Array.isArray(item.actions) ? (item.actions as string[]) : []
      if (SAFETY_CRITICAL.includes(item.system as string) && !actions.includes("COMPANY") && !actions.includes("RISK_ASSESSED")) {
        warn(id("actions"), "Defects in this system are frequently detainable at Port State Control. Confirm the Company has been informed and interim measures are in place.")
      }
      if (!actions.length) warn(id("actions"), "No action is recorded for this problem.")
    })
  },
}
