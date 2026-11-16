import assert from "node:assert/strict"
import { generatePreamble, type GeneratedPreamble } from "../../lib/narrative/preamble/generate"
import { defaultPreambleInputs, type PreambleFacts, type PreambleInputs } from "../../lib/narrative/preamble/model"
import { placeholderProblems } from "../../lib/narrative/text"

export const FACTS: PreambleFacts = { vesselName: "DHT LEOPARD", startDate: "2026-09-25", endDate: "2026-09-30" }

export function inputs(patch: Partial<PreambleInputs> = {}): PreambleInputs {
  return {
    ...defaultPreambleInputs(),
    primaryObjectives: ["OVERALL_CONDITION"],
    location: "Singapore",
    ...patch,
  }
}

export function generate(patch: Partial<PreambleInputs> = {}, facts: Partial<PreambleFacts> = {}) {
  return generatePreamble(inputs(patch), { ...FACTS, ...facts })
}

/** Checks every rule that applies to any finished preamble. */
export function assertProfessional(result: GeneratedPreamble) {
  const { text } = result
  assert.deepEqual(placeholderProblems(text), [], "no placeholders or broken punctuation")
  assert.equal(result.paragraphs.filter((p) => p.text).length, 4, "four paragraphs")
  for (const p of result.paragraphs) {
    assert.match(p.text, /^[A-Z]/, `paragraph "${p.id}" starts with a capital letter`)
    assert.match(p.text, /\.$/, `paragraph "${p.id}" ends with a full stop`)
  }
  assert.doesNotMatch(text, /[.!?] +[a-z]/, "every sentence starts with a capital letter")
  assert.doesNotMatch(text, / {2,}/, "no double spaces")
  assert.doesNotMatch(text, /\b(\w+) \1\b/i, "no repeated word")
  assert.doesNotMatch(text, /remained onboard/, "'on board' is adverbial")
  assert.doesNotMatch(text, /machineries/, "'machinery' is uncountable")
}

export function sentences(text: string) {
  return text.split(/(?<=\.)\s+/)
}
