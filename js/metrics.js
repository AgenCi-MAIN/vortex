/* VORTEX metrics.js — [W07] 12 run-scoring metrics, protocol-relative composites,
 * 30-run calibration baselines, and the Scorecard panel.
 *
 * Plain browser script, IIFE, no modules, no build step. Runs from file://.
 * No network, no fetch/XHR/WebSocket/eval. localStorage only inside try/catch.
 *
 * All 12 metrics are PROTOCOL-RELATIVE: the module never claims "higher is
 * better". Scores are percentiles against a 30-run calibration baseline per
 * config; the composite is a weighted blend of percentiles (weights sum to 1).
 *
 * STATE SAMPLE SHAPE (consumed from snapshots / backend.sampleMetrics()).
 * The CPU backend (W14) does not exist yet, so the exact input contract is
 * defined here and selfTest() feeds synthetic state through every metric.
 *   state = {
 *     tracers: { n, x:[], y:[], x0:[], y0:[], time },  // unit-square positions, time in s
 *     field:   { nx, ny, u:[], v:[] },                 // row-major coarse velocity grid, unit square
 *     field0:  { nx, ny, u:[], v:[] },                 // pre-injection field (injection-influence-radius)
 *     referenceField: { nx, ny, u:[], v:[] },          // pre-restore reference (rollback-fidelity)
 *     series:  { dt, ke:[], enstrophy:[], vortexCount:[], twinSep:[] },
 *     injection: { cx, cy },                           // injection centre, unit square
 *     scale: number                                    // metres per unit-square side; default 1
 *   }
 * Conventions: -1 for merger-time / predictability-horizon means "not observed
 * within the series window". NaN means "required input absent".
 */
