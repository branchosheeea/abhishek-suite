"use client"

import { formatTime } from "../api"
import { Banner, Card, Empty, Pill } from "../ui"
import type { Ctx } from "./types"

export function Reports({ ctx }: { ctx: Ctx }) {
  const completed = ctx.data.runs.filter((r) => r.state === "completed")
  return (
    <div className="flex flex-col gap-5">
      <Banner tone="info" title="NERAVEDA DIAGNOSTIC REPORT — NOT AN OFFICIAL VESSEL REPORTING FILE">
        Reports describe findings about the reporting files: source file names and SHA-256 hashes, rule and schema versions, DNV items, exact source
        references, calculations, evidence classes, possible causes, recommended checks, investigation status and known limitations. They are never in a
        Log Abstract, Bunker Report or OVD format, and no corrected reporting file can be generated.
      </Banner>
      <Card title="Download a diagnostic report">
        {completed.length === 0 ? <Empty>No completed run yet. Run the validation first.</Empty> : (
          <ul className="flex flex-col divide-y">
            {completed.map((r) => (
              <li key={r._id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-semibold">{formatTime(r.startedAt)}</span> <span className="text-muted-foreground">by {r.actor} · engine {r.engineVersion} · rules {r.ruleSetVersion} · config {r.configHash.slice(0, 8)}</span>
                  <p className="text-xs text-muted-foreground">{r.inputs.map((i) => `${i.kind} ${i.filename}`).join(" · ")}</p>
                </div>
                {r === completed[0] && <Pill tone="info">Latest</Pill>}
                <a className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:opacity-90" href={`/api/sessions/${ctx.data.session._id}/runs/${r._id}/report?format=xlsx`}>Excel (.xlsx)</a>
                <a className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-muted" href={`/api/sessions/${ctx.data.session._id}/runs/${r._id}/report?format=json`}>JSON</a>
                <span className="flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground sm:w-auto">
                  Errors and warnings for vessel review:
                  <a className="font-semibold text-primary hover:underline" href={`/api/sessions/${ctx.data.session._id}/runs/${r._id}/findings-export?format=pdf&scope=errors-warnings`}>PDF</a>
                  <a className="font-semibold text-primary hover:underline" href={`/api/sessions/${ctx.data.session._id}/runs/${r._id}/findings-export?format=xlsx&scope=errors-warnings`}>Excel</a>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Excel exports write every value as text with formula protection (cells starting with =, +, −, @ are marked as text), so no cell can execute as a formula.
          Each generated report is recorded in the audit history with its SHA-256. The findings PDF for the vessel (with a fillable
          Investigation status dropdown per finding) and a filtered selection are available from <strong>Export</strong> on the Findings &amp; investigation tab.
        </p>
      </Card>
    </div>
  )
}
