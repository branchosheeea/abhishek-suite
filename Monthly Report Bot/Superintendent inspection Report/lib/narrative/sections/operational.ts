// Executive Summary – Operational Condition.
// Pattern from past reports: machinery (how verified, result) → navigation and communication equipment → cargo, ballast
// and mooring (observed in operation or only from records, with the reason) → environmental systems (BWTS, EGCS, SCR,
// MARPOL checks) → critical equipment and drills → Safety Management System implementation (TMSA / PSC focus).

import { cleanFragment, gap, joinClauses, joinList, joinNouns, lowerFirst, sentence } from "../text"
import { para, type SectionSpec } from "../section"
import {
  ASSESSMENTS,
  CARGO_KEYS,
  MACHINERY_KEYS,
  NAVIGATION_KEYS,
  SAFETY_KEYS,
  deficientItems,
  vesselConditionFacts,
  assessment,
  flag,
  isFavourable,
  itemNames,
  items,
  list,
  phrases,
  str,
} from "./common"

const ISSUES = [
  { id: "NONE", label: "No operational issues", phrase: "No operational issues were reported or observed" },
  { id: "MINOR", label: "Minor issues, recorded in the DDRL", phrase: "Minor operational issues were noted and have been recorded in the DDRL" },
  { id: "SIGNIFICANT", label: "Issues reported under Significant Problems", phrase: "Operational issues were identified and are reported under Significant Problems" },
] as const

const MACHINERY_SCOPE = [
  { id: "MAIN_ENGINE", label: "Main engine", phrase: "main engine" },
  { id: "GENERATORS", label: "Diesel generators", phrase: "diesel generators" },
  { id: "BOILERS", label: "Auxiliary boilers", phrase: "auxiliary boilers" },
  { id: "PURIFIERS", label: "Purifiers", phrase: "purifiers" },
  { id: "COMPRESSORS", label: "Air compressors", phrase: "air compressors" },
  { id: "SW_PUMPS", label: "Sea water pumps", phrase: "sea water pumps" },
  { id: "STEERING", label: "Steering gear", phrase: "steering gear" },
] as const

// "{be}" becomes "was" or "were", "{its}" becomes "its" or "their", to agree with the machinery listed.
const MACHINERY_METHOD = [
  { id: "TESTED", label: "Checked in operation during the attendance", phrase: "{be} checked in operation during the attendance" },
  { id: "PERFORMANCE_RECORDED", label: "Performance recorded during the voyage", phrase: "had {its} performance recorded during the voyage" },
  { id: "RECORDS", label: "Reviewed from the latest performance records", phrase: "{be} reviewed from the latest performance records" },
  { id: "REPORTED", label: "Reported by the ship’s staff", phrase: "{be} reported by the ship’s staff to be operating normally" },
] as const

const MACHINERY_RESULT = [
  { id: "WITHIN", label: "Within the maker’s parameters", phrase: "{be} operating within the maker’s specified parameters" },
  { id: "DEVIATIONS", label: "Deviations noted", phrase: "showed deviations from the maker’s specified parameters, which have been recorded in the DDRL" },
] as const

const PLURAL_MACHINERY = ["GENERATORS", "BOILERS", "PURIFIERS", "COMPRESSORS", "SW_PUMPS"]

function agree(phrase: string, plural: boolean) {
  return phrase.replace(/\{be\}/g, plural ? "were" : "was").replace(/\{its\}/g, plural ? "their" : "its")
}

const MACHINERY_FACTS = [
  { id: "ME_MONTHLY", label: "ME performance monitored monthly", phrase: "Main engine performance is monitored monthly, and the latest report was reviewed with the Chief Engineer and Second Engineer" },
  { id: "ALARMS_TRIPS", label: "ME, generator and boiler alarms and trips tested", phrase: "Main engine, generator and boiler alarms and trips were tested" },
  { id: "STANDBY", label: "Standby machinery changed over monthly", phrase: "Standby machinery is changed over monthly and maintained ready for use" },
  { id: "GENERATOR_LOAD", label: "Generators carried full cargo-operation load", phrase: "The generators carried the required load during cargo operations without difficulty" },
  { id: "RESERVE_POWER", label: "Limited reserve power – load planning needed", phrase: "Electrical reserve power is limited, and careful load planning is required during high-demand operations" },
] as const

