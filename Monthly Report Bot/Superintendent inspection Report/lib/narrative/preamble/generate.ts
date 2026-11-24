// Deterministic generator for the Executive Summary – Preamble.
// Same inputs → same text. No AI service is involved; an AI wording layer can later post-process `text` without
// replacing this core. Missing required data is marked with gap() markers that the preview highlights and that
// are always removed from the copied or saved text.

import { compareIsoDates, datePhrase, formatDate, isValidIsoDate } from "../dates"
import {
  capitalise,
  cleanFragment,
  cleanSentences,
  gap,
  hasGap,
  joinList,
  joinWithArticle,
  lowerFirst,
  ordinal,
  paragraph,
  place,
  removeGaps,
  sentence,
  tidy,
  toSegments,
  wordCount,
  type Segment,
} from "../text"
import { isDryDockingContext, isNewbuildingContext, pruneHidden, type PreambleFacts, type PreambleInputs } from "./model"
import {
  ATTENTION_VARIANTS,
  CARGO_OPERATION_TYPES,
  CLOSING_STATEMENTS,
  DEFICIENCY_STATUSES,
  FOCUS_AREAS,
  FOLLOW_UP_METHODS,
  INSPECTION_TYPES,
  LOADING_CONDITIONS,
  NEUTRAL_FINDINGS_TEXT,
  OPENING_MEETINGS,
  OPERATING_CONDITIONS,
  PARTICULAR_ATTENTION,
  PRIMARY_OBJECTIVES,
  SAILING_STATUSES,
  VESSEL_STATUSES,
  findOption,
} from "./options"

export const STANDARD_SCOPE =
  "the vessel’s overall technical and operational condition; accessible deck, cargo, accommodation and machinery spaces; " +
  "the condition and performance of machinery, equipment, alarms and safety systems; implementation of the Safety Management " +
  "System and Planned Maintenance System; maintenance and defect records; statutory and Company compliance; and the officers’ " +
  "and crew’s familiarity with vessel-specific equipment, operating procedures and emergency arrangements"

export const DISCUSSION_TEXT =
  "Relevant safety, operational and maintenance matters were discussed with the vessel’s staff, and guidance was provided " +
  "where improvement or further action was required."

export const PARAGRAPHS = [
  { id: "attendance", title: "Attendance" },
  { id: "objectives", title: "Opening meeting, objectives and scope" },
  { id: "examination", title: "Examination, records and focus areas" },
  { id: "findings", title: "Findings, follow-up and acknowledgment" },
] as const

export type ParagraphId = (typeof PARAGRAPHS)[number]["id"]

export type GeneratedParagraph = {
  id: ParagraphId
  title: string
  /** Text with gap markers split out, for the preview. */
  segments: Segment[]
  /** Clean text, without gap markers. */
  text: string
  incomplete: boolean
}

export type GeneratedPreamble = {
  paragraphs: GeneratedParagraph[]
  /** The complete preamble: clean paragraphs separated by a blank line. This is what is copied and saved. */
  text: string
  incomplete: boolean
  wordCount: number
}

// ---------------------------------------------------------------------------------------------------------------
// Paragraph 1: attendance
// ---------------------------------------------------------------------------------------------------------------

/** Removes a leading preposition the user may have typed ("at Singapore" → "Singapore"). */
function placeName(text: string, prefix: RegExp = /^(?:at|in)\s+/i) {
  return cleanFragment(text).replace(prefix, "")
}

function shipyardPlace(inputs: PreambleInputs) {
  const parts: string[] = []
  for (const part of [inputs.shipyardName, inputs.shipyardPort, inputs.shipyardCountry].map((p) => placeName(p))) {
    if (part && !parts.some((p) => p.toLowerCase() === part.toLowerCase())) parts.push(part)
  }
  return parts.join(", ")
}

