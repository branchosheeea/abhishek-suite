// Executive Summary – Overall Condition.
// Pattern from past reports: overall assessment → hull as seen from the launch/jetty → main deck coating programme →
// accommodation → engine room and machinery → defects and shipboard team. Every evaluative statement here comes
// from a selection; the condition-rating summary comes from the report's own Vessel Condition Report.

import { gap, joinClauses, sentence } from "../text"
import { para, type SectionSpec } from "../section"
import {
  AREA_ASSESSMENTS,
  ASSESSMENTS,
  deficientItems,
  assessment,
  flag,
  has,
  isFavourable,
  itemNames,
  list,
  degradedItems,
  phrases,
  ratingSummary,
  str,
} from "./common"

const OVERALL = [
  ...ASSESSMENTS.slice(0, 2),
  { id: "SATISFACTORY_FOR_AGE", label: "Satisfactory for the vessel’s age", phrase: "satisfactory" },
  ...ASSESSMENTS.slice(2),
] as const

const HULL_VIEW = [
  { id: "LAUNCH", label: "From the launch", phrase: "as observed from the launch" },
  { id: "JETTY", label: "From the jetty", phrase: "as observed from the jetty" },
  { id: "DECK", label: "From the deck", phrase: "as observed from the deck" },
  { id: "DIVING", label: "During the underwater inspection", phrase: "as observed during the underwater inspection" },
  { id: "DRY_DOCK", label: "In dry-dock", phrase: "as observed in dry-dock" },
  { id: "NOT_OBSERVED", label: "Could not be observed", phrase: "" },
] as const

const HULL_NOT_OBSERVED = [
  { id: "DARKNESS", label: "Darkness", phrase: "because of darkness" },
  { id: "WEATHER", label: "Weather", phrase: "because of the weather conditions" },
  { id: "BERTHING", label: "Berthing position", phrase: "because of the vessel’s berthing position" },
  { id: "TIME", label: "Time constraints", phrase: "because of time constraints" },
] as const

const HULL_OBSERVATIONS = [
  { id: "NO_DAMAGE", label: "No dents or structural damage", phrase: "no dents or structural damage were noted" },
  { id: "COATING_INTACT", label: "Paint coating intact", phrase: "the paint coating was intact" },
  { id: "MARKS_CLEAR", label: "Draught, load line and hull markings clear", phrase: "the draught marks, load line mark and hull markings were clearly visible" },
  { id: "RECENTLY_PAINTED", label: "Recently painted in dry-dock", phrase: "the hull had recently been painted in dry-dock" },
  { id: "FENDER_ABRASION", label: "Abrasion from fenders or tugs", phrase: "abrasion marks from contact with berth fenders or tugs were noted" },
  { id: "DENT_WITHIN_LIMITS", label: "Minor dent within Class limits", phrase: "a minor dent within Class allowable limits was noted" },
  { id: "COATING_DETACHED", label: "Local coating detachment", phrase: "localised coating detachment was noted" },
] as const

const DECK_COATING = [
  { id: "FULLY_COATED", label: "Fully coated, routine maintenance", phrase: "The main deck is fully coated, and routine maintenance is in progress in line with the maintenance plan" },
  { id: "FULL_COAT_IN_PROGRESS", label: "Full-coat painting in progress", phrase: "Full-coat painting of the main deck is in progress" },
  { id: "NEARING_COMPLETION", label: "Full coat nearing completion", phrase: "Full-coat painting of the main deck is nearing completion" },
  { id: "SPOT_MAINTENANCE", label: "Spot maintenance in progress", phrase: "Spot maintenance and painting of the main deck are in progress" },
  { id: "SPOT_RUST", label: "Good with scattered spot rust", phrase: "The main deck coating is in good condition, with scattered spot rust" },
  { id: "FULL_COAT_PLANNED", label: "Full coat planned", phrase: "A full coat of the main deck is planned" },
  { id: "BREAKDOWN", label: "Coating breakdown requiring attention", phrase: "Coating breakdown on the main deck requires attention" },
] as const

const DECK_SUPPORT = [
  { id: "CREW_BRIEFED", label: "Chief Officer and deck crew briefed", phrase: "the Chief Officer and deck crew were briefed on the scope of work in line with Company guidance and the Owners’ expectations" },
  { id: "PAINT_ON_BOARD", label: "Required paint on board", phrase: "the required paint is on board" },
  { id: "RIDING_TEAM", label: "Riding team arranged", phrase: "a riding team has been arranged to expedite the work" },
  { id: "WEATHER_DEFERRED", label: "Work deferred by weather, rescheduled", phrase: "work deferred because of weather has been rescheduled" },
] as const

