"use client"

// Sync between this browser (IndexedDB, the working copy) and the cloud (MongoDB via /api/reports).
//
// Conflicts. Each save tells the server which cloud version this device's copy is based on (lib/report-write.ts). If
// another device or tab saved in between, the server answers 409. The device then keeps its own copy, marks the report
// as in conflict and stops sending or fetching it, so neither copy can overwrite the other. The person chooses what to
// keep (resolveSyncConflict): this device's version, the cloud version, or both (this device's version is saved as a
// separate report). Before this, a 409 was treated as synced and the next fetch replaced the local changes.
//
// Approved reports. The cloud refuses any change to a report the Fleet Manager has approved (answer 423). The device
// then keeps its changes, marks the report as locked and stops sending it. The person can withdraw the approval with a
// reason (withdrawApproval: the cloud keeps the approved version permanently) and send the changes, keep both (the
// changes become a separate draft report), or discard them and take the approved version.
//
// The engine takes its storage and network functions as arguments (createSyncEngine), so the rules can be tested in
// Node; the app uses the browser ones below.

import { apiFetch } from "./api"
import type { Photo, Report } from "./form-schema"
import * as local from "./local-db"

export type SyncConflict = local.SyncConflict
export type SyncState = local.SyncState
export type SyncLock = local.SyncLock
/**
 * synced: the report is in the cloud · conflict: changed elsewhere, waiting for the person · locked: approved in the
 * cloud, so this device's changes were refused, waiting for the person · nothing: nothing to do.
 */
export type PushResult = "synced" | "conflict" | "locked" | "nothing"
/** local: send this device's version · cloud: take the cloud version · both: keep this device's version as a new report. */
export type ConflictChoice = "local" | "cloud" | "both"
export type ResolveOutcome = { result: PushResult; copyId?: string }
/** cloud: withdrawn in the cloud (the approved version is kept there) · device: the approval never reached the cloud. */
export type WithdrawOutcome = { result: PushResult; withdrawn: "cloud" | "device" | null }

export type SyncDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  getReport: (id: string) => Promise<Report | undefined>
  putReport: (report: Report) => Promise<unknown>
  listReports: () => Promise<Report[]>
  listPhotos: (reportId: string) => Promise<Photo[]>
  putPhoto: (photo: Photo) => Promise<unknown>
  deletePhotoLocal: (id: string) => Promise<unknown>
  getPendingReportDeletes: () => string[]
  setPendingReportDeletes: (ids: string[]) => void
  getSyncState: (id: string) => SyncState
  setSyncState: (id: string, state: SyncState | null) => void
  newId: () => string
  now: () => number
  online: () => boolean
}

export function isReportDirty(report: Report) {
  return !report.syncedAt || report.updatedAt > report.syncedAt
}

export function isPhotoDirty(photo: Photo) {
  return !photo.syncedAt || photo.updatedAt > photo.syncedAt
}

const JSON_HEADERS = { "Content-Type": "application/json" }

