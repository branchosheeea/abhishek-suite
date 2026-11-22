// Digital Docking: the Daily Report to owners. A draft is built from the vessel's entries and the previous day's
// report, edited, checked and issued as frozen versions (content, email text, PDF). Synthetic data only.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { emailText, issueProblems, longDate, parseContent, REPORT_FORMAT, type ReportContent } from "../lib/docking/report/content"
import { pdfSafe } from "../lib/docking/report/pdf"
import { closeStore, openStore, type Store } from "../lib/docking/server/db"
import { peopleNames, rememberPerson, reportActionFrom, reportView, versionPdf, previewPdf } from "../lib/docking/server/reports"
import { type ActivityInput, createDocking, importSubmission, markDayReviewed, type PhotoInput } from "../lib/docking/server/repo"
import { AppError } from "../lib/server/errors"
import { png } from "./docking-photos.helpers"

const SUPT = "supt@x.com"
const NAME = "Test Superintendent"

function content(overrides: Partial<ReportContent> = {}): ReportContent {
  return {
    format: REPORT_FORMAT, greeting: "Dear Sir\nGood day", summary: "Gale-force winds today.\n\nNo painting.", events: [],
    header: [{ label: "Berth", value: "Dock No. 02" }, { label: "ETD", value: "" }, { label: "Weather", value: "Overcast" }],
    sections: {
      deck_ship: [{ id: "a", text: "Inspection of 5P & 4P WBT carried out.", company: "", photos: [], sources: [] }],
      deck_yard: [], engine_ship: [], engine_yard: [{ id: "b", text: "Boiler mounting\npressure tested.", company: "", photos: [], sources: [] }],
      class: [], service: [{ id: "c", text: "ICCP anodes renewal in progress.", company: "Cathelco", photos: [], sources: [] }],
    },
    ...overrides,
  }
}

describe("the report as text", () => {
  test("dates are written as the Superintendent writes them", () => {
    assert.deepEqual(["2025-10-21", "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-11", "2025-10-12", "2025-10-13", "2025-10-22", "2025-10-23"].map(longDate),
      ["21st October 2025", "1st October 2025", "2nd October 2025", "3rd October 2025", "11th October 2025", "12th October 2025", "13th October 2025", "22nd October 2025", "23rd October 2025"])
  })

  test("email text follows the daily email: greeting, summary, header, departments, service engineers with company", () => {
    const text = emailText(content(), { dayNo: 8, reportDate: "2025-10-21" })
    assert.equal(text, [
      "Dear Sir", "Good day", "Gale-force winds today.", "No painting.", "",
      "Date – 21st October 2025 / Day 8", "Berth – Dock No. 02", "Weather – Overcast", "",
      "DECK:", "Jobs carried out by Ship's Staff:", "1.\tInspection of 5P & 4P WBT carried out.", "",
      "ENGINE:", "Jobs carried out by Yard Staff:", "1.\tBoiler mounting pressure tested.", "",
      "Job Done By Service Engineers:", "1.\tCathelco – ICCP anodes renewal in progress.", "",
    ].join("\n"))
  })

  test("items without text block issuing; content from the browser is checked", () => {
    const c = content()
    c.sections.deck_yard.push({ id: "d", text: "  ", company: "", photos: [], sources: [] })
    assert.match(issueProblems(c)[0].where, /Deck · Jobs carried out by Yard Staff, item 1/)
    assert.deepEqual(parseContent(JSON.parse(JSON.stringify(content()))), content())
    assert.throws(() => parseContent({ ...content(), format: 99 }), /another version/)
    assert.throws(() => parseContent({ ...content(), sections: { other: [] } }), /Unknown report section/)
    assert.throws(() => parseContent(content({ summary: "x".repeat(9000) })), /longer than 8000/)
    const twice = content()
    twice.sections.deck_yard.push({ ...twice.sections.deck_ship[0] })
    assert.throws(() => parseContent(twice), /appears twice/)
    const badPhoto = content()
    badPhoto.sections.deck_ship[0].photos = ["../../x"]
    assert.throws(() => parseContent(badPhoto), /could not be read/)
  })

  test("text outside the PDF fonts is replaced, typographic punctuation is kept", () => {
    assert.equal(pdfSafe("5P & 4P – “ok” ’s 舟山\tx ×2"), "5P & 4P – “ok” ’s ?? x ×2")
  })
})

