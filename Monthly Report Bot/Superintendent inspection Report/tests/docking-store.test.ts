// Digital Docking · Stage 1B: the local store — schema rules, dockings and days, imports with revisions and
// amendments, jobs and links, notes, file storage and orphans, backup and restore. Synthetic data, temporary folders.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { backupStore, restoreStore } from "../lib/docking/server/backup"
import { closeStore, openStore, SCHEMA_VERSION, type Store } from "../lib/docking/server/db"
import { absolute, putFile, sha256, sweepOrphans } from "../lib/docking/server/files"
import {
  addAnnotation, auditTrail, createDocking, createJob, dayNumber, declareNoReport, DockingError, getDocking, importAttempts,
  importSubmission, jobTimeline, linkActivity, listDays, listJobs, markDayReviewed, type SubmissionInput, unlinkActivity, updateDocking,
} from "../lib/docking/server/repo"
import { png } from "./docking-photos.helpers"

const SUPT = "supt@x.com"
let root: string
let store: Store
const roots: string[] = []
const tempRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), "nv-docking-"))
  roots.push(dir)
  return dir
}

beforeEach(async () => {
  root = tempRoot()
  store = await openStore(root)
})
afterEach(() => {
  closeStore(store)
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const leopard = (over: Record<string, unknown> = {}) => createDocking(store, {
  code: "LEO-2025-SS2", vesselName: "DHT LEOPARD", yard: "CIMC Changhong", location: "Zhoushan, China", dockingType: "Special survey",
  utcOffsetMinutes: 480, day0Date: "2025-10-13", arrivalTime: "21:00", plannedDepartureDate: "2025-10-28", ...over,
}, SUPT)

function dailyFile(dockingId: string, reportDate: string, department: "deck" | "engine", version = "a", rows = 2, over: Partial<SubmissionInput> = {}): SubmissionInput {
  const sheet = department === "deck" ? "Deck Work" : "Engine Work"
  const prefix = department === "deck" ? "DK" : "EN"
  return {
    dockingId, reportDate, department, file: { data: Buffer.from(`synthetic workbook ${reportDate} ${department} ${version}`), name: `${department}-${reportDate}.xlsx` },
    template: "DD-DAILY", templateVersion: 1, receivedVia: "email",
    activities: Array.from({ length: rows }, (_, i) => ({ sheet, rowNo: 6 + i, rowRef: `${prefix}${String(i + 1).padStart(3, "0")}`, workText: `Work ${i + 1} (${version})`, area: "Cargo system", performedBy: "Ship staff" })),
    photos: [
      { sheet, rowNo: 6, cell: "C6", slot: 1, method: "over cells", anchor: "two-cell", mediaPart: "xl/media/image1.png", data: png(8, 6, [10, 20, 30]), extension: "png", width: 8, height: 6, format: "png", status: "linked", reason: "" },
      { sheet, rowNo: 6, cell: "B6", slot: null, method: "over cells", anchor: "one-cell", mediaPart: "xl/media/image2.png", data: png(4, 4), extension: "png", width: 4, height: 4, format: "png", status: "rejected", reason: "it is in column B, not in a photo slot" },
    ],
    ...over,
  }
}

const count = (table: string) => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
const activitiesOf = (submissionId: string) => store.db.prepare("SELECT * FROM activities WHERE submission_id = ? ORDER BY row_no").all(submissionId) as Record<string, unknown>[]

describe("the schema protects the records", () => {
  test("opening twice is safe and records the schema version", async () => {
    closeStore(store)
    store = await openStore(root)
    assert.equal((store.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v, SCHEMA_VERSION)
  })

  test("vessel records, photos, attempts and the audit cannot be changed or deleted; submissions can only be superseded", () => {
    const d = leopard()
    const r = importSubmission(store, dailyFile(d.id, "2025-10-14", "deck"), SUPT)
    assert.throws(() => store.db.prepare("UPDATE activities SET work_text = 'edited'").run(), /activities records cannot be changed/)
    assert.throws(() => store.db.prepare("DELETE FROM photos").run(), /photos records cannot be deleted/)
    assert.throws(() => store.db.prepare("DELETE FROM audit").run(), /audit records cannot be deleted/)
    assert.throws(() => store.db.prepare("UPDATE import_attempts SET outcome = 'rejected'").run(), /cannot be changed/)
    assert.throws(() => store.db.prepare("UPDATE submissions SET department = 'engine' WHERE id = ?").run(r.submissionId), /can only be superseded/)
    assert.throws(() => store.db.prepare("DELETE FROM submissions").run(), /never deleted/)
  })
})

describe("dockings and days", () => {
  test("a docking is validated, audited, and its vessel, code and Day 0 freeze once files exist", () => {
    assert.throws(() => leopard({ vesselName: "MV NOWHERE" }), /not in the fleet list/)
    assert.throws(() => leopard({ code: "x" }), /3–24 letters/)
    assert.throws(() => leopard({ utcOffsetMinutes: 470 }), /quarter-hours/)
    assert.throws(() => leopard({ plannedDepartureDate: "2025-10-01" }), /on or after Day 0/)
    const d = leopard()
    assert.deepEqual([d.vessel_id, d.code, d.status, d.rev], ["DHT_LEOPARD", "LEO-2025-SS2", "planned", 1])
    assert.throws(() => leopard(), /already exists/)
    const moved = updateDocking(store, d.id, { day0Date: "2025-10-12", status: "active" }, 1, SUPT)
    assert.deepEqual([moved.day0_date, moved.status, moved.rev], ["2025-10-12", "active", 2])
    assert.throws(() => updateDocking(store, d.id, { yard: "Other" }, 1, SUPT), /Someone else changed/)
    importSubmission(store, dailyFile(d.id, "2025-10-14", "deck"), SUPT)
    assert.throws(() => updateDocking(store, d.id, { day0Date: "2025-10-13" }, 2, SUPT), /cannot change after daily files/)
    assert.equal(updateDocking(store, d.id, { yard: "CIMC Changhong, Changtu Island" }, 2, SUPT).rev, 3)
    assert.deepEqual(auditTrail(store, d.id).map((a) => a.action), ["docking.create", "docking.update", "submission.initial", "docking.update"])
  })

  test("Day 0 is the arrival date; every day to the planned departure is listed; 'no report' needs a reason and no file", () => {
    assert.equal(dayNumber("2025-10-13", "2025-10-21"), 8)
    assert.throws(() => dayNumber("2025-10-13", "2025-10-12"), /before Day 0/)
    assert.throws(() => dayNumber("2025-10-13", "2025-13-01"), /YYYY-MM-DD/)
    const d = leopard()
    const days = listDays(store, d.id)
    assert.equal(days.length, 16) // Day 0 … Day 15 (28 Oct)
    assert.deepEqual([days[8].day_no, days[8].report_date, days[8].state], [8, "2025-10-21", "expected"])
    assert.throws(() => declareNoReport(store, d.id, "2025-10-13", " ", SUPT), /reason/)
    assert.equal(declareNoReport(store, d.id, "2025-10-13", "Arrived 2100 LT; immigration pending, no work", SUPT).state, "no_report")
    importSubmission(store, dailyFile(d.id, "2025-10-14", "deck"), SUPT)
    assert.throws(() => declareNoReport(store, d.id, "2025-10-14", "x", SUPT), /already has a report file/)
    assert.equal(listDays(store, d.id, "2025-10-30").length, 18)
  })
})

describe("importing daily files", () => {
  test("an initial file stores its original, activities and every photo (linked or rejected) with hashes", () => {
    const d = leopard()
    const input = dailyFile(d.id, "2025-10-21", "deck")
    const r = importSubmission(store, input, SUPT)
    assert.deepEqual([r.outcome, r.kind, r.dayNo, r.supersededId], ["accepted", "initial", 8, null])
    const original = store.db.prepare("SELECT * FROM source_files").get() as { stored_path: string; sha256: string }
    assert.equal(original.sha256, sha256(input.file.data))
    assert.deepEqual(readFileSync(absolute(store, original.stored_path)), input.file.data)
    assert.equal(activitiesOf(r.submissionId).length, 2)
    const photos = store.db.prepare("SELECT * FROM photos ORDER BY cell").all() as Record<string, unknown>[]
    assert.deepEqual(photos.map((p) => [p.cell, p.link_status, p.slot, p.reason]), [["B6", "rejected", null, "it is in column B, not in a photo slot"], ["C6", "linked", 1, ""]])
    for (const p of photos) assert.ok(existsSync(absolute(store, String(p.stored_path))))
    assert.equal(listDays(store, d.id)[8].state, "received")
  })

  test("exact duplicate, revision before review, amendment after review (reason required), deck and engine kept apart", () => {
    const d = leopard()
    const first = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    const before = [count("activities"), count("photos"), count("submissions")]
    const dup = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    assert.deepEqual([dup.outcome, dup.submissionId], ["duplicate", first.submissionId])
    assert.deepEqual([count("activities"), count("photos"), count("submissions")], before)

    const engine = importSubmission(store, dailyFile(d.id, "2025-10-21", "engine", "a"), SUPT)
    assert.equal(engine.kind, "initial") // the other department's file for the same day

    const revised = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "b", 3), SUPT)
    assert.deepEqual([revised.kind, revised.supersededId], ["revision", first.submissionId])
    assert.equal(activitiesOf(first.submissionId).length, 2) // the replaced file's rows are kept, unchanged
    assert.equal(activitiesOf(revised.submissionId).length, 3)
    const statuses = store.db.prepare("SELECT id, status, correction_reason FROM submissions WHERE department = 'deck' ORDER BY imported_at, rowid").all() as Record<string, unknown>[]
    assert.deepEqual(statuses.map((s) => s.status), ["superseded", "current"])
    assert.equal(statuses[1].correction_reason, "Revised file received before review.")

    markDayReviewed(store, d.id, 8, SUPT)
    const counts = [count("activities"), count("photos"), count("submissions")]
    assert.throws(() => importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "c"), SUPT), /has been reviewed\. Give the reason/)
    assert.deepEqual([count("activities"), count("photos"), count("submissions")], counts) // nothing half-written
    const amended = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "c", 2, { correctionReason: "Vessel added the afternoon hull work" }), SUPT)
    assert.equal(amended.kind, "amendment")
    assert.equal(listDays(store, d.id)[8].state, "received") // back to review
    assert.deepEqual(importAttempts(store, d.id).map((a) => a.outcome), ["accepted", "duplicate", "accepted", "accepted", "rejected", "accepted"])
  })

  test("the same file cannot be another day's report, and a photo cannot be linked to a row that does not exist", () => {
    const d = leopard()
    importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    const again = dailyFile(d.id, "2025-10-22", "deck", "a")
    again.file = dailyFile(d.id, "2025-10-21", "deck", "a").file
    assert.throws(() => importSubmission(store, again, SUPT), /already imported as the deck report for Day 8/)
    const orphan = dailyFile(d.id, "2025-10-23", "deck", "z")
    orphan.photos[0] = { ...orphan.photos[0], rowNo: 40 }
    assert.throws(() => importSubmission(store, orphan, SUPT), /row 40, which has no activity/)
    assert.equal(importAttempts(store, d.id).filter((a) => a.outcome === "rejected").length, 2)
  })
})

