"use client"

import { Textarea } from "@/components/ui/textarea"
import { COVERAGE_LABELS, findingRef, isGraded, severity, type Coverage } from "@/lib/condition-overview"
import {
  RATINGS,
  SAFETY_CRITICAL_ITEMS,
  effectiveRating,
  emptyFinding,
  isLegacyToRerate,
  needsFinding,
  needsRemarks,
  ratingLabel,
  type ConditionEntry,
  type ConditionItem,
  type CurrentRating,
  type Rating,
} from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { Check, CircleCheck, CircleMinus, EyeOff, Info, OctagonAlert, ThumbsUp, TriangleAlert } from "lucide-react"
import { useRef } from "react"
import { FindingFields } from "./finding-fields"
import { FormatToolbar } from "./format-toolbar"

const RATING_OPTIONS: Record<CurrentRating, { cue: string; icon: typeof CircleCheck; tone: keyof typeof RATING_STYLES }> = {
  satisfactory: { cue: "As expected", icon: CircleCheck, tone: "green" },
  acceptable: { cue: "Minor wear", icon: ThumbsUp, tone: "blue" },
  degraded: { cue: "Corrective action", icon: TriangleAlert, tone: "amber" },
  deficient: { cue: "Requirement not met", icon: OctagonAlert, tone: "red" },
  notInspected: { cue: "Give the reason", icon: EyeOff, tone: "slate" },
  na: { cue: "Not fitted / out of scope", icon: CircleMinus, tone: "slate" },
}

const RATING_STYLES = {
  green: "border-emerald-500/45 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  blue: "border-sky-500/45 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  red: "border-rose-500/45 bg-rose-500/10 text-rose-800 dark:text-rose-300",
  slate: "border-slate-400/45 bg-slate-500/10 text-slate-700 dark:text-slate-300",
}

const WORST_STYLES: Partial<Record<Rating, string>> = {
  satisfactory: RATING_STYLES.green,
  acceptable: RATING_STYLES.blue,
  fair: RATING_STYLES.amber,
  degraded: RATING_STYLES.amber,
  poor: RATING_STYLES.red,
  deficient: RATING_STYLES.red,
}

const COVERAGE_STYLES: Record<Coverage, string> = {
  complete: RATING_STYLES.green,
  limited: RATING_STYLES.amber,
  incomplete: RATING_STYLES.red,
  notApplicable: RATING_STYLES.slate,
}

type Props = {
  items: ConditionItem[]
  values: Record<string, ConditionEntry>
  /** The condition section's id (e.g. "engine"); also used for finding references such as ENG-02. */
  idPrefix: string
  onChange: (key: string, entry: ConditionEntry) => void
}

