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
