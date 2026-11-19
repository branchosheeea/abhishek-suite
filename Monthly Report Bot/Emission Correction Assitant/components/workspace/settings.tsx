"use client"

import { useState } from "react"
import { CONFIG_HELP, type ValidationConfig } from "@/lib/engine/config"
import { formatTime, send } from "../api"
import { Button, Card, Empty, Field, inputClass, Mono } from "../ui"
import type { Ctx } from "./types"

const DECIMAL_FIELDS = ["fuelToleranceMt", "cargoToleranceMt", "durationToleranceHours", "maxReportIntervalHours", "distanceShortToleranceNm", "distanceExcessFactor", "distanceExcessMinNm", "maxPlausibleSpeedKn", "consumptionDeviationFactor", "voyageDistanceDeviationPct"] as const
const INTEGER_FIELDS = ["bunkerProximityHours", "nearMatchMinutes"] as const

const LABEL: Record<string, string> = {
  fuelToleranceMt: "Fuel residual threshold (mt)",
  cargoToleranceMt: "Cargo change threshold (mt)",
  durationToleranceHours: "Duration difference threshold (h)",
  maxReportIntervalHours: "Long reporting interval (h)",
  bunkerProximityHours: "Bunker search window (h)",
  distanceShortToleranceNm: "Short-distance allowance (nm)",
  distanceExcessFactor: "Long-distance factor (× geodesic)",
  distanceExcessMinNm: "Long-distance minimum excess (nm)",
  maxPlausibleSpeedKn: "Implausible implied speed (kn)",
  nearMatchMinutes: "Near-match window (min)",
  consumptionDeviationFactor: "Consumption deviation factor (× median rate)",
  voyageDistanceDeviationPct: "Voyage distance deviation (% over track)",
}

export function Settings({ ctx }: { ctx: Ctx }) {
  const { session } = ctx.data
  const [title, setTitle] = useState(session.title)
  const [imo, setImo] = useState(session.imo ?? "")
  const [config, setConfig] = useState<ValidationConfig>(session.config)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await send("PATCH", `/api/sessions/${session._id}`, { title, imo: imo || null, config: { ...config, imo: undefined } })
      await ctx.reload()
    } catch (e) {
      ctx.setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function include(sha256: string, line: number) {
    try {
      await send("PATCH", `/api/sessions/${session._id}`, { include: { sha256, line } })
      await ctx.reload()
    } catch (e) {
      ctx.setError((e as Error).message)
    }
  }

  const setPeriod = (key: "from" | "to", value: string) => {
    const current = config.period ?? { from: "", to: "" }
    const next = { ...current, [key]: value }
    setConfig({ ...config, period: next.from || next.to ? next : null })
  }

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="Session and thresholds" actions={<Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title"><input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
          <Field label="IMO number" hint="Check digit validated; compared with every file."><input className={inputClass} value={imo} onChange={(e) => setImo(e.target.value.trim())} /></Field>
          <Field label="Reporting period from (UTC)"><input type="date" className={inputClass} value={config.period?.from ?? ""} onChange={(e) => setPeriod("from", e.target.value)} /></Field>
          <Field label="Reporting period to (UTC)"><input type="date" className={inputClass} value={config.period?.to ?? ""} onChange={(e) => setPeriod("to", e.target.value)} /></Field>
          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-semibold">Run record rules on</legend>
            <div className="mt-1 flex gap-4 text-sm">
              {(["LA", "OVDLA"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={config.logSources.includes(k)} onChange={(e) => setConfig({ ...config, logSources: e.target.checked ? [...config.logSources, k] : config.logSources.filter((x) => x !== k) })} />
                  {k === "LA" ? "Submitted Log Abstract" : "System-generated OVDLA"}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Record order for voyage, fuel and cargo rules" hint={CONFIG_HELP.sequenceBasis}>
            <select className={inputClass} value={config.sequenceBasis} onChange={(e) => setConfig({ ...config, sequenceBasis: e.target.value as ValidationConfig["sequenceBasis"] })}>
              <option value="timeline">Timeline — UTC order within the period, as OVD processes it (recommended)</option>
              <option value="submitted">Submitted — the file&apos;s row order</option>
            </select>
          </Field>
          {DECIMAL_FIELDS.map((k) => (
            <Field key={k} label={LABEL[k]} hint={CONFIG_HELP[k]}>
              <input className={inputClass} inputMode="decimal" value={config[k]} onChange={(e) => setConfig({ ...config, [k]: e.target.value.trim() })} />
            </Field>
          ))}
          {INTEGER_FIELDS.map((k) => (
            <Field key={k} label={LABEL[k]} hint={CONFIG_HELP[k]}>
              <input className={inputClass} type="number" min={0} step={1} value={config[k]} onChange={(e) => setConfig({ ...config, [k]: Number(e.target.value) })} />
            </Field>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">All thresholds are screening thresholds for investigation, not DNV tolerances. Each run records the exact configuration and its hash, so results are reproducible.</p>
      </Card>

      <Card title={`Excluded records (${session.exclusions.length})`}>
        {session.exclusions.length === 0 ? (
          <Empty>No record is excluded. Use “Exclude…” in the source viewer to leave a specific record (e.g. a DNV template/sample row) out of operational calculations, with a reason.</Empty>
        ) : (
          <ul className="flex flex-col divide-y text-sm">
            {session.exclusions.map((e) => {
              const kind = Object.entries(session.sources).find(([, sha]) => sha === e.sha256)?.[0] ?? "detached source"
              return (
                <li key={`${e.sha256}-${e.line}`} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold">{kind} line {e.line}</span>: {e.reason}
                    <p className="text-xs text-muted-foreground">{formatTime(e.at)} by {e.by} · <Mono>{e.sha256.slice(0, 16)}…</Mono></p>
                  </div>
                  <Button variant="secondary" className="h-8" onClick={() => include(e.sha256, e.line)}>Re-include</Button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Exclusions apply to one record of one registered file only, never to a date range or a year. Excluded records stay visible in the source viewer, in reconciliation and in the audit trail.</p>
      </Card>
    </div>
  )
}
