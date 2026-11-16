"use client"

import { useRef, useState, type KeyboardEvent } from "react"
import type { useReportEditor } from "@/hooks/use-report-editor"
import { SUMMARY_FIELDS, type Report } from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { FieldGroups } from "./field-grid"
import { PreambleBuilder } from "./preamble/preamble-builder"

type Editor = ReturnType<typeof useReportEditor>

type Props = {
  report: Report
  update: Editor["update"]
  saveNow: Editor["saveNow"]
  onChange: (key: string, value: string) => void
}

const TABS = [
  { id: "preamble", label: "Preamble" },
  { id: "other", label: "Other summary fields" },
] as const

type TabId = (typeof TABS)[number]["id"]

// The Preamble is generated from structured selections, so it is not offered as a free-text box here.
const OTHER_FIELDS = SUMMARY_FIELDS.filter((field) => field.key !== "preamble")

export function SummarySection({ report, update, saveNow, onChange }: Props) {
  const [tab, setTab] = useState<TabId>("preamble")
  const refs = useRef<Record<TabId, HTMLButtonElement | null>>({ preamble: null, other: null })

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length
    setTab(TABS[next].id)
    refs.current[TABS[next].id]?.focus()
  }

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Executive Summary parts" className="inline-flex w-fit gap-1 rounded-lg border bg-muted/60 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`summary-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`summary-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={onKeyDown}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`summary-panel-${tab}`} aria-labelledby={`summary-tab-${tab}`}>
        {tab === "preamble" ? (
          <PreambleBuilder report={report} update={update} saveNow={saveNow} />
        ) : (
          <FieldGroups groups={[{ fields: OTHER_FIELDS }]} values={report.summary} idPrefix="summary" onChange={onChange} />
        )}
      </div>
    </div>
  )
}
