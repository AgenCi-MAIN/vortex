/* backend-select.js — W15
 * Selection order per lane-14 spec §5: WebGPU → WebGL2 → CPU.
 *
 *   (a) WebGPU: via the w15-webgpu detector (navigator.gpu → high-perf
 *       adapter → timestamp queries → warm-up compute dispatch). Falls back
 *       to an inline detect if the module isn't loaded yet.
 *   (b) WebGL2: via W02's verifyBackend when w02-gpu is present, else an
 *       inline canvas probe: webgl2 context → EXT_color_buffer_float →
 *       RGBA32F framebuffer completeness → shader compile + draw + readback.
 *   (c) CPU: always available. tier C, 4K tracers, the compatibility floor.
 *
 * Every candidate that fails verification steps down AUTOMATICALLY with a
 * narrated reason appended to result.notes (and a vx:degraded bus event).
 * No modal errors: the worst case is CPU, never a hang.
 *
 * Tracer tiers: C=4K (CPU), B=262K (GPU default), A=1M (gated — the A-gate
 * belongs to W03; when w03-megafield is present its checkTierA() verdict is
 * used, otherwise B is the default).
 *
 * Backend badge: rendered into #vx-backend-badge as exactly one of
 * "GPU · WebGPU" / "GPU · WebGL2" / "CPU". Incompatible presets simply don't
 * render — selection emits vx:preset-availability for W01/W18 to consume.
 *
 * Plain browser JS, IIFE, no modules, runs from file://. Headless-safe:
 * on a GPU-less environment selection resolves to CPU with notes narrating
 * each step-down.
 * =====================================================================
 */
