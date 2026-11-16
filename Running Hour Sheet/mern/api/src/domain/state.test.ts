import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analytics, demonstrationState, monthlyHours, utilisation, validateVesselState, summarizeVesselState } from "./state.js";

const sourcePath = new URL("../../../../dashboard_data.json", import.meta.url);
const sourceJson = JSON.parse(await readFile(sourcePath, "utf8"));
const source = validateVesselState(sourceJson);

test("validates and summarizes the unchanged vessel dataset", () => {
  assert.deepEqual(source, sourceJson);
  const summary = summarizeVesselState(source);
  assert.equal(summary.vessel, "DHT LEOPARD");
  assert.equal(summary.machines, 35);
  assert.deepEqual(summary.years.map((year) => year.year), ["2025", "2026"]);
  assert.equal(summary.sourceReportRecords, 350);
});

test("keeps missing readings distinct from zero running hours", () => {
  assert.deepEqual(monthlyHours([10, 10, null, 10]), [0, null, null]);
});

test("matches the adaptive two-month utilization rules", () => {
  assert.equal(utilisation([720, 680, 730, 120, 100], 4), "amber");
  assert.equal(utilisation([80, 90, 70, 0, 0], 4), "red");
  assert.equal(utilisation([720, 680, 730, null, 0], 4), null);
});

test("uses source opening/closing observations without bridging missing months", () => {
  const computed = analytics(source);
  const year = Object.keys(source.source_reports ?? {})[0];
  const id = Object.keys(source.source_reports?.[year] ?? {})[0];
  const result = computed[year]?.[id];
  assert.ok(result);
  assert.equal(result.hours.length, 12);
  assert.equal(result.hours.some((value) => value === null), true);
});

test("formats calendar-hour exceptions without floating-point noise", () => {
  const state = demonstrationState();
  const machine = state.machines[0];
  assert.ok(machine);
  state.source_reports = {
    "2026": {
      [machine.id]: Array.from({ length: 12 }, (_, month) =>
        month === 0 ? { begin: 0.6, end: 746.2 } : null
      )
    }
  };

  const issues = analytics(state)["2026"]?.[machine.id]?.issues[0] ?? [];
  assert.ok(issues.includes("745.6 RH exceeds 744 calendar hours; verify reporting times. Reading retained."));
  assert.equal(issues.some((issue) => issue.includes("745.599999")), false);
});
