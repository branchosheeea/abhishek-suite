// Loading what a diagnostic report or findings export needs, and recording each generated file. Reports are
// built in memory and streamed to the browser; they are never written next to original files.

import type { ValidationResult } from "../engine/run"
import type { ReportInput } from "../export/report"
import type { ReportFormat } from "./diagnostics"
import { Conflict } from "./errors"
import { audit, getRun, getSession, investigation, listDnv, type Services } from "./service"
import { sha256 } from "./source-store"

export async function loadReportInput(s: Services, sessionId: string, runId: string, storageProtection: string): Promise<ReportInput> {
  const session = await getSession(s, sessionId)
  const run = await getRun(s, sessionId, runId)
  if (run.state !== "completed" || !run.resultJson) throw new Conflict("Only completed runs with verified sources can be reported.")
  const result = JSON.parse(run.resultJson) as ValidationResult
  const artifacts = (await Promise.all(run.inputs.map((i) => s.sources.get(i.sha256)))).filter((a) => a !== null)
  return {
    session, run, result, artifacts,
    dnv: (await listDnv(s, sessionId)).filter((d) => run.dnvIds.includes(d.id)),
    investigation: await investigation(s, sessionId),
    storageProtection,
    generatedAt: s.now(),
    generatedBy: s.actor(),
  }
}

/** Records the generated file (SHA-256, size) and audits it. */
export async function recordReport(s: Services, input: ReportInput, format: ReportFormat, bytes: Uint8Array, filename: string) {
  await s.db.reports.insert({ _id: s.id(), sessionId: input.session._id, runId: input.run._id, format, sha256: sha256(bytes), bytes: bytes.length, createdAt: input.generatedAt, createdBy: input.generatedBy })
  await audit(s, "report.generated", `${format.toUpperCase()} ${filename}`, input.session._id, input.run._id)
}
