"use client"

import { RULE_GROUP_LABEL, SOURCE_KIND_LABEL, type RuleGroup, type SourceKind } from "@/lib/engine/types"
import { formatTime } from "../api"
import { Banner, Card, Empty, Mono, Pill, Stat } from "../ui"
import type { Ctx } from "./types"

export function Overview({ ctx }: { ctx: Ctx }) {
  const { data, result, run } = ctx
  const kinds: SourceKind[] = ["LA", "BR", "OVDLA"]
  const dnvActive = data.dnv.filter((d) => !d.withdrawn)

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="DNV errors" value={dnvActive.filter((d) => d.severity === "error").length} note="as entered from DNV" />
        <Stat label="DNV warnings" value={dnvActive.filter((d) => d.severity === "warning").length} note="as entered from DNV" />
        <Stat label="Independently reproduced" value={result ? result.correlations.filter((c) => c.outcome === "independently-reproduced").length : "–"} note="of DNV items" />
        <Stat label="Not reproduced" value={result ? result.correlations.filter((c) => c.outcome === "not-reproduced").length : "–"} note="of DNV items" />
        <Stat label="Unresolved" value={result ? result.correlations.filter((c) => c.outcome === "unresolved").length : "–"} note="of DNV items" />
        <Stat label="Independent errors" value={run?.summary?.errors ?? "–"} note="all rule groups" />
        <Stat label="Fuel reconciliation" value={run?.summary?.fuel ?? "–"} note="errors + warnings" />
        <Stat label="Source reconciliation" value={run?.summary?.reconciliation ?? "–"} note="errors + warnings" />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Sources and integrity">
          <ul className="flex flex-col divide-y">
            {kinds.map((kind) => {
              const sha = data.session.sources[kind]
              const artifact = data.artifacts.find((a) => a._id === sha)
              const before = run?.integrity.before.find((c) => c.kind === kind)
              const after = run?.integrity.after.find((c) => c.kind === kind)
              return (
                <li key={kind} className="flex flex-col gap-1 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{SOURCE_KIND_LABEL[kind]}</span>
                    {!artifact ? (
                      <Pill>Not supplied</Pill>
                    ) : before && after ? (
                      <Pill tone={before.ok && after.ok ? "good" : "critical"}>{before.ok && after.ok ? "SHA-256 verified before and after run" : "Integrity check failed"}</Pill>
                    ) : (
                      <Pill tone="info">Registered, not yet validated</Pill>
                    )}
                  </div>
                  {artifact && (
                    <p className="text-xs text-muted-foreground">
                      {artifact.filename} · {artifact.size.toLocaleString()} bytes · registered {formatTime(artifact.registeredAt)} by {artifact.registeredBy}
                      <br />
                      <Mono>SHA-256 {artifact._id}</Mono>
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>

        <Card title="Validation coverage">
          {!result ? (
            <Empty>Run the validation to see which rules could be executed.</Empty>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <p>
                Schema <strong>{result.schema.id}</strong> (OVD {result.schema.ovdVersion}) ·{" "}
                {result.schema.verified ? <Pill tone="good">verified</Pill> : <Pill tone="warning">not verified</Pill>} · engine {result.engineVersion} · rule set {result.ruleSetVersion}
              </p>
              <CoverageBar rules={result.coverage.rules} />
              {result.coverage.rules.filter((r) => r.status !== "executed").length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-primary">Rules not fully executed ({result.coverage.rules.filter((r) => r.status !== "executed").length})</summary>
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {result.coverage.rules.filter((r) => r.status !== "executed").map((r) => (
                      <li key={r.ruleId}><strong>{r.ruleId}</strong> {r.status === "partial" ? "partly executed" : "not executable"}: {r.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
              {result.coverage.notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
            </div>
          )}
        </Card>
      </div>

      {result && (
        <Card title="Findings by rule group">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1.5 pr-3">Group</th><th className="pr-3">Errors</th><th className="pr-3">Warnings</th><th className="pr-3">Information</th><th>Hypotheses</th></tr>
              </thead>
              <tbody className="divide-y">
                {(Object.keys(RULE_GROUP_LABEL) as RuleGroup[]).map((g) => {
                  const list = result.findings.filter((f) => f.group === g)
                  return (
                    <tr key={g}>
                      <td className="py-1.5 pr-3 font-semibold">{g} · {RULE_GROUP_LABEL[g]}</td>
                      <td className="pr-3 tabular-nums">{list.filter((f) => f.severity === "error").length}</td>
                      <td className="pr-3 tabular-nums">{list.filter((f) => f.severity === "warning").length}</td>
                      <td className="pr-3 tabular-nums">{list.filter((f) => f.severity === "info").length}</td>
                      <td className="tabular-nums">{list.filter((f) => f.evidence === "hypothesis").length}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Open <em>Findings &amp; investigation</em> to filter, review calculations and record the investigation.</p>
        </Card>
      )}

      {result && result.findings.filter((f) => f.severity === "error").length > 0 && (
        <Card title="Errors to review first">
          <ul className="flex flex-col divide-y">
            {result.findings.filter((f) => f.severity === "error").slice(0, 8).map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
                <Pill tone="critical">{f.ruleId}</Pill>
                <button className="min-w-0 flex-1 text-left text-sm font-semibold text-primary hover:underline" onClick={() => ctx.openFinding(f.id)}>{f.title}</button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!run && <Banner tone="info" title="No validation run yet">Register the source files under <strong>Sources</strong>, enter DNV errors under <strong>DNV findings</strong>, then choose <strong>Run validation</strong>.</Banner>}
    </div>
  )
}

function CoverageBar({ rules }: { rules: readonly { status: string }[] }) {
  const executed = rules.filter((r) => r.status === "executed").length
  const partial = rules.filter((r) => r.status === "partial").length
  const notRun = rules.length - executed - partial
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded" role="img" aria-label={`${executed} executed, ${partial} partly executed, ${notRun} not executable of ${rules.length} rules`}>
        <span style={{ width: `${(executed / rules.length) * 100}%`, background: "var(--chart-accent)" }} />
        <span style={{ width: `${(partial / rules.length) * 100}%`, background: "var(--chart-accent)", opacity: 0.45 }} />
        <span style={{ width: `${(notRun / rules.length) * 100}%`, background: "var(--chart-muted)" }} />
      </div>
      <p className="mt-1.5 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        <span><Swatch color="var(--chart-accent)" /> {executed} executed</span>
        <span><Swatch color="var(--chart-accent)" faded /> {partial} partly executed</span>
        <span><Swatch color="var(--chart-muted)" /> {notRun} not executable</span>
      </p>
    </div>
  )
}

function Swatch({ color, faded }: { color: string; faded?: boolean }) {
  return <span aria-hidden className="mr-1 inline-block size-2.5 rounded-sm align-middle" style={{ background: color, opacity: faded ? 0.45 : 1 }} />
}
