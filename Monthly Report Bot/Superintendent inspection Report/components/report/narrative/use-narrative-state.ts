"use client"

import { useMemo } from "react"
import type { useReportEditor } from "@/hooks/use-report-editor"
import type { Narratives, Report } from "@/lib/form-schema"
import type { NarrativeState } from "@/lib/narrative/types"

type Editor = ReturnType<typeof useReportEditor>

export type StateChange<S> = (mutate: (current: S, report: Report) => Partial<S>, extra?: (report: Report) => Partial<Report>) => void

/**
 * Reads and writes one narrative section's state in `report.narratives[key]`. Every change starts from the latest
 * report held by the editor (never a stale render) and stamps `updatedAt`; the editor's autosave and sync do the rest.
 */
export function useNarrativeState<S extends NarrativeState<Record<string, unknown>>>(
  report: Report,
  update: Editor["update"],
  key: keyof Narratives,
  normalise: (raw: unknown, report: Report) => S,
) {
  const state = useMemo(() => normalise(report.narratives?.[key], report), [report, key, normalise])
  const locked = state.status === "FINAL"

  const change: StateChange<S> = (mutate, extra) =>
    update((r) => {
      const current = normalise(r.narratives?.[key], r)
      const next = { ...current, ...mutate(current, r), updatedAt: Date.now() }
      return { ...r, ...extra?.(r), narratives: { ...r.narratives, [key]: next } }
    })

  const setInputs = (patch: Partial<S["inputs"]>) => {
    if (locked) return
    change((current) => ({ inputs: { ...current.inputs, ...patch } }) as Partial<S>)
  }

  return { state, locked, change, setInputs }
}
