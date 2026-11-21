// Digital Docking · Stage 1A: where the photo slots are in an issued workbook. The analyser never guesses a layout:
// it reads the template id from the hidden _ID sheet and uses the layout registered for that id and version.

export type SlotLayout = Readonly<{
  template: string
  version: number
  /** The work sheet that holds activity rows and photo slots. */
  sheet: string
  /** 1-based worksheet rows that are activity rows. */
  rows: readonly number[]
  /** 1-based column of the row reference (e.g. DK001). */
  refColumn: number
  /** 1-based columns of Photo 1…Photo n, in order. */
  slotColumns: readonly number[]
}>

export const PHOTO_TEST_TEMPLATE = "DD-PHOTO-TEST"

export const PHOTO_TEST_LAYOUT: SlotLayout = {
  template: PHOTO_TEST_TEMPLATE,
  version: 1,
  sheet: "Deck Work",
  rows: [6, 7, 8],
  refColumn: 1,
  slotColumns: [3, 4, 5, 6],
}

const LAYOUTS: readonly SlotLayout[] = [PHOTO_TEST_LAYOUT]

export function layoutFor(template: string, version: number): SlotLayout | undefined {
  return LAYOUTS.find((l) => l.template === template && l.version === version)
}

export function columnLetter(column: number): string {
  let n = column
  let out = ""
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function parseCellRef(ref: string): { column: number; row: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i.exec(ref.trim())
  if (!m) return null
  let column = 0
  for (const ch of m[1].toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64)
  return { column, row: Number(m[2]) }
}
