// Digital Docking · the API layer behind the screens: untrusted input is checked, errors become messages the
// Superintendent can act on, and every Docking route needs the Digital Docking right. Synthetic data only.
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { addNoteFrom, auditView, createDockingFrom, createJobFrom, dayActionFrom, dockingsView, dockingView, jobView, MAX_BODY_BYTES, readBody, updateDockingFrom } from "../lib/docking/server/api"
import { closeStore, openStore, type Store } from "../lib/docking/server/db"
import { importSubmission } from "../lib/docking/server/repo"
import { AppError } from "../lib/server/errors"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const SUPT = "supt@x.com"
let dir: string
let store: Store

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nv-docking-api-"))
  store = await openStore(dir)
})
afterEach(() => {
  closeStore(store)
  rmSync(dir, { recursive: true, force: true })
})

const BODY = { vesselName: "DHT LEOPARD", code: "LEO-2025-SS", yard: "CIMC Changhong", location: "Zhoushan", dockingType: "Special survey", utcOffsetMinutes: 480, day0Date: "2025-10-13", arrivalTime: "21:00", plannedDepartureDate: "2025-10-28" }
const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === status && pattern.test(e.message))

describe("dockings from the browser", () => {
  test("create checks types and lengths, then the repository checks the meaning", () => {
    refused(() => createDockingFrom(store, { ...BODY, utcOffsetMinutes: "480" }, SUPT), 400, /UTC offset must be a whole number/)
    refused(() => createDockingFrom(store, { ...BODY, yard: "x".repeat(121) }, SUPT), 400, /Yard is longer than 120/)
    refused(() => createDockingFrom(store, { ...BODY, dockingType: "Wet dock" }, SUPT), 400, /Docking type must be one of/)
    refused(() => createDockingFrom(store, { ...BODY, vesselName: undefined }, SUPT), 400, /Vessel is required/)
    refused(() => createDockingFrom(store, { ...BODY, vesselName: "MV OTHER" }, SUPT), 400, /not in the fleet list/)
    const d = createDockingFrom(store, { ...BODY, arrivalTime: "" }, SUPT)
    assert.deepEqual([d.code, d.arrival_time, d.status], ["LEO-2025-SS", null, "planned"])
    const list = dockingsView(store)
    assert.deepEqual([list.length, list[0].days_received, list[0].jobs, list[0].last_reported_day], [1, 0, 0, null])
  })

  test("update needs the revision it was loaded with; unknown ids are 404", () => {
    const d = createDockingFrom(store, BODY, SUPT)
    refused(() => updateDockingFrom(store, d.id, { yard: "Other" }, SUPT), 400, /Reload the docking/)
    assert.equal(updateDockingFrom(store, d.id, { yard: "CIMC Changhong, Changtu", status: "active", rev: 1 }, SUPT).status, "active")
    refused(() => updateDockingFrom(store, d.id, { yard: "Again", rev: 1 }, SUPT), 400, /Someone else changed/)
    refused(() => dockingView(store, "not-an-id"), 404, /does not exist/)
    refused(() => dockingView(store, "00000000-0000-0000-0000-000000000000"), 400, /does not exist/)
  })

  test("the docking view lists every day with its files, and jobs with their span", () => {
    const d = createDockingFrom(store, BODY, SUPT)
    importSubmission(store, {
      dockingId: d.id, reportDate: "2025-10-21", department: "deck", file: { data: Buffer.from("synthetic deck day 8"), name: "deck-day8.xlsx" },
      template: "DD-DAILY", templateVersion: 1, receivedVia: "teams", activities: [{ sheet: "Deck Work", rowNo: 6, rowRef: "DK001", workText: "Seat rings renewed" }], photos: [],
    }, SUPT)
    const view = dockingView(store, d.id)
    assert.equal(view.days.length, 16)
    assert.deepEqual(view.days[8].files.map((f) => [f.department, f.file_name, f.received_via]), [["deck", "deck-day8.xlsx", "teams"]])
    assert.equal(view.days[8].state, "received")
    assert.deepEqual(view.days[7].files, [])
  })
})

