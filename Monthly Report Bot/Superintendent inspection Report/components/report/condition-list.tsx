"use client"

import { Textarea } from "@/components/ui/textarea"
import {
  conditionRiskBand,
  conditionRiskScore,
  RATINGS,
  type ConditionEntry,
  type ConditionItem,
  type Rating,
} from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { AlertTriangle, Check, CircleCheck, CircleMinus, Clock3 } from "lucide-react"
import { useRef } from "react"
import { FormatToolbar } from "./format-toolbar"

const RATING_OPTIONS = {
  good: { title: "Satisfactory", cue: "As expected", icon: CircleCheck, tone: "green" },
  fair: { title: "Monitor", cue: "Follow up", icon: Clock3, tone: "amber" },
  poor: { title: "Action required", cue: "Rectify promptly", icon: AlertTriangle, tone: "red" },
  na: { title: "Not applicable", cue: "Outside scope", icon: CircleMinus, tone: "slate" },
} as const

const RATING_STYLES: Record<string, string> = {
  green: "border-emerald-500/45 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  amber: "border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  red: "border-rose-500/45 bg-rose-500/10 text-rose-800 dark:text-rose-300",
  slate: "border-slate-400/45 bg-slate-500/10 text-slate-700 dark:text-slate-300",
}

type Props = {
  items: ConditionItem[]
  values: Record<string, ConditionEntry>
  idPrefix: string
  onChange: (key: string, entry: ConditionEntry) => void
}

export function ConditionList({ items, values, idPrefix, onChange }: Props) {
  const counts = RATINGS.map((r) => ({
    ...r,
    count: items.filter((i) => values[i.key]?.rating === r.value).length,
  }))
  const remarksRefs = useRef<Record<string, HTMLTextAreaElement>>({})
  const scoredValues = Object.fromEntries(
    items.flatMap((item) => values[item.key] ? [[item.key, values[item.key]]] : []),
  )
  const score = conditionRiskScore(scoredValues)
  const markerPosition = score === null ? 0 : ((score - 10) / 90) * 100

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-label="Rating summary">
        {counts.map((c) => (
          <span key={c.value} className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                c.value === "good" && "bg-success",
                c.value === "fair" && "bg-warning",
                c.value === "poor" && "bg-destructive",
                c.value === "na" && "bg-muted-foreground",
              )}
            />
            {c.label} <span className="font-mono font-semibold text-foreground">{c.count}</span>
          </span>
        ))}
      </div>

      <section className="rounded-xl border bg-card p-4" aria-label="Condition risk assessment">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Average condition risk</h3>
          {score === null ? (
            <span className="text-xs text-muted-foreground">Rate an item to calculate</span>
          ) : (
            <span className="font-mono text-sm font-bold">
              {score}% · {conditionRiskBand(score)}
            </span>
          )}
        </div>
        <div
          role="img"
          aria-label={
            score === null
              ? "Risk scale: Low Risk 10 to 30 percent, Moderate Risk 30 to 50 percent, High Risk 50 to 70 percent, Very High Risk 70 to 100 percent"
              : `Average condition risk ${score} percent, ${conditionRiskBand(score)}`
          }
        >
          <div className="relative mx-[5.55%] h-4">
            {score !== null && (
              <span
                className="absolute top-0 z-10 -translate-x-1/2 text-sm leading-none text-foreground"
                style={{ left: `${markerPosition}%` }}
                aria-hidden="true"
              >
                ▼
              </span>
            )}
          </div>
          <div className="flex h-3 overflow-hidden rounded-full">
            <span className="w-[22.22%] bg-[#65a842]" />
            <span className="w-[22.22%] bg-[#e0c52d]" />
            <span className="w-[22.22%] bg-[#ef8b22]" />
            <span className="w-[33.34%] bg-[#cf3c33]" />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>10%</span>
            <span>30%</span>
            <span>50%</span>
            <span>70%</span>
            <span>100%</span>
          </div>
          <div className="mt-2 grid grid-cols-4 text-center text-[10px] font-medium text-muted-foreground">
            <span>Low Risk</span>
            <span>Moderate</span>
            <span>High Risk</span>
            <span>Very High</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Satisfactory = 20%, Monitor = 40%, Action required = 80%; Not applicable and unrated items are excluded.
        </p>
      </section>

      <ol className="flex flex-col gap-3">
        {items.map((item, index) => {
          const entry = values[item.key] ?? { rating: "" as Rating, remarks: "" }
          const remarksRef = { get current() { return remarksRefs.current[item.key] ?? null } }
          const labelId = `${idPrefix}-${item.key}-label`
          return (
            <li
              key={item.key}
              className={cn(
                "flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors",
                entry.rating === "poor" && "border-destructive/50",
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="flex flex-col">
                    <span id={labelId} className="text-sm font-semibold leading-snug">
                      {item.label}
                    </span>
                    {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
                  </div>
                </div>
                <div role="radiogroup" aria-labelledby={labelId} className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                  {RATINGS.map((r) => {
                    const active = entry.rating === r.value
                    const option = RATING_OPTIONS[r.value]
                    const Icon = option.icon
                    return (
                      <button
                        key={r.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        data-active={active}
                        onClick={() => onChange(item.key, { ...entry, rating: active ? "" : r.value })}
                        className={cn("group relative flex min-w-32 items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-w-0 sm:px-3", active ? RATING_STYLES[option.tone] : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground")}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden />
                        <span className="flex min-w-0 flex-col">
                          <span className="whitespace-nowrap text-xs font-semibold">{option.title}</span>
                          <span className="whitespace-nowrap text-[10px] opacity-75">{option.cue}</span>
                        </span>
                        {active && <Check className="ml-auto size-3.5 shrink-0" aria-hidden />}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <FormatToolbar
                  value={entry.remarks}
                  onChange={(remarks) => onChange(item.key, { ...entry, remarks })}
                  inputRef={remarksRef}
                />
                <Textarea
                  ref={(element) => {
                    if (element) remarksRefs.current[item.key] = element
                    else delete remarksRefs.current[item.key]
                  }}
                  aria-label={`${item.label} remarks`}
                  value={entry.remarks}
                  onChange={(e) => onChange(item.key, { ...entry, remarks: e.target.value })}
                  placeholder="Findings, defects, recommendations…"
                  className="min-h-20 resize-y rounded-t-none text-sm leading-relaxed"
                />
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
