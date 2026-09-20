/* VORTEX substrate.js — W10 substrate plugin API (lane-14 §3.10 / §11).
 *
 * ENGINE CONTRACT (documented here, enforced below):
 *   - Fixed-timestep loop: every domain steps with VORTEX.SIM_DT = 1/60
 *     sim-seconds. Render interpolation may vary; sim never does.
 *   - SoA tracers: domain state holds Float32Array px/py (positions) plus
 *     scratch vx/vy. Iteration order is 0..n-1, always. No unseeded PRNG in
 *     sim code — VORTEX.utils.mulberry32(seed) is the only source.
 *   - Probe event bus: every probe application emits VORTEX.bus 'vx:probe'
 *     with { domain, probe, params, t } (t = sim time in seconds).
 *
 * DOMAIN INTERFACE:
 *   registerDomain({
 *     id:          'fluid-vortex',            // /^[a-z0-9][a-z0-9-]*$/
 *     title:       'Fluid vortex',            // human label
 *     version:     1,                         // optional int
 *     stub:        false,                     // true => stub domain, honest
 *     param_schema:{ circulation:{type:'number',min:0,max:10,default:1.0}, ... },
 *     field_fn:    function (x, y, t, params, out),  // out.vx, out.vy
 *     probe_fn:    function (run, probeEvent),       // mutates run.state
 *     spawn_fn:    function (rand, n, params),       // -> {px, py} Float32Array
 *     score_fn:    function (state, params),         // -> metrics object
 *     hooks:       { onInit(run), onStep(run), onReset(run) } // optional fns
 *   })
 *
 * MIGRATION ORDER (per spec): fluid-vortex through the interface, prove
 * parity, THEN crowd flow. crowd-flow is registered here as a STUB only:
 * param_schema + hooks defined, field_fn/probe_fn throw — no fake sim.
 *
 * Plain script, no modules, no network, no eval. Headless-safe.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('substrate.js: VORTEX namespace missing — vx-namespace.js must load first');
  }

  var DT = V.SIM_DT; // 1/60 fixed

  // ---------------------------------------------------------------------------
  // 1. Domain registry + schema validation
  // ---------------------------------------------------------------------------
  var _domains = {};   // id -> spec
  var _order = [];     // registration order

  var ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  var PARAM_TYPES = ['number', 'int', 'bool', 'enum'];
  var REQUIRED_FNS = ['field_fn', 'probe_fn', 'spawn_fn', 'score_fn'];

  function _isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function validateParamSchema(ps, errors) {
    if (!_isObj(ps)) { errors.push('param_schema: must be an object'); return; }
    Object.keys(ps).forEach(function (name) {
      var p = ps[name], where = 'param_schema.' + name;
      if (!_isObj(p)) { errors.push(where + ': must be an object'); return; }
      if (PARAM_TYPES.indexOf(p.type) === -1) {
        errors.push(where + ': type must be one of ' + PARAM_TYPES.join('|') +
          ', got ' + JSON.stringify(p.type));
      }
      if (p.type === 'enum' && (!Array.isArray(p.enum) || !p.enum.length)) {
        errors.push(where + ': enum type requires non-empty "enum" array');
      }
      if (('min' in p || 'max' in p) && p.type !== 'number' && p.type !== 'int') {
        errors.push(where + ': min/max only valid for number|int types');
      }
      if ('default' in p) {
        if (p.type === 'number' && typeof p.default !== 'number') {
          errors.push(where + ': default must be a number');
        }
        if (p.type === 'int' && !(typeof p.default === 'number' && (p.default | 0) === p.default)) {
          errors.push(where + ': default must be an integer');
        }
        if (p.type === 'bool' && typeof p.default !== 'boolean') {
          errors.push(where + ': default must be a boolean');
        }
        if (p.type === 'enum' && p.enum.indexOf(p.default) === -1) {
          errors.push(where + ': default must be one of the enum values');
        }
      }
    });
  }

  function validateDomainSpec(spec) {
    var errors = [];
    if (!_isObj(spec)) return { ok: false, errors: ['spec: must be an object'] };
    if (typeof spec.id !== 'string' || !ID_RE.test(spec.id)) {
      errors.push('id: required, must match /^[a-z0-9][a-z0-9-]*$/, got ' + JSON.stringify(spec.id));
    }
    if (typeof spec.title !== 'string' || !spec.title.length) {
      errors.push('title: required non-empty string');
    }
    if ('version' in spec && !(typeof spec.version === 'number' && (spec.version | 0) === spec.version)) {
      errors.push('version: must be an integer if present');
    }
    REQUIRED_FNS.forEach(function (fn) {
      if (typeof spec[fn] !== 'function') {
        errors.push(fn + ': required function, got ' + (spec[fn] === undefined ? 'missing' : typeof spec[fn]));
      }
    });
    validateParamSchema(spec.param_schema, errors);
    if (spec.hooks !== undefined) {
      if (!_isObj(spec.hooks)) {
        errors.push('hooks: must be an object if present');
      } else {
        Object.keys(spec.hooks).forEach(function (k) {
          if (spec.hooks[k] !== null && typeof spec.hooks[k] !== 'function') {
            errors.push('hooks.' + k + ': must be a function or null');
          }
        });
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function registerDomain(spec) {
    var v = validateDomainSpec(spec);
    if (!v.ok) {
      var e = new Error('substrate: invalid domain spec "' + (spec && spec.id) +
        '": ' + v.errors.join('; '));
      e.code = 'VX_E_DOMAIN_SCHEMA';
      e.reasons = v.errors;
      throw e;
    }
    if (_domains[spec.id]) {
      throw new Error('substrate: duplicate domain id "' + spec.id + '"');
    }
    _domains[spec.id] = spec;
    _order.push(spec.id);
    V.bus.emit('vx:domain', { id: spec.id, stub: !!spec.stub });
    return spec;
  }

  function getDomain(id) { return _domains[id] || null; }
  function listDomains() {
    return _order.map(function (id) {
      var s = _domains[id];
      return { id: s.id, title: s.title, stub: !!s.stub, version: s.version || 1 };
    });
  }

  function defaultsFor(spec) {
    var out = {}, ps = spec.param_schema || {};
    Object.keys(ps).forEach(function (k) {
      if ('default' in ps[k]) out[k] = ps[k].default;
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // 2. Substrate engine: fixed-timestep loop over a registered domain
  // ---------------------------------------------------------------------------
  function createRun(domainId, opts) {
    opts = opts || {};
    var spec = getDomain(domainId);
    if (!spec) throw new Error('substrate: unknown domain "' + domainId + '"');
    var seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
    var params = {};
    var dflt = defaultsFor(spec);
    Object.keys(dflt).forEach(function (k) { params[k] = dflt[k]; });
    Object.keys(opts.params || {}).forEach(function (k) { params[k] = opts.params[k]; });
    var n = opts.tracers || 256;
    var rand = V.utils.mulberry32(seed);
    var spawned = spec.spawn_fn(rand, n, params);
    if (!spawned || !(spawned.px instanceof Float32Array) || !(spawned.py instanceof Float32Array)) {
      throw new Error('substrate: spawn_fn of "' + domainId +
        '" must return {px, py} Float32Arrays');
    }
    var run = {
      id: V.utils.uid('run'),
      domain: domainId,
      seed: seed,
      params: params,
      stepIndex: 0,
      t: 0,
      state: {
        n: n,
        px: spawned.px,
        py: spawned.py,
        vx: new Float32Array(n),
        vy: new Float32Array(n)
      }
    };
    if (spec.hooks && typeof spec.hooks.onInit === 'function') spec.hooks.onInit(run);
    V.bus.emit('vx:run', { id: run.id, domain: domainId, seed: seed, tracers: n });
    return run;
  }

  function stepRun(run) {
    var spec = getDomain(run.domain);
    var st = run.state, n = st.n, p = run.params;
    var out = { vx: 0, vy: 0 };
    for (var i = 0; i < n; i++) {
      spec.field_fn(st.px[i], st.py[i], run.t, p, out);
      st.vx[i] = out.vx; st.vy[i] = out.vy;
      st.px[i] += out.vx * DT;
      st.py[i] += out.vy * DT;
    }
    run.stepIndex += 1;
    run.t = run.stepIndex * DT;
    if (spec.hooks && typeof spec.hooks.onStep === 'function') spec.hooks.onStep(run);
    return run;
  }

  function applyProbe(run, probe, params) {
    var spec = getDomain(run.domain);
    var ev = { probe: probe, params: params || {}, t: run.t };
    spec.probe_fn(run, ev);
    V.bus.emit('vx:probe', { domain: run.domain, probe: probe, params: ev.params, t: run.t });
    return run;
  }

  function scoreRun(run) {
    var spec = getDomain(run.domain);
    return spec.score_fn(run.state, run.params);
  }

  // ---------------------------------------------------------------------------
  // 3. In-file CPU reference stepper.
  //    Stand-in for w14-cpu implementing the DOCUMENTED CPU interface shape
  //    (CONTRACTS.md §5). Late-binds: if VORTEX.has('w14-cpu'), the fluid
  //    domain uses the real backend instead of this reference.
  // ---------------------------------------------------------------------------
  var CPU_DOC_SHAPE = ['name', 'tier', 'init', 'setParams', 'addProbe',
    'clearProbes', 'step', 'render', 'snapshotState', 'restoreState',
    'sampleMetrics', 'getTracers', 'dispose'];

  function cpuBackendPresent() { return V.has('w14-cpu'); }

  // Single shared field math: Rankine-style vortex core + 3 sinusoidal
  // turbulence modes with turbulence damped by persistence over time.
  // Deterministic: no PRNG state inside the field, identical for any caller.
  function vortexField(x, y, t, p, out) {
    var r2 = x * x + y * y;
    var sig2 = p.coreRadius * p.coreRadius;
    var gamma = p.circulation * (1 - Math.exp(-r2 / sig2)); // avoid singularity
    var inv = 1 / (r2 + 1e-12);
    var vx = -gamma * y * inv;
    var vy = gamma * x * inv;
    if (p.turbulence > 0) {
      var amp = p.turbulence * Math.pow(p.persistence, t * 60);
      vx += amp * (Math.sin(3 * y + 1.7) + 0.5 * Math.sin(7 * x - 0.4));
      vy += amp * (Math.cos(2 * x - 2.1) + 0.5 * Math.cos(5 * y + 0.9));
    }
    out.vx = vx; out.vy = vy;
    return out;
  }

  // Raw path: monolithic reference stepper (direct SoA arrays, direct field).
  function referenceRun(seed, n, params, steps) {
    var rand = V.utils.mulberry32(seed >>> 0);
    var px = new Float32Array(n), py = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = rand() * Math.PI * 2, r = Math.sqrt(rand());
      px[i] = r * Math.cos(a); py[i] = r * Math.sin(a);
    }
    var out = { vx: 0, vy: 0 };
    var series = [];
    for (var s = 0; s < steps; s++) {
      var t = s * DT;
      for (var j = 0; j < n; j++) {
        vortexField(px[j], py[j], t, params, out);
        px[j] += out.vx * DT;
        py[j] += out.vy * DT;
      }
      series.push(referenceMetrics(px, py, (s + 1) * DT, params));
    }
    return series;
  }

  function referenceMetrics(px, py, t, params) {
    var n = px.length, out = { vx: 0, vy: 0 };
    var ke = 0, ens = 0, rr = 0, rr2 = 0;
    var h = 1e-4;
    for (var i = 0; i < n; i++) {
      var x = px[i], y = py[i];
      vortexField(x, y, t, params, out);
      ke += 0.5 * (out.vx * out.vx + out.vy * out.vy);
      // enstrophy proxy: |curl| via finite differences
      var a = { vx: 0, vy: 0 }, b = { vx: 0, vy: 0 },
          c = { vx: 0, vy: 0 }, d = { vx: 0, vy: 0 };
      vortexField(x + h, y, t, params, a); vortexField(x - h, y, t, params, b);
      vortexField(x, y + h, t, params, c); vortexField(x, y - h, t, params, d);
      var curl = (a.vy - b.vy) / (2 * h) - (c.vx - d.vx) / (2 * h);
      ens += curl * curl;
      var rad = Math.sqrt(x * x + y * y);
      rr += rad; rr2 += rad * rad;
    }
    var mean = rr / n;
    return {
      ke: ke / n,
      enstrophy: ens / n,
      dispersion: Math.sqrt(Math.max(0, rr2 / n - mean * mean)),
      t: t
    };
  }

  // ---------------------------------------------------------------------------
  // 4. fluid-vortex domain expressed through the plugin interface
  // ---------------------------------------------------------------------------
  var FLUID_PARAMS = {
    circulation: { type: 'number', min: 0, max: 10, default: 1.0 },
    turbulence: { type: 'number', min: 0, max: 1, default: 0.0 },
    persistence: { type: 'number', min: 0, max: 1, default: 0.995 },
    coreRadius: { type: 'number', min: 0.05, max: 1, default: 0.25 }
  };

  var fluidVortexDomain = {
    id: 'fluid-vortex',
    title: 'Fluid vortex (CPU reference)',
    version: 1,
    stub: false,
    param_schema: FLUID_PARAMS,
    field_fn: function (x, y, t, params, out) {
      if (cpuBackendPresent()) {
        // Real backend owns the field once w14-cpu registers; the domain
        // forwards to its documented interface shape. Until then the
        // in-file reference field is used (see §3).
        var b = V.get('w14-cpu');
        if (b && typeof b.sampleField === 'function') return b.sampleField(x, y, t, params, out);
      }
      return vortexField(x, y, t, params, out);
    },
    probe_fn: function (run, probeEvent) {
      if (probeEvent.probe !== 'stir') {
        throw new Error('fluid-vortex: unknown probe "' + probeEvent.probe + '"');
      }
      var pr = probeEvent.params;
      var cx = pr.x || 0, cy = pr.y || 0, r = pr.r || 0.3, s = pr.strength || 0.5;
      var st = run.state;
      for (var i = 0; i < st.n; i++) {
        var dx = st.px[i] - cx, dy = st.py[i] - cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < r && d > 1e-9) {
          var fall = 1 - d / r;
          st.px[i] += (-dy / d) * s * fall * DT;
          st.py[i] += (dx / d) * s * fall * DT;
        }
      }
    },
    spawn_fn: function (rand, n, params) {
      var px = new Float32Array(n), py = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var a = rand() * Math.PI * 2, r = Math.sqrt(rand());
        px[i] = r * Math.cos(a); py[i] = r * Math.sin(a);
      }
      return { px: px, py: py };
    },
    score_fn: function (state, params) {
      return referenceMetrics(state.px, state.py, 0, params);
    },
    hooks: { onInit: null, onStep: null, onReset: null }
  };

  // ---------------------------------------------------------------------------
  // 5. crowd-flow STUB domain — param_schema + hooks defined, math NOT
  //    implemented. field_fn / probe_fn throw the documented stub error.
  // ---------------------------------------------------------------------------
  function crowdStubError(which) {
    return new Error('crowd-flow: ' + which + ' not implemented — stub domain ' +
      '(generalization order: fluid parity first, per lane-14 §3.10)');
  }

  var crowdFlowStub = {
    id: 'crowd-flow',
    title: 'Crowd flow (STUB — not implemented)',
    version: 1,
    stub: true,
    param_schema: {
      density: { type: 'number', min: 0, max: 1, default: 0.3 },
      desiredSpeed: { type: 'number', min: 0, max: 3, default: 1.2 },
      panic: { type: 'number', min: 0, max: 1, default: 0.0 },
      exitWidth: { type: 'number', min: 0.1, max: 2, default: 0.6 },
      laneDiscipline: { type: 'enum', enum: ['free', 'right-hand', 'guided'], default: 'right-hand' }
    },
    field_fn: function () { throw crowdStubError('field_fn'); },
    probe_fn: function () { throw crowdStubError('probe_fn'); },
    spawn_fn: function () { throw crowdStubError('spawn_fn'); },
    score_fn: function () { throw crowdStubError('score_fn'); },
    hooks: {
      onInit: function () { throw crowdStubError('hooks.onInit'); },
      onStep: function () { throw crowdStubError('hooks.onStep'); },
      onReset: function () { throw crowdStubError('hooks.onReset'); }
    }
  };

  // ---------------------------------------------------------------------------
  // 6. Parity proof: raw CPU path vs domain-interface path, same seed.
  // ---------------------------------------------------------------------------
  function runParityCheck(opts) {
    opts = opts || {};
    var seed = (opts.seed === undefined ? 1337 : opts.seed) >>> 0;
    var n = opts.tracers || 256;
    var steps = opts.steps || 50;
    var params = {
      circulation: 1.0, turbulence: 0.15, persistence: 0.995, coreRadius: 0.25
    };
    Object.keys(opts.params || {}).forEach(function (k) { params[k] = opts.params[k]; });

    // Path A: raw reference stepper (monolithic, direct SoA).
    var seriesA = referenceRun(seed, n, params, steps);
    var hashA = V.utils.hash53(V.utils.stableStringify(seriesA));

    // Path B: same seed/params through the substrate domain interface.
    var seriesB = [];
    var run = createRun('fluid-vortex', { seed: seed, tracers: n, params: params });
    for (var s = 0; s < steps; s++) {
      stepRun(run);
      seriesB.push(run.domain === 'fluid-vortex' ?
        referenceMetrics(run.state.px, run.state.py, run.t, run.params) : null);
    }
    var hashB = V.utils.hash53(V.utils.stableStringify(seriesB));

    var mode = cpuBackendPresent()
      ? 'cpu-backend-parity'
      : 'interface-self-consistency';
    return {
      parity: hashA === hashB,
      hashA: hashA,
      hashB: hashB,
      mode: mode,
      steps: steps,
      seed: seed,
      tracers: n,
      note: cpuBackendPresent()
        ? 'fluid-vortex domain vs w14-cpu backend, same seed'
        : 'w14-cpu absent: fluid-vortex domain interface vs in-file reference ' +
          'stepper, same seed — proves the interface introduces no divergence, ' +
          'not backend equivalence. Re-run when w14-cpu registers for ' +
          'cpu-backend-parity mode.'
    };
  }

  // ---------------------------------------------------------------------------
  // 7. Module API
  // ---------------------------------------------------------------------------
  var api = {
    registerDomain: registerDomain,
    getDomain: getDomain,
    listDomains: listDomains,
    validateDomainSpec: validateDomainSpec,
    createRun: createRun,
    stepRun: stepRun,
    applyProbe: applyProbe,
    scoreRun: scoreRun,
    runParityCheck: runParityCheck,
    cpuDocShape: CPU_DOC_SHAPE.slice(),
    cpuBackendPresent: cpuBackendPresent,
    selfTest: function () {
      var checks = [];
      function check(name, fn) {
        try {
          var r = fn();
          checks.push({ name: name, ok: !!r.ok, detail: r.detail || '' });
        } catch (e) {
          checks.push({ name: name, ok: false, detail: 'threw: ' + e.message });
        }
      }

      check('registry: accepts a valid domain spec', function () {
        var v = validateDomainSpec(fluidVortexDomain);
        return { ok: v.ok, detail: v.ok ? 'fluid-vortex valid' : v.errors.join('; ') };
      });

      check('registry: rejects bad schemas with reasons', function () {
        var cases = [
          [{}, /id/],
          [{ id: 'BAD ID', title: 'x', param_schema: {}, field_fn: 1, probe_fn: 1, spawn_fn: 1, score_fn: 1 }, /field_fn/],
          [{ id: 'ok-id', title: '', param_schema: {}, field_fn: function () {}, probe_fn: function () {}, spawn_fn: function () {}, score_fn: function () {} }, /title/],
          [{ id: 'ok-id', title: 't', param_schema: { p: { type: 'number', default: 'nope' } }, field_fn: function () {}, probe_fn: function () {}, spawn_fn: function () {}, score_fn: function () {} }, /param_schema\.p/],
          [{ id: 'ok-id', title: 't', param_schema: {}, hooks: { onStep: 'x' }, field_fn: function () {}, probe_fn: function () {}, spawn_fn: function () {}, score_fn: function () {} }, /hooks/]
        ];
        var bad = [];
        cases.forEach(function (c, i) {
          var v = validateDomainSpec(c[0]);
          if (v.ok || !c[1].test(v.errors.join(' '))) bad.push('case ' + i);
        });
        return { ok: bad.length === 0, detail: bad.length ? 'failed: ' + bad.join(', ') : '5 bad specs rejected with reasons' };
      });

      check('registry: rejects duplicate domain id', function () {
        var threw = false;
        try {
          registerDomain({
            id: 'fluid-vortex', title: 'dup', param_schema: {},
            field_fn: function () {}, probe_fn: function () {},
            spawn_fn: function () {}, score_fn: function () {}
          });
        } catch (e) { threw = /duplicate/.test(e.message); }
        return { ok: threw, detail: threw ? 'duplicate refused' : 'duplicate NOT refused' };
      });

      check('fluid domain: parity check passes headless', function () {
        var r = runParityCheck({ steps: 50, seed: 1337, tracers: 256 });
        return {
          ok: r.parity === true,
          detail: 'mode=' + r.mode + ' hashA=' + r.hashA + ' hashB=' + r.hashB
        };
      });

      check('fluid domain: parity label is honest about backend', function () {
        var r = runParityCheck({ steps: 10 });
        var want = cpuBackendPresent() ? 'cpu-backend-parity' : 'interface-self-consistency';
        return { ok: r.mode === want, detail: 'mode=' + r.mode };
      });

      check('crowd stub: field_fn throws documented stub error', function () {
        var threw = false, msg = '';
        try { getDomain('crowd-flow').field_fn(0, 0, 0, {}, {}); }
        catch (e) { threw = true; msg = e.message; }
        return { ok: threw && /not implemented — stub/.test(msg), detail: msg };
      });

      check('crowd stub: probe_fn throws documented stub error', function () {
        var threw = false, msg = '';
        try { getDomain('crowd-flow').probe_fn({}, {}); }
        catch (e) { threw = true; msg = e.message; }
        return { ok: threw && /not implemented — stub/.test(msg), detail: msg };
      });

      check('engine: fixed timestep SoA step advances tracers deterministically', function () {
        var r1 = createRun('fluid-vortex', { seed: 42, tracers: 64 });
        var r2 = createRun('fluid-vortex', { seed: 42, tracers: 64 });
        for (var s = 0; s < 5; s++) { stepRun(r1); stepRun(r2); }
        var same = true;
        for (var i = 0; i < 64; i++) {
          if (r1.state.px[i] !== r2.state.px[i] || r1.state.py[i] !== r2.state.py[i]) { same = false; break; }
        }
        return {
          ok: same && r1.t === 5 * DT,
          detail: 'same-seed runs bit-identical, t=' + r1.t.toFixed(6) + ' (dt=1/60)'
        };
      });

      check('engine: probe_fn emits vx:probe bus event', function () {
        var seen = null;
        V.bus.on('vx:probe', function (d) { seen = d; });
        var r = createRun('fluid-vortex', { seed: 7, tracers: 32 });
        applyProbe(r, 'stir', { x: 0.1, y: -0.2, r: 0.4, strength: 0.8 });
        return {
          ok: !!seen && seen.domain === 'fluid-vortex' && seen.probe === 'stir',
          detail: seen ? 'event domain=' + seen.domain + ' probe=' + seen.probe : 'no event'
        };
      });

      check('panel: Substrate registered without touching DOM at load', function () {
        var ps = V.ui.panels();
        var found = ps.some(function (p) { return p.id === 'w10-substrate'; });
        return { ok: found, detail: found ? 'panel registered (mount deferred)' : 'missing' };
      });

      var ok = checks.every(function (c) { return c.ok; });
      return { ok: ok, checks: checks };
    }
  };

  // Register built-in domains BEFORE module registration so they exist on load.
  registerDomain(fluidVortexDomain);
  registerDomain(crowdFlowStub);

  // ---------------------------------------------------------------------------
  // 8. Substrate panel — domain list, parity button + result, stub labels.
  //    mountFn only runs when the dock mounts it; DOM guarded for headless.
  // ---------------------------------------------------------------------------
  V.ui.registerPanel('w10-substrate', 'Substrate', function (el) {
    if (!V.utils.isBrowser()) return;
    var doc = root.document;

    var h = doc.createElement('h3');
    h.textContent = 'Substrate — domain plugins';
    el.appendChild(h);

    var p = doc.createElement('p');
    p.className = 'vx-note';
    p.textContent = 'Engine contract: fixed-timestep loop (dt=1/60) + SoA tracers + ' +
      'probe event bus. Generalization order: fluid parity first — crowd-flow ' +
      'is a stub by design (lane-14 §3.10).';
    el.appendChild(p);

    var list = doc.createElement('ul');
    list.className = 'vx-domain-list';
    listDomains().forEach(function (d) {
      var li = doc.createElement('li');
      li.textContent = d.id + ' — ' + d.title;
      if (d.stub) {
        var b = doc.createElement('span');
        b.className = 'vx-stub-badge';
        b.textContent = ' STUB — not implemented';
        li.appendChild(b);
      }
      list.appendChild(li);
    });
    el.appendChild(list);

    var btn = doc.createElement('button');
    btn.textContent = 'Run parity check (50 steps)';
    var res = doc.createElement('div');
    res.className = 'vx-parity-result';
    btn.onclick = function () {
      btn.disabled = true;
      res.textContent = 'running…';
      try {
        var r = runParityCheck({ steps: 50 });
        res.textContent = (r.parity ? 'PARITY ✓' : 'PARITY ✗') +
          ' · mode=' + r.mode +
          ' · hashA=' + r.hashA + ' hashB=' + r.hashB;
        var note = doc.createElement('div');
        note.className = 'vx-note';
        note.textContent = r.note;
        res.appendChild(note);
        V.ui.announce('Substrate parity: ' + (r.parity ? 'identical' : 'DIVERGED') +
          ' (' + r.mode + ')');
      } catch (e) {
        res.textContent = 'error: ' + e.message;
      }
      btn.disabled = false;
    };
    el.appendChild(btn);
    el.appendChild(res);
  });

  V.register('w10-substrate', api);

})(typeof window !== 'undefined' ? window : globalThis);
