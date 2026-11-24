// Sync conflicts (P0-1 of the 24 Nov 2026 audit): two devices editing the same report must never silently lose either
// version. Two simulated devices sync with an in-memory cloud that applies the same write rule as the API route
// (lib/report-write.ts); nothing touches a browser, MongoDB or real data.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEmptyReport, type Photo, type Report } from "../lib/form-schema"
import { decideReportWrite, readBaseUpdatedAt } from "../lib/report-write"
import { createSyncEngine, type SyncDeps, type SyncState } from "../lib/sync"

const ID = "report00000001"

// ---------------------------------------------------------------- an in-memory cloud with the API's rules

type Cloud = { reports: Map<string, Report>; photos: Map<string, Photo>; reportWrites: number }

const newCloud = (): Cloud => ({ reports: new Map(), photos: new Map(), reportWrites: 0 })
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

async function cloudFetch(cloud: Cloud, url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const match = url.match(/^\/api\/reports(?:\/([^/]+))?(?:\/photos\/([^/]+))?$/)
  if (!match) return reply({ error: "Not found" }, 404)
  const [, id, photoId] = match
  if (!id) return reply({ reports: [...cloud.reports.values()].map((r) => ({ id: r.id, updatedAt: r.updatedAt })) })
  if (photoId) {
    if (method === "PUT") cloud.photos.set(photoId, JSON.parse(String(init.body)))
    if (method === "DELETE") cloud.photos.delete(photoId)
    return reply({ status: "ok" })
  }
  if (method === "GET") {
    const report = cloud.reports.get(id)
    if (!report) return reply({ error: "Not found" }, 404)
    return reply({ report, photos: [...cloud.photos.values()].filter((p) => p.reportId === id) })
  }
  if (method === "DELETE") {
    cloud.reports.delete(id)
    return reply({ status: "ok" })
  }
  const { baseUpdatedAt, ...doc } = JSON.parse(String(init.body)) as Report & { baseUpdatedAt?: unknown }
  const existing = cloud.reports.get(id)
  const decision = decideReportWrite({
    serverUpdatedAt: existing ? existing.updatedAt : null,
    updatedAt: doc.updatedAt,
    baseUpdatedAt: readBaseUpdatedAt(baseUpdatedAt),
  })
  if (decision === "conflict") return reply({ status: "stale", serverUpdatedAt: existing!.updatedAt }, 409)
  if (decision !== "unchanged") {
    cloud.reports.set(id, doc as Report)
    cloud.reportWrites++
  }
  return reply({ status: "ok", updatedAt: doc.updatedAt })
}

// ---------------------------------------------------------------- a device: its own storage, clock and sync engine

function newDevice(cloud: Cloud, startClock: number) {
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
    conflict: (id = ID) => states.get(id)?.conflict,
    advance: (ms: number) => void (clock += ms),
    put: (report: Report) => void reports.set(report.id, clone(report)),
    /** An edit in the editor: changes the report and stamps it with this device's clock. */
    edit(mutate: (r: Report) => void, id = ID) {
      const r = clone(reports.get(id)!)
      mutate(r)
      r.updatedAt = clock
      reports.set(id, r)
    },
    addPhoto(photoId: string, caption: string) {
      photos.set(photoId, {
        id: photoId, reportId: ID, category: "Main deck", caption, includeInOwnerReport: true,
        dataUrl: "data:image/png;base64,AA==", createdAt: clock, updatedAt: clock,
      })
    },
    onCloudAnswer: (fn: typeof afterCloud) => void (afterCloud = fn),
    loseNextResponse: () => void (loseNextResponse = true),
  }
}