(function (root) {
  'use strict';
  var V = root.VORTEX;

  // Tracer tiers per spec §5
  var TIERS = {
    A: { tier: 'A', tracers: 1000000, label: 'tier A · 1M GPU (gated)' },
    B: { tier: 'B', tracers: 262144, label: 'tier B · 262K GPU (default on capable hardware)' },
    C: { tier: 'C', tracers: 4096, label: 'tier C · 4K CPU (compatibility floor)' }
  };

  var NAMES = {
    webgpu: 'GPU · WebGPU',
    webgl2: 'GPU · WebGL2',
    cpu: 'CPU'
  };

  function note(notes, s) { notes.push(String(s)); }

  function emitDegraded(from, to, reason) {
    try { V.bus.emit('vx:degraded', { from: from, to: to, reason: String(reason) }); } catch (_) {}
  }

  // ---- (a) WebGPU candidate ----
  function tryWebGPU(notes, opts) {
    opts = opts || {};
    var mod = V.get('w15-webgpu');
    if (mod && typeof mod.detect === 'function') {
      note(notes, 'WebGPU: probing via w15-webgpu detector (navigator.gpu → adapter → timestamp queries → warm-up dispatch)…');
      return Promise.resolve(mod.detect({ warmup: !opts.quick })).then(function (r) {
        if (r && r.supported) {
          note(notes, 'WebGPU: verified — ' + r.detail);
          return { ok: true, detail: r };
        }
        var msg = 'WebGPU stepped down: ' + ((r && r.reason) || 'unknown') +
          ' — ' + ((r && r.detail) || 'no detail');
        note(notes, msg);
        return { ok: false, reason: ((r && r.reason) || 'unknown') };
      }).catch(function (e) {
        note(notes, 'WebGPU stepped down: detector threw — ' + (e && e.message));
        return { ok: false, reason: 'detector-exception' };
      });
    }
    // Inline fallback when the detector module isn't loaded yet
    note(notes, 'WebGPU: w15-webgpu module not loaded — inline detection (adapter + timestamp queries, no dispatch)…');
    var nav = root.navigator;
    if (!nav || !nav.gpu) {
      note(notes, 'WebGPU stepped down: no-navigator-gpu — navigator.gpu is undefined');
      return Promise.resolve({ ok: false, reason: 'no-navigator-gpu' });
    }
    return Promise.resolve(nav.gpu.requestAdapter({ powerPreference: 'high-performance' })).then(
      function (adapter) {
        if (!adapter) {
          note(notes, 'WebGPU stepped down: no-adapter — requestAdapter() returned null');
          return { ok: false, reason: 'no-adapter' };
        }
        var hasTS = false;
        try { hasTS = adapter.features.has('timestamp-query'); } catch (_) {}
        if (!hasTS) {
          note(notes, 'WebGPU stepped down: no-timestamp-queries — adapter lacks the feature');
          return { ok: false, reason: 'no-timestamp-queries' };
        }
        note(notes, 'WebGPU: inline detection passed (adapter + timestamp queries); full warm-up dispatch not run (detector module absent)');
        return { ok: true, detail: { supported: true, reason: 'ok', timestampQueries: true, warmup: null, inline: true } };
      },
      function (e) {
        note(notes, 'WebGPU stepped down: adapter-exception — ' + (e && e.message));
        return { ok: false, reason: 'adapter-exception' };
      }
    );
  }

  // ---- (b) WebGL2 candidate ----
  function tryWebGL2(canvas, notes, opts) {
    opts = opts || {};
    /* AUDIT 2026-09-20: probing must NEVER touch the display canvas. Once a
     * canvas holds a webgl2 context, getContext('2d') returns null forever —
     * the old code probed on #vx-canvas, so the CPU fallback's 2D context came
     * back null and the sim rendered black with zero errors. All WebGL2
     * probing happens on an offscreen canvas. */
    var probeCanvas = null;
    try {
      probeCanvas = (typeof document !== 'undefined' && document.createElement)
        ? document.createElement('canvas') : null;
    } catch (e) { probeCanvas = null; }
    /* Real verifier: trial backend from w02-gpu's factory + the field
     * contract's probe-then-verify warm-up. (w02-gpu never exposed
     * verifyBackend — the old branch calling w02.verifyBackend(canvas) was
     * dead code passing a canvas where a backend belongs.) */
    var w02 = V.get('w02-gpu');
    var FC = V.get('w02-field-contract');
    if (w02 && typeof w02.create === 'function' && FC && typeof FC.verifyBackend === 'function' && probeCanvas) {
      note(notes, 'WebGL2: verifying via w02-gpu trial backend + field-contract warm-up (offscreen canvas)…');
      var trial = null;
      return Promise.resolve().then(function () {
        trial = w02.create();
        return trial.init(probeCanvas, { tracers: 4096, seed: opts.seed || 1, config: 'probe' });
      }).then(function () {
        return FC.verifyBackend(trial, { frames: 24 });
      }).then(function (r) {
        try { if (trial && typeof trial.dispose === 'function') trial.dispose(); } catch (e) { /* ignore */ }
        note(notes, 'WebGL2: verified — ' + ((r && (r.detail || r.note)) || 'trial warm-up passed'));
        return { ok: true, detail: r };
      }).catch(function (e) {
        try { if (trial && typeof trial.dispose === 'function') trial.dispose(); } catch (x) { /* ignore */ }
        var reason = (e && (e.reason || e.code)) || 'verify-failed';
        note(notes, 'WebGL2 stepped down: ' + reason + ' — ' + ((e && e.message) || ''));
        return { ok: false, reason: reason };
      });
    }
    // Inline fallback probe: context → EXT_color_buffer_float → FBO → shader/draw
    // (offscreen canvas — see note above)
    note(notes, 'WebGL2: trial-backend verifier unavailable — inline probe (context → EXT_color_buffer_float → FBO completeness → shader+draw)…');
    return Promise.resolve().then(function () {
      var pc = probeCanvas || canvas; /* last resort: display canvas, may poison 2D */
      if (!pc || typeof pc.getContext !== 'function') {
        note(notes, 'WebGL2 stepped down: no-canvas — no canvas element available for probing');
        return { ok: false, reason: 'no-canvas' };
      }
      var gl = null;
      try {
        gl = pc.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance' });
      } catch (e) {
        note(notes, 'WebGL2 stepped down: context-threw — ' + (e && e.message));
        return { ok: false, reason: 'context-threw' };
      }
      if (!gl) {
        note(notes, 'WebGL2 stepped down: no-webgl2 — getContext("webgl2") returned null');
        return { ok: false, reason: 'no-webgl2' };
      }
      if (!gl.getExtension('EXT_color_buffer_float')) {
        note(notes, 'WebGL2 stepped down: no-float-render — EXT_color_buffer_float unavailable (this caught the deployed build)');
        return { ok: false, reason: 'no-float-render' };
      }
      // FBO completeness with RGBA32F
      var fb = gl.createFramebuffer();
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      var complete = status === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!complete) {
        note(notes, 'WebGL2 stepped down: fbo-incomplete — RGBA32F framebuffer status 0x' + status.toString(16));
        gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
        return { ok: false, reason: 'fbo-incomplete' };
      }
      // Minimal shader compile + draw + readback — catches drivers that lie
      try {
        var vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, '#version 300 es\nvoid main(){gl_Position=vec4(0.,0.,0.,1.);gl_PointSize=1.;}');
        gl.compileShader(vs);
        var fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, '#version 300 es\nprecision highp float;\nlayout(location=0) out vec4 o;\nvoid main(){o=vec4(1.,0.5,0.25,1.);}');
        gl.compileShader(fs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
          throw new Error('shader compile failed: ' + gl.getShaderInfoLog(fs));
        }
        var prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program link failed');
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(0, 0, 4, 4);
        gl.useProgram(prog);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.finish();
        var err = gl.getError();
        var px = new Float32Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
        gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
        if (err !== gl.NO_ERROR) throw new Error('GL error 0x' + err.toString(16) + ' during probe draw');
        if (Math.abs(px[0] - 1.0) > 0.01) throw new Error('probe readback mismatch');
      } catch (e) {
        try { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (_) {}
        note(notes, 'WebGL2 stepped down: shader-failed — ' + (e && e.message));
        return { ok: false, reason: 'shader-failed' };
      }
      // release the context if possible
      try {
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (_) {}
      note(notes, 'WebGL2: inline probe passed (context + float render + FBO complete + probe draw)');
      return { ok: true, detail: { ok: true, inline: true, ext: 'EXT_color_buffer_float', fbo: 'complete' } };
    });
  }

  // ---- (c) CPU candidate: always available ----
  function tryCPU(notes) {
    if (V.has('w14-cpu')) {
      note(notes, 'CPU: w14-cpu backend present — tier C floor (4,096 tracers)');
    } else {
      note(notes, 'CPU: always available — w14-cpu module not loaded yet, field-init will confirm');
    }
    return { ok: true, detail: { ok: true, module: V.has('w14-cpu') } };
  }

  // ---- tier A gate (W03 owns the check; B is the default without it) ----
  function resolveTier(backend, detail, notes, opts) {
    opts = opts || {};
    if (backend !== 'webgpu') return Promise.resolve(TIERS.B); // webgl2 → B per spec
    var w03 = V.get('w03-megafield');
    if (!w03 || typeof w03.checkTierA !== 'function') {
      note(notes, 'Tier A gate (W03 megafield) not present — tier B default (262,144 tracers)');
      return Promise.resolve(TIERS.B);
    }
    note(notes, 'Tier A: asking W03 megafield eligibility (≥120 FPS @64K benchmark + ≥2 GB free GPU memory)…');
    return Promise.resolve(w03.checkTierA({
      backend: backend, detail: detail,
      benchFps: opts.benchFps, freeGpuMB: opts.freeGpuMB,
      overrideTierA: opts.overrideTierA === true || opts.override === true
    })).then(
      function (r) {
        if (r && r.eligible) {
          note(notes, 'Tier A granted by W03: ' + (r.detail || 'benchmark + memory gate passed') + ' — 1,000,000 tracers');
          return TIERS.A;
        }
        note(notes, 'Tier A declined by W03: ' + ((r && (r.reason || r.detail)) || 'not eligible') + ' — tier B (262,144)');
        return TIERS.B;
      },
      function (e) {
        note(notes, 'Tier A gate threw (' + (e && e.message) + ') — tier B default (262,144)');
        return TIERS.B;
      }
    );
  }

  function applyUserOverride(result, notes, opts) {
    opts = opts || {};
    if (opts.tracerTarget === 1000000 && result.tier !== 'A') {
      note(notes, 'You asked for 1M; measured tier is ' + result.tracers.toLocaleString() +
        ' — frame drops expected (user override, labeled, not silent)');
      result.tracers = 1000000;
      result.measuredTier = result.tier;
      result.userOverride = true;
    }
    return result;
  }

  function finalize(backend, tier, notes, detail, opts) {
    var result = {
      backend: backend,
      name: NAMES[backend],
      tier: tier.tier,
      tracers: tier.tracers,
      notes: notes.slice(),
      detail: detail || {},
      at: Date.now()
    };
    applyUserOverride(result, notes, opts);
    result.notes = notes.slice();
    // badge (never throws, never blocks selection)
    renderBackendBadge(result, null);
    // events for chrome: preset availability + stage status
    try {
      V.bus.emit('vx:preset-availability', {
        backend: backend,
        tier: result.tier,
        tracers: result.tracers,
        gpu: backend !== 'cpu',
        note: backend === 'cpu'
          ? 'GPU-only presets do not render on the CPU backend'
          : 'all presets available on this backend'
      });
      V.bus.emit('vx:stage', { stage: 'backend-probe', status: 'ok', backend: backend, tier: result.tier });
    } catch (_) {}
    return result;
  }

  function selectInner(canvas, opts, fin) {
    opts = opts || {};
    fin = (typeof fin === 'function') ? fin : function (b, t, n, d) { return finalize(b, t, n, d, opts); };
    var notes = [];
    note(notes, 'Backend selection: WebGPU → WebGL2 → CPU (spec §5).');
    return tryWebGPU(notes, opts).then(function (wg) {
      if (wg.ok) {
        return resolveTier('webgpu', wg.detail, notes, opts).then(function (tier) {
          return fin('webgpu', tier, notes, wg.detail);
        });
      }
      emitDegraded('webgpu', 'webgl2', wg.reason);
      return tryWebGL2(canvas, notes, opts).then(function (g2) {
        if (g2.ok) return fin('webgl2', TIERS.B, notes, g2.detail);
        emitDegraded('webgl2', 'cpu', g2.reason);
        var cpu = tryCPU(notes);
        return fin('cpu', TIERS.C, notes, cpu.detail);
      });
    });
  }

  // selectBackend: 5s backend-probe budget; on timeout, CPU rather than hang.
  // NOTE (audit 2026-09-20): Promise.race does NOT cancel the loser. The old
  // code let the orphan 5s timer fire finalize('cpu') AFTER the inner probe had
  // already won with WebGL2 — the badge flipped to "CPU" mid-session and phantom
  // vx:stage/vx:preset-availability events fired. Exactly one finalize runs now:
  // the timer is cleared when the inner probe wins, and a once-guard drops the
  // loser's side effects either way.
  function selectBackend(canvas, opts) {
    opts = opts || {};
    var finalized = false;
    function fin(backend, tier, notes, detail) {
      if (finalized) return null; /* loser of the race: no side effects */
      finalized = true;
      return finalize(backend, tier, notes, detail, opts);
    }
    var timer = null;
    var innerP = selectInner(canvas, opts, fin).then(function (r) {
      if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; }
      return r;
    });
    var timeoutP = new Promise(function (resolve) {
      timer = setTimeout(function () {
        timer = null;
        var notes = ['Backend selection timed out after 5s — falling back to CPU (no modal error).'];
        resolve(fin('cpu', TIERS.C, notes, { timeout: true }));
      }, opts.timeoutMs || 5000);
    });
    return Promise.race([innerP, timeoutP]);
  }

  // ---- backend badge ----
  function renderBackendBadge(result, target) {
    var el = null;
    try {
      if (target && target.nodeType === 1) {
        el = target;
      } else if (typeof target === 'string' && root.document) {
        el = root.document.getElementById(target);
      } else if (V.utils.isBrowser()) {
        el = root.document.getElementById('vx-backend-badge');
      }
    } catch (_) { el = null; }
    if (!el) return { rendered: false, reason: 'badge element not present (headless or shell not mounted)' };
    try {
      el.textContent = result && result.name ? result.name : 'CPU';
      el.setAttribute('data-backend', (result && result.backend) || 'cpu');
      el.setAttribute('data-tier', (result && result.tier) || 'C');
      el.title = 'backend ' + ((result && result.backend) || 'cpu') +
        ' · tier ' + ((result && result.tier) || 'C') +
        ' · ' + Number((result && result.tracers) || 4096).toLocaleString('en-US') + ' tracers';
      return { rendered: true };
    } catch (e) {
      return { rendered: false, reason: String(e && e.message) };
    }
  }

  var api = {
    selectBackend: selectBackend,
    renderBackendBadge: renderBackendBadge,
    tiers: function () {
      return {
        A: { tier: 'A', tracers: 1000000, label: TIERS.A.label },
        B: { tier: 'B', tracers: 262144, label: TIERS.B.label },
        C: { tier: 'C', tracers: 4096, label: TIERS.C.label }
      };
    },
    badgeNames: function () { return { webgpu: NAMES.webgpu, webgl2: NAMES.webgl2, cpu: NAMES.cpu }; },

    selfTest: function () {
      var checks = [];
      function add(n, ok, d) { checks.push({ name: n, ok: !!ok, detail: String(d) }); }
      var t = api.tiers();
      add('tiers', t.A.tracers === 1000000 && t.B.tracers === 262144 && t.C.tracers === 4096,
        'A=1,000,000 B=262,144 C=4,096');
      var badge = api.renderBackendBadge({ name: 'CPU', backend: 'cpu', tier: 'C', tracers: 4096 }, 'vx-badge-that-does-not-exist');
      add('badge-headless-safe', badge && badge.rendered === false,
        'missing DOM → {rendered:false}, no throw');
      return api.selectBackend(null, { quick: true, timeoutMs: 3000 }).then(function (r) {
        add('headless-cpu', r && r.backend === 'cpu',
          'GPU-less headless selection resolves to CPU (got ' + (r && r.backend) + ')');
        add('stepdown-narrated', !!(r && r.notes && r.notes.join(' ').match(/WebGPU/) && r.notes.join(' ').match(/WebGL2/)),
          'notes narrate each step-down (' + (r ? r.notes.length : 0) + ' notes)');
        add('badge-name', r && r.name === 'CPU', 'badge name is exactly "CPU" (got "' + (r && r.name) + '")');
        add('tier-c', r && r.tier === 'C' && r.tracers === 4096, 'CPU → tier C, 4,096 tracers');
        add('no-throw', true, 'selection completed without throwing in a DOM-less environment');
        var ok = checks.every(function (c) { return c.ok; });
        return { ok: ok, checks: checks };
      }).catch(function (e) {
        add('select-threw', false, 'selectBackend threw headless: ' + (e && e.message));
        return { ok: false, checks: checks };
      });
    }
  };

  V.register('w15-backends', api);
})(typeof window !== 'undefined' ? window : globalThis);
