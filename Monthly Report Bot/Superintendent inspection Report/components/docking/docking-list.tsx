"use client"

import { Anchor, ChevronRight, Plus } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"
import useSWR from "swr"
import { ModuleBadge } from "@/components/shell/app-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { WEB_MODULES } from "@/lib/modules"
import { API, type Docking, type DockingRow, formatDay, getJson, send, STATUS_LABEL } from "./client"
import { DockingForm } from "./docking-form"

const MODULE = WEB_MODULES.find((m) => m.id === "docking")!

export function DockingList() {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const { data, error, isLoading, mutate } = useSWR(API, (path: string) => getJson<{ dockings: DockingRow[] }>(path))
  const dockings = data?.dockings ?? []

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-9">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div className="flex items-center gap-3.5">
          <ModuleBadge module={MODULE} large />
          <div>
            <p className="text-[10px] font-bold tracking-wide" style={{ color: MODULE.accent }}>{MODULE.eyebrow}</p>
            <h1 className="text-2xl font-bold tracking-tight">Digital Docking</h1>
            <p className="text-sm text-muted-foreground">Dockings, reporting days, jobs and your notes. Vessel files are kept exactly as received.</p>
          </div>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden /> New docking
          </Button>
        )}
      </header>

      {creating && (
        <section aria-labelledby="new-docking" className="rounded-2xl border bg-card p-5">
          <h2 id="new-docking" className="mb-4 text-lg font-bold">New docking</h2>
          <DockingForm
            submitLabel="Create docking"
            onCancel={() => setCreating(false)}
            onSubmit={async (values) => {
              const { docking } = await send<{ docking: Docking }>(API, "POST", values)
              toast.success(`${docking.vessel_name} · ${docking.code} created`)
              await mutate()
              router.push(`/docking/${docking.id}`)
            }}
          />
        </section>
      )}

      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error.message}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading dockings…</p>}
      {!isLoading && !error && dockings.length === 0 && !creating && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed p-10 text-center">
          <Anchor className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-semibold">No dockings yet</p>
          <p className="max-w-md text-sm text-muted-foreground">Create a docking with the vessel, yard and Day 0 (the arrival date at the yard). Daily reports are then filed against its days.</p>
          <Button onClick={() => setCreating(true)}><Plus aria-hidden /> New docking</Button>
        </div>
      )}

      {dockings.length > 0 && (
        <ul className="flex flex-col gap-3">
          {dockings.map((d) => (
            <li key={d.id}>
              <Link href={`/docking/${d.id}`} className="group flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card p-4 transition-colors hover:border-ring/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                <div className="flex min-w-56 flex-1 flex-col">
                  <span className="font-bold">{d.vessel_name}</span>
                  <span className="text-sm text-muted-foreground">{d.code} · {d.docking_type} · {d.yard}{d.location ? `, ${d.location}` : ""}</span>
                </div>
                <Stat label="Day 0" value={formatDay(d.day0_date)} />
                <Stat label="Days reported" value={`${d.days_received + d.days_reviewed}${d.last_reported_day !== null ? ` (to Day ${d.last_reported_day})` : ""}`} />
                <Stat label="Reviewed" value={String(d.days_reviewed)} />
                <Stat label="Jobs" value={String(d.jobs)} />
                <Badge variant={d.status === "active" ? "default" : "outline"}>{STATUS_LABEL[d.status]}</Badge>
                <ChevronRight className="size-4 text-muted-foreground group-hover:text-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}