const NAV_STATUS = [
  { id: "TESTED_OK", label: "Tested – fully operational", phrase: "was tested and found fully operational" },
  { id: "REPORTED_OK", label: "Reported fully operational", phrase: "was reported by the ship’s staff to be fully operational" },
  { id: "DEFECTS", label: "Tested – defects recorded in the DDRL", phrase: "was tested, and the defects found have been recorded in the DDRL" },
  { id: "NOT_ASSESSED", label: "Not assessed", phrase: "" },
] as const

const NAV_ITEMS = [
  { id: "RADARS", label: "Both radars", phrase: "both radars" },
  { id: "ECDIS", label: "ECDIS (charts and software up to date)", phrase: "the ECDIS units with up-to-date charts and software" },
  { id: "GYRO", label: "Gyro compasses and repeaters", phrase: "the gyro compasses and repeaters" },
  { id: "MAGNETIC", label: "Magnetic compass", phrase: "the magnetic compass" },
  { id: "GMDSS", label: "GMDSS equipment", phrase: "the GMDSS equipment" },
  { id: "AIS_VDR", label: "AIS and VDR", phrase: "the AIS and VDR" },
  { id: "BNWAS", label: "BNWAS", phrase: "the BNWAS" },
] as const

const NAV_SURVEY = [
  { id: "COMPLETED", label: "Annual radio / navigation surveys completed", phrase: "The annual radio and navigation equipment surveys have been completed" },
  { id: "PLANNED", label: "Annual surveys planned", phrase: "" },
  { id: "DOCK_SERVICING", label: "5- and 10-yearly servicing done in dock", phrase: "Five-yearly and ten-yearly servicing of the navigation equipment was completed during dry-docking" },
] as const

const CARGO_METHOD = [
  { id: "OBSERVED", label: "Observed during cargo operations", phrase: "Cargo and ballast machinery was observed in operation during cargo operations" },
  { id: "UNDERWAY", label: "At sea – visual and records only", phrase: "As the vessel was at sea, the cargo machinery could not be observed in operation; a visual inspection was carried out and the records of the last cargo operation were reviewed" },
  { id: "NO_CARGO", label: "No cargo on board – records only", phrase: "Cargo machinery could not be observed in operation as there was no cargo on board; the records of the last cargo operation were reviewed" },
  { id: "RECORDS", label: "Records of the last operation reviewed", phrase: "The records of the last cargo operation were reviewed" },
] as const

const CARGO_RESULT = [
  { id: "SATISFACTORY", label: "Satisfactory, no issues", phrase: "No issues were found" },
  { id: "ISSUES", label: "Issues noted", phrase: "The issues found are addressed in this report" },
] as const

const CARGO_FACTS = [
  { id: "RATES", label: "Required pumping rates achieved", phrase: "the required pumping rates were achieved" },
  { id: "IGS", label: "Inert gas system operational", phrase: "the inert gas system was operational" },
  { id: "COW", label: "Crude oil washing normal", phrase: "crude oil washing was carried out normally" },
  { id: "BWTS_USED", label: "BWTS used for ballasting", phrase: "the BWTS was used for ballasting operations" },
  { id: "CRANES", label: "Cranes operationally tested", phrase: "the hose-handling and provision cranes were tested in operation with satisfactory results" },
  { id: "CRANES_LOAD", label: "Cranes load-tested after dock repairs", phrase: "the hose-handling and provision cranes were load-tested after dry-dock repairs" },
  { id: "MOORING", label: "Windlasses and winches satisfactory", phrase: "the windlasses and mooring winches were in satisfactory working condition" },
] as const

