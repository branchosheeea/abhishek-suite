"use client"

// Condition & Assurance Overview in the editor (shown in Sign-off): the same facts the PDF overview presents, so the
// Fleet Manager reviews them before approving. Condition is shown by the worst observed condition, never averaged.

import {
  COVERAGE_LABELS,
  areaOverview,
  conclusion,
  findingsRegister,
  keyFigures,
  raPending,
  type Coverage,
} from "@/lib/condition-overview"
import { FINDING_PRIORITIES, ratingLabel, type Rating, type Report } from "@/lib/form-schema"
import { formatDate } from "@/lib/narrative/dates"
import { cn } from "@/lib/utils"
import type { ReactNode } from "react"

const TONE = {
  green: "border-emerald-500/45 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  blue: "border-sky-500/45 bg-sky-500/10 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  red: "border-rose-500/45 bg-rose-500/10 text-rose-800 dark:text-rose-300",
  slate: "border-slate-400/45 bg-slate-500/10 text-slate-700 dark:text-slate-300",
}

const WORST: Partial<Record<Rating, string>> = {
  satisfactory: TONE.green,
  acceptable: TONE.blue,
  fair: TONE.amber,
  degraded: TONE.amber,
  poor: TONE.red,
  deficient: TONE.red,
}

const COVERAGE: Record<Coverage, string> = { complete: TONE.green, limited: TONE.amber, incomplete: TONE.red, notApplicable: TONE.slate }

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cn("inline-block rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap", className)}>{children}</span>
}

export function ConditionOverviewCard({ report }: { report: Report }) {
  const figures = keyFigures(report)
  const areas = areaOverview(report)
  const register = findingsRegister(report)
  const verdict = conclusion(report)
  const tiles = [
    { label: "Coverage", value: `${figures.coverage.assessed} / ${figures.coverage.applicable}`, note: figures.coverage.percent === null ? "" : `${figures.coverage.percent}%` },
    { label: "Critical equipment tests", value: `${figures.critical.tested} / ${figures.critical.total}`, note: figures.critical.defects ? `${figures.critical.defects} defect${figures.critical.defects === 1 ? "" : "s"}` : "", alert: figures.critical.defects > 0 },
    { label: "Deficient (non-conformities)", value: String(figures.deficient), alert: figures.deficient > 0 },
    { label: "Immediate actions", value: String(figures.immediate), alert: figures.immediate > 0 },
    { label: "Open findings", value: String(figures.openFindings) },
    { label: "RA pending", value: String(figures.raPending), alert: figures.raPending > 0 },
  ]

  return (
    <section aria-labelledby="overview-title" className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div>
        <h3 id="overview-title" className="text-sm font-semibold">Condition &amp; Assurance Overview</h3>
        <p className="text-xs text-muted-foreground">As it will appear in the PDF. Condition ratings describe observed condition; they are not risk ratings.</p>
      </div>

      <p className={cn("rounded-lg border p-3 text-sm font-medium", verdict.state === "withheld" ? TONE.amber : verdict.state === "limited" ? TONE.blue : TONE.green)}>
        {verdict.text}
      </p>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border bg-background p-3">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className={cn("mt-1 font-mono text-lg font-semibold", tile.alert && "text-destructive")}>
              {tile.value}
              {tile.note && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{tile.note}</span>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Area</th>
              <th className="py-2 pr-3 font-medium">Assessed</th>
              <th className="py-2 pr-3 font-medium">Worst observed condition</th>
              <th className="py-2 pr-3 font-medium">Deficient / Degraded</th>
              <th className="py-2 pr-3 font-medium">Immediate</th>
              <th className="py-2 font-medium">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <tr key={area.id} className={cn("border-b last:border-0", area.deficient > 0 && "bg-rose-500/5")}>
                <td className="py-2 pr-3 font-medium">{area.title}</td>
                <td className="py-2 pr-3 font-mono">{area.assessed} / {area.applicable}</td>
                <td className="py-2 pr-3">{area.worst ? <Pill className={WORST[area.worst] ?? TONE.slate}>{ratingLabel(area.worst)}</Pill> : <span className="text-muted-foreground">Not assessed</span>}</td>
                <td className="py-2 pr-3 font-mono">{area.deficient} / {area.degraded}</td>
                <td className="py-2 pr-3 font-mono">{area.immediate}</td>
                <td className="py-2"><Pill className={COVERAGE[area.coverage]}>{COVERAGE_LABELS[area.coverage]}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {register.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Findings register ({register.length})</h4>
          <ul className="flex flex-col gap-1.5">
            {register.map((entry) => (
              <li key={entry.ref} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="font-mono text-xs">{entry.ref}</span>
                <span className="font-medium">{entry.item}</span>
                <Pill className={entry.rating === "deficient" ? TONE.red : TONE.amber}>{ratingLabel(entry.rating)}</Pill>
                {entry.finding.safetyCritical && <Pill className={TONE.slate}>Safety-critical</Pill>}
                <span className="text-xs text-muted-foreground">
                  {FINDING_PRIORITIES.find((p) => p.value === entry.finding.priority)?.label ?? "Priority not set"}
                  {entry.finding.dueDate ? ` · due ${formatDate(entry.finding.dueDate)}` : ""}
                  {entry.finding.raRef ? ` · ${entry.finding.raRef}` : ""}
                  {raPending(entry) ? " · RA pending" : ""}
                  {entry.finding.status === "closed" ? " · Closed" : " · Open"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
