import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEmptyReport } from "../../lib/form-schema"
import { buildReportContext, emptyReportContext, vesselConditionFrom, type VesselCondition } from "../../lib/narrative/context"
import { defaultPreambleInputs, type PreambleInputs } from "../../lib/narrative/preamble/model"
import {
  defaultSectionInputs,
  generateSection,
  isShown,
  normaliseSectionState,
  sectionFields,
  validateSection,
  type SectionInputs,
  type SectionSpec,
} from "../../lib/narrative/section"
import { HULL_SECTION } from "../../lib/narrative/sections/hull"
import { OPERATIONAL_SECTION } from "../../lib/narrative/sections/operational"
import { STRUCTURAL_SECTION } from "../../lib/narrative/sections/structural"

const preamble = (patch: Partial<PreambleInputs>) => ({ ...defaultPreambleInputs(), ...patch }) as PreambleInputs
const ctxIn = (vesselCondition: VesselCondition) => emptyReportContext({ startDate: "2026-11-17", vesselCondition })
const savedPreamble = (inputs: PreambleInputs) => ({ status: "DRAFT" as const, inputs, generatedText: "", lastGeneratedAt: null, updatedAt: 1 })

function warnings(spec: SectionSpec, patch: SectionInputs, condition: VesselCondition) {
  const ctx = ctxIn(condition)
  const inputs = { ...defaultSectionInputs(spec), ...patch }
  return validateSection(spec, inputs, ctx, generateSection(spec, inputs, ctx)).warnings.map((w) => w.message)
}

describe("vessel condition stated once in the Preamble", () => {
  test("laden / ballast and sea / port / dry-dock are read from the Preamble", () => {
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "LADEN_PASSAGE" })), { loading: "LADEN", situation: "SEA" })
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "BALLAST_PASSAGE" })), { loading: "BALLAST", situation: "SEA" })
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "ALONGSIDE", loadingCondition: "BALLAST" })), { loading: "BALLAST", situation: "PORT" })
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "AT_ANCHORAGE", loadingCondition: "LADEN" })), { loading: "LADEN", situation: "PORT" })
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "SCHEDULED_DRY_DOCKING" })), { loading: "", situation: "DRY_DOCK" })
    assert.deepEqual(vesselConditionFrom(preamble({})), { loading: "", situation: "" })
  })

  test("a stale answer hidden by a later Preamble change is ignored", () => {
    // Laden was chosen while alongside; the status was then changed to dry-docking, which hides the question.
    assert.deepEqual(vesselConditionFrom(preamble({ vesselStatus: "SPECIAL_SURVEY_DRY_DOCKING", loadingCondition: "LADEN" })), { loading: "", situation: "DRY_DOCK" })
  })

  test("the report context carries it from the saved Preamble", () => {
    const r = createEmptyReport("ctx")
    r.narratives = { preamble: savedPreamble(preamble({ vesselStatus: "LADEN_PASSAGE" })) }
    assert.deepEqual(buildReportContext(r).vesselCondition, { loading: "LADEN", situation: "SEA" })
  })
})

describe("Hull page uses it without asking", () => {
  const loadField = sectionFields(HULL_SECTION).find(({ field }) => field.key === "load")!.field
  const base: SectionInputs = { ...defaultSectionInputs(HULL_SECTION), vantage: ["BOARDING"], plating: "SOUND", markings: "CLEAR", coating: "INTACT" }

  test("the laden / ballast question is hidden when the Preamble states it, and the Preamble's answer is written", () => {
    const ctx = ctxIn({ loading: "BALLAST", situation: "PORT" })
    assert.equal(isShown(loadField, base, ctx, base), false)
    assert.match(generateSection(HULL_SECTION, { ...base, load: "LADEN" }, ctx).text, /^The hull above the waterline was examined while boarding, with the vessel in ballast condition\./)
    assert.deepEqual(HULL_SECTION.facts!(ctx), [["Vessel condition (from the Preamble)", "ballast, in port"]])
  })

  test("only when the Preamble is silent is it asked here, as a fallback", () => {
    const ctx = ctxIn({ loading: "", situation: "" })
    assert.equal(isShown(loadField, base, ctx, base), true)
    assert.match(generateSection(HULL_SECTION, { ...base, load: "LADEN" }, ctx).text, /with the vessel in laden condition\./)
    assert.match(HULL_SECTION.facts!(ctx)[0][1], /not stated – set it in the Preamble/)
  })

  test("examination from the berth at sea, or outside the dock during dry-docking, is flagged", () => {
    assert.ok(warnings(HULL_SECTION, { ...base, vantage: ["BERTH"] }, { loading: "LADEN", situation: "SEA" }).some((m) => /at sea/.test(m)))
    assert.ok(warnings(HULL_SECTION, { ...base, vantage: ["BOARDING"] }, { loading: "", situation: "DRY_DOCK" }).some((m) => /dry-dock/.test(m)))
    assert.ok(warnings(HULL_SECTION, { ...base, vantage: ["DRY_DOCK"] }, { loading: "", situation: "PORT" }).some((m) => /in port/.test(m)))
  })

  test("a new Hull page in dry-dock starts with the hull examined in dry-dock", () => {
    const r = createEmptyReport("dock")
    r.narratives = { preamble: savedPreamble(preamble({ vesselStatus: "SCHEDULED_DRY_DOCKING" })) }
    assert.deepEqual(normaliseSectionState(HULL_SECTION, undefined, HULL_SECTION.seed!(r)).inputs.vantage, ["DRY_DOCK"])
  })
})

describe("other sections are checked against it", () => {
  test("Structural: ballast tanks ballasted while laden, cargo tanks loaded while in ballast", () => {
    assert.ok(warnings(STRUCTURAL_SECTION, { wbtMethod: ["NOT_INSPECTED"], wbtReason: "BALLASTED" }, { loading: "LADEN", situation: "PORT" }).some((m) => /laden/.test(m)))
    assert.ok(warnings(STRUCTURAL_SECTION, { cargoTanks: "LOADED" }, { loading: "BALLAST", situation: "PORT" }).some((m) => /in ballast/.test(m)))
    assert.ok(!warnings(STRUCTURAL_SECTION, { cargoTanks: "LOADED" }, { loading: "LADEN", situation: "PORT" }).some((m) => /Preamble/.test(m)))
  })

  test("Operational: cargo machinery at sea while in port, observed while at sea, no cargo while laden", () => {
    assert.ok(warnings(OPERATIONAL_SECTION, { cargo: "UNDERWAY" }, { loading: "LADEN", situation: "PORT" }).some((m) => /in port/.test(m)))
    assert.ok(warnings(OPERATIONAL_SECTION, { cargo: "OBSERVED" }, { loading: "LADEN", situation: "SEA" }).some((m) => /at sea/.test(m)))
    assert.ok(warnings(OPERATIONAL_SECTION, { cargo: "NO_CARGO" }, { loading: "LADEN", situation: "SEA" }).some((m) => /laden/.test(m)))
    assert.ok(!warnings(OPERATIONAL_SECTION, { cargo: "UNDERWAY" }, { loading: "LADEN", situation: "SEA" }).some((m) => /Preamble/.test(m)))
  })
})
