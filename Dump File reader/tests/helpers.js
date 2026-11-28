/* Test helpers: write synthetic ME-ECS burst-log files with known contents. */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Build a dump file. channels: [{ name, values (time order), gain=1, offset=0, unit="-" }].
 * The samples are stored as a ring buffer starting at ringStart, like the real logger.
 */
function buildDump(opts) {
  const channels = opts.channels;
  const n = channels[0].values.length;
  const nch = channels.length;
  const ring = opts.ringStart || 0;
  const dataStart = 0xf0 + 56 * nch;
  const buf = Buffer.alloc(dataStart + n * nch * 2 + (opts.trailer === undefined ? 56 : opts.trailer));
  buf.writeUInt16BE(0x0200, 0);
  buf.writeUInt16BE(0x0100, 2);
  buf.write(opts.logger || "CCUBurstLogger", 0x04, "latin1");
  buf.write(opts.reason || "0540#Manual Dump", 0x44, "latin1");
  buf.write(opts.software || "ME-ECS-SW-TEST", 0x84, "latin1");
  buf.write(opts.unit || "CCU1", 0xc4, "latin1");
  const utc = opts.utcSeconds || 1781487698;
  buf.writeUInt32BE(utc, 0xd4);
  buf.writeUInt32BE(opts.micros || 250000, 0xd8);
  buf.writeUInt32BE(utc + (opts.localOffsetSeconds === undefined ? 8 * 3600 : opts.localOffsetSeconds), 0xdc);
  buf.writeUInt32BE(opts.micros || 250000, 0xe0);
  buf.writeUInt16BE(opts.preSamples === undefined ? 4500 : opts.preSamples, 0xe4);
  buf.writeUInt16BE(n, 0xe6);
  buf.writeUInt16BE(ring, 0xe8);
  buf.writeUInt16BE(nch, 0xea);
  buf.writeUInt32BE(opts.intervalUs || 500, 0xec);
  channels.forEach((ch, k) => {
    const base = 0xf0 + k * 56;
    buf.write(ch.name, base, "latin1");
    buf.writeInt32BE(Math.round((ch.gain === undefined ? 1 : ch.gain) * 65536), base + 32);
    buf.writeInt32BE(Math.round((ch.offset || 0) * 65536), base + 36);
    buf.write(ch.unit === undefined ? "-" : ch.unit, base + 40, "latin1");
    buf[base + 52] = 1;
    buf[base + 53] = 2;
  });
  for (let s = 0; s < n; s++) {
    const stored = (s + ring) % n;
    channels.forEach((ch, k) => {
      buf.writeInt16BE(Math.round(ch.values[s]), dataStart + stored * nch * 2 + k * 2);
    });
  }
  return new Uint8Array(buf);
}

/** Wrap into -45 .. 315, the analysis cycle window. */
function cycleAngle(a) {
  return ((((a + 45) % 360) + 360) % 360) - 45;
}

/**
 * A synthetic engine. Every cylinder: injection 10% point at injAtdc + 0.8 deg,
 * exhaust valve 10% points at evOpen + 1.5 and evClose - 1.5 deg, FIVA feedback
 * lagging the set point by lagSamples.
 */
function engineDump(o) {
  const n = o.samples || 6000;
  const dtS = (o.intervalUs || 500) / 1e6;
  const omega = (o.rpm || 80) * 6;
  const rest = o.plungerRest || 8000;
  const stroke = o.stroke || 4000;
  const closed = 8300;
  const lift = o.lift || 7000;
  const inj = o.injAtdc === undefined ? 1 : o.injAtdc;
  const evOpen = o.evOpen || 120;
  const evClose = o.evClose || 270;
  const lag = o.lagSamples === undefined ? 6 : o.lagSamples;
  const tacho = [], plunger = [], ev = [], set = [], fb = [], ctrl = [];
  for (let i = 0; i < n; i++) {
    const theta = (o.startAngle || 0) + (o.stopped ? 0 : omega * i * dtS);
    tacho.push(Math.round(((theta % 360) + 360) % 360) % 360);
    const a = cycleAngle(theta - o.offset);
    let p = rest;
    if (a >= inj && a < inj + 8) p = rest + (stroke * (a - inj)) / 8;
    else if (a >= inj + 8 && a < inj + 60) p = rest + stroke * (1 - (a - inj - 8) / 52);
    plunger.push(p);
    let v = closed;
    if (a >= evOpen && a < evOpen + 15) v = closed + (lift * (a - evOpen)) / 15;
    else if (a >= evOpen + 15 && a < evClose - 15) v = closed + lift;
    else if (a >= evClose - 15 && a < evClose) v = closed + (lift * (evClose - a)) / 15;
    ev.push(v);
    let s = -2500;
    if (a >= -10 && a < 8) s = 2000;
    else if (a >= 8 && a < evOpen - 5) s = -1500;
    else if (a >= evOpen - 5 && a < evClose - 20) s = -7000;
    set.push(s);
    ctrl.push(-350 + (i % 7) - 3);
  }
  for (let i = 0; i < n; i++) fb.push(set[Math.max(0, i - lag)]);
  return buildDump({
    unit: "CCU" + o.cyl,
    utcSeconds: 1781487698 + o.cyl,
    ringStart: o.ringStart || 0,
    channels: [
      { name: "FIVA Set Point", values: set },
      { name: "FIVA Feedback Ch30", values: fb },
      { name: "FIVA Controller Ch70", values: ctrl, gain: 0.2 },
      { name: "Plunger Position Ch31", values: plunger },
      { name: "Exhaustvalve Position Ch34", values: ev },
      { name: "Tacho Angle Cyl. 1", values: tacho },
    ],
  });
}

/** The user's sample dumps next to the program, if they are there. */
function sampleFiles() {
  const dir = path.join(__dirname, "..");
  return fs.readdirSync(dir).filter((f) => /CCUBurstLogger\.dat$/i.test(f)).sort().map((f) => path.join(dir, f));
}

module.exports = { buildDump, engineDump, cycleAngle, sampleFiles };
