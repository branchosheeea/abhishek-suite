"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { isApproved } from "@/lib/completeness"
import { createEmptyReport, type Photo, type Report } from "@/lib/form-schema"
import { deletePhotoLocal, getReport, getSyncState, listPhotos, newId, putPhoto, putReport, setSyncState } from "@/lib/local-db"
import { apiFetch } from "@/lib/api"
import {
  resolveSyncConflict,
  syncReport,
  withdrawApproval,
  type ConflictChoice,
  type ResolveOutcome,
  type SyncState,
  type WithdrawOutcome,
} from "@/lib/sync"

/**
 * conflict: the cloud copy was changed elsewhere; this device's copy is kept and not sent until the person chooses.
 * locked: the report is approved in the cloud, so this device's changes were refused; they are kept here meanwhile.
 */
export type SaveState = "idle" | "saving" | "saved" | "synced" | "sync-error" | "conflict" | "locked"

/** An approved report is read-only: it changes only by withdrawing the approval (see lib/report-write.ts). */
const readOnly = (report: Report | null) => Boolean(report && isApproved(report))

// A report that is not on this device yet (opened from a link or bookmark) is fetched from the cloud first.
// Creating an empty draft instead would carry a newer timestamp and overwrite the cloud copy on the next sync.
async function fetchFromCloud(id: string): Promise<Report | null | "locked"> {
  if (!navigator.onLine) return null
  try {
    const res = await apiFetch(`/api/reports/${id}`, { cache: "no-store" })
    // Not signed in to NeraVeda: never fall back to an empty draft, which would overwrite the cloud copy later.
    if (res.status === 401 || res.status === 403 || res.status === 503) return "locked"
    if (!res.ok) return null
    const { report, photos } = (await res.json()) as { report: Report; photos: Photo[] }
    const local: Report = { ...createEmptyReport(id), ...report, deletedPhotoIds: [], syncedAt: report.updatedAt }
    await putReport(local)
    for (const photo of photos) await putPhoto({ ...photo, syncedAt: photo.updatedAt })
    setSyncState(id, { base: report.updatedAt })
    return local
  } catch {
    return null
  }
}

async function loadOrCreate(id: string) {
  const local = await getReport(id)
  const cloud = local ? null : await fetchFromCloud(id)
  if (cloud === "locked") throw new Error("Open Inspection Reports from NeraVeda to load this report.")
  const existing = local ?? cloud
  const report = existing ?? createEmptyReport(id)
  if (!existing) await putReport(report)
  const photos = await listPhotos(id)
  return { report, photos }
}

