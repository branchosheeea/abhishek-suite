// Digital Docking: load a past docking from its daily emails, to see the module with real data.
//
//   pnpm docking:history <folder> [--data <docking data folder>]
//
// <folder> holds one sub-folder per email (day00 … day15, final), each with the vessel's "Work Done" workbook as
// attached and top.txt (the new text of the Superintendent's email), plus summary.json (sender and sent time per
// email), as written by the Outlook extraction used in Stage 0. Nothing is sent anywhere; the records go into the
// docking store on this PC (default: the one NeraVeda uses), through the same repository code as the screens.
// Real vessel data never goes into the source repository.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { readWorkDoneWorkbook, LEGACY_TEMPLATE, LEGACY_VERSION } from "../lib/docking/legacy/workdone"
import { closeStore, dataRoot, openStore } from "../lib/docking/server/db"
import { addAnnotation, createDocking, dayNumber, declareNoReport, getDocking, importSubmission, listDockings, type DockingInput } from "../lib/docking/server/repo"

// The DHT Leopard 2nd special survey, from the header block of its daily emails.
const DOCKING: DockingInput = {
  code: "LEO-2025-SS2",
  vesselName: "DHT LEOPARD",
  yard: "CIMC Changhong Shipyard, Changtu Island Base",
  location: "Zhoushan, China",
  dockingType: "Special survey",
  utcOffsetMinutes: 8 * 60,
  day0Date: "2025-10-13",
  arrivalTime: "21:00",
  plannedDepartureDate: "2025-10-29",
  status: "completed",
}

type Sent = { tag: string; sender: string; sent: string }

function localTime(iso: string, offsetMinutes: number): string {
  const t = new Date(Date.parse(iso.replace(" ", "T")) + offsetMinutes * 60_000)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${String(t.getUTCHours()).padStart(2, "0")}${String(t.getUTCMinutes()).padStart(2, "0")} LT`
}

async function main() {
  const args = process.argv.slice(2)
  const folder = args[0]
  const dataAt = args.indexOf("--data")
  const root = dataAt >= 0 ? args[dataAt + 1] : dataRoot()
  if (!folder || !existsSync(join(folder, "summary.json"))) {
    console.error("Usage: pnpm docking:history <folder with day00 … final and summary.json> [--data <docking data folder>]")
    process.exit(2)
  }
  const sent = new Map((JSON.parse(readFileSync(join(folder, "summary.json"), "utf-8")) as Sent[]).map((s) => [s.tag, s]))
  const importer = `history-import:${userInfo().username}`
  const store = await openStore(root)
  try {
    if (listDockings(store).some((d) => d.code === DOCKING.code)) {
      console.log(`${DOCKING.code} is already in ${root}; nothing was changed.`)
      return
    }
    const docking = createDocking(store, DOCKING, importer)
    console.log(`Created ${docking.code} (${docking.vessel_name}) in ${root}`)

    const tags = readdirSync(folder).filter((t) => /^day\d+$/.test(t) || t === "final").sort((a, b) => (a === "final" ? 1 : b === "final" ? -1 : a.localeCompare(b)))
    let photos = 0
    for (const tag of tags) {
      const dir = join(folder, tag)
      const workbookName = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".xlsx"))
      let reportDate: string
      if (workbookName) {
        const data = readFileSync(join(dir, workbookName))
        const book = await readWorkDoneWorkbook(data)
        reportDate = book.reportDate ?? ""
        if (!reportDate) throw new Error(`${tag}: no report date on the sheets`)
        const fileName = workbookName.replace(/^\d{2}_/, "")
        for (const department of ["deck", "engine"] as const) {
          const part = book[department]
          if (!part.activities.length && !part.photos.length) continue
          importSubmission(store, {
            dockingId: docking.id, reportDate, department, file: { data, name: fileName }, template: LEGACY_TEMPLATE, templateVersion: LEGACY_VERSION,
            receivedVia: "email", activities: part.activities, photos: part.photos, combined: true,
            validation: { format: "Vessel work-done workbook (before the NeraVeda template)", warnings: book.warnings, sheets: book.sheets.filter((s) => s.department === department) },
          }, importer)
          photos += part.photos.filter((p) => p.status === "linked").length
        }
        console.log(`  Day ${dayNumber(DOCKING.day0Date, reportDate)} (${reportDate}): deck ${book.deck.activities.length} entries, engine ${book.engine.activities.length} entries, ` +
          `${book.deck.photos.length + book.engine.photos.length} photos${book.warnings.length ? ` — ${book.warnings.join(" ")}` : ""}`)
      } else {
        const n = Number(/^day(\d+)$/.exec(tag)?.[1] ?? NaN)
        if (!Number.isInteger(n)) throw new Error(`${tag}: no workbook and no day number`)
        reportDate = new Date(Date.parse(`${DOCKING.day0Date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
        declareNoReport(store, docking.id, reportDate, n === 0 ? "Arrival day: the vessel sent no work-done workbook." : "The vessel sent no work-done workbook.", importer)
        console.log(`  Day ${n} (${reportDate}): no workbook — recorded as "no report"`)
      }

      const top = join(dir, "top.txt")
      const email = sent.get(tag)
      if (existsSync(top) && email) {
        const day = store.db.prepare("SELECT id FROM days WHERE docking_id = ? AND report_date = ?").get(docking.id, reportDate) as { id: string }
        const body = `Daily report sent to owners, ${localTime(email.sent, DOCKING.utcOffsetMinutes)} (from the email)\n\n${readFileSync(top, "utf-8").replace(/\r\n/g, "\n").trim()}`
        addAnnotation(store, { dockingId: docking.id, entity: "day", entityId: day.id, kind: "comment", body }, email.sender || importer)
      }
    }
    const d = getDocking(store, docking.id)
    console.log(`Done: ${tags.length} emails, ${photos} photos. Open Digital Docking → ${d.vessel_name} · ${d.code}.`)
  } finally {
    closeStore(store)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
