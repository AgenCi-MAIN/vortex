/* VORTEX field-contract.js — W02.
 * Defines the VortexField backend interface (CONTRACTS §5), the tracer tier
 * table, capability probing, and the probe-then-verify warm-up rule.
 *
 * Capability rule (lane-14 §3.2 / §5): probe, then VERIFY with a headless
 * warm-up — never trust the driver. Drivers lie about extensions; the
 * RGBA16F framebuffer-completeness check is the truth. Any failure raises a
 * named VX_E_WARMUP_FAILED so the selector can step down.
 *
 * Headless-safe: no DOM/canvas/GL is touched at load time. GL appears only
 * inside probeFloatRenderable / verifyBackend, which take a context (or a
 * backend carrying one) as an argument.
 *
 * Plain script, IIFE, no modules. Works in browser and node.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('field-contract: VORTEX namespace missing (vx-namespace.js must load first)');

  var F = (V.field = V.field || {});

  /** Fixed sim timestep, sim-seconds per step (W25). Render interpolation may
   *  vary; the sim step never does. */
  F.DT = V.SIM_DT;

  /** The VortexField backend interface. Every backend (cpu/webgl2/webgpu)
   *  must expose all of these. W14 (cpu) and W15 (webgpu) implement against
   *  this shape; W02's verifyBackend() enforces it.
   *
   *  init(canvas, opts) -> Promise<backend>   opts: {tracers, seed, config}
   *  setParams(p)                             sliders as values, never recompiles
   *  addProbe(probe) / clearProbes()          probe injection (owner-gated upstream)
   *  step()                                   ONE fixed-dt sim step
   *  render()                                 draw current state; display-rate safe
   *  snapshotState() -> object                structured-cloneable
   *  restoreState(s)
   *  sampleMetrics() -> {ke, enstrophy, mixing, ...}
   *  getTracers() -> {count: number, simulated: boolean}
   *  dispose()
   */
  F.METHODS = [
    'init', 'setParams', 'addProbe', 'clearProbes', 'step', 'render',
    'snapshotState', 'restoreState', 'sampleMetrics', 'getTracers', 'dispose'
  ];

  /** Tracer tiers (lane-14 §3.2, §5). The Extreme rung is the ceiling Shawn
   *  verified on GPU hardware: 262,144 tracers @ ~128 FPS. Lower rungs are
   *  step-down targets for the governor (W11), not aspirations.
   *  grid: state-texture dims; capacity (w*h) always equals the tracer count.
   *  Tier A / 1M belongs to W03 (megafield) and is intentionally absent here. */
  F.TIERS = [
    { id: 'light',   label: 'Light',   tracers: 16384,  grid: [128, 128] },
    { id: 'dense',   label: 'Dense',   tracers: 65536,  grid: [256, 256] },
    { id: 'ultra',   label: 'Ultra',   tracers: 131072, grid: [512, 256] },
    { id: 'extreme', label: 'Extreme', tracers: 262144, grid: [512, 512] }
  ];

  /** Smallest standard tier that covers n tracers; clamps to extreme. */
  F.tierForCount = function (n) {
    n = Math.max(1, n | 0);
    for (var i = 0; i < F.TIERS.length; i++) {
      if (F.TIERS[i].tracers >= n) return F.TIERS[i];
    }
    return F.TIERS[F.TIERS.length - 1];
  };

  /** checkContract(backend) -> {ok, missing[]}. Pure structural check. */
  F.checkContract = function (backend) {
    var missing = [];
    for (var i = 0; i < F.METHODS.length; i++) {
      var m = F.METHODS[i];
      if (!backend || typeof backend[m] !== 'function') missing.push(m);
    }
    return { ok: missing.length === 0, missing: missing };
  };

  function tryFBO(gl, internalFormat, type, w, h) {
    var tex = null, fbo = null;
    try {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, null);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var ok = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return ok;
    } catch (e) {
      try { if (fbo) gl.deleteFramebuffer(fbo); } catch (e2) {}
      try { if (tex) gl.deleteTexture(tex); } catch (e3) {}
      return false;
    }
  }

  /** probeFloatRenderable(gl) — the truth test.
   *  Drivers may advertise EXT_color_buffer_float while float FBOs still come
   *  back incomplete; we attach a REAL texture and read the FBO status.
   *  Returns {ext, fbo32, fbo16, chosen, note}. chosen is 'rgba32f',
   *  'rgba16f', or null. Never throws. */
  F.probeFloatRenderable = function (gl) {
    var out = { ext: false, fbo32: false, fbo16: false, chosen: null, note: '' };
    if (!gl || typeof gl.getExtension !== 'function') {
      out.note = 'no GL context supplied';
      return out;
    }
    var ext = null;
    try { ext = gl.getExtension('EXT_color_buffer_float'); } catch (e) { ext = null; }
    out.ext = !!ext;
    if (!ext) {
      out.note = 'EXT_color_buffer_float missing — float render targets unavailable';
      return out;
    }
    out.fbo32 = tryFBO(gl, gl.RGBA32F, gl.FLOAT, 4, 4);
    out.fbo16 = tryFBO(gl, gl.RGBA16F, gl.HALF_FLOAT, 4, 4);
    if (out.fbo32) {
      out.chosen = 'rgba32f';
      out.note = 'RGBA32F render target complete (preferred)';
    } else if (out.fbo16) {
      out.chosen = 'rgba16f';
      out.note = 'RGBA16F render target complete (32F incomplete — degraded precision)';
    } else {
      out.note = 'extension advertised but no float FBO completed — driver lied; stepping down';
    }
    return out;
  };

  function warmUp(backend, gl, frames, probe) {
    return new Promise(function (resolve, reject) {
      var fail = function (msg, kept) {
        reject(V.VortexError('VX_E_WARMUP_FAILED', msg, 'backend-probe', kept || 'warm-up log'));
      };
      try {
        var before = stateSampleHash(backend);
        var times = [];
        var i, t0, err;
        for (i = 0; i < frames; i++) {
          t0 = V.utils.now();
          backend.step();
          backend.render();
          times.push(V.utils.now() - t0);
          err = gl.getError();
          if (err !== gl.NO_ERROR) {
            fail('GL error 0x' + err.toString(16) + ' during warm-up frame ' + i +
                 ' — the driver cannot sustain this backend.', 'frames completed: ' + i);
            return;
          }
        }
        var after = stateSampleHash(backend);
        times.sort(function (a, b) { return a - b; });
        var median = times[Math.floor(times.length / 2)];
        var p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
        var tr = (typeof backend.getTracers === 'function') ? backend.getTracers() : { count: 0 };
        V.bus.emit('vx:stage', { stage: 'backend-probe', status: 'passed', frames: frames });
        resolve({
          ok: true,
          frames: frames,
          medianMs: median,
          p95Ms: p95,
          format: probe.chosen,
          tracers: tr.count || 0,
          stateChanged: before !== after,
          note: probe.note
        });
      } catch (e) {
        if (e && e.code === 'VX_E_WARMUP_FAILED') { reject(e); return; }
        fail('warm-up threw: ' + (e && e.message ? e.message : String(e)));
      }
    });
  }

  function stateSampleHash(backend) {
    try {
      var s = backend.snapshotState();
      if (!s || !s.state) return 'none';
      var a = s.state, n = Math.min(a.length, 64), parts = [];
      for (var i = 0; i < n; i++) parts.push(a[i].toFixed(6));
      return V.utils.hash53(parts.join(','));
    } catch (e) {
      return 'unreadable';
    }
  }

  /** verifyBackend(backend, opts) — the probe-then-verify rule.
   *  opts: {frames} (default 120).
   *  Structural + capability gates throw VX_E_WARMUP_FAILED synchronously
   *  (so headless tests can assert the named error without a GPU); the
   *  120-frame warm-up returns a Promise that resolves a report or rejects
   *  with VX_E_WARMUP_FAILED. Either way, a failed backend steps down —
   *  nothing here ever fakes a passing GPU. */
  F.verifyBackend = function (backend, opts) {
    opts = opts || {};
    var frames = Math.max(1, (opts.frames | 0) || 120);
    V.bus.emit('vx:stage', { stage: 'backend-probe', status: 'verifying' });

    var c = F.checkContract(backend);
    if (!c.ok) {
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'Backend violates the VortexField contract (missing: ' + c.missing.join(', ') +
        '). Cannot warm up what is not a field.', 'backend-probe', 'contract shape');
    }
    var gl = backend.gl || null;
    if (!gl || typeof gl.getExtension !== 'function' || typeof gl.createTexture !== 'function') {
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'No WebGL2 context on this backend — nothing to warm up. Stepping down.',
        'backend-probe', 'backend object');
    }
    var probe = F.probeFloatRenderable(gl);
    if (!probe.chosen) {
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'No float render target: ' + probe.note + '. The GPU path cannot run here.',
        'backend-probe', 'probe report');
    }
    return warmUp(backend, gl, frames, probe);
  };

  // ---- module api ----
  function selfTest() {
    var checks = [];
    function check(name, fn) {
      try {
        var r = fn();
        checks.push({ name: name, ok: !!r.ok, detail: r.detail || '' });
      } catch (e) {
        checks.push({ name: name, ok: false, detail: 'threw: ' + (e && e.message) });
      }
    }

    check('namespace present', function () {
      return { ok: !!(V && V.register && V.bus), detail: 'VORTEX ' + V.version };
    });

    check('contract lists 11 methods', function () {
      return {
        ok: F.METHODS.length === 11,
        detail: F.METHODS.join(',')
      };
    });

    check('tier table invariants', function () {
      var ts = F.TIERS, ids = {}, prev = 0;
      for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        if (ids[t.id]) return { ok: false, detail: 'duplicate tier id ' + t.id };
        ids[t.id] = 1;
        if (!(t.tracers > prev)) return { ok: false, detail: 'counts not ascending at ' + t.id };
        prev = t.tracers;
        if (t.grid[0] * t.grid[1] !== t.tracers)
          return { ok: false, detail: t.id + ' grid capacity mismatch' };
      }
      var labels = ts.map(function (t) { return t.label; }).join('/');
      if (labels !== 'Light/Dense/Ultra/Extreme')
        return { ok: false, detail: 'labels: ' + labels };
      var top = ts[ts.length - 1];
      return {
        ok: top.tracers === 262144,
        detail: '4 tiers, top=Extreme@262144 (' + labels + ')'
      };
    });

    check('tierForCount picks smallest covering tier', function () {
      var a = F.tierForCount(1).id, b = F.tierForCount(16384).id,
          c = F.tierForCount(16385).id, d = F.tierForCount(999999999).id;
      return {
        ok: a === 'light' && b === 'light' && c === 'dense' && d === 'extreme',
        detail: '1->' + a + ' 16384->' + b + ' 16385->' + c + ' huge->' + d + ' (clamped)'
      };
    });

    check('checkContract accepts a full mock', function () {
      var mock = {};
      F.METHODS.forEach(function (m) { mock[m] = function () {}; });
      var r = F.checkContract(mock);
      return { ok: r.ok && r.missing.length === 0, detail: '11/11 present' };
    });

    check('checkContract names missing methods', function () {
      var r = F.checkContract({ step: function () {}, render: function () {} });
      return {
        ok: !r.ok && r.missing.length === 9 && r.missing.indexOf('init') !== -1,
        detail: 'missing: ' + r.missing.join(',')
      };
    });

    check('probeFloatRenderable: stub GL without extension -> chosen null', function () {
      var stub = { getExtension: function () { return null; } };
      var p = F.probeFloatRenderable(stub);
      return {
        ok: p.chosen === null && !p.ext && /EXT_color_buffer_float/.test(p.note),
        detail: 'note="' + p.note + '"'
      };
    });

    check('probeFloatRenderable: no GL at all -> chosen null, no throw', function () {
      var p = F.probeFloatRenderable(null);
      return { ok: p.chosen === null, detail: 'note="' + p.note + '"' };
    });

    check('verifyBackend: contract violation -> VX_E_WARMUP_FAILED', function () {
      try {
        F.verifyBackend({ step: function () {} }, { frames: 1 });
        return { ok: false, detail: 'did not throw' };
      } catch (e) {
        return {
          ok: e && e.code === 'VX_E_WARMUP_FAILED',
          detail: 'threw [' + (e && e.code) + '] ' + String(e && e.message).slice(0, 100)
        };
      }
    });

    check('verifyBackend: fake GL (lies about nothing, has no float) -> VX_E_WARMUP_FAILED', function () {
      var fakeGL = {
        getExtension: function () { return null; },
        createTexture: function () { return {}; }
      };
      var fake = { name: 'webgl2', tier: 'B', gl: fakeGL };
      F.METHODS.forEach(function (m) { fake[m] = function () {}; });
      try {
        F.verifyBackend(fake, { frames: 1 });
        return { ok: false, detail: 'did not throw' };
      } catch (e) {
        return {
          ok: e && e.code === 'VX_E_WARMUP_FAILED',
          detail: 'threw [' + (e && e.code) + '] ' + String(e && e.message).slice(0, 100)
        };
      }
    });

    check('verifyBackend: backend without gl -> VX_E_WARMUP_FAILED', function () {
      var b = {};
      F.METHODS.forEach(function (m) { b[m] = function () {}; });
      try {
        F.verifyBackend(b, { frames: 1 });
        return { ok: false, detail: 'did not throw' };
      } catch (e) {
        return { ok: e && e.code === 'VX_E_WARMUP_FAILED', detail: 'threw [' + (e && e.code) + ']' };
      }
    });

    var headless = (typeof root.document === 'undefined');
    checks.push({
      name: 'warm-up on real GL',
      ok: true,
      detail: headless
        ? 'SKIPPED (no GL in this environment) — real compile + 120-frame warm-up only verifiable on a GPU machine'
        : 'not run by selfTest; run VORTEX.field.verifyBackend(backend) after init on GPU hardware'
    });

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  var api = {
    selfTest: selfTest,
    DT: F.DT,
    METHODS: F.METHODS,
    TIERS: F.TIERS,
    tierForCount: F.tierForCount,
    checkContract: F.checkContract,
    probeFloatRenderable: F.probeFloatRenderable,
    verifyBackend: F.verifyBackend
  };

  VORTEX.register('w02-field-contract', api);
})(typeof window !== 'undefined' ? window : globalThis);
