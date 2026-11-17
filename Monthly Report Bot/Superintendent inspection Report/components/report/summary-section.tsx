"use client"

import { Check } from "lucide-react"
import { useRef, useState, type KeyboardEvent } from "react"
import type { useReportEditor } from "@/hooks/use-report-editor"
import type { Report } from "@/lib/form-schema"
import { SUMMARY_SECTIONS } from "@/lib/narrative/sections"
import { cn } from "@/lib/utils"
import { SectionBuilder } from "./narrative/section-builder"
import { PreambleBuilder } from "./preamble/preamble-builder"

type Editor = ReturnType<typeof useReportEditor>

type Props = {
  report: Report
  update: Editor["update"]
  saveNow: Editor["saveNow"]
}

// Every Executive Summary field is generated from structured selections; none is offered as a free-text box.
const TABS = [
  { id: "preamble", label: "Preamble", summaryKey: "preamble" },
  ...SUMMARY_SECTIONS.map((spec) => ({ id: spec.id, label: spec.tab, summaryKey: spec.summaryKey })),
]

export function SummarySection({ report, update, saveNow }: Props) {
  const [tab, setTab] = useState<string>("preamble")
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length
    setTab(TABS[next].id)
    refs.current[TABS[next].id]?.focus()
  }

  const spec = SUMMARY_SECTIONS.find((s) => s.id === tab)

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" aria-label="Executive Summary parts" className="flex flex-wrap gap-1 rounded-lg border bg-muted/60 p-1">
        {TABS.map((t) => {
          const saved = Boolean((report.summary[t.summaryKey] ?? "").trim())
          return (
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
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {saved && <Check className="size-3.5 text-success" aria-hidden />}
              {t.label}
              {!saved && (
                <span aria-hidden className="text-destructive" title="Mandatory: save the generated text to the report">
                  *
                </span>
              )}
              <span className="sr-only">{saved ? "(text saved)" : "(mandatory, not yet saved)"}</span>
            </button>
          )
        })}
      </div>

      <div role="tabpanel" id={`summary-panel-${tab}`} aria-labelledby={`summary-tab-${tab}`}>
        {spec ? (
          <SectionBuilder key={spec.id} spec={spec} report={report} update={update} saveNow={saveNow} />
        ) : (
          <PreambleBuilder report={report} update={update} saveNow={saveNow} />
        )}
      </div>
    </div>
  )
}