(function (root) {
'use strict';

var V = root.VORTEX;
if (!V || !V.utils) { throw new Error('w07-metrics: requires vx-namespace.js first'); }
var utils = V.utils;

/* ---------------- small helpers ---------------- */
function isFin(v) { return typeof v === 'number' && isFinite(v); }
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function mean(a) {
  var s = 0, n = 0;
  for (var i = 0; i < a.length; i++) { if (isFin(a[i])) { s += a[i]; n++; } }
  return n ? s / n : NaN;
}
function stdOf(a, m) {
  var s = 0, n = 0;
  for (var i = 0; i < a.length; i++) {
    if (isFin(a[i])) { var d = a[i] - m; s += d * d; n++; }
  }
  return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
}
/* Coarse-grid vorticity w = dv/dx - du/dy, central differences, PERIODIC
 * boundaries. Documented approximation: the proxy grid is coarse and the
 * real backend BCs live in the field module; this is a cheap, deterministic
 * turbulence proxy, not a solver-grade curl. */
function vorticityGrid(f) {
  var nx = f.nx, ny = f.ny, u = f.u, v = f.v;
  var w = new Array(nx * ny);
  var hx = 1 / nx, hy = 1 / ny;
  for (var j = 0; j < ny; j++) {
    for (var i = 0; i < nx; i++) {
      var ip = (i + 1) % nx, im = (i - 1 + nx) % nx;
      var jp = (j + 1) % ny, jm = (j - 1 + ny) % ny;
      var k = j * nx + i;
      var dvdx = (v[j * nx + ip] - v[j * nx + im]) / (2 * hx);
      var dudy = (u[jp * nx + i] - u[jm * nx + i]) / (2 * hy);
      w[k] = dvdx - dudy;
    }
  }
  return w;
}
function fieldOK(f) {
  return f && isFin(f.nx) && isFin(f.ny) && f.nx > 1 && f.ny > 1 &&
    f.u && f.v && f.u.length === f.nx * f.ny && f.v.length === f.nx * f.ny;
}
function tracerOK(t) {
  return t && isFin(t.n) && t.n > 0 && t.x && t.y && t.x0 && t.y0 &&
    t.x.length >= t.n && t.y.length >= t.n &&
    t.x0.length >= t.n && t.y0.length >= t.n && isFin(t.time);
}
/* Shannon entropy (nats) of tracer counts over a bins x bins unit-square grid. */
function histogramEntropy(xs, ys, n, bins) {
  var c = new Array(bins * bins);
  for (var k = 0; k < c.length; k++) c[k] = 0;
  for (var i = 0; i < n; i++) {
    var bx = Math.min(bins - 1, Math.max(0, Math.floor(xs[i] * bins)));
    var by = Math.min(bins - 1, Math.max(0, Math.floor(ys[i] * bins)));
    c[by * bins + bx]++;
  }
  var H = 0;
  for (var j = 0; j < c.length; j++) {
    if (c[j] > 0) { var p = c[j] / n; H -= p * Math.log(p); }
  }
  return H;
}
/* Least-squares slope of y vs t. */
function slope(t, y) {
  var n = y.length, sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (var i = 0; i < n; i++) {
    if (!isFin(y[i])) continue;
    m++; sx += t[i]; sy += y[i]; sxx += t[i] * t[i]; sxy += t[i] * y[i];
  }
  if (m < 2) return NaN;
  var den = m * sxx - sx * sx;
  return den === 0 ? NaN : (m * sxy - sx * sy) / den;
}

/* ---------------- the 12 metrics ----------------
 * Each entry: { id, title, unit, direction:'protocol-relative',
 *               requires:[...input keys...], compute(stateSample) -> number }
 * Deterministic by construction: pure functions of the input arrays. */
var METRICS = [
  {
    id: 'mixing-rate', title: 'Mixing rate', unit: '1/s',
    direction: 'protocol-relative', requires: ['tracers'],
    compute: function (s) {
      var t = s.tracers;
      if (!tracerOK(t)) return NaN;
      if (t.time <= 0) return 0;
      // Proxy: growth rate of tracer position-distribution entropy (8x8 bins).
      // A well-stirred field raises H; the rate is protocol-relative.
      var H0 = histogramEntropy(t.x0, t.y0, t.n, 8);
      var H1 = histogramEntropy(t.x, t.y, t.n, 8);
      return Math.max(0, H1 - H0) / t.time;
    }
  },
  {
    id: 'dispersion', title: 'Dispersion', unit: 'm^2/s',
    direction: 'protocol-relative', requires: ['tracers'],
    compute: function (s) {
      var t = s.tracers;
      if (!tracerOK(t)) return NaN;
      if (t.time <= 0) return 0;
      // Mean squared displacement from release positions, per second.
      var sc = isFin(s.scale) ? s.scale : 1, sum = 0;
      for (var i = 0; i < t.n; i++) {
        var dx = t.x[i] - t.x0[i], dy = t.y[i] - t.y0[i];
        sum += dx * dx + dy * dy;
      }
      return (sum / t.n) * sc * sc / t.time;
    }
  },
  {
    id: 'enstrophy-proxy', title: 'Enstrophy proxy', unit: '1/s^2',
    direction: 'protocol-relative', requires: ['field'],
    compute: function (s) {
      if (!fieldOK(s.field)) return NaN;
      // Proxy: mean of squared coarse-grid vorticity (integral of omega^2).
      var w = vorticityGrid(s.field), sum = 0;
      for (var i = 0; i < w.length; i++) sum += w[i] * w[i];
      return sum / w.length;
    }
  },
  {
    id: 'ke-proxy', title: 'KE proxy', unit: 'm^2/s^2',
    direction: 'protocol-relative', requires: ['field'],
    compute: function (s) {
      if (!fieldOK(s.field)) return NaN;
      // Proxy: mean specific kinetic energy on the coarse grid.
      var sc = isFin(s.scale) ? s.scale : 1;
      var sum = 0, u = s.field.u, v = s.field.v;
      for (var i = 0; i < u.length; i++) sum += u[i] * u[i] + v[i] * v[i];
      return 0.5 * (sum / u.length) * sc * sc;
    }
  },
  {
    id: 'merger-time', title: 'Merger time', unit: 's',
    direction: 'protocol-relative', requires: ['series'],
    compute: function (s) {
      var se = s.series;
      if (!se || !se.vortexCount || se.vortexCount.length < 2 || !isFin(se.dt)) return NaN;
      // First step where the dominant-vortex count drops below its initial
      // value (needs >=2 to start). -1 = no merger inside the window.
      var c0 = se.vortexCount[0];
      if (!(c0 >= 2)) return -1;
      for (var i = 1; i < se.vortexCount.length; i++) {
        if (se.vortexCount[i] < c0) return i * se.dt;
      }
      return -1;
    }
  },
  {
    id: 'filament-topology', title: 'Filament topology', unit: 'density',
    direction: 'protocol-relative', requires: ['field'],
    compute: function (s) {
      if (!fieldOK(s.field)) return NaN;
      // Proxy: number of 4-connected regions where |omega| exceeds
      // mean(|w|)+std(|w|), normalised by grid size. Counts coherent
      // filaments/eddies; flood fill, deterministic order.
      var nx = s.field.nx, ny = s.field.ny;
      var w = vorticityGrid(s.field);
      var aw = new Array(w.length), i;
      for (i = 0; i < w.length; i++) aw[i] = Math.abs(w[i]);
      var m = mean(aw), thr = m + stdOf(aw, m);
      var seen = new Array(w.length), comps = 0;
      for (i = 0; i < w.length; i++) seen[i] = 0;
      var q = [];
      for (i = 0; i < w.length; i++) {
        if (seen[i] || aw[i] <= thr) continue;
        comps++; q.length = 0; q.push(i); seen[i] = 1;
        while (q.length) {
          var c = q.pop();
          var cx = c % nx, cy = (c / nx) | 0;
          var nb = [c - 1, c + 1, c - nx, c + nx];
          for (var b = 0; b < 4; b++) {
            var n2 = nb[b], okN = true;
            if (n2 < 0 || n2 >= w.length) okN = false;
            else if (b === 0 && cx === 0) okN = false;
            else if (b === 1 && cx === nx - 1) okN = false;
            if (!okN || seen[n2] || aw[n2] <= thr) continue;
            seen[n2] = 1; q.push(n2);
          }
          void cy;
        }
      }
      return comps / w.length;
    }
  },
  {
    id: 'symmetry-breaking', title: 'Symmetry breaking', unit: '0-1',
    direction: 'protocol-relative', requires: ['field'],
    compute: function (s) {
      if (!fieldOK(s.field)) return NaN;
      // |mean(w)| / mean(|w|): symmetric swirl fields cancel to ~0; a
      // net-spin or one-sided pattern scores toward 1. Clamped 0..1.
      var w = vorticityGrid(s.field), sm = 0, sa = 0;
      for (var i = 0; i < w.length; i++) { sm += w[i]; sa += Math.abs(w[i]); }
      return clamp01(Math.abs(sm / w.length) / (sa / w.length + 1e-12));
    }
  },
  {
    id: 'predictability-horizon', title: 'Predictability horizon', unit: 's',
    direction: 'protocol-relative', requires: ['series'],
    compute: function (s) {
      var se = s.series;
      if (!se || !se.twinSep || se.twinSep.length < 2 || !isFin(se.dt)) return NaN;
      // First time a perturbed twin's separation doubles its initial value
      // (Lyapunov-style proxy). -1 = no doubling inside the window.
      var d0 = se.twinSep[0];
      if (!(d0 > 0)) return NaN;
      for (var i = 1; i < se.twinSep.length; i++) {
        if (se.twinSep[i] >= 2 * d0) return i * se.dt;
      }
      return -1;
    }
  },
  {
    id: 'energy-decay', title: 'Energy decay', unit: '1/s',
    direction: 'protocol-relative', requires: ['series'],
    compute: function (s) {
      var se = s.series;
      if (!se || !se.ke || se.ke.length < 2 || !isFin(se.dt)) return NaN;
      // Exponential decay constant: -slope of ln(KE) vs t (least squares).
      // Positive = decaying, negative = driven/growing, 0 = steady.
      var t = [], y = [];
      for (var i = 0; i < se.ke.length; i++) {
        if (se.ke[i] > 0) { t.push(i * se.dt); y.push(Math.log(se.ke[i])); }
      }
      if (t.length < 2) return NaN;
      var sl = slope(t, y);
      return isFin(sl) ? -sl : NaN;
    }
  },
  {
    id: 'vorticity-correlation-length', title: 'Vorticity correlation length', unit: 'm',
    direction: 'protocol-relative', requires: ['field'],
    compute: function (s) {
      if (!fieldOK(s.field)) return NaN;
      // On-axis autocorrelation of omega; first lag where C < 1/e.
      // Falls back to the domain size if it never drops (documented).
      var nx = s.field.nx, ny = s.field.ny;
      var w = vorticityGrid(s.field);
      var C0 = 0, i, j;
      for (i = 0; i < w.length; i++) C0 += w[i] * w[i];
      if (!(C0 > 0)) return 0;
      var sc = isFin(s.scale) ? s.scale : 1, h = sc / nx;
      for (var lag = 1; lag <= (nx / 2) | 0; lag++) {
        var c = 0;
        for (j = 0; j < ny; j++) {
          for (i = 0; i < nx; i++) c += w[j * nx + i] * w[j * nx + ((i + lag) % nx)];
        }
        if (c / C0 < 1 / Math.E) return lag * h;
      }
      return nx * h; // = scale: correlation spans the whole domain
    }
  },
  {
    id: 'injection-influence-radius', title: 'Injection influence radius', unit: 'm',
    direction: 'protocol-relative', requires: ['field', 'field0', 'injection'],
    compute: function (s) {
      if (!fieldOK(s.field) || !fieldOK(s.field0)) return NaN;
      if (!s.injection || !isFin(s.injection.cx) || !isFin(s.injection.cy)) return NaN;
      // Radius from the injection centre containing 90% of the |delta-V|^2
      // energy between pre- and post-injection coarse fields.
      var nx = s.field.nx, ny = s.field.ny;
      if (nx !== s.field0.nx || ny !== s.field0.ny) return NaN;
      var sc = isFin(s.scale) ? s.scale : 1;
      var cells = [], total = 0, i, j;
      for (j = 0; j < ny; j++) {
        for (i = 0; i < nx; i++) {
          var k = j * nx + i;
          var du = s.field.u[k] - s.field0.u[k], dv = s.field.v[k] - s.field0.v[k];
          var e = du * du + dv * dv;
          var r = Math.sqrt((i / nx - s.injection.cx) * (i / nx - s.injection.cx) +
                            (j / ny - s.injection.cy) * (j / ny - s.injection.cy));
          cells.push({ r: r, e: e }); total += e;
        }
      }
      if (!(total > 0)) return 0;
      cells.sort(function (a, b) { return a.r - b.r; });
      var acc = 0;
      for (var c = 0; c < cells.length; c++) {
        acc += cells[c].e;
        if (acc >= 0.9 * total) return cells[c].r * sc;
      }
      return cells[cells.length - 1].r * sc;
    }
  },
  {
    id: 'rollback-fidelity', title: 'Rollback fidelity', unit: '0-1',
    direction: 'protocol-relative', requires: ['field', 'referenceField'],
    compute: function (s) {
      if (!fieldOK(s.field) || !fieldOK(s.referenceField)) return NaN;
      if (s.field.nx !== s.referenceField.nx || s.field.ny !== s.referenceField.ny) return NaN;
      // 1 - relative L1 distance to the pre-restore reference; 1 = perfect.
      var d = 0, base = 0, i;
      for (i = 0; i < s.field.u.length; i++) {
        d += Math.abs(s.field.u[i] - s.referenceField.u[i]) +
             Math.abs(s.field.v[i] - s.referenceField.v[i]);
        base += Math.abs(s.referenceField.u[i]) + Math.abs(s.referenceField.v[i]);
      }
      return clamp01(1 - d / (base + 1e-12));
    }
  }
];
var BY_ID = {};
for (var mi = 0; mi < METRICS.length; mi++) BY_ID[METRICS[mi].id] = METRICS[mi];

function computeAll(state) {
  var out = {}, missing = {};
  for (var i = 0; i < METRICS.length; i++) {
    var m = METRICS[i];
    var absent = [];
    for (var r = 0; r < m.requires.length; r++) {
      if (!state || state[m.requires[r]] == null) absent.push(m.requires[r]);
    }
    if (absent.length) { out[m.id] = NaN; missing[m.id] = absent; continue; }
    var v;
    try { v = m.compute(state); } catch (e) { v = NaN; }
    out[m.id] = isFin(v) ? v : NaN;
  }
  return { values: out, missing: missing };
}

/* ---------------- composite bundles (per protocol) ----------------
 * weights MUST sum to 1. validateBundle() REJECTS anything else.
 * Bundles are direction-free: the composite is a weighted blend of
 * per-metric baseline percentiles (0..1), so "good" stays protocol-defined. */
var BUNDLE_TOL = 1e-9;
var DEFAULT_BUNDLES = {
  'spiral-default': {
    'mixing-rate': 0.15, 'dispersion': 0.10, 'enstrophy-proxy': 0.10,
    'ke-proxy': 0.05, 'merger-time': 0.05, 'filament-topology': 0.10,
    'symmetry-breaking': 0.05, 'predictability-horizon': 0.10,
    'energy-decay': 0.05, 'vorticity-correlation-length': 0.05,
    'injection-influence-radius': 0.10, 'rollback-fidelity': 0.10
  },
  'collision-default': {
    'mixing-rate': 0.05, 'dispersion': 0.05, 'enstrophy-proxy': 0.15,
    'ke-proxy': 0.10, 'merger-time': 0.20, 'filament-topology': 0.10,
    'symmetry-breaking': 0.05, 'predictability-horizon': 0.05,
    'energy-decay': 0.05, 'vorticity-correlation-length': 0.05,
    'injection-influence-radius': 0.05, 'rollback-fidelity': 0.10
  },
  'wake-default': {
    'mixing-rate': 0.20, 'dispersion': 0.15, 'enstrophy-proxy': 0.05,
    'ke-proxy': 0.05, 'merger-time': 0.00, 'filament-topology': 0.05,
    'symmetry-breaking': 0.05, 'predictability-horizon': 0.05,
    'energy-decay': 0.05, 'vorticity-correlation-length': 0.10,
    'injection-influence-radius': 0.15, 'rollback-fidelity': 0.10
  }
};
var customBundles = {};

function validateBundle(weights) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new Error('w07-metrics: bundle must be an object of metric-id -> weight');
  }
  var keys = Object.keys(weights), sum = 0, copy = {};
  for (var i = 0; i < keys.length; i++) {
    var id = keys[i], w = weights[id];
    if (!BY_ID[id]) throw new Error('w07-metrics: unknown metric id in bundle: ' + id);
    if (!isFin(w) || w < 0) {
      throw new Error('w07-metrics: weight for ' + id + ' must be a finite number >= 0');
    }
    sum += w; copy[id] = w;
  }
  if (keys.length === 0) throw new Error('w07-metrics: bundle has no weights');
  if (Math.abs(sum - 1) > BUNDLE_TOL) {
    throw new Error('w07-metrics: bundle weights must sum to 1 (got ' + sum + ') — rejected');
  }
  return copy;
}
function getBundle(protocolId) {
  var raw = customBundles[protocolId] || DEFAULT_BUNDLES[protocolId];
  if (!raw) throw new Error('w07-metrics: no bundle for protocol ' + protocolId);
  return validateBundle(raw);
}
function setBundle(protocolId, weights) {
  customBundles[protocolId] = validateBundle(weights);
  return customBundles[protocolId];
}

