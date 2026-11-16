"use client"

import type { Photo, Report } from "./form-schema"
import {
  deletePhotoLocal,
  getPendingReportDeletes,
  getReport,
  listPhotos,
  listReports,
  putPhoto,
  putReport,
  setPendingReportDeletes,
} from "./local-db"

export function isReportDirty(report: Report) {
  return !report.syncedAt || report.updatedAt > report.syncedAt
}

export function isPhotoDirty(photo: Photo) {
  return !photo.syncedAt || photo.updatedAt > photo.syncedAt
}

async function pushReport(id: string) {
  const report = await getReport(id)
  if (!report) return

  for (const photoId of report.deletedPhotoIds ?? []) {
    const res = await fetch(`/api/reports/${id}/photos/${photoId}`, { method: "DELETE" })
    if (!res.ok) throw new Error("Photo delete failed")
  }

  if (isReportDirty(report)) {
    const { deletedPhotoIds: _omit, syncedAt: _s, ...payload } = report
    const res = await fetch(`/api/reports/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!res.ok && res.status !== 409) throw new Error("Report sync failed")
  }

  for (const photo of await listPhotos(id)) {
    if (!isPhotoDirty(photo)) continue
    const res = await fetch(`/api/reports/${id}/photos/${photo.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(photo),
    })
    if (!res.ok) throw new Error("Photo sync failed")
    const latest = (await listPhotos(id)).find((p) => p.id === photo.id)
    if (latest && latest.updatedAt === photo.updatedAt) await putPhoto({ ...latest, syncedAt: photo.updatedAt })
  }

  const latest = await getReport(id)
  if (latest) {
    const remainingDeletes = (latest.deletedPhotoIds ?? []).filter((p) => !report.deletedPhotoIds?.includes(p))
    await putReport({
      ...latest,
      deletedPhotoIds: remainingDeletes,
      syncedAt: latest.updatedAt === report.updatedAt ? report.updatedAt : latest.syncedAt,
    })
  }
}

type RemoteSummary = { id: string; updatedAt: number }

async function pullReports() {
  const res = await fetch("/api/reports", { cache: "no-store" })
  if (!res.ok) throw new Error("Could not fetch reports")
  const { reports: remote } = (await res.json()) as { reports: RemoteSummary[] }
  const local = new Map((await listReports()).map((r) => [r.id, r]))
  const pendingDeletes = new Set(getPendingReportDeletes())

  for (const summary of remote) {
    if (pendingDeletes.has(summary.id)) continue
    const existing = local.get(summary.id)
    if (existing && (existing.updatedAt >= summary.updatedAt || isReportDirty(existing))) continue

    const detail = await fetch(`/api/reports/${summary.id}`, { cache: "no-store" })
    if (!detail.ok) continue
    const { report, photos } = (await detail.json()) as { report: Report; photos: Photo[] }
    await putReport({ ...report, deletedPhotoIds: [], syncedAt: report.updatedAt })

    const remotePhotoIds = new Set(photos.map((p) => p.id))
    for (const old of await listPhotos(summary.id)) {
      if (!remotePhotoIds.has(old.id) && !isPhotoDirty(old)) await deletePhotoLocal(old.id)
    }
    for (const photo of photos) await putPhoto({ ...photo, syncedAt: photo.updatedAt })
  }
}

async function flushReportDeletes() {
  const pending = getPendingReportDeletes()
  const remaining: string[] = []
  for (const id of pending) {
    const res = await fetch(`/api/reports/${id}`, { method: "DELETE" }).catch(() => null)
    if (!res?.ok) remaining.push(id)
  }
  setPendingReportDeletes(remaining)
}

let running: Promise<void> | null = null

export function syncAll(): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return Promise.resolve()
  running ??= (async () => {
    try {
      await flushReportDeletes()
      for (const report of await listReports()) {
        const photos = await listPhotos(report.id)
        if (isReportDirty(report) || report.deletedPhotoIds?.length || photos.some(isPhotoDirty)) {
          await pushReport(report.id)
        }
      }
      await pullReports()
    } finally {
      running = null
    }
  })()
  return running
}

export function syncReport(id: string): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return Promise.resolve()
  return pushReport(id)
}
