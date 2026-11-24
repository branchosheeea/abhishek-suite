// Vessel Master rules (lib/vessel-master/rules.ts): workbook structure, identity checks, and how each field's status and
// release are decided. Synthetic workbooks only; a read-only structure check of the real workbook runs when it is present.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { buildMaster, dispositionEffect, parseValue, validImo } from "../lib/vessel-master/rules"
import { FIELD } from "../lib/vessel-master/fields"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { FLEET_VESSELS } from "../lib/vessels"
import { fullSources, vessel, workbook } from "./vessel-master.helpers"

/** A valid IMO number from six digits (adds the check digit). */
const imo = (six: string) => six + String([...six].reduce((n, d, i) => n + Number(d) * (7 - i), 0) % 10)
const A = imo("900001"), B = imo("900002"), C = imo("900003")

async function build(input: Parameters<typeof workbook>[0], legacy: readonly string[] = []) {
  return buildMaster(await readWorkbook(await workbook(input)), legacy)
}
const field = (r: Awaited<ReturnType<typeof build>>, id: string, key: string) => r.vessels.find((v) => v.workbookId === id)!.fields[key]

describe("workbook structure and identity", () => {
  test("a missing sheet or column stops the import", async () => {
    assert.ok((await readWorkbook(await workbook({ vessels: [{ values: vessel("TA", "TEST A", A) }], omitSheet: "Data_Quality" }))).problems.some((p) => /Data_Quality/.test(p)))
    assert.ok((await readWorkbook(await workbook({ vessels: [{ values: vessel("TA", "TEST A", A) }], omitColumn: "Call Sign" }))).problems.some((p) => /Call Sign/.test(p)))
    assert.ok((await readWorkbook(Buffer.from("not a workbook"))).problems.length)
  })

  test("IMO numbers are checked and duplicates rejected; good rows still import", async () => {
    assert.equal(validImo(A), true)
    assert.equal(validImo("1234567"), true)
    assert.equal(validImo("1234568"), false)
    assert.equal(validImo("123456"), false)
    const r = await build({ vessels: [
      { values: vessel("TA", "TEST A", A) },
      { values: vessel("TB", "TEST B", A) },          // duplicate IMO
      { values: vessel("TA", "TEST A2", B) },         // duplicate Vessel ID
      { values: vessel("TD", "TEST D", "1234568") },  // bad check digit (1234567 would be valid)
      { values: vessel("TE", "TEST E", C) },
    ] })
    assert.deepEqual(r.vessels.map((v) => v.workbookId), ["TE"])
    assert.equal(r.rejected.length, 4)
    assert.ok(r.rejected.some((x) => x.reasons.some((m) => /appears more than once/.test(m))))
    assert.ok(r.rejected.some((x) => x.reasons.some((m) => /not a valid IMO/.test(m))))
  })

  test("existing NeraVeda vessels are linked by name once and kept when the workbook does not list them", async () => {
    const r = await build({ vessels: [{ values: vessel("TA", "Test Alpha", A) }], readme: [["Scope", "Test Omega is excluded as future delivery."]] },
      ["TEST ALPHA", "TEST OMEGA", "TEST GAMMA"])
    const alpha = r.vessels.find((v) => v.workbookId === "TA")!
    assert.equal(alpha.name, "TEST ALPHA")
    assert.deepEqual(alpha.legacyKeys, ["TEST_ALPHA"])
    assert.deepEqual(alpha.aliases, ["Test Alpha", "TEST ALPHA"])
    const omega = r.vessels.find((v) => v.name === "TEST OMEGA")!
    assert.equal(omega.activeStatus, "NOT DELIVERED")
    assert.equal(r.vessels.find((v) => v.name === "TEST GAMMA")!.activeStatus, "UNCONFIRMED")
    assert.equal(omega.fields.flag.value, null, "no value is invented for a vessel the workbook does not list")
  })
})