/* ---------------- 30-run calibration baseline per config ---------------- */
var STORE_KEY = 'vortex.w07.calibration.v1';
var calib = {}; // configId -> metricId -> { sorted:[], mean, std, n, updatedAt }

function persistCalib() {
  try {
    if (typeof root.localStorage !== 'undefined') {
      root.localStorage.setItem(STORE_KEY, JSON.stringify(calib));
    }
  } catch (e) { /* quota / privacy mode: in-memory only */ }
}
function loadCalib() {
  try {
    if (typeof root.localStorage !== 'undefined') {
      var raw = root.localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') calib = parsed;
      }
    }
  } catch (e) { calib = {}; }
}
loadCalib();

function calibrate(configId, runs) {
  if (typeof configId !== 'string' || !configId) {
    throw new Error('w07-metrics: calibrate needs a configId');
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('w07-metrics: calibrate needs a non-empty runs array');
  }
  if (runs.length < 30) {
    V.bus.emit('vx:degraded', {
      from: 'calibration-30', to: 'calibration-' + runs.length,
      reason: 'w07-metrics: baseline has ' + runs.length + ' runs; 30 recommended'
    });
  }
  var entry = {};
  for (var i = 0; i < METRICS.length; i++) {
    var id = METRICS[i].id, vals = [];
    for (var r = 0; r < runs.length; r++) {
      var v = runs[r] ? runs[r][id] : undefined;
      if (isFin(v)) vals.push(v);
    }
    vals.sort(function (a, b) { return a - b; });
    var m = mean(vals);
    entry[id] = { sorted: vals, mean: isFin(m) ? m : NaN, std: isFin(m) ? stdOf(vals, m) : NaN,
                  n: vals.length, updatedAt: utils.now() };
  }
  calib[configId] = entry;
  persistCalib();
  return { configId: configId, runs: runs.length };
}
/* Percentile of value within the baseline for metricId (0..1, midpoint rank
 * for ties — deterministic given sorted baseline). NaN when no baseline. */
