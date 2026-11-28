"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const DumpFile = require("../src/dumpfile.js");
const DA = require("../src/analysis.js");
const { engineDump, sampleFiles } = require("./helpers.js");

// Six cylinders, firing order 1-5-3-4-2-6, 60 degrees apart.
const FIRING = [1, 5, 3, 4, 2, 6];
const OFFSET = {};
FIRING.forEach((cyl, i) => { OFFSET[cyl] = i * 60; });

function engine(overrides, only) {
  const cyls = only || [1, 2, 3, 4, 5, 6];
  return cyls.map((cyl, i) => {
    const o = Object.assign({ cyl, offset: OFFSET[cyl], startAngle: 37 * cyl, ringStart: 211 * i }, (overrides && overrides[cyl]) || {});
    return DumpFile.parse(engineDump(o), "CCU" + cyl + ".dat");
  });
}

function near(actual, expected, tol, what) {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);
}

test("crank angle: fine angle follows the true angle through 1-degree steps", () => {
  const dt = 0.0005;
  const omega = 480; // 80 rpm
  const tacho = Float64Array.from({ length: 4000 }, (_, i) => Math.round((10 + omega * i * dt) % 360) % 360);
  const crank = DA.crankAngle(tacho, 500);
  assert.equal(crank.moving, true);
  near(crank.meanRpm, 80, 0.2, "mean rpm");
  for (let i = 50; i < 3950; i += 97) near(crank.fine[i], 10 + omega * i * dt, 0.2, "angle at " + i);
  near(crank.rpm[2000], 80, 1, "speed");
});

test("works out cylinder count, firing order and TDC offsets", () => {
  const set = DA.groupDumps(engine())[0];
  const a = DA.analyzeSet(set);
  assert.equal(a.firing.cylinders, 6);
  assert.equal(a.firing.source, "data");
  assert.deepEqual(a.firing.firingOrder, FIRING);
  for (const c of a.cylinders) near(c.result.offsetDeg, OFFSET[c.number], 1e-6, c.name + " offset");
});

test("finds the TDC offsets without cylinder 1 when injection is near TDC", () => {
  const set = DA.groupDumps(engine(null, [2, 3, 4, 5, 6]))[0];
  const a = DA.analyzeSet(set);
  for (const c of a.cylinders) near(c.result.offsetDeg, OFFSET[c.number], 1e-6, c.name + " offset");
  assert.equal(a.firing.firingOrder, null, "no firing order while a cylinder is missing");
});

test("measures injection, plunger stroke, exhaust valve and FIVA delay", () => {
  const a = DA.analyzeSet(DA.groupDumps(engine())[0]);
  for (const c of a.cylinders) {
    const m = c.result.metrics;
    assert.ok(m.fullCycles >= 3, c.name + " full cycles");
    near(m.injectionStart.mean, 1.8, 0.35, c.name + " injection start");
    near(m.plungerStroke.mean, 4000, 20, c.name + " stroke");
    near(m.evOpen.mean, 121.5, 0.35, c.name + " valve opens");
    near(m.evClose.mean, 268.5, 0.35, c.name + " valve closes");
    near(m.evLift.mean, 7000, 20, c.name + " lift");
    near(m.fiva.delayMs, 3.0, 0.3, c.name + " FIVA delay");
    near(m.fivaControllerMean, -70, 0.01, c.name + " controller (gain 0.2)");
    near(m.meanRpm, 80, 0.3, c.name + " rpm");
  }
  assert.deepEqual(a.findings.filter((f) => f.level !== "note"), [], "a healthy engine has no findings");
});

