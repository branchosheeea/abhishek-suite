// OVD Admin screenshot reader: layout parsing on synthetic OCR output (no vessel data), image safety checks and
// icon colours on synthetic PNGs.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PNG } from "pngjs"
import { decodePng, iconPixel, iconSampler, ImageRejected, ocrScale, pngSize, prepareForOcr } from "../lib/ocr/image"
import { checkOf, type IconSampler, missingAgainstTotals, type OcrWord, parseOvdAdmin, sameItem, toDnvEntry } from "../lib/ocr/ovd-admin"

/** Words of one text run starting at x (6 px per character, 4 px between words, 11 px high). */
function run(text: string, x: number, y: number, conf = 95): OcrWord[] {
  const out: OcrWord[] = []
  let at = x
  for (const t of text.split(" ")) {
    out.push({ text: t, conf, x0: at, y0: y, x1: at + t.length * 6, y1: y + 11 })
    at += t.length * 6 + 4
  }
  return out
}

const CHECK = 231
const MSG = 391
const EVENT = 1472

/** An OVD Admin-like table: vessel row, two segments, items with wrapped names/messages and a detail line. */
function screen(): { words: OcrWord[]; icons: { x: number; y: number; color: "red" | "amber" }[] } {
  const words: OcrWord[] = [
    ...run("TEST VESSEL (9074729)", 35, 20),
    ...run("3issues", 76, 68), ...run("7 warnings", 149, 68),
    ...run("Status IMO Vessel name Processing Latest update processed (LT) Period from Period to Last event (UTC)", 60, 130),
    ...run("9074729 TEST VESSEL", 202, 160), ...run("2025-11-02 12:10", 504, 160), ...run("2025-01-01", 717, 160), ...run("2025-12-31", 816, 160), ...run("2025-11-01 06:00", 915, 160),
    // segment 1
    ...run("UnderWay", 213, 197), ...run("2025-07-24 03:00 =» 2025-08-01 00:06", MSG, 197), ...run("KRMOK =» SGSIN", 877, 197),
    ...run("B", 213, 234), ...run("Sea passage consistency", CHECK, 234), ...run("Sea passage start and end events reporting is not consistent.", MSG, 234), ...run("2025-07-24 16:18 SOSP", EVENT, 234),
    ...run("A.", 212, 273), ...run("Duration vs. reporting", CHECK, 273), ...run("Reported duration (4.6 hours) is -15.5 hours smaller than difference between reporting times (20.1 hours).", MSG, 273), ...run("2025-08-0100:06 Arrival", EVENT, 273),
    ...run("times", CHECK, 288),
    // segment 2
    ...run("InPort", 213, 324), ...run("2025-08-01 00:06 =» 2025-08-02 17:42", MSG, 324), ...run("SGSIN =» SGSIN", 877, 324),
    ...run("Maneuvering in port", CHECK, 452), ...run("Distance in port was detected, however no time elapsed maneuvering was reported.", MSG, 452), ...run("2025-08-01 04:00 Noon", EVENT, 452),
    ...run("Consumption deviation", CHECK, 616), ...run("Total consumption per hour during the port stay between 2025-08-01 00:06 and 2025-08-02 17:42 exceeds expected values based on", MSG, 616),
    ...run("(voyage)", CHECK, 631), ...run("other port stays. Please clarify via DATE.", MSG, 631),
    ...run("Cli: FC boiler", CHECK, 670, 44), ...run("Reported cargo heating consumption is higher than boiler consumption on this event.", MSG, 670), ...run("2025-08-02 03:00 Noon", EVENT, 670),
    ...run("(consumption)", CHECK, 686),
    ...run("Fuel type HFO: cargo heating consumption: 0.8 mt; boiler consumption: 0.7 mt.", MSG, 701),
  ]
  const icons = [
    { x: 218, y: 239, color: "red" as const },
    { x: 218, y: 278, color: "amber" as const },
    { x: 218, y: 457, color: "amber" as const },
    { x: 218, y: 621, color: "amber" as const },
    { x: 218, y: 675, color: "amber" as const },
    { x: 95, y: 202, color: "red" as const }, // segment counter icons are not items
  ]
  return { words, icons }
}