describe("drafting and issuing a day's report", () => {
  let dir: string
  let store: Store
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nv-docking-report-"))
    store = await openStore(dir)
  })
  afterEach(() => {
    closeStore(store)
    rmSync(dir, { recursive: true, force: true })
  })

  const photo = (sheet: string, rowNo: number, slot: number, shade: number): PhotoInput => ({
    sheet, rowNo, cell: `C${rowNo}`, slot, method: "anchor", anchor: "oneCell", mediaPart: `xl/media/image${shade}.png`,
    data: png(40 + shade, 30, [shade * 20, 80, 120]), extension: "png", width: 40 + shade, height: 30, format: "png", status: "linked", reason: "",
  })

  function setUp() {
    const docking = createDocking(store, {
      code: "LEO-2025-SS2", vesselName: "DHT LEOPARD", yard: "CIMC Changhong", location: "Zhoushan, China", dockingType: "Special survey",
      utcOffsetMinutes: 480, day0Date: "2025-10-13", arrivalTime: "21:00", plannedDepartureDate: "2025-10-28",
    }, SUPT)
    const deck: ActivityInput[] = [
      { sheet: "DECK - SHIP STAFF", rowNo: 10, rowRef: "No. 1", workText: "Renewal of cargo lines in progress.", performedBy: "Ship staff" },
      { sheet: "DECK - SHIP STAFF", rowNo: 31, rowRef: "No. 2", workText: "", performedBy: "Ship staff", raw: { noText: true } },
      { sheet: "DECK - YARD STAFF", rowNo: 7, rowRef: "No. 1", workText: "Marking of anchor chain in progress.", performedBy: "Yard staff" },
      { sheet: "DECK - SERVICE ENGINEER", rowNo: 7, rowRef: "No. 1", workText: "Renewal of echo sounder transducer.", performedBy: "Service engineer" },
      { sheet: "Stagging - Deck", rowNo: 4, rowRef: "Row 4", workText: "Staging for manhole cover", performedBy: "Yard staff", area: "Staging" },
    ]
    const engine: ActivityInput[] = [{ sheet: "ENGINE - YARD STAFF", rowNo: 7, rowRef: "No. 1", workText: "Boiler mounting pressure testing.", performedBy: "Yard staff" }]
    const load = (reportDate: string, department: "deck" | "engine", activities: ActivityInput[], photos: PhotoInput[], name: string) =>
      importSubmission(store, { dockingId: docking.id, reportDate, department, file: { data: Buffer.from(name), name }, template: "VESSEL-WORKDONE", templateVersion: 1,
        receivedVia: "email", activities, photos, combined: false }, SUPT)
    load("2025-10-21", "deck", deck, [photo("DECK - SHIP STAFF", 10, 1, 1), photo("DECK - SHIP STAFF", 10, 2, 2), photo("DECK - SHIP STAFF", 31, 1, 3), photo("Stagging - Deck", 4, 1, 4)], "d8 deck")
    load("2025-10-21", "engine", engine, [photo("ENGINE - YARD STAFF", 7, 1, 5)], "d8 engine")
    load("2025-10-22", "deck", deck.slice(0, 1), [], "d9 deck")
    return docking
  }

  type View = ReturnType<typeof reportView>
  const start = (dockingId: string, day: string) => reportActionFrom(store, dockingId, day, { action: "start" }, SUPT, NAME) as View
  const refused = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === 400 && pattern.test(e.message))

  test("a new draft holds the vessel's entries by section with their photos; the staging register is left out", () => {
    const docking = setUp()
    assert.equal(reportView(store, docking.id, "8").report, null)
    const view = start(docking.id, "8")
    const c = view.report!.content
    assert.deepEqual(Object.fromEntries(Object.entries(c.sections).map(([k, items]) => [k, items.map((i) => [i.text, i.photos.length])])), {
      deck_ship: [["Renewal of cargo lines in progress.", 2], ["", 1]], deck_yard: [["Marking of anchor chain in progress.", 0]],
      engine_ship: [], engine_yard: [["Boiler mounting pressure testing.", 1]], class: [], service: [["Renewal of echo sounder transducer.", 0]],
    })
    assert.equal(c.greeting, "Dear Sir\nGood day")
    assert.deepEqual(c.header.filter((h) => h.value), [{ label: "Vessel arrival shipyard", value: "13th October 2025 / 2100 hrs / Day 0" }, { label: "ETD", value: "28th October 2025" }])
    assert.equal(view.issue_blocker, "Mark Day 8 as reviewed before issuing its report.")
    assert.ok(view.photo_bytes > 0)
    refused(() => start(docking.id, "8"), /already has a report/)
    assert.throws(() => reportView(store, docking.id, "3"), (e: unknown) => e instanceof AppError && e.status === 404)
  })

  test("saving checks the revision and that photos belong to this docking", () => {
    const docking = setUp()
    const { report } = start(docking.id, "8")
    const c = structuredClone(report!.content)
    c.sections.deck_ship[1].text = "Inspection of 5P & 4P WBT carried out."
    refused(() => reportActionFrom(store, docking.id, "8", { action: "save", rev: 7, content: c }, SUPT, NAME), /changed in another window/)
    const saved = reportActionFrom(store, docking.id, "8", { action: "save", rev: 1, content: c }, SUPT, NAME) as { rev: number }
    assert.equal(saved.rev, 2)
    const foreign = structuredClone(c)
    foreign.sections.deck_ship[0].photos.push("00000000-0000-4000-8000-000000000000")
    refused(() => reportActionFrom(store, docking.id, "8", { action: "save", rev: 2, content: foreign }, SUPT, NAME), /photo that is not part of this docking/)
    assert.equal(reportView(store, docking.id, "8").report!.content.sections.deck_ship[1].text, "Inspection of 5P & 4P WBT carried out.")
  })

  test("issuing needs a reviewed day and text on every item, freezes the version, and a new version needs a reason", () => {
    const docking = setUp()
    const { report } = start(docking.id, "8")
    refused(() => reportActionFrom(store, docking.id, "8", { action: "issue", rev: 1 }, SUPT, NAME), /Mark Day 8 as reviewed/)
    markDayReviewed(store, docking.id, 8, SUPT)
    refused(() => reportActionFrom(store, docking.id, "8", { action: "issue", rev: 1 }, SUPT, NAME), /Ship's Staff, item 2 has no text/)

    const c = structuredClone(report!.content)
    c.sections.deck_ship[1].text = "Inspection of 5P & 4P WBT carried out."
    c.sections.service[0].company = "Alphatron"
    c.events.push({ id: "ev1", title: "Previously on 12th October 2025:", text: "1136 LT: De-slop barge arrived", carry: true })
    c.events.push({ id: "ev2", title: "18th Oct 2025:", text: "0006 LT : Lock Gate closed", carry: false })
    c.header[0].value = "Dock No. 02"
    reportActionFrom(store, docking.id, "8", { action: "save", rev: 1, content: c }, SUPT, NAME)
    const issued = reportActionFrom(store, docking.id, "8", { action: "issue", rev: 2 }, SUPT, NAME) as ReturnType<typeof reportView>
    assert.equal(issued.versions.length, 1)
    const v1 = issued.versions[0]
    assert.equal(v1.file_name, "DHT LEOPARD - Daily Report - Day 08 - 21 Oct 2025.pdf")
    assert.equal(v1.photos, 4)
    assert.equal(v1.email_text, emailText(c, { dayNo: 8, reportDate: "2025-10-21" }))
    assert.match(v1.email_text, /1\.\tAlphatron – Renewal of echo sounder transducer\./)
    assert.equal(issued.report!.changed_since_issue, false)
    const pdf = versionPdf(store, docking.id, "8", "1")
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-")
    assert.equal(pdf.data.length, v1.pdf_bytes)
    assert.equal(previewPdf(store, docking.id, "8").data.subarray(0, 5).toString(), "%PDF-")

    refused(() => reportActionFrom(store, docking.id, "8", { action: "issue", rev: 2 }, SUPT, NAME), /Nothing has changed since version 1/)
    c.summary = "Corrected summary."
    reportActionFrom(store, docking.id, "8", { action: "save", rev: 2, content: c }, SUPT, NAME)
    assert.equal(reportView(store, docking.id, "8").report!.changed_since_issue, true)
    refused(() => reportActionFrom(store, docking.id, "8", { action: "issue", rev: 3 }, SUPT, NAME), /Say what changed in version 2/)
    const again = reportActionFrom(store, docking.id, "8", { action: "issue", rev: 3, reason: "Summary corrected" }, SUPT, NAME) as ReturnType<typeof reportView>
    assert.deepEqual(again.versions.map((v) => [v.version, v.reason]), [[1, ""], [2, "Summary corrected"]])
    assert.match(again.versions[1].file_name, /\(v2\)\.pdf$/)

    assert.throws(() => store.db.prepare("UPDATE report_versions SET reason = 'x'").run(), /cannot be changed/)
    assert.throws(() => store.db.prepare("DELETE FROM report_versions").run(), /cannot be deleted/)
    assert.throws(() => store.db.prepare("DELETE FROM daily_reports").run(), /never deleted/)
    const actions = (store.db.prepare("SELECT action FROM audit WHERE entity = 'daily_report' ORDER BY id").all() as { action: string }[]).map((a) => a.action)
    assert.deepEqual(actions, ["report.start", "report.issue", "report.issue"])

    // Day 9 carries the header and greeting forward, and only the events marked to carry.
    const day9 = start(docking.id, "9")
    assert.equal(day9.carried_from_day, 8)
    assert.equal(day9.report!.content.header[0].value, "Dock No. 02")
    assert.deepEqual(day9.report!.content.events.map((e) => e.title), ["Previously on 12th October 2025:"])
    assert.equal(day9.report!.content.summary, "Below is the work progress update at shipyard.")
  })

  test("rebuilding takes the items again from the vessel's entries and keeps the header", () => {
    const docking = setUp()
    const { report } = start(docking.id, "8")
    const c = structuredClone(report!.content)
    c.sections.deck_ship = []
    c.header[0].value = "Berth 1"
    reportActionFrom(store, docking.id, "8", { action: "save", rev: 1, content: c }, SUPT, NAME)
    const rebuilt = reportActionFrom(store, docking.id, "8", { action: "rebuild", rev: 2 }, SUPT, NAME) as ReturnType<typeof reportView>
    assert.equal(rebuilt.report!.content.sections.deck_ship.length, 2)
    assert.equal(rebuilt.report!.content.header[0].value, "Berth 1")
    assert.equal(rebuilt.report!.rev, 3)
  })

  test("names are remembered for the people who act", () => {
    rememberPerson(store, SUPT, NAME)
    rememberPerson(store, SUPT, NAME)
    rememberPerson(store, "", "nobody")
    assert.deepEqual(peopleNames(store), { [SUPT]: NAME })
  })
})
