"use client"

// Vessel Master in the browser: the vessel list and each vessel's SIR view are kept in IndexedDB ("sir-vessel-master")
// so a report can be started offline. Always the network first; the saved copy only when the server cannot be reached
// (or refuses), and then the result says so, with the time it was fetched. Nothing is ever invented: no copy -> null.

import { createStore, get, set } from "idb-keyval"
import { apiFetch } from "./api"
import type { PickerEntry, VesselView } from "./vessel-master/view"

export type Cached<T> = { data: T; fetchedAt: string; source: "network" | "cache" }

let store: ReturnType<typeof createStore> | undefined
const masterStore = () => (store ??= createStore("sir-vessel-master", "master"))

/** Network first, then the saved copy. Exported for tests (the network and the store are passed in). */
export async function networkFirst<T>(
  load: () => Promise<{ data: T; fetchedAt: string } | null>,
  read: () => Promise<{ data: T; fetchedAt: string } | undefined>,
  write: (value: { data: T; fetchedAt: string }) => Promise<void>,
): Promise<Cached<T> | null> {
  let fresh: { data: T; fetchedAt: string } | null = null
  try {
    fresh = await load()
  } catch {
    fresh = null // offline or the server is not running
  }
  if (fresh) {
    await write(fresh).catch(() => undefined) // a full or blocked browser store must not hide fresh data
    return { ...fresh, source: "network" }
  }
  const saved = await read().catch(() => undefined)
  return saved ? { ...saved, source: "cache" } : null
}

async function loadJson<T>(url: string, pick: (body: Record<string, unknown>) => T): Promise<{ data: T; fetchedAt: string } | null> {
  const res = await apiFetch(url)
  if (!res.ok) return null
  const body = (await res.json()) as Record<string, unknown>
  return { data: pick(body), fetchedAt: String(body.fetchedAt ?? new Date().toISOString()) }
}

export function fetchVesselList(): Promise<Cached<PickerEntry[]> | null> {
  return networkFirst(
    () => loadJson("/api/vessels", (b) => b.vessels as PickerEntry[]),
    () => get("list", masterStore()),
    (value) => set("list", value, masterStore()),
  )
}

export function fetchVesselView(vesselId: string): Promise<Cached<VesselView> | null> {
  return networkFirst(
    () => loadJson(`/api/vessels/${encodeURIComponent(vesselId)}`, (b) => b.vessel as VesselView),
    () => get(`vessel:${vesselId}`, masterStore()),
    (value) => set(`vessel:${vesselId}`, value, masterStore()),
  )
}
