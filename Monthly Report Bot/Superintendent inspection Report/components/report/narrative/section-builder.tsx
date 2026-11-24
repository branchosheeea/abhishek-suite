"use client"

import { useCallback, useMemo } from "react"
import type { useReportEditor } from "@/hooks/use-report-editor"
import type { Report } from "@/lib/form-schema"
import { buildReportContext, type ReportContext } from "@/lib/narrative/context"
import {
  defaultSectionInputs,
  generateSection,
  isShown,
  normaliseSectionState,
  pruneSectionInputs,
  sectionFieldId,
  sectionFields,
  validateSection,
  type ItemValue,
  type SectionInputs,
  type SectionSpec,
} from "@/lib/narrative/section"
import { removeGaps } from "@/lib/narrative/text"
import { NarrativeShell } from "./narrative-shell"
import { SpecForm } from "./spec-form"
import { useNarrativeState } from "./use-narrative-state"

type Editor = ReturnType<typeof useReportEditor>

type Props = { spec: SectionSpec; report: Report; update: Editor["update"]; saveNow: Editor["saveNow"] }

function focusById(field: string) {
  const el = document.getElementById(field === "preview" ? "narrative-preview" : field)
  if (!el) return
  const target = el.matches("input, select, textarea, section")
    ? el
    : el.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, [role=checkbox], button") ?? el
  target.scrollIntoView({ block: "center", behavior: "smooth" })
  target.focus({ preventScroll: true })
}

/** Plain-language list of the visible selections, for comparing with the generated text. */
function describe(spec: SectionSpec, inputs: SectionInputs, ctx: ReportContext): [string, string][] {
  const rows: [string, string][] = []
  for (const { field, group } of sectionFields(spec)) {
    if (field.kind === "note" || !isShown(group, inputs, ctx, inputs) || !isShown(field, inputs, ctx, inputs)) continue
    const value = inputs[field.key]
    if (field.kind === "items") {
      const items = (value as ItemValue[]) ?? []
      items.forEach((item, index) => {
        const first = field.fields.find((f) => f.kind === "select")
        const label = first && first.kind === "select" ? first.options.find((o) => o.id === item[first.key])?.label : ""
        rows.push([`${field.itemLabel} ${index + 1}`, label || "—"])
      })
      continue
    }
    let text = ""
    if (field.kind === "select") text = field.options.find((o) => o.id === value)?.label ?? ""
    else if (field.kind === "multi") text = field.options.filter((o) => (value as string[]).includes(o.id)).map((o) => o.label).join("; ")
    else if (field.kind === "confirm") text = value === true ? "Yes" : ""
    else text = typeof value === "string" ? value : ""
    if (text) rows.push([field.label, text])
  }
  return rows.length ? rows : [["Selections", "None yet"]]
}

/** Facts stated once elsewhere (e.g. laden / ballast in the Preamble) and used here without asking again. */
function CarriedFacts({ facts }: { facts: [string, string][] }) {
  if (!facts.length) return null
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs">
      {facts.map(([label, value]) => (
        <div key={label} className="flex gap-1.5">
          <dt className="text-muted-foreground">{label}:</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SectionBuilder({ spec, report, update, saveNow }: Props) {
  const ctx = useMemo(() => buildReportContext(report), [report])
  const normalise = useCallback((raw: unknown, r: Report) => normaliseSectionState(spec, raw, spec.seed?.(r)), [spec])
  const { state, locked, change, setInputs } = useNarrativeState(report, update, spec.id, normalise)
  const generated = useMemo(() => generateSection(spec, state.inputs, ctx), [spec, state.inputs, ctx])
  const validation = useMemo(() => validateSection(spec, state.inputs, ctx, generated), [spec, state.inputs, ctx, generated])
  const first = spec.groups[0]?.fields[0]

  return (
    <NarrativeShell
      report={report}
      saveNow={saveNow}
      summaryKey={spec.summaryKey}
      readText={spec.target?.read}
      writeText={
        spec.target
          ? (r, text) => spec.target!.write(r, text, spec.summary ? removeGaps(spec.summary(pruneSectionInputs(spec, state.inputs, ctx), ctx)) : undefined)
          : undefined
      }
      heading={spec.heading ?? `Executive Summary – ${spec.title}`}
      description={spec.description}
      state={state}
      change={change}
      defaultInputs={() => defaultSectionInputs(spec)}
      generated={generated}
      validation={validation}
      selections={describe(spec, state.inputs, ctx)}
      focusIssue={focusById}
      firstField={first ? sectionFieldId(spec.id, first.key) : "narrative-preview"}
    >
      {spec.facts && <CarriedFacts facts={spec.facts(ctx)} />}
      <SpecForm spec={spec} inputs={state.inputs} ctx={ctx} validation={validation} disabled={locked} set={setInputs} />
    </NarrativeShell>
  )
}
