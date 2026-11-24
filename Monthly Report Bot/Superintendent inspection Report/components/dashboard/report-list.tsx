"use client"

import { ChevronRight, Copy, FileText, Plus, RefreshCw, Ship, Trash2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { ModuleBadge } from "@/components/shell/app-shell"
import { OnlinePill } from "@/components/status-pill"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useOnline } from "@/hooks/use-online"
import { apiFetch } from "@/lib/api"
import { isApproved } from "@/lib/completeness"
import { FORM_CODE, createEmptyReport, overallProgress, type Report } from "@/lib/form-schema"
import {
  deleteReportLocal,
  getPendingReportDeletes,
  getSyncState,
  listPhotos,
  listReports,
  newId,
  putReport,
  setPendingReportDeletes,
} from "@/lib/local-db"
import { WEB_MODULES } from "@/lib/modules"
import { formatDate } from "@/lib/pdf"
import { isPhotoDirty, isReportDirty, syncAll } from "@/lib/sync"

type Row = { report: Report; photoCount: number; pending: boolean; issue: "conflict" | "locked" | null }

const MODULE = WEB_MODULES.find((m) => m.id === "inspections")!

async function loadRows(): Promise<Row[]> {
  const reports = await listReports()
  return Promise.all(
    reports.map(async (report) => {
      const photos = await listPhotos(report.id)
      return {
        report,
        photoCount: photos.length,
        pending: isReportDirty(report) || Boolean(report.deletedPhotoIds?.length) || photos.some(isPhotoDirty),
        issue: (() => {
          const state = getSyncState(report.id)
          return state.conflict ? "conflict" : state.locked ? "locked" : null
        })(),
      }
    }),
  )
}