describe("jobs built by the Superintendent", () => {
  test("numbered per department, linked across days, relinked and unlinked with history; never across dockings", () => {
    const d = leopard()
    const other = leopard({ code: "JAG-2025-SS", vesselName: "DHT JAGUAR" })
    const day8 = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    const day9 = importSubmission(store, dailyFile(d.id, "2025-10-22", "deck", "a"), SUPT)
    const elsewhere = importSubmission(store, dailyFile(other.id, "2025-10-21", "deck", "x"), SUPT)
    const valves = createJob(store, d.id, { title: "COP discharge valves OP208/209 seat rings", department: "deck", area: "Cargo system" }, SUPT)
    const chain = createJob(store, d.id, { title: "Anchor chain ranging and studs", department: "deck" }, SUPT)
    const me = createJob(store, d.id, { title: "Main engine units overhaul", department: "engine" }, SUPT)
    assert.deepEqual([valves.job_no, chain.job_no, me.job_no], ["LEO-2025-SS2-D-001", "LEO-2025-SS2-D-002", "LEO-2025-SS2-E-001"])
    assert.equal(listJobs(store, d.id).length, 3)

    const [a8] = activitiesOf(day8.submissionId)
    const [a9] = activitiesOf(day9.submissionId)
    linkActivity(store, String(a9.id), valves.id, SUPT)
    linkActivity(store, String(a8.id), chain.id, SUPT)
    linkActivity(store, String(a8.id), valves.id, SUPT) // corrected: same job as Day 9
    const timeline = jobTimeline(store, valves.id)
    assert.deepEqual(timeline.map((t) => t.day_no), [8, 9])
    assert.equal(timeline[0].photos.length, 1)
    assert.equal(jobTimeline(store, chain.id).length, 0)
    const history = store.db.prepare("SELECT action, job_id FROM job_links_history WHERE activity_id = ? ORDER BY id").all(String(a8.id)) as Record<string, unknown>[]
    assert.deepEqual(history.map((h) => h.action), ["link", "unlink", "link"])

    const [foreign] = activitiesOf(elsewhere.submissionId)
    assert.throws(() => linkActivity(store, String(foreign.id), valves.id, SUPT), /same docking/)
    assert.throws(() => store.db.prepare("INSERT INTO job_links(activity_id, job_id, linked_by, linked_at) VALUES(?,?,?,?)").run(String(foreign.id), valves.id, SUPT, "x"), /same docking/)

    assert.throws(() => unlinkActivity(store, String(a9.id), "", SUPT), /reason/)
    unlinkActivity(store, String(a9.id), "Belongs to the stripping pump job", SUPT)
    assert.deepEqual(jobTimeline(store, valves.id).map((t) => t.day_no), [8])

    const revised = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "b"), SUPT)
    assert.ok(revised.supersededId)
    assert.throws(() => linkActivity(store, String(a8.id), chain.id, SUPT), /replaced file/)
  })

  test("Superintendent notes attach to this docking's items only, and can replace an earlier note", () => {
    const d = leopard()
    const other = leopard({ code: "JAG-2025-SS", vesselName: "DHT JAGUAR" })
    const r = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck"), SUPT)
    const [a] = activitiesOf(r.submissionId)
    const first = addAnnotation(store, { dockingId: d.id, entity: "activity", entityId: String(a.id), kind: "comment", body: "Seat ring found damaged; renewed." }, SUPT)
    addAnnotation(store, { dockingId: d.id, entity: "activity", entityId: String(a.id), kind: "correction", body: "Seat rings of both valves renewed.", supersedesId: first }, SUPT)
    assert.throws(() => addAnnotation(store, { dockingId: other.id, entity: "activity", entityId: String(a.id), kind: "comment", body: "x" }, SUPT), /not part of this docking/)
    assert.throws(() => addAnnotation(store, { dockingId: d.id, entity: "vessel", entityId: "x", kind: "comment", body: "x" }, SUPT), /can be added to/)
    assert.equal(String(activitiesOf(r.submissionId)[0].work_text), "Work 1 (a)") // the vessel's text is untouched
    assert.equal(count("annotations"), 2)
  })

  test("every change needs a person", () => {
    const d = leopard()
    assert.throws(() => createJob(store, d.id, { title: "x", department: "deck" }, " "), (e: unknown) => e instanceof DockingError && /signed-in person/.test(e.message))
    assert.throws(() => declareNoReport(store, d.id, "2025-10-13", "reason", ""), /signed-in person/)
  })
})

