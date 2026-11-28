/*
 * analysis.js - turns parsed ME-ECS CCU dumps into measurements and plain findings.
 *
 *   prepare(dump)              recognise channels, work out crank angle and speed
 *   analyzeSet(dumps, opts)    match cylinders to the firing order, measure every
 *                              cycle, compare cylinders, write findings
 *   groupDumps(dumps)          split a pile of files into dump sets
 *
 * Crank angles in results are "degrees after this cylinder's TDC", shown in the
 * window -45 .. 315 so the injection (around 0) and the exhaust valve events
 * (about 120-300) sit in one unbroken cycle.
 *
 * Works in the browser (window.DumpAnalysis) and in Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DumpAnalysis = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** Channels this program understands, found by name. Anything else is still plotted. */
  var ROLES = [
    { key: "fivaSet", label: "FIVA set point", test: /fiva.*set/i },
    { key: "fivaFeedback", label: "FIVA feedback", test: /fiva.*(feed|f\.?b\b)/i },
    { key: "fivaController", label: "FIVA controller output", test: /fiva.*(contr|ctrl|output)/i },
    { key: "plunger", label: "Fuel plunger position", test: /plunger/i },
    { key: "exhaustValve", label: "Exhaust valve position", test: /exh\w*\s*valve|exhaustvalve/i },
    { key: "tacho", label: "Crank angle", test: /tacho|crank\s*angle/i },
  ];

  /** Cycle window, degrees after own TDC. */
  var CYCLE_FROM = -45;
  var CYCLE_TO = 315;
  var BIN_DEG = 0.5;

  /** Event thresholds, as a share of the movement in that cycle. */
  var EVENT_LEVEL = 0.1;

  /**
   * Comparison limits. "watch" = worth a look, "check" = clearly different.
   * Starting values; tune them against dumps from healthy engines.
   */
  var LIMITS = {
    injectionStartDeg: { watch: 1.0, check: 2.0 },
    plungerStrokePct: { watch: 5, check: 10 },
    evOpenDeg: { watch: 2, check: 4 },
    evCloseDeg: { watch: 3, check: 6 },
    evLiftPct: { watch: 5, check: 12 },
    fivaDelayMs: { watch: 0.75, check: 1.5 },
    fivaGapRatio: { watch: 1.6, check: 2.5 },
    cycleStrokeSpreadPct: { watch: 4, check: 8 },
    cycleTimingSpreadDeg: { watch: 2, check: 4 },
    speedChangePct: { watch: 2, check: 5 },
  };

  // ---------------------------------------------------------------- helpers

  function quantile(values, q) {
    var arr = Array.prototype.slice.call(values).filter(isFinite);
    if (!arr.length) return NaN;
    arr.sort(function (a, b) { return a - b; });
    var pos = (arr.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  }

  function median(values) { return quantile(values, 0.5); }

  function mean(values) {
    var s = 0, n = 0;
    for (var i = 0; i < values.length; i++) if (isFinite(values[i])) { s += values[i]; n++; }
    return n ? s / n : NaN;
  }

  function summary(values) {
    var v = values.filter(function (x) { return x !== null && isFinite(x); });
    if (!v.length) return null;
    var lo = Math.min.apply(null, v);
    var hi = Math.max.apply(null, v);
    return { mean: mean(v), min: lo, max: hi, spread: hi - lo, count: v.length };
  }

  /** Wrap any angle into the cycle window -45 .. 315. */
  function cycleAngle(deg) {
    var a = (((deg - CYCLE_FROM) % 360) + 360) % 360;
    return a + CYCLE_FROM;
  }

  /** Wrap into -180 .. 180. */
  function wrap180(deg) {
    var a = (((deg + 180) % 360) + 360) % 360;
    return a - 180;
  }

  function circularMean(degs, period) {
    var p = period || 360;
    var sx = 0, sy = 0;
    degs.forEach(function (d) {
      var r = (d / p) * 2 * Math.PI;
      sx += Math.cos(r);
      sy += Math.sin(r);
    });
    if (!degs.length) return NaN;
    return (Math.atan2(sy, sx) / (2 * Math.PI)) * p;
  }

  /** Fractional sample where series crosses level between i-1 and i. */
  function crossing(series, i, level) {
    var a = series[i - 1];
    var b = series[i];
    if (b === a) return i;
    return i - 1 + (level - a) / (b - a);
  }

  function interp(series, x) {
    var i = Math.floor(x);
    if (i < 0) return series[0];
    if (i >= series.length - 1) return series[series.length - 1];
    return series[i] + (series[i + 1] - series[i]) * (x - i);
  }

  // ---------------------------------------------------------------- per file

  function findRoles(channels) {
    var roles = {};
    ROLES.forEach(function (role) {
      for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        if (role.test.test(ch.name) && !ch.role) {
          ch.role = role.key;
          ch.label = role.label;
          roles[role.key] = ch;
          return;
        }
      }
    });
    channels.forEach(function (ch) { if (!ch.label) ch.label = ch.name; });
    return roles;
  }

  /**
   * Crank angle from the 1-degree tacho channel.
   * The tacho only moves in whole degrees, so the fine angle is drawn through the
   * middle of each step; it averages to the logged value and has no 1-degree jumps.
   */
  function crankAngle(tacho, intervalUs) {
    var n = tacho.length;
    var unwrapped = new Float64Array(n);
    var turns = 0;
    unwrapped[0] = tacho[0];
    for (var i = 1; i < n; i++) {
      var d = tacho[i] - tacho[i - 1];
      if (d < -180) turns += 360;
      else if (d > 180) turns -= 360;
      unwrapped[i] = tacho[i] + turns;
    }
    var travel = unwrapped[n - 1] - unwrapped[0];
    var dtS = intervalUs / 1e6;
    var result = {
      unwrapped: unwrapped,
      fine: new Float64Array(n),
      rpm: new Float64Array(n),
      moving: Math.abs(travel) >= 30,
      direction: travel >= 0 ? 1 : -1,
      meanRpm: Math.abs(travel) / 360 / (((n - 1) * intervalUs) / 1e6) * 60,
    };
    if (!result.moving) {
      result.fine.set(unwrapped);
      return result;
    }

    // Points where the logged angle steps; keep only steps in the running direction.
    var dir = result.direction;
    var xs = [];
    var ys = [];
    for (var j = 1; j < n; j++) {
      if (unwrapped[j] !== unwrapped[j - 1]) {
        var y = (unwrapped[j] + unwrapped[j - 1]) / 2;
        if (!ys.length || (y - ys[ys.length - 1]) * dir > 0) {
          xs.push(j - 0.5);
          ys.push(y);
        }
      }
    }
    if (xs.length < 2) {
      result.fine.set(unwrapped);
      return result;
    }
    var seg = 0;
    for (var k = 0; k < n; k++) {
      while (seg < xs.length - 2 && k > xs[seg + 1]) seg++;
      var x0 = xs[seg], x1 = xs[seg + 1];
      result.fine[k] = ys[seg] + ((ys[seg + 1] - ys[seg]) * (k - x0)) / (x1 - x0);
    }

    // Speed: slope of the fine angle over +/- 25 ms.
    var w = Math.max(2, Math.round(0.025 / dtS));
    for (var m = 0; m < n; m++) {
      var a = Math.max(0, m - w);
      var b = Math.min(n - 1, m + w);
      result.rpm[m] = (Math.abs(result.fine[b] - result.fine[a]) / ((b - a) * dtS)) / 6;
    }
    return result;
  }

  function qualityChecks(dump) {
    var notes = [];
    dump.channels.forEach(function (ch) {
      if (ch.rawMin === ch.rawMax) {
        notes.push({ level: "check", text: "\"" + ch.label + "\" does not move at all (stays at " + ch.rawMin + "). The sensor or its signal may have failed." });
      } else if (ch.rawMax >= 32767 || ch.rawMin <= -32768) {
        notes.push({ level: "watch", text: "\"" + ch.label + "\" reaches the limit of the logger's range. Part of the signal may be cut off." });
      }
    });
    return notes;
  }

  /** Recognise channels and work out the crank angle. Safe to call more than once. */
  function prepare(dump) {
    if (dump.prepared) return dump.prepared;
    var roles = findRoles(dump.channels);
    var crank = roles.tacho ? crankAngle(roles.tacho.values, dump.sampleIntervalUs) : null;
    var dtS = dump.sampleIntervalUs / 1e6;
    var time = new Float64Array(dump.sampleCount);
    for (var i = 0; i < time.length; i++) time[i] = i * dtS;
    var prepared = {
      roles: roles,
      crank: crank,
      time: time,
      quality: qualityChecks(dump),
      injectionAngleCyl1: crank && crank.moving && roles.plunger ? roughInjectionAngle(roles.plunger.values, crank.fine) : null,
    };
    dump.prepared = prepared;
    return prepared;
  }

  /** Where injections start, in logged crank degrees (cylinder 1 reference), 0-360. */
  function roughInjectionAngle(plunger, fine) {
    var rest = median(plunger);
    var top = quantile(plunger, 0.995);
    if (!(top - rest > 100)) return null;
    var level = rest + EVENT_LEVEL * (top - rest);
    var angles = [];
    for (var i = 1; i < plunger.length; i++) {
      if (plunger[i - 1] < level && plunger[i] >= level) {
        angles.push(interp(fine, crossing(plunger, i, level)));
      }
    }
    if (!angles.length) return null;
    var c = circularMean(angles, 360);
    return ((c % 360) + 360) % 360;
  }

  // ---------------------------------------------------------------- per cylinder

  /**
   * Measure every cycle of one dump.
   * @param {object} dump parsed dump (prepare() is called if needed)
   * @param {number} offsetDeg this cylinder's TDC, in logged crank degrees after cylinder 1 TDC
   */
  function measure(dump, offsetDeg) {
    var p = prepare(dump);
    var n = dump.sampleCount;
    var dtMs = dump.sampleIntervalUs / 1000;
    var out = {
      offsetDeg: offsetDeg,
      ownAngle: null,
      cycles: [],
      metrics: {},
      meanCycle: null,
    };
    var roles = p.roles;

    // FIVA: how closely and how quickly the feedback follows the set point.
    if (roles.fivaSet && roles.fivaFeedback) {
      out.metrics.fiva = fivaMetrics(roles.fivaSet.values, roles.fivaFeedback.values, dtMs);
    }
    if (roles.fivaController) {
      out.metrics.fivaControllerMean = mean(roles.fivaController.values);
    }

    if (!p.crank || !p.crank.moving) return out;

    out.metrics.meanRpm = p.crank.meanRpm;

    var own = new Float64Array(n);
    var dir = p.crank.direction;
    for (var i = 0; i < n; i++) own[i] = (p.crank.fine[i] - offsetDeg) * dir;
    out.ownAngle = own;

    // Cycle boundaries: own angle passing CYCLE_FROM (+ k*360).
    var first = Math.ceil((own[0] - CYCLE_FROM) / 360);
    var bounds = [];
    for (var k = first; ; k++) {
      var target = CYCLE_FROM + k * 360;
      if (target > own[n - 1]) break;
      bounds.push(findAngleIndex(own, target));
    }
    var edges = [0].concat(bounds).concat([n]);
    var plRest = roles.plunger ? median(roles.plunger.values) : NaN;
    var plTop = roles.plunger ? quantile(roles.plunger.values, 0.995) : NaN;
    var evClosed = roles.exhaustValve ? quantile(roles.exhaustValve.values, 0.2) : NaN;
    var evTop = roles.exhaustValve ? quantile(roles.exhaustValve.values, 0.995) : NaN;

    for (var c = 0; c < edges.length - 1; c++) {
      var s = Math.round(edges[c]);
      var e = Math.round(edges[c + 1]);
      if (e - s < 4) continue;
      var full = c > 0 && c < edges.length - 2;
      var cycle = {
        number: out.cycles.length + 1,
        start: s,
        end: e,
        full: full,
        startTimeS: s * dtMs / 1000,
        rpm: full ? ((360 / ((e - s) * dtMs / 1000)) / 6) : null,
        injection: null,
        exhaust: null,
      };
      if (full && roles.plunger) cycle.injection = plungerEvents(roles.plunger.values, own, s, e, plRest, plTop);
      if (full && roles.exhaustValve) cycle.exhaust = valveEvents(roles.exhaustValve.values, own, s, e, evClosed, evTop);
      out.cycles.push(cycle);
    }

    var full = out.cycles.filter(function (cy) { return cy.full; });
    out.metrics.fullCycles = full.length;
    function pick(fn) { return full.map(fn).filter(function (v) { return v !== null && v !== undefined && isFinite(v); }); }
    // Speed per revolution. The instant speed also swings with every firing pulse.
    out.metrics.rpm = summary(pick(function (cy) { return cy.rpm; }));
    if (roles.plunger) {
      out.metrics.injectionStart = summary(pick(function (cy) { return cy.injection && cy.injection.startDeg; }));
      out.metrics.plungerStroke = summary(pick(function (cy) { return cy.injection && cy.injection.stroke; }));
      out.metrics.plungerRest = plRest;
      out.metrics.missedInjections = full.filter(function (cy) { return !cy.injection; }).length;
    }
    if (roles.exhaustValve) {
      out.metrics.evOpen = summary(pick(function (cy) { return cy.exhaust && cy.exhaust.openDeg; }));
      out.metrics.evClose = summary(pick(function (cy) { return cy.exhaust && cy.exhaust.closeDeg; }));
      out.metrics.evLift = summary(pick(function (cy) { return cy.exhaust && cy.exhaust.lift; }));
      out.metrics.evClosedLevel = evClosed;
      out.metrics.missedValveOpenings = full.filter(function (cy) { return !cy.exhaust; }).length;
    }
    out.meanCycle = meanCycle(dump, own, full);
    return out;
  }

  /** First fractional index where a rising series reaches target. */
  function findAngleIndex(series, target) {
    var lo = 0, hi = series.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (series[mid] < target) lo = mid; else hi = mid;
    }
    if (series[hi] === series[lo]) return hi;
    return lo + (target - series[lo]) / (series[hi] - series[lo]);
  }

  function plungerEvents(values, own, s, e, rest, top) {
    var peak = -Infinity, peakAt = s;
    for (var i = s; i < e; i++) if (values[i] > peak) { peak = values[i]; peakAt = i; }
    var stroke = peak - rest;
    // Below a third of a normal stroke the plunger did not really inject.
    if (!(stroke > 0.33 * (top - rest)) || !(stroke > 50)) return null;
    var level = rest + EVENT_LEVEL * stroke;
    var startAt = null;
    for (var j = peakAt; j > s; j--) {
      if (values[j - 1] < level && values[j] >= level) { startAt = crossing(values, j, level); break; }
    }
    if (startAt === null) return null;
    return {
      stroke: stroke,
      peak: peak,
      startDeg: cycleAngle(interp(own, startAt)),
      peakDeg: cycleAngle(interp(own, peakAt)),
      startIndex: startAt,
      peakIndex: peakAt,
    };
  }

  function valveEvents(values, own, s, e, closed, top) {
    var peak = -Infinity, peakAt = s;
    for (var i = s; i < e; i++) if (values[i] > peak) { peak = values[i]; peakAt = i; }
    var lift = peak - closed;
    if (!(lift > 0.33 * (top - closed)) || !(lift > 50)) return null;
    var level = closed + EVENT_LEVEL * lift;
    var openAt = null, closeAt = null;
    for (var j = peakAt; j > s; j--) {
      if (values[j - 1] < level && values[j] >= level) { openAt = crossing(values, j, level); break; }
    }
    for (var k = peakAt + 1; k < e; k++) {
      if (values[k - 1] >= level && values[k] < level) { closeAt = crossing(values, k, level); break; }
    }
    if (openAt === null) return null;
    return {
      lift: lift,
      openDeg: cycleAngle(interp(own, openAt)),
      closeDeg: closeAt === null ? null : cycleAngle(interp(own, closeAt)),
      openIndex: openAt,
      closeIndex: closeAt,
    };
  }

  /**
   * FIVA tracking. delayMs is the time shift that best lines the feedback up with
   * the set point; gap is the average difference between them (no shift).
   */
  function fivaMetrics(set, fb, dtMs) {
    var n = Math.min(set.length, fb.length);
    var maxLag = Math.max(1, Math.round(20 / dtMs));
    var best = Infinity, bestLag = 0;
    for (var lag = 0; lag <= maxLag; lag++) {
      var s = 0;
      for (var i = 0; i + lag < n; i++) s += Math.abs(set[i] - fb[i + lag]);
      s /= n - lag;
      if (s < best) { best = s; bestLag = lag; }
    }
    // Sub-sample refinement with a parabola through the neighbours.
    var refined = bestLag;
    if (bestLag > 0 && bestLag < maxLag) {
      var f = function (l) {
        var t = 0;
        for (var i = 0; i + l < n; i++) t += Math.abs(set[i] - fb[i + l]);
        return t / (n - l);
      };
      var a = f(bestLag - 1), b = best, c = f(bestLag + 1);
      var den = a - 2 * b + c;
      if (den > 0) refined = bestLag + 0.5 * (a - c) / den;
    }
    var gap = 0, worst = 0, worstAt = 0;
    for (var j = 0; j < n; j++) {
      var d = Math.abs(set[j] - fb[j]);
      gap += d;
      if (d > worst) { worst = d; worstAt = j; }
    }
    var range = quantile(set, 0.99) - quantile(set, 0.01);
    return {
      delayMs: refined * dtMs,
      gap: gap / n,
      gapAfterDelay: best,
      worstGap: worst,
      worstGapIndex: worstAt,
      setRange: range,
    };
  }

  /** Average cycle per channel, in BIN_DEG bins from CYCLE_FROM to CYCLE_TO. */
  function meanCycle(dump, own, fullCycles) {
    if (!fullCycles.length) return null;
    var bins = Math.round((CYCLE_TO - CYCLE_FROM) / BIN_DEG);
    var angles = new Float64Array(bins);
    for (var b = 0; b < bins; b++) angles[b] = CYCLE_FROM + (b + 0.5) * BIN_DEG;
    var series = {};
    dump.channels.forEach(function (ch) {
      var sum = new Float64Array(bins);
      var cnt = new Float64Array(bins);
      var lo = new Float64Array(bins).fill(Infinity);
      var hi = new Float64Array(bins).fill(-Infinity);
      fullCycles.forEach(function (cy) {
        for (var i = cy.start; i < cy.end; i++) {
          var a = cycleAngle(own[i]);
          var bin = Math.floor((a - CYCLE_FROM) / BIN_DEG);
          if (bin < 0 || bin >= bins) continue;
          var v = ch.values[i];
          sum[bin] += v;
          cnt[bin] += 1;
          if (v < lo[bin]) lo[bin] = v;
          if (v > hi[bin]) hi[bin] = v;
        }
      });
      var avg = new Float64Array(bins);
      for (var k = 0; k < bins; k++) {
        if (cnt[k]) { avg[k] = sum[k] / cnt[k]; }
        else { avg[k] = NaN; lo[k] = NaN; hi[k] = NaN; }
      }
      series[ch.index] = { mean: avg, min: lo, max: hi };
    });
    return { angles: angles, series: series, cycles: fullCycles.length };
  }

  // ---------------------------------------------------------------- sets

  /**
   * Split files into dump sets: same reason and software, saved within 10 minutes,
   * each control unit at most once.
   */
  function groupDumps(dumps) {
    var sorted = dumps.slice().sort(function (a, b) { return a.utcMs - b.utcMs; });
    var sets = [];
    sorted.forEach(function (d) {
      var home = null;
      for (var i = sets.length - 1; i >= 0; i--) {
        var s = sets[i];
        var last = s.dumps[s.dumps.length - 1];
        var sameKind = s.reason === d.reason && s.software === d.software && s.logger === d.logger;
        var close = Math.abs(d.utcMs - last.utcMs) <= 10 * 60 * 1000;
        var taken = s.dumps.some(function (x) { return x.unitName === d.unitName; });
        if (sameKind && close && !taken) { home = s; break; }
      }
      if (!home) {
        home = { reason: d.reason, software: d.software, logger: d.logger, dumps: [] };
        sets.push(home);
      }
      home.dumps.push(d);
    });
    sets.forEach(function (s, i) {
      s.dumps.sort(function (a, b) { return (a.unitNumber || 0) - (b.unitNumber || 0) || a.unitName.localeCompare(b.unitName); });
      s.id = "set" + (i + 1);
      s.utcMs = s.dumps[0].utcMs;
    });
    return sets;
  }

  /**
   * Work out each cylinder's TDC offset from where its injections start.
   * Cylinder TDCs are evenly spaced (360/N). N is the smallest cylinder count
   * that fits every loaded cylinder, unless the user has set it.
   */
  function matchFiringOrder(dumps, cylindersSetting) {
    var entries = dumps.map(function (d) {
      var p = prepare(d);
      return { dump: d, cyl: d.unitNumber, angle: p.injectionAngleCyl1 };
    });
    var usable = entries.filter(function (e) { return e.cyl !== null && e.angle !== null; });
    var result = { cylinders: cylindersSetting || null, source: cylindersSetting ? "setting" : null, reference: "own", offsets: {}, firingOrder: null, notes: [] };

    function fit(nCyl, phi) {
      var spacing = 360 / nCyl;
      var worst = 0;
      var offsets = {};
      usable.forEach(function (e) {
        var rel = (((e.angle - phi) % 360) + 360) % 360;
        var slot = Math.round(rel / spacing) % nCyl;
        offsets[e.cyl] = (slot * spacing) % 360;
        var r = Math.abs(wrap180(rel - slot * spacing));
        if (r > worst) worst = r;
      });
      return { offsets: offsets, worst: worst };
    }

    var cyl1 = usable.filter(function (e) { return e.cyl === 1; })[0];
    var maxCyl = usable.reduce(function (m, e) { return Math.max(m, e.cyl); }, 0);
    if (!usable.length) {
      result.reference = "cyl1";
      result.notes.push("Crank angles are shown from cylinder 1 TDC, because the injection timing could not be read from these files.");
      dumps.forEach(function (d) { result.offsets[d.unitName] = 0; });
      return result;
    }

    // Without cylinder 1 loaded we assume injection starts near TDC (within half the cylinder spacing).
    function phiFor(nCyl) {
      if (cyl1) return cyl1.angle;
      var spacing = 360 / nCyl;
      return circularMean(usable.map(function (e) { return e.angle; }), spacing);
    }

    var chosen = null;
    if (cylindersSetting) {
      chosen = fit(cylindersSetting, phiFor(cylindersSetting));
    } else if (usable.length >= 2) {
      for (var nCyl = Math.max(4, maxCyl); nCyl <= 14; nCyl++) {
        var f = fit(nCyl, phiFor(nCyl));
        if (f.worst <= 4) { chosen = f; result.cylinders = nCyl; result.source = "data"; break; }
      }
    } else if (cyl1) {
      chosen = { offsets: { 1: 0 }, worst: 0 };
    }

    if (!chosen) {
      result.reference = "cyl1";
      result.notes.push("Crank angles are shown from cylinder 1 TDC. Load the cylinder 1 file as well, or set the number of cylinders under File details, to see each cylinder from its own TDC.");
      dumps.forEach(function (d) { result.offsets[d.unitName] = 0; });
      return result;
    }

    dumps.forEach(function (d) {
      var off = d.unitNumber !== null && chosen.offsets[d.unitNumber] !== undefined ? chosen.offsets[d.unitNumber] : null;
      result.offsets[d.unitName] = off === null ? 0 : off;
      if (off === null && d.unitNumber !== null) {
        result.notes.push(d.unitName + ": injection timing could not be read, so its angles are shown from cylinder 1 TDC.");
      }
    });
    if (chosen.worst > 4) {
      result.notes.push("The cylinders do not sit evenly on a " + result.cylinders + "-cylinder firing order (up to " + chosen.worst.toFixed(1) + "° off). Check the number of cylinders under File details.");
    }
    // Firing order, when every cylinder 1..N is present and distinct.
    if (result.cylinders && usable.length === result.cylinders) {
      var seen = {};
      var distinct = usable.every(function (e) {
        var key = chosen.offsets[e.cyl].toFixed(2);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
      if (distinct) {
        result.firingOrder = usable.slice().sort(function (a, b) { return chosen.offsets[a.cyl] - chosen.offsets[b.cyl]; }).map(function (e) { return e.cyl; });
      } else {
        result.notes.push("Two cylinders came out on the same crank position. Check the number of cylinders under File details.");
      }
    }
    return result;
  }

  /** Full analysis of one dump set. */
  function analyzeSet(set, options) {
    var opts = options || {};
    var dumps = set.dumps;
    dumps.forEach(prepare);
    var firing = matchFiringOrder(dumps, opts.cylinders || null);
    var cylinders = dumps.map(function (d) {
      var m = measure(d, firing.offsets[d.unitName] || 0);
      return {
        dump: d,
        name: d.unitNumber !== null ? "Cyl " + d.unitNumber : d.unitName,
        unitName: d.unitName,
        number: d.unitNumber,
        prepared: d.prepared,
        result: m,
      };
    });
    var findings = buildFindings(cylinders, firing);
    var speeds = cylinders.map(function (c) { return c.result.metrics.meanRpm; }).filter(isFinite);
    return {
      set: set,
      firing: firing,
      cylinders: cylinders,
      findings: findings,
      engineRpm: speeds.length ? mean(speeds) : null,
      comparisons: compareTable(cylinders),
    };
  }

  // ---------------------------------------------------------------- comparisons

  /** Metric definitions shared by the comparison table and the findings. */
  var METRICS = [
    { key: "injectionStart", label: "Injection starts", unit: "°", digits: 1, kind: "deg", limit: "injectionStartDeg",
      get: function (m) { return m.injectionStart && m.injectionStart.mean; },
      describe: function (diff) { return "Injection starts " + Math.abs(diff).toFixed(1) + "° " + (diff > 0 ? "later" : "earlier") + " than on the other cylinders"; } },
    { key: "plungerStroke", label: "Fuel plunger stroke", unit: "", digits: 0, kind: "pct", limit: "plungerStrokePct",
      get: function (m) { return m.plungerStroke && m.plungerStroke.mean; },
      describe: function (diff) { return "Fuel plunger stroke is " + Math.abs(diff).toFixed(1) + "% " + (diff > 0 ? "longer" : "shorter") + " than on the other cylinders, so this cylinder gets " + (diff > 0 ? "more" : "less") + " fuel"; } },
    { key: "evOpen", label: "Exhaust valve opens", unit: "°", digits: 1, kind: "deg", limit: "evOpenDeg",
      get: function (m) { return m.evOpen && m.evOpen.mean; },
      describe: function (diff) { return "Exhaust valve opens " + Math.abs(diff).toFixed(1) + "° " + (diff > 0 ? "later" : "earlier") + " than on the other cylinders"; } },
    { key: "evClose", label: "Exhaust valve closes", unit: "°", digits: 1, kind: "deg", limit: "evCloseDeg",
      get: function (m) { return m.evClose && m.evClose.mean; },
      describe: function (diff) { return "Exhaust valve closes " + Math.abs(diff).toFixed(1) + "° " + (diff > 0 ? "later" : "earlier") + " than on the other cylinders"; } },
    { key: "evLift", label: "Exhaust valve lift", unit: "", digits: 0, kind: "pct", limit: "evLiftPct",
      get: function (m) { return m.evLift && m.evLift.mean; },
      describe: function (diff) { return "Exhaust valve lift is " + Math.abs(diff).toFixed(1) + "% " + (diff > 0 ? "higher" : "lower") + " than on the other cylinders"; } },
    { key: "fivaDelay", label: "FIVA delay", unit: " ms", digits: 2, kind: "abs", limit: "fivaDelayMs", higherIsWorse: true,
      get: function (m) { return m.fiva && m.fiva.delayMs; },
      describe: function (diff) { return "FIVA valve follows its set point " + Math.abs(diff).toFixed(2) + " ms " + (diff > 0 ? "slower" : "faster") + " than on the other cylinders"; } },
    { key: "fivaGap", label: "FIVA average gap", unit: "", digits: 0, kind: "ratio", limit: "fivaGapRatio", higherIsWorse: true,
      get: function (m) { return m.fiva && m.fiva.gap; },
      describe: function (ratio) { return "FIVA feedback strays " + ratio.toFixed(1) + " times as far from the set point as on the other cylinders"; } },
  ];

  function levelFor(value, limit) {
    if (!isFinite(value)) return "ok";
    if (value >= limit.check) return "check";
    if (value >= limit.watch) return "watch";
    return "ok";
  }

  /** For each metric and cylinder: value, the others' median, difference and level. */
  function compareTable(cylinders) {
    var table = {};
    METRICS.forEach(function (metric) {
      var values = cylinders.map(function (c) { var v = metric.get(c.result.metrics); return v === undefined || v === null ? NaN : v; });
      var rows = cylinders.map(function (c, i) {
        var others = values.filter(function (v, j) { return j !== i && isFinite(v); });
        var v = values[i];
        var row = { value: v, reference: NaN, diff: NaN, level: "ok" };
        if (!isFinite(v) || others.length < 2) return row;
        var ref = median(others);
        row.reference = ref;
        var limit = LIMITS[metric.limit];
        if (metric.kind === "pct") {
          row.diff = ref ? ((v - ref) / Math.abs(ref)) * 100 : NaN;
          row.level = levelFor(Math.abs(row.diff), limit);
        } else if (metric.kind === "ratio") {
          row.diff = ref > 0 ? v / ref : NaN;
          row.level = levelFor(row.diff, limit);
        } else {
          row.diff = v - ref;
          var size = metric.higherIsWorse ? row.diff : Math.abs(row.diff);
          row.level = levelFor(size, limit);
        }
        return row;
      });
      var finite = values.filter(isFinite);
      table[metric.key] = { metric: metric, rows: rows, engineAverage: finite.length ? mean(finite) : NaN };
    });
    return table;
  }

  function buildFindings(cylinders, firing) {
    var out = [];
    var cmp = compareTable(cylinders);
    var comparable = cylinders.length >= 3;

    firing.notes.forEach(function (t) { out.push({ level: "note", cylinder: null, text: t }); });

    cylinders.forEach(function (c) {
      var m = c.result.metrics;
      var p = c.prepared;
      p.quality.forEach(function (q) { out.push({ level: q.level, cylinder: c.name, text: q.text }); });
      if (!p.roles.tacho) {
        out.push({ level: "note", cylinder: c.name, text: "No crank angle channel in this file, so cycles cannot be measured." });
      } else if (!p.crank.moving) {
        out.push({ level: "note", cylinder: c.name, text: "The crank angle does not move in this log. The engine was probably stopped." });
        return;
      }
      if (m.missedInjections > 0) {
        out.push({ level: "check", cylinder: c.name, text: "No injection in " + m.missedInjections + " of " + m.fullCycles + " cycles." });
      }
      if (m.missedValveOpenings > 0) {
        out.push({ level: "check", cylinder: c.name, text: "Exhaust valve did not open in " + m.missedValveOpenings + " of " + m.fullCycles + " cycles." });
      }
      if (m.plungerStroke && m.plungerStroke.count >= 2) {
        var spreadPct = (m.plungerStroke.spread / m.plungerStroke.mean) * 100;
        var lvl = levelFor(spreadPct, LIMITS.cycleStrokeSpreadPct);
        if (lvl !== "ok") out.push({ level: lvl, cylinder: c.name, text: "Fuel plunger stroke changes by " + spreadPct.toFixed(1) + "% from cycle to cycle." });
      }
      [["injectionStart", "Injection start"], ["evOpen", "Exhaust valve opening"], ["evClose", "Exhaust valve closing"]].forEach(function (pair) {
        var s = m[pair[0]];
        if (s && s.count >= 2) {
          var lv = levelFor(s.spread, LIMITS.cycleTimingSpreadDeg);
          if (lv !== "ok") out.push({ level: lv, cylinder: c.name, text: pair[1] + " moves by " + s.spread.toFixed(1) + "° from cycle to cycle." });
        }
      });
    });

    // Engine speed over all the logs (each control unit saves its own log, seconds apart).
    var revs = [];
    cylinders.forEach(function (c) {
      c.result.cycles.forEach(function (cy) { if (cy.full && isFinite(cy.rpm)) revs.push(cy.rpm); });
    });
    if (revs.length >= 2) {
      var lo = Math.min.apply(null, revs), hi = Math.max.apply(null, revs);
      var change = ((hi - lo) / mean(revs)) * 100;
      if (levelFor(change, LIMITS.speedChangePct) !== "ok") {
        out.push({ level: "note", cylinder: null, text: "Engine speed changed from " + lo.toFixed(1) + " to " + hi.toFixed(1) + " rpm (" + change.toFixed(1) + "%) while the logs were taken. Comparisons are less reliable while the speed changes." });
      }
    }

    if (comparable) {
      METRICS.forEach(function (metric) {
        cmp[metric.key].rows.forEach(function (row, i) {
          if (row.level === "ok") return;
          var c = cylinders[i];
          var text = metric.describe(row.diff);
          var ref = fmt(row.reference, metric.digits) + metric.unit;
          text += " (" + fmt(row.value, metric.digits) + metric.unit + " against " + ref + ").";
          out.push({ level: row.level, cylinder: c.name, metric: metric.key, text: text });
        });
      });
    } else if (cylinders.length > 0) {
      out.push({ level: "note", cylinder: null, text: "Load the dump files of three or more cylinders to compare cylinders with each other." });
    }

    var order = { check: 0, watch: 1, note: 2 };
    out.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return out;
  }

  function fmt(v, digits) {
    if (!isFinite(v)) return "-";
    return Number(v).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  return {
    ROLES: ROLES,
    METRICS: METRICS,
    LIMITS: LIMITS,
    CYCLE_FROM: CYCLE_FROM,
    CYCLE_TO: CYCLE_TO,
    prepare: prepare,
    measure: measure,
    analyzeSet: analyzeSet,
    groupDumps: groupDumps,
    matchFiringOrder: matchFiringOrder,
    cycleAngle: cycleAngle,
    crankAngle: crankAngle,
    fivaMetrics: fivaMetrics,
    quantile: quantile,
    median: median,
    fmt: fmt,
  };
});