function percentile(configId, metricId, value) {
  var e = calib[configId] && calib[configId][metricId];
  if (!e || !e.sorted.length || !isFin(value)) return NaN;
  var less = 0, eq = 0;
  for (var i = 0; i < e.sorted.length; i++) {
    if (e.sorted[i] < value) less++;
    else if (e.sorted[i] === value) eq++;
    else break;
  }
  return (less + 0.5 * eq) / e.sorted.length;
}
function zscore(configId, metricId, value) {
  var e = calib[configId] && calib[configId][metricId];
  if (!e || !isFin(value) || !isFin(e.mean) || !(e.std > 1e-12)) return 0;
  return (value - e.mean) / e.std;
}

/* ---------------- scorecard ---------------- */
var ACTIONS = ['save-to-ledger', 'rerun-seed', 'compare'];
function fmtZ(z) { return (z >= 0 ? '+' : '') + z.toFixed(2); }

function scorecard(values, opts) {
  opts = opts || {};
  var configId = opts.configId || 'spiral-default';
  var protocolId = opts.protocolId || configId;
  var weights = getBundle(protocolId);
  var perMetric = [], wsum = 0, acc = 0, best = null;
  for (var i = 0; i < METRICS.length; i++) {
    var m = METRICS[i], v = values ? values[m.id] : undefined;
    var row = { id: m.id, title: m.title, unit: m.unit, value: isFin(v) ? v : NaN,
                percentile: NaN, z: NaN };
    if (isFin(row.value)) {
      row.percentile = percentile(configId, m.id, row.value);
      row.z = zscore(configId, m.id, row.value);
      if (isFin(row.percentile)) {
        var w = weights[m.id] || 0;
        acc += w * row.percentile; wsum += w;
      }
      if (!best || Math.abs(row.z) > Math.abs(best.z)) best = row;
    }
    perMetric.push(row);
  }
  var composite = wsum > 0 ? acc / wsum : null; // weights renormalised over available metrics
  var autoInsight;
  if (best && isFin(best.z) && isFin(best.percentile)) {
    var e = calib[configId] && calib[configId][best.id];
    autoInsight = 'Largest deviation: ' + best.title + ' (z = ' + fmtZ(best.z) +
      ', ' + Math.round(best.percentile * 100) + 'th percentile of the ' +
      configId + ' baseline, n=' + (e ? e.n : 0) +
      '). Direction left to the protocol — no better/worse claim.';
  } else {
    autoInsight = 'No calibration baseline for ' + configId +
      ' yet — run 30 calibration runs first.';
  }
  return { composite: composite, perMetric: perMetric, autoInsight: autoInsight,
           actions: ACTIONS.slice(), configId: configId, protocolId: protocolId,
           manifest: { codeVersion: V.codeVersion } };
}