describe("days, jobs and notes", () => {
  test("no report needs a reason and a past day; reviewed needs a received file", () => {
    const d = createDockingFrom(store, BODY, SUPT)
    refused(() => dayActionFrom(store, d.id, "x", { action: "reviewed" }, SUPT), 404, /This day does not exist/)
    refused(() => dayActionFrom(store, d.id, "0", { action: "delete" }, SUPT), 400, /Action must be one of/)
    refused(() => dayActionFrom(store, d.id, "0", { action: "no_report" }, SUPT), 400, /Reason is required/)
    const day = dayActionFrom(store, d.id, "0", { action: "no_report", reason: "Immigration pending, no work" }, SUPT)
    assert.deepEqual([day?.state, day?.no_report_reason], ["no_report", "Immigration pending, no work"])
    refused(() => dayActionFrom(store, d.id, "1", { action: "reviewed" }, SUPT), 400, /no received report/)
  })

  test("jobs are created per department and viewed only within their docking; notes attach and can be replaced", () => {
    const d = createDockingFrom(store, BODY, SUPT)
    const other = createDockingFrom(store, { ...BODY, code: "JAG-2025-SS", vesselName: "DHT JAGUAR" }, SUPT)
    refused(() => createJobFrom(store, d.id, { title: "x", department: "bridge" }, SUPT), 400, /Department must be one of/)
    const job = createJobFrom(store, d.id, { title: "Anchor chain ranging", department: "deck", area: "Anchors and chain cables" }, SUPT)
    assert.equal(job.job_no, "LEO-2025-SS-D-001")
    assert.deepEqual(jobView(store, d.id, job.id).timeline, [])
    refused(() => jobView(store, other.id, job.id), 404, /does not exist in this docking/)

    const first = addNoteFrom(store, d.id, { entity: "job", entityId: job.id, kind: "query", body: "Spare studs on board?" }, SUPT)!
    refused(() => addNoteFrom(store, other.id, { entity: "job", entityId: job.id, kind: "comment", body: "x" }, SUPT), 400, /not part of this docking/)
    refused(() => addNoteFrom(store, d.id, { entity: "vessel", entityId: job.id, kind: "comment", body: "x" }, SUPT), 400, /Note subject must be one of/)
    addNoteFrom(store, d.id, { entity: "job", entityId: job.id, kind: "comment", body: "24 studs supplied by owner", supersedesId: first.id }, SUPT)
    const notes = dockingView(store, d.id).notes
    assert.deepEqual(notes.map((n) => [n.kind, n.replaced]), [["query", true], ["comment", false]])
    assert.deepEqual(auditView(store, d.id).map((a) => a.action), ["docking.create", "job.create", "annotation.query", "annotation.comment"])
  })
})

describe("requests and routes", () => {
  test("bodies must be small JSON objects", async () => {
    const req = (body: string) => new Request("http://localhost:3000/api/x", { method: "POST", body })
    await assert.rejects(readBody(req("x".repeat(MAX_BODY_BYTES + 1))), (e: unknown) => e instanceof AppError && e.status === 413)
    await assert.rejects(readBody(req("{not json")), /could not be read/)
    await assert.rejects(readBody(req("[1,2]")), /could not be read/)
    assert.deepEqual(await readBody(req("")), {})
  })

  test("every Digital Docking route needs the Digital Docking right", () => {
    const routes: string[] = []
    const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n === "route.ts" && routes.push(join(d, n))))
    walk(join(ROOT, "app", "api", "docking"))
    assert.ok(routes.length >= 7)
    for (const file of routes) {
      const text = readFileSync(file, "utf8")
      const handlers = text.match(/export const (GET|POST|PATCH|PUT|DELETE) = route/g) ?? []
      const guarded = text.match(/module: DD_MODULE/g) ?? []
      assert.ok(handlers.length > 0 && guarded.length === handlers.length, `${relative(ROOT, file)}: every handler needs module: DD_MODULE`)
    }
  })
})