const BWTS = [
  { id: "OPERATIONAL", label: "Operational", phrase: "The ballast water management system was operational" },
  { id: "VGP_SAMPLED", label: "Operated for VGP sampling – results satisfactory", phrase: "The ballast water management system was operated for US VGP sampling, and the results confirmed satisfactory performance" },
  { id: "UPGRADED", label: "Upgraded, approved by Class, IBWMC reissued", phrase: "The ballast water management system was upgraded, the upgrade was approved by the Classification Society and a new International Ballast Water Management Certificate was issued" },
  { id: "FREQUENT_ATTENTION", label: "Needs frequent attention and service calls", phrase: "The ballast water management system requires frequent attention and service visits" },
  { id: "DEFECTIVE", label: "Defective – see Significant Problems", phrase: "The ballast water management system is defective; details are given under Significant Problems" },
] as const

const EGCS = [
  { id: "OPEN_LOOP_OK", label: "Open-loop, within parameters", phrase: "The open-loop EGCS was operating within its parameters, enabling compliance with MARPOL Annex VI while using high-sulphur fuel oil, and wash-water discharge monitoring was within limits" },
  { id: "CLOSED_HYBRID_OK", label: "Closed-loop / hybrid, within parameters", phrase: "The EGCS was operating within its parameters, enabling compliance with MARPOL Annex VI while using high-sulphur fuel oil" },
  { id: "DEFECTIVE", label: "Defective – see Significant Problems", phrase: "The EGCS has defects; details are given under Significant Problems" },
] as const

const SCR = [
  { id: "OK", label: "Normal working condition", phrase: "The SCR system was in normal working condition" },
  { id: "ISSUE", label: "Issue under investigation with the maker", phrase: "An SCR system irregularity is under investigation with the maker’s technical support" },
] as const

const MARPOL_CHECKS = [
  { id: "OWS", label: "OWS, piping and seals – no tampering", phrase: "the oily water separator, its piping and seals showed no signs of tampering" },
  { id: "RECORD_BOOKS", label: "ORB and Garbage Record Book verified", phrase: "Oil Record Book and Garbage Record Book entries were verified" },
  { id: "GARBAGE", label: "Garbage segregation and incinerator reviewed", phrase: "garbage segregation and incinerator operation were reviewed with the crew" },
  { id: "SAMPLES", label: "Potable water and OWS samples tested", phrase: "potable water and OWS effluent samples were tested" },
] as const

const CRITICAL_RESULT = [
  { id: "SATISFACTORY", label: "Satisfactory results", phrase: ", with satisfactory results" },
  { id: "DEFECTS", label: "Defects recorded in the DDRL", phrase: ", and the defects found have been recorded in the DDRL" },
] as const

const CRITICAL_EXTRA = [
  { id: "EMERGENCY", label: "Emergency generator, emergency fire pump, incinerator run", phrase: "the emergency generator, emergency fire pump and incinerator were run" },
  { id: "SAFETY_EQUIPMENT", label: "Lifeboats, funnel flaps, QCVs and dampers tried", phrase: "the lifeboats, funnel flaps, quick-closing valves and fire dampers were tried out" },
  { id: "OVERFILL", label: "Overfill alarms and pump room dampers tested", phrase: "cargo tank overfill alarms and pump room emergency dampers were tested" },
  { id: "ODME", label: "ODME simulation test", phrase: "an ODME simulation test was carried out" },
] as const

const DRILLS = [
  { id: "FIRE", label: "Fire", phrase: "fire" },
  { id: "ABANDON", label: "Abandon ship", phrase: "abandon-ship" },
  { id: "ENCLOSED", label: "Enclosed-space rescue", phrase: "enclosed-space rescue" },
  { id: "STEERING", label: "Emergency steering", phrase: "emergency steering" },
  { id: "OIL_SPILL", label: "Oil spill response", phrase: "oil spill response" },
  { id: "MOB", label: "Man overboard", phrase: "man-overboard" },
  { id: "SECURITY", label: "Security", phrase: "security" },
  { id: "OTHER", label: "Other (write in)", phrase: "" },
] as const

