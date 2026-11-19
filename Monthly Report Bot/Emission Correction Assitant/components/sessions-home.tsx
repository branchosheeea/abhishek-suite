"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { FLEET_VESSELS } from "@/lib/vessels"
import { formatTime, get, send } from "./api"
import { Banner, Button, Card, Empty, Field, inputClass, Pill } from "./ui"

type SessionRow = {
  _id: string
  title: string
  vessel: string
  imo: string | null
  config: { period: { from: string; to: string } | null }
  sources: Record<string, string>
  updatedAt: string
  latestRun: { _id: string; state: string; startedAt: string; summary: Record<string, number> | null } | null
}

type Protection = { configured: boolean; mode: string; summary: string }

export function SessionsHome() {
  const router = useRouter()
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [protection, setProtection] = useState<Protection | null>(null)
  const [form, setForm] = useState({ vessel: "DHT COLT", imo: "", from: "", to: "", title: "" })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      setSessions((await get<{ sessions: SessionRow[] }>("/api/sessions")).sessions)
    } catch (e) {
      setError((e as Error).message)
      setSessions([])
    }
  }, [])

  useEffect(() => {
    void load()
    get<Protection>("/api/integrity").then(setProtection).catch(() => setProtection(null))
  }, [load])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const period = form.from && form.to ? { from: form.from, to: form.to } : null
      const session = await send<{ _id: string }>("POST", "/api/sessions", { vessel: form.vessel, imo: form.imo || null, period, title: form.title || undefined })
      router.push(`/sessions/${session._id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-1.5 border-b pb-6">
        <p className="text-xs font-bold tracking-wide text-primary">EMISSIONS REPORTING · WORKSPACE 07</p>
        <h1 className="text-3xl font-bold tracking-tight">DNV Emissions Validation &amp; Intelligence</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Reads vessel Log Abstract, Bunker Report and system-generated OVDLA files, reconciles them, recalculates fuel balances and
          relates DNV Emissions Connect errors to independent findings. Original files are never modified: every result is a separate
          diagnostic record.
        </p>
      </header>

      {protection?.mode === "memory" && <Banner tone="critical" title="Test mode: nothing is saved">{protection.summary}</Banner>}
      {protection && protection.configured && protection.mode !== "database-enforced" && protection.mode !== "memory" && (
        <Banner tone="warning" title="Original files are protected by the application only">
          {protection.summary} <Link className="font-semibold text-primary underline" href="/integrity">Details</Link>
        </Banner>
      )}
      {protection && !protection.configured && (
        <Banner tone="critical" title="Storage is not configured">
          Set <code>EMISSIONS_MONGODB_URI</code> in <code>.env.local</code> (see <code>.env.example</code>) and restart the server.
        </Banner>
      )}
      {error && <Banner tone="critical" title="Could not complete the request">{error}</Banner>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Validation sessions">
          {sessions === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sessions.length === 0 ? (
            <Empty>No validation session yet. Create one to register the vessel&apos;s files.</Empty>
          ) : (
            <ul className="flex flex-col divide-y">
              {sessions.map((s) => (
                <li key={s._id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/sessions/${s._id}`} className="font-semibold text-primary hover:underline">{s.title}</Link>
                    <p className="text-xs text-muted-foreground">
                      {s.vessel}
                      {s.imo ? ` · IMO ${s.imo}` : ""}
                      {s.config.period ? ` · ${s.config.period.from} to ${s.config.period.to}` : " · period not set"}
                      {` · sources: ${Object.keys(s.sources).join(", ") || "none"}`}
                    </p>
                  </div>
                  <RunBadge run={s.latestRun} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="New validation session">
          <form onSubmit={create} className="flex flex-col gap-3">
            <Field label="Vessel">
              <select className={inputClass} value={form.vessel} onChange={(e) => setForm({ ...form, vessel: e.target.value })}>
                {FLEET_VESSELS.map((v) => <option key={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="IMO number" hint="Optional. Checked against the files (check digit validated).">
              <input className={inputClass} inputMode="numeric" pattern="\d{7}" value={form.imo} onChange={(e) => setForm({ ...form, imo: e.target.value.trim() })} placeholder="7 digits" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Period from (UTC)">
                <input type="date" className={inputClass} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
              </Field>
              <Field label="Period to (UTC)">
                <input type="date" className={inputClass} value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
              </Field>
            </div>
            <Field label="Title" hint="Optional. Defaults to vessel and period.">
              <input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create session"}</Button>
            <p className="text-xs text-muted-foreground">Next, the session opens and you import the vessel&apos;s files there (Sources tab). To add files to an existing session, open it from the list.</p>
          </form>
        </Card>
      </div>
    </main>
  )
}

function RunBadge({ run }: { run: SessionRow["latestRun"] }) {
  if (!run) return <Pill>Not run yet</Pill>
  if (run.state !== "completed") return <Pill tone="critical">{run.state === "integrity-failed" ? "Integrity check failed" : run.state === "running" ? "Running / interrupted" : "Run failed"}</Pill>
  const s = run.summary ?? {}
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {s.errors ? <Pill tone="critical">{s.errors} error(s)</Pill> : null}
      {s.warnings ? <Pill tone="warning">{s.warnings} warning(s)</Pill> : null}
      {!s.errors && !s.warnings ? <Pill tone="good">No errors or warnings</Pill> : null}
      <span>{formatTime(run.startedAt)}</span>
    </span>
  )
}
