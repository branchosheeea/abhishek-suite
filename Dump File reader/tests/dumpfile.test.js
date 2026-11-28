"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const DumpFile = require("../src/dumpfile.js");
const { buildDump, sampleFiles } = require("./helpers.js");

function simple(ringStart) {
  const n = 10;
  return buildDump({
    unit: "CCU3",
    ringStart,
    utcSeconds: 1781487698,
    micros: 302335,
    channels: [
      { name: "Counter", values: Array.from({ length: n }, (_, i) => i * 100 - 300) },
      { name: "Scaled", values: Array.from({ length: n }, () => 50), gain: 0.2, offset: 1.5, unit: "bar" },
    ],
  });
}

test("reads the header fields", () => {
  const d = DumpFile.parse(simple(0), "x.dat");
  assert.equal(d.logger, "CCUBurstLogger");
  assert.equal(d.reason, "0540#Manual Dump");
  assert.equal(d.reasonCode, "0540");
  assert.equal(d.reasonText, "Manual Dump");
  assert.equal(d.unitName, "CCU3");
  assert.equal(d.unitNumber, 3);
  assert.equal(d.sampleCount, 10);
  assert.equal(d.channelCount, 2);
  assert.equal(d.sampleIntervalUs, 500);
  assert.equal(d.preSamples, 4500);
  assert.equal(d.utcOffsetMinutes, 480);
  assert.equal(d.utcMs, 1781487698 * 1000 + 302.335);
  assert.equal(new Date(Math.floor(d.utcMs)).toISOString(), "2026-06-15T01:41:38.302Z");
  assert.equal(d.trailingBytes, 56);
  assert.deepEqual(d.warnings, []);
});

test("applies gain, offset and unit", () => {
  const d = DumpFile.parse(simple(0));
  const ch = d.channels[1];
  assert.equal(ch.gain, 0.2);
  assert.equal(ch.offset, 1.5);
  assert.equal(ch.unit, "bar");
  assert.equal(ch.raw[0], 50);
  assert.ok(Math.abs(ch.values[0] - 11.5) < 1e-3);
  assert.equal(d.channels[0].unit, "", "a unit of '-' means none");
});

test("puts a ring buffer back in time order", () => {
  for (const ring of [0, 1, 4, 9]) {
    const d = DumpFile.parse(simple(ring));
    assert.deepEqual(Array.from(d.channels[0].raw), [-300, -200, -100, 0, 100, 200, 300, 400, 500, 600], "ring " + ring);
    assert.equal(d.ringStart, ring);
  }
});

test("refuses files that are not burst logs, with plain messages", () => {
  assert.throws(() => DumpFile.parse(new Uint8Array(100)), /too short/);
  const exeLike = new Uint8Array(4096);
  exeLike.set([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
  assert.throws(() => DumpFile.parse(exeLike), /not an ME-ECS burst log/);
  const cut = simple(0).slice(0, 0xf0 + 56 * 2 + 10);
  assert.throws(() => DumpFile.parse(cut), /cut short/);
  const badCount = simple(0);
  badCount[0xea] = 0x01; // 258 channels
  badCount[0xeb] = 0x02;
  assert.throws(() => DumpFile.parse(badCount), /channels/);
});

test("warns about a ring position past the end but still reads the file", () => {
  const bytes = simple(0);
  bytes[0xe8] = 0;
  bytes[0xe9] = 50;
  const d = DumpFile.parse(bytes);
  assert.equal(d.warnings.length, 1);
  assert.equal(d.channels[0].raw[0], -300);
});

const samples = sampleFiles();
test("reads the sample CCU dumps", { skip: samples.length ? false : "sample .dat files not present" }, () => {
  for (const file of samples) {
    const d = DumpFile.parse(fs.readFileSync(file), path.basename(file));
    assert.equal(d.software, "ME-ECS-SW-1609-6.4");
    assert.equal(d.sampleCount, 10500);
    assert.equal(d.channelCount, 6);
    assert.equal(d.sampleIntervalUs, 500);
    assert.match(d.unitName, /^CCU[1-7]$/);
    assert.equal(d.channels[2].gain.toFixed(4), "0.2000");
    // After un-rolling the ring, the 1-degree crank angle only steps forward or wraps 359 -> 0.
    const t = d.channels[5].raw;
    for (let i = 1; i < t.length; i++) {
      const step = t[i] - t[i - 1];
      assert.ok((step >= 0 && step <= 2) || (t[i - 1] >= 358 && t[i] <= 1), `${d.unitName}: crank angle jumps ${t[i - 1]} -> ${t[i]} at ${i}`);
    }
  }
});
