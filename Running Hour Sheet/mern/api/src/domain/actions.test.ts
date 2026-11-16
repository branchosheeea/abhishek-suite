import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, parseAction } from "./actions.js";
import { validateVesselState } from "./state.js";

const machineId = "test-machine";
const baseState = validateVesselState({
  schema: 1,
  revision: 3,
  vessel: "Test Vessel",
  machines: [{ id: machineId, name: "Generator", active: true }],
  years: { "2026": { [machineId]: [10, ...Array.from({ length: 12 }, () => null)] } }
});

test("increments the state revision for valid actions", () => {
  const updated = applyAction(baseState, parseAction({ type: "vessel", name: "Updated Vessel", revision: 3 }));
  assert.equal(updated.vessel, "Updated Vessel");
  assert.equal(updated.revision, 4);
  assert.equal(baseState.vessel, "Test Vessel");
});

test("rejects stale changes and duplicate machine names", () => {
  assert.throws(() => applyAction(baseState, parseAction({ type: "vessel", name: "Changed", revision: 2 })), /Another user changed/);
  assert.throws(() => applyAction(baseState, parseAction({ type: "add", name: " generator ", year: "2026", revision: 3 })), /unique/);
});

test("assigns an equipment group to existing and newly added machinery", () => {
  const grouped = applyAction(baseState, parseAction({
    type: "group",
    id: machineId,
    group: "purifiers",
    revision: 3
  }));
  assert.equal(grouped.machines[0].group, "purifiers");

  const added = applyAction(baseState, parseAction({
    type: "add",
    name: "Oil Fired Boiler No. 3",
    year: "2026",
    group: "boilers",
    revision: 3
  }));
  assert.equal(added.machines.find((machine) => machine.name === "Oil Fired Boiler No. 3")?.group, "boilers");

  const fuelOil = applyAction(baseState, parseAction({
    type: "group",
    id: machineId,
    group: "fo-purification",
    revision: 3
  }));
  assert.equal(fuelOil.machines[0].group, "fo-purification");
  assert.equal(validateVesselState(fuelOil).machines[0].group, "fo-purification");

  const lubeOil = applyAction(baseState, parseAction({
    type: "group",
    id: machineId,
    group: "lo-purification",
    revision: 3
  }));
  assert.equal(lubeOil.machines[0].group, "lo-purification");
  assert.equal(validateVesselState(lubeOil).machines[0].group, "lo-purification");

  const addedFuelOil = applyAction(baseState, parseAction({
    type: "add",
    name: "Fuel Oil Purifier No. 3",
    year: "2026",
    group: "fo-purification",
    revision: 3
  }));
  assert.equal(addedFuelOil.machines.find((machine) => machine.name === "Fuel Oil Purifier No. 3")?.group, "fo-purification");
});

test("rolls the December meter into an empty next reporting year", () => {
  const input = structuredClone(baseState);
  input.years["2026"][machineId][12] = 1234;
  const updated = applyAction(input, parseAction({ type: "rollover", year: "2026", revision: 3 }));
  assert.deepEqual(updated.years["2027"][machineId], [1234, ...Array.from({ length: 12 }, () => null)]);
});

test("does not allow normal meter edits to imported reports", () => {
  const input = validateVesselState({
    ...baseState,
    source_reports: { "2026": { [machineId]: [null, ...Array.from({ length: 11 }, () => null)] } }
  });
  const action = parseAction({ type: "readings", year: "2026", id: machineId, readings: Array.from({ length: 13 }, () => null), revision: 3 });
  assert.throws(() => applyAction(input, action), /read-only/);
});

test("saves monthly entries with provenance and an audit record", () => {
  const updated = applyAction(baseState, parseAction({
    type: "monthly_entry",
    year: "2026",
    month: 0,
    engineer: "Chief Engineer",
    entries: [{ id: machineId, begin: 10, end: 25, note: "" }],
    revision: 3
  }));
  assert.equal(updated.years["2026"][machineId][1], 25);
  assert.equal(updated.manual_reports?.["2026"]?.[machineId]?.[0]?.engineer, "Chief Engineer");
  assert.equal(updated.entry_audit?.length, 1);
  assert.equal(updated.revision, 4);
});

test("requires a reason when monthly opening meter breaks continuity", () => {
  const action = parseAction({
    type: "monthly_entry",
    year: "2026",
    month: 0,
    engineer: "Chief Engineer",
    entries: [{ id: machineId, begin: 11, end: 25, note: "" }],
    revision: 3
  });
  assert.throws(() => applyAction(baseState, action), /opening meter differs/);
});

test("restores validated backup data as a revisioned state", () => {
  const backup = structuredClone(baseState);
  backup.vessel = "Restored Vessel";
  backup.revision = 100;
  const restored = applyAction(baseState, parseAction({
    type: "import",
    data: backup,
    revision: 3
  }));
  assert.equal(restored.vessel, "Restored Vessel");
  assert.equal(restored.revision, 4);
});
