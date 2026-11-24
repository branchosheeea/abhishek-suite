// Vessel Condition Report – Weather deck (Main Deck page).
// Pattern from past reports (01, 05, 07, 09 are the fullest): areas covered → deck plating and rust → painting programme
// (progress, remaining areas, delay, planned completion, paint stock, equipment) → pipelines and supports → walkways →
// PV valves, PV breaker, deck seal and mast riser → hydraulic lines → rust weeping at fittings → accommodation
// exterior, engine casing and funnel. Pollution prevention on deck (scupper plugs, save-alls, spill equipment) and cargo
// line bonding are added: past reports omit them, but Port State Control, SIRE 2.0 and TMSA inspectors check them.
// Deck painting by the ship's staff is normal maintenance; the paint maker is involved for a coating failure.

import { compareIsoDates, formatDate, formatMonthYear } from "../dates"
import { cleanFragment, gap, joinClauses, joinList, sentence } from "../text"
import { para, type SectionInputs, type SectionSpec } from "../section"
import type { Rating, Report } from "../../form-schema"
import { ageWords, has, items, list, monthsBetween, phrases, str, vesselConditionFacts } from "./common"
import { CASING, DECK_RUST, EGCS_TOWER } from "./structural"

const AREAS = [
  { id: "MAIN", label: "Main deck", phrase: "the main deck" },
  { id: "FORECASTLE", label: "Forecastle deck", phrase: "the forecastle deck" },
  { id: "POOP", label: "Poop deck", phrase: "the poop deck" },
  { id: "UNDER_PIPES", label: "Under the pipe racks", phrase: "the areas under the pipe racks" },
] as const

const STRUCTURE = [
  { id: "SOUND", label: "Structurally sound – no buckling, cracking or wastage" },
  { id: "DEFECT", label: "Local wastage or deformation found" },
] as const

const STRUCTURE_ACTIONS = [
  { id: "CLASS_INFORMED", label: "Classification Society informed", phrase: "the Classification Society has been informed" },
  { id: "THICKNESS", label: "Thickness measurements arranged", phrase: "thickness measurements have been arranged" },
  { id: "REPAIR_PORT", label: "Repair at the next port", phrase: "repairs are planned at the next port" },
  { id: "REPAIR_DD", label: "Repair at the next dry-docking", phrase: "permanent repair is planned at the next dry-docking" },
  { id: "MONITOR", label: "Monitored with dated photographs", phrase: "the area is monitored by the ship’s staff with dated photographs" },
] as const

/** Deck coating condition on the IACS scale (as used for ballast tanks), so trends are comparable across the fleet. */
const COATING_CONDITION = [
  { id: "GOOD", label: "GOOD – only minor spot rusting" },
  { id: "FAIR", label: "FAIR – local breakdown at edges / welds, or light rusting over 20% or more" },
  { id: "POOR", label: "POOR – general breakdown over 20% or more, or hard scale over 10% or more" },
] as const

const COATING_DEFECTS = [
  { id: "EDGES", label: "Breakdown at edges and welds", phrase: "local breakdown at edges and welds", breakdown: true },
  { id: "UNDER_SUPPORTS", label: "Breakdown under pipe supports and fittings", phrase: "breakdown under pipe supports and fittings", breakdown: true },
  { id: "BLISTERING", label: "Blistering", phrase: "blistering", early: true },
  { id: "FLAKING", label: "Flaking / detachment", phrase: "flaking and detachment of the coating", breakdown: true, early: true },
  { id: "CHALKING", label: "Chalking (UV degradation of the finish coat)", phrase: "chalking of the finish coat", early: true },
  { id: "MECHANICAL", label: "Mechanical damage (mooring areas, stores handling)", phrase: "mechanical damage in the mooring and stores-handling areas" },
  { id: "ANTISKID", label: "Worn anti-skid / walkway coating", phrase: "worn anti-skid coating on the walkways" },
] as const

const PAINTING = [
  { id: "NONE", label: "No painting programme in progress" },
  { id: "FULL_COAT", label: "Full-coat painting in progress (deck, pipelines and fittings)" },
  { id: "SPOT", label: "Spot painting / touch-up in progress" },
  { id: "COMPLETED", label: "Full-coat painting completed" },
  { id: "FAILURE", label: "Premature coating failure – paint maker asked to assess" },
] as const

const SURFACE_PREP = [
  { id: "POWER_TOOL", label: "Power-tool cleaning (St 2 / St 3)", phrase: "power-tool cleaning to St 2 / St 3" },
  { id: "SPOT_BLAST", label: "Spot blasting (Sa 2½)", phrase: "spot blasting to Sa 2½" },
  { id: "HYDRO", label: "Hydro-blasting", phrase: "hydro-blasting" },
] as const

const DISCUSSED_WITH = [
  { id: "CO", label: "Chief Officer", phrase: "the Chief Officer" },
  { id: "BOSUN", label: "Bosun", phrase: "the Bosun" },
  { id: "CREW", label: "Deck crew", phrase: "the deck crew" },
] as const

const PAINT_TRAINING = [
  { id: "ADEQUATE", label: "Crew familiar with the paint maker’s specification", phrase: "The crew were found familiar with surface preparation and application to the paint maker’s specification" },
  { id: "REFRESHER_ONBOARD", label: "Refresher training on board by the Chief Officer", phrase: "Refresher training in surface preparation and application is to be given on board by the Chief Officer" },
  { id: "REFRESHER_MAKER", label: "Training by the paint maker’s representative to be arranged", phrase: "Training of the deck crew by the paint maker’s representative is to be arranged" },
] as const

const PREV_STATUS = [
  { id: "NONE_RAISED", label: "No deck findings were raised", phrase: "No deck findings were raised at the previous inspection" },
  { id: "ALL_CLOSED", label: "All closed – verified on board", phrase: "All deck findings of the previous inspection have been closed and were verified on board" },
  { id: "SOME_OPEN", label: "Some remain open", phrase: "" },
  { id: "NOT_AVAILABLE", label: "Previous report not available", phrase: "The previous inspection report was not available, so the status of its deck findings could not be verified" },
] as const

const PREV_ITEM_STATUS = [
  { id: "OPEN", label: "Open (within its due date)", phrase: "open" },
  { id: "OVERDUE", label: "Overdue", phrase: "overdue" },
] as const

const VERIFIED_BY = [
  { id: "SIGHTED", label: "Sighted", phrase: "sighted during the attendance" },
  { id: "TESTED", label: "Function-tested during the attendance", phrase: "verified by function test during the attendance" },
  { id: "RECORDS", label: "PMS records reviewed", phrase: "verified from the PMS records" },
] as const

