// Digital Docking · Stage 1A: every picture is linked to exactly one row and slot, or rejected with where and why;
// unsafe or unsupported files are refused before parsing. Synthetic workbooks only.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import ExcelJS from "exceljs"
import { analyzeWorkbook, type Picture } from "../lib/docking/photos/analyze"
import { imageInfo } from "../lib/docking/photos/image-size"
import { DEFAULT_LIMITS, readPackage, WorkbookRejected } from "../lib/docking/photos/package"
import { buildPhotoTestWorkbook } from "../lib/docking/photos/template"
import { jpegHeader, png, pngHeader, zip } from "./docking-photos.helpers"

const px = (n: number) => n * 9525
// Columns (0-based) C=2 … F=5 are Photo 1–4; worksheet rows 6–8 (0-based 5–7) are DK001–DK003. A slot is 238 × 220 px.
type At = { col: number; colPx: number; row: number; rowPx: number }
const at = (a: At) => ({ nativeCol: a.col, nativeColOff: px(a.colPx), nativeRow: a.row, nativeRowOff: px(a.rowPx) })

async function workbookWith(place: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook, image: number) => void, variant: "unprotected" | "protected" = "unprotected") {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await buildPhotoTestWorkbook(variant)) as unknown as ArrayBuffer)
  const image = wb.addImage({ buffer: png(40, 30) as unknown as ExcelJS.Buffer, extension: "png" })
  place(wb.getWorksheet("Deck Work")!, wb, image)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const summary = (p: Picture) => (p.status === "linked" ? `${p.rowRef} Photo ${p.slot}` : `REJECTED ${p.cell}: ${p.reason}`)

describe("pictures placed over cells", () => {
  test("pictures inside a slot are linked; outside, across or doubled are rejected with the place and reason", async () => {
    const data = await workbookWith((ws, wb, image) => {
      const two = (tl: At, br: At) => ws.addImage(image, { tl: at(tl), br: at(br), editAs: "oneCell" } as unknown as ExcelJS.ImageRange)
      const one = (tl: At, w: number, h: number) => ws.addImage(image, { tl: at(tl), ext: { width: w, height: h } } as unknown as ExcelJS.ImageRange)
      two({ col: 2, colPx: 10, row: 5, rowPx: 10 }, { col: 2, colPx: 200, row: 5, rowPx: 180 }) // C6: DK001 Photo 1
      one({ col: 3, colPx: 5, row: 5, rowPx: 5 }, 150, 120) // D6: DK001 Photo 2 (one-cell anchor)
      two({ col: 4, colPx: 10, row: 5, rowPx: 10 }, { col: 5, colPx: 4, row: 5, rowPx: 150 }) // E6, 4 px over the edge: still Photo 3
      two({ col: 4, colPx: 150, row: 6, rowPx: 10 }, { col: 5, colPx: 100, row: 6, rowPx: 150 }) // across E7 | F7
      one({ col: 1, colPx: 10, row: 5, rowPx: 10 }, 100, 80) // B6: the text column
      one({ col: 2, colPx: 5, row: 4, rowPx: 2 }, 50, 10) // C5: the header row
      one({ col: 2, colPx: 5, row: 7, rowPx: 5 }, 60, 60) // C8 twice: DK003 Photo 1
      one({ col: 2, colPx: 90, row: 7, rowPx: 90 }, 60, 60)
      wb.getWorksheet("How to test")!.addImage(image, { tl: { col: 1, row: 1 }, ext: { width: 30, height: 30 } }) // wrong sheet
    })
    const result = await analyzeWorkbook(data)
    assert.equal(result.template, "DD-PHOTO-TEST")
    assert.equal(result.variant, "unprotected")
    const lines = result.pictures.map(summary)
    assert.deepEqual(result.pictures.filter((p) => p.status === "linked").map(summary), ["DK001 Photo 1", "DK001 Photo 2", "DK001 Photo 3"])
    const reasonFor = (cell: string) => result.pictures.filter((p) => p.cell === cell && p.status === "rejected").map((p) => p.reason)
    assert.match(reasonFor("F7")[0], /crosses from Deck Work!F7 into a neighbouring slot/)
    assert.match(reasonFor("B6")[0], /column B, not in a photo slot/)
    assert.match(reasonFor("C5")[0], /row 5, which is not an activity row/)
    assert.equal(reasonFor("C8").length, 2)
    for (const r of reasonFor("C8")) assert.match(r, /2 pictures share Deck Work!C8 \(Photo 1\)/)
    assert.ok(result.pictures.some((p) => p.sheet === "How to test" && /belong in the photo slots of "Deck Work"/.test(p.reason)), lines.join("\n"))
    assert.equal(result.pictures.length, 9)
    const linked = result.pictures.find((p) => p.slot === 1)!
    assert.deepEqual([linked.anchor, linked.method, linked.width, linked.height, linked.format], ["two-cell", "over cells", 40, 30, "png"])
    assert.match(linked.sha256, /^[0-9a-f]{64}$/)
  })

  test("the protected variant keeps pictures editable and only the work text and photo cells unlocked", async () => {
    const data = await workbookWith((ws, _wb, image) => {
      ws.addImage(image, { tl: at({ col: 5, colPx: 20, row: 7, rowPx: 20 }), ext: { width: 120, height: 90 } } as unknown as ExcelJS.ImageRange)
    }, "protected")
    const result = await analyzeWorkbook(data)
    assert.deepEqual(result.pictures.map(summary), ["DK003 Photo 4"])
    assert.equal(result.variant, "protected")
    const entries = await readPackage(await buildPhotoTestWorkbook("protected"))
    const sheet = entries.get("xl/worksheets/sheet2.xml")!.toString("utf8")
    const protection = /<sheetProtection[^>]*>/.exec(sheet)![0]
    assert.match(protection, /sheet="1"/)
    assert.doesNotMatch(protection, /objects="1"/) // "Edit objects" stays allowed: photos can be inserted and moved
    assert.match(entries.get("xl/workbook.xml")!.toString("utf8"), /name="_ID" state="veryHidden"/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await buildPhotoTestWorkbook("protected")) as unknown as ArrayBuffer)
    const ws = wb.getWorksheet("Deck Work")!
    assert.equal(ws.getCell("A6").protection?.locked, undefined) // locked by default
    for (const cell of ["B6", "C6", "F8"]) assert.equal(ws.getCell(cell).protection?.locked, false, cell)
    assert.doesNotMatch((await readPackage(await buildPhotoTestWorkbook("unprotected"))).get("xl/worksheets/sheet2.xml")!.toString("utf8"), /<sheetProtection/)
  })
})

