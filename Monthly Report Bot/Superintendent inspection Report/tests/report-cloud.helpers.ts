// Test helpers: an in-memory cloud that applies the same rules as the report API routes (lib/report-write.ts), and
// simulated devices running the real sync engine (lib/sync.ts) with their own storage and clock. Nothing touches a
// browser, MongoDB or real data.

import assert from "node:assert/strict"
import { createEmptyReport, type Photo, type Report } from "../lib/form-schema"
import {
  OPTIONAL_SECTIONS,
  REPORT_SECTIONS,
  checkReopenReason,
  planPhotoDelete,
  planPhotoSave,
  planReopen,
  planReportDelete,
  planReportSave,
  readBaseUpdatedAt,
  withdrawnSignoff,
} from "../lib/report-write"
import { createSyncEngine, type SyncDeps, type SyncState } from "../lib/sync"

export const ID = "report00000001"

export type Cloud = {
  reports: Map<string, Report>
  photos: Map<string, Photo>
  reportWrites: number
  audit: { reportId: string; action: string; detail?: unknown }[]
  revisions: { reportId: string; revision: number; reason: string; report: Report; photos: Photo[] }[]
  deleted: Report[]
}

export const newCloud = (): Cloud => ({ reports: new Map(), photos: new Map(), reportWrites: 0, audit: [], revisions: [], deleted: [] })

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const lockedReply = (report: Report) =>
  reply({ status: "locked", approvedBy: report.signoff.fleetManagerName, approvedOn: report.signoff.fleetManagerDate, serverUpdatedAt: report.updatedAt }, 423)

export async function cloudFetch(cloud: Cloud, url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const match = url.match(/^\/api\/reports(?:\/([^/]+))?(?:\/(reopen)|\/photos\/([^/]+))?$/)
  if (!match) return reply({ error: "Not found" }, 404)
  const [, id, reopen, photoId] = match
  const body = init.body ? JSON.parse(String(init.body)) : {}
  if (!id) return reply({ reports: [...cloud.reports.values()].map((r) => ({ id: r.id, updatedAt: r.updatedAt })) })
  const stored = cloud.reports.get(id) ?? null

  if (photoId) {
    if (method === "PUT") {
      const plan = planPhotoSave(stored as never, cloud.photos.get(photoId) ?? null, body)
      if (plan === "locked") return lockedReply(stored!)
      if (plan === "write") cloud.photos.set(photoId, body)
    }
    if (method === "DELETE") {
      if (planPhotoDelete(stored as never) === "locked") return lockedReply(stored!)
      cloud.photos.delete(photoId)
    }
    return reply({ status: "ok" })
  }

  if (reopen) {
    const checked = checkReopenReason(body.reason)
    if ("error" in checked) return reply({ error: checked.error }, 400)
    const plan = planReopen(stored as never, readBaseUpdatedAt(body.baseUpdatedAt))
    if (plan === "not-found") return reply({ status: "not-found" }, 404)
    if (plan !== "reopen") return reply({ status: plan, serverUpdatedAt: stored!.updatedAt }, 409)
    const photos = [...cloud.photos.values()].filter((p) => p.reportId === id)
    cloud.revisions.push({ reportId: id, revision: cloud.revisions.filter((r) => r.reportId === id).length + 1, reason: checked.reason, report: structuredClone(stored!), photos: structuredClone(photos) })
    const updatedAt = Math.max(Date.now(), stored!.updatedAt + 1)
    cloud.reports.set(id, { ...stored!, signoff: withdrawnSignoff(stored!.signoff), updatedAt })
    cloud.audit.push({ reportId: id, action: "withdraw-approval", detail: checked.reason })
    return reply({ status: "ok", updatedAt, previousUpdatedAt: stored!.updatedAt })
  }

  if (method === "GET") {
    if (!stored) return reply({ error: "Not found" }, 404)
    return reply({ report: stored, photos: [...cloud.photos.values()].filter((p) => p.reportId === id) })
  }

  if (method === "DELETE") {
    const plan = planReportDelete(stored as never)
    if (plan === "locked") {
      cloud.audit.push({ reportId: id, action: "change-refused", detail: "delete" })
      return lockedReply(stored!)
    }
    if (plan === "delete") {
      cloud.deleted.push(structuredClone(stored!))
      cloud.reports.delete(id)
      for (const photo of [...cloud.photos.values()]) if (photo.reportId === id) cloud.photos.delete(photo.id)
      cloud.audit.push({ reportId: id, action: "delete" })
    }
    return reply({ status: "ok" })
  }

  // PUT: the same document the route builds, then the same plan.
  const doc: Record<string, unknown> & { updatedAt: number } = { id, updatedAt: Number(body.updatedAt), createdAt: Number(body.createdAt) }
  for (const key of REPORT_SECTIONS) doc[key] = body[key] && typeof body[key] === "object" ? body[key] : {}
  for (const key of OPTIONAL_SECTIONS) if (body[key] && typeof body[key] === "object") doc[key] = body[key]
  const plan = planReportSave({ stored: stored as never, incoming: doc, baseUpdatedAt: readBaseUpdatedAt(body.baseUpdatedAt) })
  switch (plan.action) {
    case "conflict":
      return reply({ status: "stale", serverUpdatedAt: plan.serverUpdatedAt }, 409)
    case "locked":
      cloud.audit.push({ reportId: id, action: "change-refused", detail: "save" })
      return reply({ status: "locked", approvedBy: plan.approvedBy, approvedOn: plan.approvedOn, serverUpdatedAt: plan.serverUpdatedAt }, 423)
    case "unchanged":
      break
    case "touch":
      cloud.reports.set(id, { ...stored!, updatedAt: doc.updatedAt })
      break
    default:
      cloud.reports.set(id, doc as unknown as Report)
      cloud.reportWrites++
  }
  if (plan.action !== "unchanged" && plan.approves) cloud.audit.push({ reportId: id, action: "approve" })
  return reply({ status: "ok", updatedAt: doc.updatedAt })
}

