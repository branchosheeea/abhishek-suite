// Test helpers: small synthetic Vessel Master workbooks with the real layout (six sheets, the real column headers),
// built in memory. Invented vessels and values only; the real workbook is never a fixture.

import ExcelJS from "exceljs"
import { FIELDS, IDENTITY_COLUMNS, STATUS_COLUMNS } from "../lib/vessel-master/fields"
import type { ImportRecord, MasterStore, MasterTx, Revision, StoredVessel } from "../lib/vessel-master/import"

export const MASTER_HEADER = [...IDENTITY_COLUMNS, ...FIELDS.map((f) => f.column), ...Object.values(STATUS_COLUMNS), "Primary Source Note"]

type Values = Record<string, string | number | null>
export type TestVessel = { values: Values; orange?: string[]; fill?: Record<string, string> }

/** A complete, valid vessel (invented): every column filled, all groups VERIFIED. */
export function vessel(id: string, name: string, imo: string, over: Values = {}): Values {
  return {
    "Vessel ID": id, "Vessel Name": name, "Fleet Group": "Test Fleet", "Active Status": "ACTIVE", "IMO Number": imo,
    Flag: "Testland", "Port of Registry": "Test Port", "Official Number": "1234", "Call Sign": "TEST1", "Vessel Type": "Oil Tanker",
    "Year Built": 2020, "Builder / Yard": "Test Yard", "Hull Number": "T-1", "Classification Society": "XYZ", "Class Notation": "+A1",
    "Registered Owner": "Owner Inc.", "Technical Manager": "Manager Pte", "ISM Company": "Manager Pte",
    "LOA (m)": 330, "Breadth Moulded (m)": 60, "Depth Moulded (m)": 30, "Summer Draft (m)": 22.5,
    "Verified Summer DWT (MT)": 300000.5, "DHT Website DWT (MT)": 300001, "Lightweight (MT)": 40000, "Gross Tonnage": 160000, "Net Tonnage": 110000,
    "Main Engine Make / Model": "Test Engine 6X", "MCR (kW)": 20000, "MCR (rpm)": 60, "NCR/CSR (kW)": 17000, "NCR/CSR (rpm)": 57,
    "Statutory Propelling Power (kW)": 19000, "Service Speed Laden (kn)": 14.5, "Service Speed Ballast (kn)": 15.5,
    "Guaranteed Fuel Consumption Laden (MT/day)": 55, "Associated Laden Speed (kn)": 14.5, "Guaranteed Fuel Consumption Ballast (MT/day)": 50,
    "Associated Ballast Speed (kn)": 15.5, "Fuel Grade / Reference Basis": "HFO, LCV 40.6 MJ/kg", "ME System Oil Consumption": "40 L/day",
    "ME Cylinder Oil Consumption": "400 L/day", "DG Lube Oil Consumption": "1 L/day",
    "Registry Status": "VERIFIED", "Technical Status": "VERIFIED", "Performance Status": "VERIFIED", "Primary Source Note": "Test note",
    ...over,
  }
}

/** A source covering every field group of the vessel (VERIFIED), so group VERIFIED + source VERIFIED -> VERIFIED. */
export const fullSources = (id: string, status = "VERIFIED"): Values[] => [
  "Identity, registry, owner, GT/NT, statutory power", "ISM company", "Hull, dimensions, DWT, GT/NT, lightweight, class notation",
  "Identity, owner, hull, year, statutory power, ITC dimensions and tonnage", "Principal dimensions, DWT, class and notation",
  "Current registry, dimensions, tonnage, engine and rating", "Identity, dimensions, tonnage, engine/rating, class", "Speed, fuel and lube reference",
  "IMO number",
].map((group, i) => ({ "Source ID": `SRC-${id}-${i}`, "Vessel ID": id, "Vessel Name": id, "Field / Field Group": group, "Source Type": "Certificate",
  "Source Document": `${id}-${i}.pdf`, "Authority Level": "Statutory", "Verification Status": status }))

