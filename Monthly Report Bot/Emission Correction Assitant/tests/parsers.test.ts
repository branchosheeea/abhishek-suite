import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { zip } from "../lib/export/xlsx-writer"
import { checkUpload, parseSource, SourceRejected } from "../lib/parsers"
import { parseCsv } from "../lib/parsers/csv"
import { isDateFormat, parseXlsx, XlsxError } from "../lib/parsers/xlsx"
import { readZipDirectory, ZipError } from "../lib/parsers/zip"
import { baseRows, csvTable, ovdlaBytes, sha } from "./helpers"

const enc = (s: string) => new TextEncoder().encode(s)

describe("CSV reader", () => {
  test("keeps raw text, header, original order and physical line numbers (incl. multi-line quoted fields)", () => {
    const t = csvTable('A,B,C\r\n1,"x, y",3\r\n2,"line1\r\nline2",4\r\n3,"say ""hi""",5\r\n')
    assert.deepEqual(t.headers, ["A", "B", "C"])
    assert.deepEqual(t.rows.map((r) => r.line), [2, 3, 5])
    assert.equal(t.rows[0].cells[1], "x, y")
    assert.equal(t.rows[1].cells[1], "line1\r\nline2")
    assert.equal(t.rows[2].cells[1], 'say "hi"')
    assert.equal(t.meta.lineEndings, "CRLF")
  })

  test("never repairs: ragged rows, stray quotes and blank lines are reported and kept as written", () => {
    const t = csvTable('A,B,C\n1,2\n\n4,5"x,6\n7,8,9,10\n')
    assert.deepEqual(t.rows[0].cells, ["1", "2"]) // not padded
    assert.equal(t.rows[1].blankLine, true) // kept as a row, not dropped
    assert.equal(t.rows[2].cells[1], '5"x')
    assert.deepEqual(t.rows[3].cells, ["7", "8", "9", "10"]) // not truncated
    const codes = t.issues.map((i) => i.code)
    assert.ok(codes.includes("csv.column-count"))
    assert.ok(codes.includes("csv.blank-line"))
    assert.ok(codes.includes("csv.stray-quote"))
  })

  test("BOM, semicolon delimiter and non-UTF-8 bytes are recorded", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("A;B\n1;2\n")])
    const t = parseCsv(bom, "LA", sha(bom), "x.csv")
    assert.equal(t.meta.bom, true)
    assert.equal(t.meta.delimiter, ";")
    assert.deepEqual(t.headers, ["A", "B"])
    const latin = new Uint8Array([...enc("A,B\n"), 0x44, 0xe9, 0x70, ...enc(",2\n")]) // "Dép" in Windows-1252
    const l = parseCsv(latin, "LA", sha(latin), "x.csv")
    assert.equal(l.meta.encoding, "Windows-1252")
    assert.equal(l.rows[0].cells[0], "Dép")
    assert.ok(l.issues.some((i) => i.code === "csv.encoding"))
  })

  test("parsed tables are deeply frozen", () => {
    const t = csvTable("A,B\n1,2\n")
    assert.throws(() => {
      ;(t.rows[0].cells as string[])[0] = "999"
    }, TypeError)
    assert.throws(() => {
      ;(t.rows as unknown as unknown[]).push({})
    }, TypeError)
    assert.equal(t.rows[0].cells[0], "1")
  })
})

describe("upload gate", () => {
  test("accepts only the expected format by extension and content", () => {
    assert.equal(checkUpload(enc("A,B\n"), "la.csv", "LA"), "csv")
    assert.throws(() => checkUpload(enc("A,B\n"), "la.txt", "LA"), SourceRejected)
    assert.throws(() => checkUpload(ovdlaBytes(baseRows()), "la.csv", "LA"), /ZIP\/Excel/)
    assert.throws(() => checkUpload(enc("%PDF-1.7"), "la.csv", "LA"), /PDF/)
    assert.throws(() => checkUpload(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "o.xls", "OVDLA"), /Legacy/)
    assert.throws(() => checkUpload(enc("PK"), "o.xlsm", "OVDLA"), /Macro/)
    assert.throws(() => checkUpload(enc("A,B\n"), "../../evil.csv", "LA"), /path/)
    assert.throws(() => checkUpload(new Uint8Array(0), "la.csv", "LA"), /empty/)
    assert.throws(() => parseSource(enc("A,B\n\u0000"), "LA", "x", "la.csv"), /NUL/)
  })
})