const ACCOMMODATION_NOTES = [
  { id: "HYGIENE", label: "Hygiene and housekeeping good", phrase: "hygiene and housekeeping standards were good" },
  { id: "GALLEY", label: "Galley and provision stores clean", phrase: "the galley and provision stores were clean and well maintained" },
  { id: "AC", label: "Air-conditioning working", phrase: "the air-conditioning plant was working satisfactorily" },
  { id: "UPHOLSTERY", label: "Upholstery worn, renewal needed", phrase: "worn upholstery in the mess rooms and public spaces requires renewal" },
  { id: "IMPROVE", label: "Housekeeping needs improvement", phrase: "housekeeping requires improvement" },
] as const

const ENGINE_ROOM_NOTES = [
  { id: "COSMETIC_GOOD", label: "Cosmetic condition well maintained", phrase: "its cosmetic condition was well maintained" },
  { id: "NO_LEAKS", label: "No leaks observed", phrase: "no oil, water or air leaks were observed" },
  { id: "POST_DOCK_CLEANING", label: "Post-docking cleaning in progress", phrase: "cleaning after dry-docking is in progress" },
  { id: "LEAKS", label: "Leaks to be rectified", phrase: "leaks were observed and are to be rectified" },
  { id: "COSMETIC_IMPROVE", label: "Cosmetic condition needs improvement", phrase: "its cosmetic condition requires improvement" },
] as const

const MACHINERY_METHOD = [
  { id: "TESTED", label: "Checked in operation during the attendance" },
  { id: "RECORDS", label: "Reviewed from the latest performance records" },
  { id: "REPORTED", label: "Reported by the ship’s staff" },
] as const

const MACHINERY_RESULT = [
  { id: "WITHIN_LIMITS", label: "Within the maker’s recommended limits" },
  { id: "DEVIATIONS", label: "Deviations noted" },
] as const

const DEFECTS = [
  { id: "NONE_NOTED", label: "No defects noted", phrase: "No defects were noted during the attendance" },
  { id: "RECTIFIED", label: "Minor defects rectified on board", phrase: "Minor defects noted during the attendance were brought to the attention of the officers and rectified on board" },
  { id: "DDRL", label: "Outstanding defects in DDRL and worklist", phrase: "Outstanding defects have been entered in the Defect and Damage Report List (DDRL) and the inspection worklist for follow-up" },
  { id: "IMPROVEMENT", label: "Areas for improvement in the report", phrase: "Areas requiring improvement are highlighted in the relevant sections of this report" },
] as const

const TEAM = [
  { id: "GOOD", label: "Competent and working well", phrase: "The shipboard team was found to be competent and working well together" },
  { id: "SATISFACTORY", label: "Satisfactory", phrase: "The performance of the officers and crew was found to be satisfactory" },
  { id: "IMPROVEMENT", label: "Improvement needs identified", phrase: "Performance and training needs identified in the shipboard team are addressed under Crew Evaluation" },
] as const

const show = {
  hullObserved: (s: Record<string, unknown>) => !!str(s, "hullView") && str(s, "hullView") !== "NOT_OBSERVED",
  hullNotObserved: (s: Record<string, unknown>) => str(s, "hullView") === "NOT_OBSERVED",
  deckProgress: (s: Record<string, unknown>) =>
    ["FULL_COAT_IN_PROGRESS", "NEARING_COMPLETION", "SPOT_MAINTENANCE", "FULL_COAT_PLANNED"].includes(str(s, "deckCoating")),
  machineryResult: (s: Record<string, unknown>) => !!str(s, "machineryMethod"),
}