function attendanceSentence(inputs: PreambleInputs, facts: PreambleFacts) {
  const vesselName = facts.vesselName.trim()
  const vessel = vesselName ? `the vessel ${vesselName}` : `the vessel ${gap("vessel name")}`
  const dates = datePhrase(facts.startDate, facts.endDate) || gap("attendance dates")
  const status = findOption(VESSEL_STATUSES, inputs.vesselStatus)
  const passage = status && "passage" in status ? status.passage : undefined
  const action = inputs.attendanceAction

  // Location pieces. A missing place is replaced by a gap marker *including* its preposition, so removing the
  // marker never leaves a dangling "at" or "to".
  let at = "" // "at Galle, Sri Lanka" style phrase for the verb
  let destination = "" // port-to-port destination, attached exactly once
  let missingDestination = "" // gap marker shown where the destination would go
  let route = "" // at-sea voyage route
  switch (inputs.locationType) {
    case "SINGLE": {
      const location = placeName(inputs.location)
      at = location ? `at ${place(location)}` : gap("location")
      break
    }
    case "PORT_TO_PORT": {
      const joining = placeName(inputs.joiningLocation)
      const to = placeName(inputs.disembarkationLocation, /^(?:to|at)\s+/i)
      at = joining ? `at ${place(joining)}` : gap("joining location")
      destination = to ? place(to) : ""
      if (!to) missingDestination = gap("disembarkation location")
      if ((action === "ATTENDED" || action === "PORT_CALL" || action === "DURING_DRY_DOCKING") && joining && to) {
        at = `between ${place(joining)} and ${destination}`
        destination = ""
      }
      break
    }
    case "SHIPYARD": {
      const yard = shipyardPlace(inputs)
      at = yard ? `at ${place(yard)}` : gap("shipyard")
      break
    }
    case "AT_SEA": {
      route = placeName(inputs.voyageRoute, /^(?:from|on passage from)\s+/i)
      at = route && !passage ? `at sea on passage from ${place(route)}` : "at sea"
      if (passage) route = route ? place(route) : ""
      else route = ""
      break
    }
    case "OTHER": {
      const other = cleanFragment(inputs.otherLocation)
      at = other ? place(other) : gap("location")
      break
    }
  }

  // Status clause; a passage status carries the destination or route when one is still unattached.
  let statusClause = ""
  let statusConsumed = false
  let core: string

  const statusFor = (withDestination: string) => {
    if (!status) return ""
    if (passage) {
      const suffix = "suffix" in status ? ` ${status.suffix}` : ""
      const where = withDestination ? ` to ${withDestination}` : route ? ` from ${route}` : ""
      return `${status.clause}${where}${suffix}`
    }
    const loading = "loading" in status && status.loading ? findOption(LOADING_CONDITIONS, inputs.loadingCondition) : undefined
    return loading ? `${status.clause} ${loading.phrase}` : status.clause
  }

  switch (action) {
    case "ATTENDED":
      core = `attended ${vessel} ${at} ${dates}`
      break
    case "PORT_CALL":
      core = `attended ${vessel} during her port call ${at} ${dates}`
      break
    case "DURING_DRY_DOCKING":
      core = `attended ${vessel} during dry-docking ${at} ${dates}`
      break
    case "BOARDED_REMAINED":
    case "JOINED_REMAINED": {
      const verb = action === "BOARDED_REMAINED" ? "boarded" : "joined"
      core = `${verb} ${vessel} ${at} and remained on board ${dates}`
      if (destination && !passage) {
        core += ` until her arrival at ${destination}`
        destination = ""
      }
      break
    }
    case "SEA_PASSAGE": {
      const to = destination ? ` to ${destination}` : route ? ` from ${route}` : ""
      core = `joined ${vessel} ${at} for the ${passage ?? "sea passage"}${to} ${dates}`
      destination = ""
      statusConsumed = Boolean(passage)
      break
    }
    case "BEFORE_DELIVERY_MAIDEN_VOYAGE": {
      const consumes = inputs.vesselStatus === "MAIDEN_VOYAGE"
      const to = destination ? ` to ${destination}` : consumes && route ? ` from ${route}` : ""
      core = `attended ${vessel} ${at} before delivery and remained on board for the maiden voyage${to} ${dates}`
      destination = ""
      statusConsumed = consumes
      break
    }
  }

  if (missingDestination) core += ` ${missingDestination}`
  if (!statusConsumed) statusClause = statusFor(destination)
  const sailingStatusMissing = !statusConsumed && !(status && SAILING_STATUSES.includes(status.id))
  if (inputs.inspectionType === "SAILING" && !statusClause && sailingStatusMissing) statusClause = gap("vessel status")

  const type = findOption(INSPECTION_TYPES, inputs.inspectionType)
  const conduct = type ? type.phrase : `an inspection ${gap("inspection type")}`
  return sentence(
    `The Superintendent ${core}${statusClause ? ` ${statusClause}` : ""}, to conduct ${conduct} in accordance with the Company’s inspection requirements`,
  )
}

/** The attendance end date used to decide whether a docking or delivery date was before or after the visit. */
function attendanceEnd(facts: PreambleFacts) {
  return isValidIsoDate(facts.endDate) ? facts.endDate : facts.startDate
}

function onOrBeforeAttendance(date: string, facts: PreambleFacts) {
  const order = compareIsoDates(date, attendanceEnd(facts))
  return order === null || order <= 0
}