const TANK_OPENINGS = [
  { id: "SECURED", label: "Secured – no vapour leakage", phrase: "Ullage and sounding plugs, Butterworth covers and tank lids were secured with all fastenings, with no vapour leakage" },
  { id: "DEFECT", label: "Not secured / vapour leakage", phrase: "" },
] as const

const EX_EQUIPMENT = [
  { id: "OK", label: "Intact – cables and trays secured", phrase: "Ex-rated deck lights, junction boxes and cable glands in the hazardous areas were intact, and cables and cable trays were secured" },
  { id: "DEFECT", label: "Defects found", phrase: "" },
] as const

const WEATHERTIGHT = [
  { id: "OK", label: "Close properly – dogs, gaskets, hinges in order", phrase: "Weathertight doors and hatches, including the forecastle and bosun stores, deckhouses and the emergency fire pump room, closed properly, with their dogs, gaskets and hinges in order" },
  { id: "DEFECT", label: "Defects found", phrase: "" },
] as const

const CLOSURE_ACTIONS = [
  { id: "REPAIRED", label: "Repaired during the attendance", phrase: "this was rectified during the attendance" },
  { id: "ISOLATED", label: "Isolated / secured; spares ordered", phrase: "the item has been isolated or secured and spares have been ordered" },
  { id: "PLANNED", label: "Repair planned", phrase: "repair has been planned" },
] as const

const TEMP_TYPES = [
  { id: "DOUBLER", label: "Doubler plate", phrase: "a doubler plate" },
  { id: "CEMENT_BOX", label: "Cement box", phrase: "a cement box" },
  { id: "PIPE_CLAMP", label: "Pipe clamp / sleeve", phrase: "a pipe clamp" },
  { id: "OTHER", label: "Other", phrase: "a temporary repair" },
] as const

const TEMP_CLASS = [
  { id: "INFORMED", label: "Class informed – accepted", phrase: "accepted by the Classification Society" },
  { id: "COC", label: "Condition of Class imposed", phrase: "under a Condition of Class" },
  { id: "NOT_INFORMED", label: "Class not informed", phrase: "not yet reported to the Classification Society" },
] as const

const TEMP_PERMANENT = [
  { id: "NEXT_PORT", label: "Permanent repair at the next port", phrase: "permanent repair at the next port" },
  { id: "NEXT_DD", label: "Permanent repair at the next dry-docking", phrase: "permanent repair at the next dry-docking" },
] as const

const DELAY = [
  { id: "WEATHER", label: "Inclement weather", phrase: "inclement weather" },
  { id: "CARGO_OPS", label: "Cargo operations schedule", phrase: "the cargo operations schedule" },
  { id: "MANPOWER", label: "Other priority work", phrase: "other priority maintenance work" },
] as const

const COMPLETION = [
  { id: "NEXT_BALLAST", label: "During the next ballast leg", phrase: "during the next ballast leg" },
  { id: "NEXT_LADEN", label: "During the next laden leg", phrase: "during the next laden leg" },
  { id: "THIS_VOYAGE", label: "During the present voyage", phrase: "during the present voyage" },
  { id: "BY_DATE", label: "By a date", phrase: "" },
] as const

const EQUIPMENT = [
  { id: "GRIT", label: "Mini grit blaster", phrase: "a mini grit blaster" },
  { id: "SPRAY", label: "Airless paint spray machine", phrase: "an airless paint spray machine" },
  { id: "HYDRO", label: "Hydro blaster", phrase: "a hydro blaster" },
  { id: "DFT", label: "DFT gauge", phrase: "a DFT gauge" },
] as const

const PIPES = [
  { id: "RUST_FREE", label: "Pipelines and supports free of rust", phrase: "the pipelines and supports were free of rust" },
  { id: "TEFLON", label: "On Teflon pads with Teflon-coated clamps", phrase: "the pipelines were supported on Teflon pads with Teflon-coated clamps" },
  { id: "STACKS", label: "Pipe stacks (cargo, IG, steam, air, hydraulic) and cable trays in order", phrase: "the cargo, inert gas, steam, air and hydraulic pipe stacks and the cable trays were in good order" },
  { id: "SUPPORT_CORROSION", label: "Corrosion on pipe supports / U-bolts", phrase: "" },
  { id: "PIPE_WASTAGE", label: "Pipe wastage or pitting found", phrase: "" },
] as const

const PIPE_ACTIONS = [
  { id: "RENEWAL", label: "Pipe section renewal planned", phrase: "renewal of the affected section is planned" },
  { id: "TEMPORARY", label: "Temporary repair made; renewal planned", phrase: "a temporary repair has been made and renewal of the section is planned" },
  { id: "MONITOR", label: "Monitored with thickness readings", phrase: "the section is monitored with thickness readings" },
] as const

const SAFETY = [
  { id: "WALKWAYS", label: "Walkways marked, with anti-skid coating", phrase: "the port and starboard walkways were clearly marked and coated with anti-skid paint" },
  { id: "BONDING", label: "Cargo line bonding straps in place", phrase: "the cargo line bonding straps were in place" },
  { id: "SCUPPERS", label: "Scupper plugs in place / readily available", phrase: "the scupper plugs were in place and readily available" },
  { id: "SAVEALLS", label: "Save-alls and drip trays clean and drained", phrase: "the save-alls and drip trays were clean and drained" },
  { id: "SPILL", label: "Deck spill equipment (SOPEP locker) fully stocked", phrase: "the deck oil spill equipment in the SOPEP locker was fully stocked" },
] as const

/** Deficiencies, each the counterpart of a SAFETY item (they cannot both be selected). */
const SAFETY_DEFECTS = [
  { id: "WALKWAYS", label: "Anti-skid worn on parts of the walkways", phrase: "the anti-skid coating was worn on parts of the walkways" },
  { id: "BONDING", label: "Bonding straps missing or damaged", phrase: "cargo line bonding straps were missing or damaged" },
  { id: "SCUPPERS", label: "Scupper plugs missing / not available", phrase: "scupper plugs were missing or not readily available" },
  { id: "SAVEALLS", label: "Oil or water in save-alls / drip trays", phrase: "oil and water had collected in save-alls and drip trays" },
  { id: "SPILL", label: "Spill equipment short of inventory", phrase: "the deck oil spill equipment was short of its inventory" },
] as const

const VENTING = [
  { id: "PV_OK", label: "PV valves inspected – no leakage", phrase: "the PV valves were inspected and found free of leakage" },
  { id: "BREAKER", label: "PV breaker liquid level correct", phrase: "the PV breaker liquid level was correct" },
  { id: "DECK_SEAL", label: "Deck seal in order", phrase: "the deck seal was in order" },
  { id: "MAST_RISER", label: "Mast riser in order", phrase: "the mast riser was in order" },
  { id: "FLAME_SCREENS", label: "Flame screens and high-velocity vents clean and intact", phrase: "the flame screens and high-velocity vents were clean and intact" },
  { id: "SEAL_ALARM", label: "Deck seal water level and low-level alarm tested", phrase: "the deck seal water level and its low-level alarm were tested satisfactorily" },
  { id: "PV_DERUST", label: "PV valves need de-rusting (cosmetic)", phrase: "" },
  { id: "PV_LEAK", label: "PV valve passing / leaking", phrase: "" },
] as const

