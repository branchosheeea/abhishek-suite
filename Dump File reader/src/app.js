/*
 * app.js - ME Dump Viewer screens: open files, Summary, Cylinder graphs,
 * Compare cylinders, File details. Uses DumpFile, DumpAnalysis and SignalChart.
 * Text from the files (names, channel names) always goes in with textContent.
 */
(function () {
  "use strict";

  var DF = window.DumpFile;
  var DA = window.DumpAnalysis;
  var Chart = window.SignalChart;

  // ---------------------------------------------------------------- constants

  var ICON = {
    check: '<svg viewBox="0 0 16 16" class="icon-check" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.2v4.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.05" fill="#fff"/></svg>',
    watch: '<svg viewBox="0 0 16 16" class="icon-watch" aria-hidden="true"><path d="M8 1.6 15 14.2H1z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8 6.2v3.6" stroke="#0b0b0b" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.9" r=".95" fill="#0b0b0b"/></svg>',
    note: '<svg viewBox="0 0 16 16" class="icon-note" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.8" r=".95" fill="currentColor"/></svg>',
    ok: '<svg viewBox="0 0 16 16" class="icon-ok" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  var LEVEL_LABEL = { check: "Check", watch: "Worth a look", note: "Note", ok: "OK" };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** Panels on the Cylinder graphs tab, top to bottom. */
  var PANELS = [
    { title: "FIVA valve", roles: ["fivaSet", "fivaFeedback"], height: 150 },
    { title: "FIVA controller output", roles: ["fivaController"], height: 90 },
    { title: "Fuel plunger position", roles: ["plunger"], height: 130 },
    { title: "Exhaust valve position", roles: ["exhaustValve"], height: 130 },
  ];
  var PAIR_LABEL = { fivaSet: "Set point", fivaFeedback: "Feedback" };
  var PAIR_COLOR = { fivaSet: "--series-1", fivaFeedback: "--series-2" };

  var COMPARE_SIGNALS = [
    { role: "plunger", label: "Fuel plunger", metrics: ["injectionStart", "plungerStroke"], range: "injection" },
    { role: "exhaustValve", label: "Exhaust valve", metrics: ["evOpen", "evClose", "evLift"], range: "cycle" },
    { role: "fivaFeedback", label: "FIVA feedback", metrics: ["fivaDelay", "fivaGap"], range: "cycle" },
    { role: "fivaSet", label: "FIVA set point", metrics: ["fivaDelay", "fivaGap"], range: "cycle" },
    { role: "fivaController", label: "FIVA controller", metrics: ["fivaDelay", "fivaGap"], range: "cycle" },
  ];
  var RANGES = [
    { key: "cycle", label: "Whole cycle", view: [-45, 315] },
    { key: "injection", label: "Injection", view: [-15, 75] },
    { key: "evOpen", label: "Valve opening", view: [95, 165] },
    { key: "evClose", label: "Valve closing", view: [235, 305] },
  ];
  /** Where "Show" on a finding takes you. */
  var METRIC_VIEW = {
    injectionStart: { tab: "compare", signal: "plunger", range: "injection" },
    plungerStroke: { tab: "compare", signal: "plunger", range: "injection" },
    evOpen: { tab: "compare", signal: "exhaustValve", range: "evOpen" },
    evClose: { tab: "compare", signal: "exhaustValve", range: "evClose" },
    evLift: { tab: "compare", signal: "exhaustValve", range: "cycle" },
    fivaDelay: { tab: "graphs", mode: "angle" },
    fivaGap: { tab: "graphs", mode: "angle" },
  };
  var METRIC_UNIT_NOTE = {
    injectionStart: "° after TDC",
    plungerStroke: "logged units",
    evOpen: "° after TDC",
    evClose: "° after TDC",
    evLift: "logged units",
    fivaDelay: "ms",
    fivaGap: "logged units",
  };

  // ---------------------------------------------------------------- state

  var state = {
    dumps: [],
    sets: [],
    setId: null,
    analysis: null,
    cylinderSetting: {},
    tab: "summary",
    errors: [],
    graphs: { cyl: 0, mode: "time", cycleIdx: null, view: null },
    compare: { signal: "plunger", range: "injection", highlight: 0, view: null },
    charts: { graphs: null, compare: null },
  };

  // ---------------------------------------------------------------- DOM helpers

  function $(sel, el) { return (el || document).querySelector(sel); }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "icon") el.insertAdjacentHTML("afterbegin", ICON[v] || ""); // static icons only
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === null || children === undefined) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { append(el, c); return; }
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function chip(level, text) {
    return h("span", { class: "chip " + level, icon: level }, text || LEVEL_LABEL[level]);
  }

  function seg(options, current, onPick, label) {
    return h("div", { class: "seg", role: "group", "aria-label": label || null }, options.map(function (o) {
      return h("button", {
        type: "button",
        "aria-pressed": String(o.value === current),
        disabled: o.disabled || null,
        title: o.title || null,
        onclick: function () { if (o.value !== current) onPick(o.value); },
      }, [o.label, o.mark ? h("span", { class: "mark " + o.mark, "aria-hidden": "true" }) : null]);
    }));
  }

  function group(label, content) {
    return h("div", { class: "group" }, [label ? h("span", { class: "group-label" }, label) : null, content]);
  }

  // ---------------------------------------------------------------- formatting

  function num(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    var s = Number(v).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
    return s.replace(/^-/, "−");
  }

  function signed(v, digits) {
    if (!isFinite(v)) return "–";
    var s = num(Math.abs(v), digits);
    if (Number(Math.abs(v).toFixed(digits)) === 0) return s;
    return (v > 0 ? "+" : "−") + s;
  }

  function deg(v) { return isFinite(v) ? num(v, 1) + "°" : "–"; }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function dateParts(utcMs, offsetMin) {
    var d = new Date(utcMs + offsetMin * 60000);
    return {
      date: d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear(),
      hm: pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()),
      hms: pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds()),
    };
  }

  function utcLabel(offsetMin) {
    if (!offsetMin) return "UTC";
    var sign = offsetMin > 0 ? "+" : "−";
    var m = Math.abs(offsetMin);
    return "UTC" + sign + Math.floor(m / 60) + (m % 60 ? ":" + pad2(m % 60) : "");
  }

  function digitsFor(ch) {
    return ch.gain === 1 && ch.offset === 0 ? 0 : 1;
  }

  function metricValue(metric, v) {
    if (metric.kind === "deg") return deg(v);
    return num(v, metric.digits) + (metric.unit === " ms" ? " ms" : "");
  }

  function metricDiff(metric, row) {
    if (!isFinite(row.diff)) return "";
    if (metric.kind === "pct") return signed(row.diff, 1) + "%";
    if (metric.kind === "ratio") return "×" + num(row.diff, 1);
    if (metric.kind === "deg") return signed(row.diff, 1) + "°";
    return signed(row.diff, metric.digits) + metric.unit;
  }

  // ---------------------------------------------------------------- files

  function openPicker() { $("#file-input").click(); }

  function loadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var errors = [];
    var added = [];
    Promise.all(files.map(function (f) {
      return f.arrayBuffer().then(function (buf) {
        try {
          var d = DF.parse(buf, f.name);
          var dup = state.dumps.some(function (x) { return x.fileName === d.fileName && x.utcMs === d.utcMs && x.unitName === d.unitName; });
          if (!dup) { state.dumps.push(d); added.push(d); }
        } catch (err) {
          errors.push({ name: f.name, message: err && err.name === "DumpFormatError" ? err.message : "Could not read the file (" + (err && err.message) + ")." });
        }
      }, function (err) {
        errors.push({ name: f.name, message: "Could not open the file (" + (err && err.message) + ")." });
      });
    })).then(function () {
      state.errors = errors;
      if (!state.dumps.length) { renderStartNotices(); return; }
      state.sets = DA.groupDumps(state.dumps);
      var target = added.length ? added[0] : null;
      var set = target ? state.sets.filter(function (s) { return s.dumps.indexOf(target) >= 0; })[0] : null;
      state.setId = (set || state.sets[state.sets.length - 1]).id;
      if (added.length) { state.graphs.cyl = 0; state.graphs.view = null; }
      analyzeCurrent(added.length > 0);
      showWorkspace();
    }).catch(reportError);
  }

  function currentSet() {
    return state.sets.filter(function (s) { return s.id === state.setId; })[0] || state.sets[0];
  }

  function setKey(set) {
    return set.dumps.map(function (d) { return d.fileName + "@" + d.utcMs; }).join("|");
  }

  /** @param {boolean} fresh true for a newly opened dump: Compare then starts on the first finding. */
  function analyzeCurrent(fresh) {
    var set = currentSet();
    var n = state.cylinderSetting[setKey(set)] || null;
    state.analysis = DA.analyzeSet(set, { cylinders: n });
    var cyls = state.analysis.cylinders;
    if (state.graphs.cyl >= cyls.length) state.graphs.cyl = 0;
    if (state.compare.highlight >= cyls.length) state.compare.highlight = 0;
    if (fresh) {
      var first = null;
      state.analysis.findings.some(function (f) {
        if (f.level === "note" || !f.cylinder || indexOfCylinder(f.cylinder) < 0) return false;
        first = f;
        return true;
      });
      state.compare.highlight = first ? indexOfCylinder(first.cylinder) : 0;
      var view = first && first.metric ? METRIC_VIEW[first.metric] : null;
      if (view && view.tab === "compare") {
        state.compare.signal = view.signal;
        state.compare.range = view.range;
      } else {
        state.compare.signal = "plunger";
        state.compare.range = "injection";
      }
      state.compare.view = null;
    }
    var available = COMPARE_SIGNALS.filter(function (s) { return cyls.some(function (c) { return c.prepared.roles[s.role]; }); });
    if (!available.some(function (s) { return s.role === state.compare.signal; }) && available.length) {
      state.compare.signal = available[0].role;
      state.compare.range = available[0].range;
    }
  }

  function indexOfCylinder(name) {
    var cyls = state.analysis.cylinders;
    for (var i = 0; i < cyls.length; i++) if (cyls[i].name === name) return i;
    return -1;
  }

  function closeFiles() {
    destroyCharts();
    state.dumps = [];
    state.sets = [];
    state.setId = null;
    state.analysis = null;
    state.errors = [];
    state.tab = "summary";
    $("#workspace").hidden = true;
    $("#start").hidden = false;
    $("#btn-print").hidden = true;
    $("#btn-close").hidden = true;
    $("#file-input").value = "";
    renderStartNotices();
  }

  function destroyCharts() {
    ["graphs", "compare"].forEach(function (k) {
      if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
    });
  }

  // ---------------------------------------------------------------- shell

  function showWorkspace() {
    $("#start").hidden = true;
    $("#workspace").hidden = false;
    $("#btn-print").hidden = false;
    $("#btn-close").hidden = false;
    renderHead();
    renderNotices();
    showTab(state.tab);
  }

  function renderStartNotices() {
    var box = clear($("#start-notices"));
    if (state.errors.length) box.appendChild(errorNotice());
  }

  function errorNotice() {
    var n = state.errors.length;
    return h("div", { class: "notice", role: "alert" }, [
      h("div", null, [
        h("b", null, n === 1 ? "1 file could not be read" : n + " files could not be read"),
        h("ul", null, state.errors.map(function (e) { return h("li", null, [h("b", null, e.name), " – " + e.message]); })),
      ]),
      h("button", { class: "btn small ghost", type: "button", onclick: function () { state.errors = []; renderNotices(); renderStartNotices(); } }, "Dismiss"),
    ]);
  }

  function renderNotices() {
    var box = clear($("#notices"));
    if (state.errors.length) box.appendChild(errorNotice());
  }

  function renderHead() {
    var a = state.analysis;
    var set = a.set;
    var first = set.dumps[0];
    var last = set.dumps[set.dumps.length - 1];
    var t0 = dateParts(first.utcMs, first.utcOffsetMinutes);
    var t1 = dateParts(last.utcMs, last.utcOffsetMinutes);
    $("#dump-title").textContent = (first.reasonText || "Dump") + " – " + t0.date + ", " + t0.hm;
    var units = set.dumps.length > 1 ? set.dumps[0].unitName + "–" + last.unitName : first.unitName;
    var when = t0.hms === t1.hms ? t0.hms : t0.hms + "–" + t1.hms;
    var parts = [
      "Saved by " + units + " at " + when + " local time (" + utcLabel(first.utcOffsetMinutes) + ")",
      first.software,
    ];
    if (first.reasonCode) parts.push("reason code " + first.reasonCode);
    $("#dump-sub").textContent = parts.filter(Boolean).join(" · ");
    document.title = (first.reasonText || "Dump") + " " + t0.date + " – ME Dump Viewer";

    var wrap = $("#set-picker-wrap");
    var picker = clear($("#set-picker"));
    wrap.hidden = state.sets.length < 2;
    state.sets.forEach(function (s) {
      var d = s.dumps[0];
      var t = dateParts(d.utcMs, d.utcOffsetMinutes);
      var opt = h("option", { value: s.id }, t.date + " " + t.hm + " · " + (d.reasonText || "Dump") + " · " + s.dumps.length + (s.dumps.length === 1 ? " file" : " files"));
      if (s.id === state.setId) opt.selected = true;
      picker.appendChild(opt);
    });
  }

  function showTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.getAttribute("data-tab") === tab));
      b.tabIndex = b.getAttribute("data-tab") === tab ? 0 : -1;
    });
    ["summary", "graphs", "compare", "details"].forEach(function (t) { $("#tab-" + t).hidden = t !== tab; });
    destroyCharts();
    try {
      if (tab === "summary") renderSummary();
      else if (tab === "graphs") renderGraphs();
      else if (tab === "compare") renderCompare();
      else renderDetails();
    } catch (err) {
      reportError(err);
    }
  }

  // ---------------------------------------------------------------- summary

  function renderSummary() {
    var a = state.analysis;
    var box = clear($("#tab-summary"));
    var cyls = a.cylinders;
    var checks = a.findings.filter(function (f) { return f.level === "check"; });
    var watches = a.findings.filter(function (f) { return f.level === "watch"; });
    var notes = a.findings.filter(function (f) { return f.level === "note"; });
    var cycles = cyls.reduce(function (s, c) { return s + (c.result.metrics.fullCycles || 0); }, 0);
    var measured = cyls.filter(function (c) { return c.result.metrics.fullCycles; }).length;

    var level, headline;
    if (checks.length) {
      level = "check";
      headline = checks.length === 1 ? "1 thing to check" : checks.length + " things to check";
      if (watches.length) headline += ", " + watches.length + " worth a look";
    } else if (watches.length) {
      level = "watch";
      headline = watches.length === 1 ? "1 thing worth a look" : watches.length + " things worth a look";
    } else if (measured) {
      level = "ok";
      headline = measured === 1 ? "Nothing stands out" : "Nothing stands out – the cylinders look alike";
    } else {
      level = "note";
      headline = "No engine cycles to measure";
    }
    var what = [];
    var anyRole = function (k) { return cyls.some(function (c) { return c.prepared.roles[k]; }); };
    if (anyRole("plunger")) what.push("injection timing and fuel plunger stroke");
    if (anyRole("exhaustValve")) what.push("exhaust valve timing and lift");
    if (anyRole("fivaSet") && anyRole("fivaFeedback")) what.push("FIVA valve response");
    var sub = measured
      ? "Checked " + (what.length ? what.join(", ") : "the signals") + " on " + measured + (measured === 1 ? " cylinder" : " cylinders") + ", over " + cycles + " full engine cycles."
      : "The logs do not hold a full engine cycle, so nothing could be measured. The graphs still show the signals.";

    box.appendChild(h("div", { class: "card banner" }, [
      h("span", { class: "banner-icon", icon: level }),
      h("div", null, [h("h2", null, headline), h("p", null, sub)]),
    ]));
    var bannerIcon = box.querySelector(".banner-icon svg");
    if (bannerIcon) { bannerIcon.setAttribute("width", "36"); bannerIcon.setAttribute("height", "36"); }

    // tiles
    var firing = a.firing;
    var first = a.set.dumps[0];
    var tiles = [
      { label: "Engine speed", value: a.engineRpm ? num(a.engineRpm, 1) : "–", unit: a.engineRpm ? "rpm" : "", sub: a.engineRpm ? "average over the logs" : "crank angle not moving" },
      { label: "Cylinders loaded", value: firing.cylinders ? cyls.length + " of " + firing.cylinders : String(cyls.length), sub: firing.firingOrder ? "Firing order " + firing.firingOrder.join("-") : (firing.cylinders ? "engine has " + firing.cylinders + " cylinders" : "") },
      { label: "Log length", value: num(first.durationS, 2), unit: "s", sub: "per cylinder, a sample every " + num(first.sampleIntervalUs / 1000, first.sampleIntervalUs % 1000 ? 2 : 0) + " ms" },
    ];
    box.appendChild(h("div", { class: "tiles" }, tiles.map(function (t) {
      return h("div", { class: "tile" }, [
        h("div", { class: "tile-label" }, t.label),
        h("div", { class: "tile-value" }, [t.value, t.unit ? h("small", null, " " + t.unit) : null]),
        t.sub ? h("div", { class: "tile-sub" }, t.sub) : null,
      ]);
    })));

    // findings
    var main = checks.concat(watches);
    var list = h("ul", { class: "findings" });
    if (!main.length) {
      list.appendChild(h("li", { class: "all-good" }, [chip("ok", "OK"), measured ? "Every measured value is within the normal range of the other cylinders." : "Nothing to compare."]));
    }
    main.concat(notes).forEach(function (f) {
      var idx = f.cylinder ? indexOfCylinder(f.cylinder) : -1;
      list.appendChild(h("li", { class: "finding " + f.level }, [
        chip(f.level),
        h("span", { class: "who" }, f.cylinder || "Engine"),
        h("span", { class: "what" }, f.text),
        idx >= 0 ? h("button", { class: "btn small", type: "button", onclick: function () { showFinding(f, idx); } }, "Show") : h("span"),
      ]));
    });
    box.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, "What stands out"), h("p", null, "Each cylinder is compared with the other cylinders in this dump.")]),
      list,
    ]));

    // table
    box.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [
        h("h2", null, "Cylinder by cylinder"),
        h("button", { class: "btn small no-print", type: "button", onclick: downloadSummaryCsv }, "Download table (CSV)"),
      ]),
      comparisonTable(DA.METRICS.map(function (m) { return m.key; }), function (i) { state.graphs.cyl = i; state.graphs.view = null; showTab("graphs"); }, null),
      h("p", { class: "small-print", style: "margin-top:10px" },
        "Averages over the full cycles in each log. Angles are degrees after each cylinder’s own top dead centre (TDC). " +
        "Strokes, lifts and gaps are in the logger’s own units, so compare them between cylinders rather than reading them as millimetres. " +
        "Click a cylinder to see its graphs."),
    ]));
  }

  /** Table of metrics per cylinder, flagged cells marked. */
  function comparisonTable(metricKeys, onRow, currentIndex) {
    var a = state.analysis;
    var cmp = a.comparisons;
    var cyls = a.cylinders;
    var metrics = metricKeys.map(function (k) { return cmp[k]; }).filter(function (m) {
      return m && m.rows.some(function (r) { return isFinite(r.value); });
    });
    var head = h("tr", null, [h("th", null, "Cylinder")].concat(metrics.map(function (m) {
      return h("th", null, [m.metric.label, h("small", null, METRIC_UNIT_NOTE[m.metric.key] || "")]);
    })));
    var body = h("tbody");
    cyls.forEach(function (c, i) {
      var tr = h("tr", {
        class: (onRow ? "clickable" : "") + (i === currentIndex ? " current" : ""),
        tabindex: onRow ? "0" : null,
        onclick: onRow ? function () { onRow(i); } : null,
        onkeydown: onRow ? function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRow(i); } } : null,
      }, [h("td", null, h("span", { class: "cyl-name" }, c.name))]);
      metrics.forEach(function (m) {
        var row = m.rows[i];
        var text = metricValue(m.metric, row.value);
        var title = isFinite(row.reference) ? "Other cylinders: " + metricValue(m.metric, row.reference) + (isFinite(row.diff) ? " (" + metricDiff(m.metric, row) + ")" : "") : null;
        var cell;
        if (row.level !== "ok") {
          cell = h("td", { title: title }, [
            h("span", { class: "flag " + row.level, icon: row.level }, [text, h("span", { class: "sr-only", style: "position:absolute;left:-9999px" }, " (" + LEVEL_LABEL[row.level] + ")")]),
            h("span", { class: "diff" }, metricDiff(m.metric, row) + " vs others"),
          ]);
        } else {
          cell = h("td", { title: title }, text);
        }
        tr.appendChild(cell);
      });
      body.appendChild(tr);
    });
    var foot = h("tfoot", null, h("tr", null, [h("td", null, "Engine average")].concat(metrics.map(function (m) {
      return h("td", null, metricValue(m.metric, m.engineAverage));
    }))));
    return h("div", { class: "table-wrap" }, h("table", null, [h("thead", null, head), body, foot]));
  }

  function showFinding(f, idx) {
    var view = f.metric ? METRIC_VIEW[f.metric] : null;
    if (view && view.tab === "compare") {
      state.compare.signal = view.signal;
      state.compare.range = view.range;
      state.compare.highlight = idx;
      state.compare.view = null;
      showTab("compare");
    } else {
      state.graphs.cyl = idx;
      state.graphs.view = null;
      state.graphs.cycleIdx = null;
      var cyl = state.analysis.cylinders[idx];
      var canAngle = cyl.result.ownAngle && cyl.result.cycles.length;
      state.graphs.mode = view && view.mode === "angle" && canAngle ? "angle" : state.graphs.mode;
      showTab("graphs");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------- cylinder graphs

  /** Groups of signals for one cylinder, per panel. */
  function graphLines(cyl) {
    var p = cyl.prepared;
    var roles = p.roles;
    var lines = [];
    PANELS.forEach(function (def) {
      var present = def.roles.filter(function (k) { return roles[k]; });
      if (!present.length) return;
      var groups = present.map(function (k) {
        var ch = roles[k];
        return {
          key: k,
          label: present.length > 1 ? PAIR_LABEL[k] : ch.label,
          color: PAIR_COLOR[k] || "--series-1",
          values: ch.values,
          digits: digitsFor(ch),
          channel: ch,
        };
      });
      lines.push({ title: def.title, height: def.height, legend: groups.length > 1 ? groups.map(function (g) { return { label: g.label, color: g.color }; }) : null, groups: groups });
    });
    if (p.crank && p.crank.moving) {
      lines.push({ title: "Engine speed", note: "rpm, worked out from the crank angle", height: 80, groups: [{ key: "rpm", label: "Engine speed", color: "--series-1", values: p.crank.rpm, digits: 1, unit: " rpm" }] });
    }
    cyl.dump.channels.forEach(function (ch) {
      if (ch.role) return;
      lines.push({ title: ch.name, height: 100, groups: [{ key: "ch" + ch.index, label: ch.name, color: "--series-1", values: ch.values, digits: digitsFor(ch), channel: ch }] });
    });
    return lines;
  }

  function cycleShift(own, cy) {
    var mid = Math.floor((cy.start + cy.end - 1) / 2);
    return own[mid] - DA.cycleAngle(own[mid]);
  }

  function graphData(cyl, mode) {
    var p = cyl.prepared;
    var r = cyl.result;
    var lines = graphLines(cyl);
    if (mode === "angle") {
      var own = r.ownAngle;
      var cycles = r.cycles.map(function (cy) {
        var shift = cycleShift(own, cy);
        var xs = new Float64Array(cy.end - cy.start);
        for (var i = cy.start; i < cy.end; i++) xs[i - cy.start] = own[i] - shift;
        return { cy: cy, x: xs };
      });
      return {
        xKind: "angle",
        domain: [DA.CYCLE_FROM, DA.CYCLE_TO],
        minSpan: 2,
        xLabel: "Crank angle, degrees after this cylinder’s TDC",
        markers: [{ x: 0, label: "TDC" }],
        panels: lines.map(function (l) {
          var series = [];
          l.groups.forEach(function (g) {
            cycles.forEach(function (c) {
              series.push({
                id: g.key + "#" + c.cy.number,
                group: g.key,
                full: c.cy.full,
                label: g.label,
                x: c.x,
                y: g.values.subarray(c.cy.start, c.cy.end),
                color: g.color,
                width: 1.5,
                alpha: c.cy.full ? 0.9 : 0.3,
                hoverable: false,
              });
            });
          });
          return { title: l.title, note: l.note, height: l.height, legend: l.legend, series: series, groups: l.groups };
        }),
      };
    }
    var markers = [];
    if (r.ownAngle) {
      var o = r.ownAngle;
      var k0 = Math.ceil(o[0] / 360);
      for (var i = 1; i < o.length; i++) {
        var k = Math.floor(o[i] / 360);
        if (k >= k0 && Math.floor(o[i - 1] / 360) < k) markers.push({ x: p.time[i], label: "TDC" });
      }
    }
    return {
      xKind: "time",
      domain: [0, p.time[p.time.length - 1]],
      minSpan: (cyl.dump.sampleIntervalUs / 1e6) * 20,
      xLabel: "Seconds from start of log",
      markers: markers,
      panels: lines.map(function (l) {
        return {
          title: l.title, note: l.note, height: l.height, legend: l.legend, groups: l.groups,
          series: l.groups.map(function (g) {
            return { id: g.key, group: g.key, label: g.label, x: p.time, y: g.values, color: g.color, width: 1.5, dot: true, hoverable: false };
          }),
        };
      }),
    };
  }

  function graphTooltip(cyl, data) {
    var p = cyl.prepared;
    var r = cyl.result;
    var dt = cyl.dump.sampleIntervalUs / 1e6;
    return function (x) {
      var rows = [];
      if (data.xKind === "time") {
        var i = Math.max(0, Math.min(cyl.dump.sampleCount - 1, Math.round(x / dt)));
        data.panels.forEach(function (panel) {
          if (data.panels.length > 1) rows.push({ heading: panel.title });
          panel.groups.forEach(function (g) {
            rows.push({ color: g.color, value: num(g.values[i], g.digits) + (g.unit || ""), label: panel.groups.length > 1 ? g.label : (g.channel ? g.channel.name : g.label) });
          });
        });
        var sub = "";
        if (r.ownAngle) {
          sub = "Crank " + deg(DA.cycleAngle(r.ownAngle[i])) + " after TDC · " + num(p.crank.rpm[i], 1) + " rpm";
        }
        return { title: "Time " + num(i * dt, 4) + " s", sub: sub, rows: rows };
      }
      data.panels.forEach(function (panel) {
        if (data.panels.length > 1) rows.push({ heading: panel.title });
        panel.groups.forEach(function (g) {
          var vals = [];
          panel.series.forEach(function (s) {
            if (s.group !== g.key || !s.full) return;
            var v = Chart.valueAt(s, x);
            if (isFinite(v)) vals.push(v);
          });
          if (!vals.length) return;
          var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
          var avg = vals.reduce(function (s, v) { return s + v; }, 0) / vals.length;
          var label = panel.groups.length > 1 ? g.label : (g.channel ? g.channel.name : g.label);
          if (vals.length > 1) label += " · " + num(lo, g.digits) + " to " + num(hi, g.digits);
          rows.push({ color: g.color, value: num(avg, g.digits) + (g.unit || ""), label: label });
        });
      });
      var n = r.cycles.filter(function (c) { return c.full; }).length;
      return { title: deg(x) + " after TDC", sub: "Average of " + n + " full " + (n === 1 ? "cycle" : "cycles") + " (range in grey)", rows: rows };
    };
  }

  function renderGraphs() {
    var a = state.analysis;
    var box = clear($("#tab-graphs"));
    var cyls = a.cylinders;
    var g = state.graphs;
    var cyl = cyls[g.cyl];
    var canAngle = !!(cyl.result.ownAngle && cyl.result.cycles.length);
    if (!canAngle) g.mode = "time";
    var full = cyl.result.cycles.filter(function (c) { return c.full; });
    if (g.mode !== "time") g.cycleIdx = null;

    var levelOf = cylinderLevels();
    var cycleLabel = h("span", { class: "cycle-label" });
    var prev = h("button", { class: "btn small", type: "button", onclick: function () { stepCycle(-1); } }, "◀ Previous cycle");
    var next = h("button", { class: "btn small", type: "button", onclick: function () { stepCycle(1); } }, "Next cycle ▶");
    var whole = h("button", { class: "btn small", type: "button", onclick: function () { g.cycleIdx = null; g.view = null; chart.reset(); updateCycleNav(); } }, "Whole log");

    var toolbar = h("div", { class: "toolbar" }, [
      group("Cylinder", seg(cyls.map(function (c, i) { return { value: i, label: c.name, mark: levelOf[i] }; }), g.cyl, function (i) {
        g.cyl = i; g.cycleIdx = null;
        if (g.mode === "time") g.view = null;
        renderGraphs();
      }, "Cylinder")),
      group("Show against", seg([
        { value: "time", label: "Time" },
        { value: "angle", label: "Crank angle", disabled: !canAngle, title: canAngle ? "All cycles on top of each other" : "No crank angle in this log" },
      ], g.mode, function (m) { g.mode = m; g.view = null; g.cycleIdx = null; renderGraphs(); }, "X axis")),
      g.mode === "time" && full.length ? group(null, [whole, prev, cycleLabel, next]) : null,
    ]);
    box.appendChild(toolbar);

    var host = h("div", { "aria-label": "Graphs for " + cyl.name });
    box.appendChild(h("div", { class: "card chart-card" }, [
      h("div", { class: "chart-head" }, [
        h("p", { class: "hint" }, g.mode === "angle"
          ? "Every cycle of the log on top of the others, from 45° before TDC. Faint lines are the part cycles at the ends of the log. Drag across the graph to zoom in, double-click to zoom out."
          : "Drag across the graph to zoom in. Scroll to zoom, double-click to zoom out. Arrow keys move left and right when the graph is selected."),
        h("div", { class: "chart-actions no-print" }, [
          h("button", { class: "btn small", type: "button", onclick: function () { downloadCylinderCsv(cyl); } }, "Download data (CSV)"),
          h("button", { class: "btn small", type: "button", onclick: function () { savePicture(chart, cyl.name + " – " + (g.mode === "angle" ? "cycles on top of each other" : "signals against time"), cyl.unitName + "-graphs.png"); } }, "Save picture"),
        ]),
      ]),
      host,
    ]));

    var data = graphData(cyl, g.mode);
    var chart = new Chart(host, {
      tooltip: graphTooltip(cyl, data),
      onView: function (view, zoomed) { g.view = zoomed ? view : null; g.cycleIdx = null; updateCycleNav(); },
    });
    state.charts.graphs = chart;
    if (g.view) data.view = g.view;
    chart.setData(data);

    function viewForCycle(idx) {
      var cy = full[idx];
      var t = cyl.prepared.time;
      return [t[cy.start], t[Math.min(cy.end, t.length - 1)]];
    }
    function stepCycle(dir) {
      var idx;
      if (g.cycleIdx === null) {
        var mid = (chart.view[0] + chart.view[1]) / 2;
        var t = cyl.prepared.time;
        idx = 0;
        full.forEach(function (c, i) { if (t[c.start] <= mid) idx = i; });
        if (chart.isZoomed()) idx = Math.max(0, Math.min(full.length - 1, idx + (dir > 0 ? 1 : -1)));
        else idx = dir > 0 ? 0 : full.length - 1;
      } else {
        idx = Math.max(0, Math.min(full.length - 1, g.cycleIdx + dir));
      }
      g.cycleIdx = idx;
      g.view = viewForCycle(idx);
      chart.setView(g.view, true);
      updateCycleNav();
    }
    function updateCycleNav() {
      if (g.mode !== "time" || !full.length) return;
      if (g.cycleIdx === null) {
        cycleLabel.textContent = chart.isZoomed() ? "Zoomed in" : full.length + " full cycles";
        prev.disabled = false;
        next.disabled = false;
      } else {
        cycleLabel.textContent = "Cycle " + (g.cycleIdx + 1) + " of " + full.length;
        prev.disabled = g.cycleIdx === 0;
        next.disabled = g.cycleIdx === full.length - 1;
      }
      whole.disabled = !chart.isZoomed();
    }
    if (g.cycleIdx !== null && full[g.cycleIdx]) chart.setView(viewForCycle(g.cycleIdx), true);
    updateCycleNav();

    box.appendChild(h("div", { class: "two-col" }, [cycleTableCard(cyl), cylinderFactsCard(cyl)]));
  }

  function cylinderLevels() {
    var levels = {};
    state.analysis.findings.forEach(function (f) {
      if (!f.cylinder || f.level === "note") return;
      var i = indexOfCylinder(f.cylinder);
      if (i < 0) return;
      if (f.level === "check" || !levels[i]) levels[i] = f.level;
    });
    return levels;
  }

  function cycleTableCard(cyl) {
    var r = cyl.result;
    var full = r.cycles.filter(function (c) { return c.full; });
    var roles = cyl.prepared.roles;
    var cols = [
      { label: "Cycle", get: function (c, i) { return String(i + 1); } },
      { label: "Starts at", sub: "s", get: function (c) { return num(c.startTimeS, 3); } },
      { label: "Speed", sub: "rpm", get: function (c) { return num(c.rpm, 2); } },
    ];
    if (roles.plunger) {
      cols.push({ label: "Injection starts", sub: "° after TDC", get: function (c) { return c.injection ? deg(c.injection.startDeg) : "none"; } });
      cols.push({ label: "Plunger stroke", sub: "logged units", get: function (c) { return c.injection ? num(c.injection.stroke, 0) : "–"; } });
    }
    if (roles.exhaustValve) {
      cols.push({ label: "Valve opens", sub: "° after TDC", get: function (c) { return c.exhaust ? deg(c.exhaust.openDeg) : "did not open"; } });
      cols.push({ label: "Valve closes", sub: "° after TDC", get: function (c) { return c.exhaust ? deg(c.exhaust.closeDeg) : "–"; } });
      cols.push({ label: "Valve lift", sub: "logged units", get: function (c) { return c.exhaust ? num(c.exhaust.lift, 0) : "–"; } });
    }
    var content;
    if (!full.length) {
      content = h("p", { class: "muted" }, "This log does not hold a full engine cycle.");
    } else {
      content = h("div", { class: "table-wrap" }, h("table", null, [
        h("thead", null, h("tr", null, cols.map(function (c) { return h("th", null, [c.label, c.sub ? h("small", null, c.sub) : null]); }))),
        h("tbody", null, full.map(function (cy, i) {
          return h("tr", null, cols.map(function (c) { return h("td", null, c.get(cy, i)); }));
        })),
      ]));
    }
    return h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, "Cycle by cycle"), h("p", null, full.length + " full " + (full.length === 1 ? "cycle" : "cycles") + " in this log")]),
      content,
    ]);
  }

  function cylinderFactsCard(cyl) {
    var m = cyl.result.metrics;
    var p = cyl.prepared;
    var items = [];
    var firing = state.analysis.firing;
    if (isFinite(m.meanRpm)) items.push(["Engine speed", num(m.meanRpm, 1) + " rpm"]);
    if (firing.reference === "own" && cyl.number !== null) items.push(["TDC after cylinder 1 TDC", num(cyl.result.offsetDeg, 1) + "°"]);
    if (m.fiva) {
      items.push(["FIVA delay", num(m.fiva.delayMs, 2) + " ms"]);
      items.push(["FIVA average gap", num(m.fiva.gap, 0)]);
      items.push(["FIVA gap once the delay is allowed for", num(m.fiva.gapAfterDelay, 0)]);
      items.push(["FIVA largest gap", num(m.fiva.worstGap, 0) + " at " + num(p.time[m.fiva.worstGapIndex], 3) + " s"]);
    }
    if (isFinite(m.fivaControllerMean)) items.push(["FIVA controller average output", num(m.fivaControllerMean, 1)]);
    if (isFinite(m.plungerRest)) items.push(["Fuel plunger at rest", num(m.plungerRest, 0)]);
    if (isFinite(m.evClosedLevel)) items.push(["Exhaust valve closed position", num(m.evClosedLevel, 0)]);
    var t = dateParts(cyl.dump.utcMs, cyl.dump.utcOffsetMinutes);
    items.push(["Log saved", t.date + " " + t.hms]);
    return h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, cyl.name + " in numbers"), h("p", null, cyl.dump.fileName)]),
      h("dl", { class: "facts" }, items.map(function (it) { return h("div", null, [h("dt", null, it[0]), h("dd", null, it[1])]); })),
    ]);
  }

  // ---------------------------------------------------------------- compare

  function renderCompare() {
    var a = state.analysis;
    var box = clear($("#tab-compare"));
    var cyls = a.cylinders;
    var cmp = state.compare;
    var available = COMPARE_SIGNALS.filter(function (s) { return cyls.some(function (c) { return c.prepared.roles[s.role] && c.result.meanCycle; }); });
    if (!available.length) {
      box.appendChild(h("div", { class: "card" }, h("p", { class: "muted" }, "These logs have no full engine cycles with known signals, so the cylinders cannot be laid on top of each other.")));
      return;
    }
    var signal = available.filter(function (s) { return s.role === cmp.signal; })[0] || available[0];
    cmp.signal = signal.role;
    var range = RANGES.filter(function (r) { return r.key === cmp.range; })[0] || RANGES[0];
    var levelOf = cylinderLevels();

    box.appendChild(h("div", { class: "toolbar" }, [
      group("Signal", seg(available.map(function (s) { return { value: s.role, label: s.label }; }), signal.role, function (role) {
        var s = COMPARE_SIGNALS.filter(function (x) { return x.role === role; })[0];
        cmp.signal = role; cmp.range = s.range; cmp.view = null; renderCompare();
      }, "Signal")),
      group("Part of the cycle", seg(RANGES.map(function (r) { return { value: r.key, label: r.label }; }), range.key, function (key) {
        cmp.range = key; cmp.view = null; renderCompare();
      }, "Part of the cycle")),
    ]));
    box.appendChild(h("div", { class: "toolbar" }, [
      group("Highlight", seg(cyls.map(function (c, i) { return { value: i, label: c.name, mark: levelOf[i], disabled: !c.result.meanCycle }; }), cmp.highlight, function (i) {
        cmp.highlight = i; renderCompare();
      }, "Highlight cylinder")),
    ]));

    var hl = cyls[cmp.highlight];
    var series = [];
    var digits = 0;
    cyls.forEach(function (c, i) {
      var ch = c.prepared.roles[signal.role];
      var mc = c.result.meanCycle;
      if (!ch || !mc) return;
      digits = Math.max(digits, digitsFor(ch));
      var on = i === cmp.highlight;
      series.push({
        id: "c" + i,
        label: c.name,
        x: mc.angles,
        y: mc.series[ch.index].mean,
        color: on ? "--series-1" : "--series-other",
        hoverColor: on ? null : "--series-2",
        width: on ? 2 : 1.5,
        z: on ? 10 : 0,
        dot: on,
        hoverable: true,
      });
    });

    var pointing = h("span", { class: "muted" }, "Point at a grey line to see which cylinder it is; click it to highlight it.");
    var host = h("div", { "aria-label": signal.label + " on all cylinders" });
    box.appendChild(h("div", { class: "card chart-card" }, [
      host,
      h("div", { class: "legend-line" }, [
        h("span", null, [h("span", { class: "legend-key", style: "background:var(--series-1)" }), hl.name]),
        h("span", null, [h("span", { class: "legend-key", style: "background:var(--series-other)" }), "Other cylinders"]),
        pointing,
        h("span", { class: "spacer", style: "flex:1" }),
        h("button", { class: "btn small no-print", type: "button", onclick: function () { savePicture(chart, signal.label + " – all cylinders, " + hl.name + " highlighted", "compare-" + signal.role + ".png"); } }, "Save picture"),
      ]),
    ]));

    var chart = new Chart(host, {
      tooltip: function (x, ctx) {
        var rows = [];
        series.slice().sort(function (p, q) { return Chart.valueAt(q, x) - Chart.valueAt(p, x); }).forEach(function (s) {
          var v = Chart.valueAt(s, x);
          if (!isFinite(v)) return;
          var on = s.id === "c" + cmp.highlight;
          var near = s.id === ctx.nearestId && !on;
          rows.push({ color: on ? "--series-1" : near ? "--series-2" : "--series-other", value: num(v, digits), label: s.label, strong: on || near, dim: !(on || near) });
        });
        return { title: deg(x) + " after TDC", sub: signal.label + ", average cycle · highest first", rows: rows };
      },
      onHoverSeries: function (id) {
        var target = id && id !== "c" + cmp.highlight ? id : null;
        chart.setHighlight(target);
        var name = target ? cyls[parseInt(target.slice(1), 10)].name : null;
        pointing.textContent = name ? "Pointing at " + name + " – click to highlight it." : "Point at a grey line to see which cylinder it is; click it to highlight it.";
      },
      onClick: function (x, ctx) {
        if (ctx.nearestId) {
          var i = parseInt(ctx.nearestId.slice(1), 10);
          if (i !== cmp.highlight) { cmp.highlight = i; renderCompare(); }
        }
      },
      onView: function (view, zoomed) { cmp.view = zoomed ? view : null; },
    });
    state.charts.compare = chart;
    chart.setData({
      xKind: "angle",
      domain: [DA.CYCLE_FROM, DA.CYCLE_TO],
      minSpan: 2,
      view: cmp.view || range.view,
      xLabel: "Crank angle, degrees after each cylinder’s own TDC",
      markers: [{ x: 0, label: "TDC" }],
      panels: [{ title: signal.label, note: "average cycle of each cylinder", height: 360, series: series }],
    });

    box.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, "The numbers behind it"), h("p", null, "Click a cylinder to highlight it.")]),
      comparisonTable(signal.metrics, function (i) { cmp.highlight = i; renderCompare(); }, cmp.highlight),
    ]));
  }

  // ---------------------------------------------------------------- details

  function renderDetails() {
    var a = state.analysis;
    var box = clear($("#tab-details"));
    var set = a.set;
    var firing = a.firing;
    var key = setKey(set);
    var current = state.cylinderSetting[key] || 0;

    var options = [h("option", { value: "0" }, firing.source === "data" || !current ? "Work out from the files" + (firing.source === "data" ? " (" + firing.cylinders + ")" : "") : "Work out from the files")];
    for (var n = 4; n <= 14; n++) {
      var o = h("option", { value: String(n) }, n + " cylinders");
      if (n === current) o.selected = true;
      options.push(o);
    }
    var select = h("select", { id: "cyl-setting", onchange: function (e) {
      var v = parseInt(e.target.value, 10) || 0;
      if (v) state.cylinderSetting[key] = v; else delete state.cylinderSetting[key];
      analyzeCurrent();
      renderHead();
      renderDetails();
    } }, options);

    var offsetsRows = a.cylinders.map(function (c) {
      var inj = c.prepared.injectionAngleCyl1;
      var ownInj = c.result.metrics.injectionStart;
      return h("tr", null, [
        h("td", null, h("span", { class: "cyl-name" }, c.name)),
        h("td", null, firing.reference === "own" ? num(c.result.offsetDeg, 1) + "°" : "–"),
        h("td", null, inj === null ? "–" : num(inj, 1) + "°"),
        h("td", null, ownInj ? deg(ownInj.mean) : "–"),
      ]);
    });

    box.appendChild(h("div", { class: "two-col" }, [
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [h("h2", null, "Engine")]),
        h("dl", { class: "facts single" }, [
          h("div", null, [h("dt", null, h("label", { for: "cyl-setting" }, "Cylinders on this engine")), h("dd", null, select)]),
          h("div", null, [h("dt", null, "Firing order"), h("dd", null, firing.firingOrder ? firing.firingOrder.join("-") : "needs all cylinders")]),
          h("div", null, [h("dt", null, "Crank angles shown from"), h("dd", null, firing.reference === "own" ? "each cylinder’s own TDC" : "cylinder 1 TDC")]),
        ]),
        h("p", { class: "small-print", style: "margin-top:10px" },
          "The logged crank angle counts from cylinder 1 TDC in every file. Each cylinder’s own TDC is found from where its injections start, " +
          "rounded to the even cylinder spacing (360° divided by the number of cylinders)."),
      ]),
      h("div", { class: "card" }, [
        h("div", { class: "card-head" }, [h("h2", null, "Cylinder timing")]),
        h("div", { class: "table-wrap" }, h("table", null, [
          h("thead", null, h("tr", null, [
            h("th", null, "Cylinder"),
            h("th", null, ["TDC", h("small", null, "after cyl 1 TDC")]),
            h("th", null, ["Injection starts", h("small", null, "logged crank angle")]),
            h("th", null, ["Injection starts", h("small", null, "after own TDC")]),
          ])),
          h("tbody", null, offsetsRows),
        ])),
      ]),
    ]));

    // files
    var fileRows = set.dumps.map(function (d) {
      var local = dateParts(d.utcMs, d.utcOffsetMinutes);
      var utc = dateParts(d.utcMs, 0);
      return h("tr", null, [
        h("td", null, h("span", { class: "cyl-name" }, d.unitName)),
        h("td", { class: "text" }, d.fileName),
        h("td", null, local.date + " " + local.hms),
        h("td", null, utc.hms),
        h("td", null, num(d.sampleCount, 0)),
        h("td", null, num(d.sampleIntervalUs, 0) + " µs"),
        h("td", null, num(d.durationS, 2) + " s"),
        h("td", null, String(d.channelCount)),
        h("td", null, num(d.fileSize, 0)),
      ]);
    });
    var first = set.dumps[0];
    box.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, "Files"), h("p", null, [first.logger, first.reason, first.software].filter(Boolean).join(" · "))]),
      h("div", { class: "table-wrap" }, h("table", null, [
        h("thead", null, h("tr", null, [
          h("th", null, "Unit"), h("th", { class: "text" }, "File"),
          h("th", null, ["Saved", h("small", null, "local, " + utcLabel(first.utcOffsetMinutes))]),
          h("th", null, ["Saved", h("small", null, "UTC")]),
          h("th", null, "Samples"), h("th", null, "Sample every"), h("th", null, "Length"), h("th", null, "Channels"), h("th", null, ["Size", h("small", null, "bytes")]),
        ])),
        h("tbody", null, fileRows),
      ])),
    ]));

    // channels of the cylinder chosen on the graphs tab
    var cyl = a.cylinders[state.graphs.cyl] || a.cylinders[0];
    var d0 = cyl.dump;
    var chRows = d0.channels.map(function (ch) {
      return h("tr", null, [
        h("td", { class: "text" }, ch.name),
        h("td", { class: "text" }, ch.role ? ch.label : "(shown as it is)"),
        h("td", null, num(ch.gain, ch.gain === Math.round(ch.gain) ? 0 : 4)),
        h("td", null, num(ch.offset, ch.offset === Math.round(ch.offset) ? 0 : 4)),
        h("td", null, ch.unit || "none"),
        h("td", null, num(ch.rawMin, 0)),
        h("td", null, num(ch.rawMax, 0)),
      ]);
    });
    var warnings = [];
    set.dumps.forEach(function (d) { d.warnings.forEach(function (w) { warnings.push(d.unitName + ": " + w); }); });
    box.appendChild(h("div", { class: "card" }, [
      h("div", { class: "card-head" }, [h("h2", null, "Channels in the " + d0.unitName + " file"), h("p", null, "Value shown = logged number × gain + offset")]),
      h("div", { class: "table-wrap" }, h("table", null, [
        h("thead", null, h("tr", null, [
          h("th", { class: "text" }, "Channel name in the file"), h("th", { class: "text" }, "Read as"), h("th", null, "Gain"), h("th", null, "Offset"), h("th", null, "Unit"),
          h("th", null, ["Lowest", h("small", null, "logged")]), h("th", null, ["Highest", h("small", null, "logged")]),
        ])),
        h("tbody", null, chRows),
      ])),
      h("p", { class: "small-print", style: "margin-top:10px" },
        "The logger keeps the last " + num(d0.sampleCount, 0) + " samples in a ring; this file’s oldest sample was at position " + num(d0.ringStart, 0) +
        ", and the viewer puts the samples back in time order. The header also holds the number " + num(d0.preSamples, 0) +
        " (probably the samples kept from before the dump was triggered)." +
        (d0.trailingBytes ? " The file ends with " + d0.trailingBytes + " spare bytes after the samples." : "")),
      warnings.length ? h("ul", { class: "small-print" }, warnings.map(function (w) { return h("li", null, w); })) : null,
    ]));
  }

  // ---------------------------------------------------------------- export

  function csvCell(v) {
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(name, rows) {
    var text = "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
    download(name, new Blob([text], { type: "text/csv;charset=utf-8" }));
  }

  function download(name, what) {
    var url = typeof what === "string" ? what : URL.createObjectURL(what);
    var link = h("a", { href: url, download: name, style: "display:none" });
    document.body.appendChild(link);
    link.click();
    setTimeout(function () {
      link.remove();
      if (typeof what !== "string") URL.revokeObjectURL(url);
    }, 1000);
  }

  function downloadCylinderCsv(cyl) {
    var d = cyl.dump;
    var p = cyl.prepared;
    var r = cyl.result;
    var tacho = p.roles.tacho;
    var head = ["Time (s)"];
    if (p.crank) head.push("Crank angle from cylinder 1 TDC (deg)");
    if (r.ownAngle) head.push("Crank angle after own TDC (deg)", "Engine speed (rpm)");
    d.channels.forEach(function (ch) { if (ch !== tacho) head.push(ch.name + (ch.unit ? " (" + ch.unit + ")" : "")); });
    var rows = [head];
    for (var i = 0; i < d.sampleCount; i++) {
      var row = [p.time[i].toFixed(4)];
      if (p.crank) row.push(p.crank.fine[i] % 360 < 0 ? ((p.crank.fine[i] % 360) + 360).toFixed(2) : (p.crank.fine[i] % 360).toFixed(2));
      if (r.ownAngle) row.push(DA.cycleAngle(r.ownAngle[i]).toFixed(2), p.crank.rpm[i].toFixed(2));
      d.channels.forEach(function (ch) {
        if (ch === tacho) return;
        row.push(digitsFor(ch) ? ch.values[i].toFixed(2) : String(ch.values[i]));
      });
      rows.push(row);
    }
    downloadCsv(d.fileName.replace(/\.dat$/i, "") + ".csv", rows);
  }

  function downloadSummaryCsv() {
    var a = state.analysis;
    var metrics = DA.METRICS;
    var head = ["Cylinder", "File"].concat(metrics.map(function (m) { return m.label + " (" + METRIC_UNIT_NOTE[m.key] + ")"; })).concat(["Full cycles", "Engine speed (rpm)", "Findings"]);
    var rows = [head];
    a.cylinders.forEach(function (c, i) {
      var findings = a.findings.filter(function (f) { return f.cylinder === c.name && f.level !== "note"; }).map(function (f) { return LEVEL_LABEL[f.level] + ": " + f.text; });
      rows.push([c.name, c.dump.fileName]
        .concat(metrics.map(function (m) {
          var v = a.comparisons[m.key].rows[i].value;
          return isFinite(v) ? v.toFixed(m.digits === 0 ? 0 : m.digits) : "";
        }))
        .concat([c.result.metrics.fullCycles || 0, isFinite(c.result.metrics.meanRpm) ? c.result.metrics.meanRpm.toFixed(2) : "", findings.join(" | ")]));
    });
    var d = a.set.dumps[0];
    var t = dateParts(d.utcMs, d.utcOffsetMinutes);
    downloadCsv("dump-summary-" + t.date.replace(/ /g, "-") + "-" + t.hm.replace(":", "") + ".csv", rows);
  }

  function savePicture(chart, title, name) {
    if (!chart) return;
    download(name, chart.toPNG(title));
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    $("#btn-open").addEventListener("click", openPicker);
    $("#btn-close").addEventListener("click", closeFiles);
    $("#btn-print").addEventListener("click", function () {
      if (state.tab !== "summary") showTab("summary");
      setTimeout(function () { window.print(); }, 50);
    });
    $("#file-input").addEventListener("change", function (e) { loadFiles(e.target.files); e.target.value = ""; });
    var drop = $("#drop");
    drop.addEventListener("click", openPicker);
    drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } });
    $("#set-picker").addEventListener("change", function (e) {
      state.setId = e.target.value;
      state.graphs.cyl = 0;
      state.graphs.view = null;
      analyzeCurrent(true);
      showWorkspace();
    });
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
      b.addEventListener("keydown", function (e) {
        var tabs = Array.prototype.slice.call(document.querySelectorAll(".tabs button"));
        var i = tabs.indexOf(b);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          var nextTab = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          nextTab.focus();
          showTab(nextTab.getAttribute("data-tab"));
        }
      });
    });

    // Drag and drop anywhere on the page. Every drop is caught: left alone, the browser
    // would leave this page and open the dropped item (what happens with a file dragged
    // from VS Code, which arrives as a link rather than as a file).
    var overlay = $("#drop-overlay");
    var depth = 0;
    var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; };
    var hideOverlay = function () { depth = 0; overlay.hidden = true; drop.classList.remove("over"); };
    window.addEventListener("dragenter", function (e) {
      e.preventDefault();
      depth++;
      overlay.hidden = false;
      drop.classList.add("over");
    });
    window.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", function () {
      depth = Math.max(0, depth - 1);
      if (!depth) hideOverlay();
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      hideOverlay();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (hasFiles(e) && files && files.length) {
        loadFiles(files);
      } else {
        showMessage("The browser is not allowed to read what was dropped. This happens when files are dragged from VS Code. " +
          "Drag the .dat files from File Explorer instead, or click “Open dump files” and choose them.");
      }
    });
    window.addEventListener("dragend", hideOverlay);

    // Never leave a blank page: show what went wrong.
    window.addEventListener("error", function (e) { reportError(e.error || e.message); });
    window.addEventListener("unhandledrejection", function (e) { reportError(e.reason); });
  }

  /** A plain message box at the top of whichever screen is showing. */
  function showMessage(text, isError) {
    var box = $("#workspace").hidden ? $("#start-notices") : $("#notices");
    var old = box.querySelector(".notice.message");
    if (old) old.remove();
    box.insertBefore(h("div", { class: "notice message" + (isError ? " error" : ""), role: "alert" }, [
      h("div", null, text),
      h("button", { class: "btn small ghost", type: "button", onclick: function (e) { e.target.closest(".notice").remove(); } }, "Dismiss"),
    ]), box.firstChild);
    window.scrollTo({ top: 0 });
  }

  function reportError(err) {
    var detail = err && err.message ? err.message : String(err);
    if (window.console) console.error(err);
    if (!state.dumps.length || !state.analysis) {
      $("#workspace").hidden = true;
      $("#start").hidden = false;
    }
    showMessage("Something went wrong while showing the files: " + detail +
      ". Click “Close files” and open them again. If it happens again, send a screenshot of this message.", true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
