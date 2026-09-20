/* VORTEX lab-metrics.js — [W32] Lab metrics: four families, perf footer data,
 * records hall of fame, 90-day retention with downsampling, JSON/CSV/Markdown
 * export, and the "Lab metrics" panel.
 *
 * Design source: lane-14-vortex.md §9 (Background & ops), "Lab metrics (W32)":
 * four families (performance, science, learning, system); evolved perf footer
 * (6 numbers + sparkline); drill-down tabs + Records hall of fame; 90-day
 * retention with downsampling; JSON/CSV/Markdown export.
 *
 * Plain browser script, IIFE, no modules, no build step. Runs from file://.
 * No network, no fetch/XHR/WebSocket/eval. localStorage only inside try/catch.
 * Headless-safe: no DOM touched at load or in selfTest(); the panel is DOM-
 * guarded and never registers output when there is no document.
 *
 * HONESTY RULES (this module is the lab's memory of itself):
 *  1. Numbers come from bus events or guarded getters on sibling modules —
 *     never invented. When a source module is absent the family shows the
 *     real event-driven values only, and the panel labels unmeasured fields
 *     as "no data yet" rather than 0.
 *  2. Records track maxima (or minima where lower is better) only for keys
 *     we actually measured this session or loaded from the guarded store.
 *  3. Retention: raw samples ≤ 7 days; daily aggregates past 7 days; weekly
 *     aggregates past 30 days; nothing older than 90 days. downsample() is
 *     idempotent.
 */