/* ---------------- backend consumption (guarded) ----------------
 * Metrics consume field-state snapshots and backend.sampleMetrics().
 * Guarded with VORTEX.has() / duck-typed module scan: when no backend is
 * registered this returns null instead of throwing. */
function findBackend() {
  var ids = ['w14-cpu', 'w02-gpu', 'w15-webgpu', 'w03-megafield'];
  var i, m;
  for (i = 0; i < ids.length; i++) {
    if (V.has(ids[i])) {
      m = V.get(ids[i]);
      if (m && typeof m.snapshotState === 'function') return m;
    }
  }
  var mods = V.modules();
  for (i = 0; i < mods.length; i++) {
    m = V.get(mods[i]);
    if (m && typeof m.snapshotState === 'function') return m;
  }
  return null;
}
function sampleFromBackend() {
  var b = findBackend();
  if (!b) return null;
  try {
    return { snapshot: b.snapshotState(),
             quick: (typeof b.sampleMetrics === 'function') ? b.sampleMetrics() : null };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

/* ---------------- Scorecard panel (DOM-guarded, headless-safe) ---------------- */
function buildPanel(el, initial) {
  var doc = root.document;
  el.className = 'vx-scorecard';
  var head = doc.createElement('h3'); head.textContent = 'Scorecard'; el.appendChild(head);
  var big = doc.createElement('div'); big.className = 'vx-score-big'; el.appendChild(big);
  var insight = doc.createElement('p'); insight.className = 'vx-insight'; el.appendChild(insight);
  var rows = doc.createElement('div'); rows.className = 'vx-score-rows'; el.appendChild(rows);
  var btns = doc.createElement('div'); btns.className = 'vx-score-actions'; el.appendChild(btns);
  ACTIONS.forEach(function (a) {
    var b = doc.createElement('button');
    b.textContent = a.replace(/-/g, ' ');
    b.setAttribute('data-action', a);
    b.onclick = function () {
      V.bus.emit('vx:scorecard-action', { action: a, at: utils.now() });
      V.ui.announce('Scorecard action: ' + a);
    };
    btns.appendChild(b);
  });
  function render(sc) {
    big.textContent = (sc && isFin(sc.composite))
      ? 'Composite ' + sc.composite.toFixed(3) : 'Composite —';
    insight.textContent = (sc && sc.autoInsight) || '';
    rows.innerHTML = '';
    if (sc && sc.perMetric) {
      sc.perMetric.forEach(function (r) {
        var row = doc.createElement('div'); row.className = 'vx-score-row';
        var name = doc.createElement('span'); name.className = 'vx-score-name';
        name.textContent = r.title + ' (' + r.unit + ')';
        var val = doc.createElement('span'); val.className = 'vx-score-val';
        val.textContent = isFin(r.value) ? r.value.toPrecision(4) : '—';
        var bar = doc.createElement('div'); bar.className = 'vx-score-bar';
        var fill = doc.createElement('div'); fill.className = 'vx-score-fill';
        fill.style.width = isFin(r.percentile) ? Math.round(r.percentile * 100) + '%' : '0%';
        bar.appendChild(fill);
        var pct = doc.createElement('span'); pct.className = 'vx-score-pct';
        pct.textContent = isFin(r.percentile) ? 'p' + Math.round(r.percentile * 100) : 'no base';
        row.appendChild(name); row.appendChild(val); row.appendChild(bar); row.appendChild(pct);
        rows.appendChild(row);
      });
    }
  }
  render(initial || null);
  V.bus.on('vx:scorecard', function (sc) { render(sc); });
  return { render: render };
}
V.ui.registerPanel('w07-scorecard', 'Scorecard', function (el) {
  // mountFn: headless-safe — never throws without a DOM.
  if (!utils.isBrowser() || !el || typeof root.document === 'undefined') return;
  buildPanel(el, null);
});

/* ---------------- public api ---------------- */
var api = {
  metrics: METRICS,
  metric: function (id) { return BY_ID[id] || null; },
  compute: function (id, state) {
    var m = BY_ID[id];
    if (!m) throw new Error('w07-metrics: unknown metric ' + id);
    try { var v = m.compute(state); return isFin(v) ? v : NaN; }
    catch (e) { return NaN; }
  },
  computeAll: computeAll,
  validateBundle: validateBundle,
  getBundle: getBundle,
  setBundle: setBundle,
  bundles: function () {
    var out = {};
    Object.keys(DEFAULT_BUNDLES).forEach(function (k) { out[k] = validateBundle(DEFAULT_BUNDLES[k]); });
    return out;
  },
  calibrate: calibrate,
  percentile: percentile,
  zscore: zscore,
  scorecard: scorecard,
  calibrationInfo: function () {
    var out = {};
    Object.keys(calib).forEach(function (c) {
      out[c] = { metrics: Object.keys(calib[c]).length,
                 n: (calib[c]['mixing-rate'] || {}).n || 0 };
    });
    return out;
  },
  clearCalibration: function (configId) {
    if (configId) delete calib[configId]; else calib = {};
    persistCalib();
  },
  sampleFromBackend: sampleFromBackend,
  selfTest: selfTest
};

V.register('w07-metrics', api);

/* ---------------- selfTest ----------------
 * Headless-safe: synthetic state only, no DOM, no backend required. */
function syntheticState(seed) {
  var rnd = utils.mulberry32(seed);
  var n = 200, x = [], y = [], x0 = [], y0 = [], i, j;
  for (i = 0; i < n; i++) {
    var a = rnd(), b = rnd();
    x0.push(a); y0.push(b);
    // deterministic stir: rotation + small seeded jitter
    x.push(a + 0.08 * Math.sin(6.28 * b) + 0.01 * (rnd() - 0.5));
    y.push(b + 0.08 * Math.cos(6.28 * a) + 0.01 * (rnd() - 0.5));
  }
  var nx = 16, ny = 16, u = [], v = [];
  for (j = 0; j < ny; j++) {
    for (i = 0; i < nx; i++) {
      var px = i / nx - 0.5, py = j / ny - 0.5;
      var r2 = px * px + py * py + 1e-6;
      // swirl (vortex) + seeded noise
      u.push(-py / r2 * 0.05 + 0.02 * (rnd() - 0.5));
      v.push(px / r2 * 0.05 + 0.02 * (rnd() - 0.5));
    }
  }
  var ke = [], en = [], vc = [], ts = [], dt = 1 / 60;
  for (i = 0; i < 60; i++) {
    ke.push(2.0 * Math.exp(-0.05 * i * dt) + 0.001 * rnd());
    en.push(5.0 * Math.exp(-0.08 * i * dt) + 0.001 * rnd());
    vc.push(i < 25 ? 2 : 1); // merger at step 25
    ts.push(1e-4 * Math.pow(2, i * dt / 8) * (1 + 0.01 * rnd())); // twin sep doubles
  }
  var field0 = { nx: nx, ny: ny, u: u.slice(), v: v.slice() };
  var fu = u.slice(), fv = v.slice();
  // gaussian injection bump at (0.6, 0.4)
  for (j = 0; j < ny; j++) {
    for (i = 0; i < nx; i++) {
      var dx = i / nx - 0.6, dy = j / ny - 0.4;
      var g = Math.exp(-(dx * dx + dy * dy) / 0.01);
      fu[j * nx + i] += 0.3 * g; fv[j * nx + i] += 0.1 * g;
    }
  }
  var ru = fu.slice(), rv = fv.slice();
  for (i = 0; i < ru.length; i++) { ru[i] += 0.001 * (rnd() - 0.5); rv[i] += 0.001 * (rnd() - 0.5); }
  return {
    tracers: { n: n, x: x, y: y, x0: x0, y0: y0, time: 10 },
    field: { nx: nx, ny: ny, u: fu, v: fv },
    field0: field0,
    referenceField: { nx: nx, ny: ny, u: ru, v: rv },
    series: { dt: dt, ke: ke, enstrophy: en, vortexCount: vc, twinSep: ts },
    injection: { cx: 0.6, cy: 0.4 },
    scale: 1
  };
}

function selfTest() {
  var checks = [];
  function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: String(detail) }); }

  var s1 = syntheticState(1337), s2 = syntheticState(1337);
  var r1 = computeAll(s1), r2 = computeAll(s2);

  // 1. every metric computes a finite number on synthetic state
  for (var i = 0; i < METRICS.length; i++) {
    var m = METRICS[i], v = r1.values[m.id];
    check('metric ' + m.id + ' finite', isFin(v), 'value=' + v);
  }
  // 2. determinism: identical input -> identical output
  check('deterministic', utils.stableStringify(r1) === utils.stableStringify(r2),
    'two computeAll runs on same synthetic state match byte-for-byte');

  // 3. composite bundles: valid passes, invalid rejected
  var okValid = false;
  try { validateBundle(DEFAULT_BUNDLES['spiral-default']); okValid = true; } catch (e) {}
  check('bundle valid passes', okValid, 'spiral-default sums to 1');
  var rejects = 0, tries = 0;
  function expectReject(w, why) {
    tries++;
    try { validateBundle(w); } catch (e) { rejects++; }
  }
  expectReject({ 'mixing-rate': 0.6, 'dispersion': 0.6 }, 'sum 1.2');
  expectReject({ 'mixing-rate': 0.5, 'dispersion': 0.5, 'ke-proxy': 0.0001 }, 'sum != 1 (1.0001)');
  expectReject({ 'mixing-rate': 1.5, 'dispersion': -0.5 }, 'negative weight');
  expectReject({ 'nope': 1.0 }, 'unknown metric');
  expectReject({}, 'empty');
  check('bundle invalid rejected', rejects === tries, rejects + '/' + tries + ' bad bundles rejected');

  // 4. calibration: 30 synthetic runs -> sane percentiles
  var runs = [];
  for (var k = 0; k < 30; k++) runs.push(computeAll(syntheticState(9000 + k)).values);
  calibrate('selftest-config', runs);
  var pctOK = true, monoOK = true, detailP = '';
  for (i = 0; i < METRICS.length; i++) {
    var id = METRICS[i].id;
    var pMid = percentile('selftest-config', id, runs[15][id]);
    if (!(pMid >= 0 && pMid <= 1) || !isFin(pMid)) { pctOK = false; detailP = id + '=' + pMid; break; }
    // monotonicity sanity: min value gets the smallest percentile
    var vals = runs.map(function (r) { return r[id]; }).sort(function (a, b) { return a - b; });
    var pMin = percentile('selftest-config', id, vals[0]);
    var pMax = percentile('selftest-config', id, vals[vals.length - 1]);
    if (!(pMin <= pMax)) { monoOK = false; detailP = id; break; }
  }
  check('calibration percentiles in [0,1]', pctOK, detailP || '30 runs, 12 metrics');
  check('calibration monotone', monoOK, detailP || 'min percentile <= max percentile');

  // 5. scorecard shape
  var sc = scorecard(runs[0], { configId: 'selftest-config', protocolId: 'spiral-default' });
  check('scorecard shape', sc && sc.perMetric.length === 12 &&
        isFin(sc.composite) && sc.composite >= 0 && sc.composite <= 1 &&
        typeof sc.autoInsight === 'string' && sc.autoInsight.length > 0 &&
        JSON.stringify(sc.actions) === JSON.stringify(ACTIONS),
    'composite=' + sc.composite + ' insight="' + sc.autoInsight.slice(0, 40) + '..."');
  check('scorecard no-baseline path', (function () {
    var sc2 = scorecard(runs[0], { configId: 'no-such-config', protocolId: 'spiral-default' });
    return sc2 && sc2.composite === null && /No calibration/.test(sc2.autoInsight);
  })(), 'composite null + guidance line when baseline missing');

  // 6. backend guard: never throws. With no backend registered -> null; with a
  // backend present (full integration) -> real metrics. Both are correct.
  var bg = null, bgThrew = false;
  try { bg = sampleFromBackend(); } catch (e) { bgThrew = true; }
  var anyBackend = V.has('w14-cpu') || V.has('w02-gpu') || V.has('w15-webgpu') || V.has('w03-megafield');
  check('backend guard', !bgThrew && (anyBackend ? bg !== null : bg === null),
    anyBackend ? 'backend present -> metrics sampled, no throw' : 'no backend registered -> null, no throw');

  // 7. panel registered (mountFn itself is DOM-guarded; checked headless)
  var panels = V.ui.panels(), hasPanel = false;
  for (i = 0; i < panels.length; i++) if (panels[i].id === 'w07-scorecard') hasPanel = true;
  check('scorecard panel registered', hasPanel, 'w07-scorecard in ui registry');

  api.clearCalibration('selftest-config');

  var ok = true;
  for (i = 0; i < checks.length; i++) if (!checks[i].ok) ok = false;
  return { ok: ok, checks: checks };
}

})(typeof window !== 'undefined' ? window : globalThis);