export function createSyncEngine(d: SyncDeps) {
  /** The cloud version this device's copy is based on. */
  const baseOf = (report: Report) => d.getSyncState(report.id).base ?? report.syncedAt

  /** The cloud refused a change because the report is approved: keep this device's copy and stop sending it. */
  async function markLocked(id: string, res: Response): Promise<PushResult> {
    const body = (await res.json().catch(() => ({}))) as { approvedBy?: unknown; approvedOn?: unknown; serverUpdatedAt?: unknown }
    d.setSyncState(id, {
      ...d.getSyncState(id),
      locked: {
        approvedBy: String(body.approvedBy ?? ""),
        approvedOn: String(body.approvedOn ?? ""),
        serverUpdatedAt: Number(body.serverUpdatedAt) || 0,
        detectedAt: d.now(),
      },
    })
    return "locked"
  }

  async function pushReport(id: string): Promise<PushResult> {
    const report = await d.getReport(id)
    if (!report) return "nothing"
    const state = d.getSyncState(id)
    // Waiting for the person to choose: sending it would replace the other version, or be refused again.
    if (state.conflict) return "conflict"
    if (state.locked) return "locked"

    let pushed = false
    if (isReportDirty(report)) {
      const { deletedPhotoIds: _omit, syncedAt: _s, ...payload } = report
      const res = await d.fetch(`/api/reports/${id}`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...payload, baseUpdatedAt: baseOf(report) }),
      })
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { serverUpdatedAt?: unknown }
        d.setSyncState(id, { ...state, conflict: { serverUpdatedAt: Number(body.serverUpdatedAt) || 0, detectedAt: d.now() } })
        return "conflict"
      }
      if (res.status === 423) return markLocked(id, res)
      if (!res.ok) throw new Error("Report sync failed")
      // The cloud now holds this version: later saves are based on it, even if the person kept typing meanwhile.
      d.setSyncState(id, { base: report.updatedAt })
      pushed = true
    }

    for (const photoId of report.deletedPhotoIds ?? []) {
      const res = await d.fetch(`/api/reports/${id}/photos/${photoId}`, { method: "DELETE" })
      if (res.status === 423) return markLocked(id, res)
      if (!res.ok) throw new Error("Photo delete failed")
    }

    for (const photo of await d.listPhotos(id)) {
      if (!isPhotoDirty(photo)) continue
      const res = await d.fetch(`/api/reports/${id}/photos/${photo.id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(photo) })
      if (res.status === 423) return markLocked(id, res)
      if (!res.ok) throw new Error("Photo sync failed")
      const latest = (await d.listPhotos(id)).find((p) => p.id === photo.id)
      if (latest && latest.updatedAt === photo.updatedAt) await d.putPhoto({ ...latest, syncedAt: photo.updatedAt })
    }

    const latest = await d.getReport(id)
    if (latest) {
      const remainingDeletes = (latest.deletedPhotoIds ?? []).filter((p) => !report.deletedPhotoIds?.includes(p))
      // Edits made while this was sending keep the copy "not yet synced" (updatedAt > syncedAt).
      await d.putReport({ ...latest, deletedPhotoIds: remainingDeletes, syncedAt: pushed ? report.updatedAt : latest.syncedAt })
    }
    return "synced"
  }

  /** Replace this device's copy with the cloud copy. Photos added here and not yet sent are kept unless told otherwise. */
  async function applyCloudCopy(report: Report, photos: Photo[], keepUnsentPhotos: boolean) {
    await d.putReport({ ...report, deletedPhotoIds: [], syncedAt: report.updatedAt })
    const remotePhotoIds = new Set(photos.map((p) => p.id))
    for (const old of await d.listPhotos(report.id)) {
      if (!remotePhotoIds.has(old.id) && !(keepUnsentPhotos && isPhotoDirty(old))) await d.deletePhotoLocal(old.id)
    }
    for (const photo of photos) await d.putPhoto({ ...photo, syncedAt: photo.updatedAt })
    d.setSyncState(report.id, { base: report.updatedAt })
  }

  async function fetchCloudCopy(id: string): Promise<{ report: Report; photos: Photo[] } | null> {
    const res = await d.fetch(`/api/reports/${id}`, { cache: "no-store" })
    if (!res.ok) return null
    return (await res.json()) as { report: Report; photos: Photo[] }
  }

  async function pullReports() {
    const res = await d.fetch("/api/reports", { cache: "no-store" })
    if (!res.ok) throw new Error("Could not fetch reports")
    const { reports: remote } = (await res.json()) as { reports: { id: string; updatedAt: number }[] }
    const localReports = new Map((await d.listReports()).map((r) => [r.id, r]))
    const pendingDeletes = new Set(d.getPendingReportDeletes())

    for (const summary of remote) {
      if (pendingDeletes.has(summary.id)) continue
      // Never replace a copy in conflict, or one holding changes refused for an approved report: the person decides.
      const state = d.getSyncState(summary.id)
      if (state.conflict || state.locked) continue
      const existing = localReports.get(summary.id)
      if (existing && (existing.updatedAt >= summary.updatedAt || isReportDirty(existing))) continue
      const cloud = await fetchCloudCopy(summary.id)
      if (cloud) await applyCloudCopy(cloud.report, cloud.photos, true)
    }
  }

  async function flushReportDeletes() {
    const remaining: string[] = []
    for (const id of d.getPendingReportDeletes()) {
      const res = await d.fetch(`/api/reports/${id}`, { method: "DELETE" }).catch(() => null)
      // Approved in the cloud, so it was not deleted there: stop asking; the next fetch brings it back to this device.
      if (res?.status === 423) continue
      if (!res?.ok) remaining.push(id)
    }
    d.setPendingReportDeletes(remaining)
  }

  let running: Promise<void> | null = null

  function syncAll(): Promise<void> {
    if (!d.online()) return Promise.resolve()
    running ??= (async () => {
      try {
        await flushReportDeletes()
        for (const report of await d.listReports()) {
          const photos = await d.listPhotos(report.id)
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

  function syncReport(id: string): Promise<PushResult> {
    if (!d.online()) return Promise.resolve("nothing")
    return pushReport(id)
  }

  /**
   * Settle a conflict, or changes refused for an approved report, with the person's choice.
   * local: this device's version replaces the cloud copy (refused again if the cloud changed once more meanwhile).
   *        Not possible for an approved report: withdraw the approval instead (withdrawApproval).
   * cloud: the cloud copy replaces this device's; photos added here and not yet sent are kept and sent.
   * both:  this device's version, with its photos, is saved as a new draft report (without the Fleet Manager's
   *        signature, which belongs to the original); this one takes the cloud copy.
   */
  async function resolveSyncConflict(id: string, choice: ConflictChoice): Promise<ResolveOutcome> {
    const state = d.getSyncState(id)
    const conflict = state.conflict
    if (!conflict && !state.locked) return { result: "nothing" }
    if (choice === "local" && !conflict) throw new Error("An approved report cannot be replaced. Withdraw the approval instead.")
    const report = await d.getReport(id)
    if (!report) {
      d.setSyncState(id, null)
      return { result: "nothing" }
    }

    if (choice === "local" && conflict) {
      d.setSyncState(id, { base: conflict.serverUpdatedAt })
      await d.putReport({ ...report, updatedAt: Math.max(d.now(), conflict.serverUpdatedAt + 1, report.updatedAt + 1) })
      return { result: await pushReport(id) }
    }

    const cloud = await fetchCloudCopy(id)
    if (!cloud) throw new Error("The cloud copy could not be loaded.")

    let copyId: string | undefined
    if (choice === "both") {
      copyId = d.newId()
      const at = d.now()
      const devicePhotos = await d.listPhotos(id)
      await d.putReport({
        ...report,
        id: copyId,
        createdAt: at,
        updatedAt: at,
        syncedAt: undefined,
        deletedPhotoIds: [],
        signoff: { ...report.signoff, fleetManagerSignature: "" },
      })
      for (const photo of devicePhotos) {
        await d.putPhoto({ ...photo, id: d.newId(), reportId: copyId, updatedAt: at, syncedAt: undefined })
      }
    }
    // For "both" every photo of this device's version is in the copy, so this report takes exactly the cloud's photos.
    await applyCloudCopy(cloud.report, cloud.photos, choice === "cloud")
    return copyId ? { result: "synced", copyId } : { result: "synced" }
  }

  /**
   * Withdraw the Fleet Manager's approval so the report can be corrected (the reason is required). In the cloud the
   * approved version is kept permanently, with who withdrew it and why. This device's copy, including any changes the
   * cloud refused while it was approved, then becomes the report and must be approved again.
   */
  async function withdrawApproval(id: string, reason: string): Promise<WithdrawOutcome> {
    const report = await d.getReport(id)
    if (!report) return { result: "nothing", withdrawn: null }
    const res = await d.fetch(`/api/reports/${id}/reopen`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ reason, baseUpdatedAt: baseOf(report) }),
    })
    const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string; updatedAt?: unknown; serverUpdatedAt?: unknown }
    const withdrawn = { ...report, signoff: { ...report.signoff, fleetManagerSignature: "" } }

    if (res.ok) {
      const cloudVersion = Number(body.updatedAt)
      d.setSyncState(id, { base: cloudVersion })
      await d.putReport({ ...withdrawn, updatedAt: Math.max(d.now(), cloudVersion + 1, report.updatedAt + 1) })
      return { result: await pushReport(id), withdrawn: "cloud" }
    }
    if (res.status === 409 && body.status === "stale") {
      // This copy is not based on the cloud's current version: settle that first.
      const { locked: _l, ...rest } = d.getSyncState(id)
      d.setSyncState(id, { ...rest, conflict: { serverUpdatedAt: Number(body.serverUpdatedAt) || 0, detectedAt: d.now() } })
      return { result: "conflict", withdrawn: null }
    }
    if (res.status === 404 || (res.status === 409 && body.status === "not-approved")) {
      // The approval never reached the cloud (made on this device and not yet sent): withdraw it here.
      const { locked: _l, ...rest } = d.getSyncState(id)
      d.setSyncState(id, rest)
      await d.putReport({ ...withdrawn, updatedAt: Math.max(d.now(), report.updatedAt + 1) })
      return { result: await pushReport(id), withdrawn: "device" }
    }
    throw new Error(body.error || "The approval could not be withdrawn.")
  }

  return { pushReport, pullReports, syncAll, syncReport, resolveSyncConflict, withdrawApproval }
}

const browserEngine = createSyncEngine({
  fetch: apiFetch,
  getReport: local.getReport,
  putReport: local.putReport,
  listReports: local.listReports,
  listPhotos: local.listPhotos,
  putPhoto: local.putPhoto,
  deletePhotoLocal: local.deletePhotoLocal,
  getPendingReportDeletes: local.getPendingReportDeletes,
  setPendingReportDeletes: local.setPendingReportDeletes,
  getSyncState: local.getSyncState,
  setSyncState: local.setSyncState,
  newId: local.newId,
  now: () => Date.now(),
  online: () => typeof navigator === "undefined" || navigator.onLine,
})

export const syncAll = browserEngine.syncAll
export const syncReport = browserEngine.syncReport
export const resolveSyncConflict = browserEngine.resolveSyncConflict
export const withdrawApproval = browserEngine.withdrawApproval
