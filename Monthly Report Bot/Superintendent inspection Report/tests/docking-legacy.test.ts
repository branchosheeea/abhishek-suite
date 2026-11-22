// Digital Docking: the vessel's own "Work Done" workbook (the format sent today) is read item by item with its photos,
// one file feeds both departments of the day, and the day screen's API shows entries, photos and job links.
// Synthetic workbooks only, laid out like the Leopard 2025 files.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import ExcelJS from "exceljs"
import { classifySheet, LEGACY_TEMPLATE, readWorkDoneWorkbook } from "../lib/docking/legacy/workdone"
import { activityActionFrom, dayView, photoFile } from "../lib/docking/server/api"
import { closeStore, openStore, type Store } from "../lib/docking/server/db"
import { createDocking, importSubmission } from "../lib/docking/server/repo"
import { AppError } from "../lib/server/errors"
import { png } from "./docking-photos.helpers"

const SUPT = "supt@x.com"

/** A small workbook in the vessel's layout. Rows and columns are 1-based as Excel shows them. */
async function workDone(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const images = [1, 2, 3, 4, 5, 6].map((n) => wb.addImage({ buffer: png(40 + n, 30, [n * 30, 60, 90]) as unknown as ExcelJS.Buffer, extension: "png" }))
  const put = (ws: ExcelJS.Worksheet, image: number, col: number, row: number) =>
    ws.addImage(image, { tl: { col: col - 1, row: row - 1 }, ext: { width: 120, height: 90 } } as unknown as ExcelJS.ImageRange)

  const deck = wb.addWorksheet("DECK - SHIP STAFF")
  deck.getCell("B2").value = "DECK WORK DONE BY SHIP STAFF"
  deck.getCell("B5").value = "Date : 21-Oct-2025"
  deck.getCell("M5").value = "Day : 08"
  deck.getCell("B8").value = "SR.NO"
  deck.getCell("C8").value = "JOBS"
  deck.getCell("C9").value = "Renewal of cargo lines on main deck in progress."
  deck.getCell("B10").value = 1 // number one row below its text
  deck.getCell("B31").value = 2
  deck.getCell("C31").value = "Inspection of 5P & 4P WBT carried out."
  deck.getCell("B52").value = 3 // photos, no text
  deck.getCell("B60").value = 4 // unused row of the form
  put(deck, images[0], 3, 3) // above the first item
  put(deck, images[0], 3, 10)
  put(deck, images[1], 7, 10)
  put(deck, images[2], 3, 32)
  put(deck, images[3], 3, 53)

  const engine = wb.addWorksheet("ENGINE - YARD STAFF ")
  engine.getCell("B6").value = "SR.NO"
  engine.getCell("B7").value = 1
  engine.getCell("C7").value = "Boiler mounting pressure testing carried out in yard."
  put(engine, images[4], 3, 8)

  const staging = wb.addWorksheet("Stagging - Engine")
  staging.getCell("A2").value = "Location"
  staging.getCell("B2").value = "Quantity"
  staging.getCell("C2").value = "Dimension"
  staging.getCell("F2").value = "Purpose"
  staging.getCell("G2").value = "Rigged on"
  staging.getCell("H2").value = "Removed on"
  staging.getCell("C3").value = "Length (Mtr)"
  staging.getRow(4).values = ["ENGINE ROOM BLOWER", 4, 1.17, 0.7, 2.7, "E/R FAN AND HEAD OVERHAUL", new Date(Date.UTC(2025, 9, 15))]
  put(staging, images[5], 9, 4)

  const list = wb.addWorksheet("Engine")
  list.getCell("B3").value = "Jobs carried out by Ship Staff:"
  list.getCell("B4").value = "1.    Departure preparation, engine turned with turning gear."
  list.getCell("B6").value = "Jobs carried out by Yard Staff: "
  list.getCell("B7").value = "1. Rectified fuel oil high pressure leak."
  list.getCell("B8").value = "Class Surveyor attendance"
  list.getCell("C9").value = "None"

  const other = wb.addWorksheet("Notes")
  other.getCell("A1").value = "scratch"
  put(other, images[0], 2, 2)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe("reading the vessel's own workbook", () => {
  test("sheets are sorted into department and who did the work", () => {
    assert.deepEqual(classifySheet("DECK - YARD STAFF "), { kind: "work", department: "deck", performedBy: "Yard staff" })
    assert.deepEqual(classifySheet("ENGINE - SERVICE VENDORS"), { kind: "work", department: "engine", performedBy: "Service engineer" })
    assert.deepEqual(classifySheet("Stagging - Inside Dock"), { kind: "staging", department: "deck", performedBy: "Yard staff" })
    assert.deepEqual(classifySheet("Engine"), { kind: "list", department: "engine", performedBy: "" })
    assert.equal(classifySheet("Sheet1"), null)
  })

  test("items keep their own photos; text above its number is one item; photo-only items are kept, empty rows dropped", async () => {
    const book = await readWorkDoneWorkbook(await workDone())
    assert.equal(book.reportDate, "2025-10-21")
    assert.equal(book.dayNo, 8)
    const deck = book.deck.activities.filter((a) => a.sheet === "DECK - SHIP STAFF")
    assert.deepEqual(deck.map((a) => [a.rowRef, a.rowNo, a.workText]), [
      ["No. 1", 9, "Renewal of cargo lines on main deck in progress."],
      ["No. 2", 31, "Inspection of 5P & 4P WBT carried out."],
      ["No. 3", 52, ""],
    ])
    assert.equal((deck[0].raw as { textAboveNumber: boolean }).textAboveNumber, true)
    assert.equal((deck[2].raw as { noText: boolean }).noText, true)
    const photos = book.deck.photos.filter((p) => p.sheet === "DECK - SHIP STAFF")
    assert.deepEqual(photos.map((p) => [p.cell, p.status, p.rowNo, p.slot]), [
      ["C3", "rejected", 3, null], ["C10", "linked", 9, 1], ["G10", "linked", 9, 2], ["C32", "linked", 31, 1], ["C53", "linked", 52, 1],
    ])
    assert.match(photos[0].reason, /above the first item/)
    assert.ok(photos[1].data && photos[1].width === 41 && photos[1].format === "png")
    assert.ok(book.warnings.some((w) => /1 numbered item has photos but no description/.test(w)))
  })

  test("engine sheets, the staging table and the plain list sheet are read; other sheets are reported, not imported", async () => {
    const book = await readWorkDoneWorkbook(await workDone())
    const yard = book.engine.activities.find((a) => a.sheet === "ENGINE - YARD STAFF")!
    assert.deepEqual([yard.performedBy, yard.rowRef, book.engine.photos.find((p) => p.sheet === "ENGINE - YARD STAFF")?.status], ["Yard staff", "No. 1", "linked"])
    const stage = book.engine.activities.find((a) => a.sheet === "Stagging - Engine")!
    assert.deepEqual([stage.area, stage.location, stage.status], ["Staging", "ENGINE ROOM BLOWER", "Rigged 2025-10-15"])
    assert.match(stage.workText, /Staging for e\/r fan and head overhaul \(4 × 1\.17 × 0\.7 × 2\.7 m\)/)
    assert.equal(book.engine.photos.find((p) => p.sheet === "Stagging - Engine")?.rowNo, 4)
    const listed = book.engine.activities.filter((a) => a.sheet === "Engine")
    assert.deepEqual(listed.map((a) => [a.performedBy, a.rowRef, a.workText]), [
      ["Ship staff", "No. 1", "Departure preparation, engine turned with turning gear."],
      ["Yard staff", "No. 1", "Rectified fuel oil high pressure leak."],
    ])
    assert.ok(book.warnings.some((w) => /"Notes" is not a Deck, Engine or staging sheet.*1 photos left out/.test(w)))
    assert.equal(book.sheets.find((s) => s.name === "Notes")?.kind, "unknown")
  })
})

describe("one workbook for both departments, and the day screen", () => {
  let dir: string
  let store: Store
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nv-docking-legacy-"))
    store = await openStore(dir)
  })
  afterEach(() => {
    closeStore(store)
    rmSync(dir, { recursive: true, force: true })
  })

  async function loaded() {
    const data = await workDone()
    const book = await readWorkDoneWorkbook(data)
    const docking = createDocking(store, { code: "LEO-2025-SS2", vesselName: "DHT LEOPARD", yard: "CIMC Changhong", dockingType: "Special survey", utcOffsetMinutes: 480, day0Date: "2025-10-13" }, SUPT)
    const load = (department: "deck" | "engine", reportDate = book.reportDate!, combined = true) => importSubmission(store, {
      dockingId: docking.id, reportDate, department, file: { data, name: "Day 08 Work Done.xlsx" }, template: LEGACY_TEMPLATE, templateVersion: 1,
      receivedVia: "email", activities: book[department].activities, photos: book[department].photos, combined, validation: { warnings: book.warnings },
    }, SUPT)
    return { docking, data, book, load }
  }

  test("the same file is accepted as that day's Deck and Engine source, but not for another day or uncombined", async () => {
    const { load } = await loaded()
    assert.equal(load("deck").kind, "initial")
    assert.equal(load("engine").kind, "initial")
    assert.throws(() => load("deck", "2025-10-22"), /already imported as the (deck|engine) report for Day 8/)
    closeStore(store)
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), "nv-docking-legacy-"))
    store = await openStore(dir)
    const again = await loaded()
    again.load("deck", undefined, false)
    assert.throws(() => again.load("engine", undefined, false), /already imported as the deck report for Day 8/)
  })

  test("the day view lists entries in workbook order with photos; photos are served; entries are linked to new jobs", async () => {
    const { docking, load } = await loaded()
    load("deck")
    load("engine")
    const view = dayView(store, docking.id, "8")
    assert.deepEqual([view.day.day_no, view.day.state, view.previous, view.next], [8, "received", 7, null])
    const deck = view.departments.find((d) => d.department === "deck")!
    assert.equal(deck.file?.shared, true)
    assert.equal(deck.file?.rejected_photos.length, 1)
    assert.deepEqual(deck.entries.map((e) => [e.row_ref, e.photos.length, e.no_text]), [["No. 1", 2, false], ["No. 2", 1, false], ["No. 3", 1, true]])
    const photo = photoFile(store, docking.id, deck.entries[0].photos[0].id)
    assert.equal(photo.type, "image/png")
    assert.equal(photo.data.readUInt32BE(16), 41)

    const first = deck.entries[0]
    const job = activityActionFrom(store, docking.id, first.id, { action: "new_job", title: "Cargo lines renewal", area: "Cargo lines, valves and manifold" }, SUPT)
    assert.equal(job?.job_no, "LEO-2025-SS2-D-001")
    activityActionFrom(store, docking.id, deck.entries[1].id, { action: "link", jobId: job!.id }, SUPT)
    const after = dayView(store, docking.id, "8").departments.find((d) => d.department === "deck")!
    assert.deepEqual(after.entries.map((e) => e.job?.job_no ?? null), ["LEO-2025-SS2-D-001", "LEO-2025-SS2-D-001", null])
    assert.equal(activityActionFrom(store, docking.id, first.id, { action: "unlink", reason: "wrong job" }, SUPT), null)

    const refused = (fn: () => unknown, status: number) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === status)
    refused(() => dayView(store, docking.id, "x"), 404)
    refused(() => dayView(store, docking.id, "99"), 404)
    refused(() => photoFile(store, docking.id, "00000000-0000-4000-8000-000000000000"), 404)
    refused(() => activityActionFrom(store, docking.id, first.id, { action: "unlink" }, SUPT), 400)
    const other = createDocking(store, { code: "LEO-2026-IS", vesselName: "DHT LEOPARD", yard: "Y", dockingType: "Other", utcOffsetMinutes: 480, day0Date: "2026-01-01" }, SUPT)
    refused(() => activityActionFrom(store, other.id, first.id, { action: "link", jobId: job!.id }, SUPT), 404)
    refused(() => photoFile(store, other.id, deck.entries[0].photos[0].id), 404)
  })
})
