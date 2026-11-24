// Executive Summary – Structural Condition.
// Pattern from past reports: assessment (qualified by the areas accessible) → hull above the waterline → underwater
// inspection / propeller polishing → main deck, superstructure, casings, EGCS tower, Load Line items → ballast tanks
// (who inspected what, how far, coating) → cargo tanks, Class status, CAP rating and survey dates.
// Coverage limits are always stated with their reason, so the summary never implies an inspection that did not happen.

import { compareIsoDates, formatDate, formatMonthYear } from "../dates"
import { gap, joinClauses, joinList, sentence } from "../text"
import { para, type SectionSpec } from "../section"
import { UNDERWATER_FIELDS, monthsSinceUnderwater, underwaterSentences } from "./underwater"
import { vesselConditionFacts } from "./common"
import { ASSESSMENTS, HULL_KEYS, STRUCTURE_KEYS, TANK_KEYS, deficientItems, assessment, flag, has, isFavourable, itemNames, list, phrases, str } from "./common"

const HULL_STRUCTURE = [
  { id: "NO_DEFORMATION", label: "No deformation, indentation or damage", phrase: "the shell plating showed no deformation, indentation or structural damage" },
  { id: "MARKINGS", label: "Draught, load line and hull markings clear", phrase: "the draught marks, load line mark and hull markings were clearly visible" },
  { id: "INDENT_WITHIN_LIMITS", label: "Minor indentation within Class limits", phrase: "a minor indentation within Class allowable limits was noted" },
  { id: "FENDER_DAMAGE", label: "Coating damage from fender contact", phrase: "coating damage from fender contact was noted" },
] as const

export const DECK_RUST = [
  { id: "NONE", label: "No rust spots", phrase: "no rust spots were noted" },
  { id: "LT_0_1", label: "Rust spots < 0.1% of deck area", phrase: "rust spots covered less than 0.1% of the deck area" },
  { id: "LT_1", label: "Rust spots < 1% of deck area", phrase: "rust spots covered less than 1% of the deck area" },
  { id: "SCATTERED", label: "Scattered spot rust", phrase: "scattered spot rust was noted" },
  { id: "SIGNIFICANT", label: "Significant rust requiring attention", phrase: "significant rust requiring attention was noted" },
] as const

export const DECK_OBSERVATIONS = [
  { id: "NO_CORROSION", label: "Plating, pipelines and fittings sound", phrase: "deck plating, pipelines and fittings were free from significant corrosion, cracking or fatigue" },
  { id: "SUPPORTS", label: "Pipe supports, vents and coamings good", phrase: "deck pipe supports, vent pipes, railings and tank coamings were in good condition" },
  { id: "HELIDECK", label: "Helicopter area well marked", phrase: "the helicopter area was well marked" },
  { id: "PIPE_CORROSION", label: "Pipeline / U-bolt corrosion being addressed", phrase: "corrosion on pipelines, supports and U-bolts is being addressed" },
  { id: "MANHOLE_WEEPING", label: "Rust weeping at domes and manholes", phrase: "rust weeping at tank domes and manholes is to be de-rusted and painted" },
] as const

export const CASING = [
  { id: "CLEAN", label: "Clean, no stains or leaks", phrase: "The engine room casing and funnel were clean and free of stains and leaks" },
  { id: "STAINS", label: "Weeping stains / spot corrosion planned", phrase: "Weeping stains and spot corrosion on the engine casing and funnel have been included in the maintenance plan" },
  { id: "SOOT", label: "Soot staining from the funnel", phrase: "Soot staining from the funnel was noted on the casing and sunken deck" },
] as const

export const EGCS_TOWER = [
  { id: "SATISFACTORY", label: "Tower and attachments satisfactory", phrase: "the EGCS tower and its structural attachments were in satisfactory condition" },
  { id: "WEEPING", label: "Weeping marks need early attention", phrase: "weeping marks on the EGCS tower require early attention" },
  { id: "PIPING_MONITOR", label: "EGCS sea water piping under close watch", phrase: "the EGCS sea water piping requires close monitoring because of previous damage, and spare pipes have been supplied" },
] as const

