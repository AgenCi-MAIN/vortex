/* VORTEX determinism.js — [W25] run manifests, tiered determinism verifier,
 * hygiene kill-list guards, reseed-as-branch, and the Determinism panel.
 *
 * Plain browser script, IIFE, no modules, no build step. Runs from file://.
 * No network, no fetch/XHR/WebSocket/eval. No DOM assumptions (headless-safe);
 * the panel mountFn is DOM-guarded and only invoked by the shell in-browser.
 *
 * TIERED DETERMINISM (spec §3.3):
 *   CPU backends   -> BIT-IDENTICAL bar: two replays from (seed, params,
 *                     probe timeline) must produce identical
 *                     hash53(stableStringify(sampleMetrics())).
 *   GPU backends   -> STATISTICAL bar: N>=5 repeats, every repeat's metrics
 *                     must land inside the manifest's per-metric toleranceBands
 *                     {lo, hi} (absolute) or {rel} (relative to reference run).
 *   Cross-backend comparisons always use the statistical bar.
 *
 * Manifests are built on VORTEX.makeManifest (namespace owns the schema) and
 * extended with: live-recorded probeTimeline (vx:probe events stamped in
 * sim-time), steps (replay length), parentHash (reseed branches), note.
 * reseed() ALWAYS mints a new manifest — a branch in the evidence trail,
 * never an erasure. History is append-only.
 *
 * The hygiene checker is a CI/selfTest gate: it scans sim-step SOURCE TEXT
 * for the kill list (Math.random, Date.now, performance.now, unsorted
 * Map/Set iteration). It never runs at sim time.
 */
