/* VORTEX cpu-field.js — W14 CPU reference backend (tier C).
 *
 * The determinism anchor for the whole lab: SoA typed arrays, analytic
 * axial-vortex field, seeded noise only, fixed dt, sorted (index-order)
 * iteration, zero allocation in step(). GPU backends prove parity against
 * THIS module (endpoint displacement < 0.5% of domain diagonal).
 *
 * Worker-ready: step() touches no DOM; state lives in transferable
 * Float32Arrays. A worker host can postMessage the buffers with a
 * transfer list and rebuild the backend around them.
 *
 * Plain script, IIFE, no modules, no network, no Math.random anywhere.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || !V.utils || typeof V.register !== 'function') {
    throw new Error('w14-cpu: VORTEX namespace (vx-namespace.js) must load first');
  }

  var SIM_DT = V.SIM_DT;                 // fixed sim dt, 1/60 sim-seconds
  var NOISE_G = 48;                      // seeded value-noise lattice, periodic
  var MIX_GRID = 32;                     // occupancy grid for the mixing metric

  var DEFAULTS = {
    tracers: 4000,
    seed: 1337,
    circulation: 1.0,                    // 0..3
    turbulence: 0.35,                    // 0..1
    persistence: 0.6,                    // 0..0.99 — velocity memory blend
    drift: 0.05,                         // 0..0.5 — weak background advection
    soft: 0.18,                          // vortex core radius
    noiseFreq: 3.0,                      // base spatial frequency of octaves
    noiseRot: 0.05,                      // rad/sim-second rotation of noise coords
    vmax: 2.0,                           // vortex velocity scale
    tamp: 1.2,                           // turbulence velocity scale
    cflMax: 4.0                          // hard speed clamp (CFL-ish)
  };

  // ---- state (module-closure; one backend instance) ----
  var _tracers = 0, _seed = 0, _stepCount = 0;
  var _inited = false, _disposed = false;
  var _x = null, _y = null, _vx = null, _vy = null;   // SoA live state
  var _sx = null;                                     // per-tracer seed channel
  var _x0 = null, _y0 = null;                         // initial positions (dispersion)
  var _g1 = null, _g2 = null;                         // seeded noise lattices
  var _probes = [];                                   // [{x,y,strength,radius,kind}]
  var _params = null;
  var _canvas = null, _ctx = null, _img = null;       // render side only
  var _lastStepMs = 0, _lastRenderMs = 0;

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  function clampNum(v, lo, hi, fb) {
    v = Number(v);
    if (!isFinite(v)) return fb;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // ---- seeded value noise (periodic lattice, bilinear) ----
  // All lattice values fixed at init from mulberry32(seed); sampling is a
  // pure function of (x, y, stepCount). No PRNG calls in the hot path.
  function noise2(g, u, v) {
    var G = NOISE_G;
    u = u % G; if (u < 0) u += G;
    v = v % G; if (v < 0) v += G;
    var x0 = u | 0, y0 = v | 0;
    var fx = u - x0, fy = v - y0;
    var x1 = x0 + 1 >= G ? 0 : x0 + 1;
    var y1 = y0 + 1 >= G ? 0 : y0 + 1;
    var a = g[y0 * G + x0], b = g[y0 * G + x1];
    var c = g[y1 * G + x0], d = g[y1 * G + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  function buildNoise(seed) {
    var rng = V.utils.mulberry32((seed ^ 0x9e3779b9) >>> 0);
    var n = NOISE_G * NOISE_G;
    _g1 = new Float32Array(n);
    _g2 = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      _g1[i] = rng() * 2 - 1;
      _g2[i] = rng() * 2 - 1;
    }
  }

  function seedTracers(seed) {
    var rng = V.utils.mulberry32(seed >>> 0);
    for (var i = 0; i < _tracers; i++) {
      var px = rng() * 2 - 1, py = rng() * 2 - 1;
      _x[i] = px; _y[i] = py;
      _x0[i] = px; _y0[i] = py;
      _vx[i] = 0; _vy[i] = 0;
      _sx[i] = rng();               // per-tracer seed channel (coloring, splits)
    }
  }

  // ---- contract: init ----
  function init(canvas, opts) {
    return new Promise(function (resolve, reject) {
      try {
        dispose(); // re-init safe: tear down previous instance first
        opts = opts || {};
        var cfg = opts.config || {};
        _tracers = Math.max(1, (opts.tracers | 0) || DEFAULTS.tracers);
        _seed = (opts.seed == null ? DEFAULTS.seed : opts.seed) >>> 0;
        _params = {
          circulation: clampNum(cfg.circulation, 0, 3, DEFAULTS.circulation),
          turbulence: clampNum(cfg.turbulence, 0, 1, DEFAULTS.turbulence),
          persistence: clampNum(cfg.persistence, 0, 0.99, DEFAULTS.persistence),
          drift: clampNum(cfg.drift, 0, 0.5, DEFAULTS.drift),
          soft: clampNum(cfg.soft, 0.02, 1, DEFAULTS.soft),
          noiseFreq: clampNum(cfg.noiseFreq, 0.5, 12, DEFAULTS.noiseFreq),
          noiseRot: clampNum(cfg.noiseRot, -2, 2, DEFAULTS.noiseRot),
          vmax: clampNum(cfg.vmax, 0, 8, DEFAULTS.vmax),
          tamp: clampNum(cfg.tamp, 0, 4, DEFAULTS.tamp),
          cflMax: clampNum(cfg.cflMax, 0.5, 20, DEFAULTS.cflMax)
        };
        var n = _tracers;
        _x = new Float32Array(n); _y = new Float32Array(n);
        _vx = new Float32Array(n); _vy = new Float32Array(n);
        _sx = new Float32Array(n);
        _x0 = new Float32Array(n); _y0 = new Float32Array(n);
        buildNoise(_seed);
        seedTracers(_seed);
        _probes = [];
        _stepCount = 0;
        _lastStepMs = 0; _lastRenderMs = 0;
        _canvas = canvas || null;
        _ctx = null; _img = null;
        if (_canvas && typeof _canvas.getContext === 'function') {
          try { _ctx = _canvas.getContext('2d'); } catch (e) { _ctx = null; }
        }
        _disposed = false;
        _inited = true;
        V.bus.emit('vx:ready', { backend: 'cpu', tracers: n });
        resolve(api);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---- contract: setParams (uniform-like; never reallocates) ----
  function setParams(p) {
    if (!_inited || !p || typeof p !== 'object') return;
    var P = _params;
    if (p.circulation !== undefined) P.circulation = clampNum(p.circulation, 0, 3, P.circulation);
    if (p.turbulence !== undefined) P.turbulence = clampNum(p.turbulence, 0, 1, P.turbulence);
    if (p.persistence !== undefined) P.persistence = clampNum(p.persistence, 0, 0.99, P.persistence);
    if (p.drift !== undefined) P.drift = clampNum(p.drift, 0, 0.5, P.drift);
    if (p.soft !== undefined) P.soft = clampNum(p.soft, 0.02, 1, P.soft);
    if (p.noiseFreq !== undefined) P.noiseFreq = clampNum(p.noiseFreq, 0.5, 12, P.noiseFreq);
    if (p.noiseRot !== undefined) P.noiseRot = clampNum(p.noiseRot, -2, 2, P.noiseRot);
    if (p.vmax !== undefined) P.vmax = clampNum(p.vmax, 0, 8, P.vmax);
    if (p.tamp !== undefined) P.tamp = clampNum(p.tamp, 0, 4, P.tamp);
    if (p.cflMax !== undefined) P.cflMax = clampNum(p.cflMax, 0.5, 20, P.cflMax);
    // unknown keys ignored; seed is immutable here (reseed = new init = new manifest)
  }

  function getParams() {
    var o = {}, k;
    if (!_params) return o;
    for (k in _params) { if (Object.prototype.hasOwnProperty.call(_params, k)) o[k] = _params[k]; }
    return o;
  }

  // ---- contract: probes ----
  function addProbe(probe) {
    if (!probe || typeof probe !== 'object') return null;
    var kind = probe.kind === 'push' ? 'push' : 'swirl';
    var p = {
      x: clampNum(probe.x, -2, 2, 0),
      y: clampNum(probe.y, -2, 2, 0),
      strength: clampNum(probe.strength, -8, 8, 0),
      radius: clampNum(probe.radius, 0.02, 2, 0.25),
      kind: kind
    };
    _probes.push(p); // allocation here is fine: NOT in the step() hot path
    V.bus.emit('vx:probe', { probe: { x: p.x, y: p.y, strength: p.strength, radius: p.radius, kind: p.kind }, params: getParams() });
    return p;
  }

  function clearProbes() {
    _probes.length = 0;
  }

  function getProbes() {
    return _probes.map(function (p) {
      return { x: p.x, y: p.y, strength: p.strength, radius: p.radius, kind: p.kind };
    });
  }

  // ---- contract: step — ONE fixed-dt step. Zero allocation by design. ----
  function step() {
    if (!_inited || _disposed) return false;
    var t0 = nowMs();
    var n = _tracers, dt = SIM_DT, P = _params;
    var x = _x, y = _y, vx = _vx, vy = _vy;
    var circ = P.circulation, turb = P.turbulence, pers = P.persistence;
    var drift = P.drift, soft = P.soft;
    var s2 = soft * soft;
    var k = circ * P.vmax;
    var ta = turb * P.tamp;
    var mx = P.cflMax;
    var oneMinusP = 1 - pers;
    var theta = _stepCount * dt * P.noiseRot;
    var ca = Math.cos(theta), sa = Math.sin(theta);
    var fq = P.noiseFreq * 0.5 * (NOISE_G - 1);
    var g1 = _g1, g2 = _g2;
    var probes = _probes, np = probes.length;
    var dx = drift * 0.7, dy = drift * 0.3;

    for (var i = 0; i < n; i++) {
      var px = x[i], py = y[i];
      var r2 = px * px + py * py;
      var den = r2 + s2;

      // axial vortex: v = k * (-y, x) / (r^2 + soft^2)
      var wvx = -py * k / den + dx;
      var wvy = px * k / den + dy;

      // turbulence: two seeded noise octaves, coords rotated deterministically
      if (ta > 0) {
        var rx = px * ca - py * sa, ry = px * sa + py * ca;
        var u1 = (rx + 1) * fq, v1 = (ry + 1) * fq;
        var u2 = u1 * 2.03 + 7.7, v2 = v1 * 2.03 + 3.1;
        var n1 = noise2(g1, u1, v1) + 0.5 * noise2(g1, u2, v2);
        var n2 = noise2(g2, u1, v1) + 0.5 * noise2(g2, u2, v2);
        wvx += ta * n1 * 0.6667;
        wvy += ta * n2 * 0.6667;
      }

      // probes perturb the sampled velocity
      for (var q = 0; q < np; q++) {
        var pr = probes[q];
        var ox = px - pr.x, oy = py - pr.y;
        var od2 = ox * ox + oy * oy;
        var rad = pr.radius;
        if (od2 < rad * rad * 4) {
          var s = pr.strength * Math.exp(-od2 / (rad * rad)) / (od2 + 0.02);
          if (pr.kind === 'push') { wvx += ox * s; wvy += oy * s; }
          else { wvx += -oy * s; wvy += ox * s; }
        }
      }

      // persistence: exponential velocity memory
      var nvx = pers * vx[i] + oneMinusP * wvx;
      var nvy = pers * vy[i] + oneMinusP * wvy;

      // CFL-style hard clamp
      var sp = Math.sqrt(nvx * nvx + nvy * nvy);
      if (sp > mx) { var f = mx / sp; nvx *= f; nvy *= f; }
      vx[i] = nvx; vy[i] = nvy;

      // advect + periodic wrap on [-1, 1]
      var nxp = px + nvx * dt, nyp = py + nvy * dt;
      if (nxp > 1) nxp -= 2; else if (nxp < -1) nxp += 2;
      if (nyp > 1) nyp -= 2; else if (nyp < -1) nyp += 2;
      x[i] = nxp; y[i] = nyp;
    }

    _stepCount++;
    _lastStepMs = nowMs() - t0;
    return true;
  }

  // ---- render: canvas 2D splat via reusable ImageData; headless = no-op ----
  var LUT = null; // 256-entry teal->purple ramp, built lazily (not in step path)
  function buildLUT() {
    LUT = new Uint8Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      // teal (45, 212, 191) -> purple (168, 85, 247)
      LUT[i * 3] = Math.round(45 + (168 - 45) * t);
      LUT[i * 3 + 1] = Math.round(212 + (85 - 212) * t);
      LUT[i * 3 + 2] = Math.round(191 + (247 - 191) * t);
    }
  }

  function render() {
    if (!_inited || _disposed) return { rendered: false, note: 'not initialized' };
    if (!_canvas || !_ctx) return { rendered: false, note: 'headless: no canvas' };
    var t0 = nowMs();
    try {
      var W = _canvas.width | 0, H = _canvas.height | 0;
      if (W <= 0 || H <= 0) return { rendered: false, note: 'canvas has no size' };
      if (!_img || _img.width !== W || _img.height !== H) {
        _img = _ctx.createImageData(W, H); // realloc only on resize, never per tracer
      }
      if (!LUT) buildLUT();
      var data = _img.data;
      // clear (allocation-free: fill on existing buffer)
      for (var z = 0, zn = data.length; z < zn; z += 4) {
        data[z] = 5; data[z + 1] = 7; data[z + 2] = 15; data[z + 3] = 255;
      }
      var n = _tracers, x = _x, y = _y, vx = _vx, vy = _vy;
      for (var i = 0; i < n; i++) {
        var cxx = (((x[i] + 1) * 0.5 * W) | 0);
        var cyy = (((y[i] + 1) * 0.5 * H) | 0);
        if (cxx < 0 || cxx >= W || cyy < 0 || cyy >= H) continue;
        var sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        var li = sp > 3 ? 255 : ((sp / 3) * 255) | 0;
        var o = (cyy * W + cxx) * 4;
        var r = data[o] + LUT[li * 3], g = data[o + 1] + LUT[li * 3 + 1], b = data[o + 2] + LUT[li * 3 + 2];
        data[o] = r > 255 ? 255 : r;
        data[o + 1] = g > 255 ? 255 : g;
        data[o + 2] = b > 255 ? 255 : b;
      }
      _ctx.putImageData(_img, 0, 0);
      _lastRenderMs = nowMs() - t0;
      return { rendered: true, tracers: n, stepMs: _lastStepMs, renderMs: _lastRenderMs };
    } catch (e) {
      return { rendered: false, note: 'render failed: ' + e.message };
    }
  }

  // ---- metrics: deterministic single pass, sorted order ----
  function sampleMetrics() {
    if (!_inited) return { ke: 0, enstrophy: 0, mixing: 0, dispersion: 0, stepCount: _stepCount };
    var n = _tracers, P = _params;
    var ke = 0, ens = 0, disp = 0;
    var k = P.circulation * P.vmax, s2 = P.soft * P.soft;
    var w2 = 2 * k * s2; // analytic vorticity: w = 2*k*soft^2 / (r^2+soft^2)^2
    var occ = new Uint8Array(MIX_GRID * MIX_GRID); // alloc here is fine: not step()
    var x = _x, y = _y, vx = _vx, vy = _vy, x0 = _x0, y0 = _y0;
    for (var i = 0; i < n; i++) {
      var vxi = vx[i], vyi = vy[i];
      ke += 0.5 * (vxi * vxi + vyi * vyi);
      var r2 = x[i] * x[i] + y[i] * y[i];
      var den = r2 + s2, w = w2 / (den * den);
      ens += w * w;
      var ddx = x[i] - x0[i], ddy = y[i] - y0[i];
      disp += ddx * ddx + ddy * ddy;
      var cx = ((x[i] + 1) * 0.5 * MIX_GRID) | 0;
      var cy = ((y[i] + 1) * 0.5 * MIX_GRID) | 0;
      if (cx < 0) cx = 0; else if (cx >= MIX_GRID) cx = MIX_GRID - 1;
      if (cy < 0) cy = 0; else if (cy >= MIX_GRID) cy = MIX_GRID - 1;
      occ[cy * MIX_GRID + cx] = 1;
    }
    var filled = 0;
    for (var c = 0; c < occ.length; c++) filled += occ[c];
    return {
      ke: ke / n,
      enstrophy: ens / n,
      mixing: filled / (MIX_GRID * MIX_GRID),
      dispersion: disp / n,
      stepCount: _stepCount
    };
  }

  function metricHash() {
    return V.utils.hash53(V.utils.stableStringify(sampleMetrics()));
  }

  // ---- contract: getTracers ----
  function getTracers() {
    return { count: _tracers, simulated: _inited && _stepCount > 0 };
  }

  // ---- contract: snapshot / restore (structured-cloneable) ----
  function snapshotState() {
    if (!_inited) return null;
    return {
      module: 'w14-cpu',
      codeVersion: V.codeVersion,
      seed: _seed,
      stepCount: _stepCount,
      tracers: _tracers,
      params: getParams(),
      probes: getProbes(),
      arrays: {
        x: Array.from(_x), y: Array.from(_y),
        vx: Array.from(_vx), vy: Array.from(_vy),
        sx: Array.from(_sx),
        x0: Array.from(_x0), y0: Array.from(_y0)
      }
    };
  }

  function restoreState(s) {
    if (!s || s.module !== 'w14-cpu' || !s.arrays) return false;
    var n = s.arrays.x.length | 0;
    if (n <= 0) return false;
    _tracers = n;
    _x = new Float32Array(s.arrays.x); _y = new Float32Array(s.arrays.y);
    _vx = new Float32Array(s.arrays.vx); _vy = new Float32Array(s.arrays.vy);
    _sx = new Float32Array(s.arrays.sx || new Array(n).fill(0));
    _x0 = new Float32Array(s.arrays.x0 || s.arrays.x);
    _y0 = new Float32Array(s.arrays.y0 || s.arrays.y);
    _seed = (s.seed >>> 0) || 0;
    _stepCount = s.stepCount | 0;
    _params = {};
    var d = DEFAULTS, sp = s.params || {};
    _params.circulation = clampNum(sp.circulation, 0, 3, d.circulation);
    _params.turbulence = clampNum(sp.turbulence, 0, 1, d.turbulence);
    _params.persistence = clampNum(sp.persistence, 0, 0.99, d.persistence);
    _params.drift = clampNum(sp.drift, 0, 0.5, d.drift);
    _params.soft = clampNum(sp.soft, 0.02, 1, d.soft);
    _params.noiseFreq = clampNum(sp.noiseFreq, 0.5, 12, d.noiseFreq);
    _params.noiseRot = clampNum(sp.noiseRot, -2, 2, d.noiseRot);
    _params.vmax = clampNum(sp.vmax, 0, 8, d.vmax);
    _params.tamp = clampNum(sp.tamp, 0, 4, d.tamp);
    _params.cflMax = clampNum(sp.cflMax, 0.5, 20, d.cflMax);
    buildNoise(_seed); // noise is a pure function of seed: rebuild, no storage needed
    _probes = (s.probes || []).map(function (p) {
      return {
        x: clampNum(p.x, -2, 2, 0), y: clampNum(p.y, -2, 2, 0),
        strength: clampNum(p.strength, -8, 8, 0),
        radius: clampNum(p.radius, 0.02, 2, 0.25),
        kind: p.kind === 'push' ? 'push' : 'swirl'
      };
    });
    _disposed = false;
    _inited = true;
    _img = null; // render buffer rebuilt on next render if canvas present
    return true;
  }

  function dispose() {
    /* NOTE (audit 2026-09-20): init() calls dispose() for re-init safety, so a
     * fresh boot used to narrate a phantom "Degraded: cpu to none" in the
     * footer. Only emit when a live backend was actually torn down. */
    var wasLive = _inited;
    _x = _y = _vx = _vy = _sx = _x0 = _y0 = null;
    _g1 = _g2 = null;
    _probes = [];
    _canvas = null; _ctx = null; _img = null;
    _inited = false; _disposed = true;
    _tracers = 0; _stepCount = 0;
    if (wasLive) V.bus.emit('vx:degraded', { from: 'cpu', to: 'none', reason: 'backend disposed' });
  }

  // ---- honest perf: measured, never claimed ----
  function perfInfo() {
    return {
      lastStepMs: _lastStepMs,
      lastRenderMs: _lastRenderMs,
      tracers: _tracers,
      stepCount: _stepCount,
      note: 'measured on this machine; not a framerate claim'
    };
  }

  // ---- selfTest: headless-safe, deterministic, assertion-driven ----
  // Returns a Promise resolving to { ok, checks }. Sequential async: each
  // check awaits the previous so state never interleaves.
  function runSteps(count) {
    for (var i = 0; i < count; i++) step();
  }

  async function selfTest() {
    var checks = [];
    async function check(name, fn) {
      try {
        var r = await fn();
        checks.push({ name: name, ok: !!r.ok, detail: String(r.detail === undefined ? '' : r.detail) });
      } catch (e) {
        checks.push({ name: name, ok: false, detail: 'threw: ' + (e && e.message) });
      }
    }

    await check('contract shape: all §5 methods present', async function () {
      var need = ['init', 'setParams', 'addProbe', 'clearProbes', 'step', 'render',
        'snapshotState', 'restoreState', 'sampleMetrics', 'getTracers', 'dispose', 'selfTest'];
      var missing = need.filter(function (k) { return typeof api[k] !== 'function'; });
      return { ok: missing.length === 0, detail: missing.length ? 'missing: ' + missing.join(',') : 'name=' + api.name + ' tier=' + api.tier };
    });

    await check('determinism: 600 steps, same seed -> identical metric hash', async function () {
      await init(null, { tracers: 512, seed: 42 });
      runSteps(600);
      var h1 = metricHash();
      await init(null, { tracers: 512, seed: 42 });
      runSteps(600);
      var h2 = metricHash();
      return { ok: h1 === h2, detail: 'h1=' + h1 + ' h2=' + h2 };
    });

    await check('different seed -> different hash', async function () {
      await init(null, { tracers: 512, seed: 43 });
      runSteps(600);
      var h3 = metricHash();
      await init(null, { tracers: 512, seed: 42 });
      runSteps(600);
      var h4 = metricHash();
      return { ok: h3 !== h4, detail: 'seed43=' + h3 + ' seed42=' + h4 };
    });

    await check('step() allocates zero: no `new` in hot-path source', async function () {
      var src = step.toString() + noise2.toString();
      var hits = src.match(/\bnew\s+[A-Z]/g);
      return { ok: !hits, detail: hits ? 'found: ' + hits.join(',') : 'no allocation keywords in step/noise2 (heuristic + code discipline)' };
    });

    await check('probes perturb the field', async function () {
      await init(null, { tracers: 256, seed: 7 });
      runSteps(50);
      var base = metricHash();
      addProbe({ x: 0, y: 0, strength: 2.0, radius: 0.4, kind: 'swirl' });
      runSteps(50);
      var perturbed = metricHash();
      return { ok: base !== perturbed, detail: 'base=' + base + ' perturbed=' + perturbed };
    });

    await check('clearProbes restores baseline (add+clear with 0 active steps = no-op)', async function () {
      await init(null, { tracers: 256, seed: 7 });
      runSteps(50);
      var base = metricHash();
      await init(null, { tracers: 256, seed: 7 });
      addProbe({ x: 0, y: 0, strength: 2.0, radius: 0.4, kind: 'swirl' });
      clearProbes();
      runSteps(50);
      var cleared = metricHash();
      return { ok: base === cleared, detail: 'base=' + base + ' cleared=' + cleared };
    });

    await check('snapshot/restore roundtrip is bit-identical', async function () {
      await init(null, { tracers: 256, seed: 99 });
      runSteps(100);
      var hSnap = metricHash();
      var snap = snapshotState();
      runSteps(50);
      var okRestore = restoreState(snap);
      var hAfter = metricHash();
      var cloneable = JSON.parse(JSON.stringify(snap));
      return { ok: okRestore && hSnap === hAfter && !!cloneable.arrays, detail: 'snap=' + hSnap + ' restored=' + hAfter };
    });

    await check('state stays finite over 600 steps', async function () {
      await init(null, { tracers: 1024, seed: 5 });
      runSteps(600);
      for (var i = 0; i < _tracers; i++) {
        if (!isFinite(_x[i]) || !isFinite(_y[i]) || !isFinite(_vx[i]) || !isFinite(_vy[i])) {
          return { ok: false, detail: 'non-finite at i=' + i };
        }
      }
      return { ok: true, detail: '1024 tracers, 600 steps, all finite' };
    });

    await check('headless render is a safe no-op', async function () {
      var r = render();
      return { ok: !!(r && r.rendered === false && r.note), detail: r.note };
    });

    await check('setParams clamps without realloc', async function () {
      var before = _tracers;
      setParams({ circulation: 99, persistence: 5, turbulence: -3, bogus: 1 });
      var p = getParams();
      return {
        ok: _tracers === before && p.circulation === 3 && p.persistence === 0.99 && p.turbulence === 0 && p.bogus === undefined,
        detail: 'circ=' + p.circulation + ' pers=' + p.persistence + ' turb=' + p.turbulence
      };
    });

    await check('perf smoke: measured step ms at 4000 tracers', async function () {
      await init(null, { tracers: 4000, seed: 11 });
      runSteps(30);
      var ms = perfInfo().lastStepMs;
      return { ok: ms > 0 && ms < 1000, detail: 'lastStepMs=' + ms.toFixed(2) + 'ms (measured, not claimed)' };
    });

    var ok = true;
    for (var i = 0; i < checks.length; i++) if (!checks[i].ok) ok = false;
    return { ok: ok, checks: checks };
  }
  var api = {
    name: 'cpu',
    tier: 'C',
    init: init,
    setParams: setParams,
    getParams: getParams,
    addProbe: addProbe,
    clearProbes: clearProbes,
    getProbes: getProbes,
    step: step,
    render: render,
    sampleMetrics: sampleMetrics,
    metricHash: metricHash,
    getTracers: getTracers,
    snapshotState: snapshotState,
    restoreState: restoreState,
    perfInfo: perfInfo,
    dispose: dispose,
    selfTest: selfTest
  };

  VORTEX.register('w14-cpu', api);
})(typeof window !== 'undefined' ? window : globalThis);
