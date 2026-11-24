"use client"

import { createStore, del, get, set, values } from "idb-keyval"
import type { Photo, Report } from "./form-schema"

const reportStore = () => createStore("sir-reports", "reports")
const photoStore = () => createStore("sir-photos", "photos")

let reportStoreInstance: ReturnType<typeof createStore> | undefined
let photoStoreInstance: ReturnType<typeof createStore> | undefined
const reports = () => (reportStoreInstance ??= reportStore())
const photos = () => (photoStoreInstance ??= photoStore())

export function newId() {
  return crypto.randomUUID().replace(/-/g, "")
}

export async function listReports(): Promise<Report[]> {
  const all = await values<Report>(reports())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export const getReport = (id: string) => get<Report>(id, reports())
export const putReport = (report: Report) => set(report.id, report, reports())

export async function deleteReportLocal(id: string) {
  const reportPhotos = await listPhotos(id)
  await Promise.all(reportPhotos.map((p) => del(p.id, photos())))
  await del(id, reports())
  setSyncState(id, null)
}

export async function listPhotos(reportId: string): Promise<Photo[]> {
  const all = await values<Photo>(photos())
  return all.filter((p) => p.reportId === reportId).sort((a, b) => a.createdAt - b.createdAt)
}

export const putPhoto = (photo: Photo) => set(photo.id, photo, photos())
export const deletePhotoLocal = (id: string) => del(id, photos())

const DELETED_KEY = "sir-deleted-reports"

export function getPendingReportDeletes(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(DELETED_KEY) ?? "[]")
  } catch {
    return []
  }
}

export function setPendingReportDeletes(ids: string[]) {
  window.localStorage.setItem(DELETED_KEY, JSON.stringify(ids))
}

// Sync state per report, written only by the sync code (lib/sync.ts), never by the editor's autosave:
//   base      the cloud version this device's copy is based on (the cloud's updatedAt at the last sync)
//   conflict  the cloud copy changed elsewhere since then; this device's copy is kept and not sent until the person
//             chooses what to keep
//   locked    the cloud copy has been approved, so the changes on this device were refused; they are kept here and
//             not sent until the person withdraws the approval or chooses what to keep
// If this is ever lost (site data cleared), nothing is lost with it: the copy's own syncedAt is used as the base, and a
// conflict is detected again on the next sync.
const SYNC_STATE_KEY = "sir-sync-state"

export type SyncConflict = { serverUpdatedAt: number; detectedAt: number }
export type SyncLock = { approvedBy: string; approvedOn: string; serverUpdatedAt: number; detectedAt: number }
export type SyncState = { base?: number; conflict?: SyncConflict; locked?: SyncLock }

function readSyncStates(): Record<string, SyncState> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SYNC_STATE_KEY) ?? "{}")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function getSyncState(id: string): SyncState {
  return readSyncStates()[id] ?? {}
}

export function setSyncState(id: string, state: SyncState | null) {
  try {
    const all = readSyncStates()
    if (state && (state.base !== undefined || state.conflict || state.locked)) all[id] = state
    else delete all[id]
    window.localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: the next sync falls back to the report's syncedAt and detects any conflict again.
  }
}
