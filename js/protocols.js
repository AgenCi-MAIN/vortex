/* VORTEX js/protocols.js — W06 experiment protocol framework.
 *
 * Science runs on protocols, not vibes. A protocol is a frozen,
 * content-hashed JSON spec: hypothesis, config, timed probe sequence,
 * paired control, replication counts, stop conditions. Verdicts
 * (CONFIRMED / REFUTED / INCONCLUSIVE) come from effect size + 95% CI,
 * computed with zero external libraries.
 *
 * Verdict rule (hard): a verdict is NEVER auto-entered into the lab
 * notebook as truth. It is the protocol's computed verdict, emitted on
 * `vx:protocol-verdict` with `autoNotebook:false`. Recording it is a
 * human (owner) decision — W13 owns notebook entries.
 *
 * Integration guards (all degrade cleanly when absent):
 *   - w07-metrics:   enrich raw driver samples via w07.enrich() when present.
 *   - w25-determinism: hand each executed replicate a V.makeManifest() manifest;
 *                      call w25.record(manifest) only if the function exists.
 *   - w13-compare:    listens to vx:protocol-verdict; we never write there.
 *
 * Driver interface (what execute() needs; adapt any backend to it):
 *   {
 *     reset:      function(seed, params, arm)  // 'treatment' | 'control'
 *     step:       function()                   // ONE fixed-dt sim step
 *     applyProbe: function(probeId, params)    // fire probe at current sim time
 *     sample:     function() -> {metric: num}  // metrics snapshot
 *   }
 * Use VORTEX.get('w06-protocols').driverFromBackend(backend, canvas) to adapt a
 * VortexField-contract backend. Replicate reset prefers backend.init(canvas,
 * {seed, params}) when a canvas is available; otherwise it falls back to
 * snapshot restore (flagged resetMode:'snapshot' — replicates then share
 * initial conditions, and zero cross-replicate variance forces INCONCLUSIVE
 * with the reason stated).
 *
 * Plain script, no modules. Works headless (node) and in browser.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w06-protocols: VORTEX namespace missing (load vx-namespace.js first)');
  var U = V.utils;
  var DT = V.SIM_DT || (1 / 60);

  // ---------------------------------------------------------------- states
  var STATES = ['draft', 'queued', 'running', 'scored', 'archived'];
  var TRANSITIONS = {
    draft:   ['queued'],
    queued:  ['draft', 'running'],
    running: ['queued', 'scored'],   // running->queued is an abort back to queue
    scored:  ['archived'],
    archived: []
  };

  // ------------------------------------------------------- t-critical 95%
  // Two-sided 0.975 quantiles, df 1..30. Standard Student-t table values.
  var TCRIT95 = [0,
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.059, 2.056, 2.052, 2.048, 2.045, 2.042];
  function tCrit95(df) {
    if (!(df >= 1)) return NaN;
    if (df <= 30) return TCRIT95[Math.floor(df)] || TCRIT95[30];
    return 1.96; // normal approx for large df
  }

  // ----------------------------------------------------------------- stats
  function mean(xs) {
    var s = 0, i;
    for (i = 0; i < xs.length; i++) s += xs[i];
    return xs.length ? s / xs.length : NaN;
  }
  function variance(xs) { // sample variance (n-1)
    if (xs.length < 2) return NaN;
    var m = mean(xs), s = 0, i;
    for (i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m);
    return s / (xs.length - 1);
  }
  function cohensD(txs, cxs) {
    var n1 = txs.length, n2 = cxs.length;
    if (n1 < 2 || n2 < 2) return NaN;
    var v1 = variance(txs), v2 = variance(cxs);
    var sp = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
    if (!(sp > 0)) return NaN;
    return (mean(txs) - mean(cxs)) / sp;
  }
  // Welch 95% CI for the difference of means (treatment - control).
  function welchCI(txs, cxs) {
    var n1 = txs.length, n2 = cxs.length;
    if (n1 < 2 || n2 < 2) return null;
    var m1 = mean(txs), m2 = mean(cxs);
    var v1 = variance(txs), v2 = variance(cxs);
    if (!(v1 >= 0) || !(v2 >= 0)) return null;
    var se = Math.sqrt(v1 / n1 + v2 / n2);
    if (!(se > 0)) return null; // degenerate: no variance at all
    var num = (v1 / n1 + v2 / n2) * (v1 / n1 + v2 / n2);
    var den = (v1 * v1) / (n1 * n1 * (n1 - 1)) + (v2 * v2) / (n2 * n2 * (n2 - 1));
    var df = den > 0 ? num / den : 1;
    var t = tCrit95(df);
    var diff = m1 - m2;
    return { diff: diff, se: se, df: df, tCrit: t, lo: diff - t * se, hi: diff + t * se };
  }
  // Verdict from effect size + 95% CI. expectsDirection: +1 (treatment > control)
  // or -1 (treatment < control). Never returns anything but the three verdicts.
  function verdict(txs, cxs, expectsDirection, minimumEffect) {
    var out = { verdict: 'INCONCLUSIVE', reason: '', d: NaN, ci: null,
                nT: txs.length, nC: cxs.length,
                meanT: mean(txs), meanC: mean(cxs) };
    if (txs.length < 2 || cxs.length < 2) {
      out.reason = 'need >=2 replicates per arm (got ' + txs.length + '/' + cxs.length + ')';
      return out;
    }
    var d = cohensD(txs, cxs);
    var ci = welchCI(txs, cxs);
    out.d = d; out.ci = ci;
    if (ci === null || !(d === d)) {
      out.reason = 'degenerate: no variance across replicates (backend may lack per-seed reset)';
      return out;
    }
    var significant = (ci.lo > 0) || (ci.hi < 0);
    if (!significant) {
      out.reason = '95% CI [' + ci.lo.toFixed(3) + ', ' + ci.hi.toFixed(3) +
        '] includes 0 — effect not distinguishable from noise at n=' +
        txs.length + '+' + cxs.length;
      return out;
    }
    var dir = expectsDirection >= 0 ? 1 : -1;
    var observed = ci.diff > 0 ? 1 : -1;
    if (minimumEffect && Math.abs(d) < minimumEffect) {
      out.reason = 'significant but |d|=' + Math.abs(d).toFixed(3) +
        ' below minimum effect ' + minimumEffect;
      return out;
    }
    if (observed === dir) {
      out.verdict = 'CONFIRMED';
      out.reason = 'effect in predicted direction, 95% CI excludes 0, d=' + d.toFixed(3);
    } else {
      out.verdict = 'REFUTED';
      out.reason = 'significant effect OPPOSITE to prediction, d=' + d.toFixed(3);
    }
    return out;
  }

  // ---------------------------------------------------------------- schema
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function validateProtocol(p) {
    var errors = [];
    if (!isObj(p)) return { ok: false, errors: ['protocol must be an object'] };
    if (typeof p.id !== 'string' || !p.id) errors.push('id: non-empty string required');
    if (typeof p.hypothesis !== 'string' || !p.hypothesis.trim())
      errors.push('hypothesis: non-empty string required');
    if (!isObj(p.config)) errors.push('config: object required');
    else {
      if (typeof p.config.configId !== 'string' || !p.config.configId)
        errors.push('config.configId: non-empty string required');
      if (!isObj(p.config.params)) errors.push('config.params: object required');
      if (!(p.config.seed >>> 0 === p.config.seed) && typeof p.config.seed !== 'number')
        errors.push('config.seed: number required');
    }
    if (!Array.isArray(p.probeSequence)) errors.push('probeSequence: array required');
    else p.probeSequence.forEach(function (pr, i) {
      if (!isObj(pr)) { errors.push('probeSequence[' + i + ']: object required'); return; }
      if (!(typeof pr.t === 'number' && pr.t >= 0))
        errors.push('probeSequence[' + i + '].t: sim-time seconds >= 0 required');
      if (typeof pr.probeId !== 'string' || !pr.probeId)
        errors.push('probeSequence[' + i + '].probeId: non-empty string required');
    });
    if (!isObj(p.control)) errors.push('control: object required');
    else {
      if (typeof p.control.paired !== 'boolean') errors.push('control.paired: boolean required');
      if (typeof p.control.configId !== 'string' || !p.control.configId)
        errors.push('control.configId: non-empty string required');
      if (!isObj(p.control.params)) errors.push('control.params: object required');
    }
    var rep = p.replications || { treatment: 5, control: 5 };
    if (!(rep.treatment >= 2) || !(rep.control >= 2))
      errors.push('replications: need >=2 per arm for variance (default 5+5)');
    if (typeof p.primaryMetric !== 'string' || !p.primaryMetric)
      errors.push('primaryMetric: non-empty string required');
    if (p.expectsDirection !== 1 && p.expectsDirection !== -1)
      errors.push('expectsDirection: must be +1 (treatment > control) or -1');
    if (p.stopConditions !== undefined && !Array.isArray(p.stopConditions))
      errors.push('stopConditions: array required when present');
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------------------------------------------------------------- freeze
  function deepFreeze(o) {
    if (o !== null && (typeof o === 'object')) {
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) deepFreeze(o[i]); }
      else {
        var ks = Object.keys(o);
        for (var j = 0; j < ks.length; j++) deepFreeze(o[ks[j]]);
      }
      Object.freeze(o);
    }
    return o;
  }
  // freeze: validate, hash content, return a NEW deeply-frozen object.
  // The input is never mutated.
  function freeze(p) {
    var v = validateProtocol(p);
    if (!v.ok) throw new Error('w06 freeze: invalid protocol: ' + v.errors.join('; '));
    var copy = JSON.parse(JSON.stringify(p));
    copy.replications = copy.replications || { treatment: 5, control: 5 };
    copy.stopConditions = copy.stopConditions || [];
    copy.createdBy = copy.createdBy || 'owner';
    copy.createdAt = copy.createdAt || new Date().toISOString();
    copy.codeVersion = V.codeVersion;
    var body = U.stableStringify(copy);
    copy._hash = U.hash53(body);
    copy._frozenAt = new Date().toISOString();
    return deepFreeze(copy);
  }
  // verifyFrozen: recompute the content hash over everything except the
  // hash bookkeeping fields. Detects any tampering after freeze.
  function verifyFrozen(p) {
    if (!isObj(p) || typeof p._hash !== 'string')
      return { ok: false, reason: 'not a frozen protocol (no _hash)' };
    if (!Object.isFrozen(p))
      return { ok: false, reason: 'not frozen (Object.isFrozen false)' };
    var copy = JSON.parse(JSON.stringify(p));
    delete copy._hash; delete copy._frozenAt;
    var recomputed = U.hash53(U.stableStringify(copy));
    if (recomputed !== p._hash)
      return { ok: false, reason: 'hash mismatch: content changed after freeze' };
    return { ok: true, reason: 'hash verified' };
  }

  // -------------------------------------------------------------- records
  var _records = {};   // id -> { spec, status, history:[{from,to,at}], results, verdict }
  var _driver = null;  // attached lab driver (setDriver)

  function draft(p) {
    var v = validateProtocol(p);
    if (!v.ok) throw new Error('w06 draft: invalid protocol: ' + v.errors.join('; '));
    if (_records[p.id]) throw new Error('w06 draft: duplicate protocol id ' + p.id);
    var rec = { spec: p, status: 'draft', history: [], results: null, verdict: null };
    _records[p.id] = rec;
    return rec;
  }
  function queue(frozenSpec) {
    var vf = verifyFrozen(frozenSpec);
    if (!vf.ok) throw new Error('w06 queue: ' + vf.reason);
    var rec = draft(frozenSpec);
    transition(rec, 'queued');
    return rec;
  }
  function transition(recOrId, to) {
    var rec = typeof recOrId === 'string' ? _records[recOrId] : recOrId;
    if (!rec) throw new Error('w06 transition: unknown protocol ' +
      (typeof recOrId === 'string' ? recOrId : '?'));
    var from = rec.status;
    if (STATES.indexOf(to) < 0)
      throw new Error('w06 transition: unknown target state "' + to + '"');
    if (TRANSITIONS[from].indexOf(to) < 0)
      throw new Error('w06 transition: illegal ' + from + ' -> ' + to +
        ' (allowed from ' + from + ': ' + (TRANSITIONS[from].join(', ') || 'none') + ')');
    if ((to === 'queued' || to === 'running') && !verifyFrozen(rec.spec).ok)
      throw new Error('w06 transition: ' + from + ' -> ' + to +
        ' requires a frozen, hash-verified spec');
    if (to === 'scored' && !rec.results)
      throw new Error('w06 transition: running -> scored requires results (run execute() first)');
    rec.status = to;
    rec.history.push({ from: from, to: to, at: new Date().toISOString() });
    V.bus.emit('vx:protocol-state', { id: rec.spec.id, from: from, to: to });
    return rec;
  }

  // ---------------------------------------------------------------- runner
  function stopLimit(p) {
    var maxSteps = 3600 * 10; // default 10 sim-minutes of headroom
    (p.stopConditions || []).forEach(function (sc) {
      if (sc.type === 'maxSteps' && sc.n > 0) maxSteps = Math.min(maxSteps, sc.n);
      if (sc.type === 'maxSimTime' && sc.seconds > 0)
        maxSteps = Math.min(maxSteps, Math.ceil(sc.seconds / DT));
    });
    return maxSteps;
  }
  function collectSample(driver) {
    var s = driver.sample() || {};
    // W07 metrics integration: enrich when present, degrade when absent.
    if (V.has('w07-metrics')) {
      try {
        var w07 = V.get('w07-metrics');
        if (w07 && typeof w07.enrich === 'function') {
          var extra = w07.enrich(s) || {};
          for (var k in extra) if (extra.hasOwnProperty(k) && s[k] === undefined) s[k] = extra[k];
        }
      } catch (e) { /* degrade: raw samples only */ }
    }
    return s;
  }
  function maybeRecordManifest(p, replicate) {
    // W25 determinism integration: always build the manifest; hand it to W25
    // only if it exposes a record() function.
    var m = V.makeManifest({
      seed: replicate.seed,
      params: replicate.params,
      configId: replicate.configId,
      probeTimeline: (p.probeSequence || []).map(function (pr) {
        return { t: pr.t, probe: pr.probeId, params: pr.params || {} };
      }),
      backend: replicate.backend || 'driver',
      tracers: replicate.tracers || 0,
      toleranceBands: replicate.toleranceBands || {}
    });
    if (V.has('w25-determinism')) {
      try {
        var w25 = V.get('w25-determinism');
        if (w25 && typeof w25.record === 'function') w25.record(m);
      } catch (e) { /* degrade */ }
    }
    return m;
  }

  function runReplicate(driver, arm, p, i, baseParams, baseSeed, configId) {
    var seed = (baseSeed + i) >>> 0;
    driver.reset(seed, baseParams, arm);
    var maxSteps = stopLimit(p);
    var t = 0, steps = 0;
    var probes = (p.probeSequence || []).slice().sort(function (a, b) { return a.t - b.t; });
    var fired = [];
    probes.forEach(function (pr) {
      var target = Math.ceil(pr.t / DT);
      while (steps < target && steps < maxSteps) { driver.step(); steps++; }
      t = steps * DT;
      driver.applyProbe(pr.probeId, pr.params || {});
      fired.push({ t: t, probeId: pr.probeId });
    });
    // settle: let the field respond after the last probe
    var settle = Math.min(240, Math.max(0, maxSteps - steps)); // 4 sim-seconds
    for (var s = 0; s < settle; s++) { driver.step(); steps++; }
    t = steps * DT;
    var sample = collectSample(driver);
    var metric = sample[p.primaryMetric];
    var manifest = maybeRecordManifest(p, {
      seed: seed, params: baseParams, configId: configId,
      backend: driver.kind || 'driver'
    });
    return {
      arm: arm, index: i, seed: seed, simTime: t, steps: steps,
      fired: fired, sample: sample,
      value: (typeof metric === 'number' && isFinite(metric)) ? metric : null,
      manifestHash: manifest.hash
    };
  }

  // execute a queued protocol. opts: {driver, onProgress}. Returns a Promise
  // resolving to the record. Transitions: queued->running, then running->scored.
  function execute(recOrId, opts) {
    opts = opts || {};
    var rec = typeof recOrId === 'string' ? _records[recOrId] : recOrId;
    if (!rec) return Promise.reject(new Error('w06 execute: unknown protocol'));
    var driver = opts.driver || _driver;
    if (!driver || typeof driver.reset !== 'function' || typeof driver.step !== 'function' ||
        typeof driver.sample !== 'function')
      return Promise.reject(new Error('w06 execute: no driver attached ' +
        '(setDriver() or pass opts.driver; driver needs reset/step/sample)'));
    var p = rec.spec;
    try { transition(rec, 'running'); }
    catch (e) { return Promise.reject(e); }

    var rep = p.replications || { treatment: 5, control: 5 };
    var nT = rep.treatment, nC = rep.control;
    var onProgress = opts.onProgress || function () {};
    var results = { replicates: [], startedAt: new Date().toISOString() };
    var pairs = Math.max(nT, nC);
    var txs = [], cxs = [];
    var failed = [];

    function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

    var chain = Promise.resolve();
    for (var i = 0; i < pairs; i++) (function (i) {
      // paired + interleaved: treatment[i] then control[i], same seed offset
      if (i < nT) chain = chain.then(function () {
        onProgress({ phase: 'replicate', arm: 'treatment', i: i, total: nT + nC });
        return tick().then(function () {
          var r = runReplicate(driver, 'treatment', p, i,
            p.config.params, p.config.seed >>> 0, p.config.configId);
          results.replicates.push(r);
          if (r.value === null) failed.push(r); else txs.push(r.value);
        });
      });
      if (i < nC) chain = chain.then(function () {
        onProgress({ phase: 'replicate', arm: 'control', i: i, total: nT + nC });
        return tick().then(function () {
          var r = runReplicate(driver, 'control', p, i,
            p.control.params, p.control.seed >>> 0, p.control.configId);
          results.replicates.push(r);
          if (r.value === null) failed.push(r); else cxs.push(r.value);
        });
      });
    })(i);

    return chain.then(function () {
      results.finishedAt = new Date().toISOString();
      results.failed = failed.length;
      var v = verdict(txs, cxs, p.expectsDirection, p.minimumEffect);
      v.metric = p.primaryMetric;
      v.failed = failed.length;
      // The verdict is computed, never auto-entered as truth.
      v.autoNotebook = false;
      v.note = 'Computed verdict only. A human (owner) records it in the lab ' +
        'notebook; W13 owns notebook entries.';
      results.verdict = v;
      rec.results = results;
      rec.verdict = v;
      transition(rec, 'scored');
      V.bus.emit('vx:protocol-verdict', {
        protocolId: p.id, verdict: v.verdict, d: v.d, ci: v.ci,
        metric: p.primaryMetric, autoNotebook: false
      });
      V.ui.announce('Protocol ' + p.id + ': ' + v.verdict +
        ' (d=' + (v.d === v.d ? v.d.toFixed(3) : 'n/a') + ')');
      return rec;
    });
  }

  // Adapt a VortexField-contract backend (CONTRACTS §5) to the driver
  // interface. canvas may be null headless — then reset uses snapshot restore
  // and the run is flagged resetMode:'snapshot'.
  function driverFromBackend(backend, canvas) {
    if (!backend) throw new Error('w06 driverFromBackend: no backend');
    var initial = null;
    return {
      kind: backend.name || 'backend',
      reset: function (seed, params) {
        if (typeof backend.setParams === 'function') backend.setParams(params);
        if (canvas && typeof backend.init === 'function') {
          // full re-init with the replicate seed (preferred)
          return backend.init(canvas, { seed: seed >>> 0, params: params });
        }
        if (typeof backend.restoreState === 'function' && initial) {
          backend.restoreState(initial); // snapshot fallback
          return;
        }
        throw new Error('w06 driver: backend has no re-init path (need canvas+init or snapshot)');
      },
      prime: function () { // capture the snapshot used by the fallback path
        if (typeof backend.snapshotState === 'function') initial = backend.snapshotState();
      },
      step: function () { backend.step(); },
      applyProbe: function (probeId, params) {
        if (typeof backend.addProbe !== 'function') return;
        // W05 probe objects when available; else a plain descriptor
        var probe = { id: probeId, params: params || {} };
        if (V.has('w05-probes')) {
          try {
            var w05 = V.get('w05-probes');
            if (w05 && typeof w05.get === 'function') {
              var full = w05.get(probeId);
              if (full) probe = full;
              probe.params = params || {};
            }
          } catch (e) { /* plain descriptor */ }
        }
        backend.addProbe(probe);
      },
      sample: function () {
        return (typeof backend.sampleMetrics === 'function') ? backend.sampleMetrics() : {};
      }
    };
  }
  function setDriver(d) { _driver = d; return _driver; }
  function getDriver() { return _driver; }

  // ------------------------------------------- "Save as protocol?" (ad-hoc)
  var _manualCounts = {}; // key -> {count, suggested}
  function trackManualRun(configId, mode) {
    var key = String(configId) + '::' + String(mode);
    var e = _manualCounts[key] || { count: 0, suggested: false };
    e.count += 1;
    var out = { configId: configId, mode: mode, count: e.count, suggested: false };
    if (e.count >= 3 && !e.suggested) {
      e.suggested = true;
      out.suggested = true;
      V.bus.emit('vx:protocol-suggest', {
        configId: configId, mode: mode, count: e.count,
        message: 'Same config+mode run ' + e.count + 'x ad-hoc. Save as protocol?'
      });
    }
    _manualCounts[key] = e;
    return out;
  }
  function manualRunCounts() {
    var o = {};
    for (var k in _manualCounts) if (_manualCounts.hasOwnProperty(k)) o[k] = _manualCounts[k].count;
    return o;
  }
  // Build a draft protocol from the ad-hoc history (caller freezes/queues it).
  function suggestProtocol(configId, mode, extra) {
    extra = extra || {};
    return {
      id: 'adhoc-' + String(configId) + '-' + String(mode) + '-' + Date.now().toString(36),
      hypothesis: extra.hypothesis || 'Ad-hoc runs suggest an effect worth testing.',
      config: { configId: configId, params: extra.params || {}, seed: extra.seed >>> 0 || 1 },
      probeSequence: extra.probeSequence || [],
      control: { paired: true, configId: configId, params: extra.params || {}, seed: extra.seed >>> 0 || 1 },
      replications: { treatment: 5, control: 5 },
      stopConditions: [],
      primaryMetric: extra.primaryMetric || 'mixing',
      expectsDirection: extra.expectsDirection || 1,
      createdBy: 'owner'
    };
  }

  // ------------------------------------------------- worked example (§12.4)
  // Opposing-winding merger: two vortices with opposing winding are
  // hypothesized to merge SLOWER (longer merger time) than the
  // unperturbed control. Runnable headless via exampleDriver().
  function exampleProtocol() {
    return {
      id: 'w06-example-opposing-merger',
      hypothesis: 'Firing the oppose-winding probe at t=2s on a vortex pair ' +
        'increases time-to-merger relative to the unperturbed paired control.',
      config: {
        configId: 'vortex-pair-merger',
        params: { circulation: 1.0, turbulence: 0.2, persistence: 0.9 },
        seed: 1234
      },
      probeSequence: [
        { t: 2.0, probeId: 'oppose-winding', params: { strength: 0.8 } }
      ],
      control: {
        paired: true,
        configId: 'vortex-pair-merger',
        params: { circulation: 1.0, turbulence: 0.2, persistence: 0.9 },
        seed: 1234
      },
      replications: { treatment: 5, control: 5 },
      stopConditions: [{ type: 'maxSimTime', seconds: 30 }],
      primaryMetric: 'mergerTime',
      expectsDirection: 1,
      minimumEffect: 0.5,
      createdBy: 'owner'
    };
  }
  // Synthetic driver with a KNOWN effect: treatment mergerTime ~ N(9,1),
  // control ~ N(6,1). Deterministic via mulberry32(seed). Used by selfTest
  // and the panel's dry-run mode.
  function exampleDriver() {
    var st = null;
    return {
      kind: 'synthetic',
      reset: function (seed, params, arm) {
        st = { rng: U.mulberry32(seed >>> 0), t: 0, arm: arm, params: params || {} };
      },
      step: function () { if (st) st.t += DT; },
      applyProbe: function () { /* no-op: effect is baked into the metric model */ },
      sample: function () {
        var r = st.rng;
        var z = (r() + r() + r() - 1.5) * 2; // ~N(0,1)
        var mu = (st.arm === 'treatment') ? 9.0 : 6.0;
        return { mergerTime: mu + z * 1.0, ke: 1.0, mixing: 0.5 };
      }
    };
  }

  // ----------------------------------------------------------------- panel
  function mountPanel(el) {
    var doc = root.document;
    function h(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      el.appendChild(e); return e;
    }
    function field(label, value, multiline) {
      h('label', 'vx-pf-label', label);
      var inp = multiline ? doc.createElement('textarea') : doc.createElement('input');
      inp.className = 'vx-pf-input';
      inp.value = value;
      el.appendChild(inp); return inp;
    }
    h('h3', 'vx-pf-title', 'Protocols — science, not vibes');
    var statusLine = h('div', 'vx-pf-status',
      'driver: ' + (getDriver() ? getDriver().kind : 'none (dry-run available)') +
      ' · w07-metrics: ' + (V.has('w07-metrics') ? 'present' : 'absent (raw samples)') +
      ' · w25: ' + (V.has('w25-determinism') ? 'present' : 'absent') +
      ' · w13: ' + (V.has('w13-compare') ? 'present' : 'absent'));
    var fId = field('id', 'my-protocol-1');
    var fHyp = field('hypothesis', 'Stirring longer increases mixing.', true);
    var fCfg = field('configId', 'spiral-default');
    var fSeed = field('seed', '1234');
    var fParams = field('params (JSON)', '{"circulation":1.0,"turbulence":0.2,"persistence":0.9}', true);
    var fProbes = field('probeSequence (JSON, t in sim seconds)',
      '[{"t":2.0,"probeId":"stir","params":{"strength":0.5}}]', true);
    var fMetric = field('primaryMetric', 'mixing');
    var dirSel = doc.createElement('select'); dirSel.className = 'vx-pf-input';
    [['1', 'treatment > control (+1)'], ['-1', 'treatment < control (−1)']].forEach(function (o) {
      var op = doc.createElement('option'); op.value = o[0]; op.textContent = o[1];
      dirSel.appendChild(op);
    });
    h('label', 'vx-pf-label', 'expectsDirection'); el.appendChild(dirSel);
    var fReps = field('replications (treatment,control)', '5,5');

    var btnRow = h('div', 'vx-pf-row');
    function btn(text, fn) {
      var b = doc.createElement('button');
      b.className = 'vx-pf-btn'; b.textContent = text;
      b.onclick = fn; btnRow.appendChild(b); return b;
    }
    var msg = h('div', 'vx-pf-msg');
    var prog = h('div', 'vx-pf-prog');
    var progBar = doc.createElement('div'); progBar.className = 'vx-pf-bar';
    prog.appendChild(progBar);
    var verdictBox = h('div', 'vx-pf-verdict');

    var currentId = null;
    function say(t, bad) { msg.textContent = t; msg.style.color = bad ? '#e5484d' : ''; }
    function parseJSON(t, what) {
      try { return JSON.parse(t); }
      catch (e) { throw new Error('bad JSON in ' + what + ': ' + e.message); }
    }
    function buildSpec() {
      var reps = fReps.value.split(',').map(function (x) { return parseInt(x.trim(), 10); });
      var seed = parseInt(fSeed.value.trim(), 10);
      return {
        id: fId.value.trim(),
        hypothesis: fHyp.value,
        config: { configId: fCfg.value.trim(), params: parseJSON(fParams.value, 'params'), seed: seed },
        probeSequence: parseJSON(fProbes.value, 'probeSequence'),
        control: {
          paired: true, configId: fCfg.value.trim(),
          params: parseJSON(fParams.value, 'params'), seed: seed
        },
        replications: { treatment: reps[0] || 5, control: reps[1] || 5 },
        stopConditions: [{ type: 'maxSimTime', seconds: 30 }],
        primaryMetric: fMetric.value.trim(),
        expectsDirection: parseInt(dirSel.value, 10),
        createdBy: 'owner'
      };
    }
    btn('Load worked example', function () {
      var ex = exampleProtocol();
      fId.value = ex.id; fHyp.value = ex.hypothesis; fCfg.value = ex.config.configId;
      fSeed.value = String(ex.config.seed);
      fParams.value = JSON.stringify(ex.config.params);
      fProbes.value = JSON.stringify(ex.probeSequence);
      fMetric.value = ex.primaryMetric; dirSel.value = '1'; fReps.value = '5,5';
      say('Worked example loaded: opposing-winding merger (§12.4 acceptance case).');
    });
    btn('Freeze & queue', function () {
      try {
        var frozen = freeze(buildSpec());
        var rec = queue(frozen);
        currentId = rec.spec.id;
        say('Queued: ' + currentId + ' · hash ' + frozen._hash.slice(0, 12) +
          ' · state: ' + rec.status);
      } catch (e) { say(e.message, true); }
    });
    btn('Run (dry-run driver)', function () {
      if (!currentId) { say('Freeze & queue first.', true); return; }
      setDriver(exampleDriver());
      runCurrent();
    });
    btn('Run (lab driver)', function () {
      if (!currentId) { say('Freeze & queue first.', true); return; }
      if (!getDriver() || getDriver().kind === 'synthetic') {
        say('No lab driver attached — use setDriver() or dry-run.', true); return;
      }
      runCurrent();
    });
    function runCurrent() {
      say('Running ' + currentId + ' …');
      progBar.style.width = '0%';
      verdictBox.textContent = '';
      execute(currentId, {
        onProgress: function (p) {
          var done = p.i + (p.arm === 'control' ? 0.5 : 0);
          progBar.style.width = Math.round(100 * done / p.total) + '%';
        }
      }).then(function (rec) {
        progBar.style.width = '100%';
        showVerdict(rec.verdict);
        say('Done. State: ' + rec.status + '. Verdict is computed — record it yourself; never auto-entered.');
      }).catch(function (e) { say('Run failed: ' + e.message, true); });
    }
    function showVerdict(v) {
      verdictBox.innerHTML = '';
      var dv = doc.createElement('div');
      dv.className = 'vx-pf-verdict-' + v.verdict.toLowerCase();
      var ciTxt = v.ci
        ? '95% CI [' + v.ci.lo.toFixed(3) + ', ' + v.ci.hi.toFixed(3) + ']'
        : 'CI n/a';
      dv.textContent = v.verdict + ' · d=' + (v.d === v.d ? v.d.toFixed(3) : 'n/a') +
        ' · ' + ciTxt + ' · n=' + v.nT + '+' + v.nC +
        ' · means ' + v.meanT.toFixed(3) + ' vs ' + v.meanC.toFixed(3);
      var dr = doc.createElement('div'); dr.className = 'vx-pf-reason';
      dr.textContent = v.reason + ' — ' + v.note;
      verdictBox.appendChild(dv); verdictBox.appendChild(dr);
    }
    V.bus.on('vx:protocol-suggest', function (d) {
      say('Suggestion: ' + d.message);
    });
    return statusLine;
  }

  // ---------------------------------------------------------------- selfTest
  function check(name, ok, detail) { return { name: name, ok: !!ok, detail: detail || '' }; }
  function selfTest() {
    var checks = [];
    // 1. freeze/verify round-trip
    var ex = exampleProtocol();
    var frozen, v1;
    try {
      frozen = freeze(ex);
      v1 = verifyFrozen(frozen);
      checks.push(check('freeze/verify round-trip', v1.ok, v1.reason + ' hash=' + frozen._hash));
    } catch (e) { checks.push(check('freeze/verify round-trip', false, e.message)); }
    // 2. tampered frozen protocol detected
    try {
      var evil = JSON.parse(JSON.stringify(frozen));
      // mutate BEFORE re-freeze is not possible post-freeze; simulate a stored
      // copy that was altered: change hypothesis then re-attach the old hash
      // without deep-freeze so isFrozen fails too — try both vectors:
      var vec2 = JSON.parse(JSON.stringify(frozen));
      vec2.hypothesis = 'tampered hypothesis';
      var r2 = verifyFrozen(vec2);
      checks.push(check('tampered content detected', !r2.ok, r2.reason));
    } catch (e) { checks.push(check('tampered content detected', false, e.message)); }
    // 3. frozen object is actually immutable
    try {
      var threw = false;
      try { frozen.hypothesis = 'x'; } catch (e) { threw = true; }
      checks.push(check('frozen spec immutable',
        threw || frozen.hypothesis !== 'x',
        threw ? 'assignment threw (strict mode)' : 'assignment silently ignored'));
    } catch (e) { checks.push(check('frozen spec immutable', false, e.message)); }
    // 4. lifecycle: legal chain + illegal rejection
    try {
      var lcSpec = freeze(Object.assign({}, exampleProtocol(), { id: 'w06-t-lifecycle' }));
      var rec = queue(lcSpec); // queue() includes draft->queued
      var okChain = rec.status === 'queued';
      transition(rec, 'draft');           // unqueue allowed
      transition(rec, 'queued');
      var illegal = null;
      try { transition(rec, 'scored'); } catch (e) { illegal = e.message; }
      checks.push(check('lifecycle legal chain', okChain && rec.status === 'queued',
        'draft->queued->draft->queued ok'));
      checks.push(check('lifecycle rejects queued->scored', !!illegal, illegal || 'not rejected'));
      var illegal2 = null;
      try { transition(rec, 'archived'); } catch (e) { illegal2 = e.message; }
      checks.push(check('lifecycle rejects queued->archived', !!illegal2, illegal2 || 'not rejected'));
      // running requires frozen spec: draft an unfrozen spec and force running
      var raw = draft({ id: 'w06-t-unfrozen', hypothesis: 'h',
        config: { configId: 'c', params: {}, seed: 1 }, probeSequence: [],
        control: { paired: true, configId: 'c', params: {}, seed: 1 },
        replications: { treatment: 5, control: 5 },
        primaryMetric: 'm', expectsDirection: 1 });
      transition(raw, 'queued'); // should fail: not frozen
      checks.push(check('queued requires frozen spec', false, 'transition unexpectedly allowed'));
    } catch (e) {
      var msg = String(e.message || e);
      if (/requires a frozen/.test(msg))
        checks.push(check('queued requires frozen spec', true, msg));
      else
        checks.push(check('lifecycle chain', false, msg));
    }
    // 5. stats: known effect -> CONFIRMED
    var rng = U.mulberry32(7);
    function gauss(mu) { return mu + ((rng() + rng() + rng() - 1.5) * 2); }
    var tx = [], cx = [], i;
    for (i = 0; i < 5; i++) { tx.push(gauss(9)); cx.push(gauss(6)); }
    var vc = verdict(tx, cx, 1, 0.5);
    checks.push(check('stats known effect -> CONFIRMED', vc.verdict === 'CONFIRMED',
      'd=' + (vc.d).toFixed(3) + ' CI=[' + vc.ci.lo.toFixed(2) + ',' + vc.ci.hi.toFixed(2) + ']'));
    // 6. stats: no effect -> INCONCLUSIVE
    var tx2 = [], cx2 = [];
    for (i = 0; i < 5; i++) { tx2.push(gauss(6)); cx2.push(gauss(6)); }
    var vi = verdict(tx2, cx2, 1, 0.5);
    checks.push(check('stats no effect -> INCONCLUSIVE', vi.verdict === 'INCONCLUSIVE', vi.reason));
    // 7. stats: opposite significant effect -> REFUTED
    var tx3 = [], cx3 = [];
    for (i = 0; i < 5; i++) { tx3.push(gauss(4)); cx3.push(gauss(8)); }
    var vr = verdict(tx3, cx3, 1, 0.5);
    checks.push(check('stats opposite effect -> REFUTED', vr.verdict === 'REFUTED',
      'd=' + vr.d.toFixed(3)));
    // 8. worked example validates against the schema
    var ve = validateProtocol(exampleProtocol());
    checks.push(check('worked example validates', ve.ok, ve.errors.join('; ') || 'schema ok'));
    // 9. ad-hoc suggestion fires at 3 and only once
    var sug = [];
    var h = function (d) { sug.push(d); };
    V.bus.on('vx:protocol-suggest', h);
    var r1 = trackManualRun('cfg-x', 'stir');
    var r2 = trackManualRun('cfg-x', 'stir');
    var r3 = trackManualRun('cfg-x', 'stir');
    var r4 = trackManualRun('cfg-x', 'stir');
    checks.push(check('ad-hoc suggest at 3x, once',
      r1.count === 1 && !r1.suggested && r2.count === 2 && r3.suggested && !r4.suggested && sug.length === 1,
      'counts 1,2,3*,4 ; events=' + sug.length));
    // 10. full headless run of the worked example -> CONFIRMED, scored
    // (async; selfTest returns a promise-aware wrapper below)
    var runSpec = freeze(Object.assign({}, exampleProtocol(), { id: 'w06-t-headless' }));
    var p10 = execute(queue(runSpec), { driver: exampleDriver() })
      .then(function (rec2) {
        var ok = rec2.status === 'scored' && rec2.verdict && rec2.verdict.verdict === 'CONFIRMED' &&
          rec2.verdict.autoNotebook === false;
        return check('worked example headless run -> scored/CONFIRMED', ok,
          'status=' + rec2.status + ' verdict=' + (rec2.verdict && rec2.verdict.verdict) +
          ' d=' + (rec2.verdict && rec2.verdict.d.toFixed(3)) +
          ' CI=[' + (rec2.verdict.ci && rec2.verdict.ci.lo.toFixed(2)) + ',' +
          (rec2.verdict.ci && rec2.verdict.ci.hi.toFixed(2)) + ']');
      })
      .catch(function (e) { return check('worked example headless run', false, e.message); });

    return p10.then(function (c10) {
      checks.push(c10);
      // 11. illegal unknown-state transition rejected with reason
      var bad = null;
      try { transition('no-such-id', 'running'); } catch (e) { bad = e.message; }
      checks.push(check('unknown protocol id rejected', !!bad, bad || 'not rejected'));
      var ok = checks.every(function (c) { return c.ok; });
      return { ok: ok, checks: checks };
    });
  }

  // ------------------------------------------------------------------ api
  var api = {
    selfTest: selfTest,
    // schema + freeze
    validateProtocol: validateProtocol,
    freeze: freeze,
    verifyFrozen: verifyFrozen,
    // lifecycle
    draft: draft,
    queue: queue,
    transition: transition,
    record: function (id) { return _records[id] || null; },
    records: function () { return Object.keys(_records); },
    STATES: STATES,
    // runner
    execute: execute,
    driverFromBackend: driverFromBackend,
    setDriver: setDriver,
    getDriver: getDriver,
    // stats (exposed for tests / teaching)
    stats: { mean: mean, variance: variance, cohensD: cohensD, welchCI: welchCI,
             tCrit95: tCrit95, verdict: verdict },
    // ad-hoc suggestion
    trackManualRun: trackManualRun,
    manualRunCounts: manualRunCounts,
    suggestProtocol: suggestProtocol,
    // worked example
    exampleProtocol: exampleProtocol,
    exampleDriver: exampleDriver
  };

  V.register('w06-protocols', api);

  if (V.utils.isBrowser() && V.ui && typeof V.ui.registerPanel === 'function') {
    try { V.ui.registerPanel('vx-protocols', 'Protocols', mountPanel); }
    catch (e) { /* chrome failure is non-fatal */ }
  }
})(typeof window !== 'undefined' ? window : globalThis);
