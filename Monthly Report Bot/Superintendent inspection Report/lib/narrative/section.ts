// Generic engine for controlled-narrative sections defined as data (field specs + a generator).
// The Preamble predates this engine and keeps its own model; every other Executive Summary section uses this one.
// Pure TypeScript: no React, no browser APIs.

import type { Report } from "../form-schema"
import { isValidIsoDate } from "./dates"
import type { ReportContext } from "./context"
import { hasGap, placeholderProblems, removeGaps, tidy, toSegments, wordCount, type Segment } from "./text"
import type { Issue, NarrativeSectionId, NarrativeState, ValidationResult } from "./types"

// ---------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------

export type ScalarValue = string | string[] | boolean
export type ItemValue = { id: string } & Record<string, ScalarValue>
export type InputValue = ScalarValue | ItemValue[]
export type SectionInputs = Record<string, InputValue>
export type SectionState = NarrativeState<SectionInputs>

// ---------------------------------------------------------------------------------------------------------------
// Field specs
// ---------------------------------------------------------------------------------------------------------------

export type OptionDef = { readonly id: string; readonly label: string }

/** `scope` is the section inputs for top-level fields, or the item for fields inside an item list. */
export type ShowIf = (scope: Record<string, InputValue>, ctx: ReportContext, inputs: SectionInputs) => boolean

type BaseSpec = {
  key: string
  label: string
  hint?: string
  tooltip?: string
  required?: boolean
  showIf?: ShowIf
  /** Full width in a two-column layout. */
  wide?: boolean
}

export type SelectSpec = BaseSpec & { kind: "select"; options: readonly OptionDef[]; placeholder?: string; default?: string }
export type MultiSpec = BaseSpec & { kind: "multi"; options: readonly OptionDef[]; exclusive?: string; columns?: 1 | 2; default?: string[] }
export type TextSpec = BaseSpec & { kind: "text"; placeholder?: string }
export type DateSpec = BaseSpec & { kind: "date" }
export type ConfirmSpec = BaseSpec & { kind: "confirm"; default?: boolean }
export type NoteSpec = BaseSpec & { kind: "note"; placeholder?: string }
export type ItemFieldSpec = SelectSpec | MultiSpec | TextSpec | DateSpec | ConfirmSpec
export type ItemsSpec = BaseSpec & { kind: "items"; itemLabel: string; max: number; fields: ItemFieldSpec[]; addLabel?: string }
export type FieldSpec = ItemFieldSpec | NoteSpec | ItemsSpec

export type GroupSpec = { title: string; description?: string; showIf?: ShowIf; fields: FieldSpec[] }

export type ParagraphDraft = { id: string; title: string; raw: string }

export type GeneratedNarrative = {
  paragraphs: { id: string; title: string; segments: Segment[]; text: string; incomplete: boolean }[]
  text: string
  incomplete: boolean
  wordCount: number
}

export type SectionSpec = {
  id: Exclude<NarrativeSectionId, "preamble">
  /** Key of the plain-text field in `report.summary` that receives the generated text (also used in element ids). */
  summaryKey: string
  /** Where the saved text lives when it is not `report.summary[summaryKey]` (e.g. a condition item's remarks). */
  target?: { read: (report: Report) => string; write: (report: Report, text: string, summary?: string) => Partial<Report> }
  /** Facts this section takes from elsewhere in the report (shown above the form, never asked again). */
  facts?: (ctx: ReportContext) => [label: string, value: string][]
  /** Short statement of the defects selected (for the findings register), saved with the text; "" when none. */
  summary?: (inputs: SectionInputs, ctx: ReportContext) => string
  /** Heading of the builder; defaults to "Executive Summary – <title>". */
  heading?: string
  /** Starting selections for a report that has none saved yet, taken from elsewhere in the report. */
  seed?: (report: Report) => Record<string, unknown>
  title: string
  tab: string
  description: string
  groups: GroupSpec[]
  /** Builds the paragraphs; receives inputs with hidden fields already reset to defaults. */
  paragraphs: (inputs: SectionInputs, ctx: ReportContext) => ParagraphDraft[]
  /** Section-specific checks on top of the generic required/date/placeholder checks. */
  validate?: (inputs: SectionInputs, ctx: ReportContext, issues: { error: (f: string, m: string) => void; warn: (f: string, m: string) => void }) => void
  /** Plain-language summary of the selections, for comparing with the output. */
  selections?: (inputs: SectionInputs, ctx: ReportContext) => [string, string][]
}