describe("XLSX reader", () => {
  test("reads stored cell text, types and the sheet row numbers", () => {
    const bytes = ovdlaBytes(baseRows())
    const t = parseXlsx(bytes, "OVDLA", sha(bytes), "o.xlsx")
    assert.equal(t.headers[0], "IMO")
    assert.equal(t.headers.at(-1), "Last_Updated")
    assert.equal(t.rows.length, 4)
    assert.equal(t.rows[0].line, 2)
    assert.equal(t.rows[0].cells[t.headers.indexOf("LFO_ROB")], "500.000") // exact stored text, not 500
    assert.equal(t.meta.sheet, "Log Abstract")
  })

  test("shared strings, date styles and formulas without a cached value", () => {
    const files = [
      { name: "[Content_Types].xml", data: Buffer.from('<Types xmlns="x"><Default Extension="xml" ContentType="application/xml"/></Types>') },
      { name: "xl/workbook.xml", data: Buffer.from('<workbook xmlns:r="r"><workbookPr/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/sharedStrings.xml", data: Buffer.from('<sst><si><t>Date_UTC</t></si><si><r><t>Ev</t></r><r><t>ent</t></r><rPh><t>x</t></rPh></si><si><t>A &amp; B</t></si></sst>') },
      { name: "xl/styles.xml", data: Buffer.from('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>') },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" s="1"><v>45717</v></c><c r="B3" t="s"><v>2</v></c><c r="C3"><f>1+1</f></c></row></sheetData></worksheet>') },
    ]
    const bytes = zip(files)
    const t = parseXlsx(bytes, "OVDLA", sha(bytes), "o.xlsx")
    assert.deepEqual(t.headers, ["Date_UTC", "Event"])
    assert.equal(t.rows[0].line, 3) // sparse rows keep the sheet row number
    assert.equal(t.rows[0].cells[0], "45717")
    assert.equal(t.rows[0].dateFormatted?.[0], true)
    assert.equal(t.rows[0].cells[1], "A & B")
    assert.equal(t.rows[0].cells[2], "") // formula not evaluated
    assert.ok(t.issues.some((i) => i.code === "xlsx.formula-no-value"))
    assert.ok(!t.issues.some((i) => i.code === "xlsx.beyond-header")) // the cell beyond the header is empty
  })

  test("date format detection", () => {
    assert.equal(isDateFormat(14, undefined), true)
    assert.equal(isDateFormat(164, "dd/mm/yyyy hh:mm"), true)
    assert.equal(isDateFormat(165, "0.000"), false)
    assert.equal(isDateFormat(166, '#,##0.00" mt"'), false)
    assert.equal(isDateFormat(167, "[Red]0.00"), false)
  })

  const minimal = (extra: { name: string; data: Buffer }[] = [], rels = '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>') => [
    { name: "[Content_Types].xml", data: Buffer.from('<Types xmlns="x"/>') },
    { name: "xl/workbook.xml", data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<Relationships>${rels}</Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>H</t></is></c></row></sheetData></worksheet>') },
    ...extra,
  ]

  test("rejects macros, external links, embedded objects and DOCTYPE/entity declarations", () => {
    const reject = (files: { name: string; data: Buffer }[], pattern: RegExp) => {
      const bytes = zip(files)
      assert.throws(() => parseXlsx(bytes, "OVDLA", sha(bytes), "o.xlsx"), pattern)
    }
    reject(minimal([{ name: "xl/vbaProject.bin", data: Buffer.from("x") }]), /macros/)
    reject(minimal([{ name: "xl/externalLinks/externalLink1.xml", data: Buffer.from("<x/>") }]), /external workbooks/)
    reject(minimal([{ name: "xl/embeddings/oleObject1.bin", data: Buffer.from("x") }]), /embedded/)
    reject(minimal([], '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Target="http://evil" TargetMode="External"/>'), /external resource/)
    const xxe = minimal()
    xxe[3] = { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///c:/windows/win.ini">]><worksheet><sheetData/></worksheet>') }
    reject(xxe, /DOCTYPE/)
  })

  test("rejects decompression bombs before inflating, and corrupted parts", () => {
    const huge = Buffer.alloc(40 * 1024 * 1024, 0x41) // highly compressible: ratio far above the limit
    const bomb = zip(minimal([{ name: "xl/worksheets/sheet2.xml", data: huge }]))
    assert.throws(() => readZipDirectory(bomb), (e: unknown) => e instanceof ZipError && /compression ratio/.test((e as Error).message))
    assert.throws(() => parseXlsx(bomb, "OVDLA", sha(bomb), "o.xlsx"), XlsxError)

    const good = zip(minimal())
    const corrupt = Buffer.from(good)
    const sheetAt = corrupt.indexOf(Buffer.from("xl/worksheets/sheet1.xml")) + "xl/worksheets/sheet1.xml".length
    corrupt[sheetAt + 2] ^= 0xff // flip a compressed byte of the sheet part
    assert.throws(() => parseXlsx(corrupt, "OVDLA", sha(corrupt), "o.xlsx"), XlsxError)
  })
})