export function useReportEditor(id: string) {
  const { data, isLoading } = useSWR(["report-editor", id], () => loadOrCreate(id), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  })

  const [report, setReport] = useState<Report | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [syncIssue, setSyncIssue] = useState<SyncState>({})
  const saveTimer = useRef<number | undefined>(undefined)
  const syncTimer = useRef<number | undefined>(undefined)
  const latest = useRef<Report | null>(null)

  /** Reads this report's open conflict or lock (kept by lib/sync.ts) and returns the save state it implies, if any. */
  const readIssue = useCallback((): SaveState | null => {
    const state = getSyncState(id)
    setSyncIssue({ conflict: state.conflict, locked: state.locked })
    return state.conflict ? "conflict" : state.locked ? "locked" : null
  }, [id])

  useEffect(() => {
    if (data && !latest.current) {
      latest.current = data.report
      setReport(data.report)
      setPhotos(data.photos)
      readIssue()
    }
  }, [data, readIssue])

  const runSync = useCallback(async () => {
    if (!navigator.onLine) return
    try {
      await syncReport(id)
      const fresh = await getReport(id)
      if (fresh && latest.current) {
        latest.current = { ...latest.current, syncedAt: fresh.syncedAt, deletedPhotoIds: fresh.deletedPhotoIds }
      }
      setPhotos(await listPhotos(id))
      setSaveState(readIssue() ?? "synced")
    } catch {
      setSaveState("sync-error")
    }
  }, [id, readIssue])

  const scheduleSync = useCallback(() => {
    window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(runSync, 2500)
  }, [runSync])

  /** Saves on this device and syncs straight away, instead of waiting for the autosave timers. */
  const saveNow = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    window.clearTimeout(syncTimer.current)
    if (!latest.current) return
    setSaveState("saving")
    await putReport(latest.current)
    setSaveState("saved")
    await runSync()
  }, [runSync])

  const persist = useCallback(
    (next: Report) => {
      latest.current = next
      setReport(next)
      setSaveState("saving")
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(async () => {
        if (!latest.current) return
        await putReport(latest.current)
        setSaveState("saved")
        scheduleSync()
      }, 400)
    },
    [scheduleSync],
  )

  const update = useCallback(
    (mutator: (draft: Report) => Report) => {
      if (!latest.current || readOnly(latest.current)) return
      // Always later than the last save, even if this device's clock is behind the one that stamped it (e.g. the
      // server's, after an approval is withdrawn): otherwise the change would not count as unsent.
      persist({ ...mutator(latest.current), updatedAt: Math.max(Date.now(), latest.current.updatedAt + 1) })
    },
    [persist],
  )

  const addPhoto = useCallback(
    async (input: Pick<Photo, "category" | "dataUrl">) => {
      if (readOnly(latest.current)) return
      const now = Date.now()
      const photo: Photo = {
        id: newId(),
        reportId: id,
        category: input.category,
        caption: "",
        includeInOwnerReport: true,
        dataUrl: input.dataUrl,
        createdAt: now,
        updatedAt: now,
      }
      await putPhoto(photo)
      setPhotos((prev) => [...prev, photo])
      setSaveState("saved")
      scheduleSync()
    },
    [id, scheduleSync],
  )

  const updatePhoto = useCallback(
    async (photoId: string, patch: Partial<Pick<Photo, "caption" | "category" | "includeInOwnerReport">>) => {
      if (readOnly(latest.current)) return
      let updated: Photo | undefined
      setPhotos((prev) =>
        prev.map((p) => {
          if (p.id !== photoId) return p
          updated = { ...p, ...patch, updatedAt: Date.now() }
          return updated
        }),
      )
      queueMicrotask(async () => {
        if (updated) await putPhoto(updated)
        setSaveState("saved")
        scheduleSync()
      })
    },
    [scheduleSync],
  )

  const removePhoto = useCallback(
    async (photoId: string) => {
      if (readOnly(latest.current)) return
      const photo = photos.find((p) => p.id === photoId)
      await deletePhotoLocal(photoId)
      setPhotos((prev) => prev.filter((p) => p.id !== photoId))
      if (photo?.syncedAt) {
        update((r) => ({ ...r, deletedPhotoIds: [...(r.deletedPhotoIds ?? []), photoId] }))
      }
    },
    [photos, update],
  )

  /**
   * Runs a sync decision (settling a conflict, withdrawing an approval) after saving what is on screen, then shows the
   * report as it now stands on this device.
   */
  const settle = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(syncTimer.current)
      if (latest.current) await putReport(latest.current)
      setSaveState("saving")
      try {
        return await action()
      } catch (error) {
        setSaveState("sync-error")
        throw error
      } finally {
        const fresh = await getReport(id)
        if (fresh) {
          latest.current = fresh
          setReport(fresh)
        }
        setPhotos(await listPhotos(id))
        const issue = readIssue()
        setSaveState((state) => issue ?? (state === "sync-error" ? state : "synced"))
      }
    },
    [id, readIssue],
  )

  /** Settle a sync conflict, or changes refused for an approved report (see lib/sync.ts). */
  const resolveConflict = useCallback(
    (choice: ConflictChoice): Promise<ResolveOutcome> => settle(() => resolveSyncConflict(id, choice)),
    [id, settle],
  )

  /** Withdraw the Fleet Manager's approval, with a reason, so the report can be corrected and approved again. */
  const withdraw = useCallback((reason: string): Promise<WithdrawOutcome> => settle(() => withdrawApproval(id, reason)), [id, settle])

  useEffect(() => {
    const flush = () => {
      if (latest.current) void putReport(latest.current)
    }
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(syncTimer.current)
      flush()
    }
  }, [])

  useEffect(() => {
    const onOnline = () => scheduleSync()
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [scheduleSync])

  return {
    report,
    photos,
    isLoading: isLoading || !report,
    saveState,
    /** Read-only: approved by the Fleet Manager. */
    approved: readOnly(report),
    conflict: syncIssue.conflict ?? null,
    locked: syncIssue.locked ?? null,
    resolveConflict,
    withdraw,
    update,
    saveNow,
    addPhoto,
    updatePhoto,
    removePhoto,
  }
}
