"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { createEmptyReport, type Photo, type Report } from "@/lib/form-schema"
import { deletePhotoLocal, getReport, listPhotos, newId, putPhoto, putReport } from "@/lib/local-db"
import { syncReport } from "@/lib/sync"

export type SaveState = "idle" | "saving" | "saved" | "synced" | "sync-error"

async function loadOrCreate(id: string) {
  const existing = await getReport(id)
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
  const saveTimer = useRef<number | undefined>(undefined)
  const syncTimer = useRef<number | undefined>(undefined)
  const latest = useRef<Report | null>(null)

  useEffect(() => {
    if (data && !latest.current) {
      latest.current = data.report
      setReport(data.report)
      setPhotos(data.photos)
    }
  }, [data])

  const scheduleSync = useCallback(() => {
    window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(async () => {
      if (!navigator.onLine) return
      try {
        await syncReport(id)
        const fresh = await getReport(id)
        if (fresh && latest.current) {
          latest.current = { ...latest.current, syncedAt: fresh.syncedAt, deletedPhotoIds: fresh.deletedPhotoIds }
        }
        setPhotos(await listPhotos(id))
        setSaveState("synced")
      } catch {
        setSaveState("sync-error")
      }
    }, 2500)
  }, [id])

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
      if (!latest.current) return
      persist({ ...mutator(latest.current), updatedAt: Date.now() })
    },
    [persist],
  )

  const addPhoto = useCallback(
    async (input: Pick<Photo, "category" | "dataUrl">) => {
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
      const photo = photos.find((p) => p.id === photoId)
      await deletePhotoLocal(photoId)
      setPhotos((prev) => prev.filter((p) => p.id !== photoId))
      if (photo?.syncedAt) {
        update((r) => ({ ...r, deletedPhotoIds: [...(r.deletedPhotoIds ?? []), photoId] }))
      }
    },
    [photos, update],
  )

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

  return { report, photos, isLoading: isLoading || !report, saveState, update, addPhoto, updatePhoto, removePhoto }
}
