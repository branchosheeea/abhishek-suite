/*
 * dumpfile.js - reads MAN B&W ME-ECS burst-log dump files (*.dat).
 *
 * Layout (all numbers big-endian), worked out from CCU burst logs written by
 * ME-ECS-SW-1609-6.4 and checked against LDEPlot 1.3.0. See docs/FILE_FORMAT.md.
 *
 *   0x000  4 bytes      02 00 01 00 in every sample (meaning unknown; probably a format version)
 *   0x004  char[64]     logger name            "CCUBurstLogger"
 *   0x044  char[64]     reason                 "0540#Manual Dump"
 *   0x084  char[64]     control software       "ME-ECS-SW-1609-6.4"
 *   0x0C4  char[16]     control unit           "CCU1"
 *   0x0D4  u32 u32      UTC time: seconds since 1970, microseconds
 *   0x0DC  u32 u32      local time: seconds, microseconds
 *   0x0E4  u16          4500 in every sample (probably samples kept before the trigger)
 *   0x0E6  u16          number of samples per channel
 *   0x0E8  u16          ring-buffer position of the oldest sample
 *   0x0EA  u16          number of channels
 *   0x0EC  u32          sample interval in microseconds
 *   0x0F0  56 bytes per channel:
 *            char[32]   name
 *            s32        gain, 16.16 fixed point   (0x00010000 = 1.0)
 *            s32        offset, 16.16 fixed point
 *            char[12]   unit                      ("-" = none)
 *            u8 u8 u16  type bytes (0x01 0x02 = 16-bit signed)
 *   then    s16 samples, interleaved by channel, stored as a ring buffer.
 *
 * Works in the browser (window.DumpFile) and in Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DumpFile = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OFFSETS = {
    version: 0x00,
    logger: 0x04,
    reason: 0x44,
    software: 0x84,
    unit: 0xc4,
    utc: 0xd4,
    local: 0xdc,
    counts: 0xe4,
    channels: 0xf0,
  };
  var CHANNEL_BYTES = 56;
  var MAX_CHANNELS = 64;

  function DumpFormatError(message) {
    var error = new Error(message);
    error.name = "DumpFormatError";
    return error;
  }

  /** Text up to the first NUL byte. Bytes after it are left-over memory, not data. */
  function readText(bytes, start, length) {
    var out = "";
    for (var i = start; i < start + length && i < bytes.length; i++) {
      var c = bytes[i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.trim();
  }

  function isPrintable(text) {
    return /^[\x20-\x7e]*$/.test(text);
  }

  /**
   * Parse one dump file.
   * @param {ArrayBuffer|Uint8Array} input file contents
   * @param {string} [fileName]
   * @returns {object} dump with header fields and channels in time order
   */
  function parse(input, fileName) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var name = fileName || "dump.dat";

    if (bytes.length < OFFSETS.channels) {
      throw DumpFormatError("The file is too short to be an ME-ECS burst log (" + bytes.length + " bytes).");
    }

    var logger = readText(bytes, OFFSETS.logger, 64);
    if (!logger || !isPrintable(logger)) {
      throw DumpFormatError("This is not an ME-ECS burst log: no logger name in the file header.");
    }

    var preSamples = view.getUint16(OFFSETS.counts, false);
    var sampleCount = view.getUint16(OFFSETS.counts + 2, false);
    var ringStart = view.getUint16(OFFSETS.counts + 4, false);
    var channelCount = view.getUint16(OFFSETS.counts + 6, false);
    var intervalUs = view.getUint32(OFFSETS.counts + 8, false);

    if (channelCount < 1 || channelCount > MAX_CHANNELS) {
      throw DumpFormatError("The header says " + channelCount + " channels, which does not look right.");
    }
    if (sampleCount < 2) {
      throw DumpFormatError("The log holds no samples.");
    }
    if (intervalUs < 1 || intervalUs > 10000000) {
      throw DumpFormatError("The header gives a sample interval of " + intervalUs + " microseconds, which does not look right.");
    }

    var dataStart = OFFSETS.channels + CHANNEL_BYTES * channelCount;
    var dataBytes = sampleCount * channelCount * 2;
    if (bytes.length < dataStart + dataBytes) {
      throw DumpFormatError(
        "The file is cut short: it should hold " + (dataStart + dataBytes) + " bytes but has " + bytes.length + "."
      );
    }

    var warnings = [];
    var channels = [];
    for (var c = 0; c < channelCount; c++) {
      var base = OFFSETS.channels + c * CHANNEL_BYTES;
      var unit = readText(bytes, base + 40, 12);
      var typeA = bytes[base + 52];
      var typeB = bytes[base + 53];
      var channelName = readText(bytes, base, 32) || "Channel " + (c + 1);
      if (!(typeA === 1 && typeB === 2)) {
        warnings.push("Channel \"" + channelName + "\" has unknown type bytes " + hex2(typeA) + " " + hex2(typeB) + "; read as 16-bit numbers.");
      }
      channels.push({
        index: c,
        name: channelName,
        gain: fixed16(view.getInt32(base + 32, false)),
        offset: fixed16(view.getInt32(base + 36, false)),
        unit: unit === "-" ? "" : unit,
        typeBytes: hex2(typeA) + " " + hex2(typeB),
        raw: new Int16Array(sampleCount),
        values: new Float64Array(sampleCount),
        rawMin: 0,
        rawMax: 0,
      });
    }

    // The logger writes into a ring buffer; ringStart is where the oldest sample sits.
    var rotate = ringStart > 0 && ringStart < sampleCount;
    if (ringStart >= sampleCount) {
      warnings.push("Ring-buffer position " + ringStart + " is past the end of the log; samples kept in stored order.");
    }
    var stride = channelCount * 2;
    for (var s = 0; s < sampleCount; s++) {
      var stored = rotate ? (s + ringStart) % sampleCount : s;
      var at = dataStart + stored * stride;
      for (var k = 0; k < channelCount; k++) {
        channels[k].raw[s] = view.getInt16(at + k * 2, false);
      }
    }
    for (var j = 0; j < channelCount; j++) {
      var ch = channels[j];
      var lo = Infinity;
      var hi = -Infinity;
      for (var i = 0; i < sampleCount; i++) {
        var r = ch.raw[i];
        if (r < lo) lo = r;
        if (r > hi) hi = r;
        ch.values[i] = r * ch.gain + ch.offset;
      }
      ch.rawMin = lo;
      ch.rawMax = hi;
    }

    var reason = readText(bytes, OFFSETS.reason, 64);
    var hashAt = reason.indexOf("#");
    var utcSeconds = view.getUint32(OFFSETS.utc, false);
    var utcMicros = view.getUint32(OFFSETS.utc + 4, false);
    var localSeconds = view.getUint32(OFFSETS.local, false);
    var unitName = readText(bytes, OFFSETS.unit, 16);
    var unitMatch = /(\d+)\s*$/.exec(unitName);

    return {
      fileName: name,
      fileSize: bytes.length,
      headerTag: hex2(bytes[0]) + " " + hex2(bytes[1]) + " " + hex2(bytes[2]) + " " + hex2(bytes[3]),
      logger: logger,
      reason: reason,
      reasonCode: hashAt >= 0 ? reason.slice(0, hashAt) : "",
      reasonText: hashAt >= 0 ? reason.slice(hashAt + 1) : reason,
      software: readText(bytes, OFFSETS.software, 64),
      unitName: unitName,
      unitType: unitName.replace(/\d+\s*$/, ""),
      unitNumber: unitMatch ? parseInt(unitMatch[1], 10) : null,
      utcMs: utcSeconds * 1000 + utcMicros / 1000,
      utcOffsetMinutes: Math.round((localSeconds - utcSeconds) / 60),
      preSamples: preSamples,
      sampleCount: sampleCount,
      ringStart: ringStart,
      channelCount: channelCount,
      sampleIntervalUs: intervalUs,
      durationS: (sampleCount * intervalUs) / 1e6,
      dataStart: dataStart,
      trailingBytes: bytes.length - (dataStart + dataBytes),
      channels: channels,
      warnings: warnings,
    };
  }

  /**
   * 16.16 fixed point to a number. 0.2 is stored as 0x3333 (0.19999695...), so a
   * value is snapped to the nearest 4-decimal number when that lies within the
   * format's own resolution (1/65536).
   */
  function fixed16(raw) {
    var exact = raw / 65536;
    var short = Math.round(exact * 10000) / 10000;
    return Math.abs(short - exact) <= 1 / 65536 ? short : exact;
  }

  function hex2(n) {
    return ("0" + n.toString(16)).slice(-2);
  }

  return { parse: parse, OFFSETS: OFFSETS, CHANNEL_BYTES: CHANNEL_BYTES };
});
