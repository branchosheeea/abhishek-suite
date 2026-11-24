// Vessel Master admin command (lib/vessel-master/*). The only way master data is imported; the web app only reads it.
//
//   npm run vessel-master -- check  [--file <xlsx>] [--out <preview.json>]     read-only: what an import would do
//   npm run vessel-master -- import --approve <preview hash> [--file <xlsx>] [--override-verified "<reason>"] [--by <name>]
//   npm run vessel-master -- list
//   npm run vessel-master -- show <name | workbook ID | IMO>
//   npm run vessel-master -- flags [<name | workbook ID | IMO>]
//
// `import` takes a backup of the inspections database first, then writes in one transaction, and only if the preview
// hash still matches (the workbook and the master are what you reviewed). The workbook itself is never modified.
// Uses MONGODB_URI and optional SIR_DNS_SERVERS (from the environment or .env.local).

import { readFileSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { MongoClient, type Db } from "mongodb"
import { backupDatabase, backupRoot } from "../lib/server/mongo-backup"
import { applyDnsOverride } from "../lib/server/dns-override"
import { FIELD } from "../lib/vessel-master/fields"
import { commitImport, planImport, type ImportPlan, type StoredVessel } from "../lib/vessel-master/import"
import { ensureVesselIndexes, flagsOf, listVessels, mongoMasterStore, requireTransactions } from "../lib/vessel-master/repo"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { FLEET_VESSELS } from "../lib/vessels"

const LIVE = "inspections"
const DEFAULT_FILE = join(import.meta.dirname, "..", "Vessel Particular", "SIR_Vessel_Master_DHT_23_Technical_File_Review 3.xlsx")
const [command = "", ...rest] = process.argv.slice(2)

function option(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = rest[i + 1]
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`)
  return value
}
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")))

async function withDb<T>(fn: (client: MongoClient, db: Db) => Promise<T>): Promise<T> {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is not set (environment or .env.local).")
  applyDnsOverride() // SIR_DNS_SERVERS, before the driver resolves mongodb+srv records
  const client = await new MongoClient(uri, { appName: "sir-vessel-master" }).connect()
  try {
    return await fn(client, client.db(LIVE))
  } finally {
    await client.close()
  }
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v))

function printPlan(plan: ImportPlan) {
  const c = plan.counts
  console.log(`Workbook   ${plan.fileName}`)
  console.log(`SHA-256    ${plan.sha256}`)
  console.log(`Preview    ${plan.previewHash}   (import with: --approve ${plan.previewHash})`)
  if (plan.problems.length) {
    console.log("\nSTRUCTURAL PROBLEMS (nothing can be imported):")
    for (const p of plan.problems) console.log(`  - ${p}`)
    return
  }
  console.log(`\nVessels    create ${c.create} · update ${c.update} · unchanged ${c.unchanged} · rejected ${c.rejected}`)
  console.log(`Fields     VERIFIED ${c.fields.VERIFIED} · PROVISIONAL ${c.fields.PROVISIONAL} · CONFLICT ${c.fields.CONFLICT} · MISSING ${c.fields.MISSING}`)
  console.log(`In the SIR filled ${c.release.fill} · offered ${c.release.offer} · withheld ${c.release.withhold} · master only ${c.release["master-only"]}`)
  console.log(`Physical verification required ${c.physicalVerification} · VERIFIED values the workbook would change ${c.verifiedOverwrites}`)

  if (plan.rejected.length) {
    console.log("\nREJECTED ROWS (not imported):")
    for (const r of plan.rejected) console.log(`  - ${show(r.workbookId)}${r.row ? ` (row ${r.row})` : ""}: ${r.reasons.join("; ")}`)
  }
  if (plan.exceptions.length) {
    console.log("\nREVIEW EXCEPTIONS:")
    for (const e of plan.exceptions) console.log(`  - ${e.workbookId ? `${e.workbookId}: ` : ""}${e.text}`)
  }

  for (const v of plan.vessels) {
    const fields = Object.entries(v.draft.fields)
    const by = (pred: (f: (typeof fields)[number][1]) => boolean) => fields.filter(([, f]) => pred(f))
    console.log(`\n── ${v.name} · ${show(v.workbookId)} · IMO ${show(v.draft.imo)} · ${show(v.draft.fleetGroup)} · ${show(v.draft.activeStatus)}`)
    console.log(`   ${v.action.toUpperCase()} (match: ${v.match})${v.draft.performanceBasis ? ` · performance basis ${v.draft.performanceBasis}` : ""}`)
    console.log(`   NeraVeda link: ${v.draft.legacyKeys.length ? v.draft.legacyKeys.join(", ") : "none (new to NeraVeda)"} · aliases ${v.draft.aliases.join(" / ")}`)
    if (!v.draft.workbookId) continue
    const counts = (["VERIFIED", "PROVISIONAL", "CONFLICT", "MISSING"] as const).map((s) => `${s} ${by((f) => f.status === s).length}`).join(" · ")
    console.log(`   ${counts}`)
    const withheld = by((f) => f.release === "withhold" && f.value !== null)
    if (withheld.length) {
      console.log("   Withheld from the SIR (value present, not released):")
      for (const [k, f] of withheld) console.log(`     ${FIELD[k].label}: ${show(f.value)}${f.unit ? ` ${f.unit}` : ""} [${f.status}${f.physicalVerification ? ", physical verification" : ""}] ${f.reasons.join("; ")}`)
    }
    const offered = by((f) => f.release === "offer")
    if (offered.length) console.log(`   Offered (Superintendent confirms): ${offered.map(([k]) => FIELD[k].label).join(", ")}`)
    for (const ch of v.changes.filter((x) => v.action === "update")) {
      console.log(`   ${ch.kind.padEnd(6)} ${FIELD[ch.field].label}: ${show(ch.before?.value)} [${show(ch.before?.status)}] → ${show(ch.after.value)} [${ch.after.status}]${ch.verifiedOverwrite ? "   ← replaces a VERIFIED value (needs --override-verified)" : ""}`)
    }
  }
}

function find(vessels: StoredVessel[], query: string) {
  const q = query.trim().toLowerCase()
  return vessels.find((v) => v.workbookId?.toLowerCase() === q || v.imo === q || v.name.toLowerCase() === q || v.aliases.some((a) => a.toLowerCase() === q))
}

async function main() {
  const file = option("file") ?? DEFAULT_FILE
  if (command === "check") {
    const book = await readWorkbook(readFileSync(file))
    const plan = await withDb(async (client, db) => planImport(book, file, await mongoMasterStore(client, db).listVessels(), FLEET_VESSELS))
    printPlan(plan)
    const out = option("out")
    if (out) {
      writeFileSync(out, JSON.stringify(plan, null, 2))
      console.log(`\nFull preview written: ${out}`)
    }
  } else if (command === "import") {
    const approve = option("approve")
    if (!approve) throw new Error("Give the preview hash you reviewed: import --approve <hash> (run check first).")
    const reason = option("override-verified")
    const by = option("by") ?? userInfo().username
    const book = await readWorkbook(readFileSync(file))
    await withDb(async (client, db) => {
      const store = mongoMasterStore(client, db)
      const plan = planImport(book, file, await store.listVessels(), FLEET_VESSELS)
      if (plan.previewHash !== approve) throw new Error(`The preview is now ${plan.previewHash}, not ${approve}: the workbook or the master changed. Run check again.`)
      await requireTransactions(db)
      await ensureVesselIndexes(db)
      const folder = await backupDatabase(
        {
          collections: async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")),
          documents: (name) => db.collection(name).find({}).sort({ _id: 1 }),
        },
        { dest: backupRoot(LIVE), database: LIVE },
      )
      console.log(`Backup before import: ${folder}`)
      const record = await commitImport(store, book, file, FLEET_VESSELS, { approve, by, overrideVerified: reason ? { reason } : undefined })
      console.log(`${record.outcome === "committed" ? "Imported" : "Nothing to change"}: create ${record.counts.create} · update ${record.counts.update} · unchanged ${record.counts.unchanged} · rejected ${record.counts.rejected}`)
      if (record.skippedVerified.length) {
        console.log("VERIFIED values kept (the workbook differs; use --override-verified \"<reason>\" to replace them):")
        for (const s of record.skippedVerified) console.log(`  - ${show(s.workbookId)} ${FIELD[s.field].label}`)
      }
    })
  } else if (command === "list") {
    await withDb(async (_client, db) => {
      const vessels = await listVessels(db)
      if (!vessels.length) console.log("The Vessel Master is empty (no import yet).")
      for (const v of vessels) console.log(`${v.name.padEnd(18)} ${show(v.workbookId).padEnd(6)} IMO ${show(v.imo).padEnd(8)} ${show(v.fleetGroup).padEnd(16)} ${show(v.activeStatus).padEnd(14)} rev ${v.revision}`)
    })
  } else if (command === "show" && positional.length === 1) {
    await withDb(async (_client, db) => {
      const v = find(await listVessels(db), positional[0])
      if (!v) throw new Error(`No vessel "${positional[0]}" in the master.`)
      console.log(`${v.name} · ${show(v.workbookId)} · IMO ${show(v.imo)} · ${show(v.fleetGroup)} · ${show(v.activeStatus)} · revision ${v.revision} (${v.updatedAt} by ${v.updatedBy})`)
      for (const [k, f] of Object.entries(v.fields)) {
        console.log(`  ${FIELD[k].label.padEnd(34)} ${`${show(f.value)}${f.unit && f.value !== null ? ` ${f.unit}` : ""}`.padEnd(30)} ${f.status.padEnd(11)} ${f.release.padEnd(11)}${f.physicalVerification ? " physical" : ""}${f.reasons.length ? `  ${f.reasons.join("; ")}` : ""}`)
      }
    })
  } else if (command === "flags") {
    await withDb(async (_client, db) => {
      const v = positional[0] ? find(await listVessels(db), positional[0]) : undefined
      if (positional[0] && !v) throw new Error(`No vessel "${positional[0]}" in the master.`)
      const flags = await flagsOf(db, v?.vesselId)
      if (!flags.length) console.log("No master data issues reported.")
      for (const f of flags) console.log(`${f.at} ${f.status.padEnd(8)} ${f.vesselName} · ${f.field}: "${f.currentValue}" → "${f.proposedValue}" (${f.reason}; ${f.source}) by ${f.reporterName}`)
    })
  } else {
    console.log("Usage: npm run vessel-master -- check | import --approve <hash> | list | show <vessel> | flags [<vessel>]  (see scripts/vessel-master.ts)")
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