describe("files, orphans, backup and restore", () => {
  test("a stored file is checked by hash; unreferenced old files are swept, referenced or recent ones kept", () => {
    const d = leopard()
    importSubmission(store, dailyFile(d.id, "2025-10-21", "deck"), SUPT)
    const orphan = putFile(store, "photos", png(3, 3, [1, 2, 3]), "png") // e.g. left by an import that rolled back
    const young = putFile(store, "photos", png(3, 3, [4, 5, 6]), "png")
    const old = new Date(Date.now() - 2 * 3600_000)
    utimesSync(absolute(store, orphan.path), old, old)
    assert.deepEqual(sweepOrphans(store), [orphan.path])
    assert.ok(existsSync(absolute(store, young.path)))
    assert.equal(count("photos"), 2)
    for (const p of store.db.prepare("SELECT stored_path FROM photos").all() as { stored_path: string }[]) assert.ok(existsSync(absolute(store, p.stored_path)))
    writeFileSync(absolute(store, young.path), Buffer.from("damaged"))
    assert.throws(() => putFile(store, "photos", png(3, 3, [4, 5, 6]), "png"), /damaged \(hash mismatch\)/)
  })

  test("a backup restores into an empty folder with every record and file; a damaged backup is refused", async () => {
    const d = leopard()
    importSubmission(store, dailyFile(d.id, "2025-10-21", "deck"), SUPT)
    importSubmission(store, dailyFile(d.id, "2025-10-21", "engine"), SUPT)
    createJob(store, d.id, { title: "Hull painting", department: "deck" }, SUPT)
    const dest = tempRoot()
    const snapshot = await backupStore(store, { dest })
    const manifest = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"))
    assert.deepEqual([manifest.counts.submissions, manifest.counts.activities, manifest.counts.photos, manifest.counts.jobs], [2, 4, 4, 1])
    assert.equal(manifest.files.length, 2 + 2) // 2 originals; photos are shared by both files (same synthetic bytes)

    const target = join(tempRoot(), "restored")
    const { store: restored } = await restoreStore(snapshot, target)
    try {
      assert.equal(getDocking(restored, d.id).code, "LEO-2025-SS2")
      for (const f of manifest.files) assert.equal(sha256(readFileSync(join(target, ...f.path.split("/")))), f.sha256)
      assert.equal(auditTrail(restored, d.id).length, auditTrail(store, d.id).length)
    } finally {
      closeStore(restored)
    }
    await assert.rejects(restoreStore(snapshot, target), /only into an empty folder/)
    writeFileSync(join(dest, "files", ...manifest.files[0].path.split("/")), Buffer.from("tampered"))
    await assert.rejects(restoreStore(snapshot, join(tempRoot(), "again")), /damaged \(hash mismatch\)/)
  })

  test("only the newest backups are kept", async () => {
    leopard()
    const dest = tempRoot()
    for (let i = 0; i < 4; i++) await backupStore(store, { dest, keep: 2, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) })
    const kept = (await import("node:fs")).readdirSync(dest).filter((n) => n !== "files").sort()
    assert.deepEqual(kept, ["2026-01-01T00-00-02-000Z", "2026-01-01T00-00-03-000Z"])
  })
})