function dockingSentence(inputs: PreambleInputs, facts: PreambleFacts) {
  const completion = formatDate(inputs.dockingCompletionDate)
  if (inputs.inspectionType === "POST_DOCKING") {
    return completion ? sentence(`The attendance followed completion of the vessel’s dry-docking on ${completion}`) : ""
  }
  if (!isDryDockingContext(inputs)) return ""
  const number = /^\d{1,2}$/.test(inputs.specialSurveyNumber.trim()) ? Number(inputs.specialSurveyNumber.trim()) : 0
  const survey = number >= 1 ? `in connection with the vessel’s ${ordinal(number)} Special Survey` : ""
  const completed = completion && onOrBeforeAttendance(inputs.dockingCompletionDate, facts)
  if (survey && completion) {
    return sentence(
      completed
        ? `The dry-docking was undertaken ${survey} and was completed on ${completion}`
        : `The dry-docking was undertaken ${survey}, with completion planned for ${completion}`,
    )
  }
  if (survey) return sentence(`The dry-docking was undertaken ${survey}`)
  if (completion) {
    return sentence(completed ? `The dry-docking was completed on ${completion}` : `Completion of the dry-docking was planned for ${completion}`)
  }
  return ""
}

function newbuildingSentences(inputs: PreambleInputs, facts: PreambleFacts) {
  if (!isNewbuildingContext(inputs)) return []
  const builder = cleanFragment(inputs.builder)
  const delivery = formatDate(inputs.deliveryDate)
  const delivered = delivery && onOrBeforeAttendance(inputs.deliveryDate, facts)
  const deliveryPart = delivery ? (delivered ? `delivered on ${delivery}` : `is scheduled for delivery on ${delivery}`) : ""
  const sentences: string[] = []
  if (builder && deliveryPart) sentences.push(sentence(`The vessel was built by ${builder} and ${deliveryPart}`))
  else if (builder) sentences.push(sentence(`The vessel was built by ${builder}`))
  else if (deliveryPart) sentences.push(sentence(`The vessel ${delivered ? "was " : ""}${deliveryPart}`))
  const guarantee = formatDate(inputs.guaranteeEndDate)
  if (guarantee) sentences.push(sentence(`The guarantee period ends on ${guarantee}`))
  return sentences
}

// ---------------------------------------------------------------------------------------------------------------
// Paragraph 2: opening meeting, objectives and scope
// ---------------------------------------------------------------------------------------------------------------

function objectivesSentences(inputs: PreambleInputs) {
  const conditions = findOption(OPERATING_CONDITIONS, inputs.operatingCondition)?.label ?? "the conditions prevailing during the attendance"
  const phrases = PRIMARY_OBJECTIVES.filter((o) => o.id !== "OTHER" && inputs.primaryObjectives.includes(o.id)).map((o) =>
    o.phrase.replace("{conditions}", conditions),
  )
  const custom = inputs.primaryObjectives.includes("OTHER") ? lowerFirst(cleanFragment(inputs.customObjective)) : ""
  const sentences: string[] = []
  if (phrases.length) sentences.push(sentence(`The inspection focused on ${joinList(phrases)}`))
  if (custom) sentences.push(sentence(`The inspection ${phrases.length ? "also addressed" : "focused on"} ${custom}`))
  if (!sentences.length) sentences.push(gap("primary objectives"))
  return { sentences, stated: phrases.length > 0 || Boolean(custom) }
}

// ---------------------------------------------------------------------------------------------------------------
// Paragraph 3: examination, records and focus areas
// ---------------------------------------------------------------------------------------------------------------

function previousInspectionSentence(inputs: PreambleInputs) {
  const date = formatDate(inputs.previousInspectionDate)
  const reference = cleanFragment(inputs.previousWorklistReference)
  const observations = date ? `Previously reported observations from the inspection of ${date}` : "Previously reported observations"
  const items = reference ? `outstanding items on worklist ${reference}` : "outstanding worklist items"
  return sentence(`${observations} and ${items} were reviewed, and their status was verified as far as practicable`)
}

function cargoSentence(inputs: PreambleInputs, base: string) {
  if (!inputs.cargoOperationsWitnessed) return base
  const operation = findOption(CARGO_OPERATION_TYPES, inputs.cargoOperationType)
  const cargo = cleanFragment(inputs.cargoType)
  let witnessed: string
  if (operation && cargo) witnessed = `${capitalise(cargo)} ${operation.noun} were witnessed`
  else if (operation) witnessed = `Cargo ${operation.noun} were witnessed`
  else if (cargo) witnessed = `Cargo operations involving ${cargo} were witnessed`
  else witnessed = "Cargo operations were witnessed"
  return sentence(
    `${witnessed}, and cargo-system condition, operational procedures, associated records and crew familiarity were reviewed as far as practicable during the attendance`,
  )
}

