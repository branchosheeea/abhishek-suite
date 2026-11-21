// Digital Docking · Stage 1A: the photo test workbook (3 activity rows × 4 photo slots), unprotected or protected.
// It is a test instrument, not the production vessel template (Stage 1C): its only job is to show, on the vessel's
// own Excel, which way of inserting photos links every picture to the right row and slot.

import ExcelJS from "exceljs"
import { columnLetter, PHOTO_TEST_LAYOUT as L, PHOTO_TEST_TEMPLATE } from "./layout"

export type Variant = "unprotected" | "protected"

const SLOT_WIDTH = 34 // characters ≈ 243 px
const ACTIVITY_ROW_HEIGHT = 165 // points ≈ 220 px
const GREY = "FFEFF2F5"
const BORDER = { style: "thin" as const, color: { argb: "FF9AA5B1" } }
const box = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER }

export const TESTS: readonly (readonly [string, string, string, string])[] = [
  ["T1", "Insert > Pictures > This Device. Drag and resize each photo so it sits fully inside its grey box.", "Unprotected file · DK001 · Photo 1–4", "4 linked"],
  ["T2", "Select a grey box, then Insert > Pictures > Place in Cell (skip if your Excel has no such option).", "Unprotected file · DK002 · Photo 1–4", "4 linked, or note: option not available"],
  ["T3", "Mix: one photo placed over cells, one placed in a cell.", "Unprotected file · DK003 · Photo 1–2", "2 linked"],
  ["T4", "Put one photo so that it covers part of two grey boxes.", "Unprotected file · DK003 · between Photo 3 and Photo 4", "rejected: crosses into a neighbouring slot"],
  ["T5", "Put one photo in the white 'Work carried out' column.", "Unprotected file · DK001 · column B", "rejected: not in a photo slot"],
  ["T6", "Copy a photo from another program (e.g. WhatsApp, Photos) and paste it into a grey box.", "Protected file · DK001 · Photo 1", "linked"],
  ["T7", "On the protected file: insert photos, move and resize them, delete one and insert again. Try to change the DK001 cell.", "Protected file · DK001–DK003", "photos can be edited; the row reference cannot"],
  ["T8", "Open the T1 file on the ECR PC (the older Excel), add one photo in DK002 Photo 1, save.", "Unprotected file after T1", "all linked, opens without a repair message"],
  ["T9", "Save copies after File > Compress Pictures at 96 ppi, 150 ppi and 220 ppi (untick 'Apply only to this picture').", "Any filled file", "report shows size per photo for each setting"],
]

function title(sheet: ExcelJS.Worksheet, text: string, sub: string) {
  sheet.getCell("A1").value = text
  sheet.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF0F1B2A" } }
  sheet.getCell("A2").value = sub
  sheet.getCell("A2").font = { size: 10, color: { argb: "FF5F6B7A" } }
}

export async function buildPhotoTestWorkbook(variant: Variant, generatedAt = new Date()): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "NeraVeda"
  wb.created = generatedAt

  const guide = wb.addWorksheet("How to test")
  title(guide, "NeraVeda · Digital Docking · Photo test workbook", `${variant === "protected" ? "PROTECTED" : "UNPROTECTED"} version · fill the "Deck Work" sheet, save, and send the file back for checking.`)
  guide.columns = [{ width: 6 }, { width: 70 }, { width: 40 }, { width: 36 }, { width: 30 }]
  guide.getRow(4).values = ["Test", "What to do", "Where", "Expected", "Your note (Excel version, anything odd)"]
  guide.getRow(4).font = { bold: true }
  TESTS.forEach((t, i) => {
    const row = guide.getRow(5 + i)
    row.values = [...t, ""]
    row.alignment = { wrapText: true, vertical: "top" }
  })
  guide.getCell(`A${6 + TESTS.length}`).value = "Keep one photo per grey box. Do not rename sheets or insert rows. Save as Excel Workbook (.xlsx)."
  guide.getCell(`A${6 + TESTS.length}`).font = { italic: true, size: 10 }

  const ws = wb.addWorksheet(L.sheet, { views: [{ state: "frozen", ySplit: L.rows[0] - 1 }] })
  title(ws, "Deck Work — photo test", "Put each photo fully inside one grey box. More than four photos for one job: use the next row.")
  ws.getCell("A3").value = variant === "protected" ? "This sheet is protected: only the white text cells and the grey photo boxes can be changed." : "This sheet is not protected."
  ws.getCell("A3").font = { size: 10, italic: true }
  ws.getColumn(L.refColumn).width = 10
  ws.getColumn(2).width = 42
  for (const c of L.slotColumns) ws.getColumn(c).width = SLOT_WIDTH
  const header = ws.getRow(L.rows[0] - 1)
  header.getCell(L.refColumn).value = "Row ref"
  header.getCell(2).value = "Work carried out today"
  L.slotColumns.forEach((c, i) => (header.getCell(c).value = `Photo ${i + 1}`))
  header.font = { bold: true }
  header.eachCell((cell) => (cell.border = box))

  L.rows.forEach((r, i) => {
    const row = ws.getRow(r)
    row.height = ACTIVITY_ROW_HEIGHT
    const ref = row.getCell(L.refColumn)
    ref.value = `DK${String(i + 1).padStart(3, "0")}`
    ref.font = { bold: true }
    ref.alignment = { vertical: "top" }
    ref.border = box
    const work = row.getCell(2)
    work.value = `Test row ${i + 1}: type anything here.`
    work.alignment = { wrapText: true, vertical: "top" }
    work.border = box
    work.protection = { locked: false }
    for (const c of L.slotColumns) {
      const slot = row.getCell(c)
      slot.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREY } }
      slot.border = box
      slot.protection = { locked: false }
    }
  })
  if (variant === "protected") {
    // No password: protection prevents accidental edits; it is not a security boundary. Objects (pictures) stay
    // editable because `objects` is left unset, which Excel shows as "Edit objects" allowed.
    await ws.protect("", { selectLockedCells: true, selectUnlockedCells: true })
  }

  const id = wb.addWorksheet("_ID", { state: "veryHidden" })
  const identity: [string, string | number][] = [
    ["Template", PHOTO_TEST_TEMPLATE],
    ["Version", L.version],
    ["Variant", variant],
    ["Generated", generatedAt.toISOString()],
    ["Slots", `${L.sheet}!${columnLetter(L.slotColumns[0])}${L.rows[0]}:${columnLetter(L.slotColumns.at(-1)!)}${L.rows.at(-1)}`],
  ]
  identity.forEach(([k, v], i) => (id.getRow(i + 1).values = [k, v]))

  return Buffer.from(await wb.xlsx.writeBuffer())
}