// ---------------------------------------------------------------------------------------------------------------
// Defaults, restoring saved data, visibility
// ---------------------------------------------------------------------------------------------------------------

function defaultFor(field: FieldSpec): InputValue {
  switch (field.kind) {
    case "select":
      return field.default ?? ""
    case "multi":
      return [...(field.default ?? [])]
    case "confirm":
      return field.default ?? false
    case "items":
      return []
    default:
      return ""
  }
}

export function sectionFields(spec: SectionSpec): { field: FieldSpec; group: GroupSpec }[] {
  return spec.groups.flatMap((group) => group.fields.map((field) => ({ field, group })))
}

export function defaultSectionInputs(spec: SectionSpec): SectionInputs {
  return Object.fromEntries(sectionFields(spec).map(({ field }) => [field.key, defaultFor(field)]))
}

function normaliseScalar(field: ItemFieldSpec | NoteSpec, value: unknown): ScalarValue {
  switch (field.kind) {
    case "select":
      return typeof value === "string" && (value === "" || field.options.some((o) => o.id === value)) ? value : (defaultFor(field) as string)
    case "multi": {
      const chosen = new Set(Array.isArray(value) ? value : [])
      return field.options.filter((o) => chosen.has(o.id)).map((o) => o.id)
    }
    case "confirm":
      return typeof value === "boolean" ? value : (defaultFor(field) as boolean)
    default:
      return typeof value === "string" ? value : ""
  }
}

export function normaliseItem(fields: ItemFieldSpec[], raw: unknown, index: number): ItemValue {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const item: ItemValue = { id: typeof r.id === "string" && r.id ? r.id : `item-${index + 1}` }
  for (const field of fields) item[field.key] = normaliseScalar(field, r[field.key])
  return item
}

/** Restores saved inputs: unknown option ids fall back to defaults, lists keep their fixed option order. */
export function normaliseSectionInputs(spec: SectionSpec, raw: unknown): SectionInputs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const inputs: SectionInputs = {}
  for (const { field } of sectionFields(spec)) {
    if (field.kind === "items") {
      const list = Array.isArray(r[field.key]) ? (r[field.key] as unknown[]) : []
      inputs[field.key] = list.slice(0, field.max).map((item, i) => normaliseItem(field.fields, item, i))
    } else {
      inputs[field.key] = r[field.key] === undefined ? defaultFor(field) : normaliseScalar(field, r[field.key])
    }
  }
  return inputs
}

export function normaliseSectionState(spec: SectionSpec, raw: unknown, seed?: Record<string, unknown>): SectionState {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : seed ? { inputs: seed } : {}
  const status = r.status === "UNDER_REVIEW" || r.status === "FINAL" ? r.status : "DRAFT"
  return {
    status,
    inputs: normaliseSectionInputs(spec, r.inputs),
    generatedText: typeof r.generatedText === "string" ? r.generatedText : "",
    lastGeneratedAt: typeof r.lastGeneratedAt === "number" ? r.lastGeneratedAt : null,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  }
}

export function isShown(field: { showIf?: ShowIf }, scope: Record<string, InputValue>, ctx: ReportContext, inputs: SectionInputs) {
  return field.showIf ? field.showIf(scope, ctx, inputs) : true
}

/** Resets every hidden field (and hidden fields inside items) to its default, so stale values never reach the text. */
export function pruneSectionInputs(spec: SectionSpec, inputs: SectionInputs, ctx: ReportContext): SectionInputs {
  const pruned: SectionInputs = { ...inputs }
  for (const { field, group } of sectionFields(spec)) {
    const visible = isShown(group, inputs, ctx, inputs) && isShown(field, inputs, ctx, inputs)
    if (!visible) {
      pruned[field.key] = defaultFor(field)
      continue
    }
    if (field.kind === "items") {
      pruned[field.key] = ((inputs[field.key] as ItemValue[]) ?? []).map((item) => {
        const clean: ItemValue = { ...item }
        for (const sub of field.fields) if (!isShown(sub, item, ctx, inputs)) clean[sub.key] = defaultFor(sub) as ScalarValue
        return clean
      })
    }
  }
  return pruned
}

