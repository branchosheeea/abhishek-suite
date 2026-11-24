// Vessel Condition Report – Hull structure, coating and hull marking.
// Pattern from past reports: how and from where the hull was examined (launch boat, berth, boarding, dry-dock; loaded
// or ballast) → shell plating above the waterline (deformation, indentation, contact damage and what was done about
// it) → markings → topside coating, antifouling system and marine growth → underwater inspection and propeller
// polishing (shared wording with the Structural summary) → hull performance.
// The text is saved as the Hull item's remarks; the condition rating is chosen separately and cross-checked here.

import { formatMonthYear } from "../dates"
import { cleanFragment, gap, joinClauses, joinList, place, sentence } from "../text"
import { para, type SectionInputs, type SectionSpec } from "../section"
import type { Rating, Report } from "../../form-schema"
import { ageWords, has, list, monthsBetween, phrases, str, vesselConditionFacts } from "./common"
import { vesselConditionFrom } from "../context"
import { normalisePreambleInputs } from "../preamble/model"
import { UNDERWATER_FIELDS, UNDERWATER_KEYS, UW_FINDINGS, monthsSinceUnderwater, underwaterSentences } from "./underwater"

const VANTAGE = [
  { id: "LAUNCH", label: "From a launch boat around the vessel", phrase: "from a launch boat around the vessel" },
  { id: "BERTH", label: "From the berth", phrase: "from the berth" },
  { id: "BOARDING", label: "While boarding (gangway / accommodation ladder)", phrase: "while boarding" },
  { id: "DECK", label: "From the main deck, looking over the side", phrase: "from the main deck, looking over the side" },
  { id: "DRY_DOCK", label: "In dry-dock (whole hull, including the underwater body)", phrase: "in dry-dock" },
] as const

const BERTH_SIDE = [
  { id: "PORT", label: "Port side alongside", phrase: "berthed port side alongside" },
  { id: "STARBOARD", label: "Starboard side alongside", phrase: "berthed starboard side alongside" },
] as const

/** Only asked when the Preamble does not state it; the Preamble's answer is used everywhere else. */
const LOAD = [
  { id: "LADEN", label: "Laden", phrase: "in laden condition" },
  { id: "BALLAST", label: "Ballast", phrase: "in ballast condition" },
] as const

const PLATING = [
  { id: "SOUND", label: "No deformation, indentation or contact damage" },
  { id: "MINOR", label: "Minor indentation within Class allowable limits" },
  { id: "DAMAGE", label: "Indentation / contact damage – assessment required" },
] as const

const DAMAGE_ACTIONS = [
  { id: "CLASS_INFORMED", label: "Classification Society informed", phrase: "the Classification Society has been informed" },
  { id: "CLASS_SURVEYED", label: "Examined by Class – no recommendation", phrase: "the damage was examined by the Classification Society and no recommendation was imposed" },
  { id: "COC", label: "Condition of Class imposed", phrase: "a Condition of Class has been imposed" },
  { id: "MONITOR", label: "Monitored by ship’s staff with dated photographs", phrase: "the area is monitored by the ship’s staff with dated photographs" },
  { id: "REPAIR_PORT", label: "Repair at the next port", phrase: "repairs are planned at the next port" },
  { id: "REPAIR_DD", label: "Permanent repair at the next dry-docking", phrase: "permanent repair is planned at the next dry-docking" },
] as const

const TOPSIDE = [
  { id: "FENDER", label: "Abrasion / coating damage from fender contact", phrase: "abrasion and coating damage from fender contact was noted" },
  { id: "TUG", label: "Coating damage at tug push points", phrase: "coating damage was noted at the tug push points" },
  { id: "RUST_STREAKS", label: "Rust streaks below scuppers / overboard discharges", phrase: "rust streaks were noted below scuppers and overboard discharges" },
  { id: "OPENINGS_OK", label: "Overboard discharges and shell openings in good order", phrase: "overboard discharges and shell openings were in good order" },
] as const