const DRILL_RESULT = [
  { id: "SATISFACTORY", label: "Crew response satisfactory", phrase: "the crew’s response was satisfactory" },
  { id: "IMPROVEMENT", label: "Improvement points debriefed", phrase: "improvement points were debriefed with the crew" },
] as const

const SMS_ITEMS = [
  { id: "PMS", label: "PMS records cross-checked against machinery", phrase: "Planned Maintenance System records, randomly cross-checked against the machinery" },
  { id: "DDRL", label: "Defect and Damage Report List", phrase: "the Defect and Damage Report List" },
  { id: "PTW_RA", label: "Permits to work and risk assessments", phrase: "permit-to-work and risk assessment records" },
  { id: "REST_HOURS", label: "Hours of rest (STCW / MLC)", phrase: "hours of rest records under STCW and MLC" },
  { id: "MASTERS_REVIEW", label: "Master’s Review and Company response", phrase: "the Master’s Review of the SMS and the Company’s response" },
  { id: "NEAR_MISS", label: "Near-miss reports and preventive measures", phrase: "near-miss reports and the effectiveness of preventive measures" },
  { id: "FAMILIARISATION", label: "Safety and equipment familiarisation", phrase: "safety and equipment familiarisation records" },
  { id: "CERTIFICATES", label: "Certificates and survey status", phrase: "statutory and Class certificates and survey status" },
  { id: "SAFETY_MEETINGS", label: "Safety committee meetings", phrase: "safety committee meeting minutes" },
  { id: "PREVIOUS_OBS", label: "Close-out of previous observations", phrase: "close-out of observations from the previous inspection" },
  { id: "PSC_CHECKLIST", label: "PSC preparation checklist", phrase: "the PSC preparation checklist" },
  { id: "BUNKER_CHECKLISTS", label: "Bunkering checklists", phrase: "bunkering checklists" },
  { id: "ROUTINES", label: "Weekly safety routines and rounds", phrase: "weekly safety routines and rounds" },
] as const

const SMS_RESULT = [
  { id: "NO_NC", label: "No non-conformities", phrase: "No non-conformities were identified" },
  { id: "OBSERVATIONS", label: "Observations raised – in the worklist", phrase: "The observations raised have been included in the inspection worklist" },
  { id: "NC", label: "Non-conformities reported to the Company", phrase: "The non-conformities identified have been reported to the Company for corrective action" },
] as const

/** "A fire drill" / "An abandon-ship drill" / "Fire and abandon-ship drills". */
function drillsSentence(names: string[]) {
  if (!names.length) return ""
  if (names.length === 1) return `${/^[aeiou]/i.test(names[0]) ? "An" : "A"} ${names[0]} drill was`
  return `${joinList(names)} drills were`
}