const samplerOf = (icons: { x: number; y: number; color: "red" | "amber" }[]): IconSampler => (x0, y0, x1, y1) =>
  icons.find((i) => i.x >= x0 && i.x <= x1 && i.y >= y0 && i.y <= y1)?.color ?? null

describe("OVD Admin layout reader", () => {
  const { words, icons } = screen()
  const parsed = parseOvdAdmin(words, samplerOf(icons))

  test("vessel, IMO, reporting period and the UnderWay / InPort segments", () => {
    assert.deepEqual(parsed.vessel, { name: "TEST VESSEL", imo: "9074729" })
    assert.deepEqual(parsed.period, { from: "2025-01-01", to: "2025-12-31" })
    assert.deepEqual(parsed.segments, [
      { type: "UnderWay", fromUtc: "2025-07-24T03:00Z", toUtc: "2025-08-01T00:06Z", fromPort: "KRMOK", toPort: "SGSIN" },
      { type: "InPort", fromUtc: "2025-08-01T00:06Z", toUtc: "2025-08-02T17:42Z", fromPort: "SGSIN", toPort: "SGSIN" },
    ])
  })

  test("items: check, severity from the icon colour, message, event time and event, segment", () => {
    assert.equal(parsed.items.length, 5)
    const [sea, duration, maneuvering, consumption, boiler] = parsed.items
    assert.deepEqual([sea.category, sea.severity, sea.severitySource, sea.eventUtc, sea.eventName, sea.segment?.type], ["SEA_PASSAGE", "error", "icon", "2025-07-24T16:18Z", "SOSP", "UnderWay"])
    // a wrapped check name, and a date and time that OCR ran together
    assert.equal(duration.checkName, "Duration vs. reporting times")
    assert.equal(duration.eventUtc, "2025-08-01T00:06Z")
    assert.equal(duration.severity, "warning")
    // "in port" inside a message is not an InPort segment row
    assert.equal(maneuvering.category, "MANEUVERING_IN_PORT")
    assert.equal(maneuvering.segment?.type, "InPort")
    assert.match(maneuvering.message, /^Distance in port was detected/)
    // no event time: the window stated in the message is used; wrapped message and check name are joined
    assert.equal(consumption.checkName, "Consumption deviation (voyage)")
    assert.equal(consumption.eventUtc, null)
    assert.deepEqual([consumption.fromUtc, consumption.toUtc], ["2025-08-01T00:06Z", "2025-08-02T17:42Z"])
    assert.match(consumption.message, /based on other port stays\. Please clarify via DATE\.$/)
    // "Cli" read for "CII"; the detail line joins the message; the fuel is taken from it; low confidence flagged
    assert.equal(boiler.checkName, "CII: FC boiler (consumption)")
    assert.equal(boiler.category, "CII_BOILER")
    assert.equal(boiler.fuel, "HFO")
    assert.match(boiler.message, /on this event\. Fuel type HFO: cargo heating consumption: 0\.8 mt; boiler consumption: 0\.7 mt\.$/)
    assert.ok(boiler.uncertain.includes("Cli:"))
  })

  test("OVD Admin's own totals are read, so missing items (cut off by the screenshot) are pointed out", () => {
    assert.deepEqual(parsed.totals, { issues: 3, warnings: 7 })
    assert.deepEqual(missingAgainstTotals(parsed.totals, parsed.items), { issues: 2, warnings: 3 })
    assert.equal(missingAgainstTotals({ issues: null, warnings: null }, parsed.items), null)
  })

  test("without an image sampler, the OCR'd icon glyph or a known check name still starts an item", () => {
    const p = parseOvdAdmin(words)
    assert.equal(p.items.length, 5)
    assert.deepEqual(p.items.map((i) => i.severitySource), ["glyph", "glyph", "unknown", "unknown", "unknown"])
    assert.deepEqual(p.items.slice(0, 2).map((i) => i.severity), ["error", "warning"])
    assert.ok(p.warnings.some((w) => /without a recognisable error\/warning icon/.test(w)))
  })

  test("an unrelated image gives no items and says what to capture", () => {
    const p = parseOvdAdmin(run("Some unrelated text on a page", 10, 10))
    assert.equal(p.items.length, 0)
    assert.match(p.warnings[0], /No OVD Admin items were recognised/)
  })

  test("check names map to the DNV categories; unknown names are kept as read", () => {
    assert.equal(checkOf("Reported ROB vs. available fuel").category, "FUEL_AVAILABLE")
    assert.equal(checkOf("ROBs reported (beginning of year)").category, "BOY_ROB")
    assert.equal(checkOf("Distance deviation (per voyage)").category, "DISTANCE")
    assert.deepEqual(checkOf("Some new check"), { name: "Some new check", category: "OTHER" })
  })

  test("an item becomes a screenshot DNV entry with its evidence; the same item is recognised as already entered", () => {
    const item = parsed.items[0]
    const entry = toDnvEntry(item, "9074729", { sha256: "a".repeat(64), name: "shot.png", reader: "local" }, false)
    assert.equal(entry.entryMethod, "screenshot")
    assert.equal(entry.confirmed, false)
    assert.equal(entry.eventUtc, "2025-07-24T16:18Z")
    assert.match(entry.description, /\(event: SOSP\)$/)
    assert.match(entry.voyageOrPortStay!, /^UnderWay KRMOK → SGSIN/)
    assert.deepEqual(entry.portCodes, ["KRMOK", "SGSIN"])
    assert.ok(sameItem(entry, item))
    assert.ok(!sameItem({ ...entry, eventUtc: "2025-07-25T16:18Z" }, item))
  })
})