export function ReportList() {
  const router = useRouter()
  const online = useOnline()
  const { data: rows, mutate, isLoading } = useSWR("local-reports", loadRows)
  const { isValidating: syncing, mutate: runSync } = useSWR(
    online ? "cloud-sync" : null,
    async () => {
      await syncAll()
      await mutate()
      return Date.now()
    },
    { revalidateOnFocus: true, onError: () => toast.error("Cloud sync failed. Your work is safe on this device.") },
  )

  useEffect(() => {
    if (online) void runSync()
  }, [online, runSync])

  // Tell the server how many reports are only on this device, so the NeraVeda Home page can say so (audit P1-7).
  // Counts only, never report content; offline, it is simply not sent.
  useEffect(() => {
    if (!rows || !online) return
    const status = {
      reports: rows.length,
      pending: rows.filter((r) => r.pending).length,
      conflicts: rows.filter((r) => r.issue === "conflict").length,
      locked: rows.filter((r) => r.issue === "locked").length,
    }
    apiFetch("/api/inspections/device", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(status) }).catch(() => {})
  }, [rows, online])

  const createReport = async (fromId?: string) => {
    const id = newId()
    const report = createEmptyReport(id)
    const source = fromId ? rows?.find((r) => r.report.id === fromId)?.report : undefined
    if (source) {
      report.particulars = { ...source.particulars }
      report.details = {
        vessel: source.details.vessel ?? "",
        owners: source.details.owners ?? "",
        manager: source.details.manager ?? "",
      }
    }
    await putReport(report)
    router.push(`/inspections/report?id=${id}`)
  }

  const removeReport = async (id: string, name: string) => {
    if (!window.confirm(`Delete the inspection report for ${name}? This cannot be undone.`)) return
    await deleteReportLocal(id)
    setPendingReportDeletes([...getPendingReportDeletes(), id])
    await mutate()
    if (online) void runSync()
    toast.success("Report deleted")
  }

  const pendingCount = rows?.filter((r) => r.pending).length ?? 0

  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <span className="hidden sm:block">
            <ModuleBadge module={MODULE} large />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* On phones the NeraVeda top bar already shows the current workspace. */}
            <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Link href="/" className="hover:text-foreground hover:underline">
                NeraVeda
              </Link>
              <ChevronRight className="size-3" aria-hidden />
              <span aria-current="page">{MODULE.navLabel}</span>
            </nav>
            <span className="truncate text-sm font-semibold leading-tight">{MODULE.title}</span>
            <span className="font-mono text-xs text-muted-foreground">Form {FORM_CODE}</span>
          </div>
          <OnlinePill />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => runSync()}
            disabled={!online || syncing}
            aria-label="Sync now"
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} aria-hidden />
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
        <section className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-balance">Superintendent inspection reports</h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground text-pretty">
              Fill reports on board with or without internet. Everything is saved on this device as you type and synced to
              the cloud when a connection is available. Export a formatted PDF at any time.
            </p>
          </div>
          <Button size="lg" onClick={() => createReport()} className="h-11">
            <Plus aria-hidden />
            New inspection
          </Button>
        </section>

        <dl className="grid grid-cols-3 gap-3">
          <Stat label="Reports" value={rows?.length ?? 0} />
          <Stat label="Photos" value={rows?.reduce((a, r) => a + r.photoCount, 0) ?? 0} />
          <Stat label="Waiting to sync" value={pendingCount} highlight={pendingCount > 0} />
        </dl>

        <section aria-labelledby="reports-heading" className="flex flex-col gap-3">
          <h2 id="reports-heading" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent reports
          </h2>
          {isLoading ? (
            <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          ) : !rows?.length ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-12 text-center">
              <Ship className="size-10 text-muted-foreground" aria-hidden />
              <p className="font-medium">No inspections yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Start a new inspection. You can keep working even if the ship loses connectivity.
              </p>
              <Button onClick={() => createReport()} className="mt-2">
                <Plus aria-hidden />
                New inspection
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map(({ report, photoCount, pending, issue }) => {
                const approved = isApproved(report)
                const name = report.details.vessel || report.particulars.shipName || "Untitled inspection"
                const progress = overallProgress(report, photoCount)
                const meta = [
                  report.details.reportNo && `#${report.details.reportNo}`,
                  report.details.port,
                  report.details.dateFrom && formatDate(report.details.dateFrom),
                ].filter(Boolean)
                return (
                  <li
                    key={report.id}
                    className="group relative flex flex-col gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 sm:flex-row sm:items-center"
                  >
                    <span className="hidden size-11 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground sm:flex">
                      <FileText className="size-5" aria-hidden />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/inspections/report?id=${report.id}`}
                          className="truncate font-semibold after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
                        >
                          {name}
                        </Link>
                        {issue === "locked" ? (
                          <Badge variant="outline" className="border-destructive/60 text-destructive" title="The report was approved elsewhere: open it to choose what to do with this device's changes">
                            Changes not saved
                          </Badge>
                        ) : issue === "conflict" ? (
                          <Badge variant="outline" className="border-destructive/60 text-destructive" title="Changed on another device or tab: open the report to choose what to keep">
                            Sync conflict
                          </Badge>
                        ) : pending ? (
                          <Badge variant="outline" className="border-warning/60 text-warning-foreground dark:text-warning">
                            On device only
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-success/50 text-success">
                            Synced
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {meta.length ? meta.join(" · ") : "No details yet"}
                        {photoCount > 0 && ` · ${photoCount} photo${photoCount === 1 ? "" : "s"}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Edited {new Date(report.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 sm:w-44">
                      <Progress value={progress} className="h-1.5 flex-1" aria-label={`${name} completion`} />
                      <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">{progress}%</span>
                    </div>
                    <div className="relative z-10 flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => createReport(report.id)}
                        aria-label={`Start new inspection for ${name} using its particulars`}
                        title="New inspection for this vessel"
                      >
                        <Copy aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeReport(report.id, name)}
                        disabled={approved}
                        aria-label={approved ? `${name} is approved and cannot be deleted` : `Delete ${name}`}
                        title={approved ? "Approved reports cannot be deleted. Withdraw the approval first." : "Delete"}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`font-mono text-2xl font-semibold tabular-nums ${highlight ? "text-warning" : ""}`}>{value}</dd>
    </div>
  )
}