export const OPERATIONAL_SECTION: SectionSpec = {
  id: "operationalCondition",
  summaryKey: "operational",
  title: "Operational Condition",
  tab: "Operational",
  description: "How machinery, navigation, cargo and safety systems performed, how that was verified, and SMS implementation.",
  groups: [
    {
      title: "Assessment and machinery",
      fields: [
        { kind: "select", key: "assessment", label: "Operational condition", required: true, options: ASSESSMENTS, placeholder: "Select…" },
        { kind: "select", key: "issues", label: "Operational issues", options: ISSUES, placeholder: "Not stated" },
        { kind: "multi", key: "machineryScope", label: "Machinery covered", options: MACHINERY_SCOPE, columns: 2 },
        { kind: "select", key: "machineryMethod", label: "How it was verified", required: true, options: MACHINERY_METHOD, showIf: (s) => list(s, "machineryScope").length > 0 },
        { kind: "select", key: "machineryResult", label: "Result", required: true, options: MACHINERY_RESULT, showIf: (s) => list(s, "machineryScope").length > 0 && str(s, "machineryMethod") !== "REPORTED" },
        { kind: "multi", key: "machineryFacts", label: "Further machinery points", options: MACHINERY_FACTS },
      ],
    },
    {
      title: "Navigation and communication",
      fields: [
        { kind: "select", key: "nav", label: "Navigation and communication equipment", options: NAV_STATUS, placeholder: "Not stated" },
        { kind: "multi", key: "navItems", label: "Including", options: NAV_ITEMS, columns: 2, showIf: (s) => !!str(s, "nav") && str(s, "nav") !== "NOT_ASSESSED" },
        { kind: "select", key: "navSurvey", label: "Radio / navigation surveys", options: NAV_SURVEY, placeholder: "Not stated" },
        { kind: "text", key: "navSurveyPlan", label: "Planned at / around", required: true, placeholder: "e.g. Singapore around 13 May 2025", showIf: (s) => str(s, "navSurvey") === "PLANNED" },
      ],
    },
    {
      title: "Cargo, ballast and mooring",
      fields: [
        { kind: "select", key: "cargo", label: "Cargo and ballast machinery", options: CARGO_METHOD, placeholder: "Not stated", wide: true },
        { kind: "select", key: "cargoResult", label: "Result", required: true, options: CARGO_RESULT, showIf: (s) => !!str(s, "cargo") },
        { kind: "multi", key: "cargoFacts", label: "Further points", options: CARGO_FACTS, columns: 2 },
      ],
    },
    {
      title: "Environmental systems and MARPOL",
      fields: [
        { kind: "select", key: "bwts", label: "Ballast water management system", options: BWTS, placeholder: "Not fitted / not stated" },
        { kind: "select", key: "egcs", label: "Exhaust gas cleaning system", options: EGCS, placeholder: "Not fitted / not stated" },
        { kind: "confirm", key: "egcsPortStop", label: "Open-loop operation suspended in ports where discharge is prohibited", showIf: (s) => str(s, "egcs") === "OPEN_LOOP_OK" },
        { kind: "select", key: "scr", label: "SCR (Tier III)", options: SCR, placeholder: "Not fitted / not stated" },
        { kind: "multi", key: "marpol", label: "MARPOL checks", options: MARPOL_CHECKS },
      ],
    },
    {
      title: "Critical equipment and drills",
      fields: [
        {
          kind: "confirm",
          key: "includeCritical",
          label: "State the critical equipment tests recorded in this report",
          default: true,
          showIf: (_s, ctx) => ctx.critical.tested.length > 0,
        },
        { kind: "select", key: "criticalResult", label: "Result of the tests", required: true, options: CRITICAL_RESULT, showIf: (s, ctx) => ctx.critical.tested.length > 0 && flag(s, "includeCritical") },
        { kind: "multi", key: "criticalExtra", label: "Also tried out", options: CRITICAL_EXTRA },
        { kind: "multi", key: "drills", label: "Drills witnessed", options: DRILLS, columns: 2 },
        {
          kind: "items",
          key: "otherDrills",
          label: "Other drills",
          itemLabel: "Other drill",
          addLabel: "Add another drill",
          max: 6,
          required: true,
          showIf: (s) => list(s, "drills").includes("OTHER"),
          fields: [
            {
              kind: "text",
              key: "name",
              label: "Drill",
              required: true,
              placeholder: "e.g. ballast water spill",
              hint: "The word “drill” is added for you.",
              wide: true,
            },
          ],
        },
        { kind: "select", key: "drillResult", label: "Drill outcome", required: true, options: DRILL_RESULT, showIf: (s) => list(s, "drills").length > 0 },
      ],
    },
    {
      title: "Safety Management System",
      fields: [
        { kind: "multi", key: "sms", label: "SMS implementation reviewed", options: SMS_ITEMS, columns: 2 },
        { kind: "select", key: "smsResult", label: "Result", required: true, options: SMS_RESULT, showIf: (s) => list(s, "sms").length > 0 },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i, ctx) {
    // 1. Assessment and machinery
    const a = assessment(str(i, "assessment"))
    const opening = a ? sentence(`The vessel’s operational condition was assessed as ${a}`) : gap("operational condition")
    const issues = ISSUES.find((o) => o.id === str(i, "issues"))?.phrase
    const scopeIds = list(i, "machineryScope")
    const scope = phrases(MACHINERY_SCOPE, scopeIds)
    let machinery = ""
    if (scope.length) {
      const plural = scope.length > 1 || PLURAL_MACHINERY.includes(scopeIds[0])
      const subject = `The ${joinList(scope)}`
      const method = MACHINERY_METHOD.find((o) => o.id === str(i, "machineryMethod"))
      const result = MACHINERY_RESULT.find((o) => o.id === str(i, "machineryResult"))
      if (!method) machinery = gap("how the machinery was verified")
      else if (method.id === "REPORTED" || !result) machinery = sentence(`${subject} ${agree(method.phrase, plural)}`)
      else machinery = sentence(`${subject} ${agree(method.phrase, plural)} and ${agree(result.phrase, plural)}`)
    }
    const facts = phrases(MACHINERY_FACTS, list(i, "machineryFacts")).map((p) => sentence(p))

    // 2. Navigation
    const nav = NAV_STATUS.find((o) => o.id === str(i, "nav"))
    const navItems = phrases(NAV_ITEMS, list(i, "navItems"))
    let navText = ""
    if (nav?.id === "NOT_ASSESSED") navText = sentence("Navigation and communication equipment was not assessed during this attendance")
    else if (nav) navText = sentence(`Navigation and communication equipment${navItems.length ? `, including ${joinList(navItems)},` : ""} ${nav.phrase}`)
    const survey = str(i, "navSurvey")
    const surveyText =
      survey === "PLANNED"
        ? sentence(`The annual radio and navigation equipment surveys are planned at ${str(i, "navSurveyPlan") || gap("place and date")}`)
        : sentence(NAV_SURVEY.find((o) => o.id === survey)?.phrase ?? "")

    // 3. Cargo
    const cargo = CARGO_METHOD.find((o) => o.id === str(i, "cargo"))
    const cargoResult = CARGO_RESULT.find((o) => o.id === str(i, "cargoResult"))
    const cargoText = cargo ? [sentence(cargo.phrase), cargoResult ? sentence(cargoResult.phrase) : ""].filter(Boolean).join(" ") : ""
    const cargoFacts = phrases(CARGO_FACTS, list(i, "cargoFacts"))
    const cargoFactsText = cargoFacts.length ? sentence(joinClauses(cargoFacts)) : ""

    // 4. Environmental
    const bwts = BWTS.find((o) => o.id === str(i, "bwts"))?.phrase
    const egcs = EGCS.find((o) => o.id === str(i, "egcs"))?.phrase
    const egcsStop = flag(i, "egcsPortStop") ? sentence("Open-loop operation is suspended in ports where wash-water discharge is prohibited") : ""
    const scr = SCR.find((o) => o.id === str(i, "scr"))?.phrase
    const marpol = phrases(MARPOL_CHECKS, list(i, "marpol"))
    const marpolText = marpol.length ? sentence(`MARPOL compliance checks were carried out: ${joinClauses(marpol)}`) : ""

    // 5. Critical equipment and drills
    let critical = ""
    if (ctx.critical.tested.length && flag(i, "includeCritical")) {
      const n = ctx.critical.tested.length
      const result = CRITICAL_RESULT.find((o) => o.id === str(i, "criticalResult"))?.phrase
      critical = sentence(`Of the ${ctx.critical.total} critical equipment items listed in this report, ${n} ${n === 1 ? "was" : "were"} tested during the attendance${result ?? ""}`)
    }
    const extra = phrases(CRITICAL_EXTRA, list(i, "criticalExtra"))
    const extraText = extra.length ? sentence(`${critical ? "In addition, " : ""}${joinClauses(extra)}`) : ""
    // Written-in drills follow the standard ones; a trailing "drill" typed by the user is dropped (it is added once).
    const otherDrills = list(i, "drills").includes("OTHER")
      ? items(i, "otherDrills")
          .map((item) => lowerFirst(cleanFragment(item.name as string)).replace(/\s+drills?$/i, ""))
          .filter(Boolean)
      : []
    const drillNames = [...phrases(DRILLS, list(i, "drills")), ...otherDrills]
    const drillResult = DRILL_RESULT.find((o) => o.id === str(i, "drillResult"))?.phrase
    const drills = drillNames.length ? sentence(`${drillsSentence(drillNames)} witnessed${drillResult ? `, and ${drillResult}` : ""}`) : ""

    // 6. SMS
    const sms = phrases(SMS_ITEMS, list(i, "sms"))
    const smsResult = SMS_RESULT.find((o) => o.id === str(i, "smsResult"))?.phrase
    const smsText = sms.length ? [sentence(`The review of Safety Management System implementation covered ${joinNouns(sms)}`), smsResult ? sentence(smsResult) : ""].filter(Boolean).join(" ") : ""

    return [
      para("machinery", "Assessment and machinery", [opening, issues && sentence(issues), machinery, ...facts]),
      para("navigation", "Navigation and communication", [navText, surveyText]),
      para("cargo", "Cargo, ballast and mooring", [cargoText, cargoFactsText]),
      para("environment", "Environmental systems and MARPOL", [bwts && sentence(bwts), egcs && sentence(egcs), egcsStop, scr && sentence(scr), marpolText]),
      para("critical", "Critical equipment and drills", [critical, extraText, drills]),
      para("sms", "Safety Management System", [smsText, sentence(str(i, "note"))]),
    ]
  },

  facts: vesselConditionFacts,

  validate(i, ctx, { warn }) {
    const { loading, situation } = ctx.vesselCondition
    const cargoMethod = str(i, "cargo")
    if (cargoMethod === "UNDERWAY" && (situation === "PORT" || situation === "DRY_DOCK")) {
      warn("narr-operationalCondition-cargo", `“At sea” is selected for the cargo machinery, but the Preamble says the vessel was ${situation === "PORT" ? "in port" : "in dry-dock"}.`)
    }
    if (cargoMethod === "OBSERVED" && situation === "SEA") {
      warn("narr-operationalCondition-cargo", "Cargo machinery is recorded as observed during cargo operations, but the Preamble says the vessel was at sea.")
    }
    if (cargoMethod === "NO_CARGO" && loading === "LADEN") {
      warn("narr-operationalCondition-cargo", "“No cargo on board” is selected, but the Preamble says the vessel was laden.")
    }
    const keys = [...MACHINERY_KEYS, ...NAVIGATION_KEYS, ...CARGO_KEYS, ...SAFETY_KEYS]
    const action = deficientItems(ctx, keys)
    if (isFavourable(str(i, "assessment")) && action.length) {
      warn("narr-operationalCondition-assessment", `The operational condition is favourable while ${itemNames(action)} ${action.length === 1 ? "is" : "are"} rated Deficient. Confirm the assessment.`)
    }
    const defectsSelected =
      str(i, "machineryResult") === "DEVIATIONS" ||
      str(i, "nav") === "DEFECTS" ||
      str(i, "bwts") === "DEFECTIVE" ||
      str(i, "egcs") === "DEFECTIVE" ||
      str(i, "criticalResult") === "DEFECTS"
    if (str(i, "issues") === "NONE" && defectsSelected) {
      warn("narr-operationalCondition-issues", "“No operational issues” is selected, but defects are selected elsewhere in this section.")
    }
    if (str(i, "issues") === "NONE" && action.length) {
      warn("narr-operationalCondition-issues", `“No operational issues” is selected, but ${itemNames(action)} ${action.length === 1 ? "is" : "are"} rated Deficient.`)
    }
    if (!ctx.critical.tested.length) {
      warn("narr-operationalCondition-criticalExtra", "No critical equipment is ticked as tested in the Critical Equipment section of this report.")
    }
    const testDefects = ctx.critical.defects
    if (flag(i, "includeCritical") && str(i, "criticalResult") === "SATISFACTORY" && testDefects.length) {
      warn(
        "narr-operationalCondition-criticalResult",
        `“Satisfactory results” is selected, but the Critical Equipment section records a defect on ${testDefects.length === 1 ? "this test" : "these tests"}: ${testDefects.join("; ")}.`,
      )
    }
  },
}
