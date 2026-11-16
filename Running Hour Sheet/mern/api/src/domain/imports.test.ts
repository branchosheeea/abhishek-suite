import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import test from "node:test";
import { importAnnualWorkbook, previewAnnualWorkbook, previewHistoricalReports } from "./imports.js";
import { validateVesselState } from "./state.js";

const machineId = "import-test-machine";
const baseState = validateVesselState({
  schema: 1,
  revision: 4,
  vessel: "Test Vessel",
  machines: [{ id: machineId, name: "Generator", active: true }],
  years: { "2026": { [machineId]: Array.from({ length: 13 }, () => null) } }
});

async function annualWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const master = workbook.addWorksheet("Machinery_Master");
  master.getRow(4).values = ["Machinery Name", "Include in RH", "_Machinery_ID"];
  master.getRow(5).values = ["Generator", "Yes", machineId];
  const sheet = workbook.addWorksheet("RH_2026");
  sheet.getRow(4).values = [
    "Machinery Name", "Meter @ 31 Dec 2025",
    ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month) => `${month} meter`),
    ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month) => `${month} RH`),
    "_Machinery_ID"
  ];
  sheet.getRow(5).values = ["Generator", 100, 110, ...Array.from({ length: 11 }, () => null), ...Array.from({ length: 12 }, () => null), machineId];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function historicalWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");
  sheet.getCell("A2").value = "Vessel: Test Vessel";
  sheet.getCell("A3").value = "Description";
  sheet.getCell("D2").value = "Jan 2026";
  sheet.getRow(4).values = ["Generator", 100, 10, 110];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("previews and adds annual workbook meters without replacing existing values", async () => {
  const file = { name: "Annual.xlsx", buffer: await annualWorkbook() };
  const preview = await previewAnnualWorkbook(baseState, file);
  assert.equal(preview.summary.new_values, 2);
  assert.equal(preview.summary.total_conflicts, 0);
  const imported = await importAnnualWorkbook(baseState, file, preview.fingerprint);
  assert.equal(imported.data.years["2026"][machineId][0], 100);
  assert.equal(imported.data.years["2026"][machineId][1], 110);
  assert.equal(imported.data.workbook_sources?.["2026"]?.[machineId]?.[1]?.file, "Annual.xlsx");
  assert.equal(imported.data.revision, baseState.revision + 1);
});

test("rejects an annual workbook changed after preview", async () => {
  const file = { name: "Annual.xlsx", buffer: await annualWorkbook() };
  await assert.rejects(importAnnualWorkbook(baseState, file, "stale-fingerprint"), /changed since preview/);
});

test("scans YYYY-MM report files and preserves source report provenance", async () => {
  const file = {
    name: "Monthly.xlsx",
    relativePath: "reports/2026-01/Monthly.xlsx",
    buffer: await historicalWorkbook()
  };
  const preview = await previewHistoricalReports(baseState, [file]);
  assert.equal(preview.summary.new_records, 1);
  assert.equal(preview.summary.errors.length, 0);
  const report = preview.data.source_reports?.["2026"]?.[machineId]?.[0];
  assert.equal(report?.begin, 100);
  assert.equal(report?.reported, 10);
  assert.equal(report?.end, 110);
  assert.equal(report?.file, file.relativePath);
  assert.equal(preview.data.years["2026"][machineId][1], 110);
});