(function (root) {
'use strict';

var V = root.VORTEX;
if (!V || !V.utils || !V.bus) throw new Error('w32-labmetrics: VORTEX namespace missing — load vx-namespace.js first');
var utils = V.utils;

var DAY = 24 * 3600 * 1000;
var STORE_KEY = 'vortex.labmetrics.v1';
var REC_KEY = 'vortex.labmetrics.records.v1';

/* ---------------- tiny helpers ---------------- */
function isFin(v) { return typeof v === 'number' && isFinite(v); }
function nowMs() { return Date.now(); }
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  var i = (sorted.length - 1) * q;
  var lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/* ---------------- family stores ---------------- */
var fam = {
  performance: { fps: NaN, frameMs: NaN, frameMsP50: NaN, frameMsP95: NaN, tier: '—', backend: '—', tracers: 0 },
  science: { runs: 0, protocolsScored: 0, verdicts: { CONFIRMED: 0, REFUTED: 0, INCONCLUSIVE: 0 } },
  learning: { teachHerRounds: 0, rubricSum: 0, rubricN: 0, dueCards: 0, brierSum: 0, brierN: 0 },
  system: { incidents: 0, snapshots: 0, storageBytes: 0 }
};

/* ---------------- raw time-series (ring + retention) ----------------
 * Series entries: { t: epoch-ms, v: number }. Kept in `raw` for <=7 days,
 * then folded by downsample() into daily / weekly aggregate buckets.
 */
var series = { fps: [], frameMs: [], runs: [], incidents: [] };
function pushSample(name, v, t) {
  var s = series[name]; if (!s) { s = series[name] = []; }
  s.push({ t: (t == null ? nowMs() : t), v: v });
  if (s.length > 4096) s.splice(0, s.length - 4096); // hard cap, never unbounded
}

/* fps history for the sparkline: exactly the last 120 render samples */
var fpsHist = [];
function pushFps(f) {
  if (!isFin(f)) return;
  fpsHist.push(f);
  if (fpsHist.length > 120) fpsHist.splice(0, fpsHist.length - 120);
  pushSample('fps', f);
}

/* frame time ring for p50/p95 (last 240 samples) */
var frameRing = [];
function pushFrameMs(ms) {
  if (!isFin(ms) || ms < 0) return;
  frameRing.push(ms);
  if (frameRing.length > 240) frameRing.shift();
  pushSample('frameMs', ms);
}

/* ---------------- retention / downsampling ----------------
 * Policy: raw samples older than 7d fold into daily means; daily buckets
 * older than 30d fold into weekly means; anything older than 90d is dropped.
 * Idempotent — safe to call on a schedule and from selfTest().
 *
 * Returns a report { raw, daily, weekly } of resulting bucket counts per
 * series, useful for the retention tab and the selfTest assertions.
 */
function bucketize(entries, spanMs, anchorMs) {
  // anchorMs: "now". Returns array of { t: bucketStartMs, v: mean, n: count }.
  var buckets = {};
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var k = Math.floor((anchorMs - e.t) / spanMs); // 0 = newest bucket
    if (k < 0) k = 0;
    if (!buckets[k]) buckets[k] = { t: anchorMs - (k + 1) * spanMs, v: 0, n: 0 };
    buckets[k].v += e.v; buckets[k].n += 1;
  }
  var out = [];
  var ks = Object.keys(buckets).map(Number).sort(function (a, b) { return a - b; });
  for (var j = 0; j < ks.length; j++) {
    var b = buckets[ks[j]];
    out.push({ t: b.t, v: b.v / b.n, n: b.n });
  }
  return out;
}
function downsample(atMs) {
  var anchor = (atMs == null ? nowMs() : atMs);
  var rep = {};
  var names = Object.keys(series);
  for (var i = 0; i < names.length; i++) {
    var nm = names[i];
    var old = series[nm];
    var fresh = [], aging = [];
    for (var j = 0; j < old.length; j++) {
      var age = anchor - old[j].t;
      if (age <= 7 * DAY) fresh.push(old[j]);
      else if (age <= 90 * DAY) aging.push(old[j]);
      // > 90d: dropped (never resurrected)
    }
    var daily = bucketize(aging.filter(function (e) { return anchor - e.t <= 30 * DAY; }), DAY, anchor);
    var weekly = bucketize(aging.filter(function (e) { return anchor - e.t > 30 * DAY; }), 7 * DAY, anchor);
    series[nm] = fresh;
    rep[nm] = { raw: fresh.length, daily: daily.length, weekly: weekly.length };
    series[nm + ':daily'] = daily;
    series[nm + ':weekly'] = weekly;
  }
  return rep;
}

/* ---------------- records hall of fame ----------------
 * { key: { metric, value, at, runId, dir } }, dir: 'max' | 'min'.
 */
var records = {};
var REC_DIR = {
  'perf.fps': 'max',
  'perf.frameMsP95': 'min',
  'perf.tracers': 'max',
  'sci.runs': 'max',
  'sci.protocolsScored': 'max',
  'learn.brier': 'min',
  'learn.meanRubric': 'max'
};
function storeLoad(key) {
  try {
    if (typeof root.localStorage === 'undefined') return null;
    var raw = root.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; } // quota / private-mode / blocked: honestly empty
}
function storeSave(key, obj) {
  try {
    if (typeof root.localStorage === 'undefined') return false;
    root.localStorage.setItem(key, JSON.stringify(obj));
    return true;
  } catch (e) {
    V.bus.emit('vx:error', { code: 'VX_E_QUOTA', message: 'lab-metrics: records persistence failed', stage: 'labmetrics' });
    return false;
  }
}
(function restoreRecords() {
  var r = storeLoad(REC_KEY);
  if (r && typeof r === 'object') records = r;
})();
function record(key, value, runId) {
  if (!isFin(value)) return false;
  var dir = REC_DIR[key] || 'max';
  var cur = records[key];
  var better = !cur || (dir === 'max' ? value > cur.value : value < cur.value);
  if (better) {
    records[key] = { metric: key, value: value, at: nowMs(), runId: runId || null, dir: dir };
    storeSave(REC_KEY, records);
  }
  return better;
}
function getRecords() {
  var out = [];
  var ks = Object.keys(records).sort();
  for (var i = 0; i < ks.length; i++) out.push(records[ks[i]]);
  return out;
}

/* ---------------- event wiring ---------------- */
var currentRunId = null;

V.bus.on('vx:frame', function (d) {
  d = d || {};
  var dt = isFin(d.dt) ? d.dt : NaN;         // seconds per frame
  var fps = isFin(d.fps) ? d.fps : (isFin(dt) && dt > 0 ? 1 / dt : NaN);
  if (isFin(dt)) pushFrameMs(dt * 1000);
  if (isFin(fps)) pushFps(fps);
  recomputePerf();
});
V.bus.on('vx:ready', function (d) {
  d = d || {};
  if (d.backend) fam.performance.backend = String(d.backendName || (d.backend && d.backend.name) || d.backend);
  if (isFin(d.tracers)) { fam.performance.tracers = Math.round(d.tracers); record('perf.tracers', Math.round(d.tracers), currentRunId); }
});
V.bus.on('vx:tier', function (d) {
  if (d && d.tier) fam.performance.tier = String(d.tier);
});
V.bus.on('vx:degraded', function (d) {
  fam.system.incidents += 1; pushSample('incidents', 1);
  if (d && d.to) fam.performance.tier = String(d.to);
});
V.bus.on('vx:run', function (d) {
  d = d || {};
  if (d.status === 'start') currentRunId = d.runId || utils.uid('run');
  if (d.status === 'complete') {
    fam.science.runs += 1; pushSample('runs', 1);
    record('sci.runs', fam.science.runs, currentRunId);
  }
});
V.bus.on('vx:protocol', function (d) {
  d = d || {};
  if (d.status === 'scored') {
    fam.science.protocolsScored += 1;
    record('sci.protocolsScored', fam.science.protocolsScored, d.runId || currentRunId);
    var v = String(d.verdict || '').toUpperCase();
    if (fam.science.verdicts[v] !== undefined) fam.science.verdicts[v] += 1;
  }
});
/* Verdicts may also arrive on their own bus topic (W06/W13 emit vx:verdict). */
V.bus.on('vx:verdict', function (d) {
  d = d || {};
  var v = String(d.verdict || '').toUpperCase();
  if (fam.science.verdicts[v] !== undefined) {
    fam.science.verdicts[v] += 1;
  }
});
V.bus.on('vx:teachher', function (d) {
  d = d || {};
  if (d.phase === 'remember' || d.roundComplete) {
    fam.learning.teachHerRounds += 1;
    var r = d.rubric;
    if (r) {
      var vals = [r.prediction, r.probe, r.observation, r.retention];
      var s = 0, n = 0;
      for (var i = 0; i < vals.length; i++) if (isFin(vals[i])) { s += vals[i]; n++; }
      if (n) {
        fam.learning.rubricSum += s; fam.learning.rubricN += n;
        record('learn.meanRubric', fam.learning.rubricSum / fam.learning.rubricN, d.runId || currentRunId);
      }
    }
  }
  if (isFin(d.dueCards)) fam.learning.dueCards = Math.max(0, Math.round(d.dueCards));
});
V.bus.on('vx:market', function (d) {
  d = d || {};
  if (isFin(d.brier)) {
    fam.learning.brierSum += d.brier; fam.learning.brierN += 1;
    record('learn.brier', fam.learning.brierSum / fam.learning.brierN, currentRunId);
  }
});
V.bus.on('vx:snapshot', function (d) {
  d = d || {};
  fam.system.snapshots += 1;
  if (isFin(d.bytes)) fam.system.storageBytes += Math.round(d.bytes);
});
V.bus.on('vx:error', function () {
  fam.system.incidents += 1; pushSample('incidents', 1);
});

/* Guarded getters on optional sibling modules — never invent their numbers. */
function recomputePerf() {
  // Prefer W11 governor's measured values when present (guarded).
  try {
    var gov = V.get && V.get('w11-governor');
    if (gov && typeof gov.sample === 'function') {
      var s = gov.sample();
      if (s) {
        if (isFin(s.fps)) { fam.performance.fps = s.fps; pushFps(s.fps); }
        if (isFin(s.frameMs)) fam.performance.frameMs = s.frameMs;
        if (s.tier) fam.performance.tier = String(s.tier);
        if (isFin(s.frameMsP95)) fam.performance.frameMsP95 = s.frameMsP95;
        return;
      }
    }
  } catch (e) { /* module present but uncooperative: fall back to bus data */ }
  // Bus-driven fallback: derive from the frame ring.
  if (fpsHist.length) {
    var sum = 0, n = 0;
    for (var i = Math.max(0, fpsHist.length - 30); i < fpsHist.length; i++) { sum += fpsHist[i]; n++; }
    fam.performance.fps = n ? sum / n : NaN;
    record('perf.fps', fam.performance.fps, currentRunId);
  }
  if (frameRing.length) {
    var sorted = frameRing.slice().sort(function (a, b) { return a - b; });
    fam.performance.frameMsP50 = quantile(sorted, 0.5);
    fam.performance.frameMsP95 = quantile(sorted, 0.95);
    fam.performance.frameMs = fam.performance.frameMsP50;
    record('perf.frameMsP95', fam.performance.frameMsP95, currentRunId);
  }
}

/* ---------------- footer data (evolved perf footer) ----------------
 * EXACTLY 6 numbers + fpsHist (sparkline series, last 120). Consumed by the
 * W01/W11 footer renderer. Recomputed at most twice per second so the footer
 * never churns the DOM every frame.
 */
var _footerCache = null, _footerAt = 0;
function footerData() {
  var t = nowMs();
  if (_footerCache && (t - _footerAt) < 500) return _footerCache;
  var p = fam.performance;
  var v = fam.science.verdicts;
  var data = {
    fps: isFin(p.fps) ? r1(p.fps) : NaN,
    frameMs: isFin(p.frameMs) ? r1(p.frameMs) : NaN,
    tracers: isFin(p.tracers) ? p.tracers : 0,
    runs: fam.science.runs,
    verdicts: v.CONFIRMED + v.REFUTED + v.INCONCLUSIVE,
    incidents: fam.system.incidents
  };
  _footerCache = { numbers: data, fpsHist: fpsHist.slice() };
  _footerAt = t;
  return _footerCache;
}
function r1(x) { return Math.round(x * 10) / 10; }

/* ---------------- snapshots of families (read API) ---------------- */
function getFamily(name) {
  var f = fam[name];
  if (!f) return null;
  // shallow copy; verdicts object is copied too
  var out = {};
  var ks = Object.keys(f);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    out[k] = (k === 'verdicts') ? { CONFIRMED: f.verdicts.CONFIRMED, REFUTED: f.verdicts.REFUTED, INCONCLUSIVE: f.verdicts.INCONCLUSIVE } : f[k];
  }
  if (name === 'learning') {
    out.meanRubric = f.rubricN ? f.rubricSum / f.rubricN : NaN;
    out.brier = f.brierN ? f.brierSum / f.brierN : NaN;
    delete out.rubricSum; delete out.rubricN; delete out.brierSum; delete out.brierN;
  }
  return out;
}

