// Digital Docking: importing a vessel's daily workbook from the screen. "Check" reads the file and says what would
// happen without storing anything; "import" files it under the day its date gives (or the day the Superintendent
// chose), as new, a revision before review, or an amendment with a reason. Synthetic workbooks only.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import ExcelJS from "exceljs"
import { dockingView } from "../lib/docking/server/api"
import { closeStore, openStore, type Store } from "../lib/docking/server/db"
import { checkImport, cleanFileName, readUpload, runImport, type Upload } from "../lib/docking/server/imports"
import { reportActionFrom, reportView } from "../lib/docking/server/reports"
import { createDocking, markDayReviewed } from "../lib/docking/server/repo"
import { AppError } from "../lib/server/errors"
import { png } from "./docking-photos.helpers"

const SUPT = "supt@x.com"

/** A vessel "Work Done" workbook: one deck item with two photos, one engine item with one photo. */
async function workbook(options: { date?: string | null; day?: number; deckText?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const images = [1, 2, 3].map((n) => wb.addImage({ buffer: png(40 + n, 30, [n * 50, 80, 120]) as unknown as ExcelJS.Buffer, extension: "png" }))
  const put = (ws: ExcelJS.Worksheet, image: number, col: number, row: number) =>
    ws.addImage(image, { tl: { col: col - 1, row: row - 1 }, ext: { width: 120, height: 90 } } as unknown as ExcelJS.ImageRange)
  const deck = wb.addWorksheet("DECK - SHIP STAFF")
  if (options.date !== null) deck.getCell("B5").value = `Date : ${options.date ?? "21-Oct-2025"}`
  deck.getCell("M5").value = `Day : ${String(options.day ?? 8).padStart(2, "0")}`
  deck.getCell("B8").value = "SR.NO"
  deck.getCell("B9").value = 1
  deck.getCell("C9").value = options.deckText ?? "Inspection of 5P & 4P WBT carried out."
  put(deck, images[0], 3, 10)
  put(deck, images[1], 7, 10)
  const engine = wb.addWorksheet("ENGINE - YARD STAFF")
  engine.getCell("B6").value = "SR.NO"
  engine.getCell("B7").value = 1
  engine.getCell("C7").value = "Boiler mounting pressure testing carried out."
  put(engine, images[2], 3, 8)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const file = async (name: string, options?: Parameters<typeof workbook>[0]): Promise<Upload> => ({ name, data: await workbook(options) })

async function rejects(promise: Promise<unknown>, status: number, message: RegExp) {
  await assert.rejects(promise, (e: unknown) => e instanceof AppError && e.status === status && message.test(e.message))
}

describe("importing a daily file from the screen", () => {
  let dir: string
  let store: Store
  let dockingId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "docking-import-"))
    store = await openStore(dir)
    dockingId = createDocking(store, {
      code: "LEO-2025-SS2", vesselName: "DHT LEOPARD", yard: "CIMC Changhong", dockingType: "Special survey", utcOffsetMinutes: 480,
      day0Date: "2025-10-13", plannedDepartureDate: "2025-10-29", status: "active",
    }, SUPT).id
  })
  afterEach(() => {
    closeStore(store)
    rmSync(dir, { recursive: true, force: true })
  })

  const count = (table: string) => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)

  test("check reads the date, the day and both departments, and stores nothing", async () => {
    const plan = await checkImport(store, dockingId, await file("C:\\Users\\x\\Day 08 Work Done.xlsx"))
    assert.equal(plan.file.name, "Day 08 Work Done.xlsx")
    assert.equal(plan.file_date, "2025-10-21")
    assert.equal(plan.report_date, "2025-10-21")
    assert.equal(plan.day_no, 8)
    assert.equal(plan.day_state, "expected")
    assert.deepEqual(plan.departments.map((d) => [d.department, d.entries, d.photos, d.kind]), [["deck", 1, 2, "initial"], ["engine", 1, 1, "initial"]])
    assert.deepEqual(plan.problems, [])
    assert.equal(plan.needs_reason, false)
    assert.equal(count("submissions"), 0)
    assert.equal(count("import_attempts"), 0)
  })

  test("import files both departments under the day, then the same file again changes nothing", async () => {
    const upload = await file("day08.xlsx")
    const done = await runImport(store, dockingId, upload, { receivedVia: "teams" }, SUPT)
    assert.equal(done.day_no, 8)
    assert.deepEqual(done.results.map((r) => [r.department, r.kind]), [["deck", "initial"], ["engine", "initial"]])
    const day = dockingView(store, dockingId).days.find((d) => d.day_no === 8)!
    assert.equal(day.state, "received")
    assert.deepEqual(day.files.map((f) => [f.department, f.file_name, f.received_via]), [["deck", "day08.xlsx", "teams"], ["engine", "day08.xlsx", "teams"]])
    assert.equal(day.report, null)

    const again = await checkImport(store, dockingId, upload)
    assert.deepEqual(again.departments.map((d) => d.kind), ["duplicate", "duplicate"])
    assert.match(again.problems[0], /already Day 8's current file/)
    await rejects(runImport(store, dockingId, upload, {}, SUPT), 400, /Nothing would change/)
    assert.equal(count("submissions"), 2)
  })

  test("a corrected file replaces the day's file; after review it needs a reason and the day goes back to received", async () => {
    await runImport(store, dockingId, await file("v1.xlsx"), {}, SUPT)
    const v2 = await file("v2.xlsx", { deckText: "Inspection of 5P, 4P and 3P WBT carried out." })
    const plan = await checkImport(store, dockingId, v2)
    assert.deepEqual(plan.departments.map((d) => [d.kind, d.current_file]), [["revision", "v1.xlsx"], ["revision", "v1.xlsx"]])
    await runImport(store, dockingId, v2, {}, SUPT)

    markDayReviewed(store, dockingId, 8, SUPT)
    const v3 = await file("v3.xlsx", { deckText: "Inspection of all WBTs carried out." })
    const amend = await checkImport(store, dockingId, v3)
    assert.deepEqual(amend.departments.map((d) => d.kind), ["amendment", "amendment"])
    assert.equal(amend.needs_reason, true)
    assert.ok(amend.warnings.some((w) => /goes back to "received"/.test(w)))
    await rejects(runImport(store, dockingId, v3, {}, SUPT), 400, /reason for replacing/)
    const done = await runImport(store, dockingId, v3, { correctionReason: "Vessel resent with all tanks" }, SUPT)
    assert.deepEqual(done.results.map((r) => r.kind), ["amendment", "amendment"])
    assert.equal(dockingView(store, dockingId).days.find((d) => d.day_no === 8)!.state, "received")
    const reasons = store.db.prepare("SELECT correction_reason FROM submissions WHERE status = 'current'").all() as { correction_reason: string }[]
    assert.deepEqual(reasons.map((r) => r.correction_reason), ["Vessel resent with all tanks", "Vessel resent with all tanks"])
  })

  test("the Superintendent can file a wrongly dated workbook under another day; both dates are kept", async () => {
    const upload = await file("stale-date.xlsx", { date: "21-Oct-2025", day: 8 })
    const plan = await checkImport(store, dockingId, upload, { reportDate: "2025-10-22" })
    assert.equal(plan.day_no, 9)
    assert.ok(plan.warnings.some((w) => /dated 2025-10-21; it is imported as 2025-10-22/.test(w)))
    await runImport(store, dockingId, upload, { reportDate: "2025-10-22" }, SUPT)
    const validation = JSON.parse((store.db.prepare("SELECT validation FROM submissions LIMIT 1").get() as { validation: string }).validation)
    assert.equal(validation.file_date, "2025-10-21")
    assert.equal(validation.imported_as, "2025-10-22")
    assert.equal(dockingView(store, dockingId).days.find((d) => d.day_no === 9)!.state, "received")
  })

  test("a file without a date needs a chosen day; a day number that disagrees is pointed out", async () => {
    const undated = await file("undated.xlsx", { date: null })
    const plan = await checkImport(store, dockingId, undated)
    assert.equal(plan.report_date, null)
    assert.match(plan.problems.join(" "), /no report date/)
    await rejects(runImport(store, dockingId, undated, {}, SUPT), 400, /no report date/)
    assert.equal((await checkImport(store, dockingId, undated, { reportDate: "2025-10-21" })).day_no, 8)

    const numbered = await checkImport(store, dockingId, await file("d.xlsx", { date: "22-Oct-2025", day: 8 }))
    assert.ok(numbered.warnings.some((w) => /calls itself Day 8, but 2025-10-22 is Day 9/.test(w)))
    const early = await checkImport(store, dockingId, undated, { reportDate: "2025-10-01" })
    assert.match(early.problems.join(" "), /before Day 0/)
  })

  test("the same file cannot become a second day's record", async () => {
    const upload = await file("day08.xlsx")
    await runImport(store, dockingId, upload, {}, SUPT)
    const plan = await checkImport(store, dockingId, upload, { reportDate: "2025-10-22" })
    assert.match(plan.problems.join(" "), /already imported as the deck file of Day 8/)
  })

  test("files that are not workbooks are refused with a plain reason", async () => {
    await rejects(checkImport(store, dockingId, { name: "photo.xlsx", data: Buffer.from("not a zip at all") }), 400, /not an Excel \.xlsx workbook/)
    const old = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    await rejects(checkImport(store, dockingId, { name: "old.xls", data: old }), 400, /old-format/)
  })

  test("a report started before a corrected file says so until its items are rebuilt; day cards show the report", async () => {
    await runImport(store, dockingId, await file("v1.xlsx"), {}, SUPT)
    const started = reportActionFrom(store, dockingId, "8", { action: "start" }, SUPT, "Supt") as ReturnType<typeof reportView>
    assert.equal(started.newer_file, null)
    assert.deepEqual(dockingView(store, dockingId).days.find((d) => d.day_no === 8)!.report, { versions: 0, changed: false })

    await new Promise((r) => setTimeout(r, 5))
    await runImport(store, dockingId, await file("v2.xlsx", { deckText: "Corrected text." }), {}, SUPT)
    const view = reportView(store, dockingId, "8")
    assert.equal(view.newer_file?.file_name, "v2.xlsx")
    assert.equal(view.report!.content.sections.deck_ship[0].text, "Inspection of 5P & 4P WBT carried out.")

    const rebuilt = reportActionFrom(store, dockingId, "8", { action: "rebuild", rev: view.report!.rev }, SUPT, "Supt") as ReturnType<typeof reportView>
    assert.equal(rebuilt.newer_file, null)
    assert.equal(rebuilt.report!.content.sections.deck_ship[0].text, "Corrected text.")
  })

  test("the upload is read from multipart form data with its fields", async () => {
    const form = new FormData()
    form.set("file", new File([new Uint8Array(await workbook())], "Day 8.xlsx"))
    form.set("reportDate", "2025-10-21")
    form.set("receivedVia", "email")
    form.set("ignored", "x")
    const { upload, fields } = await readUpload(new Request("http://localhost:3000/x", { method: "POST", body: form }))
    assert.equal(upload.name, "Day 8.xlsx")
    assert.ok(upload.data.length > 1000)
    assert.deepEqual(fields, { reportDate: "2025-10-21", receivedVia: "email" })

    const empty = new FormData()
    empty.set("reportDate", "2025-10-21")
    await rejects(readUpload(new Request("http://localhost:3000/x", { method: "POST", body: empty })), 400, /Choose the vessel's workbook/)
    assert.equal(cleanFileName("../../etc/passwd"), "passwd")
    assert.equal(cleanFileName("a\u0000b.xlsx"), "ab.xlsx")
    assert.equal(cleanFileName(""), "workbook.xlsx")
  })
})