describe("field status and release", () => {
  test("VERIFIED needs both the group status and a VERIFIED source for that field", async () => {
    const verified = await build({ vessels: [{ values: vessel("TA", "TEST A", A) }], sources: fullSources("TA") })
    assert.equal(field(verified, "TA", "flag").status, "VERIFIED")
    assert.equal(field(verified, "TA", "flag").release, "fill")
    const groupOnly = await build({ vessels: [{ values: vessel("TA", "TEST A", A) }] })
    assert.equal(field(groupOnly, "TA", "flag").status, "PROVISIONAL", "group-level VERIFIED alone never verifies a field")
    assert.match(field(groupOnly, "TA", "flag").reasons.join(" "), /no VERIFIED source/)
    const provisionalSource = await build({ vessels: [{ values: vessel("TA", "TEST A", A) }], sources: fullSources("TA", "PROVISIONAL") })
    assert.equal(field(provisionalSource, "TA", "flag").status, "PROVISIONAL")
  })

  test("a PROVISIONAL value is filled when the field allows it, and only offered for 'VERIFIED only' fields", async () => {
    const r = await build({ vessels: [{ values: vessel("TA", "TEST A", A, { "Registry Status": "PROVISIONAL", "Technical Status": "PROVISIONAL" }) }] })
    assert.equal(FIELD.flag.autofill, "VERIFIED_ONLY")
    assert.equal(field(r, "TA", "flag").release, "offer")
    assert.equal(FIELD.year_built.autofill, "VERIFIED_OR_PROVISIONAL")
    assert.equal(field(r, "TA", "year_built").release, "fill")
    assert.equal(field(r, "TA", "statutory_power_kw").release, "master-only")
    assert.equal(field(r, "TA", "public_dwt_mt").release, "master-only")
  })

  test("a blank stays blank (MISSING, null), never zero", async () => {
    const r = await build({ vessels: [{ values: vessel("TA", "TEST A", A, { "Guaranteed Fuel Consumption Ballast (MT/day)": null, "Summer Draft (m)": null }) }] })
    for (const key of ["fuel_ballast_mt_day", "summer_draft_m"]) {
      assert.equal(field(r, "TA", key).value, null)
      assert.equal(field(r, "TA", key).status, "MISSING")
      assert.equal(field(r, "TA", key).release, "withhold")
    }
  })

  test("numbers written as text are parsed with the original kept; non-numbers are refused, not guessed", () => {
    assert.deepEqual(parseValue("336.0", FIELD.loa_m), { value: 336, raw: "336.0" })
    assert.deepEqual(parseValue(329.01, FIELD.loa_m), { value: 329.01 })
    assert.ok(parseValue("about 330", FIELD.loa_m).error)
    assert.ok(parseValue(2020.5, FIELD.year_built).error)
    assert.deepEqual(parseValue("1.52 g/kWh; 446 L/day", FIELD.me_cylinder_oil), { value: "1.52 g/kWh; 446 L/day" }, "lube-oil text is kept as text")
  })

  test("Data_Quality dispositions: BLOCK withholds, PROVISIONAL ONLY caps, ALLOW does not restrict, resolved items do not restrict", async () => {
    assert.equal(dispositionEffect("BLOCK"), "block")
    assert.equal(dispositionEffect("BLOCK REGISTRY AUTOFILL"), "block")
    assert.equal(dispositionEffect("ORANGE / BLOCK VERIFIED STATUS"), "cap")
    assert.equal(dispositionEffect("ORANGE / PHYSICAL VERIFY"), "block")
    assert.equal(dispositionEffect("SHOW AS PROVISIONAL ONLY"), "cap")
    assert.equal(dispositionEffect("ALLOW SEPARATE FIELDS"), "allow")
    const r = await build({
      vessels: [{ values: vessel("TA", "TEST A", A) }, { values: vessel("TB", "TEST B", B) }],
      sources: [...fullSources("TA"), ...fullSources("TB")],
      issues: [
        { "Issue ID": "DQ-X1", "Vessel ID": "TA", Field: "Hull Number", "Issue Type": "CONFLICT", "Disposition for SIR Autofill": "BLOCK", Status: "OPEN" },
        { "Issue ID": "DQ-X2", "Vessel ID": "TB", Field: "Detailed fields", "Issue Type": "PARTIAL", "Disposition for SIR Autofill": "PROVISIONAL ONLY", Status: "OPEN" },
        { "Issue ID": "DQ-X3", "Vessel ID": "TA", Field: "Flag", "Issue Type": "CONFLICT", "Disposition for SIR Autofill": "BLOCK", Status: "RESOLVED" },
      ],
    })
    assert.equal(field(r, "TA", "hull_number").status, "CONFLICT")
    assert.equal(field(r, "TA", "hull_number").release, "withhold")
    assert.deepEqual(field(r, "TA", "hull_number").issueIds, ["DQ-X1"])
    assert.equal(field(r, "TA", "flag").status, "VERIFIED", "a resolved item does not restrict")
    assert.equal(field(r, "TB", "flag").status, "PROVISIONAL", "an unmapped vessel-wide item caps every field")
    assert.ok(r.exceptions.some((e) => /DQ-X2 is not in the reviewed table/.test(e.text)))
  })

  test("an orange cell needs physical verification: kept, flagged, PROVISIONAL at most and withheld", async () => {
    const r = await build({
      vessels: [{ values: vessel("TA", "TEST A", A), orange: ["MCR (kW)"] }], sources: fullSources("TA"),
      physical: [{ "Vessel ID": "TA", "Field(s)": "MCR", "Release rule": "Only release after the EIAPP is checked.", Status: "OPEN" }],
    })
    const mcr = field(r, "TA", "mcr_kw")
    assert.equal(mcr.value, 20000, "the working value is kept for review")
    assert.equal(mcr.physicalVerification, true)
    assert.equal(mcr.release, "withhold")
    assert.match(mcr.reasons.join(" "), /EIAPP is checked/)
  })

  test("a group status of CONFLICT means its fields are offered, never filled", async () => {
    const r = await build({ vessels: [{ values: vessel("TA", "TEST A", A, { "Technical Status": "CONFLICT" }) }], sources: fullSources("TA") })
    assert.equal(field(r, "TA", "loa_m").release, "offer")
    assert.equal(field(r, "TA", "flag").release, "fill", "other groups are not affected")
  })

  test("an unmapped source text verifies nothing and is reported; an unknown fill colour is reviewed, not ignored", async () => {
    const r = await build({
      vessels: [{ values: vessel("TA", "TEST A", A), fill: { "Gross Tonnage": "FFFFFF00" } }],
      sources: [{ "Source ID": "SRC-?", "Vessel ID": "TA", "Field / Field Group": "Everything important", "Verification Status": "VERIFIED" }],
    })
    assert.equal(field(r, "TA", "flag").status, "PROVISIONAL")
    assert.ok(r.exceptions.some((e) => /not mapped to fields/.test(e.text)))
    assert.equal(field(r, "TA", "gross_tonnage").release, "offer")
    assert.ok(r.exceptions.some((e) => /colour the README does not define/.test(e.text)))
  })
})