const MARKINGS = [
  { id: "CLEAR", label: "All clearly visible" },
  { id: "TOUCH_UP", label: "Visible – touch-up required" },
  { id: "NOT_LEGIBLE", label: "Not clearly legible – re-marking required" },
] as const

const COATING = [
  { id: "INTACT", label: "Intact – no breakdown" },
  { id: "LOCAL", label: "Local breakdown / spot rust at edges and welds" },
  { id: "WIDESPREAD", label: "Widespread breakdown – recoating required" },
] as const

/**
 * Hull coating damage is repaired on the paint maker's assessment, never by ship's-staff touch-up alone.
 * `maker` marks the options that involve the paint maker (at least one is required).
 */
const COATING_ACTIONS = [
  { id: "MAKER_INSPECT", label: "Paint maker’s representative to inspect and advise", phrase: "the paint maker’s representative will inspect the coating and advise on the repair", maker: true },
  { id: "MAKER_ASSESSED", label: "Paint maker’s assessment received – repairs to follow their recommendation", phrase: "the paint maker has assessed the damage, and repairs will follow their recommendation", maker: true },
  { id: "SPOT_REPAIR", label: "Spot repair by riding squad / shore contractor to the paint maker’s procedure", phrase: "spot repair by a riding squad or shore contractor to the paint maker’s procedure is planned", maker: true, repair: true },
  { id: "DRY_DOCK", label: "Recoating at the next dry-docking, specification agreed with the paint maker", phrase: "recoating is planned at the next dry-docking to a specification agreed with the paint maker", maker: true, repair: true },
  { id: "MONITOR", label: "Monitored under the PMS with dated photographs until repaired", phrase: "the affected areas are monitored under the PMS with dated photographs until repaired", maker: false },
] as const

const COATING_EXTENT = [
  { id: "LT_1", label: "Less than 1% of the area", phrase: "less than 1%" },
  { id: "1_3", label: "1–3% of the area", phrase: "1–3%" },
  { id: "GT_3", label: "More than 3% of the area", phrase: "more than 3%" },
] as const

const coatingBreakdown = (s: Record<string, unknown>) => str(s, "coating") === "LOCAL" || str(s, "coating") === "WIDESPREAD"
/** Coating damage of any kind (breakdown, fender or tug contact) needs the paint maker's assessment. */
const coatingDamage = (s: Record<string, unknown>) => coatingBreakdown(s) || has(s, "topside", "FENDER") || has(s, "topside", "TUG")


const GROWTH = [
  { id: "NONE", label: "No marine growth at the waterline", phrase: "No marine growth was visible at the waterline" },
  { id: "SLIME", label: "Light slime at the boot top", phrase: "Light slime was visible at the boot top" },
  { id: "GROWTH", label: "Weed / barnacle growth at the waterline", phrase: "Weed and barnacle growth was visible at the waterline, indicating fouling of the underwater hull" },
] as const

const PROP_COVERAGE = [
  { id: "25", label: "About 25%" },
  { id: "50", label: "About 50%" },
  { id: "80", label: "About 80%" },
  { id: "100", label: "Fully covered" },
] as const

const PERFORMANCE = [
  { id: "SATISFACTORY", label: "Satisfactory – no charterer’s performance claims", phrase: "Hull performance is monitored and has been satisfactory, with no performance claims from charterers" },
  { id: "DECLINE", label: "Gradual decline – hull cleaning being considered", phrase: "Hull performance monitoring shows a gradual decline, and an underwater hull cleaning is being considered" },
  { id: "CLAIM", label: "Charterer’s performance claim received", phrase: "A charterer’s performance claim has been received and is being addressed" },
] as const

/** "on the port side shell between frames 120 and 125": accepts the location with or without a leading "on" / "at". */
const where = (text: string) => {
  const clean = cleanFragment(text).replace(/^(on|at|in)\s+/i, "")
  return clean ? `on ${clean}` : gap("location")
}

const hullRating = (ctx: { items: { key: string; rating: Rating }[] }) => ctx.items.find((item) => item.key === "hull")?.rating ?? ""