describe("screenshot image handling", () => {
  function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
    const p = new PNG({ width, height })
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y)
      const i = (y * width + x) * 4
      p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255
    }
    return new Uint8Array(PNG.sync.write(p))
  }

  test("only PNG is accepted, and the size is checked before anything is decompressed", () => {
    assert.throws(() => pngSize(new TextEncoder().encode("GIF89a not a png at all, padded to length....")), ImageRejected)
    const header = png(4, 4, () => [255, 255, 255])
    const huge = header.slice()
    new DataView(huge.buffer).setUint32(16, 50_000) // width in IHDR
    assert.throws(() => decodePng(huge), /16 megapixels/)
  })

  test("icon colours: error red and warning amber are told apart; grey, blue and white are not icons", () => {
    assert.equal(iconPixel(211, 47, 47), "red")
    assert.equal(iconPixel(245, 166, 35), "amber")
    assert.equal(iconPixel(128, 128, 128), null)
    assert.equal(iconPixel(42, 120, 214), null)
    const img = decodePng(png(60, 20, (x) => (x >= 5 && x < 15 ? [211, 47, 47] : x >= 35 && x < 45 ? [245, 166, 35] : [255, 255, 255])))
    const sample = iconSampler(img)
    assert.equal(sample(0, 0, 20, 19), "red")
    assert.equal(sample(30, 0, 50, 19), "amber")
    assert.equal(sample(18, 0, 30, 19), null)
  })

  test("the OCR copy is grayscale, enlarged, and a dark screenshot is inverted to dark-on-light", () => {
    assert.equal(ocrScale(1700, 750), 3)
    assert.equal(ocrScale(3840, 2160), 2)
    const dark = decodePng(png(10, 10, () => [20, 20, 20]))
    const out = PNG.sync.read(prepareForOcr(dark, 3))
    assert.equal(out.width, 30)
    assert.ok(out.data[0] > 200) // inverted
  })
})