(function (root) {
'use strict';

var V = root.VORTEX;
if (!V || !V.utils) { throw new Error('w25-determinism: requires vx-namespace.js first'); }
var utils = V.utils;

var DT = V.SIM_DT; // 1/60 fixed sim-seconds per step
var EPS = 1e-12;

/* ---------------- module state ---------------- */
var _current = null;          // current run manifest
var _history = [];            // append-only evidence trail (capped)
var HISTORY_CAP = 64;
var _liveSteps = 0;           // live sim clock, in steps (callers note steps)
var _recording = false;
var _timeline = [];           // live-recorded probeTimeline [{t, probe, params}]
var _verifyFactory = null;    // backendFactory registered by W14/W02 for panel verify

/* ---------------- probe timeline recording ---------------- */
function liveSimTime() { return _liveSteps * DT; }

function onProbe(detail) {
  if (!_recording) return;
  var d = detail || {};
  var t = (typeof d.simTime === 'number') ? d.simTime : liveSimTime();
  _timeline.push({ t: t, probe: d.probe, params: d.params || {} });
}
if (V.bus && V.bus.on) {
  try { V.bus.on('vx:probe', onProbe); } catch (e) { /* bus not ready; recording stays manual */ }
}

/* ---------------- manifests ---------------- */
function mintManifest(opts) {
  opts = opts || {};
  var m = V.makeManifest({
    seed: opts.seed >>> 0,
    params: opts.params || {},
    configId: opts.configId || 'spiral-default',
    probeTimeline: opts.probeTimeline || _timeline.slice(),
    backend: opts.backend || 'cpu',
    tracers: opts.tracers || 0,
    toleranceBands: opts.toleranceBands || defaultBands()
  });
  m.steps = (opts.steps | 0) || 0;
  m.parentHash = opts.parentHash || null;
  m.note = opts.note || '';
  // re-hash so the hash covers the W25 extensions too
  delete m.hash;
  m.hash = utils.hash53(utils.stableStringify(m));
  return m;
}

function defaultBands() {
  // relative bands for the standard metric ids; absolute {lo,hi} bands can
  // be supplied per-run. GPU statistical bar: N>=5 repeats inside bands.
  return {
    ke: { rel: 0.05 },
    enstrophy: { rel: 0.05 },
    mixing: { rel: 0.05 }
  };
}

function pushHistory(m) {
  _history.push(m);
  while (_history.length > HISTORY_CAP) _history.shift();
}

/* ---------------- replay core ---------------- */
function sortedTimeline(manifest) {
  return (manifest.probeTimeline || []).slice().sort(function (a, b) { return a.t - b.t; });
}

// Drive one backend from (seed, params, probe timeline) for totalSteps steps.
function runOnce(manifest, backendFactory, totalSteps) {
  var b = backendFactory(manifest.seed >>> 0, manifest.params || {});
  if (!b || typeof b.step !== 'function' || typeof b.sampleMetrics !== 'function') {
    throw new Error('w25-determinism: backendFactory must return {step(), sampleMetrics(), addProbe?}');
  }
  if (typeof b.setParams === 'function') b.setParams(manifest.params || {});
  var timeline = sortedTimeline(manifest);
  var targets = timeline.map(function (e) { return Math.round(e.t / DT); });
  var ti = 0;
  for (var s = 0; s < totalSteps; s++) {
    while (ti < targets.length && targets[ti] <= s) {
      if (typeof b.addProbe === 'function') b.addProbe(timeline[ti].probe, timeline[ti].params);
      ti++;
    }
    b.step();
  }
  return b.sampleMetrics();
}

function hashMetrics(metrics) {
  return utils.hash53(utils.stableStringify(metrics));
}

function bandContains(band, ref, v) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  var lo, hi;
  if (band && typeof band.rel === 'number') {
    if (typeof ref !== 'number' || !isFinite(ref)) return false;
    var span = Math.abs(ref) * band.rel;
    if (span < EPS) span = EPS;
    lo = ref - span; hi = ref + span;
  } else if (band && typeof band.lo === 'number' && typeof band.hi === 'number') {
    lo = band.lo; hi = band.hi;
  } else {
    return false; // no usable band for this metric
  }
  return v >= lo - EPS && v <= hi + EPS;
}

/* ---------------- verifier ---------------- */
function verifyManifest(manifest, backendFactory, opts) {
  opts = opts || {};
  if (!manifest || typeof manifest.hash !== 'string') {
    throw new Error('w25-determinism: verifyManifest needs a minted manifest');
  }
  if (typeof backendFactory !== 'function') {
    throw new Error('w25-determinism: verifyManifest needs a backendFactory(seed, params)');
  }
  var totalSteps = (manifest.steps | 0) || 0;
  var result = { reproduced: false, hashA: null, hashB: null, integrity: false, bar: null, detail: '' };

  // integrity: does the stored hash match a recomputation over the manifest?
  var stored = manifest.hash;
  var copy = {};
  for (var k in manifest) if (manifest.hasOwnProperty(k) && k !== 'hash') copy[k] = manifest[k];
  result.integrity = (utils.hash53(utils.stableStringify(copy)) === stored);

  var isCpu = (manifest.backend === 'cpu');
  result.bar = isCpu ? 'bit-identical' : 'statistical';

  var ref = runOnce(manifest, backendFactory, totalSteps);
  result.hashA = hashMetrics(ref);

  if (isCpu) {
    // CPU bar: a second fresh replay must be hash-identical.
    var ref2 = runOnce(manifest, backendFactory, totalSteps);
    result.hashB = hashMetrics(ref2);
    result.reproduced = (result.hashA === result.hashB);
    result.detail = result.reproduced
      ? 'CPU bit-identical: 2 replays, same metric hash'
      : 'CPU replay diverged: hashA != hashB';
    return result;
  }

  // GPU bar: N>=5 repeats, every metric inside toleranceBands.
  var n = Math.max(opts.repeats | 0 || 5, 5);
  var bands = manifest.toleranceBands || {};
  var allIn = true, firstBad = null, lastHash = result.hashA;
  for (var i = 0; i < n; i++) {
    var m = runOnce(manifest, backendFactory, totalSteps);
    lastHash = hashMetrics(m);
    for (var key in ref) {
      if (!ref.hasOwnProperty(key)) continue;
      if (typeof ref[key] !== 'number') continue; // only numeric metrics are band-checked
      var band = bands[key] || defaultBands()[key];
      if (!band) continue; // no band defined for this metric (e.g. step counters) -> not checked
      if (!bandContains(band, ref[key], m[key])) {
        allIn = false;
        if (!firstBad) firstBad = 'repeat ' + i + ' metric "' + key + '" outside band';
        break;
      }
    }
    if (!allIn) break;
  }
  result.hashB = lastHash;
  result.repeats = n;
  result.reproduced = allIn;
  result.detail = allIn
    ? 'GPU statistical: ' + n + ' repeats inside toleranceBands'
    : 'GPU statistical FAILED: ' + firstBad;
  return result;
}

/* ---------------- deterministic replay helper (W13/W26) ---------------- */
// Replays `backend` to exactly simTime seconds, applying the manifest's
// probe timeline at sim-times. Returns {steps, probesApplied}.
function replayTo(backend, manifest, simTime) {
  if (!backend || typeof backend.step !== 'function') {
    throw new Error('w25-determinism: replayTo needs a backend with step()');
  }
  if (!manifest) throw new Error('w25-determinism: replayTo needs a manifest');
  if (typeof backend.setParams === 'function') backend.setParams(manifest.params || {});
  var targetSteps = Math.round(simTime / DT);
  var timeline = sortedTimeline(manifest);
  var targets = timeline.map(function (e) { return Math.round(e.t / DT); });
  var ti = 0, applied = 0, s = 0;
  for (s = 0; s < targetSteps; s++) {
    while (ti < targets.length && targets[ti] <= s) {
      if (typeof backend.addProbe === 'function') backend.addProbe(timeline[ti].probe, timeline[ti].params);
      ti++; applied++;
    }
    backend.step();
  }
  // probes stamped exactly at targetSteps (t == simTime) still apply
  while (ti < targets.length && targets[ti] <= targetSteps) {
    if (typeof backend.addProbe === 'function') backend.addProbe(timeline[ti].probe, timeline[ti].params);
    ti++; applied++;
  }
  return { steps: targetSteps, probesApplied: applied };
}

/* ---------------- hygiene kill-list guard (CI/selfTest, not runtime) ---------------- */
var KILL_RULES = [
  { id: 'UNSEEDED_RNG', re: /\bMath\.random\s*\(/, why: 'unseeded PRNG — use VORTEX.utils.mulberry32(seed)' },
  { id: 'WALL_CLOCK', re: /\bDate\.now\s*\(/, why: 'wall-clock time breaks replay — use sim-time' },
  { id: 'WALL_CLOCK', re: /\bperformance\.now\s*\(/, why: 'wall-clock time breaks replay — use sim-time' },
  { id: 'WALL_CLOCK', re: /\bperformance\.timeOrigin\b/, why: 'wall-clock time breaks replay — use sim-time' },
  { id: 'WALL_CLOCK', re: /\bnew\s+Date\s*\(/, why: 'wall-clock time breaks replay — use sim-time' }
];

function stripCommentsKeepLines(src) {
  var s = String(src);
  s = s.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); });
  s = s.split('\n').map(function (line) {
    var idx = -1;
    for (var i = 0; i < line.length - 1; i++) {
      if (line[i] === '/' && line[i + 1] === '/' && line[i - 1] !== ':') { idx = i; break; }
    }
    return idx >= 0 ? line.slice(0, idx) : line;
  }).join('\n');
  return s;
}

function checkDeterminismHygiene(moduleSourceString) {
  var src = stripCommentsKeepLines(moduleSourceString);
  var lines = src.split('\n');
  var flags = [];
  function flag(rule, ln, why) {
    flags.push({ rule: rule, line: ln, detail: why, snippet: lines[ln - 1].trim().slice(0, 120) });
  }
  // scalar kill-list rules
  for (var li = 0; li < lines.length; li++) {
    for (var r = 0; r < KILL_RULES.length; r++) {
      if (KILL_RULES[r].re.test(lines[li])) flag(KILL_RULES[r].id, li + 1, KILL_RULES[r].why);
    }
  }
  // unsorted Map/Set iteration: find container vars, then flag for..of / forEach
  // without a .sort( materialization on the same line. Heuristic — CI gate.
  var containers = {};
  var declRe = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(Map|Set)\s*\(/;
  for (var di = 0; di < lines.length; di++) {
    var dm = declRe.exec(lines[di]);
    if (dm) containers[dm[1]] = { kind: dm[2], line: di + 1 };
  }
  var names = Object.keys(containers);
  for (var ci = 0; ci < names.length; ci++) {
    var nm = names[ci];
    var ofRe = new RegExp('\\bfor\\s*\\([^)]*\\bof\\s+' + nm + '\\b');
    var feRe = new RegExp('\\b' + nm + '\\.forEach\\s*\\(');
    for (var ii = 0; ii < lines.length; ii++) {
      var line = lines[ii];
      if ((ofRe.test(line) || feRe.test(line)) && line.indexOf('.sort(') < 0) {
        flag('UNSORTED_CONTAINER_ITER', ii + 1,
          containers[nm].kind + ' "' + nm + '" iterated without sorted materialization (declared line ' +
          containers[nm].line + ') — iteration order must be deterministic');
      }
    }
  }
  return { ok: flags.length === 0, flags: flags };
}

/* ---------------- public API ---------------- */
var api = {
  // manifests
  makeManifest: function (opts) {
    var m = mintManifest(opts);
    _current = m;
    pushHistory(m);
    V.bus.emit('vx:manifest', { manifest: m });
    return m;
  },
  getCurrent: function () { return _current; },
  getHistory: function () { return _history.slice(); },
  defaultBands: defaultBands,

  // live clock + timeline recording
  setSimTime: function (t) { _liveSteps = Math.max(0, Math.round(t / DT)); },
  noteSteps: function (n) { _liveSteps += (n | 0) || 1; },
  getSimTime: function () { return liveSimTime(); },
  startRecording: function () { _recording = true; },
  stopRecording: function () { _recording = false; return _timeline.slice(); },
  clearTimeline: function () { _timeline = []; },
  getTimeline: function () { return _timeline.slice(); },
  recordProbe: function (probe, params, simTime) {
    _timeline.push({ t: (typeof simTime === 'number') ? simTime : liveSimTime(), probe: probe, params: params || {} });
  },

  // reseed-as-branch: never erases, always a new manifest with parentHash
  reseed: function (newSeed) {
    if (!_current) throw new Error('w25-determinism: reseed needs a current manifest (makeManifest first)');
    var m = mintManifest({
      seed: newSeed >>> 0,
      params: _current.params,
      configId: _current.configId,
      probeTimeline: [], // fresh branch starts a fresh timeline
      backend: _current.backend,
      tracers: _current.tracers,
      toleranceBands: _current.toleranceBands,
      steps: 0,
      parentHash: _current.hash,
      note: 'branch of ' + _current.hash.slice(0, 10)
    });
    _current = m;
    pushHistory(m);
    V.bus.emit('vx:manifest', { manifest: m, branch: true });
    V.ui.announce('Determinism: branched to seed ' + (newSeed >>> 0) + ' (parent ' + m.parentHash.slice(0, 10) + ')');
    return m;
  },
  branchManifest: function (newSeed) { return this.reseed(newSeed); },

  // verifier + replay
  verifyManifest: verifyManifest,
  replayTo: replayTo,
  setVerifyFactory: function (fn) { _verifyFactory = (typeof fn === 'function') ? fn : null; },
  getVerifyFactory: function () { return _verifyFactory; },

  // hygiene kill-list
  checkDeterminismHygiene: checkDeterminismHygiene,
  scanSimPath: checkDeterminismHygiene,

  selfTest: selfTest
};

VORTEX.register('w25-determinism', api);

/* ---------------- Determinism panel ---------------- */
V.ui.registerPanel('determinism', 'Determinism', function (el) {
  if (!utils.isBrowser() || !el) return;
  var doc = root.document;

  function row(label, value) {
    var d = doc.createElement('div'); d.className = 'vx-det-row';
    var b = doc.createElement('b'); b.textContent = label + ': ';
    var s = doc.createElement('span'); s.textContent = value;
    d.appendChild(b); d.appendChild(s); el.appendChild(d);
    return s;
  }
  function btn(label, fn) {
    var b = doc.createElement('button'); b.textContent = label;
    b.className = 'vx-det-btn';
    b.addEventListener('click', fn);
    el.appendChild(b);
    return b;
  }

  var hashSpan = row('Manifest hash', '(none yet)');
  var barSpan = row('Determinism bar', '—');
  var parentSpan = row('Parent hash', '—');
  var out = doc.createElement('div'); out.className = 'vx-det-out'; el.appendChild(out);

  function refresh() {
    var m = api.getCurrent();
    if (!m) { hashSpan.textContent = '(none yet)'; barSpan.textContent = '—'; parentSpan.textContent = '—'; return; }
    hashSpan.textContent = m.hash.slice(0, 16) + '…  (seed ' + m.seed + ', ' + m.steps + ' steps, ' +
      m.probeTimeline.length + ' probes, ' + m.backend + ')';
    barSpan.textContent = m.backend === 'cpu' ? 'bit-identical (CPU)' : 'statistical N≥5 (GPU)';
    parentSpan.textContent = m.parentHash ? m.parentHash.slice(0, 16) + '…' : '(root manifest)';
  }

  btn('Verify current manifest', function () {
    out.textContent = '';
    var m = api.getCurrent();
    if (!m) { out.textContent = 'No manifest yet — mint one via makeManifest first.'; return; }
    var factory = api.getVerifyFactory();
    if (!factory) {
      out.textContent = 'No deterministic backend factory registered (W14/W02 wire one via setVerifyFactory). Nothing verified.';
      return;
    }
    try {
      var r = api.verifyManifest(m, factory);
      out.textContent = (r.reproduced ? 'REPRODUCED ✓' : 'NOT REPRODUCED ✗') +
        '  bar=' + r.bar + '  integrity=' + r.integrity +
        '  hashA=' + String(r.hashA).slice(0, 12) + ' hashB=' + String(r.hashB).slice(0, 12) +
        (r.repeats ? ' repeats=' + r.repeats : '') + '  — ' + r.detail;
    } catch (e) {
      out.textContent = 'Verify failed: ' + e.message;
    }
  });

  btn('Hygiene check (paste sim-step code)', function () {
    out.textContent = '';
    var ta = doc.createElement('textarea');
    ta.className = 'vx-det-ta';
    ta.placeholder = 'Paste sim-step module source here…';
    ta.rows = 4;
    el.appendChild(ta);
    var go = doc.createElement('button');
    go.textContent = 'Run hygiene check';
    go.className = 'vx-det-btn';
    go.addEventListener('click', function () {
      var r = api.checkDeterminismHygiene(ta.value || '');
      out.textContent = r.ok
        ? 'Hygiene PASS — no kill-list violations.'
        : 'Hygiene FAIL — ' + r.flags.length + ' violation(s):\n' +
          r.flags.map(function (f) { return '  [' + f.rule + '] line ' + f.line + ': ' + f.detail; }).join('\n');
    });
    el.appendChild(go);
  });

  btn('Branch (reseed)', function () {
    out.textContent = '';
    var m = api.getCurrent();
    var nextSeed = m ? ((m.seed + 1) >>> 0) : 1;
    var input = doc.createElement('input');
    input.className = 'vx-det-input';
    input.value = String(nextSeed);
    el.appendChild(input);
    var go = doc.createElement('button');
    go.textContent = 'Mint branch manifest';
    go.className = 'vx-det-btn';
    go.addEventListener('click', function () {
      try {
        var b = api.branchManifest(parseInt(input.value, 10) >>> 0);
        refresh();
        out.textContent = 'Branched: new hash ' + b.hash.slice(0, 16) + '… parent ' +
          b.parentHash.slice(0, 16) + '… — history is append-only, nothing erased.';
      } catch (e) {
        out.textContent = 'Branch failed: ' + e.message;
      }
    });
    el.appendChild(go);
  });

  refresh();
});

/* ---------------- selfTest (headless-safe) ---------------- */
function selfTest() {
  var checks = [];
  function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: String(detail || '') }); }

  // --- mock deterministic backend (tiny fake stepper) ---
  function mockBackend(seed, params) {
    var rnd = utils.mulberry32(seed >>> 0);
    var ph = utils.hash53(utils.stableStringify(params || {}));
    var bias = parseInt(ph.slice(0, 8), 16) / 4294967295;
    var st = { ke: bias, enstrophy: 0, mixing: 0, steps: 0, probes: 0 };
    return {
      setParams: function () {},
      addProbe: function () { st.probes++; st.ke += 0.25 * st.probes * (0.5 + bias); },
      step: function () {
        st.steps++;
        st.ke += rnd() * 0.01 + bias * 0.001;
        st.enstrophy += rnd() * 0.02;
        st.mixing += (rnd() - 0.5) * 0.005;
      },
      sampleMetrics: function () {
        return { ke: st.ke, enstrophy: st.enstrophy, mixing: st.mixing, steps: st.steps, probes: st.probes };
      }
    };
  }
  var mockFactory = function (seed, params) { return mockBackend(seed, params); };

  // 1. manifest mint: stable hash, key-order independent, schema fields present
  var m1 = api.makeManifest({ seed: 42, params: { circulation: 1.0, turbulence: 0.3 }, steps: 120,
    backend: 'cpu', tracers: 4000, configId: 'spiral-default' });
  var m2 = api.makeManifest({ seed: 42, params: { turbulence: 0.3, circulation: 1.0 }, steps: 120,
    backend: 'cpu', tracers: 4000, configId: 'spiral-default' });
  check('manifest hash stable across stableStringify', m1.hash === m2.hash, 'hash=' + m1.hash.slice(0, 12));
  check('manifest carries codeVersion + bands', m1.codeVersion === V.codeVersion && !!m1.toleranceBands.ke,
    'codeVersion=' + m1.codeVersion);

  // 2. verifier reproduces on the deterministic mock (CPU bit-identical bar)
  var v1 = api.verifyManifest(m1, mockFactory);
  check('verifier reproduces on deterministic backend', v1.reproduced === true && v1.hashA === v1.hashB,
    'bar=' + v1.bar + ' hashA=' + String(v1.hashA).slice(0, 12));

  // 3. tampered manifest (param changed, hash recomputed) replays to a
  //    DIFFERENT evidence hash than the original run -> caught against it
  var tampered = JSON.parse(JSON.stringify(m1));
  delete tampered.hash;
  tampered.params.turbulence = 0.9;
  tampered.hash = utils.hash53(utils.stableStringify(tampered));
  var tamperedHash = hashMetrics(runOnce(tampered, mockFactory, tampered.steps));
  check('tampered manifest (param change) fails reproduce', tamperedHash !== v1.hashA,
    'original=' + String(v1.hashA).slice(0, 12) + ' tampered=' + String(tamperedHash).slice(0, 12));

  // 4. integrity flag: param changed WITHOUT hash update -> integrity:false
  var sneaky = JSON.parse(JSON.stringify(m1));
  sneaky.params.circulation = 9.99;
  var v3 = api.verifyManifest(sneaky, mockFactory);
  check('stale-hash manifest flagged', v3.integrity === false, 'integrity=' + v3.integrity);

  // 5. probe timeline applies at sim-times and affects the replay
  var mp = api.makeManifest({ seed: 7, params: {}, steps: 60, backend: 'cpu',
    probeTimeline: [{ t: 0.25, probe: 'stir', params: {} }, { t: 0.75, probe: 'pulse', params: {} }] });
  var v4 = api.verifyManifest(mp, mockFactory);
  check('probe timeline replay reproduces', v4.reproduced === true, '2 probes, ' + mp.steps + ' steps');
  var mp2 = api.makeManifest({ seed: 7, params: {}, steps: 60, backend: 'cpu', probeTimeline: [] });
  var hP = hashMetrics(runOnce(mp, mockFactory, mp.steps));
  var hN = hashMetrics(runOnce(mp2, mockFactory, mp2.steps));
  check('probes actually perturb the run', hP !== hN, 'probe run != no-probe run');

  // 6. GPU statistical bar: N>=5 repeats inside bands -> true; absurdly tight band -> false
  var mg = api.makeManifest({ seed: 11, params: { circulation: 1 }, steps: 60, backend: 'webgl2',
    toleranceBands: { ke: { rel: 0.05 }, enstrophy: { rel: 0.05 }, mixing: { rel: 0.05 } } });
  var v5 = api.verifyManifest(mg, mockFactory, { repeats: 5 });
  check('GPU statistical bar passes on deterministic backend', v5.reproduced === true && v5.bar === 'statistical' && v5.repeats >= 5,
    'repeats=' + v5.repeats);
  var mgTight = api.makeManifest({ seed: 11, params: { circulation: 1 }, steps: 60, backend: 'webgl2',
    toleranceBands: { ke: { lo: 0, hi: 1e-15 }, enstrophy: { rel: 0.05 }, mixing: { rel: 0.05 } } });
  var v6 = api.verifyManifest(mgTight, mockFactory);
  check('GPU statistical bar fails on impossible band', v6.reproduced === false, v6.detail.slice(0, 60));

  // 7. hygiene checker: flags violations, passes clean code
  var dirty = [
    'function step(s) {',
    '  var r = Math.random();            // unseeded',
    '  var t0 = Date.now();              // wall clock',
    '  var t1 = performance.now();       // wall clock',
    '  const seen = new Map();',
    '  seen.set("a", 1);',
    '  for (const k of seen.keys()) { s.ke += seen.get(k); }  // unsorted iteration',
    '}'
  ].join('\n');
  var hd = api.checkDeterminismHygiene(dirty);
  var rules = hd.flags.map(function (f) { return f.rule; });
  check('hygiene flags kill-list violations',
    hd.ok === false && rules.indexOf('UNSEEDED_RNG') >= 0 && rules.indexOf('WALL_CLOCK') >= 0 &&
    rules.indexOf('UNSORTED_CONTAINER_ITER') >= 0 && hd.flags.length >= 4,
    hd.flags.length + ' flags: ' + rules.join(','));
  var clean = [
    'function step(s, rnd) {',
    '  var t = s.steps * (1/60);',
    '  var r = rnd();',
    '  const keys = Array.from(s.map.keys()).sort();',
    '  for (var i = 0; i < keys.length; i++) { s.ke += s.map.get(keys[i]); }',
    '}'
  ].join('\n');
  var hc = api.checkDeterminismHygiene(clean);
  check('hygiene passes clean deterministic code', hc.ok === true && hc.flags.length === 0,
    hc.flags.length + ' flags');
  check('scanSimPath alias works', api.scanSimPath(clean).ok === true, 'alias === same function');

  // 8. reseed-as-branch: new manifest, parentHash link, history append-only
  var before = api.getHistory().length;
  var prevCurrent = api.getCurrent();
  var branch = api.reseed(43);
  var after = api.getHistory().length;
  check('branch links parentHash', prevCurrent !== null && branch.parentHash === prevCurrent.hash,
    'parent=' + String(branch.parentHash).slice(0, 12) + ' prev=' + String(prevCurrent && prevCurrent.hash).slice(0, 12));
  check('branch is a NEW manifest (not erasure)', branch.hash !== branch.parentHash && branch.seed === 43,
    'seed=' + branch.seed);
  check('history append-only', after === before + 1, before + ' -> ' + after);

  // 9. replayTo helper (W13/W26): exact step count, probes applied at sim-times
  var appliedAt = [];
  var rb = mockBackend(99, {});
  var origAdd = rb.addProbe;
  rb.addProbe = function (p) { appliedAt.push(rb.sampleMetrics().steps); return origAdd(p); };
  var mr = api.makeManifest({ seed: 99, params: {}, steps: 0, backend: 'cpu',
    probeTimeline: [{ t: 0.5, probe: 'a', params: {} }, { t: 1.0, probe: 'b', params: {} }] });
  var rr = api.replayTo(rb, mr, 1.0);
  check('replayTo hits exact sim time', rr.steps === 60 && rb.sampleMetrics().steps === 60, 'steps=60');
  check('replayTo applies probes at sim-times', rr.probesApplied === 2 && appliedAt.join(',') === '30,60',
    'applied at steps ' + appliedAt.join(','));

  // 10. live timeline recording hooks vx:probe with sim-time
  api.clearTimeline();
  api.setSimTime(0);
  api.startRecording();
  V.bus.emit('vx:probe', { probe: 'stir', params: { strength: 2 }, simTime: 0.25 });
  api.noteSteps(30);
  V.bus.emit('vx:probe', { probe: 'pulse', params: {} }); // no simTime -> falls back to live clock
  api.stopRecording();
  var tl = api.getTimeline();
  check('probe timeline records with sim-time', tl.length === 2 && tl[0].t === 0.25 && tl[1].t === 0.5,
    't=' + tl.map(function (e) { return e.t; }).join(','));
  api.clearTimeline();

  // 11. panel registered (mountFn DOM-guarded; registry check is headless-safe)
  var panels = V.ui.panels(), hasPanel = false;
  for (var i = 0; i < panels.length; i++) if (panels[i].id === 'determinism') hasPanel = true;
  check('determinism panel registered', hasPanel, 'w25 panel in ui registry');

  var ok = true;
  for (var c = 0; c < checks.length; c++) if (!checks[c].ok) ok = false;
  return { ok: ok, checks: checks };
}

})(typeof window !== 'undefined' ? window : globalThis);