/** Starting selections from the Executive Summary – Structural Condition, so nothing is recorded twice. */
function seedFromStructural(report: Report) {
  const structural = report.narratives?.structuralCondition?.inputs as Record<string, unknown> | undefined
  if (!structural) return {}
  const seed: Record<string, unknown> = {}
  for (const key of UNDERWATER_KEYS) if (structural[key] !== undefined) seed[key] = structural[key]
  const hull = Array.isArray(structural.hull) ? (structural.hull as string[]) : []
  if (hull.includes("NO_DEFORMATION")) seed.plating = "SOUND"
  if (hull.includes("INDENT_WITHIN_LIMITS")) seed.plating = "MINOR"
  if (hull.includes("MARKINGS")) seed.markings = "CLEAR"
  if (hull.includes("FENDER_DAMAGE")) seed.topside = ["FENDER"]
  return seed
}

/** The defect sentences only (no description of what was satisfactory), for the findings register. */
export function hullDefects(i: SectionInputs): string[] {
  const out: string[] = []
  const plating = str(i, "plating")
  if (plating === "MINOR") out.push(sentence(`A minor indentation within Class allowable limits was noted ${where(str(i, "location"))}`))
  if (plating === "DAMAGE") out.push(sentence(`Indentation and contact damage were noted ${where(str(i, "location"))}`))
  const topside = phrases(TOPSIDE, list(i, "topside").filter((o) => o !== "OPENINGS_OK"))
  if (topside.length) out.push(sentence(joinClauses(topside)))
  const markings = str(i, "markings")
  if (markings === "TOUCH_UP") out.push(sentence(`${cleanFragment(str(i, "touchUpDetail")) || "Some hull markings"} require touch-up`))
  if (markings === "NOT_LEGIBLE") out.push(sentence(`${cleanFragment(str(i, "markingsDetail")) || "Some hull markings"} were not clearly legible`))
  const coating = str(i, "coating")
  const extent = COATING_EXTENT.find((o) => o.id === str(i, "coatingExtent"))?.phrase
  const extentText = extent ? `, estimated at ${extent} of the topside area,` : ""
  if (coating === "LOCAL") out.push(sentence(`Local coating breakdown and spot rust${extentText} were noted at edges and welds of the topsides`))
  if (coating === "WIDESPREAD") out.push(sentence(`Widespread breakdown of the topside coating${extentText} was noted`))
  const growth = str(i, "growth")
  if (growth === "GROWTH") out.push(sentence("Weed and barnacle growth was visible at the waterline"))
  if (list(i, "uwFindings").includes("AF_DEGRADED") && str(i, "uwStatus")) out.push(sentence("Antifouling coating degradation was noted at the underwater inspection"))
  return out
}