describe("the supplied workbook (read-only; skipped when it is not in the working copy)", () => {
  const path = join(import.meta.dirname, "..", "Vessel Particular", "SIR_Vessel_Master_DHT_23_Technical_File_Review 3.xlsx")
  test("23 vessels and their known quality items are handled as planned", { skip: !existsSync(path) }, async () => {
    const book = await readWorkbook(readFileSync(path))
    assert.deepEqual(book.problems, [])
    const r = buildMaster(book, FLEET_VESSELS)
    assert.equal(r.rejected.length, 0)
    assert.equal(r.vessels.filter((v) => v.workbookId).length, 23)
    assert.equal(r.vessels.find((v) => v.name === "DHT ORYX")?.activeStatus, "NOT DELIVERED")
    assert.equal(r.vessels.filter((v) => v.workbookId && v.legacyKeys.length).length, 23, "all 23 linked to the existing names")
    const f = (id: string, key: string) => r.vessels.find((v) => v.workbookId === id)!.fields[key]
    assert.equal(f("DIMP", "hull_number").release, "withhold")           // DQ-001
    assert.equal(f("DPUM", "mcr_kw").release, "withhold")                // DQ-002 / plan Q3
    assert.equal(f("DLIO", "flag").release, "withhold")                  // DQ-004
    assert.equal(f("DGAZ", "class_notation").release, "withhold")        // DQ-007
    assert.equal(f("DANT", "summer_dwt_mt").release, "withhold")         // DQ-008 / plan Q4
    assert.equal(f("DOSP", "flag").release, "withhold")                  // DQ-010
    assert.equal(f("DGAZ", "fuel_laden_mt_day").release, "withhold")     // DQ-013
    assert.equal(f("DANT", "mcr_kw").release, "withhold")                // DQ-014
    assert.equal(f("DIMP", "fuel_basis").release, "withhold")            // DQ-015
    assert.equal(f("DSUN", "fuel_laden_mt_day").release, "withhold")     // DQ-016 + orange
    assert.notEqual(f("DADD", "fuel_laden_mt_day").status, "VERIFIED")  // plan Q1
    assert.equal(f("DIMP", "flag").status, "PROVISIONAL")                // plan Q2: provisional registry certificate
    assert.equal(r.vessels.reduce((n, v) => n + Object.values(v.fields).filter((x) => x.physicalVerification).length, 0), 23)
    assert.equal(f("DHAR", "loa_m").value, 336)
    assert.equal(f("DTIG", "summer_dwt_mt").value, null, "no value invented where the workbook is blank")
  })
})