describe("pictures placed in cells (Place in Cell)", () => {
  async function withInCellPictures() {
    const entries = await readPackage(await buildPhotoTestWorkbook("unprotected"))
    const sheetPart = "xl/worksheets/sheet2.xml"
    let sheet = entries.get(sheetPart)!.toString("utf8")
    const put = (ref: string, vm: number) => {
      const re = new RegExp(`<c r="${ref}"(?: [^>]*?)?( s="\\d+")?(?: [^>]*?)?(?:/>|>[\\s\\S]*?</c>)`)
      assert.ok(re.test(sheet), `cell ${ref} not found`)
      sheet = sheet.replace(re, (_m, style = "") => `<c r="${ref}"${style} t="e" vm="${vm}"><v>#VALUE!</v></c>`)
    }
    put("D7", 1) // DK002 Photo 2
    put("B7", 2) // the text column
    put("E7", 3) // a web picture (IMAGE function)
    entries.set(sheetPart, Buffer.from(sheet))
    const rvb = (i: number) => `<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="${i}"/></ext></extLst></bk>`
    entries.set("xl/metadata.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="3">${rvb(0)}${rvb(1)}${rvb(2)}</futureMetadata><valueMetadata count="3"><bk><rc t="1" v="0"/></bk><bk><rc t="1" v="1"/></bk><bk><rc t="1" v="2"/></bk></valueMetadata></metadata>`))
    entries.set("xl/richData/rdrichvalue.xml", Buffer.from(`<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="3"><rv s="0"><v>0</v><v>5</v></rv><rv s="0"><v>1</v><v>5</v></rv><rv s="1"><v>https://example.invalid/a.png</v></rv></rvData>`))
    entries.set("xl/richData/rdrichvaluestructure.xml", Buffer.from(`<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="2"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s><s t="_webimage"><k n="WebImageIdentifier" t="i"/></s></rvStructures>`))
    entries.set("xl/richData/richValueRel.xml", Buffer.from(`<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/><rel r:id="rId2"/></richValueRels>`))
    entries.set("xl/richData/_rels/richValueRel.xml.rels", Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/incell1.png"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/incell2.png"/></Relationships>`))
    entries.set("xl/media/incell1.png", png(64, 48))
    entries.set("xl/media/incell2.png", png(20, 20))
    return { entries, data: zip(entries) }
  }

  test("a stored picture in a slot cell is linked; in another cell or from the web it is rejected", async () => {
    const { data } = await withInCellPictures()
    const result = await analyzeWorkbook(data)
    assert.deepEqual(result.pictures.map(summary), [
      "REJECTED B7: it is in column B, not in a photo slot (Photo 1–4)",
      "DK002 Photo 2",
      "REJECTED E7: it is a web picture (IMAGE function), not a photo stored in the file",
    ])
    const linked = result.pictures[1]
    assert.deepEqual([linked.method, linked.anchor, linked.width, linked.media], ["in cell", "cell", 64, "xl/media/incell1.png"])
  })

  test("in-cell picture data that points nowhere is rejected, not skipped", async () => {
    const { entries } = await withInCellPictures()
    entries.delete("xl/media/incell1.png")
    const result = await analyzeWorkbook(zip(entries))
    assert.match(result.pictures.find((p) => p.cell === "D7")!.reason, /picture data is missing/)
  })
})

describe("unsafe or unsupported files are refused before parsing", () => {
  const refused = async (data: Buffer, pattern: RegExp, limits = DEFAULT_LIMITS) => {
    await assert.rejects(analyzeWorkbook(data, limits), (error: unknown) => error instanceof WorkbookRejected && pattern.test(error.message))
  }

  test("old .xls or password-protected, not a workbook, too large, too many parts", async () => {
    await refused(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]), /old-format \(\.xls\) or password-protected/)
    await refused(Buffer.from("hello"), /not an Excel \.xlsx workbook/)
    const good = await buildPhotoTestWorkbook("unprotected")
    await refused(good, /limit is 0 MB/, { ...DEFAULT_LIMITS, maxFileBytes: 1000 })
    await refused(good, /more than 3 parts/, { ...DEFAULT_LIMITS, maxEntries: 3 })
    await refused(good, /unpacks to more than the allowed size/, { ...DEFAULT_LIMITS, maxTotalUnzippedBytes: 2000 })
  })

  test("unsafe part names, encryption flags, macros and document type declarations", async () => {
    const entries = await readPackage(await buildPhotoTestWorkbook("unprotected"))
    await refused(zip([...entries, ["../../evil.txt", Buffer.from("x")]]), /unsafe part name/)
    await refused(zip([...entries], 1), /encrypted/)
    await refused(zip([...entries, ["xl/vbaProject.bin", Buffer.from("x")]]), /macros or ActiveX/)
    const xml = new Map(entries)
    xml.set("xl/workbook.xml", Buffer.from(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>${entries.get("xl/workbook.xml")!.toString("utf8").replace(/^<\?xml[^>]*\?>/, "")}`))
    await refused(zip(xml), /document type declaration/)
  })

  test("a workbook not issued by NeraVeda, or with its work sheet renamed, is refused", async () => {
    const entries = await readPackage(await buildPhotoTestWorkbook("unprotected"))
    const noId = new Map(entries)
    noId.set("xl/workbook.xml", Buffer.from(entries.get("xl/workbook.xml")!.toString("utf8").replace(/<sheet [^>]*name="_ID"[^>]*\/>/, "")))
    await refused(zip(noId), /not issued by NeraVeda/)
    const renamed = new Map(entries)
    renamed.set("xl/workbook.xml", Buffer.from(entries.get("xl/workbook.xml")!.toString("utf8").replace('name="Deck Work"', 'name="Deck"')))
    await refused(zip(renamed), /"Deck Work" is missing or was renamed/)
  })

  test("pictures that are linked to outside files, grouped, hidden or huge are rejected", async () => {
    const data = await workbookWith((ws, _wb, image) => {
      for (let i = 0; i < 4; i++) ws.addImage(image, { tl: at({ col: 2 + i, colPx: 10, row: 6, rowPx: 10 }), ext: { width: 50, height: 50 } } as unknown as ExcelJS.ImageRange)
    })
    const entries = await readPackage(data)
    const drawingPart = [...entries.keys()].find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))!
    let drawing = entries.get(drawingPart)!.toString("utf8")
    const pics = drawing.match(/<xdr:pic>[\s\S]*?<\/xdr:pic>/g)!
    assert.equal(pics.length, 4)
    drawing = drawing.replace(pics[0], pics[0].replace(/r:embed="[^"]*"/, 'r:link="rIdX"'))
    drawing = drawing.replace(pics[1], `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="90" name="Group 1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr/>${pics[1]}</xdr:grpSp>`)
    drawing = drawing.replace(pics[2], pics[2].replace(/<xdr:cNvPr ([^>]*?)(\/?)>/, '<xdr:cNvPr $1 hidden="1"$2>'))
    entries.set(drawingPart, Buffer.from(drawing))
    const mediaPart = [...entries.keys()].find((n) => n.startsWith("xl/media/"))!
    const huge = new Map(entries)
    const result = await analyzeWorkbook(zip(entries))
    const byCell = Object.fromEntries(result.pictures.map((p) => [p.cell, p.reason]))
    assert.match(byCell.C7, /linked to a file outside the workbook/)
    assert.match(byCell.D7, /grouped/)
    assert.match(byCell.E7, /hidden/)
    assert.equal(result.pictures.find((p) => p.cell === "F7")!.status, "linked")
    huge.set(mediaPart, pngHeader(10000, 9000))
    const big = await analyzeWorkbook(zip(huge))
    assert.match(big.pictures.find((p) => p.cell === "F7")!.reason, /10000 × 9000 pixels, larger than the 50 megapixel limit/)
  })
})

describe("photo size from the file header", () => {
  test("PNG and JPEG sizes are read without decoding", () => {
    assert.deepEqual(imageInfo(png(321, 123)), { format: "png", width: 321, height: 123 })
    assert.deepEqual(imageInfo(jpegHeader(1280, 960)), { format: "jpeg", width: 1280, height: 960 })
    assert.equal(imageInfo(Buffer.from("not an image")), null)
  })
})