test("flags the cylinder that differs, and only that one", () => {
  const a = DA.analyzeSet(DA.groupDumps(engine({ 4: { stroke: 4600 }, 2: { evOpen: 124 }, 6: { lagSamples: 10 } }))[0]);
  const issues = a.findings.filter((f) => f.level !== "note");
  const keys = issues.map((f) => f.cylinder + ":" + f.metric + ":" + f.level);
  for (const k of ["Cyl 2:evOpen:check", "Cyl 4:plungerStroke:check", "Cyl 6:fivaDelay:check"]) assert.ok(keys.includes(k), "missing " + k + " in " + keys);
  // A slower FIVA also strays further from its set point, so Cyl 6 may carry a second flag; nobody else is flagged.
  assert.deepEqual([...new Set(issues.map((f) => f.cylinder))].sort(), ["Cyl 2", "Cyl 4", "Cyl 6"]);
  const stroke = issues.find((f) => f.cylinder === "Cyl 4");
  assert.match(stroke.text, /1[45]\.\d% longer than on the other cylinders, so this cylinder gets more fuel \(4,[56]\d\d against [34],\d\d\d\)\./);
});

test("reports cycles where the exhaust valve did not open", () => {
  const dumps = engine();
  // Hold cylinder 3's exhaust valve shut for one whole cycle (cycle 3 runs from sample 2850 to 4350).
  const d3 = dumps.find((d) => d.unitNumber === 3);
  const ev = d3.channels[4];
  for (let i = 2860; i < 4340; i++) ev.values[i] = 8300;
  const a = DA.analyzeSet(DA.groupDumps(dumps)[0]);
  const f = a.findings.find((x) => x.cylinder === "Cyl 3" && /did not open/.test(x.text));
  assert.ok(f, "finding for the missed valve opening");
  assert.equal(f.level, "check");
});

test("a stopped engine gives a note, not an error", () => {
  const d = DumpFile.parse(engineDump({ cyl: 1, offset: 0, stopped: true }), "CCU1.dat");
  const a = DA.analyzeSet(DA.groupDumps([d])[0]);
  assert.ok(a.findings.some((f) => /engine was probably stopped/.test(f.text)));
});

test("one cylinder other than 1: angles stay on cylinder 1 TDC, with a note", () => {
  const a = DA.analyzeSet(DA.groupDumps(engine(null, [4]))[0]);
  assert.equal(a.firing.reference, "cyl1");
  assert.ok(a.findings.some((f) => /cylinder 1 TDC/.test(f.text)));
  // With the cylinder count set by the user, the own TDC is found again.
  const b = DA.analyzeSet(DA.groupDumps(engine(null, [4]))[0], { cylinders: 6 });
  near(b.cylinders[0].result.offsetDeg, OFFSET[4], 1e-6, "offset with setting");
});

test("groups files into separate dumps", () => {
  const first = engine(null, [1, 2]);
  const later = engine(null, [1]).map((d) => Object.assign(d, { utcMs: d.utcMs + 3600 * 1000 }));
  const sets = DA.groupDumps(first.concat(later));
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((s) => s.dumps.length), [2, 1]);
});

const samples = sampleFiles();
test("sample dump: 7 cylinders, firing order 1-7-2-5-4-3-6", { skip: samples.length === 7 ? false : "needs the 7 sample .dat files" }, () => {
  const dumps = samples.map((f) => DumpFile.parse(fs.readFileSync(f), path.basename(f)));
  const sets = DA.groupDumps(dumps);
  assert.equal(sets.length, 1);
  const a = DA.analyzeSet(sets[0]);
  assert.equal(a.firing.cylinders, 7);
  assert.deepEqual(a.firing.firingOrder, [1, 7, 2, 5, 4, 3, 6]);
  near(a.engineRpm, 54.1, 0.2, "engine speed");
  for (const c of a.cylinders) {
    const m = c.result.metrics;
    near(m.injectionStart.mean, 0, 0.5, c.name + " injection start");
    near(m.evOpen.mean, 124, 1, c.name + " valve opens");
    near(m.fiva.delayMs, 3.5, 0.3, c.name + " FIVA delay");
    assert.equal(m.missedInjections, 0);
    assert.equal(m.missedValveOpenings, 0);
  }
  assert.equal(a.findings.filter((f) => f.level === "check").length, 0);
});
