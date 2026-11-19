"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { SourceRef } from "@/lib/engine/types"
import { formatTime, get, send } from "../api"
import { Banner, Button, cn, Pill } from "../ui"
import { AuditPanel } from "./audit"
import { DnvPanel } from "./dnv"
import { FindingsPanel } from "./findings"
import { Overview } from "./overview"
import { Reconciliation } from "./reconciliation"
import { Reports } from "./reports"
import { Settings } from "./settings"
import { SourcesPanel } from "./sources"
import type { Ctx, Focus, Result, RunSummary, SessionData } from "./types"
import { VoyageFuel } from "./voyage-fuel"

const TABS = [
  ["overview", "Dashboard"],
  ["sources", "Sources"],
  ["reconciliation", "Source reconciliation"],
  ["voyage", "Voyage & fuel"],
  ["dnv", "DNV findings"],
  ["findings", "Findings & investigation"],
  ["reports", "Diagnostic reports"],
  ["settings", "Settings & exclusions"],
  ["audit", "Audit history"],
] as const

type Tab = (typeof TABS)[number][0]

export function Workspace({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<SessionData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("overview")
  const [runId, setRunId] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)
  const [focus, setFocus] = useState<Focus>(null)
  const [findingId, setFindingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const next = await get<SessionData>(`/api/sessions/${sessionId}`)
      setData(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [sessionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const completed = useMemo(() => (data?.runs ?? []).filter((r) => r.state === "completed"), [data])
  const run: RunSummary | null = useMemo(() => data?.runs.find((r) => r._id === runId) ?? completed[0] ?? null, [data, runId, completed])

  useEffect(() => {
    if (!run || run.state !== "completed") {
      setResult(null)
      return
    }
    let cancelled = false
    get<{ result: Result }>(`/api/sessions/${sessionId}/runs/${run._id}`)
      .then((r) => !cancelled && setResult(r.result))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [run, sessionId])

  async function runValidation() {
    setRunning(true)
    setError(null)
    try {
      const r = await send<RunSummary>("POST", `/api/sessions/${sessionId}/runs`)
      if (r.state !== "completed") setError(r.error ?? `The run ended in state ${r.state}.`)
      await reload()
      setRunId(r._id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  if (!data) {
    return <main className="px-4 py-8 sm:px-9">{error ? <Banner tone="critical" title="Could not open the session">{error}</Banner> : <p className="text-sm text-muted-foreground">Loading session…</p>}</main>
  }

  const ctx: Ctx = {
    data,
    result,
    run,
    reload,
    setError,
    focus: (refs: readonly SourceRef[], columns?: readonly string[]) => {
      if (refs.length === 0) return
      const kind = refs[0].kind
      setFocus({ kind, lines: refs.filter((r) => r.kind === kind).map((r) => r.line), columns })
      setTab("sources")
    },
    openFinding: (id: string) => {
      setFindingId(id)
      setTab("findings")
    },
  }
  const { session } = data
  const stale = run && new Date(session.updatedAt) > new Date(run.startedAt)

  return (
    <main className="mx-auto flex max-w-[1400px] flex-col gap-5 px-4 py-6 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
        <Link href="/" className="hover:underline">Validation sessions</Link> › {session.title}
      </nav>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{session.title}</h1>
          <p className="text-sm text-muted-foreground">
            {session.vessel}
            {session.imo ? ` · IMO ${session.imo}` : " · IMO not set"}
            {session.config.period ? ` · ${session.config.period.from} to ${session.config.period.to} (UTC)` : " · reporting period not set"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.runs.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Run</span>
              <select className="h-9 rounded-lg border border-input bg-card px-2 text-sm" value={run?._id ?? ""} onChange={(e) => setRunId(e.target.value)}>
                {data.runs.map((r) => (
                  <option key={r._id} value={r._id}>
                    {formatTime(r.startedAt)} · {r.state}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button onClick={runValidation} disabled={running || Object.keys(session.sources).length === 0}>
            {running ? "Validating…" : "Run validation"}
          </Button>
        </div>
      </header>

      {error && (
        <Banner tone="critical" title="Something needs attention">
          {error}{" "}
          <button className="ml-2 font-semibold underline" onClick={() => setError(null)}>Dismiss</button>
        </Banner>
      )}
      {run && run.state !== "completed" && (
        <Banner tone="critical" title={run.state === "integrity-failed" ? "Integrity check failed: results withheld" : run.state === "running" ? "This run did not finish (interrupted)" : "This run failed"}>
          {run.error ?? "No result was stored. Source files were not changed."}
        </Banner>
      )}
      {stale && <Banner tone="warning" title="Settings changed after this run">Run the validation again to apply the current sources, exclusions and thresholds.</Banner>}
      {Object.keys(session.sources).length === 0 && tab !== "sources" && (
        <Banner tone="info" title="Start here: import the vessel's files">
          <span className="flex flex-wrap items-center gap-3">
            Import the Log Abstract (.csv), the Bunker Report (.csv) and the OVDLA (.xlsx) on the Sources tab, then run the validation.
            <Button onClick={() => setTab("sources")}>Import files</Button>
          </span>
        </Banner>
      )}
      {result && !result.schema.verified && (
        <Banner tone="warning" title="Provisional schema: results are not yet verified against the OVD 3.13 Interface Description">{result.schema.note}</Banner>
      )}

      <div role="tablist" aria-label="Session sections" className="flex flex-wrap gap-1 border-b">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn("-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm", tab === id ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
        {run && <span className="ml-auto self-center"><Pill tone={run.state === "completed" ? "good" : "critical"}>{run.state === "completed" ? `Run ${formatTime(run.startedAt)}` : run.state}</Pill></span>}
      </div>

      <div role="tabpanel">
        {tab === "overview" && <Overview ctx={ctx} />}
        {tab === "sources" && <SourcesPanel ctx={ctx} focus={focus} />}
        {tab === "reconciliation" && <Reconciliation ctx={ctx} />}
        {tab === "voyage" && <VoyageFuel ctx={ctx} />}
        {tab === "dnv" && <DnvPanel ctx={ctx} />}
        {tab === "findings" && <FindingsPanel ctx={ctx} selected={findingId} onSelect={setFindingId} />}
        {tab === "reports" && <Reports ctx={ctx} />}
        {tab === "settings" && <Settings ctx={ctx} />}
        {tab === "audit" && <AuditPanel sessionId={session._id} />}
      </div>
    </main>
  )
}