describe("job links follow a replaced file (audit P1-6)", () => {
  test("a link moves to the same, unchanged row of the new file; a changed row keeps its link on the replaced file", () => {
    const d = leopard()
    const first = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    const [row1, row2] = activitiesOf(first.submissionId)
    const valves = createJob(store, d.id, { title: "COP discharge valves", department: "deck" }, SUPT)
    const chain = createJob(store, d.id, { title: "Anchor chain", department: "deck" }, SUPT)
    linkActivity(store, String(row1.id), valves.id, SUPT)
    linkActivity(store, String(row2.id), chain.id, SUPT)

    // The corrected file keeps row DK001 word for word and rewrites row DK002.
    const corrected = dailyFile(d.id, "2025-10-21", "deck", "b", 2, {
      activities: [
        { sheet: "Deck Work", rowNo: 6, rowRef: "DK001", workText: "Work 1 (a)", area: "Cargo system", performedBy: "Ship staff" },
        { sheet: "Deck Work", rowNo: 7, rowRef: "DK002", workText: "Work 2 rewritten by the vessel", area: "Cargo system", performedBy: "Ship staff" },
      ],
    })
    const result = importSubmission(store, corrected, SUPT)
    assert.equal(result.linksCarried, 1)
    assert.equal(result.linksToReview, 1)

    const [new1] = activitiesOf(result.submissionId)
    const valvesTimeline = jobTimeline(store, valves.id)
    assert.deepEqual(valvesTimeline.map((t) => [t.id, t.submission_status]), [[new1.id, "current"]], "the valves job now shows the new file's row")
    const chainTimeline = jobTimeline(store, chain.id)
    assert.deepEqual(chainTimeline.map((t) => [t.id, t.submission_status]), [[row2.id, "superseded"]], "the changed row stays, marked as replaced")

    const moved = store.db.prepare("SELECT activity_id, action FROM job_links_history WHERE job_id = ? ORDER BY id").all(valves.id) as Record<string, unknown>[]
    assert.deepEqual(moved.map((h) => [h.activity_id, h.action]), [[row1.id, "link"], [row1.id, "unlink"], [new1.id, "link"]])
    const audit = auditTrail(store, d.id).find((a) => a.action === "submission.revision")
    assert.equal((audit?.after as { links_carried?: number }).links_carried, 1)
  })

  test("a first file reports no link counts, and an ambiguous duplicate row is never guessed", () => {
    const d = leopard()
    const first = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "a"), SUPT)
    assert.equal(first.linksCarried, undefined)
    const [row1] = activitiesOf(first.submissionId)
    const job = createJob(store, d.id, { title: "Hull blasting", department: "deck" }, SUPT)
    linkActivity(store, String(row1.id), job.id, SUPT)
    const twice = { sheet: "Deck Work", rowRef: "DK001", workText: "Work 1 (a)", area: "Cargo system", performedBy: "Ship staff" }
    const result = importSubmission(store, dailyFile(d.id, "2025-10-21", "deck", "b", 2, { activities: [{ ...twice, rowNo: 6 }, { ...twice, rowNo: 7 }] }), SUPT)
    assert.equal(result.linksCarried, 0)
    assert.equal(result.linksToReview, 1)
  })
})

