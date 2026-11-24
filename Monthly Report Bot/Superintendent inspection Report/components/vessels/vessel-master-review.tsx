"use client"

// Vessel Master review page (/inspections/vessels): what the master holds for each vessel, the status of every value and
// what a new SIR does with it, the workbook's sources and data-quality items, and the issues Superintendents reported.
// Values change only through the admin import or "Verify" (a Superintendent's check on board against a ship's
// document, recorded with its evidence). "Report issue" records a flag for the office to review.

import { ChevronRight, Flag as FlagIcon, ShieldCheck, Ship } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { ModuleBadge } from "@/components/shell/app-shell"
import { FlagForm } from "@/components/vessels/flag-form"
import { VerifyForm } from "@/components/vessels/verify-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/lib/api"
import { WEB_MODULES } from "@/lib/modules"
import { fetchVesselList, type Cached } from "@/lib/vessel-cache"
import type { Status } from "@/lib/vessel-master/fields"
import { RELEASE_LABEL, type PickerEntry, type ViewField, type VesselView } from "@/lib/vessel-master/view"

const MODULE = WEB_MODULES.find((m) => m.id === "inspections")!

type Row = Record<string, unknown>
type Review = {
  vessel: VesselView
  sources: Row[]
  issues: Row[]
  flags: Row[]
  verifications: Row[]
  revisions: { revision: number; at: string; by: string; reason: string; changed: number }[]
}

const STATUS_STYLE: Record<Status, string> = {
  VERIFIED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PROVISIONAL: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  CONFLICT: "bg-destructive/10 text-destructive",
  MISSING: "border-border text-muted-foreground",
}

const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "")
const cell = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v))