const HYDRAULIC = [
  { id: "NO_LEAKS", label: "No leaks", phrase: "The hydraulic lines for the deck machinery and the valve remote-control system were free of leaks" },
  { id: "SPOT_RUST", label: "No leaks; spot rust on operating blocks", phrase: "The hydraulic lines were free of leaks; spot rust on some operating blocks and lines is to be de-rusted and painted" },
  { id: "LEAKS", label: "Leaks found", phrase: "" },
] as const

const WEEPING = [
  { id: "DOMES", label: "Tank domes", phrase: "tank domes" },
  { id: "MANHOLES", label: "Ballast tank manholes", phrase: "ballast tank manholes" },
  { id: "LIGHT_MASTS", label: "Light masts", phrase: "light masts" },
  { id: "DECKHOUSES", label: "Deck houses", phrase: "deck houses" },
] as const

const ACCOMMODATION = [
  { id: "GOOD", label: "Good condition", phrase: "The accommodation block exterior was in good condition" },
  { id: "SPOT", label: "Spot rust (e.g. bridge wings) – in maintenance plan", phrase: "Spot rust on the accommodation block exterior, including under the bridge wings, has been included in the maintenance plan" },
] as const

const painting = (s: Record<string, unknown>) => str(s, "painting")
const inProgress = (s: Record<string, unknown>) => painting(s) === "FULL_COAT" || painting(s) === "SPOT"
const where = (text: string) => {
  const clean = cleanFragment(text).replace(/^(on|at|in)\s+/i, "")
  return clean ? `at ${clean}` : gap("location")
}
/** " (verified by function test during the attendance)" etc., or "" when not stated. */
const verified = (i: SectionInputs, key: string) => {
  const how = VERIFIED_BY.find((o) => o.id === str(i, key))?.phrase
  return how ? `, ${how}` : ""
}

const weatherDeckRating = (ctx: { items: { key: string; rating: Rating }[] }) => ctx.items.find((item) => item.key === "weatherDeck")?.rating ?? ""

/** When the deck was last fully coated: the completed painting month, or the date entered. */
const coatingDate = (i: SectionInputs) => (str(i, "painting") === "COMPLETED" ? str(i, "completedIn") : str(i, "lastDeckCoating"))

/** Surface preparation and DFT: whether the crew's painting follows the paint maker's specification. */
function paintQuality(i: SectionInputs) {
  const prep = SURFACE_PREP.find((o) => o.id === str(i, "surfacePrep"))?.phrase
  const dft = i.dftRecorded === true
  if (!prep && !dft) return []
  if (prep && dft) return [sentence(`Surfaces are prepared by ${prep}, and DFT readings are recorded against the paint maker’s specification`)]
  return [sentence(prep ? `Surfaces are prepared by ${prep}` : "DFT readings are recorded against the paint maker’s specification")]
}

/** The defect sentences only, for the findings register. */
export function mainDeckDefects(i: SectionInputs): string[] {
  const out: string[] = []
  if (str(i, "structure") === "DEFECT") out.push(sentence(`Local wastage or deformation of the deck plating was noted ${where(str(i, "structureWhere"))}`))
  const condition = str(i, "coatingCondition")
  const breakdown = phrases(
    COATING_DEFECTS.filter((o) => "breakdown" in o || "early" in o),
    list(i, "coatingDefects"),
  )
  if (condition === "POOR" || (condition === "FAIR" && breakdown.length)) {
    out.push(sentence(`The deck coating was assessed as ${condition}, as defined by IACS${breakdown.length ? `, with ${joinList(breakdown)}` : ""}`))
  }
  if (["SCATTERED", "SIGNIFICANT"].includes(str(i, "deckRust"))) out.push(sentence(DECK_RUST.find((o) => o.id === str(i, "deckRust"))!.phrase))
  if (painting(i) === "FAILURE") out.push(sentence("Premature breakdown of the deck coating was noted"))
  if (has(i, "pipes", "SUPPORT_CORROSION")) out.push(sentence(`Corrosion of pipe supports and U-bolts was noted ${where(str(i, "supportWhere"))}`))
  if (has(i, "pipes", "PIPE_WASTAGE")) out.push(sentence(`Wastage of a pipeline was noted ${where(str(i, "wastageWhere"))}`))
  const safety = phrases(SAFETY_DEFECTS, list(i, "safetyDefects"))
  if (safety.length) out.push(sentence(joinClauses(safety)))
  if (has(i, "venting", "PV_LEAK")) out.push(sentence(`A PV valve was found passing ${where(str(i, "pvLeakWhere"))}`))
  if (str(i, "hydraulic") === "LEAKS") out.push(sentence(`Hydraulic oil leaks were found ${where(str(i, "hydraulicWhere"))}`))
  if (str(i, "tankOpenings") === "DEFECT") out.push(sentence(`Tank openings were found not secured or leaking vapour ${where(str(i, "tankOpeningsWhere"))}`))
  if (str(i, "exEquipment") === "DEFECT") out.push(sentence(`Defective Ex-rated electrical equipment was found ${where(str(i, "exEquipmentWhere"))}`))
  if (str(i, "weathertight") === "DEFECT") out.push(sentence(`Defective weathertight closures were found ${where(str(i, "weathertightWhere"))}`))
  if (str(i, "tempRepairs") === "PRESENT") {
    const list = items(i, "tempItems").map((t) => `${TEMP_TYPES.find((o) => o.id === t.type)?.phrase ?? "a temporary repair"} ${where(String(t.where ?? ""))}`)
    if (list.length) out.push(sentence(`Temporary repairs on deck: ${joinList(list)}`))
  }
  return out
}

function seedFromStructural(report: Report) {
  const s = report.narratives?.structuralCondition?.inputs as Record<string, unknown> | undefined
  if (!s) return {}
  const seed: Record<string, unknown> = {}
  if (typeof s.deckRust === "string" && s.deckRust) seed.deckRust = s.deckRust
  if (typeof s.casing === "string" && s.casing) seed.casing = s.casing
  if (Array.isArray(s.egcs)) seed.egcs = s.egcs
  const deck = Array.isArray(s.deck) ? (s.deck as string[]) : []
  if (deck.includes("NO_CORROSION")) {
    seed.structure = "SOUND"
    seed.pipes = ["RUST_FREE"]
  }
  if (deck.includes("PIPE_CORROSION")) seed.pipes = [...((seed.pipes as string[]) ?? []).filter((p) => p !== "RUST_FREE"), "SUPPORT_CORROSION"]
  if (deck.includes("MANHOLE_WEEPING")) seed.weeping = ["DOMES", "MANHOLES"]
  return seed
}