describe("the summary for the NeraVeda Home page (audit P1-7)", () => {
  test("counts what each docking received so far and lists past days with no report; cancelled dockings are left out", async () => {
    const { dockingsSummary } = await import("../lib/docking/server/summary")
    const d = leopard() // Day 0 = 13 Oct 2025, yard time UTC+8
    importSubmission(store, dailyFile(d.id, "2025-10-14", "deck"), SUPT)
    importSubmission(store, dailyFile(d.id, "2025-10-16", "engine"), SUPT)
    leopard({ code: "JAG-2025-X", vesselName: "DHT JAGUAR", status: "cancelled" })
    const noon17thAtYard = Date.UTC(2025, 9, 17, 4, 0) // 17 Oct 12:00 at UTC+8
    const summary = dockingsSummary(store, noon17thAtYard)
    assert.equal(summary.dockings.length, 1)
    const s = summary.dockings[0]
    assert.equal(s.code, "LEO-2025-SS2")
    assert.equal(s.daysSoFar, 5, "Day 0 to Day 4 (today at the yard)")
    assert.equal(s.received, 2)
    // Files for Day 1 (14 Oct) and Day 3 (16 Oct). Today's report (Day 4) may still arrive, so it is not missing yet.
    assert.deepEqual(s.missingDays, [0, 2])
    assert.equal(s.latestReportDate, "2025-10-16")
  })
})