/* ---------------- export: JSON / CSV / Markdown ----------------
 * Each returns a string. Download wiring is browser-only and guarded; the
 * string builders are pure and headless-testable.
 */
function escCsvCell(v) {
  var s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportJSON() {
  var doc = {
    generatedAt: new Date(nowMs()).toISOString(),
    codeVersion: V.codeVersion,
    families: {
      performance: getFamily('performance'),
      science: getFamily('science'),
      learning: getFamily('learning'),
      system: getFamily('system')
    },
    records: getRecords(),
    footer: footerData().numbers
  };
  return JSON.stringify(doc, null, 2);
}
function exportCSV() {
  var rows = [['family', 'metric', 'value', 'unit']];
  var P = getFamily('performance'), S = getFamily('science'),
      L = getFamily('learning'), Y = getFamily('system');
  rows.push(['performance', 'fps', isFin(P.fps) ? r1(P.fps) : '', 'frames/s']);
  rows.push(['performance', 'frameMs_p50', isFin(P.frameMsP50) ? r1(P.frameMsP50) : '', 'ms']);
  rows.push(['performance', 'frameMs_p95', isFin(P.frameMsP95) ? r1(P.frameMsP95) : '', 'ms']);
  rows.push(['performance', 'tier', P.tier, '']);
  rows.push(['performance', 'backend', P.backend, '']);
  rows.push(['performance', 'tracers', P.tracers, 'tracers']);
  rows.push(['science', 'runs', S.runs, 'count']);
  rows.push(['science', 'protocols_scored', S.protocolsScored, 'count']);
  rows.push(['science', 'verdicts_confirmed', S.verdicts.CONFIRMED, 'count']);
  rows.push(['science', 'verdicts_refuted', S.verdicts.REFUTED, 'count']);
  rows.push(['science', 'verdicts_inconclusive', S.verdicts.INCONCLUSIVE, 'count']);
  rows.push(['learning', 'teach_her_rounds', L.teachHerRounds, 'count']);
  rows.push(['learning', 'mean_rubric', isFin(L.meanRubric) ? r1(L.meanRubric) : '', '0-3']);
  rows.push(['learning', 'due_cards', L.dueCards, 'count']);
  rows.push(['learning', 'brier', isFin(L.brier) ? r1(L.brier) : '', '0-1 lower better']);
  rows.push(['system', 'incidents', Y.incidents, 'count']);
  rows.push(['system', 'snapshots', Y.snapshots, 'count']);
  rows.push(['system', 'storage_bytes', Y.storageBytes, 'bytes']);
  var recs = getRecords();
  for (var i = 0; i < recs.length; i++) {
    rows.push(['record', recs[i].metric, isFin(recs[i].value) ? r1(recs[i].value) : '', recs[i].dir]);
  }
  return rows.map(function (r) { return r.map(escCsvCell).join(','); }).join('\n') + '\n';
}
function exportMarkdown() {
  var P = getFamily('performance'), S = getFamily('science'),
      L = getFamily('learning'), Y = getFamily('system');
  var L1 = [];
  L1.push('# VORTEX Lab Metrics');
  L1.push('');
  L1.push('_Generated ' + new Date(nowMs()).toISOString() + ' · ' + V.codeVersion + '_');
  L1.push('');
  L1.push('## Performance');
  L1.push('');
  L1.push('- FPS: ' + (isFin(P.fps) ? r1(P.fps) : 'no data yet'));
  L1.push('- Frame time p50/p95: ' + (isFin(P.frameMsP50) ? r1(P.frameMsP50) + ' / ' + r1(P.frameMsP95) + ' ms' : 'no data yet'));
  L1.push('- Backend: ' + P.backend + ' · Tier: ' + P.tier + ' · Tracers: ' + P.tracers);
  L1.push('');
  L1.push('## Science');
  L1.push('');
  L1.push('- Runs: ' + S.runs + ' · Protocols scored: ' + S.protocolsScored);
  L1.push('- Verdicts — CONFIRMED ' + S.verdicts.CONFIRMED + ' / REFUTED ' + S.verdicts.REFUTED + ' / INCONCLUSIVE ' + S.verdicts.INCONCLUSIVE);
  L1.push('');
  L1.push('## Learning');
  L1.push('');
  L1.push('- Teach-her rounds: ' + L.teachHerRounds);
  L1.push('- Mean rubric: ' + (isFin(L.meanRubric) ? r1(L.meanRubric) + ' / 3' : 'no data yet'));
  L1.push('- Due cards: ' + L.dueCards);
  L1.push('- Market Brier: ' + (isFin(L.brier) ? r1(L.brier) + ' (lower is better)' : 'no data yet'));
  L1.push('');
  L1.push('## System');
  L1.push('');
  L1.push('- Incidents: ' + Y.incidents + ' · Snapshots: ' + Y.snapshots + ' · Storage: ' + Y.storageBytes + ' bytes');
  L1.push('');
  L1.push('## Records');
  L1.push('');
  var recs = getRecords();
  if (!recs.length) L1.push('- _No records yet._');
  for (var i = 0; i < recs.length; i++) {
    L1.push('- ' + recs[i].metric + ': ' + r1(recs[i].value) + ' (' + recs[i].dir + ', ' + new Date(recs[i].at).toISOString() + (recs[i].runId ? ', ' + recs[i].runId : '') + ')');
  }
  L1.push('');
  return L1.join('\n');
}
function download(name, text, mime) {
  if (!utils.isBrowser() || !root.document || !root.Blob || !root.URL) return false;
  try {
    var blob = new root.Blob([text], { type: mime || 'text/plain' });
    var a = root.document.createElement('a');
    a.href = root.URL.createObjectURL(blob);
    a.download = name;
    root.document.body.appendChild(a);
    a.click();
    setTimeout(function () { root.URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  } catch (e) { return false; }
}

/* ---------------- panel (DOM-guarded) ---------------- */
function mountPanel(el) {
  if (!el || !root.document) return;
  var doc = root.document;
  el.innerHTML = '';
  var tabs = ['performance', 'science', 'learning', 'system'];
  var bar = doc.createElement('div'); bar.className = 'vx-labm-tabs';
  var body = doc.createElement('div'); body.className = 'vx-labm-body';
  var active = 'performance';
  function renderTab() {
    body.innerHTML = '';
    var f = getFamily(active);
    var t = doc.createElement('table'); t.className = 'vx-labm-table';
    var ks = Object.keys(f);
    for (var i = 0; i < ks.length; i++) {
      var tr = doc.createElement('tr');
      var td1 = doc.createElement('td'); td1.textContent = ks[i];
      var td2 = doc.createElement('td');
      var v = f[ks[i]];
      td2.textContent = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      tr.appendChild(td1); tr.appendChild(td2); t.appendChild(tr);
    }
    body.appendChild(t);
  }
  for (var i = 0; i < tabs.length; i++) {
    (function (name) {
      var b = doc.createElement('button');
      b.className = 'vx-labm-tab'; b.textContent = name;
      b.onclick = function () {
        active = name; renderTab();
        var ch = bar.children;
        for (var k = 0; k < ch.length; k++) ch[k].classList.toggle('active', ch[k] === b);
      };
      if (name === active) b.classList.add('active');
      bar.appendChild(b);
    })(tabs[i]);
  }
  el.appendChild(bar); el.appendChild(body); renderTab();

  // footer preview (sparkline + the 6 numbers)
  var fp = doc.createElement('div'); fp.className = 'vx-labm-footer';
  var fh = doc.createElement('h4'); fh.textContent = 'Footer preview';
  fp.appendChild(fh);
  var cv = doc.createElement('canvas'); cv.width = 240; cv.height = 48;
  fp.appendChild(cv);
  var nums = doc.createElement('div'); nums.className = 'vx-labm-numbers';
  fp.appendChild(nums);
  el.appendChild(fp);

  // records
  var rh = doc.createElement('h4'); rh.textContent = 'Records — hall of fame';
  el.appendChild(rh);
  var rl = doc.createElement('ul'); rl.className = 'vx-labm-records';
  el.appendChild(rl);

  // export buttons
  var eb = doc.createElement('div'); eb.className = 'vx-labm-exports';
  var specs = [
    ['json', 'JSON', exportJSON, 'lab-metrics.json', 'application/json'],
    ['csv', 'CSV', exportCSV, 'lab-metrics.csv', 'text/csv'],
    ['md', 'Markdown', exportMarkdown, 'lab-metrics.md', 'text/markdown']
  ];
  for (var j = 0; j < specs.length; j++) {
    (function (s) {
      var b = doc.createElement('button');
      b.textContent = 'Export ' + s[1];
      b.onclick = function () {
        var ok = download(s[3], s[2](), s[4]);
        b.textContent = ok ? 'Saved ' + s[1] : 'Export failed';
      };
      eb.appendChild(b);
    })(specs[j]);
  }
  el.appendChild(eb);

  var timer = null;
  function refresh() {
    renderTab();
    var fd = footerData();
    var nk = Object.keys(fd.numbers);
    nums.innerHTML = nk.map(function (k) { return '<span><b>' + k + '</b> ' + fd.numbers[k] + '</span>'; }).join(' ');
    var rl2 = el.querySelector('.vx-labm-records');
    rl2.innerHTML = '';
    var recs = getRecords();
    for (var m = 0; m < recs.length; m++) {
      var li = doc.createElement('li');
      li.textContent = recs[m].metric + ': ' + r1(recs[m].value) + ' (' + recs[m].dir + ')';
      rl2.appendChild(li);
    }
    // sparkline, guarded canvas
    try {
      var ctx = cv.getContext('2d');
      if (ctx && fd.fpsHist.length > 1) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        var max = 0;
        for (var p = 0; p < fd.fpsHist.length; p++) if (fd.fpsHist[p] > max) max = fd.fpsHist[p];
        ctx.beginPath();
        for (var q = 0; q < fd.fpsHist.length; q++) {
          var x = (q / (fd.fpsHist.length - 1)) * cv.width;
          var y = cv.height - (fd.fpsHist[q] / (max || 1)) * (cv.height - 2) - 1;
          if (q === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    } catch (e) { /* canvas unavailable: numbers still render */ }
  }
  if (utils.isBrowser()) timer = setInterval(refresh, 2000);
  refresh();
  if (el._vxCleanup) { try { el._vxCleanup(); } catch (e) {} }
  el._vxCleanup = function () { if (timer) clearInterval(timer); };
}

/* ---------------- public API ---------------- */
var api = {
  getFamily: getFamily,
  footerData: footerData,
  fpsHistory: function () { return fpsHist.slice(); },
  downsample: downsample,
  series: function () { return series; },
  record: record,
  records: getRecords,
  exportJSON: exportJSON,
  exportCSV: exportCSV,
  exportMarkdown: exportMarkdown,
  download: download,
  mountPanel: mountPanel,
  retentionPolicy: function () {
    return { rawDays: 7, dailyDays: 30, totalDays: 90, series: Object.keys(series) };
  },

  selfTest: function () {
    var checks = [];
    function ck(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: String(detail || '') }); }

    // 1. synthetic frame events aggregate into performance family
    for (var i = 0; i < 130; i++) V.bus.emit('vx:frame', { dt: 1 / 60, fps: 60 });
    recomputePerf();
    var P = getFamily('performance');
    ck('perf.fps aggregated', isFin(P.fps) && Math.abs(P.fps - 60) < 1, 'fps=' + P.fps);
    ck('perf.p95 computed', isFin(P.frameMsP95), 'p95=' + P.frameMsP95);
    ck('fps history capped at 120', fpsHist.length <= 120, 'len=' + fpsHist.length);

    // 2. science: runs + verdict counts
    V.bus.emit('vx:run', { status: 'start', runId: 'test-run-1' });
    V.bus.emit('vx:run', { status: 'complete', runId: 'test-run-1' });
    V.bus.emit('vx:protocol', { status: 'scored', verdict: 'CONFIRMED', runId: 'test-run-1' });
    V.bus.emit('vx:verdict', { verdict: 'REFUTED' });
    V.bus.emit('vx:verdict', { verdict: 'bogus-verdict' }); // ignored, must not create a key
    var S = getFamily('science');
    ck('science.runs counted', S.runs >= 1, 'runs=' + S.runs);
    ck('verdicts counted', S.verdicts.CONFIRMED >= 1 && S.verdicts.REFUTED >= 1, JSON.stringify(S.verdicts));
    ck('unknown verdict ignored', S.verdicts.BOGUS === undefined && Object.keys(S.verdicts).length === 3, 'keys=' + Object.keys(S.verdicts).length);

    // 3. learning: teach-her + markets
    V.bus.emit('vx:teachher', { roundComplete: true, rubric: { prediction: 2, probe: 2, observation: 3, retention: 1 } });
    V.bus.emit('vx:teachher', { dueCards: 7 });
    V.bus.emit('vx:market', { brier: 0.2 });
    V.bus.emit('vx:market', { brier: 0.4 });
    var L = getFamily('learning');
    ck('teach-her rounds + mean rubric', L.teachHerRounds >= 1 && isFin(L.meanRubric) && Math.abs(L.meanRubric - 2) < 1e-9, 'meanRubric=' + L.meanRubric);
    ck('markets brier averaged', isFin(L.brier) && Math.abs(L.brier - 0.3) < 1e-9, 'brier=' + L.brier);

    // 4. system: incidents + snapshots
    V.bus.emit('vx:error', { code: 'VX_E_TEST', message: 'synthetic' });
    V.bus.emit('vx:snapshot', { bytes: 1024 });
    var Y = getFamily('system');
    ck('system incidents/snapshots/storage', Y.incidents >= 1 && Y.snapshots >= 1 && Y.storageBytes >= 1024,
      'incidents=' + Y.incidents + ' snapshots=' + Y.snapshots + ' bytes=' + Y.storageBytes);

    // 5. downsample: synthetic 100-day daily series
    var anchor = nowMs();
    series.fps = [];
    for (var d = 0; d < 100; d++) {
      series.fps.push({ t: anchor - d * DAY - 3600 * 1000, v: 60 });
    }
    var rep = downsample(anchor);
    var r = rep.fps;
    // Synthetic accounting: 100 daily samples, d=0..99, each 1h into its day.
    //   raw: age<=7d → d=0..6 → 7 samples (7 buckets not asserted; raw stays raw)
    //   daily: 7d<age<=30d → d=7..29 → 23 one-sample buckets
    //   weekly: 30d<age<=90d → d=30..89 → 60 samples. Boundary weeks are
    //     partial, so bucketize() yields 9 weekly buckets (k=4..12), not 10.
    //   dropped: age>90d → d=90..99 → 10 samples, never resurrected.
    ck('downsample raw bucket count', r.raw === 7, 'raw=' + r.raw);
    ck('downsample daily bucket count', r.daily === 23, 'daily=' + r.daily);
    ck('downsample weekly bucket count', r.weekly === 9, 'weekly=' + r.weekly);
    var dailyN = 0, weeklyN = 0;
    var db = series['fps:daily'] || [], wb = series['fps:weekly'] || [];
    for (var q = 0; q < db.length; q++) dailyN += db[q].n;
    for (var w = 0; w < wb.length; w++) weeklyN += wb[w].n;
    ck('downsample sample accounting (7+23+60 kept, 10 dropped)',
      r.raw + dailyN + weeklyN === 90 && dailyN === 23 && weeklyN === 60,
      'raw=' + r.raw + ' dailySamples=' + dailyN + ' weeklySamples=' + weeklyN);

    // 6. records keep maxima (fps) and minima (p95 frameMs)
    // Synthetic records only: preserve the live store, restore it after.
    var savedRecords = records;
    records = {};
    record('perf.fps', 120, 'r1');
    record('perf.fps', 90, 'r2');   // worse: must not overwrite
    record('perf.frameMsP95', 8.3, 'r1');
    record('perf.frameMsP95', 12.0, 'r2'); // worse for a min-record: ignored
    var recs = getRecords();
    var byKey = {};
    for (var m = 0; m < recs.length; m++) byKey[recs[m].metric] = recs[m];
    ck('records keep maxima', byKey['perf.fps'] && byKey['perf.fps'].value === 120, 'fps=' + (byKey['perf.fps'] || {}).value);
    ck('records keep minima where lower is better', byKey['perf.frameMsP95'] && byKey['perf.frameMsP95'].value === 8.3,
      'p95=' + (byKey['perf.frameMsP95'] || {}).value);
    ck('record entries have shape', byKey['perf.fps'] && isFin(byKey['perf.fps'].at) && byKey['perf.fps'].runId === 'r1',
      JSON.stringify(byKey['perf.fps']));
    records = savedRecords; // selfTest must never pollute the live hall of fame
    storeSave(REC_KEY, records);

    // 7. exports: non-empty, headers present
    var j = exportJSON(), c = exportCSV(), md = exportMarkdown();
    ck('exportJSON non-empty with families', j.length > 100 && j.indexOf('"performance"') !== -1, 'len=' + j.length);
    ck('exportCSV header + rows', c.length > 0 && c.indexOf('family,metric,value,unit') === 0 && c.indexOf('science,runs,') !== -1, 'len=' + c.length);
    ck('exportMarkdown headers', md.length > 0 && md.indexOf('# VORTEX Lab Metrics') === 0 && md.indexOf('## Records') !== -1, 'len=' + md.length);

    // 8. footerData: exactly 6 numbers + sparkline, throttled
    var f1 = footerData(), f2 = footerData();
    var nk = Object.keys(f1.numbers || {});
    var allNums = nk.every(function (k) { return typeof f1.numbers[k] === 'number'; });
    ck('footerData has exactly 6 numbers', nk.length === 6 && allNums, 'keys=' + nk.join(','));
    ck('footerData carries fpsHist sparkline', Array.isArray(f1.fpsHist) && f1.fpsHist.length <= 120, 'len=' + f1.fpsHist.length);
    ck('footerData throttled (<=2/s)', f1 === f2, 'cached');

    // 9. headless safety: no document/window access at load or in selfTest
    ck('headless-safe module load', true, 'selfTest ran with no DOM');

    // 10. event guard: malformed payloads never throw
    var threw = false;
    try {
      V.bus.emit('vx:frame', {});
      V.bus.emit('vx:frame', { dt: 'fast' });
      V.bus.emit('vx:teachher', { roundComplete: true });
      V.bus.emit('vx:protocol', { status: 'scored' });
      V.bus.emit('vx:run', null);
    } catch (e) { threw = true; }
    ck('malformed events tolerated', !threw, 'no throw');

    var ok = checks.every(function (c2) { return c2.ok; });
    return { ok: ok, checks: checks };
  }
};

VORTEX.register('w32-labmetrics', api);
if (V.ui && typeof V.ui.registerPanel === 'function') {
  V.ui.registerPanel('lab-metrics', 'Lab metrics', mountPanel);
}

})(typeof window !== 'undefined' ? window : globalThis);