export const MAIN_DECK_SECTION: SectionSpec = {
  id: "mainDeckCondition",
  summaryKey: "weatherDeckRemarks",
  title: "Main Deck",
  tab: "Main Deck",
  heading: "Weather deck – remarks",
  description:
    "Builds the Weather deck remarks from what was seen: plating, painting programme, pipelines, safety and pollution prevention, venting and inert gas. Deck rust, casing and EGCS start from the Structural Condition summary.",
  target: {
    read: (report) => report.deck?.weatherDeck?.remarks ?? "",
    write: (report, text, summary) => ({
      deck: { ...report.deck, weatherDeck: { ...report.deck?.weatherDeck, rating: report.deck?.weatherDeck?.rating ?? "", remarks: text, summary: summary ?? "" } },
    }),
  },
  seed: seedFromStructural,
  facts: vesselConditionFacts,
  summary: (i) => mainDeckDefects(i).join(" "),
  groups: [
    {
      title: "Previous inspection’s deck findings",
      description: "Closing the loop (ISM Code 10): the status of what the last inspection found on deck.",
      fields: [
        { kind: "select", key: "prevStatus", label: "Status of the previous inspection’s deck findings", options: PREV_STATUS, placeholder: "Not stated", wide: true },
        {
          kind: "items",
          key: "prevOpen",
          label: "Findings still open",
          itemLabel: "Open finding",
          addLabel: "Add open finding",
          max: 10,
          required: true,
          showIf: (s) => str(s, "prevStatus") === "SOME_OPEN",
          fields: [
            { kind: "text", key: "finding", label: "Finding", required: true, placeholder: "e.g. corrosion of the IG line supports in way of No. 2 COT", wide: true },
            { kind: "select", key: "status", label: "Status", required: true, options: PREV_ITEM_STATUS, placeholder: "Select…" },
            { kind: "date", key: "revisedDue", label: "Revised due date (optional)" },
          ],
        },
      ],
    },
    {
      title: "Deck plating",
      fields: [
        { kind: "multi", key: "areas", label: "Areas inspected", options: AREAS, required: true, columns: 2, wide: true },
        { kind: "select", key: "structure", label: "Deck plating structure", options: STRUCTURE, required: true, placeholder: "Select…" },
        { kind: "select", key: "deckRust", label: "Rust on deck", options: DECK_RUST, required: true, placeholder: "Select…" },
        {
          kind: "text",
          key: "structureWhere",
          label: "Where",
          required: true,
          placeholder: "e.g. the deck plating in way of No. 3 COT, port side",
          showIf: (s) => str(s, "structure") === "DEFECT",
          wide: true,
        },
        { kind: "multi", key: "structureActions", label: "Action taken", options: STRUCTURE_ACTIONS, required: true, columns: 2, showIf: (s) => str(s, "structure") === "DEFECT", wide: true },
      ],
    },
    {
      title: "Deck coating condition",
      fields: [
        {
          kind: "select",
          key: "coatingCondition",
          label: "Deck coating condition (IACS)",
          options: COATING_CONDITION,
          required: true,
          placeholder: "Select…",
          tooltip:
            "IACS coating condition: GOOD – only minor spot rusting; FAIR – local breakdown at edges of stiffeners and weld connections and/or light rusting over 20% or more of the area, less than POOR; POOR – general breakdown over 20% or more, or hard scale over 10% or more of the area.",
          wide: true,
        },
        { kind: "multi", key: "coatingDefects", label: "Type of breakdown", options: COATING_DEFECTS, columns: 2, wide: true },
        {
          kind: "date",
          key: "lastDeckCoating",
          label: "Last full coating of the deck (month)",
          hint: "Written with the coating’s age, e.g. “in March 2024, about 2.5 years before this attendance”.",
          showIf: (s) => str(s, "painting") !== "COMPLETED",
        },
      ],
    },
    {
      title: "Painting programme",
      fields: [
        { kind: "text", key: "paintSystem", label: "Deck paint in use (maker and product)", placeholder: "e.g. Jotun Jotamastic 87 with Hardtop XP finish", wide: true },
        { kind: "select", key: "painting", label: "Deck painting", options: PAINTING, required: true, placeholder: "Select…", wide: true },
        {
          kind: "text",
          key: "completedSections",
          label: "Sections completed",
          required: true,
          placeholder: "e.g. the deck in way of Nos. 1–3 COTs and the forecastle",
          showIf: (s) => painting(s) === "FULL_COAT",
          wide: true,
        },
        { kind: "text", key: "remaining", label: "Remaining areas", placeholder: "e.g. the deck in way of COTs 4P/C/S", showIf: inProgress, wide: true },
        { kind: "select", key: "surfacePrep", label: "Surface preparation", options: SURFACE_PREP, placeholder: "Not stated", showIf: (s) => inProgress(s) || painting(s) === "COMPLETED" },
        {
          kind: "confirm",
          key: "dftRecorded",
          label: "DFT readings recorded against the paint maker’s specification",
          showIf: (s) => inProgress(s) || painting(s) === "COMPLETED",
        },
        { kind: "select", key: "delay", label: "Delayed by (if behind plan)", options: DELAY, placeholder: "Not delayed", showIf: inProgress },
        { kind: "select", key: "completion", label: "Planned completion", options: COMPLETION, required: true, placeholder: "Select…", showIf: inProgress },
        { kind: "date", key: "completionBy", label: "Completion by", required: true, showIf: (s) => inProgress(s) && str(s, "completion") === "BY_DATE" },
        { kind: "date", key: "completedIn", label: "Completed in (month)", required: true, showIf: (s) => painting(s) === "COMPLETED" },
        { kind: "confirm", key: "paintStock", label: "Sufficient paint on board to complete the work", showIf: inProgress },
        {
          kind: "multi",
          key: "discussedWith",
          label: "Painting scope discussed with",
          options: DISCUSSED_WITH,
          tooltip: "To confirm the crew understand the work and to ascertain the training they have received.",
        },
        { kind: "select", key: "paintTraining", label: "Crew training", options: PAINT_TRAINING, required: true, placeholder: "Select…", showIf: (s) => list(s, "discussedWith").length > 0, wide: true },
        { kind: "confirm", key: "dataSheets", label: "Paint maker’s technical data sheets / application guidelines available on board" },
        { kind: "multi", key: "equipment", label: "Deck maintenance equipment on board and working", options: EQUIPMENT, columns: 2, wide: true },
      ],
    },
    {
      title: "Pipelines and supports",
      fields: [
        { kind: "multi", key: "pipes", label: "Pipelines and supports", options: PIPES, required: true, columns: 1, wide: true },
        { kind: "text", key: "supportWhere", label: "Supports / U-bolts – where", required: true, placeholder: "e.g. the IG line supports in way of No. 2 COT", showIf: (s) => has(s, "pipes", "SUPPORT_CORROSION"), wide: true },
        { kind: "text", key: "wastageWhere", label: "Pipe wastage – where", required: true, placeholder: "e.g. the stripping line near the starboard manifold", showIf: (s) => has(s, "pipes", "PIPE_WASTAGE"), wide: true },
        { kind: "select", key: "pipeAction", label: "Pipe wastage – action", options: PIPE_ACTIONS, required: true, placeholder: "Select…", showIf: (s) => has(s, "pipes", "PIPE_WASTAGE") },
      ],
    },
    {
      title: "Safety and pollution prevention on deck",
      fields: [
        { kind: "multi", key: "safety", label: "In order", options: SAFETY, columns: 1, wide: true },
        { kind: "multi", key: "safetyDefects", label: "Deficiencies", options: SAFETY_DEFECTS, columns: 1, wide: true },
        { kind: "select", key: "verifyBonding", label: "Bonding straps – verified by", options: VERIFIED_BY, placeholder: "Not stated", showIf: (s) => has(s, "safety", "BONDING") },
      ],
    },
    {
      title: "Venting and inert gas",
      fields: [
        { kind: "multi", key: "venting", label: "PV valves, PV breaker, deck seal, mast riser", options: VENTING, required: true, columns: 2, wide: true },
        { kind: "text", key: "pvLeakWhere", label: "Passing PV valve – which tank", required: true, placeholder: "e.g. No. 5 COT (S)", showIf: (s) => has(s, "venting", "PV_LEAK") },
        { kind: "select", key: "verifyPv", label: "PV valves – verified by", options: VERIFIED_BY, placeholder: "Not stated", showIf: (s) => has(s, "venting", "PV_OK") },
        { kind: "select", key: "verifyDeckSeal", label: "Deck seal – verified by", options: VERIFIED_BY, placeholder: "Not stated", showIf: (s) => has(s, "venting", "DECK_SEAL") },
        { kind: "date", key: "pvLastMaintenance", label: "Last PV valve maintenance under the PMS (month)", hint: "Written as “in August 2026”." },
        { kind: "select", key: "tankOpenings", label: "Tank openings (ullage / sounding plugs, Butterworth covers, lids)", options: TANK_OPENINGS, placeholder: "Not stated", wide: true },
        { kind: "text", key: "tankOpeningsWhere", label: "Tank openings – where", required: true, placeholder: "e.g. the Butterworth cover of No. 3 COT (P)", showIf: (s) => str(s, "tankOpenings") === "DEFECT", wide: true },
      ],
    },
    {
      title: "Electrical equipment and weathertight closures",
      fields: [
        { kind: "select", key: "exEquipment", label: "Ex-rated lights, junction boxes, cable glands (hazardous areas)", options: EX_EQUIPMENT, placeholder: "Not stated", wide: true },
        { kind: "text", key: "exEquipmentWhere", label: "Ex equipment – where", required: true, placeholder: "e.g. the deck light junction box at the starboard manifold", showIf: (s) => str(s, "exEquipment") === "DEFECT", wide: true },
        { kind: "select", key: "exEquipmentAction", label: "Ex equipment – action", options: CLOSURE_ACTIONS, required: true, placeholder: "Select…", showIf: (s) => str(s, "exEquipment") === "DEFECT" },
        { kind: "select", key: "weathertight", label: "Weathertight doors and hatches", options: WEATHERTIGHT, placeholder: "Not stated", wide: true },
        { kind: "text", key: "weathertightWhere", label: "Weathertight closures – where", required: true, placeholder: "e.g. the bosun store door: two dogs seized, gasket hardened", showIf: (s) => str(s, "weathertight") === "DEFECT", wide: true },
        { kind: "select", key: "weathertightAction", label: "Weathertight closures – action", options: CLOSURE_ACTIONS, required: true, placeholder: "Select…", showIf: (s) => str(s, "weathertight") === "DEFECT" },
      ],
    },
    {
      title: "Temporary repairs on deck",
      fields: [
        {
          kind: "select",
          key: "tempRepairs",
          label: "Temporary repairs (doublers, cement boxes, pipe clamps)",
          options: [
            { id: "NONE", label: "None found" },
            { id: "PRESENT", label: "Present" },
          ],
          placeholder: "Not stated",
          wide: true,
        },
        {
          kind: "items",
          key: "tempItems",
          label: "Temporary repairs",
          itemLabel: "Temporary repair",
          addLabel: "Add temporary repair",
          max: 10,
          required: true,
          showIf: (s) => str(s, "tempRepairs") === "PRESENT",
          fields: [
            { kind: "select", key: "type", label: "Type", required: true, options: TEMP_TYPES, placeholder: "Select…" },
            { kind: "text", key: "where", label: "Where", required: true, placeholder: "e.g. the stripping line near No. 4 COT (S)", wide: true },
            { kind: "select", key: "classStatus", label: "Class", required: true, options: TEMP_CLASS, placeholder: "Select…" },
            { kind: "select", key: "permanent", label: "Permanent repair", required: true, options: TEMP_PERMANENT, placeholder: "Select…" },
          ],
        },
      ],
    },
    {
      title: "Hydraulic lines and fittings",
      fields: [
        { kind: "select", key: "hydraulic", label: "Hydraulic lines (deck machinery, valve remote control)", options: HYDRAULIC, required: true, placeholder: "Select…", wide: true },
        { kind: "text", key: "hydraulicWhere", label: "Leaks – where", required: true, placeholder: "e.g. the forward mooring winch hydraulic supply line", showIf: (s) => str(s, "hydraulic") === "LEAKS", wide: true },
        { kind: "multi", key: "weeping", label: "Rust weeping at", options: WEEPING, columns: 2, wide: true },
      ],
    },
    {
      title: "Accommodation exterior, engine casing and funnel",
      description: "Starts from the Structural Condition summary when this page is first opened.",
      fields: [
        { kind: "select", key: "accommodation", label: "Accommodation block exterior", options: ACCOMMODATION, placeholder: "Not stated" },
        { kind: "select", key: "casing", label: "Engine casing and funnel", options: CASING, placeholder: "Not stated" },
        { kind: "multi", key: "egcs", label: "EGCS tower (if fitted)", options: EGCS_TOWER },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i, ctx) {
    // 0. Previous inspection's deck findings (closing the loop)
    const prev = str(i, "prevStatus")
    let previous = PREV_STATUS.find((o) => o.id === prev)?.phrase ? sentence(PREV_STATUS.find((o) => o.id === prev)!.phrase) : ""
    if (prev === "SOME_OPEN") {
      const open = items(i, "prevOpen").map((f) => {
        const status = PREV_ITEM_STATUS.find((o) => o.id === f.status)?.phrase ?? gap("status")
        const due = formatDate(String(f.revisedDue ?? ""))
        return `${cleanFragment(String(f.finding ?? "")) || gap("finding")} (${status}${due ? `, now due by ${due}` : ""})`
      })
      previous = open.length ? sentence(`Of the previous inspection’s deck findings, the following remain open: ${joinList(open)}`) : gap("open findings")
    }

    // 1. Plating
    const areas = phrases(AREAS, list(i, "areas"))
    const covered = areas.length ? sentence(`The weather deck was inspected, covering ${joinList(areas)}`) : gap("areas inspected")
    const structure = str(i, "structure")
    let plating = gap("deck plating")
    if (structure === "SOUND") plating = sentence("The deck plating was structurally sound, with no buckling, cracking or wastage")
    else if (structure === "DEFECT") {
      const actions = phrases(STRUCTURE_ACTIONS, list(i, "structureActions"))
      plating = [
        sentence(`Local wastage or deformation of the deck plating was noted ${where(str(i, "structureWhere"))}`),
        actions.length ? sentence(joinClauses(actions)) : gap("action taken"),
      ].join(" ")
    }
    const rust = DECK_RUST.find((o) => o.id === str(i, "deckRust"))?.phrase
    const rustText = rust ? sentence(rust) : gap("rust on deck")

    // 1b. Deck coating condition (IACS scale), the type of breakdown and the coating's age.
    const condition = str(i, "coatingCondition")
    const kinds = phrases(COATING_DEFECTS, list(i, "coatingDefects"))
    const conditionText = condition
      ? sentence(`The deck coating was assessed as ${condition}, as defined by IACS${kinds.length ? `, with ${joinList(kinds)}` : ""}`)
      : gap("deck coating condition")
    const lastCoat = coatingDate(i)
    const age = monthsBetween(lastCoat, ctx.startDate)
    const lastCoatText = lastCoat && str(i, "painting") !== "COMPLETED"
      ? sentence(`The deck was last fully coated in ${formatMonthYear(lastCoat)}${age !== null && age >= 0 ? `, ${ageWords(age)} before this attendance` : ""}`)
      : ""

    // 2. Painting programme (crew maintenance; the paint maker for a coating failure)
    const p = painting(i)
    const paint: string[] = []
    if (p === "FULL_COAT" || p === "SPOT") {
      const done = cleanFragment(str(i, "completedSections"))
      const remaining = cleanFragment(str(i, "remaining"))
      if (p === "FULL_COAT") {
        paint.push(sentence("A full-coat painting programme for the main deck, pipelines and fittings is in progress"))
        paint.push(sentence(`${done ? `Painting of ${done} has been completed` : gap("sections completed")}${remaining ? `, with ${remaining} remaining` : ""}`))
      } else paint.push(sentence(`Spot painting of the deck and pipelines is in progress${remaining ? `, with ${remaining} remaining` : ""}`))
      const delay = DELAY.find((o) => o.id === str(i, "delay"))?.phrase
      if (delay) paint.push(sentence(`Progress has been delayed by ${delay}`))
      const completion = str(i, "completion")
      const by = formatDate(str(i, "completionBy"))
      const when = completion === "BY_DATE" ? (by ? `by ${by}` : gap("completion date")) : COMPLETION.find((o) => o.id === completion)?.phrase
      paint.push(when ? sentence(`The work is planned to be completed ${when}`) : gap("planned completion"))
      if (i.paintStock === true) paint.push(sentence("Sufficient paint is on board to complete the work"))
      paint.push(...paintQuality(i))
    } else if (p === "COMPLETED") {
      const month = formatMonthYear(str(i, "completedIn"))
      paint.push(sentence(`Full-coat painting of the main deck, pipelines and fittings was completed${month ? ` in ${month}` : ` ${gap("month")}`}`))
      paint.push(...paintQuality(i))
    } else if (p === "FAILURE") {
      paint.push(sentence("Premature breakdown of the deck coating was noted, and the paint maker has been asked to assess it and advise on the repair"))
    } else if (!p) paint.push(gap("painting programme"))
    // Paint system and crew: which specification applies, and whether the crew can work to it.
    const system = cleanFragment(str(i, "paintSystem"))
    if (system) paint.unshift(sentence(`The deck is coated with ${system}`))
    const withWhom = phrases(DISCUSSED_WITH, list(i, "discussedWith"))
    if (withWhom.length) {
      paint.push(sentence(`The deck painting scope was discussed with ${joinList(withWhom)} to confirm their understanding of the work and the training they have received`))
      const training = PAINT_TRAINING.find((o) => o.id === str(i, "paintTraining"))?.phrase
      paint.push(training ? sentence(training) : gap("crew training"))
    }
    if (i.dataSheets === true) paint.push(sentence("The paint maker’s technical data sheets and application guidelines are available on board"))
    const equipment = phrases(EQUIPMENT, list(i, "equipment"))
    if (equipment.length) paint.push(sentence(`Deck maintenance equipment on board, including ${joinList(equipment)}, was in working order`))

    // 3. Pipelines
    const pipes = phrases(PIPES, list(i, "pipes")).filter(Boolean)
    if (has(i, "pipes", "SUPPORT_CORROSION")) pipes.push(`corrosion of pipe supports and U-bolts was noted ${where(str(i, "supportWhere"))} and is to be addressed under routine maintenance`)
    if (has(i, "pipes", "PIPE_WASTAGE")) {
      const action = PIPE_ACTIONS.find((o) => o.id === str(i, "pipeAction"))?.phrase
      pipes.push(`wastage of a pipeline was noted ${where(str(i, "wastageWhere"))}, and ${action ?? gap("action")}`)
    }

    // 4. Safety and pollution prevention
    const bondingPhrase = SAFETY.find((o) => o.id === "BONDING")!.phrase
    const safety = phrases(SAFETY, list(i, "safety")).map((phrase) => (phrase === bondingPhrase ? `${phrase}${verified(i, "verifyBonding")}` : phrase))
    const safetyDefects = phrases(SAFETY_DEFECTS, list(i, "safetyDefects"))

    // 5. Venting and inert gas
    const pvPhrase = VENTING.find((o) => o.id === "PV_OK")!.phrase
    const sealPhrase = VENTING.find((o) => o.id === "DECK_SEAL")!.phrase
    let venting = phrases(VENTING, list(i, "venting"))
      .filter(Boolean)
      .map((phrase) => (phrase === pvPhrase ? `${phrase}${verified(i, "verifyPv")}` : phrase === sealPhrase ? `${phrase}${verified(i, "verifyDeckSeal")}` : phrase))
    if (has(i, "venting", "DECK_SEAL") && has(i, "venting", "MAST_RISER")) {
      // One clause for both inert-gas items.
      const seal = VENTING.find((o) => o.id === "DECK_SEAL")!.phrase
      const riser = VENTING.find((o) => o.id === "MAST_RISER")!.phrase
      const how = VERIFIED_BY.find((o) => o.id === str(i, "verifyDeckSeal"))?.phrase
      const both = how ? `the deck seal (${how}) and the mast riser were in order` : "the deck seal and mast riser were in order"
      venting = venting.filter((v) => v !== riser).map((v) => (v.startsWith(seal) ? both : v))
    }
    const pvMonth = formatMonthYear(str(i, "pvLastMaintenance"))
    const ventText = [
      venting.length ? sentence(joinClauses(venting)) : list(i, "venting").length ? "" : gap("PV valves and inert gas"),
      has(i, "venting", "PV_LEAK") ? sentence(`A PV valve was found passing ${where(str(i, "pvLeakWhere"))} and is to be overhauled`) : "",
      has(i, "venting", "PV_DERUST") ? sentence("De-rusting and cosmetic maintenance of the PV valves is required") : "",
      pvMonth ? sentence(`The last PV valve maintenance under the PMS was carried out in ${pvMonth}`) : "",
      str(i, "tankOpenings") === "SECURED" ? sentence(TANK_OPENINGS[0].phrase) : "",
      str(i, "tankOpenings") === "DEFECT" ? sentence(`Tank openings were found not secured or leaking vapour ${where(str(i, "tankOpeningsWhere"))}, and these were to be secured immediately`) : "",
    ]

    // 5b. Electrical equipment and weathertight closures
    const closure = (key: string, okPhrase: string, defect: string) => {
      const value = str(i, key)
      if (value === "OK") return sentence(okPhrase)
      if (value !== "DEFECT") return ""
      const action = CLOSURE_ACTIONS.find((o) => o.id === str(i, `${key}Action`))?.phrase
      return sentence(`${defect} ${where(str(i, `${key}Where`))}, and ${action ?? gap("action")}`)
    }
    const exText = closure("exEquipment", EX_EQUIPMENT[0].phrase, "Defective Ex-rated electrical equipment was found")
    const wtText = closure("weathertight", WEATHERTIGHT[0].phrase, "Defective weathertight closures were found")

    // 5c. Temporary repairs on deck
    let tempText = ""
    if (str(i, "tempRepairs") === "NONE") tempText = sentence("No temporary repairs were found on deck")
    else if (str(i, "tempRepairs") === "PRESENT") {
      const list = items(i, "tempItems").map((t) => {
        const type = TEMP_TYPES.find((o) => o.id === t.type)?.phrase ?? gap("type")
        const cls = TEMP_CLASS.find((o) => o.id === t.classStatus)?.phrase ?? gap("Class status")
        const perm = TEMP_PERMANENT.find((o) => o.id === t.permanent)?.phrase ?? gap("permanent repair")
        return `${type} ${where(String(t.where ?? ""))}, ${cls}, with ${perm}`
      })
      // Each entry contains commas, so entries are separated by semicolons.
      const joined = list.length > 1 ? `${list.slice(0, -1).join("; ")}; and ${list[list.length - 1]}` : list[0]
      tempText = list.length ? sentence(`The following temporary repairs are on deck: ${joined}`) : gap("temporary repairs")
    }

    // 6. Hydraulic lines and fittings
    const hydraulic = str(i, "hydraulic")
    const hydraulicText =
      hydraulic === "LEAKS"
        ? sentence(`Hydraulic oil leaks were found ${where(str(i, "hydraulicWhere"))} and are to be rectified`)
        : HYDRAULIC.find((o) => o.id === hydraulic)?.phrase
          ? sentence(HYDRAULIC.find((o) => o.id === hydraulic)!.phrase)
          : gap("hydraulic lines")
    const weeping = phrases(WEEPING, list(i, "weeping"))
    const weepingText = weeping.length ? sentence(`Rust weeping was noted at ${joinList(weeping)}, which are to be de-rusted and painted under routine maintenance`) : ""

    // 7. Superstructure
    const accommodation = ACCOMMODATION.find((o) => o.id === str(i, "accommodation"))?.phrase
    const casing = CASING.find((o) => o.id === str(i, "casing"))?.phrase
    const egcs = phrases(EGCS_TOWER, list(i, "egcs"))

    void ctx
    return [
      para("previous", "Previous inspection’s deck findings", [previous]),
      para("plating", "Deck plating", [covered, plating, rustText]),
      para("coating", "Deck coating condition", [conditionText, lastCoatText]),
      para("painting", "Painting programme", paint),
      para("pipelines", "Pipelines and supports", [pipes.length ? sentence(joinClauses(pipes)) : gap("pipelines and supports")]),
      para("safety", "Safety and pollution prevention", [safety.length ? sentence(joinClauses(safety)) : "", safetyDefects.length ? sentence(`However, ${joinClauses(safetyDefects)}, and these are to be rectified`) : ""]),
      para("venting", "Venting and inert gas", ventText),
      para("closures", "Electrical equipment and weathertight closures", [exText, wtText]),
      para("temporary", "Temporary repairs on deck", [tempText]),
      para("hydraulic", "Hydraulic lines and fittings", [hydraulicText, weepingText]),
      para("superstructure", "Accommodation exterior, engine casing and funnel", [
        accommodation && sentence(accommodation),
        casing && sentence(casing),
        egcs.length ? sentence(joinClauses(egcs)) : "",
        sentence(str(i, "note")),
      ]),
    ]
  },

  validate(i, ctx, { error, warn }) {
    const id = (key: string) => `narr-mainDeckCondition-${key}`
    const rating = weatherDeckRating(ctx)
    const defects = list(i, "safetyDefects")
    for (const both of list(i, "safety").filter((s) => defects.includes(s))) {
      error(id("safetyDefects"), `“${SAFETY.find((o) => o.id === both)!.label}” is selected both as in order and as a deficiency.`)
    }
    if (has(i, "venting", "PV_OK") && has(i, "venting", "PV_LEAK")) error(id("venting"), "“No leakage” and “PV valve passing” cannot both be selected.")

    const closureDefect = str(i, "exEquipment") === "DEFECT" || str(i, "weathertight") === "DEFECT" || str(i, "tankOpenings") === "DEFECT"
    const serious =
      closureDefect ||
      str(i, "tempRepairs") === "PRESENT" ||
      str(i, "structure") === "DEFECT" ||
      str(i, "deckRust") === "SIGNIFICANT" ||
      painting(i) === "FAILURE" ||
      has(i, "pipes", "PIPE_WASTAGE") ||
      has(i, "venting", "PV_LEAK") ||
      str(i, "hydraulic") === "LEAKS" ||
      defects.length > 0
    const minor =
      ["LT_0_1", "LT_1", "SCATTERED"].includes(str(i, "deckRust")) ||
      has(i, "pipes", "SUPPORT_CORROSION") ||
      has(i, "venting", "PV_DERUST") ||
      str(i, "hydraulic") === "SPOT_RUST" ||
      list(i, "weeping").length > 0
    if (rating === "satisfactory" && minor && !serious) {
      warn(id("deckRust"), "The weather deck is rated Satisfactory (no defects), but minor defects are recorded here. Acceptable may be the better rating.")
    }
    if ((rating === "satisfactory" || rating === "acceptable") && serious) {
      warn(id("structure"), "Wastage, a coating failure, leaks or safety / pollution-prevention deficiencies are recorded here. Confirm the rating of the weather deck.")
    }
    if ((rating === "degraded" || rating === "deficient") && !serious && !minor) {
      warn(id("structure"), "The weather deck is rated Degraded or Deficient, but no defect is recorded here. Describe the finding.")
    }
    // Requirements not met: consider Deficient.
    if ((defects.includes("BONDING") || has(i, "venting", "PV_LEAK") || defects.includes("SCUPPERS")) && rating !== "deficient") {
      warn(id("safetyDefects"), "Missing bonding straps, missing scupper plugs or a passing PV valve do not meet ISGOTT / MARPOL / SOLAS requirements: consider rating the weather deck Deficient.")
    }
    // Coating condition against the rust extent, the rating, the repair plan and the coating's age.
    const coating = str(i, "coatingCondition")
    const rustExtent = str(i, "deckRust")
    if ((coating === "GOOD" && ["SCATTERED", "SIGNIFICANT"].includes(rustExtent)) || (coating === "POOR" && rustExtent === "NONE")) {
      warn(id("coatingCondition"), "The deck coating condition and the rust on deck disagree. Check both.")
    }
    if (coating === "POOR" && (rating === "satisfactory" || rating === "acceptable")) {
      warn(id("coatingCondition"), "The deck coating is POOR: confirm the rating of the weather deck.")
    }
    if (coating === "FAIR" && rating === "satisfactory") {
      warn(id("coatingCondition"), "The deck coating is FAIR: Acceptable may be the better rating than Satisfactory.")
    }
    if (coating === "POOR" && (!str(i, "painting") || str(i, "painting") === "NONE")) {
      warn(id("painting"), "The deck coating is POOR, but no painting programme is planned. State the planned repair.")
    }
    const coatAge = monthsBetween(coatingDate(i), ctx.startDate)
    if (coatAge !== null && coatAge >= 0 && coatAge < 24 && COATING_DEFECTS.some((o) => "early" in o && has(i, "coatingDefects", o.id))) {
      warn(id("coatingDefects"), "Blistering, flaking or chalking on a coating applied less than two years ago may be a paint failure: involve the paint maker and consider a warranty claim.")
    }
    if (coatAge !== null && coatAge < 0) error(id("lastDeckCoating"), "The last full coating of the deck cannot be after this inspection.")

    if (closureDefect && rating !== "deficient") {
      warn(id("exEquipment"), "Defective Ex equipment, weathertight closures or tank openings do not meet SOLAS / Load Line / ISGOTT requirements: consider rating the weather deck Deficient.")
    }
    if (!rating) warn(id("areas"), "Rate the weather deck above as well: the remarks do not replace the rating.")

    // Previous findings and temporary repairs.
    if (items(i, "prevOpen").some((f) => f.status === "OVERDUE") && str(i, "prevStatus") === "SOME_OPEN") {
      warn(id("prevOpen"), "An overdue finding from the previous inspection should be raised again in this report’s findings register with a new due date.")
    }
    const temps = str(i, "tempRepairs") === "PRESENT" ? items(i, "tempItems") : []
    if (temps.some((t) => t.classStatus === "NOT_INFORMED")) {
      warn(id("tempItems"), "A temporary repair not reported to the Classification Society: report it to Class.")
    }
    if (temps.some((t) => t.classStatus === "COC")) {
      warn(id("tempItems"), "A Condition of Class applies: list it under Significant Problems with its due date.")
    }
    if (inProgress(i) && !list(i, "discussedWith").length) {
      warn(id("discussedWith"), "Painting is in progress: discuss the scope with the Chief Officer, Bosun and deck crew and record the training they have received.")
    }
    if (inProgress(i) && !str(i, "paintSystem")) warn(id("paintSystem"), "State the deck paint in use (maker and product), so the specification being followed is clear.")
    if (inProgress(i) && i.dftRecorded !== true) {
      warn(id("dftRecorded"), "Painting is in progress without DFT readings recorded: crew painting should follow the paint maker’s specification.")
    }

    // PV maintenance interval.
    const pv = str(i, "pvLastMaintenance")
    const order = compareIsoDates(pv, ctx.endDate || ctx.startDate)
    if (pv && order !== null && order > 0) error(id("pvLastMaintenance"), "The last PV valve maintenance cannot be after this inspection.")
    if (pv && ctx.startDate && (Date.parse(ctx.startDate) - Date.parse(pv)) / (30.44 * 24 * 3600 * 1000) > 6) {
      warn(id("pvLastMaintenance"), "The last PV valve maintenance was more than six months before this attendance. Check the PMS interval.")
    }

    // Planned completion against the vessel's condition from the Preamble.
    const loading = ctx.vesselCondition.loading
    const completion = str(i, "completion")
    if (inProgress(i) && completion === "NEXT_BALLAST" && loading === "BALLAST") {
      warn(id("completion"), "The Preamble says the vessel is in ballast now: “during the present voyage” may be meant rather than “the next ballast leg”.")
    }
    if (inProgress(i) && completion === "NEXT_LADEN" && loading === "LADEN") {
      warn(id("completion"), "The Preamble says the vessel is laden now: “during the present voyage” may be meant rather than “the next laden leg”.")
    }

    // Consistency with the Executive Summary – Structural Condition.
    const structural = ctx.sectionInputs.structuralCondition
    if (structural) {
      const s = (key: string) => (typeof structural[key] === "string" ? (structural[key] as string) : "")
      if (s("deckRust") && str(i, "deckRust") && s("deckRust") !== str(i, "deckRust")) {
        warn(id("deckRust"), "The rust on deck differs from the Executive Summary – Structural Condition. Make them the same.")
      }
      if (s("casing") && str(i, "casing") && s("casing") !== str(i, "casing")) {
        warn(id("casing"), "The engine casing and funnel differ from the Executive Summary – Structural Condition. Make them the same.")
      }
    }
  },
}