// ---------------------------------------------------------------------------------------------------------------
// Generation and validation
// ---------------------------------------------------------------------------------------------------------------

export function generateSection(spec: SectionSpec, rawInputs: SectionInputs, ctx: ReportContext): GeneratedNarrative {
  const inputs = pruneSectionInputs(spec, rawInputs, ctx)
  const paragraphs = spec.paragraphs(inputs, ctx)
    .map((p) => ({ ...p, raw: tidy(p.raw) }))
    .filter((p) => p.raw)
    .map((p) => ({ id: p.id, title: p.title, segments: toSegments(p.raw), text: removeGaps(p.raw), incomplete: hasGap(p.raw) }))
  const text = paragraphs.map((p) => p.text).filter(Boolean).join("\n\n")
  return { paragraphs, text, incomplete: paragraphs.some((p) => p.incomplete), wordCount: wordCount(text) }
}

/** DOM id / issue id of a field, or of a field inside an item. */
export function sectionFieldId(sectionId: string, key: string, index?: number, sub?: string) {
  return index === undefined ? `narr-${sectionId}-${key}` : `narr-${sectionId}-${key}-${index}-${sub}`
}

const blankValue = (value: InputValue | undefined) =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "string" && !value.trim())

const hasPlaceholder = (text: string) => placeholderProblems(text.replace(/\s+/g, " ").trim()).some((p) => !/space|punctuation/i.test(p))

function checkScalar(
  field: ItemFieldSpec | NoteSpec,
  value: InputValue | undefined,
  id: string,
  error: (f: string, m: string) => void,
) {
  if (field.required && blankValue(value)) {
    error(id, field.kind === "multi" ? `Select at least one option for “${field.label}”.` : field.kind === "select" ? `Select “${field.label}”.` : `Enter “${field.label}”.`)
    return
  }
  if (field.kind === "date" && typeof value === "string" && value.trim() && !isValidIsoDate(value)) error(id, "Enter a valid date.")
  if ((field.kind === "text" || field.kind === "note") && typeof value === "string" && hasPlaceholder(value)) {
    error(id, "Remove placeholder text such as [ ], { } or TBA.")
  }
  if (field.kind === "multi" && field.exclusive && Array.isArray(value) && (value as string[]).includes(field.exclusive) && value.length > 1) {
    const label = field.options.find((o) => o.id === field.exclusive)?.label ?? field.exclusive
    error(id, `“${label}” cannot be combined with other options.`)
  }
}

export function validateSection(spec: SectionSpec, rawInputs: SectionInputs, ctx: ReportContext, generated?: GeneratedNarrative): ValidationResult {
  const inputs = pruneSectionInputs(spec, rawInputs, ctx)
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const error = (field: string, message: string) => errors.push({ field, message })
  const warn = (field: string, message: string) => warnings.push({ field, message })

  for (const { field, group } of sectionFields(spec)) {
    if (!isShown(group, inputs, ctx, inputs) || !isShown(field, inputs, ctx, inputs)) continue
    const id = sectionFieldId(spec.id, field.key)
    if (field.kind === "items") {
      const items = (inputs[field.key] as ItemValue[]) ?? []
      if (field.required && !items.length) error(id, `Add at least one ${field.itemLabel.toLowerCase()}.`)
      items.forEach((item, index) => {
        for (const sub of field.fields) {
          if (!isShown(sub, item, ctx, inputs)) continue
          checkScalar(sub, item[sub.key], sectionFieldId(spec.id, field.key, index, sub.key), error)
        }
      })
      continue
    }
    checkScalar(field, inputs[field.key], id, error)
  }

  spec.validate?.(inputs, ctx, { error, warn })

  if (generated && !errors.length) {
    const problems = placeholderProblems(generated.text)
    if (problems.length) error("preview", `The generated text needs attention: ${problems.join("; ")}.`)
  }
  return { errors, warnings }
}

/** Builds a gap-marked paragraph draft list helper: drops empty sentences. */
export function para(id: string, title: string, sentences: (string | false | null | undefined)[]): ParagraphDraft {
  return { id, title, raw: sentences.filter(Boolean).join(" ") }
}