const WBT_METHOD = [
  { id: "PERSONAL", label: "Inspected internally by the Superintendent" },
  { id: "FROM_HATCH", label: "Inspected from the access hatch to a stringer level" },
  { id: "STAFF_REPORTS", label: "Ship’s staff inspection reports reviewed" },
  { id: "PHOTOS", label: "Inspection photographs verified" },
  { id: "IN_DRY_DOCK", label: "Inspected during dry-docking" },
  { id: "NOT_INSPECTED", label: "Not inspected by the Superintendent" },
] as const

const STRINGERS = [
  { id: "FIRST", label: "First stringer", phrase: "first" },
  { id: "SECOND", label: "Second stringer", phrase: "second" },
  { id: "THIRD", label: "Third stringer", phrase: "third" },
] as const

const WBT_REASON = [
  { id: "BALLASTED", label: "Tanks ballasted", phrase: "as the tanks were ballasted" },
  { id: "SCHEDULE", label: "Port / cargo schedule", phrase: "because of the vessel’s port and cargo schedule" },
  { id: "ENTRY", label: "Entry conditions not met", phrase: "as the conditions for safe entry could not be met" },
  { id: "TIME", label: "Time constraints", phrase: "because of time constraints" },
] as const

const IACS_COATING = [
  { id: "GOOD", label: "GOOD (IACS)", phrase: "GOOD" },
  { id: "FAIR", label: "FAIR (IACS)", phrase: "FAIR" },
  { id: "POOR", label: "POOR (IACS)", phrase: "POOR" },
] as const

const WBT_FINDINGS = [
  { id: "NO_PITTING", label: "No pitting, wear or breakdown", phrase: "no pitting, structural wear or coating breakdown was found" },
  { id: "INTACT", label: "Coating intact, no blistering", phrase: "the coating was intact, with no blistering" },
  { id: "LIGHT_CORROSION", label: "Light surface corrosion", phrase: "light surface corrosion was noted on some longitudinals and bulkheads" },
  { id: "ANODES_GOOD", label: "Anodes in good condition", phrase: "sacrificial anodes were in good condition" },
  { id: "NO_ANODES", label: "No anodes fitted – monitor coating", phrase: "sacrificial anodes are not fitted, so the coating requires close monitoring" },
  { id: "LADDERS", label: "Ladders / handrails need maintenance", phrase: "ladders and handrails require spot de-rusting and coating" },
  { id: "MUD", label: "Mud in double bottoms", phrase: "mud accumulation was noted in the double-bottom tanks" },
  { id: "DEFORMATION_CLASS", label: "Deformation reviewed by Class", phrase: "structural deformation was noted and has been reviewed by the Classification Society, which raised no structural concern" },
] as const

const CARGO_TANKS = [
  { id: "INSPECTED", label: "Inspected during the attendance", phrase: "The cargo tanks were inspected during the attendance" },
  { id: "IN_DRY_DOCK", label: "Inspected during dry-docking", phrase: "All cargo tanks were inspected during the recent dry-docking" },
  { id: "LAST_INSPECTED", label: "Last inspected on a date", phrase: "" },
  { id: "INERTED", label: "Not inspected – tanks inerted", phrase: "The cargo tanks could not be inspected as they were inerted" },
  { id: "LOADED", label: "Not inspected – vessel loaded", phrase: "The cargo tanks could not be inspected as the vessel was loaded" },
] as const

const CAP = [
  { id: "CAP1", label: "CAP 1", phrase: "CAP 1" },
  { id: "CAP2", label: "CAP 2", phrase: "CAP 2" },
  { id: "CAP3", label: "CAP 3", phrase: "CAP 3" },
] as const

const CAP_SCOPE = [
  { id: "HULL", label: "Hull", phrase: "hull" },
  { id: "CARGO", label: "Cargo system", phrase: "cargo system" },
  { id: "MACHINERY", label: "Machinery", phrase: "machinery" },
] as const