/** Device A creates the report and syncs it; device B fetches it. Both then hold the same cloud version. */
async function twoDevicesSharingAReport() {
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

// ---------------------------------------------------------------- the write rule

describe("cloud write rule", () => {
  test("a save based on the cloud's current version is written", () => {
    assert.equal(decideReportWrite({ serverUpdatedAt: 100, updatedAt: 200, baseUpdatedAt: 100 }), "write")
  })
  test("a save based on an older cloud version is a conflict, whatever its timestamp", () => {
    assert.equal(decideReportWrite({ serverUpdatedAt: 150, updatedAt: 200, baseUpdatedAt: 100 }), "conflict")
    assert.equal(decideReportWrite({ serverUpdatedAt: 150, updatedAt: 120, baseUpdatedAt: 100 }), "conflict")
  })
  test("a save the cloud already holds (a retry) is accepted without writing", () => {
    assert.equal(decideReportWrite({ serverUpdatedAt: 200, updatedAt: 200, baseUpdatedAt: 100 }), "unchanged")
  })
  test("a new report is inserted", () => {
    assert.equal(decideReportWrite({ serverUpdatedAt: null, updatedAt: 200 }), "insert")
  })
  test("older tabs that send no base keep the previous rule", () => {
    assert.equal(decideReportWrite({ serverUpdatedAt: 150, updatedAt: 200 }), "write")
    assert.equal(decideReportWrite({ serverUpdatedAt: 250, updatedAt: 200 }), "conflict")
  })
  test("the base is used only when it is a number", () => {
    assert.equal(readBaseUpdatedAt(undefined), undefined)
    assert.equal(readBaseUpdatedAt(null), undefined)
    assert.equal(readBaseUpdatedAt("x"), undefined)
    assert.equal(readBaseUpdatedAt(123), 123)
  })
})

// ---------------------------------------------------------------- detecting conflicts without losing anything

describe("sync conflicts are detected and nothing is lost", () => {
  test("ordinary editing on one device syncs as before", async () => {
    const { cloud, a } = await twoDevicesSharingAReport()
    for (const port of ["Fujairah", "Rotterdam", "Houston"]) {
      a.advance(1_000)
      a.edit((r) => void (r.details.port = port))
      assert.equal(await a.engine.syncReport(ID), "synced")
    }
    assert.equal(cloud.reports.get(ID)!.details.port, "Houston")
    assert.equal(a.conflict(), undefined)
  })

  test("the audit's case: an older save is refused, kept on the device and not replaced by the next fetch", async () => {
    const { cloud, a, b } = await twoDevicesSharingAReport()
    b.advance(2_000) // B's clock: 3,000
    b.edit((r) => void (r.details.port = "Port by B"))
    await b.engine.syncAll()
    a.advance(500) // A's clock: 1,500, older than B's save
    a.edit((r) => void (r.details.port = "Port by A"))

    assert.equal(await a.engine.syncReport(ID), "conflict")
    assert.equal(a.conflict()?.serverUpdatedAt, 3_000)
    await a.engine.syncAll() // includes fetching from the cloud: before the fix this replaced A's changes
    assert.equal(a.report().details.port, "Port by A", "A's own changes are still on A")
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by B", "B's changes are still in the cloud")
  })

  test("a newer save from a device that never saw the other's save is a conflict too (no silent overwrite)", async () => {
    const { cloud, a, b } = await twoDevicesSharingAReport()
    b.advance(1_000)
    b.edit((r) => void (r.details.port = "Port by B"))
    await b.engine.syncAll()
    a.advance(9_000) // A's clock is ahead of B's: before the fix A's save replaced B's
    a.edit((r) => void (r.details.port = "Port by A"))

    assert.equal(await a.engine.syncReport(ID), "conflict")
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by B")
  })

  test("a report in conflict is neither sent nor fetched until the person chooses", async () => {
    const { cloud, a, b } = await twoDevicesSharingAReport()
    b.advance(1_000)
    b.edit((r) => void (r.details.port = "Port by B"))
    await b.engine.syncAll()
    a.advance(2_000)
    a.edit((r) => void (r.details.port = "Port by A"))
    await a.engine.syncAll()
    const writes = cloud.reportWrites
    a.advance(1_000)
    a.edit((r) => void (r.details.reportNo = "SIR-2026-099")) // A keeps working
    await a.engine.syncAll()
    assert.equal(cloud.reportWrites, writes, "nothing was sent")
    assert.equal(a.report().details.reportNo, "SIR-2026-099")
    assert.equal(a.report().details.port, "Port by A")
  })

  test("a retry after a lost response is not a conflict", async () => {
    const { cloud, a } = await twoDevicesSharingAReport()
    a.advance(1_000)
    a.edit((r) => void (r.details.port = "Fujairah"))
    a.loseNextResponse()
    await assert.rejects(a.engine.syncReport(ID))
    assert.equal(cloud.reports.get(ID)!.details.port, "Fujairah", "the cloud did save it")
    assert.equal(await a.engine.syncReport(ID), "synced")
    assert.equal(a.conflict(), undefined)
  })

  test("typing while a save is being sent does not cause a false conflict", async () => {
    const { cloud, a } = await twoDevicesSharingAReport()
    a.advance(1_000)
    a.edit((r) => void (r.details.port = "Fujairah"))
    a.onCloudAnswer((url, init) => {
      if (init.method === "PUT" && url === `/api/reports/${ID}`) {
        a.advance(300)
        a.edit((r) => void (r.details.reportNo = "typed during the save"))
      }
    })
    assert.equal(await a.engine.syncReport(ID), "synced")
    a.onCloudAnswer(null)
    assert.equal(await a.engine.syncReport(ID), "synced", "the later edit is sent, not refused")
    assert.equal(cloud.reports.get(ID)!.details.reportNo, "typed during the save")
    assert.equal(a.conflict(), undefined)
  })

  test("a report saved by the earlier version of the app after a refused save is now caught as a conflict", async () => {
    const { cloud, a, b } = await twoDevicesSharingAReport()
    b.advance(2_000)
    b.edit((r) => void (r.details.port = "Port by B"))
    await b.engine.syncAll()
    // The earlier app marked A's refused copy as synced at its own timestamp, with no separate record of the base.
    a.advance(500)
    a.edit((r) => void (r.details.port = "Port by A"))
    a.put({ ...a.report(), syncedAt: a.report().updatedAt })
    a.advance(100)
    a.edit((r) => void (r.details.reportNo = "next edit"))
    // simulate the earlier app's state: no base recorded for this report
    const fresh = newDevice(cloud, 1_600)
    fresh.put(a.report())
    assert.equal(await fresh.engine.syncReport(ID), "conflict")
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by B")
  })
})

// ---------------------------------------------------------------- the person's choice

async function conflictWithAPhotoOnA() {
  const setup = await twoDevicesSharingAReport()
  const { a, b } = setup
  b.advance(1_000)
  b.edit((r) => void (r.details.port = "Port by B"))
  await b.engine.syncAll()
  a.advance(2_000)
  a.addPhoto("photoA00000001", "taken on A")
  a.edit((r) => void (r.details.port = "Port by A"))
  assert.equal(await a.engine.syncReport(ID), "conflict")
  return setup
}

describe("settling a conflict", () => {
  test("this device's version: it replaces the cloud copy, and the other device then receives it", async () => {
    const { cloud, a, b } = await conflictWithAPhotoOnA()
    a.advance(100)
    assert.deepEqual(await a.engine.resolveSyncConflict(ID, "local"), { result: "synced" })
    assert.equal(a.conflict(), undefined)
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by A")
    assert.ok(cloud.photos.has("photoA00000001"), "A's photo was sent")
    await b.engine.syncAll()
    assert.equal(b.report().details.port, "Port by A")
  })

  test("this device's version is refused again if the cloud changed once more meanwhile", async () => {
    const { cloud, a, b } = await conflictWithAPhotoOnA()
    b.advance(5_000)
    b.edit((r) => void (r.details.port = "Port by B, again"))
    await b.engine.syncAll()
    assert.equal((await a.engine.resolveSyncConflict(ID, "local")).result, "conflict")
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by B, again")
    assert.ok(a.conflict())
  })

  test("the cloud version: it replaces this device's copy; photos added here are kept and sent", async () => {
    const { cloud, a } = await conflictWithAPhotoOnA()
    assert.deepEqual(await a.engine.resolveSyncConflict(ID, "cloud"), { result: "synced" })
    assert.equal(a.report().details.port, "Port by B")
    assert.equal(a.conflict(), undefined)
    assert.ok(a.photos.has("photoA00000001"), "the photo taken on A is kept")
    assert.equal(await a.engine.syncReport(ID), "synced")
    assert.ok(cloud.photos.has("photoA00000001"))
  })

  test("keep both: this device's version, with its photos, becomes a separate report; this one shows the cloud version", async () => {
    const { cloud, a } = await conflictWithAPhotoOnA()
    const outcome = await a.engine.resolveSyncConflict(ID, "both")
    assert.equal(outcome.result, "synced")
    const copyId = outcome.copyId!
    assert.ok(copyId && copyId !== ID)

    assert.equal(a.report(copyId).details.port, "Port by A")
    const copyPhotos = [...a.photos.values()].filter((p) => p.reportId === copyId)
    assert.equal(copyPhotos.length, 1)
    assert.equal(copyPhotos[0].caption, "taken on A")
    assert.notEqual(copyPhotos[0].id, "photoA00000001", "the copy's photos have their own ids")

    assert.equal(a.report().details.port, "Port by B")
    assert.equal([...a.photos.values()].filter((p) => p.reportId === ID).length, 0, "the original shows exactly the cloud's photos")
    assert.equal(a.conflict(), undefined)

    await a.engine.syncAll()
    assert.equal(cloud.reports.get(copyId)!.details.port, "Port by A", "the copy reaches the cloud as a new report")
    assert.equal(cloud.reports.get(ID)!.details.port, "Port by B")
  })

  test("with no conflict recorded, nothing happens", async () => {
    const { a } = await twoDevicesSharingAReport()
    assert.deepEqual(await a.engine.resolveSyncConflict(ID, "local"), { result: "nothing" })
  })
})