export function VesselMasterReview() {
  const [list, setList] = useState<Cached<PickerEntry[]> | null | undefined>(undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchVesselList().then((result) => {
      setList(result)
      const first = result?.data.find((v) => v.selectable) ?? result?.data[0]
      if (first) setSelected((current) => current ?? first.vesselId)
    })
  }, [])

  const load = useCallback(async (vesselId: string) => {
    setError(null)
    try {
      const res = await apiFetch(`/api/vessels/${vesselId}?review=1`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? "The vessel could not be loaded.")
      setReview(body as Review)
    } catch (e) {
      setReview(null)
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "The server cannot be reached. The review page needs a connection.")
    }
  }, [])

  useEffect(() => {
    if (selected) void load(selected)
  }, [selected, load])

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <span className="hidden sm:block">
            <ModuleBadge module={MODULE} large />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Link href="/" className="hover:text-foreground hover:underline">NeraVeda</Link>
              <ChevronRight className="size-3" aria-hidden />
              <Link href="/inspections" className="hover:text-foreground hover:underline">{MODULE.navLabel}</Link>
              <ChevronRight className="size-3" aria-hidden />
              <span aria-current="page">Vessel Master</span>
            </nav>
            <span className="truncate text-sm font-semibold leading-tight">Vessel Master</span>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <section className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">Vessel Master</h1>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground text-pretty">
            The vessel particulars a new inspection report starts from, with the status of every value. VERIFIED values are
            filled in; PROVISIONAL values are filled in or offered for confirmation; values in conflict or awaiting physical
            verification are not released. Checked a value against the ship&apos;s document on board? Use “Verify” to record it as
            VERIFIED with its evidence. If a value is wrong or missing, use “Report issue”.
          </p>
          {list?.source === "cache" && (
            <p className="text-sm text-amber-700 dark:text-amber-400">Offline: vessel list saved on this device on {when(list.fetchedAt)}.</p>
          )}
        </section>

        {list === undefined ? (
          <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
        ) : !list?.data.length ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
            <Ship className="size-10 text-muted-foreground" aria-hidden />
            <p className="font-medium">{list ? "The Vessel Master is empty" : "The Vessel Master cannot be reached"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {list ? "Vessels are added by importing the Vessel Master workbook (npm run vessel-master)." : "Open this page once while connected; the list is then kept on this device."}
            </p>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
            <nav aria-label="Vessels" className="flex flex-col gap-1 lg:sticky lg:top-4 lg:self-start">
              {list.data.map((v) => (
                <button
                  key={v.vesselId}
                  type="button"
                  onClick={() => setSelected(v.vesselId)}
                  aria-current={selected === v.vesselId ? "true" : undefined}
                  className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${selected === v.vesselId ? "bg-accent font-medium text-accent-foreground" : ""} ${v.selectable ? "" : "text-muted-foreground"}`}
                >
                  <span className="truncate">{v.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{v.workbookId ?? v.activeStatus}</span>
                </button>
              ))}
            </nav>

            <div className="flex min-w-0 flex-col gap-6">
              {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
              {review && <VesselDetail review={review} onFlagged={() => void load(review.vessel.vesselId)} />}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function VesselDetail({ review, onFlagged }: { review: Review; onFlagged: () => void }) {
  const { vessel } = review
  const [panel, setPanel] = useState<{ key: string; kind: "flag" | "verify" } | null>(null)
  const toggle = (key: string, kind: "flag" | "verify") => setPanel(panel?.key === key && panel.kind === kind ? null : { key, kind })
  const counts = vessel.groups.flatMap((g) => g.fields).reduce<Record<string, number>>((n, f) => ({ ...n, [f.status]: (n[f.status] ?? 0) + 1 }), {})
  return (
    <>
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <h2 className="text-xl font-semibold">{vessel.name}</h2>
        <p className="text-sm text-muted-foreground">
          {[vessel.workbookId && `Workbook ID ${vessel.workbookId}`, vessel.imo && `IMO ${vessel.imo}`, vessel.fleetGroup, vessel.activeStatus, `revision ${vessel.revision}`, vessel.updatedAt && `updated ${when(vessel.updatedAt)}`].filter(Boolean).join(" · ")}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["VERIFIED", "PROVISIONAL", "CONFLICT", "MISSING"] as const).map((s) => (
            <Badge key={s} variant="outline" className={STATUS_STYLE[s]}>{s} {counts[s] ?? 0}</Badge>
          ))}
        </div>
        {!vessel.workbookId && (
          <p className="text-sm text-muted-foreground">Name-only record: NeraVeda knows this vessel but the workbook does not list it. It is not offered for new reports.</p>
        )}
      </section>

      {vessel.groups.map((group) => (
        <section key={group.id} aria-labelledby={`group-${group.id}`} className="flex flex-col gap-2">
          <h3 id={`group-${group.id}`} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.id} · {group.title}
            {group.id === "F" && vessel.basisLabel && <span className="ml-2 normal-case tracking-normal">({vessel.basisLabel})</span>}
          </h3>
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Field</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">In a new report</th>
                  <th className="px-3 py-2"><span className="sr-only">Report issue</span></th>
                </tr>
              </thead>
              <tbody>
                {group.fields.map((f) => (
                  <FieldRow key={f.key} field={f} vesselId={vessel.vesselId} canVerify={Boolean(vessel.workbookId)}
                    panel={panel?.key === f.key ? panel.kind : null} onToggle={(kind) => toggle(f.key, kind)}
                    onClose={() => setPanel(null)} onDone={() => { setPanel(null); onFlagged() }} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <RowsTable title="Verified on board" empty="No values verified on board yet." rows={review.verifications ?? []}
        columns={[["at", "When"], ["field", "Field"], ["value", "Verified value"], ["documentType", "Document"], ["documentRef", "Reference"], ["documentDate", "Dated"], ["byName", "By"], ["note", "Note"]]}
        format={{ at: (v) => when(String(v)) }} />
      <RowsTable title="Reported issues" empty="No issues reported for this vessel." rows={review.flags}
        columns={[["at", "Reported"], ["field", "Field"], ["currentValue", "Master value"], ["proposedValue", "Proposed"], ["reason", "Reason"], ["reporterName", "By"], ["status", "Status"]]}
        format={{ at: (v) => when(String(v)) }} />
      <RowsTable title="Data-quality items (workbook)" empty="No data-quality items for this vessel." rows={review.issues}
        columns={[["Issue ID", "Item"], ["Field", "Field"], ["Field(s)", "Field(s)"], ["Issue Type", "Type"], ["Disposition for SIR Autofill", "Disposition"], ["Release rule", "Release rule"], ["Status", "Status"]]} />
      <RowsTable title="Sources (workbook)" empty="No sources listed for this vessel." rows={review.sources}
        columns={[["Source ID", "Source"], ["Field / Field Group", "Covers"], ["Source Type", "Type"], ["Source Document", "Document"], ["Verification Status", "Status"]]} />
      <RowsTable title="Revisions" empty="No revisions." rows={review.revisions}
        columns={[["revision", "Revision"], ["at", "When"], ["by", "By"], ["reason", "Reason"], ["changed", "Fields changed"]]} format={{ at: (v) => when(String(v)) }} />
    </>
  )
}

function FieldRow({ field, vesselId, canVerify, panel, onToggle, onClose, onDone }: {
  field: ViewField; vesselId: string; canVerify: boolean; panel: "flag" | "verify" | null; onToggle: (kind: "flag" | "verify") => void; onClose: () => void; onDone: () => void
}) {
  return (
    <>
      <tr className="border-t align-top">
        <td className="px-3 py-2 font-medium">{field.label}</td>
        <td className="px-3 py-2">
          <span className={field.display ? "" : "text-muted-foreground"}>{field.display || "—"}</span>
          {field.status !== "VERIFIED" && field.reasons.length > 0 && (
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Why</summary>
              <ul className="mt-1 list-disc pl-4">{field.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </details>
          )}
        </td>
        <td className="px-3 py-2">
          <Badge variant="outline" className={STATUS_STYLE[field.status]}>{field.status}</Badge>
          {field.physicalVerification && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">Physical verification</span>}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{RELEASE_LABEL[field.release]}</td>
        <td className="px-3 py-2 text-right">
          <div className="flex justify-end gap-1">
            {canVerify && field.status !== "VERIFIED" && (
              <Button variant="ghost" size="sm" onClick={() => onToggle("verify")} aria-expanded={panel === "verify"} className="text-emerald-700 dark:text-emerald-400">
                <ShieldCheck aria-hidden />
                Verify
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onToggle("flag")} aria-expanded={panel === "flag"}>
              <FlagIcon aria-hidden />
              Report issue
            </Button>
          </div>
        </td>
      </tr>
      {panel && (
        <tr className="border-t bg-muted/30">
          <td colSpan={5} className="px-3 py-3">
            {panel === "flag" ? (
              <FlagForm vesselId={vesselId} field={field.key} label={field.label} masterValue={field.display} onDone={onDone} onCancel={onClose} />
            ) : (
              <VerifyForm vesselId={vesselId} field={field.key} label={field.label} unit={field.unit}
                value={field.value === null ? "" : field.display.replace(field.unit ? ` ${field.unit}` : "", "")} onVerified={onDone} onCancel={onClose} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function RowsTable({ title, empty, rows, columns, format = {} }: {
  title: string; empty: string; rows: Row[]; columns: [string, string][]; format?: Record<string, (v: unknown) => string>
}) {
  // Only the columns this vessel's rows actually use (Data_Quality and Physical_Verification rows have different columns).
  const used = columns.filter(([key]) => rows.some((r) => r[key] !== undefined && r[key] !== null && r[key] !== ""))
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {!rows.length ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>{used.map(([key, label]) => <th key={key} className="px-3 py-2 font-medium">{label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t align-top">
                  {used.map(([key]) => <td key={key} className="px-3 py-2">{format[key] ? format[key](r[key]) : cell(r[key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