export function ConditionList({ items, values, idPrefix, onChange }: Props) {
  const remarksRefs = useRef<Record<string, HTMLTextAreaElement>>({})
  const ratings = items.map((item) => effectiveRating(values[item.key]?.rating))
  const applicable = ratings.filter((r) => r !== "na").length
  const assessed = ratings.filter(isGraded).length
  const unrated = ratings.filter((r) => !r).length
  const notInspected = ratings.filter((r) => r === "notInspected").length
  const worst = ratings.reduce<Rating>((w, r) => (severity(r) > severity(w) ? r : w), "")
  const coverage: Coverage = applicable === 0 ? "notApplicable" : unrated ? "incomplete" : notInspected ? "limited" : "complete"

  const setRating = (key: string, entry: ConditionEntry, rating: Rating) => {
    const next: ConditionEntry = { ...entry, rating }
    if (needsFinding(rating) && !entry.finding) next.finding = emptyFinding(SAFETY_CRITICAL_ITEMS.includes(key))
    onChange(key, next)
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 text-xs" aria-label="Area summary">
        <span className="text-muted-foreground">
          Assessed <span className="font-mono font-semibold text-foreground">{assessed}/{applicable}</span>
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">Worst observed condition</span>
        <span className={cn("rounded-full border px-2 py-0.5 font-semibold", worst ? WORST_STYLES[worst] : RATING_STYLES.slate)}>
          {worst ? ratingLabel(worst) : "Not assessed"}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">Coverage</span>
        <span className={cn("rounded-full border px-2 py-0.5 font-semibold", COVERAGE_STYLES[coverage])}>{COVERAGE_LABELS[coverage]}</span>
      </section>

      <details className="rounded-xl border bg-card p-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-2 font-medium text-foreground">
          <Info className="size-3.5" aria-hidden /> Rating definitions
        </summary>
        <dl className="mt-2 grid gap-1.5 sm:grid-cols-[8rem_1fr]">
          {RATINGS.map((r) => (
            <div key={r.value} className="contents">
              <dt className="font-semibold text-foreground">{r.label}</dt>
              <dd>{r.definition}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2">Condition ratings describe the observed condition. They are not risk ratings: risk is assessed under the Company’s risk assessment procedure.</p>
      </details>

      <ol className="flex flex-col gap-3">
        {items.map((item, index) => {
          const entry = values[item.key] ?? { rating: "" as Rating, remarks: "" }
          const current = effectiveRating(entry.rating)
          const remarksRef = { get current() { return remarksRefs.current[item.key] ?? null } }
          const labelId = `${idPrefix}-${item.key}-label`
          const remarksNeeded = needsRemarks(current)
          return (
            <li
              key={item.key}
              className={cn(
                "flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors",
                current === "deficient" && "border-destructive/50",
                current === "degraded" && "border-amber-500/50",
              )}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <div className="flex flex-col">
                  <span id={labelId} className="text-sm font-semibold leading-snug">
                    {item.label}{" "}
                    <span aria-hidden className="text-destructive" title="Mandatory: rate every item">*</span>
                    <span className="sr-only">(rating mandatory)</span>
                  </span>
                  {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
                </div>
              </div>

              {isLegacyToRerate(entry.rating) && (
                <p className="rounded-lg border border-amber-500/45 bg-amber-500/10 p-2.5 text-xs text-amber-900 dark:text-amber-200">
                  Rated <strong>{ratingLabel(entry.rating)}</strong>. Choose a rating on the current scale.
                </p>
              )}

              <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                {RATINGS.map((r) => {
                  const active = current === r.value
                  const option = RATING_OPTIONS[r.value]
                  const Icon = option.icon
                  return (
                    <button
                      key={r.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-active={active}
                      title={r.definition}
                      onClick={() => setRating(item.key, entry, active ? "" : r.value)}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        active ? RATING_STYLES[option.tone] : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs font-semibold">{r.label}</span>
                        <span className="text-[10px] opacity-75">{option.cue}</span>
                      </span>
                      {active && <Check className="ml-auto size-3.5 shrink-0" aria-hidden />}
                    </button>
                  )
                })}
              </div>

              <div>
                <FormatToolbar value={entry.remarks} onChange={(remarks) => onChange(item.key, { ...entry, remarks })} inputRef={remarksRef} />
                <Textarea
                  ref={(element) => {
                    if (element) remarksRefs.current[item.key] = element
                    else delete remarksRefs.current[item.key]
                  }}
                  aria-label={`${item.label} remarks${remarksNeeded ? " (mandatory)" : ""}`}
                  aria-invalid={remarksNeeded && !entry.remarks.trim() ? true : undefined}
                  value={entry.remarks}
                  onChange={(e) => onChange(item.key, { ...entry, remarks: e.target.value })}
                  placeholder={
                    current === "notInspected"
                      ? "* Mandatory: why it could not be inspected (e.g. tanks loaded, no gas-free certificate, no access)…"
                      : remarksNeeded
                        ? "* Mandatory: the finding – what, where, extent and the evidence seen…"
                        : "Findings, observations, recommendations…"
                  }
                  className="min-h-20 resize-y rounded-t-none text-sm leading-relaxed"
                />
              </div>

              {needsFinding(current) && (
                <FindingFields
                  findingRef={findingRef(idPrefix, index)}
                  finding={entry.finding ?? emptyFinding(SAFETY_CRITICAL_ITEMS.includes(item.key))}
                  deficient={current === "deficient"}
                  idPrefix={`${idPrefix}-${item.key}`}
                  onChange={(finding) => onChange(item.key, { ...entry, finding })}
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