const CLASS_STATUS = [
  { id: "NO_COC", label: "No Conditions of Class outstanding", phrase: "No Conditions of Class or statutory recommendations are outstanding" },
  { id: "COC", label: "Conditions of Class outstanding", phrase: "Conditions of Class are outstanding and are reported under Significant Problems" },
] as const

export const STRUCTURAL_SECTION: SectionSpec = {
  id: "structuralCondition",
  summaryKey: "structural",
  title: "Structural Condition",
  tab: "Structural",
  description: "Hull, decks, tanks and Class matters, stating what was physically inspected and what was verified from records.",
  groups: [
    {
      title: "Assessment and hull above the waterline",
      fields: [
        { kind: "select", key: "assessment", label: "Structural condition", required: true, options: ASSESSMENTS, placeholder: "Select…" },
        { kind: "confirm", key: "accessibleOnly", label: "Qualify as “based on the areas accessible during the attendance”", default: true },
        { kind: "multi", key: "hull", label: "Hull above the waterline", options: HULL_STRUCTURE, columns: 2 },
      ],
    },
    {
      title: "Underwater hull and propeller",
      fields: [
        ...UNDERWATER_FIELDS,
      ],
    },
    {
      title: "Main deck, superstructure and casings",
      fields: [
        { kind: "select", key: "deckRust", label: "Main deck rust", options: DECK_RUST, placeholder: "Not stated" },
        { kind: "multi", key: "deck", label: "Deck observations", options: DECK_OBSERVATIONS, columns: 2 },
        { kind: "select", key: "casing", label: "Engine casing and funnel", options: CASING, placeholder: "Not stated" },
        { kind: "multi", key: "egcs", label: "EGCS tower (if fitted)", options: EGCS_TOWER },
        {
          kind: "confirm",
          key: "loadLine",
          label: "Vents, air pipe heads and closing appliances checked – compliant with the Load Line Convention",
          tooltip: "A frequent Port State Control item. Tick only if they were checked during this attendance.",
        },
      ],
    },
    {
      title: "Ballast tanks",
      fields: [
        { kind: "multi", key: "wbtMethod", label: "How the ballast tanks were covered", options: WBT_METHOD, required: true },
        { kind: "text", key: "wbtTanks", label: "Tanks inspected", required: true, placeholder: "e.g. 1S, 2S, 5S and the aft peak tank", showIf: (s) => has(s, "wbtMethod", "PERSONAL") || has(s, "wbtMethod", "FROM_HATCH") },
        { kind: "select", key: "wbtStringer", label: "Inspected down to", required: true, options: STRINGERS, showIf: (s) => has(s, "wbtMethod", "FROM_HATCH") },
        { kind: "date", key: "wbtStaffDate", label: "Ship’s staff last inspected all tanks (month)", hint: "Written as “in December 2024”.", showIf: (s) => has(s, "wbtMethod", "STAFF_REPORTS") },
        { kind: "select", key: "wbtReason", label: "Why not inspected", required: true, options: WBT_REASON, showIf: (s) => has(s, "wbtMethod", "NOT_INSPECTED") },
        { kind: "select", key: "wbtCoating", label: "Coating condition (IACS)", options: IACS_COATING, placeholder: "Not assessed", tooltip: "IACS coating condition: GOOD – minor spot rusting only; FAIR – local breakdown at edges or welds; POOR – general breakdown or hard scale." },
        { kind: "multi", key: "wbtFindings", label: "Findings", options: WBT_FINDINGS, columns: 2 },
      ],
    },
    {
      title: "Cargo tanks, Class and surveys",
      fields: [
        { kind: "select", key: "cargoTanks", label: "Cargo tanks", options: CARGO_TANKS, placeholder: "Not stated" },
        { kind: "date", key: "cargoTanksDate", label: "Last inspected (month)", required: true, showIf: (s) => str(s, "cargoTanks") === "LAST_INSPECTED" },
        { kind: "select", key: "cap", label: "CAP rating", options: CAP, placeholder: "None / not stated" },
        { kind: "multi", key: "capScope", label: "CAP rating covers", options: CAP_SCOPE, showIf: (s) => !!str(s, "cap") },
        { kind: "select", key: "classStatus", label: "Class status", options: CLASS_STATUS, placeholder: "Not verified" },
        { kind: "date", key: "annualFrom", label: "Next annual survey window – from" },
        { kind: "date", key: "annualTo", label: "Next annual survey window – to", showIf: (s) => !!str(s, "annualFrom") },
        { kind: "date", key: "specialSurveyDue", label: "Next Special Survey due" },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i) {
    // 1. Assessment and hull
    const a = assessment(str(i, "assessment"))
    const qualifier = flag(i, "accessibleOnly") ? ", based on the areas accessible during the attendance" : ""
    const opening = a ? sentence(`The structural condition of the vessel was assessed as ${a}${qualifier}`) : gap("structural condition")
    const hullPhrases = phrases(HULL_STRUCTURE, list(i, "hull"))
    const hull = hullPhrases.length ? sentence(`Above the waterline, ${joinClauses(hullPhrases)}`) : ""

    // 2. Underwater hull and propeller
    const uw = underwaterSentences(i)
    const underwater = uw.text
    const uwFindings = uw.findings.length ? sentence(joinClauses(uw.findings)) : ""

    // 3. Deck, superstructure and casings
    const rust = DECK_RUST.find((o) => o.id === str(i, "deckRust"))?.phrase
    const deckPhrases = [rust, ...phrases(DECK_OBSERVATIONS, list(i, "deck"))].filter(Boolean) as string[]
    const deck = deckPhrases.length ? sentence(`On the main deck, ${joinClauses(deckPhrases)}`) : ""
    const casing = CASING.find((o) => o.id === str(i, "casing"))?.phrase
    const egcs = phrases(EGCS_TOWER, list(i, "egcs"))
    const loadLine = flag(i, "loadLine")
      ? sentence("Vents, air pipe heads and closing appliances were checked and found compliant with the International Convention on Load Lines")
      : ""

    // 4. Ballast tanks
    const methods = list(i, "wbtMethod")
    const tanks = str(i, "wbtTanks")
    const wbt: string[] = []
    if (methods.includes("IN_DRY_DOCK")) wbt.push(sentence("All ballast tanks were inspected during the recent dry-docking"))
    if (methods.includes("FROM_HATCH")) {
      const level = STRINGERS.find((s) => s.id === str(i, "wbtStringer"))?.phrase
      wbt.push(sentence(`The Superintendent inspected ${tanks || gap("tanks")} from the access hatch down to the ${level ?? gap("stringer")} stringer level`))
    } else if (methods.includes("PERSONAL")) {
      wbt.push(sentence(`The Superintendent inspected ${tanks || gap("tanks")} internally`))
    }
    if (methods.includes("NOT_INSPECTED")) {
      const reason = WBT_REASON.find((r) => r.id === str(i, "wbtReason"))?.phrase
      wbt.push(sentence(`Internal inspection of the ballast tanks by the Superintendent was not possible ${reason ?? gap("reason")}`))
    }
    if (methods.includes("STAFF_REPORTS")) {
      const month = formatMonthYear(str(i, "wbtStaffDate"))
      wbt.push(
        sentence(
          month
            ? `All ballast tanks were last inspected internally by the ship’s staff in ${month}, and the inspection reports were reviewed with the Chief Officer`
            : "The ship’s staff ballast tank inspection reports were reviewed with the Chief Officer",
        ),
      )
    }
    if (methods.includes("PHOTOS")) wbt.push(sentence("The inspection photographs were verified on board"))
    const coating = IACS_COATING.find((o) => o.id === str(i, "wbtCoating"))?.phrase
    if (coating) wbt.push(sentence(`The ballast tank coating condition was assessed as ${coating}, as defined by IACS`))
    const wbtFindings = phrases(WBT_FINDINGS, list(i, "wbtFindings"))
    if (wbtFindings.length) wbt.push(sentence(joinClauses(wbtFindings)))

    // 5. Cargo tanks, Class and surveys
    const ct = str(i, "cargoTanks")
    let cargo = sentence(CARGO_TANKS.find((o) => o.id === ct)?.phrase ?? "")
    if (ct === "LAST_INSPECTED") {
      const month = formatMonthYear(str(i, "cargoTanksDate"))
      cargo = month ? sentence(`The cargo tanks were last inspected in ${month}`) : gap("cargo tank inspection date")
    }
    const cap = CAP.find((o) => o.id === str(i, "cap"))?.phrase
    const scope = phrases(CAP_SCOPE, list(i, "capScope"))
    const capText = cap ? sentence(`The vessel holds a ${cap} rating${scope.length ? ` for ${joinList(scope)}` : ""}`) : ""
    const classText = CLASS_STATUS.find((o) => o.id === str(i, "classStatus"))?.phrase
    const from = formatDate(str(i, "annualFrom"))
    const to = formatDate(str(i, "annualTo"))
    const window = from ? sentence(to ? `The next annual survey window is from ${from} to ${to}` : `The next annual survey window opens on ${from}`) : ""
    const ss = formatDate(str(i, "specialSurveyDue"))
    const special = ss ? sentence(`The next Special Survey is due by ${ss}`) : ""

    return [
      para("assessment", "Assessment and hull", [opening, hull]),
      para("underwater", "Underwater hull and propeller", [underwater, uwFindings]),
      para("deck", "Main deck, superstructure and casings", [deck, casing && sentence(casing), ...egcs.map((p) => sentence(p)), loadLine]),
      para("ballast", "Ballast tanks", wbt),
      para("class", "Cargo tanks, Class and surveys", [cargo, capText, classText && sentence(classText), window, special, sentence(str(i, "note"))]),
    ]
  },

  facts: vesselConditionFacts,

  validate(i, ctx, { error, warn }) {
    const { loading } = ctx.vesselCondition
    if (loading === "LADEN" && str(i, "wbtReason") === "BALLASTED" && has(i, "wbtMethod", "NOT_INSPECTED")) {
      warn("narr-structuralCondition-wbtReason", "The Preamble says the vessel was laden, but the ballast tanks are given as ballasted. Check the reason.")
    }
    if (loading === "BALLAST" && str(i, "cargoTanks") === "LOADED") {
      warn("narr-structuralCondition-cargoTanks", "The Preamble says the vessel was in ballast, but the cargo tanks are given as not inspected because she was loaded.")
    }
    const action = deficientItems(ctx, STRUCTURE_KEYS)
    if (isFavourable(str(i, "assessment")) && action.length) {
      warn("narr-structuralCondition-assessment", `The structural condition is favourable while ${itemNames(action)} ${action.length === 1 ? "is" : "are"} rated Deficient. Confirm the assessment.`)
    }
    const hullAction = deficientItems(ctx, HULL_KEYS)
    if (has(i, "hull", "NO_DEFORMATION") && hullAction.length) {
      warn("narr-structuralCondition-hull", "“No deformation or damage” is selected, but the hull is rated Deficient in the Vessel Condition Report.")
    }
    const tankAction = deficientItems(ctx, TANK_KEYS)
    if (str(i, "wbtCoating") === "GOOD" && tankAction.length) {
      warn("narr-structuralCondition-wbtCoating", "Ballast tank coating is GOOD while tanks are rated Deficient in the Vessel Condition Report.")
    }
    const start = ctx.startDate
    const months = monthsSinceUnderwater(i, start)
    if (flag(i, "uwSms") && months !== null && months > 6) {
      warn("narr-structuralCondition-uwDate", "The last underwater inspection was more than six months before this attendance; check the SMS interval.")
    }
    if ((compareIsoDates(str(i, "annualFrom"), str(i, "annualTo")) ?? 0) > 0) {
      error("narr-structuralCondition-annualTo", "The survey window cannot end before it starts.")
    }
    if ((compareIsoDates(str(i, "specialSurveyDue"), start) ?? 1) < 0) {
      warn("narr-structuralCondition-specialSurveyDue", "The Special Survey due date is before this attendance. Check the date.")
    }
    if (str(i, "classStatus") === "COC") {
      warn("narr-structuralCondition-classStatus", "Conditions of Class are outstanding: list them under Significant Problems with their due dates.")
    }
  },
}