export async function workbook(input: {
  vessels: TestVessel[]
  sources?: Values[]
  issues?: Values[]
  physical?: Values[]
  readme?: [string, string][]
  omitSheet?: string
  omitColumn?: string
}): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = (name: string, header: string[], rows: Values[]) => {
    if (input.omitSheet === name) return null
    const ws = book.addWorksheet(name)
    ws.addRow(header.filter((h) => h !== input.omitColumn))
    for (const r of rows) ws.addRow(header.filter((h) => h !== input.omitColumn).map((h) => r[h] ?? null))
    return ws
  }
  const master = sheet("Vessel_Master", MASTER_HEADER, input.vessels.map((v) => v.values))
  input.vessels.forEach((v, i) => {
    for (const [column, argb] of [...(v.orange ?? []).map((c) => [c, "FFF4B183"] as const), ...Object.entries(v.fill ?? {})]) {
      const col = MASTER_HEADER.filter((h) => h !== input.omitColumn).indexOf(column) + 1
      master!.getRow(i + 2).getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb } }
    }
  })
  sheet("Source_Register", ["Source ID", "Vessel ID", "Vessel Name", "Field / Field Group", "Source Type", "Source Document", "Authority Level", "Verification Status", "Source Date"], input.sources ?? [])
  sheet("Data_Quality", ["Issue ID", "Vessel ID", "Vessel Name", "Field", "Issue Type", "Current Working Value", "Disposition for SIR Autofill", "Required Verification Source", "Status", "Notes"], input.issues ?? [])
  sheet("Field_Definitions", ["Field Key", "Visible SIR Label", "Autofill Rule"], FIELDS.map((f) => ({ "Field Key": f.key, "Visible SIR Label": f.label, "Autofill Rule": f.autofill })))
  if (input.omitSheet !== "README") {
    const readme = book.addWorksheet("README")
    readme.addRow(["Test workbook"])
    for (const [item, text] of input.readme ?? []) readme.addRow([item, text])
  }
  sheet("Physical_Verification", ["Priority", "Vessel ID", "Vessel Name", "Field(s)", "Release rule", "Status"], input.physical ?? [])
  return Buffer.from(await book.xlsx.writeBuffer())
}

// ── An in-memory master store with the database's rules: unique vessel id / workbook id / IMO / revision, revision-
//    checked replace, and transactions that apply all or nothing (a conflicting concurrent commit fails).

export function memoryStore() {
  let state = { vessels: [] as StoredVessel[], revisions: [] as Revision[], imports: [] as ImportRecord[], refs: new Map<string, unknown>(), version: 0 }
  const clone = <T>(v: T): T => structuredClone(v)
  let failNextAfterWrites: number | null = null
  const store: MasterStore & { state: () => typeof state; failAfter: (writes: number) => void } = {
    listVessels: async () => clone(state.vessels),
    state: () => state,
    failAfter: (writes) => void (failNextAfterWrites = writes),
    async transaction(fn) {
      const work = { ...clone({ vessels: state.vessels, revisions: state.revisions, imports: state.imports }), refs: new Map(state.refs), version: state.version }
      const startedAt = state.version
      let writes = 0
      const wrote = () => {
        writes++
        if (failNextAfterWrites !== null && writes > failNextAfterWrites) {
          failNextAfterWrites = null
          throw new Error("simulated failure part-way through the import")
        }
      }
      const unique = (doc: StoredVessel, except?: string) => {
        for (const v of work.vessels) {
          if (v.vesselId === except) continue
          if (v.vesselId === doc.vesselId || (doc.workbookId && v.workbookId === doc.workbookId) || (doc.imo && v.imo === doc.imo)) {
            throw new Error(`duplicate key: ${doc.name}`)
          }
        }
      }
      const tx: MasterTx = {
        listVessels: async () => clone(work.vessels),
        insertVessel: async (doc) => { wrote(); unique(doc); work.vessels.push(clone(doc)) },
        replaceVessel: async (doc, expected) => {
          wrote()
          const i = work.vessels.findIndex((v) => v.vesselId === doc.vesselId && v.revision === expected)
          if (i < 0) return false
          unique(doc, doc.vesselId)
          work.vessels[i] = clone(doc)
          return true
        },
        insertRevision: async (r) => {
          wrote()
          if (work.revisions.some((x) => x.vesselId === r.vesselId && x.revision === r.revision)) throw new Error("duplicate revision")
          work.revisions.push(clone(r))
        },
        upsertReference: async (collection, key, doc) => { wrote(); work.refs.set(`${collection}|${key}`, clone(doc)) },
        insertImport: async (record) => { wrote(); work.imports.push(clone(record)) },
      }
      const result = await fn(tx)
      // Commit: refused if another transaction committed meanwhile (as MongoDB aborts on a write conflict).
      if (state.version !== startedAt) throw new Error("write conflict: another import committed first")
      state = { vessels: work.vessels, revisions: work.revisions, imports: work.imports, refs: work.refs, version: startedAt + 1 }
      return result
    },
  }
  return store
}