export const OVERALL_SECTION: SectionSpec = {
  id: "overallCondition",
  summaryKey: "overall",
  title: "Overall Condition",
  tab: "Overall",
  description: "The overall picture of the vessel, taken from what was seen and tested.",
  groups: [
    {
      title: "Overall assessment",
      fields: [
        { kind: "select", key: "assessment", label: "Overall condition", required: true, options: OVERALL, placeholder: "Select the overall condition…" },
        {
          kind: "confirm",
          key: "includeRatings",
          label: "Include the condition-rating summary from the Vessel Condition Report",
          default: true,
          hint: "Counts of Satisfactory / Acceptable / Degraded / Deficient items, taken from this report.",
        },
      ],
    },
    {
      title: "Hull and main deck",
      fields: [
        { kind: "select", key: "hullView", label: "Hull above the waterline was observed", options: HULL_VIEW, placeholder: "Select…" },
        { kind: "select", key: "hullNotObservedReason", label: "Reason", required: true, options: HULL_NOT_OBSERVED, showIf: show.hullNotObserved },
        { kind: "select", key: "hullCondition", label: "Hull condition", required: true, options: ASSESSMENTS, showIf: show.hullObserved, placeholder: "Select…" },
        { kind: "multi", key: "hullObservations", label: "Hull observations", options: HULL_OBSERVATIONS, columns: 2, showIf: show.hullObserved },
        { kind: "select", key: "deckCoating", label: "Main deck coating", options: DECK_COATING, placeholder: "Select…", wide: true },
        {
          kind: "text",
          key: "deckProgress",
          label: "Progress or timing (optional)",
          placeholder: "e.g. with about 50% of the deck completed",
          hint: "Added after a comma, e.g. “with work pending on the manifold pipelines” or “to be carried out after the Special Survey in early 2026”.",
          showIf: show.deckProgress,
          wide: true,
        },
        { kind: "multi", key: "deckSupport", label: "Deck maintenance arrangements", options: DECK_SUPPORT, showIf: (s) => !!str(s, "deckCoating") },
      ],
    },
    {
      title: "Accommodation, engine room and machinery",
      fields: [
        { kind: "select", key: "accommodation", label: "Accommodation", options: AREA_ASSESSMENTS, placeholder: "Select…" },
        { kind: "multi", key: "accommodationNotes", label: "Accommodation notes", options: ACCOMMODATION_NOTES, columns: 2, showIf: (s) => isFavourable(s.accommodation) || s.accommodation === "FAIR" || s.accommodation === "POOR" },
        { kind: "select", key: "engineRoom", label: "Engine room", required: true, options: AREA_ASSESSMENTS, placeholder: "Select…" },
        { kind: "multi", key: "engineRoomNotes", label: "Engine room notes", options: ENGINE_ROOM_NOTES, columns: 2, showIf: (s) => !!str(s, "engineRoom") && s.engineRoom !== "NOT_ASSESSED" },
        { kind: "select", key: "machineryMethod", label: "Main and auxiliary engine performance was", options: MACHINERY_METHOD, placeholder: "Select…" },
        { kind: "select", key: "machineryResult", label: "Result", required: true, options: MACHINERY_RESULT, showIf: show.machineryResult },
      ],
    },
    {
      title: "Defects and shipboard team",
      fields: [
        { kind: "multi", key: "defects", label: "Defects", options: DEFECTS, exclusive: "NONE_NOTED" },
        { kind: "select", key: "team", label: "Shipboard team", options: TEAM, placeholder: "Not stated" },
        { kind: "confirm", key: "seniorExperienced", label: "Senior officers are experienced and guide junior officers well" },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express.", hint: "Inserted as written at the end of this section." },
      ],
    },
  ],

  paragraphs(i, ctx) {
    // 1. Overall assessment
    const choice = str(i, "assessment")
    const phrase = OVERALL.find((o) => o.id === choice)?.phrase
    let opening = phrase ? `The vessel’s overall condition was assessed as ${phrase}` : ""
    if (phrase && choice === "SATISFACTORY_FOR_AGE") {
      opening += ctx.vesselAge ? `, having regard to her age of ${ctx.vesselAge} years` : ", having regard to her age"
    }
    // A gap replaces the whole sentence, so removing it never leaves a broken sentence behind.
    const openingText = opening ? sentence(opening) : gap("overall condition")
    const ratings = flag(i, "includeRatings") ? ratingSummary(ctx) : ""

    // 2. Hull and main deck
    const view = HULL_VIEW.find((o) => o.id === str(i, "hullView"))
    let hull = ""
    if (view?.id === "NOT_OBSERVED") {
      const reason = HULL_NOT_OBSERVED.find((o) => o.id === str(i, "hullNotObservedReason"))?.phrase
      hull = sentence(`The hull above the waterline could not be observed during the attendance ${reason ?? gap("reason")}`)
    } else if (view) {
      const condition = assessment(str(i, "hullCondition"))
      const observations = phrases(HULL_OBSERVATIONS, list(i, "hullObservations"))
      hull = condition
        ? [sentence(`The hull above the waterline, ${view.phrase}, was in ${condition} condition`), observations.length ? sentence(joinClauses(observations)) : ""]
            .filter(Boolean)
            .join(" ")
        : gap("hull condition")
    }
    const deck = DECK_COATING.find((o) => o.id === str(i, "deckCoating"))
    const progress = str(i, "deckProgress").replace(/^[,\s]+/, "")
    const support = phrases(DECK_SUPPORT, list(i, "deckSupport"))
    const deckText = deck ? sentence(`${deck.phrase}${progress ? `, ${progress}` : ""}`) : ""
    const supportText = deck && support.length ? sentence(joinClauses(support)) : ""

    // 3. Accommodation, engine room and machinery
    const acc = assessment(str(i, "accommodation"))
    const accNotes = phrases(ACCOMMODATION_NOTES, list(i, "accommodationNotes"))
    const accText = acc ? [sentence(`The accommodation was in ${acc} condition`), accNotes.length ? sentence(joinClauses(accNotes)) : ""].filter(Boolean).join(" ") : ""
    const er = str(i, "engineRoom")
    const erNotes = phrases(ENGINE_ROOM_NOTES, list(i, "engineRoomNotes"))
    let erText = ""
    if (er === "NOT_ASSESSED") erText = sentence("The engine room was not assessed during this attendance")
    else if (er) erText = [sentence(`The engine room was in ${assessment(er)} condition`), erNotes.length ? sentence(joinClauses(erNotes)) : ""].filter(Boolean).join(" ")
    else erText = gap("engine room condition")
    const method = str(i, "machineryMethod")
    const within = str(i, "machineryResult") === "WITHIN_LIMITS"
    const resultText = within ? "the parameters were within the maker’s recommended limits" : "deviations from the maker’s recommended limits were noted and are addressed in this report"
    let machinery = ""
    if (method === "TESTED") machinery = sentence(`The performance of the main engine and auxiliary engines was checked during the attendance, and ${resultText}`)
    else if (method === "RECORDS") machinery = sentence(`Main engine and auxiliary engine performance was reviewed from the latest performance records, and ${resultText}`)
    else if (method === "REPORTED")
      machinery = within
        ? sentence("The ship’s staff reported the main engine and auxiliary engines to be operating within the maker’s recommended limits")
        : sentence("The ship’s staff reported deviations from the maker’s recommended limits on the main engine or auxiliary engines, and these are addressed in this report")

    // 4. Defects and team
    const defects = phrases(DEFECTS, list(i, "defects")).map((p) => sentence(p))
    const team = TEAM.find((o) => o.id === str(i, "team"))?.phrase
    const senior = flag(i, "seniorExperienced") ? sentence("The senior officers are experienced and provide good guidance to junior officers") : ""

    return [
      para("assessment", "Overall assessment", [openingText, ratings]),
      para("hull", "Hull and main deck", [hull, deckText, supportText]),
      para("machinery", "Accommodation, engine room and machinery", [accText, erText, machinery]),
      para("team", "Defects and shipboard team", [...defects, team && sentence(team), senior, sentence(str(i, "note"))]),
    ]
  },

  validate(i, ctx, { warn }) {
    const action = deficientItems(ctx)
    const monitor = degradedItems(ctx)
    if (["GOOD", "SATISFACTORY", "SATISFACTORY_FOR_AGE"].includes(str(i, "assessment")) && action.length) {
      warn(
        "narr-overallCondition-assessment",
        `The overall condition is favourable while ${action.length} item${action.length === 1 ? " is" : "s are"} rated Deficient (${itemNames(action)}). Confirm the assessment.`,
      )
    }
    if (has(i, "defects", "NONE_NOTED") && (action.length || monitor.length)) {
      warn("narr-overallCondition-defects", "“No defects noted” is selected, but the Vessel Condition Report has items rated Degraded or Deficient.")
    }
    if (flag(i, "includeRatings") && !ctx.items.some((item) => item.rating && item.rating !== "na")) {
      warn("narr-overallCondition-includeRatings", "No condition items are rated yet, so the rating summary is left out.")
    }
    if (str(i, "assessment") === "SATISFACTORY_FOR_AGE" && ctx.vesselAge === null) {
      warn("narr-overallCondition-assessment", "Enter the year of build in Principal Particulars to state the vessel’s age.")
    }
  },
}