function bunkeringSentence(inputs: PreambleInputs, base: string) {
  if (!inputs.bunkeringWitnessed) return "" // never describe bunkering that was not witnessed
  const fuel = cleanFragment(inputs.fuelGrade)
  const port = placeName(inputs.bunkeringPort)
  const rest = "the associated procedures, communications, safety precautions and records were reviewed"
  if (fuel) return sentence(`Bunkering of ${fuel}${port ? ` at ${place(port)}` : ""} was witnessed, and ${rest}`)
  if (port) return sentence(`Bunkering operations at ${place(port)} were witnessed, and ${rest}`)
  return base
}

function sireSentence(inputs: PreambleInputs, base: string) {
  const date = formatDate(inputs.expectedSireDate)
  if (!date) return base
  return sentence(
    `The vessel’s readiness for the forthcoming SIRE 2.0 inspection, expected on ${date}, was reviewed, including machinery condition, operational readiness, documentation, housekeeping and crew familiarisation`,
  )
}

function focusSentences(inputs: PreambleInputs) {
  const sentences: string[] = []
  for (const area of FOCUS_AREAS) {
    if (area.id === "NONE" || !inputs.additionalFocusAreas.includes(area.id)) continue
    switch (area.id) {
      case "PREVIOUS_INSPECTION":
        sentences.push(previousInspectionSentence(inputs))
        break
      case "CARGO_OPERATIONS":
        sentences.push(cargoSentence(inputs, area.text))
        break
      case "BUNKERING_OPERATIONS":
        sentences.push(bunkeringSentence(inputs, area.text))
        break
      case "SIRE_PREPARATION":
        sentences.push(sireSentence(inputs, area.text))
        break
      default:
        sentences.push(area.text)
    }
  }
  // Vary the opening of repeated "Particular attention was given to" sentences.
  let attention = 0
  return sentences.filter(Boolean).map((text) => {
    if (!text.startsWith(PARTICULAR_ATTENTION)) return text
    const opening = ATTENTION_VARIANTS[Math.min(attention++, ATTENTION_VARIANTS.length - 1)]
    return opening + text.slice(PARTICULAR_ATTENTION.length)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Paragraph 4: findings, follow-up and acknowledgment
// ---------------------------------------------------------------------------------------------------------------

function followUpSentence(inputs: PreambleInputs) {
  if (inputs.followUpMethods.includes("NO_SEPARATE_RECORD")) return ""
  const nouns: string[] = FOLLOW_UP_METHODS.filter((m) => m.noun && inputs.followUpMethods.includes(m.id)).map((m) => m.noun)
  if (inputs.followUpMethods.includes("OTHER")) {
    const custom = cleanFragment(inputs.customFollowUpMethod).replace(/^the\s+/i, "")
    if (custom) nouns.push(custom)
  }
  if (!nouns.length) return ""
  return sentence(`Items requiring further action have been included in ${joinWithArticle(nouns)} for tracking through to closure`)
}

// ---------------------------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------------------------

export function generatePreamble(rawInputs: PreambleInputs, facts: PreambleFacts): GeneratedPreamble {
  const inputs = pruneHidden(rawInputs)

  const objectives = objectivesSentences(inputs)
  const conditions = findOption(OPERATING_CONDITIONS, inputs.operatingCondition)?.label ?? "the conditions prevailing during the attendance"

  const raw: Record<ParagraphId, string> = {
    attendance: paragraph([attendanceSentence(inputs, facts), dockingSentence(inputs, facts), ...newbuildingSentences(inputs, facts)]),
    objectives: paragraph([
      findOption(OPENING_MEETINGS, inputs.openingMeeting)?.text ?? "",
      ...objectives.sentences,
      sentence(`${objectives.stated ? "It" : "The inspection"} covered ${STANDARD_SCOPE}`),
    ]),
    examination: paragraph([
      sentence(
        `Machinery and systems were examined and tested, where practicable, under ${conditions}, and the available records were reviewed to verify maintenance quality, equipment reliability and operational readiness`,
      ),
      ...focusSentences(inputs),
      cleanSentences(inputs.additionalNote),
      DISCUSSION_TEXT,
    ]),
    findings: paragraph([
      findOption(DEFICIENCY_STATUSES, inputs.deficiencyStatus)?.text ?? NEUTRAL_FINDINGS_TEXT,
      followUpSentence(inputs),
      findOption(CLOSING_STATEMENTS, inputs.closingStatement)?.text ?? "",
    ]),
  }

  const paragraphs = PARAGRAPHS.map(({ id, title }) => ({
    id,
    title,
    segments: toSegments(tidy(raw[id])),
    text: removeGaps(raw[id]),
    incomplete: hasGap(raw[id]),
  }))
  const text = paragraphs.map((p) => p.text).filter(Boolean).join("\n\n")
  return { paragraphs, text, incomplete: paragraphs.some((p) => p.incomplete), wordCount: wordCount(text) }
}