export function newDevice(cloud: Cloud, startClock: number) {
  let clock = startClock
  const reports = new Map<string, Report>()
  const photos = new Map<string, Photo>()
  const states = new Map<string, SyncState>()
  let pending: string[] = []
  let copies = 0
  /** Runs after the cloud has answered, before the device reads the answer (e.g. the person types during a save). */
  let afterCloud: ((url: string, init: RequestInit) => void) | null = null
  /** Simulates a lost response: the cloud applies the request, the device sees a network error. */
  let loseNextResponse = false
  const clone = <T>(value: T): T => structuredClone(value)

  const deps: SyncDeps = {
    fetch: async (url, init = {}) => {
      const res = await cloudFetch(cloud, url, init)
      afterCloud?.(url, init)
      if (loseNextResponse) {
        loseNextResponse = false
        throw new TypeError("Failed to fetch")
      }
      return res
    },
    getReport: async (id) => (reports.has(id) ? clone(reports.get(id)) : undefined),
    putReport: async (report) => void reports.set(report.id, clone(report)),
    listReports: async () => [...reports.values()].map(clone),
    listPhotos: async (reportId) =>
      [...photos.values()].filter((p) => p.reportId === reportId).sort((a, b) => a.createdAt - b.createdAt).map(clone),
    putPhoto: async (photo) => void photos.set(photo.id, clone(photo)),
    deletePhotoLocal: async (id) => void photos.delete(id),
    getPendingReportDeletes: () => [...pending],
    setPendingReportDeletes: (ids) => void (pending = [...ids]),
    getSyncState: (id) => clone(states.get(id) ?? {}),
    setSyncState: (id, state) => void (state ? states.set(id, clone(state)) : states.delete(id)),
    newId: () => `copy${String(++copies).padStart(10, "0")}`,
    now: () => clock,
    online: () => true,
  }

  return {
    engine: createSyncEngine(deps),
    reports,
    photos,
    report: (id = ID) => reports.get(id)!,
    state: (id = ID) => states.get(id) ?? {},
    conflict: (id = ID) => states.get(id)?.conflict,
    pending: () => [...pending],
    advance: (ms: number) => void (clock += ms),
    put: (report: Report) => void reports.set(report.id, clone(report)),
    /** An edit in the editor: changes the report and stamps it as the editor does (this device's clock, always later). */
    edit(mutate: (r: Report) => void, id = ID) {
      const r = clone(reports.get(id)!)
      mutate(r)
      r.updatedAt = Math.max(clock, r.updatedAt + 1)
      reports.set(id, r)
    },
    addPhoto(photoId: string, caption: string, reportId = ID) {
      photos.set(photoId, {
        id: photoId, reportId, category: "Main deck", caption, includeInOwnerReport: true,
        dataUrl: "data:image/png;base64,AA==", createdAt: clock, updatedAt: clock,
      })
    },
    /** Delete in the list: gone from this device at once, deleted in the cloud on the next sync. */
    deleteLocally(id = ID) {
      reports.delete(id)
      for (const photo of [...photos.values()]) if (photo.reportId === id) photos.delete(photo.id)
      states.delete(id)
      pending.push(id)
    },
    onCloudAnswer: (fn: typeof afterCloud) => void (afterCloud = fn),
    loseNextResponse: () => void (loseNextResponse = true),
  }
}

export type Device = ReturnType<typeof newDevice>

/** Device A creates the report and syncs it; device B fetches it. Both then hold the same cloud version. */
export async function twoDevicesSharingAReport() {
  const cloud = newCloud()
  const a = newDevice(cloud, 1_000)
  const b = newDevice(cloud, 1_000)
  const report = createEmptyReport(ID)
  report.createdAt = report.updatedAt = 1_000
  report.details = { vessel: "DHT LEOPARD", port: "Singapore" }
  a.put(report)
  await a.engine.syncAll()
  await b.engine.syncAll()
  assert.equal(b.report().details.port, "Singapore", "B has the shared version")
  return { cloud, a, b }
}

/** Approves the report on a device, as the Fleet Manager's name, date and signature do in Sign-off. */
export function approveOn(device: Device, id = ID) {
  device.edit((r) => {
    r.signoff = { ...r.signoff, fleetManagerName: "Vijoy Dick", fleetManagerDate: "2026-11-20", fleetManagerSignature: "data:image/png;base64,SIG=" }
  }, id)
}
