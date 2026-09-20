/* VORTEX js/ab-fields.js — W26: A/B split-lab.
 *
 * Design source: lane-14-vortex.md §6 "A/B fields" (W26).
 * Plain IIFE script, no modules, no network, no build step.
 * Works in browser and node (headless selfTest).
 *
 * What this module is:
 *   A split-lab harness for A/B (and A/B/C/D) field experiments. 2×1 or 2×2
 *   layouts, each cell holding a backend instance (or a replay) behind the
 *   W02 VortexField contract shape {step, sampleMetrics, snapshotState,
 *   restoreState, dispose}. One driver loop steps every cell's backend once
 *   per tick, so all cells share hard-synced sim timelines. It records
 *   per-metric delta series with replicate-variance bands, declares
 *   per-metric winners with effect size + 95% CI, and falls back to cached
 *   sequential runs when parallel stepping fails or is too slow.
 *
 * What this module is NOT:
 *   - Not a fluid solver. Cells normally get REAL backends (W02/W14/W15)
 *     through a backend factory. When none is registered yet, cells run on
 *     a deterministic SYNTHETIC reference stepper (clearly labeled
 *     `synthetic` on every arm, in the panel, and in series metadata).
 *     The synthetic stepper exists for wiring, tests, and headless CI —
 *     its "metrics" are oscillator toys, not physics.
 *   - Not a stats replacement for W06. winnerOf() prefers W06's
 *     `compareAB(aVals, bVals, metric)` when 'w06-protocols' is registered
 *     (guarded; unexpected shapes fall back). Otherwise it uses a small
 *     built-in Welch t-interval + Cohen's d — same verdict semantics
 *     (CONFIRMED-style: CI excludes 0 → winner).
 *
 * Backend factory contract (what createLab expects):
 *   makeBackend(cellSpec, repIndex) -> steppable (synchronous object with
 *   step(), sampleMetrics(), snapshotState(), restoreState(), dispose()).
 *   Replicate r of a cell uses seed = (cellSpec.seed + r*2654435761) >>> 0.
 *   A factory may expose `.kind` for honest labeling.
 *
 * Events emitted (W13/W08 hook in by listening; nothing is called directly):
 *   vx:ab-start {labId, layout, cells}
 *   vx:ab-done  {labId, mode, simTime}
 *   vx:ab-winner {labId, metric, pair, winner, effectSize, ci, basis, mode}
 *   vx:ab-fallback-complete {labId, mode, reason}
 *   vx:degraded {from:'parallel', to:'sequential-fallback', reason} (standard)
 *   vx:error on unrecoverable failure (standard shape)
 *
 * Module id: 'w26-ab'. Headless-safe. No fetch/XHR/WebSocket/eval.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w26-ab-fields: VORTEX namespace missing — load vx-namespace.js first');

  var DT = V.SIM_DT || 1 / 60;
  var MODULE_ID = 'w26-ab';
  var LAYOUTS = ['2x1', '2x2'];
  var DEFAULT_METRICS = ['ke', 'enstrophy', 'mixing'];
  var CORE_PROBES = ['oppose-winding', 'test-the-wake', 'perturb-field'];
  var REP_SEED_STRIDE = 2654435761;
  var Z95 = 1.96;

  // ------------------------------------------------------------ utilities
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function numOr(x, d) { return isNum(x) ? x : d; }
  function mean(a) {
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : NaN;
  }
  // sample variance (n-1); 0 when n < 2 (degenerate, flagged by callers)
  function svar(a) {
    var n = a.length;
    if (n < 2) return 0;
    var m = mean(a), s = 0, i, d;
    for (i = 0; i < n; i++) { d = a[i] - m; s += d * d; }
    return s / (n - 1);
  }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // two-sided 95% t critical value, df>=1 (table to 30, else normal approx)
  var T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  function tCrit95(df) {
    if (!isNum(df) || df < 1) return T95[0];
    if (df >= 30) return Z95;
    return T95[Math.max(1, Math.round(df)) - 1];
  }
  function repSeed(seed, r) { return (((seed >>> 0) + r * REP_SEED_STRIDE) >>> 0) || 1; }

  // ------------------------------------------- metrics / configs / camera
  // W07 hook (guarded): use its metric ids when present, else the contract's
  // sampleMetrics() example keys.
  function defaultMetrics() {
    try {
      if (V.has('w07-metrics')) {
        var m = V.get('w07-metrics');
        if (m && typeof m.list === 'function') {
          var l = m.list();
          if (Array.isArray(l) && l.length) {
            var ids = l.map(function (x) { return (x && x.id) || x; })
              .filter(function (x) { return typeof x === 'string' && x; });
            if (ids.length) return ids;
          }
        }
      }
    } catch (e) { /* fall through */ }
    return DEFAULT_METRICS.slice();
  }

  function availableConfigs() {
    try {
      if (V.has('w04-configs')) {
        var c = V.get('w04-configs');
        if (c && typeof c.list === 'function') {
          var l = c.list();
          if (Array.isArray(l) && l.length) {
            return l.map(function (x) {
              return { id: (x && x.id) || String(x), title: (x && x.title) || (x && x.id) || String(x) };
            });
          }
        }
      }
    } catch (e) { /* fall through */ }
    return [{ id: 'spiral-default', title: 'Spiral (default)' }];
  }

  var _sharedViewport = null;
  // Shared camera descriptor: W20's rig when present, else one shared
  // fallback viewport object (same reference handed to every cell).
  function resolveCamera() {
    try {
      if (V.has('w20-director')) {
        var d = V.get('w20-director');
        if (d) {
          if (d.camera) return d.camera;
          if (typeof d.getCamera === 'function') {
            var cam = d.getCamera();
            if (cam) return cam;
          }
        }
      }
    } catch (e) { /* fall through to fallback viewport */ }
    if (!_sharedViewport) {
      _sharedViewport = {
        x: 0, y: 0, zoom: 1, rotation: 0, framing: 'top-down',
        source: 'w26-fallback-viewport'
      };
    }
    return _sharedViewport;
  }

  // --------------------------------------------- stats (W06-style, small)
  // Welch's t-interval for (meanB - meanA).
  function diffCI(aVals, bVals) {
    var nA = aVals.length, nB = bVals.length;
    var mA = mean(aVals), mB = mean(bVals);
    var vA = svar(aVals), vB = svar(bVals);
    var delta = mB - mA;
    var se = Math.sqrt(vA / nA + vB / nB);
    var df = 1;
    if (nA > 1 && nB > 1 && (vA > 0 || vB > 0)) {
      var num = Math.pow(vA / nA + vB / nB, 2);
      var den = (Math.pow(vA / nA, 2) / (nA - 1)) + (Math.pow(vB / nB, 2) / (nB - 1));
      if (den > 0) df = num / den;
    }
    var t = tCrit95(df);
    return { delta: delta, se: se, df: df, lo: delta - t * se, hi: delta + t * se };
  }

  function cohensD(aVals, bVals, delta) {
    var nA = aVals.length, nB = bVals.length;
    var pooled = ((nA - 1) * svar(aVals) + (nB - 1) * svar(bVals)) / (nA + nB - 2);
    if (!(pooled > 0)) return null; // undefined; JSON-safe null, not Infinity
    return delta / Math.sqrt(pooled);
  }

  // Built-in winner math. Convention: delta = meanB - meanA; CI excludes 0
  // on the positive side → 'B' wins (higher metric value).
  function builtinWinner(metric, aVals, bVals) {
    var nA = aVals.length, nB = bVals.length;
    var out = {
      metric: String(metric), winner: 'undecided', effectSize: null,
      ci: { lo: NaN, hi: NaN }, nA: nA, nB: nB,
      basis: 'builtin-welch', note: ''
    };
    if (nA < 2 || nB < 2) {
      out.note = 'needs >=2 replicates per cell for a verdict (got ' + nA + ' vs ' + nB + ')';
      return out;
    }
    var c = diffCI(aVals, bVals);
    out.ci = { lo: c.lo, hi: c.hi };
    out.effectSize = cohensD(aVals, bVals, c.delta);
    if (c.lo > 0) out.winner = 'B';
    else if (c.hi < 0) out.winner = 'A';
    else out.winner = 'tie';
    if (!(svar(aVals) > 0) && !(svar(bVals) > 0)) {
      out.note = 'zero within-cell variance — verdict is arithmetic, not statistical';
    }
    return out;
  }

  // winnerOf(metric, aVals, bVals): prefers W06 when present (guarded),
  // else the built-in Welch math above. Returns
  // {metric, winner:'A'|'B'|'tie'|'undecided', effectSize, ci:{lo,hi},
  //  nA, nB, basis, note}. 'winner' is relative to argument order
  // (aVals = first of the pair, bVals = second).
  function winnerOf(metric, aVals, bVals) {
    aVals = Array.isArray(aVals) ? aVals.filter(isNum) : [];
    bVals = Array.isArray(bVals) ? bVals.filter(isNum) : [];
    try {
      if (V.has('w06-protocols')) {
        var p = V.get('w06-protocols');
        if (p && typeof p.compareAB === 'function') {
          var r = p.compareAB(aVals.slice(), bVals.slice(), String(metric));
          if (r && (r.winner === 'A' || r.winner === 'B' ||
                    r.winner === 'tie' || r.winner === 'undecided') &&
              isNum(r.effectSize) && r.ci && isNum(r.ci.lo) && isNum(r.ci.hi)) {
            return {
              metric: String(metric), winner: r.winner, effectSize: r.effectSize,
              ci: { lo: r.ci.lo, hi: r.ci.hi },
              nA: aVals.length, nB: bVals.length,
              basis: 'w06-protocols', note: r.note || ''
            };
          }
        }
      }
    } catch (e) { /* fall through to built-in */ }
    return builtinWinner(metric, aVals, bVals);
  }

  // --------------------------------- synthetic reference backend (labeled)
  // Deterministic oscillator toy behind the W02 VortexField contract shape.
  // SYNTHETIC — for wiring, tests, and headless CI only. Never a fluid
  // solver; never presented as one. Every arm records backendKind so the
  // panel, series metadata, and winners all say which backend actually ran.
  function makeSyntheticBackend(opts) {
    opts = opts || {};
    var seed = (opts.seed >>> 0) || 1;
    var params = opts.params || {};
    var circ = numOr(params.circulation, 1.0);
    var turb = numOr(params.turbulence, 0.5);
    var pers = numOr(params.persistence, 0.5);
    var rng = V.utils.mulberry32(seed);
    var MODES = 6, i, j;
    var amp = [], freq = [], phase = [], damp = [];
    for (i = 0; i < MODES; i++) {
      amp.push(0.4 + 0.6 * rng());
      freq.push((i + 1) * (0.6 + 0.9 * circ));
      phase.push(rng() * Math.PI * 2);
      damp.push((0.01 + 0.06 * turb) * (1 - 0.7 * pers) * (1 + 0.3 * rng()));
    }
    var t = 0;
    var probe = opts.probe || null;
    var probeDone = false;

    function applyProbe() {
      if (probe && !probeDone && t >= numOr(probe.at, Infinity)) {
        var k = 1 + numOr(probe.strength, 0.25);
        for (j = 0; j < MODES; j++) amp[j] *= k;
        probeDone = true;
      }
    }

    var backend = {
      kind: 'synthetic',
      synthetic: true, // honest flag: not a fluid solver
      init: function () { return Promise.resolve(backend); },
      setParams: function (p) {
        if (!p) return;
        circ = numOr(p.circulation, circ);
        turb = numOr(p.turbulence, turb);
        pers = numOr(p.persistence, pers);
      },
      addProbe: function () { return false; }, // synthetic probes arrive via opts
      clearProbes: function () { probeDone = true; },
      step: function () {
        t += DT;
        applyProbe();
        for (j = 0; j < MODES; j++) {
          phase[j] += freq[j] * DT;
          amp[j] *= (1 - damp[j] * DT);
        }
      },
      render: function () { /* headless-safe no-op */ },
      snapshotState: function () {
        return {
          kind: 'synthetic', seed: seed, t: t,
          amp: amp.slice(), phase: phase.slice(), probeDone: probeDone,
          params: { circulation: circ, turbulence: turb, persistence: pers }
        };
      },
      restoreState: function (s) {
        if (!s || s.kind !== 'synthetic') throw new Error('w26-ab: bad synthetic snapshot');
        t = s.t; amp = s.amp.slice(); phase = s.phase.slice();
        probeDone = !!s.probeDone;
      },
      sampleMetrics: function () {
        var ke = 0, en = 0;
        for (j = 0; j < MODES; j++) {
          ke += amp[j] * amp[j];
          en += amp[j] * amp[j] * freq[j] * freq[j] * 0.05;
        }
        var mixRate = 0.04 + 0.25 * turb + 0.08 * circ;
        return { ke: ke, enstrophy: en, mixing: 1 - Math.exp(-t * mixRate) };
      },
      getTracers: function () { return { count: 0, simulated: 0 }; },
      dispose: function () { /* nothing held */ }
    };
    return backend;
  }

  // -------------------------------------------------- backend factories
  function syntheticFactory() {
    var fac = function (cellSpec, repIndex) {
      return makeSyntheticBackend({
        seed: repSeed(cellSpec.seed, repIndex),
        params: cellSpec.params,
        probe: cellSpec.probe || null
      });
    };
    fac.kind = 'synthetic';
    return fac;
  }

  function wrapDiscovered(kind, make) {
    var fac = function (cellSpec, repIndex) {
      var b = make({
        seed: repSeed(cellSpec.seed, repIndex),
        params: cellSpec.params,
        probe: cellSpec.probe || null,
        headless: true
      });
      if (!b || typeof b.step !== 'function' || typeof b.sampleMetrics !== 'function') {
        throw new Error('w26-ab: discovered backend from ' + kind +
          ' does not expose step()/sampleMetrics()');
      }
      if (!b.kind) b.kind = kind;
      return b;
    };
    fac.kind = kind;
    return fac;
  }

  // Prefer a real backend factory when one is registered (W14/W02/W15 may
  // expose abBackendFactory() returning {make}). Otherwise the labeled
  // synthetic factory. Never throws: worst case is synthetic.
  function defaultBackendFactory() {
    var ids = ['w14-cpu', 'w02-webgl2', 'w15-webgpu'];
    for (var k = 0; k < ids.length; k++) {
      try {
        if (!V.has(ids[k])) continue;
        var m = V.get(ids[k]);
        if (m && typeof m.abBackendFactory === 'function') {
          var f = m.abBackendFactory();
          if (f && typeof f.make === 'function') return wrapDiscovered(ids[k], f.make);
        }
      } catch (e) { /* keep looking */ }
    }
    return syntheticFactory();
  }

  // ------------------------------------------------------------- the lab
  function cacheKey(cellSpec, repIndex, totalSteps, factoryKind) {
    return V.utils.hash53(V.utils.stableStringify({
      codeVersion: V.codeVersion,
      factoryKind: factoryKind || 'unknown',
      configId: cellSpec.configId,
      params: cellSpec.params,
      seed: repSeed(cellSpec.seed, repIndex),
      probe: cellSpec.probe || null,
      steps: totalSteps
    }));
  }

  function defaultCellSpec(label, i, raw) {
    raw = raw || {};
    return {
      label: raw.label || label,
      configId: raw.configId || 'spiral-default',
      params: {
        circulation: numOr(raw.params && raw.params.circulation, 1.0),
        turbulence: numOr(raw.params && raw.params.turbulence, 0.5),
        persistence: numOr(raw.params && raw.params.persistence, 0.5)
      },
      seed: (raw.seed >>> 0) || (1000 + i * 7919),
      probe: raw.probe || null, // {id, at (sim-sec), strength} or null
      replicates: Math.max(1, Math.min(16, raw.replicates | 0 || 3))
    };
  }

  function createLab(spec) {
    spec = spec || {};
    var layout = LAYOUTS.indexOf(spec.layout) >= 0 ? spec.layout : '2x1';
    var nCells = layout === '2x2' ? 4 : 2;
    var labels = nCells === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
    var metrics = (Array.isArray(spec.metrics) && spec.metrics.length)
      ? spec.metrics.filter(function (x) { return typeof x === 'string' && x; })
      : defaultMetrics();
    if (!metrics.length) metrics = DEFAULT_METRICS.slice();
    var durationSec = Math.max(DT, numOr(spec.durationSec, 10));
    var totalSteps = Math.max(1, Math.round(durationSec / DT));
    var sampleEvery = Math.max(1, spec.sampleEvery | 0 || 6);
    var stepsPerTick = Math.max(1, spec.stepsPerTick | 0 || 2);
    var factory = spec.backendFactory || defaultBackendFactory();
    var camera = resolveCamera();
    var rawCells = Array.isArray(spec.cells) ? spec.cells : [];

    var lab = {
      id: V.utils.uid('ab'),
      layout: layout,
      mode: 'parallel',          // 'parallel' | 'sequential-fallback'
      status: 'idle',            // idle|running|done|stopped|error
      simTime: 0,
      stepCount: 0,
      totalSteps: totalSteps,
      durationSec: durationSec,
      sampleEvery: sampleEvery,
      stepsPerTick: stepsPerTick,
      slowTickMs: numOr(spec.slowTickMs, 250),
      metrics: metrics,
      fallbackReason: null,
      winners: [],
      cache: {},                 // cacheKey -> {series, snapshot, backendKind}
      tickTimes: [],
      cells: [],
      _factory: factory,
      _timer: null,
      _driveMs: Math.max(16, numOr(spec.driveMs, 120)),
      _autoDrive: !!spec.autoDrive
    };

    for (var i = 0; i < nCells; i++) {
      var cs = defaultCellSpec(labels[i], i, rawCells[i]);
      lab.cells.push({
        label: cs.label,
        configId: cs.configId,
        params: cs.params,
        seed: cs.seed,
        probe: cs.probe,
        replicates: cs.replicates,
        spec: cs,                // normalized cell spec (for factory + cache)
        arms: [],                // [{backend, simTime, series, snapshot, backendKind, fromCache, repIndex}]
        status: 'idle',
        failReason: null,
        camera: camera           // shared descriptor: same reference, all cells
      });
    }

    // ---- internal: build parallel arms (throws -> caller triggers fallback)
    function buildArms() {
      lab.cells.forEach(function (cell) {
        cell.arms = [];
        cell.failReason = null;
        for (var r = 0; r < cell.replicates; r++) {
          var backend = lab._factory(cell.spec, r);
          if (!backend || typeof backend.step !== 'function' ||
              typeof backend.sampleMetrics !== 'function') {
            throw new Error('w26-ab: factory for cell ' + cell.label +
              ' did not return a steppable backend');
          }
          var series = {};
          lab.metrics.forEach(function (m) { series[m] = []; });
          cell.arms.push({
            backend: backend, simTime: 0, series: series, snapshot: null,
            backendKind: backend.kind || lab._factory.kind || 'unknown',
            fromCache: false, repIndex: r
          });
        }
        cell.status = 'running';
      });
    }

    function sampleAll() {
      lab.cells.forEach(function (cell) {
        cell.arms.forEach(function (arm) {
          if (!arm.backend) return;
          var mm = null;
          try { mm = arm.backend.sampleMetrics(); } catch (e) { mm = null; }
          lab.metrics.forEach(function (m) {
            var v = (mm && isNum(mm[m])) ? mm[m] : NaN;
            arm.series[m].push({ t: arm.simTime, v: v });
          });
        });
      });
    }

    // Real backends: attempt timed probe injection (guarded; synthetic
    // backends apply probes internally from factory opts).
    function applyProbes() {
      lab.cells.forEach(function (cell) {
        if (!cell.probe || cell.probeApplied || cell.probeSkipped) return;
        if (lab.simTime < numOr(cell.probe.at, Infinity)) return;
        var applied = false, supported = false;
        cell.arms.forEach(function (arm) {
          if (!arm.backend || arm.backend.synthetic) return;
          if (typeof arm.backend.addProbe === 'function') {
            supported = true;
            try {
              if (arm.backend.addProbe({ id: cell.probe.id, strength: numOr(cell.probe.strength, 0.25) })) applied = true;
            } catch (e) { /* one arm failing must not kill the lab */ }
          }
        });
        if (applied) cell.probeApplied = true;
        else if (!supported) { cell.probeSkipped = true; cell.probeNote = 'probe not applied: backend has no addProbe'; }
        else cell.probeApplied = true; // supported but declined; don't retry forever
      });
    }

    function stopTimer() {
      if (lab._timer) { clearInterval(lab._timer); lab._timer = null; }
    }

    function finish(reason) {
      stopTimer();
      lab.status = reason === 'stopped' ? 'stopped' : 'done';
      sampleAll();
      lab.winners = declareWinners();
      emitWinners();
      try {
        V.bus.emit(reason === 'stopped' ? 'vx:ab-stop' : 'vx:ab-done',
          { labId: lab.id, mode: lab.mode, simTime: lab.simTime });
      } catch (e) { /* bus must never break the lab */ }
      V.ui.announce('A/B lab ' + (reason === 'stopped' ? 'stopped' : 'finished') +
        ' — ' + lab.modeLabel() + '.');
    }

    // ---- sequential fallback: run each cell's arms one at a time on fresh
    // backends, cache by spec hash ("run A, snapshot; run B, snapshot"),
    // then present the recorded series as the lab result.
    function enterSequentialFallback(err) {
      stopTimer();
      var reason = (err && err.message) || String(err);
      lab.mode = 'sequential-fallback';
      lab.fallbackReason = reason;
      try {
        V.bus.emit('vx:degraded', {
          from: 'parallel', to: 'sequential-fallback', reason: reason, labId: lab.id
        });
      } catch (e) { /* bus must never break the lab */ }
      V.ui.announce('A/B lab: parallel stepping failed (' + reason +
        ') — running sequential fallback.');
      try {
        runSequential();
      } catch (e2) {
        lab.status = 'error';
        try {
          V.bus.emit('vx:error', {
            code: 'VX_E_FIELD_INIT',
            message: 'A/B sequential fallback also failed: ' + ((e2 && e2.message) || e2),
            stage: 'ab-fallback', labId: lab.id
          });
        } catch (e3) { /* last resort: stay silent, status says it */ }
      }
    }

    function runSequential() {
      var factoryKind = lab._factory.kind || 'unknown';
      lab.cells.forEach(function (cell) {
        cell.arms = [];
        cell.failReason = null;
        for (var r = 0; r < cell.replicates; r++) {
          var key = cacheKey(cell.spec, r, lab.totalSteps, factoryKind);
          var hit = lab.cache[key];
          var series, snapshot, backendKind, fromCache = false;
          if (hit) {
            series = hit.series; snapshot = hit.snapshot;
            backendKind = hit.backendKind; fromCache = true;
          } else {
            var backend = lab._factory(cell.spec, r); // throws -> caught by caller
            if (!backend || typeof backend.step !== 'function' ||
                typeof backend.sampleMetrics !== 'function') {
              throw new Error('w26-ab: factory for cell ' + cell.label +
                ' did not return a steppable backend (sequential)');
            }
            backendKind = backend.kind || factoryKind;
            series = {};
            lab.metrics.forEach(function (m) { series[m] = []; });
            for (var s = 0; s < lab.totalSteps; s++) {
              backend.step();
              if (s % lab.sampleEvery === 0 || s === lab.totalSteps - 1) {
                var mm = null;
                try { mm = backend.sampleMetrics(); } catch (e) { mm = null; }
                (function (tt) {
                  lab.metrics.forEach(function (m) {
                    var v = (mm && isNum(mm[m])) ? mm[m] : NaN;
                    series[m].push({ t: tt, v: v });
                  });
                })((s + 1) * DT);
              }
            }
            try { snapshot = backend.snapshotState(); } catch (e) { snapshot = null; }
            try { if (backend.dispose) backend.dispose(); } catch (e) { /* ignore */ }
            lab.cache[key] = { series: series, snapshot: snapshot, backendKind: backendKind };
          }
          cell.arms.push({
            backend: null, simTime: lab.totalSteps * DT,
            series: series, snapshot: snapshot,
            backendKind: backendKind, fromCache: fromCache, repIndex: r
          });
        }
        cell.status = cell.arms.length ? 'done' : 'failed';
      });
      lab.simTime = lab.totalSteps * DT;
      lab.status = 'done';
      lab.winners = declareWinners();
      emitWinners();
      try {
        V.bus.emit('vx:ab-fallback-complete',
          { labId: lab.id, mode: lab.mode, reason: lab.fallbackReason });
      } catch (e) { /* bus must never break the lab */ }
    }

    function listPairs() {
      var ls = lab.cells.map(function (c) { return c.label; });
      var out = [];
      for (var i = 0; i < ls.length; i++) {
        for (var j = i + 1; j < ls.length; j++) out.push(ls[i] + '-' + ls[j]);
      }
      return out;
    }

    function cellByLabel(label) {
      for (var i = 0; i < lab.cells.length; i++) {
        if (lab.cells[i].label === label) return lab.cells[i];
      }
      return null;
    }

    // Per metric, per cell-pair: [{t, delta, replicateVariance, lo, hi}].
    // delta = meanB - meanA; band = delta ± 1.96·SE (SE from replicate
    // variance); lo/hi included in the DATA — shading is the panel's job.
    function getDeltaSeries(metric, pair) {
      var parts = String(pair || '').split('-');
      if (parts.length !== 2) return [];
      var ca = cellByLabel(parts[0]), cb = cellByLabel(parts[1]);
      if (!ca || !cb || !ca.arms.length || !cb.arms.length) return [];
      var sa = ca.arms[0].series[metric], sb = cb.arms[0].series[metric];
      if (!sa || !sb) return [];
      var n = Math.min(sa.length, sb.length);
      var out = [];
      for (var i = 0; i < n; i++) {
        var aVals = [], bVals = [], k;
        for (k = 0; k < ca.arms.length; k++) {
          var va = ca.arms[k].series[metric][i];
          if (va && isNum(va.v)) aVals.push(va.v);
        }
        for (k = 0; k < cb.arms.length; k++) {
          var vb = cb.arms[k].series[metric][i];
          if (vb && isNum(vb.v)) bVals.push(vb.v);
        }
        if (!aVals.length || !bVals.length) continue;
        var vA = svar(aVals), vB = svar(bVals);
        var delta = mean(bVals) - mean(aVals);
        var se = Math.sqrt(vA / aVals.length + vB / bVals.length);
        out.push({
          t: sa[i].t,
          delta: delta,
          replicateVariance: (vA + vB) / 2,
          lo: delta - Z95 * se,
          hi: delta + Z95 * se
        });
      }
      return out;
    }

    function finalValues(cell, metric) {
      var vals = [];
      cell.arms.forEach(function (arm) {
        var s = arm.series[metric];
        if (!s || !s.length) return;
        var tail = s.slice(Math.max(0, s.length - 10));
        var vs = tail.map(function (p) { return p.v; }).filter(isNum);
        if (vs.length) vals.push(mean(vs));
      });
      return vals;
    }

    function declareWinners() {
      var out = [];
      listPairs().forEach(function (pair) {
        var parts = pair.split('-');
        var ca = cellByLabel(parts[0]), cb = cellByLabel(parts[1]);
        if (!ca || !cb) return;
        lab.metrics.forEach(function (metric) {
          var w = winnerOf(metric, finalValues(ca, metric), finalValues(cb, metric));
          // map relative A/B onto the pair's labels
          var winnerLabel = w.winner === 'A' ? parts[0] :
            w.winner === 'B' ? parts[1] : w.winner; // 'tie' | 'undecided'
          out.push({
            metric: w.metric, pair: pair, winner: winnerLabel,
            effectSize: w.effectSize, ci: w.ci,
            nA: w.nA, nB: w.nB, basis: w.basis, note: w.note,
            mode: lab.mode
          });
        });
      });
      return out;
    }

    function emitWinners() {
      lab.winners.forEach(function (w) {
        var detail = {
          labId: lab.id, metric: w.metric, pair: w.pair, winner: w.winner,
          effectSize: w.effectSize, ci: w.ci, basis: w.basis, mode: lab.mode
        };
        try { V.bus.emit('vx:ab-winner', detail); } catch (e) { /* ignore */ }
        // Best-effort direct hooks into W13 leaderboard + W08 market
        // settlement. Method names are guesses; every call is guarded, and
        // the vx:ab-winner event above is the authoritative feed.
        try {
          if (V.has('w13-compare')) {
            var c13 = V.get('w13-compare');
            if (c13 && typeof c13.recordABWinner === 'function') c13.recordABWinner(detail);
          }
        } catch (e) { /* ignore */ }
        try {
          if (V.has('w08-markets')) {
            var m8 = V.get('w08-markets');
            if (m8 && typeof m8.settleAB === 'function') m8.settleAB(detail);
          }
        } catch (e) { /* ignore */ }
      });
    }

    function latestDeltas() {
      var rows = [];
      listPairs().forEach(function (pair) {
        lab.metrics.forEach(function (metric) {
          var s = getDeltaSeries(metric, pair);
          if (s.length) {
            var last = s[s.length - 1];
            rows.push({
              pair: pair, metric: metric, t: last.t, delta: last.delta,
              replicateVariance: last.replicateVariance,
              lo: last.lo, hi: last.hi, n: s.length, series: s
            });
          }
        });
      });
      return rows;
    }

    // ---- public lab API
    lab.tick = function () {
      if (lab.status !== 'running' || lab.mode !== 'parallel') return { advanced: false };
      var t0 = V.utils.now();
      try {
        lab.cells.forEach(function (cell) {
          if (cell.status === 'failed') return;
          cell.arms.forEach(function (arm) {
            arm.backend.step();
            arm.simTime += DT;
          });
        });
      } catch (err) {
        enterSequentialFallback(err); // failed parallel step -> sequential
        return { advanced: false, fallback: true };
      }
      lab.simTime += DT;
      lab.stepCount++;
      var dtMs = V.utils.now() - t0;
      lab.tickTimes.push(dtMs);
      if (lab.tickTimes.length > 20) lab.tickTimes.shift();
      if (lab.stepCount >= 10) {
        var med = median(lab.tickTimes);
        if (med > lab.slowTickMs) {
          enterSequentialFallback(new Error('parallel ticks too slow (median ' +
            med.toFixed(1) + 'ms > ' + lab.slowTickMs + 'ms budget)'));
          return { advanced: false, fallback: true };
        }
      }
      if (lab.stepCount % lab.sampleEvery === 0) sampleAll();
      applyProbes();
      if (lab.simTime >= lab.durationSec) finish('done');
      return { advanced: true };
    };

    lab.start = function () {
      if (lab.status === 'running') return lab;
      lab.mode = 'parallel';
      lab.status = 'running';
      lab.simTime = 0;
      lab.stepCount = 0;
      lab.tickTimes = [];
      lab.fallbackReason = null;
      lab.winners = [];
      try {
        buildArms();
      } catch (err) {
        enterSequentialFallback(err); // backend construction failed
        return lab;
      }
      try {
        V.bus.emit('vx:ab-start', {
          labId: lab.id, layout: lab.layout,
          cells: lab.cells.map(function (c) { return c.label; })
        });
      } catch (e) { /* ignore */ }
      V.ui.announce('A/B lab started — ' + lab.cells.length +
        ' cells, hard-synced timelines (' + lab._factory.kind + ' backends).');
      if (lab._autoDrive) {
        stopTimer();
        lab._timer = setInterval(function () {
          var alive = lab.status === 'running' && lab.mode === 'parallel';
          for (var i = 0; i < lab.stepsPerTick && alive; i++) {
            var r = lab.tick();
            alive = r.advanced;
          }
          if (!alive) stopTimer();
        }, lab._driveMs);
      }
      return lab;
    };

    lab.runSync = function (n) {
      // Headless deterministic driver: advance up to n ticks.
      n = Math.max(0, n | 0 || 0);
      for (var i = 0; i < n; i++) {
        var r = lab.tick();
        if (!r.advanced) break;
      }
      return lab;
    };

    lab.stop = function () {
      if (lab.status !== 'running') return lab;
      finish('stopped');
      return lab;
    };

    lab.dispose = function () {
      stopTimer();
      lab.cells.forEach(function (cell) {
        cell.arms.forEach(function (arm) {
          try { if (arm.backend && arm.backend.dispose) arm.backend.dispose(); }
          catch (e) { /* ignore */ }
        });
        cell.arms = [];
      });
      lab.status = 'idle';
      return lab;
    };

    lab.listPairs = listPairs;
    lab.getDeltaSeries = getDeltaSeries;
    lab.latestDeltas = latestDeltas;
    lab.declareWinners = function () {
      lab.winners = declareWinners();
      emitWinners();
      return lab.winners;
    };
    lab.enterSequentialFallback = function (reason) {
      // manual trigger (panel "force fallback" / tests)
      if (lab.mode === 'sequential-fallback') return lab;
      enterSequentialFallback(reason || new Error('manual fallback requested'));
      return lab;
    };
    lab.modeLabel = function () {
      if (lab.mode === 'sequential-fallback') {
        return 'sequential fallback — cached sequential runs (run A → snapshot, run B → snapshot)' +
          (lab.fallbackReason ? ' [' + lab.fallbackReason + ']' : '');
      }
      return 'parallel · hard-synced timelines';
    };
    lab.describe = function () {
      return {
        id: lab.id, layout: lab.layout, mode: lab.mode, status: lab.status,
        simTime: lab.simTime, metrics: lab.metrics.slice(),
        backendKind: lab._factory.kind || 'unknown',
        fallbackReason: lab.fallbackReason,
        cells: lab.cells.map(function (c) {
          return {
            label: c.label, configId: c.configId, replicates: c.replicates,
            status: c.status, failReason: c.failReason,
            backendKinds: c.arms.map(function (a) { return a.backendKind; }),
            fromCache: c.arms.map(function (a) { return !!a.fromCache; })
          };
        })
      };
    };

    return lab;
  }

  // ------------------------------------------------------- panel "A/B lab"
  var SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  function sparkline(vals) {
    var vs = vals.filter(isNum);
    if (!vs.length) return '—';
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    if (!(hi > lo)) return SPARKS[3].repeat(Math.min(vs.length, 24));
    var tail = vs.slice(-24);
    return tail.map(function (v) {
      return SPARKS[Math.min(7, Math.floor((v - lo) / (hi - lo) * 8))];
    }).join('');
  }

  function mountAbLab(el) {
    if (!root.document) return; // browser only; selfTest never mounts
    var doc = root.document;

    function h(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null) e.textContent = String(text);
      return e;
    }
    function numInput(val, step, min, max) {
      var i = doc.createElement('input');
      i.type = 'number'; i.value = val;
      if (step !== undefined) i.step = step;
      if (min !== undefined) i.min = min;
      if (max !== undefined) i.max = max;
      i.style.width = '5.5em';
      return i;
    }

    var wrap = h('div', 'vx-ab-panel');
    var head = h('div', 'vx-ab-head');
    head.appendChild(h('h3', null, 'A/B lab'));
    var modeBadge = h('span', 'vx-ab-mode', 'idle');
    var statusLine = h('span', 'vx-ab-status', 'not started');
    head.appendChild(modeBadge); head.appendChild(statusLine);
    wrap.appendChild(head);

    // --- controls row: layout, duration, replicates default
    var ctrls = h('div', 'vx-ab-controls');
    ctrls.appendChild(h('label', null, 'Layout '));
    var layoutSel = doc.createElement('select');
    LAYOUTS.forEach(function (L) {
      var o = doc.createElement('option'); o.value = L; o.textContent = L;
      layoutSel.appendChild(o);
    });
    ctrls.appendChild(layoutSel);
    ctrls.appendChild(h('label', null, ' Duration (sim s) '));
    var durInput = numInput(10, 1, 1, 3600); ctrls.appendChild(durInput);
    ctrls.appendChild(h('label', null, ' Replicates '));
    var repInput = numInput(3, 1, 1, 16); ctrls.appendChild(repInput);
    var startBtn = h('button', null, 'Start');
    var stopBtn = h('button', null, 'Stop'); stopBtn.disabled = true;
    var declareBtn = h('button', null, 'Declare winners now'); declareBtn.disabled = true;
    var fallbackBtn = h('button', null, 'Force sequential fallback'); fallbackBtn.disabled = true;
    ctrls.appendChild(startBtn); ctrls.appendChild(stopBtn);
    ctrls.appendChild(declareBtn); ctrls.appendChild(fallbackBtn);
    wrap.appendChild(ctrls);

    // --- per-cell config
    var cellBox = h('div', 'vx-ab-cells');
    wrap.appendChild(cellBox);
    var cellUIs = [];
    var configs = availableConfigs();

    function buildCellUIs() {
      cellBox.innerHTML = '';
      cellUIs = [];
      var n = layoutSel.value === '2x2' ? 4 : 2;
      var labels = n === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
      labels.forEach(function (L, i) {
        var fs = doc.createElement('fieldset');
        fs.appendChild(h('legend', null, 'Cell ' + L));
        var cfg = doc.createElement('select');
        configs.forEach(function (c) {
          var o = doc.createElement('option');
          o.value = c.id; o.textContent = c.title || c.id;
          cfg.appendChild(o);
        });
        fs.appendChild(h('label', null, 'Config ')); fs.appendChild(cfg);
        fs.appendChild(h('label', null, ' Seed '));
        var seedI = numInput(1000 + i * 7919, 1); fs.appendChild(seedI);
        var pCirc = numInput(1.0, 0.05), pTurb = numInput(0.5, 0.05), pPers = numInput(0.5, 0.05);
        fs.appendChild(h('label', null, ' Circ ')); fs.appendChild(pCirc);
        fs.appendChild(h('label', null, ' Turb ')); fs.appendChild(pTurb);
        fs.appendChild(h('label', null, ' Pers ')); fs.appendChild(pPers);
        var probeSel = doc.createElement('select');
        [['', '(no probe)']].concat(CORE_PROBES.map(function (p) { return [p, p]; }))
          .forEach(function (pr) {
            var o = doc.createElement('option'); o.value = pr[0]; o.textContent = pr[1];
            probeSel.appendChild(o);
          });
        fs.appendChild(h('label', null, ' Probe ')); fs.appendChild(probeSel);
        fs.appendChild(h('label', null, ' at (s) '));
        var probeAt = numInput(5, 0.5, 0); fs.appendChild(probeAt);
        cellBox.appendChild(fs);
        cellUIs.push({ label: L, cfg: cfg, seed: seedI, pCirc: pCirc, pTurb: pTurb, pPers: pPers, probe: probeSel, probeAt: probeAt });
      });
    }
    layoutSel.addEventListener('change', buildCellUIs);
    buildCellUIs();

    // --- delta table
    wrap.appendChild(h('h4', null, 'Delta sparklines (B−A per pair; band = ±1.96·SE of replicates)'));
    var dTable = doc.createElement('table'); dTable.className = 'vx-ab-table';
    var dHead = doc.createElement('thead');
    var dhr = doc.createElement('tr');
    ['Pair', 'Metric', 't (s)', 'Δ', 'Band lo–hi', 'Trend'].forEach(function (t) {
      dhr.appendChild(h('th', null, t));
    });
    dHead.appendChild(dhr); dTable.appendChild(dHead);
    var dBody = doc.createElement('tbody');
    dTable.appendChild(dBody); wrap.appendChild(dTable);

    // --- winners table
    wrap.appendChild(h('h4', null, 'Winners (per metric; 95% CI on mean difference)'));
    var wTable = doc.createElement('table'); wTable.className = 'vx-ab-table';
    var wHead = doc.createElement('thead');
    var whr = doc.createElement('tr');
    ['Metric', 'Pair', 'Winner', 'Effect size d', '95% CI', 'Basis', 'Mode'].forEach(function (t) {
      whr.appendChild(h('th', null, t));
    });
    wHead.appendChild(whr); wTable.appendChild(wHead);
    var wBody = doc.createElement('tbody');
    wTable.appendChild(wBody); wrap.appendChild(wTable);

    var note = h('p', 'vx-ab-note',
      'Cells run on real backends when W14/W02/W15 register an A/B factory; ' +
      'otherwise they run on the labeled deterministic synthetic reference ' +
      '(wiring/tests only — not a fluid solver). No network calls anywhere.');
    wrap.appendChild(note);

    el.appendChild(wrap);

    var lab = null;
    var timer = null;

    function fmt(x, d) { return isNum(x) ? x.toFixed(d === undefined ? 4 : d) : '—'; }

    function refresh() {
      if (!lab) return;
      modeBadge.textContent = lab.modeLabel();
      var bk = lab.cells.map(function (c) {
        var kinds = {};
        c.arms.forEach(function (a) { kinds[a.backendKind] = true; });
        return c.label + ':' + Object.keys(kinds).join(',');
      }).join(' ');
      statusLine.textContent = lab.status + ' · t=' + lab.simTime.toFixed(2) +
        's · ' + lab.mode + ' · backends [' + bk + ']';
      // delta rows
      dBody.innerHTML = '';
      lab.latestDeltas().forEach(function (row) {
        var tr = doc.createElement('tr');
        tr.appendChild(h('td', null, row.pair));
        tr.appendChild(h('td', null, row.metric));
        tr.appendChild(h('td', null, fmt(row.t, 1)));
        tr.appendChild(h('td', null, fmt(row.delta)));
        tr.appendChild(h('td', null, fmt(row.lo) + ' … ' + fmt(row.hi)));
        tr.appendChild(h('td', 'vx-ab-spark', sparkline(row.series.map(function (p) { return p.delta; }))));
        dBody.appendChild(tr);
      });
      if (!dBody.children.length) {
        var tr0 = doc.createElement('tr');
        var td0 = h('td', null, 'no samples yet — start the lab'); td0.colSpan = 6;
        tr0.appendChild(td0); dBody.appendChild(tr0);
      }
      // winners rows
      wBody.innerHTML = '';
      (lab.winners || []).forEach(function (w) {
        var tr = doc.createElement('tr');
        tr.appendChild(h('td', null, w.metric));
        tr.appendChild(h('td', null, w.pair));
        tr.appendChild(h('td', null, w.winner + (w.note ? ' *' : '')));
        tr.appendChild(h('td', null, fmt(w.effectSize, 3)));
        tr.appendChild(h('td', null, fmt(w.ci.lo, 4) + ' … ' + fmt(w.ci.hi, 4)));
        tr.appendChild(h('td', null, w.basis));
        tr.appendChild(h('td', null, w.mode));
        if (w.note) tr.title = w.note;
        wBody.appendChild(tr);
      });
      var running = lab.status === 'running';
      stopBtn.disabled = !running;
      declareBtn.disabled = !(running || lab.status === 'done' || lab.status === 'stopped');
      fallbackBtn.disabled = !(running && lab.mode === 'parallel');
      startBtn.disabled = running;
    }

    startBtn.addEventListener('click', function () {
      if (lab) lab.dispose();
      var reps = Math.max(1, Math.min(16, parseInt(repInput.value, 10) || 3));
      var cells = cellUIs.map(function (cu) {
        var probeVal = cu.probe.value;
        return {
          label: cu.label,
          configId: cu.cfg.value,
          params: {
            circulation: parseFloat(cu.pCirc.value),
            turbulence: parseFloat(cu.pTurb.value),
            persistence: parseFloat(cu.pPers.value)
          },
          seed: parseInt(cu.seed.value, 10) || 1,
          probe: probeVal ? { id: probeVal, at: parseFloat(cu.probeAt.value) || 0, strength: 0.25 } : null,
          replicates: reps
        };
      });
      lab = createLab({
        layout: layoutSel.value,
        cells: cells,
        durationSec: Math.max(1, parseFloat(durInput.value) || 10),
        sampleEvery: 6,
        stepsPerTick: 4,
        autoDrive: true,
        driveMs: 120
      });
      lab.start();
      if (timer) clearInterval(timer);
      timer = setInterval(refresh, 500);
      refresh();
    });
    stopBtn.addEventListener('click', function () { if (lab) { lab.stop(); refresh(); } });
    declareBtn.addEventListener('click', function () { if (lab) { lab.declareWinners(); refresh(); } });
    fallbackBtn.addEventListener('click', function () {
      if (lab) { lab.enterSequentialFallback(new Error('forced from panel')); refresh(); }
    });

    refresh();
  }

  try {
    V.ui.registerPanel('ab-lab', 'A/B lab', mountAbLab);
  } catch (e) { /* panel registry must never break module load */ }

  // ------------------------------------------------------------- selfTest
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }

    function mkCell(label, seed, circ) {
      return {
        label: label, configId: 'spiral-default',
        params: { circulation: circ, turbulence: 0.5, persistence: 0.5 },
        seed: seed, probe: null, replicates: 3
      };
    }

    try {
      // 1. Synced timelines: one driver loop, every arm advances equally.
      var lab = createLab({
        layout: '2x1',
        cells: [mkCell('A', 11, 1.0), mkCell('B', 22, 1.4)],
        durationSec: 5, sampleEvery: 6, autoDrive: false
      });
      lab.start();
      lab.runSync(60);
      var times = [];
      lab.cells.forEach(function (c) {
        c.arms.forEach(function (a) { times.push(a.simTime); });
      });
      var allEqual = times.length === 6 &&
        times.every(function (t) { return Math.abs(t - times[0]) < 1e-12; }) &&
        Math.abs(lab.simTime - times[0]) < 1e-12;
      check('synced-timelines', allEqual,
        'arms=' + times.length + ' simTime=' + lab.simTime.toFixed(4) +
        's arm[0]=' + (times[0] !== undefined ? times[0].toFixed(4) : '?'));
      check('registered-id', V.has(MODULE_ID), 'VORTEX.has("w26-ab")');
      check('shared-camera', lab.cells[0].camera === lab.cells[1].camera &&
        typeof lab.cells[0].camera === 'object',
        'both cells share one camera descriptor object');

      // 2. Delta series shape: {t, delta, replicateVariance, lo, hi}.
      var s = lab.getDeltaSeries('ke', 'A-B');
      var shapeOk = s.length > 0 && s.every(function (p) {
        return isNum(p.t) && isNum(p.delta) && isNum(p.replicateVariance) &&
          isNum(p.lo) && isNum(p.hi) && p.lo <= p.delta && p.delta <= p.hi;
      });
      check('delta-series-shape', shapeOk,
        s.length + ' samples; keys t/delta/replicateVariance/lo/hi; lo<=delta<=hi');
      lab.dispose();

      // 3. Fallback: a backend that throws mid-run triggers honest fallback.
      var made = 0;
      function riggedFactory(cellSpec, repIndex) {
        made++;
        var b = makeSyntheticBackend({
          seed: repSeed(cellSpec.seed, repIndex),
          params: cellSpec.params, probe: null
        });
        if (made === 1) {
          var n = 0, orig = b.step;
          b.kind = 'rigged-synthetic';
          b.step = function () {
            n++;
            if (n === 3) throw new Error('rigged backend failure');
            orig();
          };
        }
        return b;
      }
      riggedFactory.kind = 'rigged';
      var lab2 = createLab({
        layout: '2x1',
        cells: [mkCell('A', 33, 1.0), mkCell('B', 44, 1.0)],
        durationSec: 2, sampleEvery: 6, autoDrive: false,
        backendFactory: riggedFactory, slowTickMs: 1e9 // don't trip slowness
      });
      lab2.start();
      lab2.runSync(200); // tick 3 throws -> sequential fallback runs to completion
      check('fallback-triggered', lab2.mode === 'sequential-fallback',
        'mode=' + lab2.mode + ' reason=' + lab2.fallbackReason);
      check('fallback-labeled', /sequential/i.test(lab2.modeLabel()),
        lab2.modeLabel());
      var s2 = lab2.getDeltaSeries('ke', 'A-B');
      check('fallback-completes', lab2.status === 'done' && s2.length > 0,
        'status=' + lab2.status + ' samples=' + s2.length);
      check('fallback-winners', Array.isArray(lab2.winners) && lab2.winners.length === 3,
        lab2.winners.length + ' winner rows (3 metrics x 1 pair)');
      lab2.dispose();

      // 4. Winner math on synthetic data picks the true winner.
      var w = winnerOf('ke',
        [1.00, 1.10, 0.90, 1.05, 0.95],
        [2.00, 2.10, 1.90, 2.05, 1.95]);
      check('winner-true-winner',
        w.winner === 'B' && w.ci.lo > 0 && w.effectSize > 2,
        'winner=' + w.winner + ' d=' + (w.effectSize || 0).toFixed(2) +
        ' CI=[' + w.ci.lo.toFixed(3) + ',' + w.ci.hi.toFixed(3) + '] basis=' + w.basis);
      var wt = winnerOf('ke', [1.0, 1.1, 0.9, 1.05, 0.95], [1.02, 0.98, 1.05, 0.95, 1.0]);
      check('winner-tie-or-undecided',
        wt.winner === 'tie' || wt.winner === 'undecided',
        'winner=' + wt.winner + ' CI=[' + wt.ci.lo.toFixed(3) + ',' + wt.ci.hi.toFixed(3) + ']');
      var wn = winnerOf('ke', [1.5], [2.5]);
      check('winner-needs-replicates', wn.winner === 'undecided' && /replicates/.test(wn.note),
        'n=1 -> undecided: ' + wn.note);
      var w06mod = null;
      try { w06mod = V.get('w06-protocols'); } catch (e) { w06mod = null; }
      var w06Compare = !!(w06mod && typeof w06mod.compareAB === 'function');
      check('w06-absent-safe',
        w.basis === (w06Compare ? 'w06-protocols' : 'builtin-welch'),
        w06Compare ? 'w06.compareAB present and used'
                   : 'w06 absent or exposes no compareAB; built-in math used without throwing');

      // 5. Sequential fallback labeled even when entered manually.
      var lab3 = createLab({
        layout: '2x1', cells: [mkCell('A', 55, 1.0), mkCell('B', 66, 1.2)],
        durationSec: 1, autoDrive: false
      });
      lab3.start();
      lab3.enterSequentialFallback(new Error('manual test'));
      check('manual-fallback-labeled',
        lab3.mode === 'sequential-fallback' && /sequential fallback/i.test(lab3.modeLabel()) &&
        lab3.status === 'done',
        lab3.modeLabel());
      // cache hit on identical re-run
      var cacheSize = Object.keys(lab3.cache).length;
      check('sequential-cache', cacheSize === 6,
        cacheSize + ' cached arm-runs (2 cells x 3 replicates)');
      lab3.dispose();
    } catch (e) {
      check('selftest-no-throw', false, (e && e.stack) || String(e));
    }

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  VORTEX.register(MODULE_ID, {
    selfTest: selfTest,
    createLab: createLab,
    layouts: function () { return LAYOUTS.slice(); },
    defaultMetrics: defaultMetrics,
    availableConfigs: availableConfigs,
    winnerOf: winnerOf,
    makeSyntheticBackend: makeSyntheticBackend,
    resolveCamera: resolveCamera,
    version: MODULE_ID + '/1.0'
  });
})(typeof window !== 'undefined' ? window : globalThis);