export const HULL_SECTION: SectionSpec = {
  id: "hullCondition",
  summaryKey: "hullRemarks",
  title: "Hull",
  tab: "Hull",
  heading: "Hull structure, coating and hull marking – remarks",
  description:
    "Builds the Hull remarks from what was seen and how. Underwater details start from the Structural Condition summary; the rating above is chosen separately and checked against this text.",
  target: {
    read: (report) => report.deck?.hull?.remarks ?? "",
    write: (report, text, summary) => ({
      deck: { ...report.deck, hull: { ...report.deck?.hull, rating: report.deck?.hull?.rating ?? "", remarks: text, summary: summary ?? "" } },
    }),
  },
  seed: (report) => {
    const seed = seedFromStructural(report)
    // In dry-dock (per the Preamble) the whole hull is examined in the dock.
    const condition = vesselConditionFrom(normalisePreambleInputs(report.narratives?.preamble?.inputs))
    return condition.situation === "DRY_DOCK" ? { ...seed, vantage: ["DRY_DOCK"] } : seed
  },
  facts: vesselConditionFacts,
  summary: (i) => hullDefects(i).join(" "),
  groups: [
    {
      title: "How the hull was examined",
      fields: [
        { kind: "multi", key: "vantage", label: "Examined", options: VANTAGE, required: true, columns: 2 },
        { kind: "select", key: "berthSide", label: "Side alongside", options: BERTH_SIDE, placeholder: "Not stated", showIf: (s) => has(s, "vantage", "BERTH") },
        {
          kind: "select",
          key: "load",
          label: "Laden or ballast (not stated in the Preamble)",
          options: LOAD,
          placeholder: "Not stated",
          hint: "State it once in the Executive Summary – Preamble and every section uses it.",
          showIf: (s, ctx) => !ctx.vesselCondition.loading && !has(s, "vantage", "DRY_DOCK"),
        },
      ],
    },
    {
      title: "Shell plating above the waterline",
      fields: [
        { kind: "select", key: "plating", label: "Shell plating", options: PLATING, required: true, placeholder: "Select…" },
        {
          kind: "text",
          key: "location",
          label: "Location",
          required: true,
          placeholder: "e.g. the port side shell between frames 120 and 125, about 1 m above the waterline",
          hint: "Written as “… was noted on the port side shell between frames 120 and 125”.",
          showIf: (s) => str(s, "plating") === "MINOR" || str(s, "plating") === "DAMAGE",
          wide: true,
        },
        { kind: "multi", key: "damageActions", label: "Action taken", options: DAMAGE_ACTIONS, required: true, columns: 2, showIf: (s) => str(s, "plating") === "DAMAGE", wide: true },
        { kind: "multi", key: "topside", label: "Other observations", options: TOPSIDE, columns: 2, wide: true },
      ],
    },
    {
      title: "Hull markings",
      fields: [
        {
          kind: "select",
          key: "markings",
          label: "Draught marks, load line mark, name, port of registry and IMO number",
          options: MARKINGS,
          required: true,
          placeholder: "Select…",
          wide: true,
        },
        {
          kind: "text",
          key: "markingsDetail",
          label: "Which markings",
          placeholder: "e.g. the forward draught marks and the IMO number on the stern",
          required: true,
          showIf: (s) => str(s, "markings") === "NOT_LEGIBLE",
          wide: true,
        },
        { kind: "text", key: "touchUpDetail", label: "Which markings (optional)", placeholder: "e.g. the aft draught marks", showIf: (s) => str(s, "markings") === "TOUCH_UP", wide: true },
      ],
    },
    {
      title: "Coating and antifouling",
      fields: [
        {
          kind: "date",
          key: "lastFullPaint",
          label: "Last complete hull painting (full blast and recoat) – month",
          required: true,
          hint: "The reference for judging paint performance. Written as “in March 2024, about 2.5 years before this attendance”.",
        },
        { kind: "text", key: "lastFullPaintPlace", label: "Where (optional)", placeholder: "e.g. COSCO Zhoushan, at the third Special Survey" },
        { kind: "select", key: "coating", label: "Topside and boot-top coating", options: COATING, required: true, placeholder: "Select…" },
        { kind: "select", key: "coatingExtent", label: "Extent of breakdown", options: COATING_EXTENT, required: true, placeholder: "Select…", showIf: coatingBreakdown },
        {
          kind: "multi",
          key: "coatingActions",
          label: "Coating repair (paint maker’s assessment required)",
          options: COATING_ACTIONS,
          required: true,
          columns: 1,
          wide: true,
          tooltip: "Hull coating damage is repaired on the paint maker’s assessment; ship’s-staff touch-up alone is not an acceptable action.",
          showIf: coatingDamage,
        },
        { kind: "text", key: "afSystem", label: "Antifouling system (maker and product)", placeholder: "e.g. Jotun SeaQuantum Classic III" },
        { kind: "date", key: "afApplied", label: "Last antifouling application, if after the complete painting (month)", hint: "Leave empty if the antifouling was applied at the complete painting." },
        { kind: "select", key: "growth", label: "Marine growth at the waterline", options: GROWTH, placeholder: "Not stated" },
      ],
    },
    {
      title: "Underwater hull and propeller",
      description: "Same details as the Structural Condition summary; they start from it when this page is first opened.",
      fields: [
        ...UNDERWATER_FIELDS,
        { kind: "text", key: "uwBy", label: "Diving company (optional)", placeholder: "e.g. Hydrex", showIf: (s) => ["THIS_ATTENDANCE", "PREVIOUS"].includes(str(s, "uwStatus")) },
        {
          kind: "select",
          key: "propCoverage",
          label: "Propeller slime coverage before polishing",
          options: PROP_COVERAGE,
          placeholder: "Not stated",
          showIf: (s) => ["THIS_ATTENDANCE", "PREVIOUS", "IN_DRY_DOCK"].includes(str(s, "uwStatus")) && has(s, "uwFindings", "PROP_POLISHED"),
        },
      ],
    },
    {
      title: "Hull performance",
      fields: [
        { kind: "select", key: "performance", label: "Hull performance", options: PERFORMANCE, placeholder: "Not stated", wide: true },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i, ctx) {
    // 1. How the hull was examined, and the shell plating
    const vantage = list(i, "vantage")
    const dock = vantage.includes("DRY_DOCK")
    const how = phrases(VANTAGE, vantage)
    // Laden / ballast comes from the Preamble; the local answer is only a fallback when the Preamble is silent.
    const loading = dock ? "" : ctx.vesselCondition.loading || str(i, "load")
    const state = [BERTH_SIDE.find((o) => o.id === str(i, "berthSide"))?.phrase, LOAD.find((o) => o.id === loading)?.phrase].filter(Boolean) as string[]
    const examined = how.length
      ? sentence(`The hull${dock ? ", including the underwater body," : " above the waterline"} was examined ${joinList(how)}${state.length ? `, with the vessel ${joinList(state)}` : ""}`)
      : gap("how the hull was examined")
    const plating = str(i, "plating")
    let shell = gap("shell plating")
    if (plating === "SOUND") shell = sentence("The shell plating showed no deformation, indentation or contact damage")
    else if (plating === "MINOR") shell = sentence(`A minor indentation within Class allowable limits was noted ${where(str(i, "location"))}`)
    else if (plating === "DAMAGE") {
      const actions = phrases(DAMAGE_ACTIONS, list(i, "damageActions"))
      shell = [
        sentence(`Indentation and contact damage were noted ${where(str(i, "location"))}`),
        actions.length ? sentence(joinClauses(actions)) : gap("action taken"),
      ].join(" ")
    }
    const topside = phrases(TOPSIDE, list(i, "topside"))

    // 2. Markings
    const markings = str(i, "markings")
    let marks = gap("hull markings")
    if (markings === "CLEAR") marks = sentence("The draught marks, load line mark, vessel’s name, port of registry and IMO number were clearly visible")
    else if (markings === "TOUCH_UP") {
      const which = cleanFragment(str(i, "touchUpDetail"))
      marks = sentence(which ? `The hull markings were visible; ${which} require touch-up by the ship’s staff` : "The hull markings were visible, and some require touch-up by the ship’s staff")
    } else if (markings === "NOT_LEGIBLE") {
      const which = cleanFragment(str(i, "markingsDetail"))
      marks = [
        sentence(`${which || gap("which markings")} were not clearly legible and are to be re-marked`),
        sentence("Legible draught marks and load line mark are required by the International Convention on Load Lines and are checked by Port State Control"),
      ].join(" ")
    }

    // 3. Coating and antifouling
    // The last complete painting comes first: it is the reference for judging the coating's performance.
    const paintedIn = formatMonthYear(str(i, "lastFullPaint"))
    const paintedAt = cleanFragment(str(i, "lastFullPaintPlace"))
    const age = monthsBetween(str(i, "lastFullPaint"), ctx.startDate)
    const lastPaint = paintedIn
      ? sentence(`The last complete painting of the hull was carried out${paintedAt ? ` at ${place(paintedAt)}` : ""} in ${paintedIn}${age !== null && age >= 0 ? `, ${ageWords(age)} before this attendance` : ""}`)
      : gap("last complete hull painting")
    const coating = str(i, "coating")
    const actions = phrases(COATING_ACTIONS, list(i, "coatingActions"))
    const repair = actions.length ? sentence(joinClauses(actions)) : coatingDamage(i) ? gap("coating repair") : ""
    const extent = COATING_EXTENT.find((o) => o.id === str(i, "coatingExtent"))?.phrase
    const extentText = extent ? `, estimated at ${extent} of the topside area,` : gap("extent")
    let coat = gap("coating condition")
    if (coating === "INTACT") coat = sentence("The topside and boot-top coating was intact, with no breakdown")
    else if (coating === "LOCAL") coat = sentence(`Local coating breakdown and spot rust${extentText} were noted at edges and welds of the topsides`)
    else if (coating === "WIDESPREAD") coat = sentence(`Widespread breakdown of the topside coating${extentText} was noted`)
    const af = cleanFragment(str(i, "afSystem"))
    const month = formatMonthYear(str(i, "afApplied"))
    const antifouling = af
      ? sentence(`The underwater hull is coated with ${af} antifouling${month ? `, last applied in ${month}` : ""}`)
      : month
        ? sentence(`The antifouling was last applied in ${month}`)
        : ""
    const growth = GROWTH.find((o) => o.id === str(i, "growth"))?.phrase

    // 4. Underwater hull and propeller (shared wording)
    const coverage = str(i, "propCoverage")
    const findingPhrases = phrases(UW_FINDINGS, list(i, "uwFindings")).map((phrase) =>
      coverage && phrase === UW_FINDINGS.find((f) => f.id === "PROP_POLISHED")?.phrase
        ? coverage === "100"
          ? "the propeller was fully covered with slime and algae, which were removed by polishing"
          : `approximately ${coverage}% of the propeller was covered with slime and algae, which were removed by polishing`
        : phrase,
    )
    const uw = underwaterSentences(i, { by: cleanFragment(str(i, "uwBy")), findingPhrases })

    // 5. Performance
    const performance = PERFORMANCE.find((o) => o.id === str(i, "performance"))?.phrase

    return [
      para("examination", "Examination and shell plating", [examined, shell, topside.length ? sentence(joinClauses(topside)) : ""]),
      para("markings", "Hull markings", [marks]),
      para("coating", "Coating and antifouling", [lastPaint, coat, repair, antifouling, growth && sentence(growth)]),
      para("underwater", "Underwater hull and propeller", [uw.text, uw.findings.length ? sentence(joinClauses(uw.findings)) : ""]),
      para("performance", "Hull performance", [performance && sentence(performance), sentence(str(i, "note"))]),
    ]
  },

  validate(i, ctx, { warn, error }) {
    const id = (key: string) => `narr-hullCondition-${key}`
    const rating = hullRating(ctx)
    const plating = str(i, "plating")
    const markings = str(i, "markings")
    const coating = str(i, "coating")
    const minorDefects = plating === "MINOR" || coating === "LOCAL" || markings === "TOUCH_UP" || list(i, "topside").some((o) => o !== "OPENINGS_OK")
    const serious = plating === "DAMAGE" || coating === "WIDESPREAD" || markings === "NOT_LEGIBLE" || str(i, "growth") === "GROWTH"
    const clean = plating === "SOUND" && markings === "CLEAR" && coating === "INTACT" && !minorDefects && !serious

    // The text and the rating above must tell the same story.
    if (rating === "satisfactory" && minorDefects && !serious) {
      warn(id("plating"), "The hull is rated Satisfactory (no defects), but minor defects are recorded here. Acceptable may be the better rating.")
    }
    if ((rating === "satisfactory" || rating === "acceptable") && serious) {
      warn(id("plating"), `The hull is rated ${rating === "satisfactory" ? "Satisfactory" : "Acceptable"}, but damage, widespread coating breakdown, illegible markings or heavy fouling is recorded here. Confirm the rating.`)
    }
    if ((rating === "degraded" || rating === "deficient") && clean) {
      warn(id("plating"), `The hull is rated ${rating === "degraded" ? "Degraded" : "Deficient"}, but no defect is recorded here. Describe the finding.`)
    }
    if (markings === "NOT_LEGIBLE" && rating !== "deficient") {
      warn(id("markings"), "If the draught marks or load line mark are not legible, a Load Line Convention requirement is not met: rate the hull Deficient.")
    }
    if (plating === "DAMAGE" && !list(i, "damageActions").some((a) => ["CLASS_INFORMED", "CLASS_SURVEYED", "COC"].includes(a))) {
      warn(id("damageActions"), "Hull damage should be reported to the Classification Society. Record that Class was informed or attended.")
    }
    if (!rating) warn(id("vantage"), "Rate the hull above as well: the remarks do not replace the rating.")
    // Consistency with where the vessel was, as stated in the Preamble.
    const { situation } = ctx.vesselCondition
    const vantage = list(i, "vantage")
    if (situation === "DRY_DOCK" && vantage.length && !vantage.includes("DRY_DOCK")) {
      warn(id("vantage"), "The Preamble says the vessel was in dry-dock, but the hull is not recorded as examined in dry-dock.")
    }
    if ((situation === "SEA" || situation === "PORT") && vantage.includes("DRY_DOCK")) {
      warn(id("vantage"), `The Preamble says the vessel was ${situation === "SEA" ? "at sea" : "in port"}, but the hull is recorded as examined in dry-dock.`)
    }
    if (situation === "SEA" && (vantage.includes("BERTH") || vantage.includes("LAUNCH"))) {
      warn(id("vantage"), "The Preamble says the vessel was at sea; examination from the berth or a launch boat needs a port call. Check the selections.")
    }

    // Coating repair needs the paint maker; paint performance is judged against the last complete painting.
    const chosen = list(i, "coatingActions")
    if (coatingDamage(i) && chosen.length && !COATING_ACTIONS.some((o) => o.maker && chosen.includes(o.id))) {
      error(id("coatingActions"), "Coating damage needs the paint maker’s assessment: select at least one paint maker option.")
    }
    if (str(i, "coating") === "WIDESPREAD" && !COATING_ACTIONS.some((o) => "repair" in o && o.repair && chosen.includes(o.id))) {
      warn(id("coatingActions"), "Widespread breakdown needs a planned repair: spot repair by a contractor or recoating at the next dry-docking.")
    }
    const age = monthsBetween(str(i, "lastFullPaint"), ctx.startDate)
    if (age !== null && age < 0) error(id("lastFullPaint"), "The last complete painting cannot be after this inspection.")
    if (age !== null && age > 60) {
      warn(id("lastFullPaint"), "The hull was last completely painted more than five years ago, beyond a typical 60-month antifouling service life. Check the antifouling specification and the dry-docking plan.")
    }
    if (age !== null && age >= 0 && age < 24 && (coatingBreakdown(i) || has(i, "uwFindings", "AF_DEGRADED"))) {
      warn(id("lastFullPaint"), "Breakdown on a coating applied less than two years ago may be a paint failure: consider a claim under the paint maker’s warranty.")
    }
    const afOrder = monthsBetween(str(i, "lastFullPaint"), str(i, "afApplied"))
    if (afOrder !== null && afOrder < 0) warn(id("afApplied"), "The antifouling application is dated before the last complete painting. Check the dates.")

    const months = monthsSinceUnderwater(i, ctx.startDate)
    if (months !== null && months > 6) {
      warn(id("uwDate"), "The last underwater inspection was more than six months before this attendance; check the SMS interval.")
    }

    // Consistency with the Executive Summary – Structural Condition.
    const structural = ctx.sectionInputs.structuralCondition
    if (structural) {
      const s = (key: string) => (typeof structural[key] === "string" ? (structural[key] as string) : "")
      if (s("uwStatus") && str(i, "uwStatus") && (s("uwStatus") !== str(i, "uwStatus") || s("uwDate") !== str(i, "uwDate") || s("uwPlace").trim() !== str(i, "uwPlace"))) {
        warn(id("uwStatus"), "The underwater inspection details differ from the Executive Summary – Structural Condition. Make them the same.")
      }
      const hull = Array.isArray(structural.hull) ? (structural.hull as string[]) : []
      if (hull.includes("NO_DEFORMATION") && (plating === "MINOR" || plating === "DAMAGE")) {
        warn(id("plating"), "The Structural Condition summary states no deformation or damage, but an indentation is recorded here.")
      }
    }
  },
}
