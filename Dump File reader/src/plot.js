/*
 * plot.js - small canvas chart for long signal logs.
 *
 * One chart = one or more panels stacked on a shared x axis.
 *   chart.setData({ panels, domain, xKind, markers, minSpan })
 *   panel  = { title, height, series: [...] }
 *   series = { id, label, x, y, color, width, alpha, hoverColor, hoverable }
 *            x must rise; colors are CSS custom property names ("--series-1") or plain colors.
 *
 * Interaction: crosshair + tooltip, drag to zoom, wheel to zoom, double-click to
 * zoom out, arrow keys to pan, +/- to zoom, 0 to reset.
 */
(function (root) {
  "use strict";

  var PAD_LEFT = 64;
  var PAD_RIGHT = 16;
  var TITLE_H = 22;
  var PANEL_GAP = 12;
  var AXIS_H = 40;

  function lowerBound(arr, value) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function valueAt(series, x) {
    var xs = series.x, ys = series.y;
    var n = xs.length;
    if (!n || x < xs[0] || x > xs[n - 1]) return NaN;
    var i = lowerBound(xs, x);
    if (i <= 0) return ys[0];
    if (i >= n) return ys[n - 1];
    var x0 = xs[i - 1], x1 = xs[i];
    var y0 = ys[i - 1], y1 = ys[i];
    if (!isFinite(y0)) return y1;
    if (!isFinite(y1)) return y0;
    return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }

  function niceStep(span, target) {
    var raw = span / Math.max(1, target);
    if (!(raw > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function angleStep(span, target) {
    var raw = span / Math.max(1, target);
    var steps = [0.5, 1, 2, 5, 10, 15, 30, 45, 90, 180, 360, 720];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
    return niceStep(span, target);
  }

  function decimals(step) {
    if (step >= 1) return 0;
    return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
  }

  function formatTick(v, step, compact) {
    if (Math.abs(v) < step / 1e6) v = 0;
    if (compact) {
      var k = v / 1000;
      return k.toLocaleString("en-GB", { maximumFractionDigits: decimals(step / 1000) }) + "K";
    }
    return v.toLocaleString("en-GB", { minimumFractionDigits: decimals(step), maximumFractionDigits: decimals(step) });
  }

  function Chart(host, options) {
    this.host = host;
    this.opts = options || {};
    host.classList.add("chart");
    if (!host.hasAttribute("tabindex")) host.tabIndex = 0;
    this.base = document.createElement("canvas");
    this.base.className = "chart-base";
    this.top = document.createElement("canvas");
    this.top.className = "chart-top";
    this.tip = document.createElement("div");
    this.tip.className = "chart-tip";
    this.tip.hidden = true;
    host.appendChild(this.base);
    host.appendChild(this.top);
    host.appendChild(this.tip);

    this.panels = [];
    this.domain = [0, 1];
    this.view = [0, 1];
    this.markers = [];
    this.xKind = "time";
    this.minSpan = 0;
    this.hoverX = null;
    this.hoverId = null;
    this.drag = null;
    this.rects = [];
    this.width = 0;
    this.height = 0;

    var self = this;
    this.top.addEventListener("pointermove", function (e) { self.onMove(e); });
    this.top.addEventListener("pointerleave", function () { if (!self.drag) self.clearHover(); });
    this.top.addEventListener("pointerdown", function (e) { self.onDown(e); });
    this.top.addEventListener("pointerup", function (e) { self.onUp(e); });
    this.top.addEventListener("pointercancel", function () { self.drag = null; self.drawTop(); });
    this.top.addEventListener("dblclick", function () { self.reset(); });
    this.top.addEventListener("wheel", function (e) { self.onWheel(e); }, { passive: false });
    host.addEventListener("keydown", function (e) { self.onKey(e); });
    if (typeof ResizeObserver !== "undefined") {
      var pending = false;
      this.resizer = new ResizeObserver(function () {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () { pending = false; self.layout(); self.render(); });
      });
      this.resizer.observe(host);
    }
    if (root.matchMedia) {
      this.mq = root.matchMedia("(prefers-color-scheme: dark)");
      this.redraw = function () { self.render(); };
      if (this.mq.addEventListener) this.mq.addEventListener("change", this.redraw);
      else if (this.mq.addListener) this.mq.addListener(this.redraw);
    }
  }

  Chart.prototype.destroy = function () {
    if (this.resizer) this.resizer.disconnect();
    if (this.mq) {
      if (this.mq.removeEventListener) this.mq.removeEventListener("change", this.redraw);
      else if (this.mq.removeListener) this.mq.removeListener(this.redraw);
    }
  };

  Chart.prototype.color = function (token) {
    if (!token) return "#888";
    if (token.indexOf("--") === 0) {
      var v = getComputedStyle(this.host).getPropertyValue(token).trim();
      return v || "#888";
    }
    return token;
  };

  Chart.prototype.setData = function (data, keepView) {
    this.panels = data.panels || [];
    this.domain = data.domain || [0, 1];
    this.markers = data.markers || [];
    this.xKind = data.xKind || "time";
    this.minSpan = data.minSpan || (this.domain[1] - this.domain[0]) / 2000;
    this.xLabel = data.xLabel || "";
    if (!keepView) this.view = (data.view || this.domain).slice();
    this.clampView();
    this.hoverId = null;
    this.layout();
    this.render();
  };

  Chart.prototype.clampView = function () {
    var d = this.domain, v = this.view;
    var span = Math.max(this.minSpan, Math.min(v[1] - v[0], d[1] - d[0]));
    var a = Math.max(d[0], Math.min(v[0], d[1] - span));
    this.view = [a, a + span];
  };

  Chart.prototype.setView = function (view, silent) {
    this.view = view.slice();
    this.clampView();
    this.render();
    this.drawTop();
    if (!silent && this.opts.onView) this.opts.onView(this.view.slice(), this.isZoomed());
  };

  Chart.prototype.isZoomed = function () {
    var d = this.domain, v = this.view;
    return v[1] - v[0] < (d[1] - d[0]) * 0.999;
  };

  Chart.prototype.reset = function () { this.setView(this.domain); };

  Chart.prototype.zoom = function (factor, anchor) {
    var v = this.view;
    var at = anchor === undefined ? (v[0] + v[1]) / 2 : anchor;
    var a = at - (at - v[0]) * factor;
    var b = at + (v[1] - at) * factor;
    this.setView([a, b]);
  };

  Chart.prototype.pan = function (fraction) {
    var v = this.view;
    var shift = (v[1] - v[0]) * fraction;
    this.setView([v[0] + shift, v[1] + shift]);
  };

  Chart.prototype.setHighlight = function (id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.render();
  };

  Chart.prototype.layout = function () {
    var w = Math.max(320, this.host.clientWidth);
    var y = 0;
    this.rects = this.panels.map(function (p) {
      var r = { x: PAD_LEFT, y: y + TITLE_H, w: w - PAD_LEFT - PAD_RIGHT, h: p.height || 120, top: y };
      y += TITLE_H + r.h + PANEL_GAP;
      return r;
    });
    var h = y - PANEL_GAP + AXIS_H;
    this.width = w;
    this.height = h;
    var dpr = root.devicePixelRatio || 1;
    [this.base, this.top].forEach(function (c) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + "px";
      c.style.height = h + "px";
    });
    this.host.style.height = h + "px";
    this.dpr = dpr;
  };

  Chart.prototype.sx = function (x) {
    var r = this.rects[0];
    var v = this.view;
    return r.x + ((x - v[0]) / (v[1] - v[0])) * r.w;
  };

  Chart.prototype.xFromPx = function (px) {
    var r = this.rects[0];
    var v = this.view;
    return v[0] + ((px - r.x) / r.w) * (v[1] - v[0]);
  };

  Chart.prototype.yRange = function (panel) {
    if (panel.yRange) return panel.yRange;
    var lo = Infinity, hi = -Infinity;
    var v = this.view;
    panel.series.forEach(function (s) {
      if (s.skipRange) return;
      var xs = s.x, ys = s.y;
      var i0 = Math.max(0, lowerBound(xs, v[0]) - 1);
      var i1 = Math.min(xs.length, lowerBound(xs, v[1]) + 1);
      for (var i = i0; i < i1; i++) {
        var yv = ys[i];
        if (yv < lo) lo = yv;
        if (yv > hi) hi = yv;
      }
    });
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  };

  Chart.prototype.render = function () {
    if (!this.rects.length) return;
    var ctx = this.base.getContext("2d");
    var dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    var c = {
      surface: this.color("--surface"),
      grid: this.color("--grid"),
      axis: this.color("--axis"),
      muted: this.color("--muted"),
      ink2: this.color("--ink-2"),
      ink: this.color("--ink"),
    };
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, this.width, this.height);
    var font = getComputedStyle(this.host).fontFamily || "system-ui, sans-serif";
    this.font = font;
    var self = this;
    var v = this.view;

    // x ticks
    var span = v[1] - v[0];
    var target = Math.max(2, Math.floor(this.rects[0].w / 90));
    var xStep = this.xKind === "angle" ? angleStep(span, target) : niceStep(span, target);
    var xTicks = [];
    for (var t = Math.ceil(v[0] / xStep) * xStep; t <= v[1] + xStep * 1e-6; t += xStep) xTicks.push(t);
    this.ranges = [];

    this.panels.forEach(function (panel, pi) {
      var r = self.rects[pi];
      var yr = self.yRange(panel);
      self.ranges[pi] = yr;
      var sy = function (y) { return r.y + r.h - ((y - yr[0]) / (yr[1] - yr[0])) * r.h; };

      // title
      ctx.fillStyle = c.ink2;
      ctx.font = "600 12px " + font;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText(panel.title || "", r.x, r.y - 7);
      var cursor = r.x + ctx.measureText(panel.title || "").width + 10;
      if (panel.note) {
        ctx.fillStyle = c.muted;
        ctx.font = "12px " + font;
        ctx.fillText(panel.note, cursor, r.y - 7);
        cursor += ctx.measureText(panel.note).width + 12;
      }
      // legend: short line key + label, after the title
      (panel.legend || []).forEach(function (item) {
        ctx.strokeStyle = self.color(item.color);
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cursor + 4, r.y - 11);
        ctx.lineTo(cursor + 18, r.y - 11);
        ctx.stroke();
        ctx.fillStyle = c.ink2;
        ctx.font = "12px " + font;
        ctx.fillText(item.label, cursor + 24, r.y - 7);
        cursor += 24 + ctx.measureText(item.label).width + 14;
      });

      // y grid + labels
      var yStep = niceStep(yr[1] - yr[0], Math.max(4, Math.floor(r.h / 28)));
      var compact = Math.max(Math.abs(yr[0]), Math.abs(yr[1])) >= 10000 && yStep >= 100;
      ctx.font = "11px " + font;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1;
      for (var y = Math.ceil(yr[0] / yStep) * yStep; y <= yr[1]; y += yStep) {
        var py = Math.round(sy(y)) + 0.5;
        ctx.strokeStyle = c.grid;
        ctx.beginPath();
        ctx.moveTo(r.x, py);
        ctx.lineTo(r.x + r.w, py);
        ctx.stroke();
        ctx.fillStyle = c.muted;
        ctx.fillText(formatTick(y, yStep, compact), r.x - 8, py);
      }
      // x grid
      ctx.strokeStyle = c.grid;
      xTicks.forEach(function (xt) {
        var px = Math.round(self.sx(xt)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, r.y);
        ctx.lineTo(px, r.y + r.h);
        ctx.stroke();
      });
      // markers (e.g. TDC)
      self.markers.forEach(function (m) {
        if (m.x < v[0] || m.x > v[1]) return;
        var px = Math.round(self.sx(m.x)) + 0.5;
        ctx.strokeStyle = c.axis;
        ctx.beginPath();
        ctx.moveTo(px, r.y);
        ctx.lineTo(px, r.y + r.h);
        ctx.stroke();
        if (pi === 0 && m.label) {
          ctx.fillStyle = c.muted;
          ctx.font = "10px " + font;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(m.label, px + 3, r.y + 3);
        }
      });
      // baseline frame
      ctx.strokeStyle = c.axis;
      ctx.beginPath();
      ctx.moveTo(r.x, Math.round(r.y + r.h) + 0.5);
      ctx.lineTo(r.x + r.w, Math.round(r.y + r.h) + 0.5);
      ctx.stroke();

      // series: normal first, highlighted last
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y - 1, r.w, r.h + 2);
      ctx.clip();
      var ordered = panel.series.slice().sort(function (a, b) {
        var za = (a.z || 0) + (a.id === self.hoverId ? 100 : 0);
        var zb = (b.z || 0) + (b.id === self.hoverId ? 100 : 0);
        return za - zb;
      });
      ordered.forEach(function (s) {
        var hot = s.id === self.hoverId && s.hoverColor;
        ctx.strokeStyle = self.color(hot ? s.hoverColor : s.color);
        ctx.globalAlpha = hot ? 1 : (s.alpha === undefined ? 1 : s.alpha);
        ctx.lineWidth = hot ? 2 : (s.width || 2);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        self.drawLine(ctx, s, sy, r);
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    });

    // x axis labels under the last panel
    var last = this.rects[this.rects.length - 1];
    ctx.fillStyle = c.muted;
    ctx.font = "11px " + font;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    xTicks.forEach(function (xt) {
      var label = self.xKind === "angle" ? formatTick(xt, xStep, false) + "°" : formatTick(xt, xStep, false);
      ctx.fillText(label, self.sx(xt), last.y + last.h + 6);
    });
    if (this.xLabel) {
      ctx.fillStyle = c.ink2;
      ctx.textAlign = "right";
      ctx.fillText(this.xLabel, last.x + last.w, last.y + last.h + 22);
    }
    this.drawTop();
  };

  Chart.prototype.drawLine = function (ctx, s, sy, r) {
    var xs = s.x, ys = s.y;
    var v = this.view;
    var n = xs.length;
    if (!n) return;
    var i0 = Math.max(0, lowerBound(xs, v[0]) - 1);
    var i1 = Math.min(n, lowerBound(xs, v[1]) + 2);
    var count = i1 - i0;
    var self = this;
    ctx.beginPath();
    var pen = false;
    if (count > r.w * 3) {
      // Many samples per pixel: draw each pixel column as its min-max span.
      var col = null, mn = 0, mx = 0;
      var flush = function () {
        if (col === null) return;
        if (!pen) { ctx.moveTo(col, sy(mn)); pen = true; } else ctx.lineTo(col, sy(mn));
        ctx.lineTo(col, sy(mx));
      };
      for (var i = i0; i < i1; i++) {
        var yv = ys[i];
        if (!isFinite(yv)) continue;
        var px = Math.round(self.sx(xs[i]));
        if (px !== col) { flush(); col = px; mn = yv; mx = yv; }
        else { if (yv < mn) mn = yv; if (yv > mx) mx = yv; }
      }
      flush();
    } else {
      for (var j = i0; j < i1; j++) {
        var y = ys[j];
        if (!isFinite(y)) { pen = false; continue; }
        var X = self.sx(xs[j]);
        var Y = sy(y);
        if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
      }
    }
    ctx.stroke();
  };

  Chart.prototype.pointer = function (e) {
    var b = this.top.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  Chart.prototype.panelAt = function (py) {
    for (var i = 0; i < this.rects.length; i++) {
      var r = this.rects[i];
      if (py >= r.top && py <= r.y + r.h + PANEL_GAP / 2) return i;
    }
    return this.rects.length - 1;
  };

  /** Series in panel pi closest (in pixels) to the pointer, within 40 px. */
  Chart.prototype.nearest = function (pi, x, py) {
    var panel = this.panels[pi];
    var r = this.rects[pi];
    var yr = this.ranges && this.ranges[pi];
    if (!panel || !yr) return null;
    var best = null, bestD = 40;
    panel.series.forEach(function (s) {
      if (s.hoverable === false) return;
      var val = valueAt(s, x);
      if (!isFinite(val)) return;
      var sy = r.y + r.h - ((val - yr[0]) / (yr[1] - yr[0])) * r.h;
      var d = Math.abs(sy - py);
      if (d < bestD) { bestD = d; best = s; }
    });
    return best;
  };

  Chart.prototype.onMove = function (e) {
    var p = this.pointer(e);
    var r0 = this.rects[0];
    if (!r0) return;
    var inside = p.x >= r0.x && p.x <= r0.x + r0.w;
    if (this.drag) {
      this.drag.now = Math.max(r0.x, Math.min(r0.x + r0.w, p.x));
      if (Math.abs(this.drag.now - this.drag.from) > 4) this.drag.moved = true;
    }
    if (!inside && !this.drag) { this.clearHover(); return; }
    var x = this.xFromPx(Math.max(r0.x, Math.min(r0.x + r0.w, p.x)));
    var pi = this.panelAt(p.y);
    var near = this.nearest(pi, x, p.y);
    this.hoverX = x;
    this.hoverPanel = pi;
    if (this.opts.onHoverSeries) this.opts.onHoverSeries(near ? near.id : null, pi);
    this.drawTop();
    this.showTip(x, p, pi, near);
  };

  Chart.prototype.clearHover = function () {
    this.hoverX = null;
    this.tip.hidden = true;
    if (this.opts.onHoverSeries) this.opts.onHoverSeries(null, null);
    this.drawTop();
  };

  Chart.prototype.showTip = function (x, p, pi, near) {
    if (!this.opts.tooltip) return;
    var content = this.opts.tooltip(x, { panel: pi, nearestId: near ? near.id : null });
    if (!content) { this.tip.hidden = true; return; }
    var tip = this.tip;
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    var title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = content.title || "";
    tip.appendChild(title);
    if (content.sub) {
      var sub = document.createElement("div");
      sub.className = "tip-sub";
      sub.textContent = content.sub;
      tip.appendChild(sub);
    }
    var self = this;
    (content.rows || []).forEach(function (row) {
      if (row.heading) {
        var hd = document.createElement("div");
        hd.className = "tip-heading";
        hd.textContent = row.heading;
        tip.appendChild(hd);
        return;
      }
      var line = document.createElement("div");
      line.className = "tip-row" + (row.strong ? " strong" : "") + (row.dim ? " dim" : "");
      var key = document.createElement("span");
      key.className = "tip-key";
      if (row.color) key.style.background = self.color(row.color);
      else key.style.background = "transparent";
      var val = document.createElement("span");
      val.className = "tip-value";
      val.textContent = row.value;
      var lab = document.createElement("span");
      lab.className = "tip-label";
      lab.textContent = row.label;
      line.appendChild(key);
      line.appendChild(val);
      line.appendChild(lab);
      tip.appendChild(line);
    });
    tip.hidden = false;
    var hostW = this.host.clientWidth;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = p.x + 16;
    if (left + tw > hostW - 4) left = p.x - tw - 16;
    if (left < 4) left = 4;
    var top = p.y + 12;
    if (top + th > this.height - 4) top = Math.max(4, this.height - th - 4);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };

  Chart.prototype.drawTop = function () {
    var ctx = this.top.getContext("2d");
    var dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.rects.length) return;
    var first = this.rects[0];
    var last = this.rects[this.rects.length - 1];
    var self = this;
    if (this.drag && this.drag.moved) {
      var a = Math.min(this.drag.from, this.drag.now);
      var b = Math.max(this.drag.from, this.drag.now);
      ctx.fillStyle = this.color("--select");
      ctx.fillRect(a, first.y, b - a, last.y + last.h - first.y);
      return;
    }
    if (this.hoverX === null) return;
    var px = Math.round(this.sx(this.hoverX)) + 0.5;
    ctx.strokeStyle = this.color("--ink-2");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, first.y);
    ctx.lineTo(px, last.y + last.h);
    ctx.stroke();
    // dots where the crosshair meets the emphasised lines
    var surface = this.color("--surface");
    this.panels.forEach(function (panel, pi) {
      var r = self.rects[pi];
      var yr = self.ranges && self.ranges[pi];
      if (!yr) return;
      panel.series.forEach(function (s) {
        var hot = s.id === self.hoverId && s.hoverColor;
        if (!(s.dot || hot)) return;
        var val = valueAt(s, self.hoverX);
        if (!isFinite(val)) return;
        var y = r.y + r.h - ((val - yr[0]) / (yr[1] - yr[0])) * r.h;
        if (y < r.y - 2 || y > r.y + r.h + 2) return;
        ctx.beginPath();
        ctx.arc(px, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = self.color(hot ? s.hoverColor : s.color);
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      });
    });
  };

  Chart.prototype.onDown = function (e) {
    if (e.button !== 0) return;
    var p = this.pointer(e);
    var r0 = this.rects[0];
    if (!r0 || p.x < r0.x || p.x > r0.x + r0.w) return;
    this.top.setPointerCapture(e.pointerId);
    this.drag = { from: p.x, now: p.x, moved: false, y: p.y };
  };

  Chart.prototype.onUp = function (e) {
    var d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) {
      var a = this.xFromPx(Math.min(d.from, d.now));
      var b = this.xFromPx(Math.max(d.from, d.now));
      this.setView([a, b]);
    } else if (this.opts.onClick) {
      var pi = this.panelAt(d.y);
      var x = this.xFromPx(d.from);
      var near = this.nearest(pi, x, d.y);
      this.opts.onClick(x, { panel: pi, nearestId: near ? near.id : null });
    }
    this.drawTop();
  };

  Chart.prototype.onWheel = function (e) {
    var r0 = this.rects[0];
    if (!r0) return;
    e.preventDefault();
    var p = this.pointer(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      var dx = e.deltaX || e.deltaY;
      this.pan(dx / Math.max(200, r0.w));
      return;
    }
    var factor = Math.pow(1.0015, e.deltaY);
    this.zoom(factor, this.xFromPx(Math.max(r0.x, Math.min(r0.x + r0.w, p.x))));
  };

  Chart.prototype.onKey = function (e) {
    var handled = true;
    if (e.key === "ArrowLeft") this.pan(-0.2);
    else if (e.key === "ArrowRight") this.pan(0.2);
    else if (e.key === "+" || e.key === "=") this.zoom(0.7);
    else if (e.key === "-" || e.key === "_") this.zoom(1 / 0.7);
    else if (e.key === "0" || e.key === "Home") this.reset();
    else if (e.key === "Escape") { this.drag = null; this.clearHover(); }
    else handled = false;
    if (handled) e.preventDefault();
  };

  /** PNG of the chart with a title line above it. */
  Chart.prototype.toPNG = function (title) {
    var dpr = this.dpr || 1;
    var head = title ? 36 : 0;
    var out = document.createElement("canvas");
    out.width = this.base.width;
    out.height = this.base.height + Math.round(head * dpr);
    var ctx = out.getContext("2d");
    ctx.fillStyle = this.color("--surface");
    ctx.fillRect(0, 0, out.width, out.height);
    if (title) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this.color("--ink");
      ctx.font = "600 14px " + (this.font || "system-ui, sans-serif");
      ctx.textBaseline = "middle";
      ctx.fillText(title, PAD_LEFT, head / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(this.base, 0, Math.round(head * dpr));
    return out.toDataURL("image/png");
  };

  root.SignalChart = Chart;
  root.SignalChart.valueAt = valueAt;
})(typeof self !== "undefined" ? self : this);
