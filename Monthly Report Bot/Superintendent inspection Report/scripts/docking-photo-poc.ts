// Digital Docking · Stage 1A photo proof of concept.
//   pnpm docking:photos make  [folder]        write the unprotected and protected test workbooks
//   pnpm docking:photos check <file|folder>…  report every picture: linked to row + slot, or rejected and why
// The default folder is "Dry Docking Module/Photo Test" (ignored by Git): test files will hold real photos.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { analyzeWorkbook, type Analysis } from "../lib/docking/photos/analyze"
import { WorkbookRejected } from "../lib/docking/photos/package"
import { buildPhotoTestWorkbook } from "../lib/docking/photos/template"

const APP_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const DEFAULT_FOLDER = resolve(APP_DIR, "..", "Dry Docking Module", "Photo Test")
/** D6: both department files share 8 MB per email, so each file should stay near 4 MB on a busy day. */
const BUSY_DAY_PHOTOS = 150
const FILE_BUDGET_MB = 4

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

async function make(folder: string) {
  mkdirSync(folder, { recursive: true })
  for (const variant of ["unprotected", "protected"] as const) {
    const path = join(folder, `NeraVeda Photo Test - ${variant === "protected" ? "Protected" : "Unprotected"}.xlsx`)
    writeFileSync(path, await buildPhotoTestWorkbook(variant), { flag: "wx" })
    console.log(`Written: ${path}`)
  }
}

function report(file: string, a: Analysis) {
  const linked = a.pictures.filter((p) => p.status === "linked")
  const rejected = a.pictures.filter((p) => p.status === "rejected")
  console.log(`\n=== ${basename(file)} · ${a.variant || "?"} · ${mb(a.bytes)} · sha256 ${a.sha256.slice(0, 12)}…`)
  console.log(`    ${a.pictures.length} pictures: ${linked.length} linked, ${rejected.length} rejected`)
  for (const p of a.pictures) {
    const size = p.width && p.height ? `${p.width}×${p.height}` : "size ?"
    const where = p.status === "linked" ? `${p.rowRef || `row ${p.row}`} Photo ${p.slot}` : `${p.sheet}!${p.cell}`
    console.log(`    ${p.status === "linked" ? "LINKED  " : "REJECTED"} ${where.padEnd(18)} ${p.method.padEnd(10)} ${p.anchor.padEnd(9)} ${size.padEnd(11)} ${kb(p.bytes).padStart(7)}${p.reason ? `  — ${p.reason}` : ""}`)
  }
  for (const w of a.warnings) console.log(`    NOTE: ${w}`)
  if (linked.length) {
    const avg = linked.reduce((s, p) => s + p.bytes, 0) / linked.length
    const projected = avg * BUSY_DAY_PHOTOS
    console.log(`    Photo size: average ${kb(avg)} → about ${mb(projected)} of photos for a busy department-day (${BUSY_DAY_PHOTOS} photos); budget ${FILE_BUDGET_MB} MB per file: ${projected <= FILE_BUDGET_MB * 1048576 ? "within" : "OVER"}`)
  }
}

function workbooks(target: string): string[] {
  if (statSync(target).isDirectory()) return readdirSync(target).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith("~$")).map((n) => join(target, n))
  return [target]
}

async function check(targets: string[]) {
  let failures = 0
  for (const file of (targets.length ? targets : [DEFAULT_FOLDER]).flatMap(workbooks)) {
    try {
      report(file, await analyzeWorkbook(readFileSync(file)))
    } catch (error) {
      failures++
      console.log(`\n=== ${basename(file)}\n    NOT ACCEPTED — ${error instanceof WorkbookRejected ? error.message : `unexpected error: ${(error as Error).message}`}`)
    }
  }
  return failures
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === "make") await make(args[0] ? resolve(args[0]) : DEFAULT_FOLDER)
  else if (command === "check") process.exitCode = (await check(args.map((a) => resolve(a)))) ? 1 : 0
  else {
    console.log("Usage: pnpm docking:photos make [folder] | check <file.xlsx|folder>…")
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
