/* VORTEX init.js — W01 shared staged initializer.
 *
 * This file kills the INITIALIZING FIELD hang. Every boot stage has a
 * timeout, a named error (VX_E_*), one retry, then a named on-screen error
 * rendered via VORTEX.ui.fail — never an infinite spinner. boot() ALWAYS
 * settles: it resolves {backend, tracers} or rejects with a named
 * VortexError.
 *
 * Load order owned here (CONTRACTS §10): js/vx-namespace.js first (namespace
 * stage), then every js/* module in §10 order (scripts stage). vortex.html
 * includes ONLY this file + a boot() call, so the staged loader owns
 * everything — a mid-boot failure surfaces as a named error, not a hang.
 *
 * Ordering note: the module pattern says VORTEX.register('w01-init', api) at
 * load, but init.js is the thing that LOADS the namespace (namespace stage).
 * So registration happens (a) immediately if VORTEX already exists
 * (double-include / embed host preloaded it), and (b) at the end of the
 * namespace stage otherwise. Pre-namespace callers use the tiny
 * window.VortexInit global exposed below.
 *
 * Plain script, no ES modules, no fetch/XHR/WebSocket/eval. Runs from
 * file://. Headless-safe: every DOM touch is guarded; selfTest() never
 * throws without a DOM (it skips DOM-only checks with a note).
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Stage table (CONTRACTS §4). timeoutMs is per attempt; scripts stage  */
  /* uses it per script file. retries = 1 everywhere except ready.       */
  /* ------------------------------------------------------------------ */
  var STAGES = [
    { name: 'shell-detect',  timeoutMs: 2000,  error: 'VX_E_SHELL',          retries: 1, fatal: true  },
    { name: 'namespace',     timeoutMs: 2000,  error: 'VX_E_NAMESPACE',      retries: 1, fatal: true  },
    { name: 'scripts',       timeoutMs: 8000,  error: 'VX_E_SCRIPT_ERROR',   timeoutError: 'VX_E_SCRIPT_TIMEOUT', retries: 1, fatal: true, perScript: true },
    { name: 'backend-probe', timeoutMs: 5000,  error: 'VX_E_NO_BACKEND',     retries: 1, fatal: true  },
    { name: 'field-init',    timeoutMs: 10000, error: 'VX_E_FIELD_INIT',     retries: 1, fatal: true  },
    { name: 'chrome',        timeoutMs: 5000,  error: 'VX_E_CHROME',         retries: 1, fatal: false },
    { name: 'ready',         timeoutMs: 0,     error: null,                  retries: 0, fatal: true  }
  ];

  /* js/* modules in CONTRACTS §10 load order (namespace first, integration
   * last). vortex-embed.js is W33's entry point, not a boot-stage module, so
   * it is intentionally NOT in this list. */
  var MODULE_FILES = [
    'js/field-contract.js',
    'js/webgl2-field.js',
    'js/cpu-field.js',
    'js/webgpu-field.js',
    'js/backend-select.js',
    'js/substrate.js',
    'js/megafield.js',
    'js/determinism.js',
    'js/governor.js',
    'js/snapshots.js',
    'js/resilience.js',
    'js/protocols.js',
    'js/metrics.js',
    'js/capture-compare.js',
    'js/ab-fields.js',
    'js/teach-her.js',
    'js/hypothesis.js',
    'js/markets.js',
    'js/field-configs.js',
    'js/probe-catalog.js',
    'js/multivortex.js',
    'js/presets.js',
    'js/director.js',
    'js/touch.js',
    'js/a11y-panels.js',
    'js/sonify.js',
    'js/onboarding.js',
    'js/background.js',
    'js/agent-api.js',
    'js/permissions.js',
    'js/telemetry.js',
    'js/lab-metrics.js',
    'js/treasury-view.js',
    'js/integration.js'
  ];

  var KNOWN_CODES = [
    'VX_E_SHELL', 'VX_E_NAMESPACE', 'VX_E_SCRIPT_TIMEOUT', 'VX_E_SCRIPT_ERROR',
    'VX_E_NO_BACKEND', 'VX_E_WARMUP_FAILED', 'VX_E_FIELD_INIT', 'VX_E_CHROME',
    'VX_E_OOM', 'VX_E_CONTEXT_LOST', 'VX_E_QUOTA'
  ];

  /* code -> one plain sentence (CONTRACTS §8: code + sentence + kept + next) */
  var PLAIN = {
    VX_E_SHELL: 'The lab shell (page structure or embed root) could not be detected.',
    VX_E_NAMESPACE: 'The VORTEX core namespace failed to load.',
    VX_E_SCRIPT_TIMEOUT: 'A lab module took too long to load (per-script limit exceeded).',
    VX_E_SCRIPT_ERROR: 'A lab module failed to load.',
    VX_E_NO_BACKEND: 'No simulation backend is available.',
    VX_E_WARMUP_FAILED: 'The backend failed its warm-up verification and there was nothing left to step down to.',
    VX_E_FIELD_INIT: 'The field failed to initialize.',
    VX_E_CHROME: 'Some lab chrome failed to mount. The lab remains usable.',
    VX_E_OOM: 'Out of memory — the lab stepped down to a lighter configuration.',
    VX_E_CONTEXT_LOST: 'The graphics context was lost.',
    VX_E_QUOTA: 'Storage quota exceeded.'
  };

  var MODES = ['standalone', 'embedded', 'observatory'];

  /* Pathological backstop: every await in boot is already wrapped in a
   * timeout, but if anything ever slipped through, the watchdog rejects with
   * the active stage's named error. Worst case for the scripts stage is
   * 33 files x 8s x 2 attempts = 528s, so 600s leaves headroom. */
  var WATCHDOG_MS = 600000;

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */
  function vxError(code, message, stage, kept) {
    var e = new Error('[' + code + '] ' + (message || PLAIN[code] || 'unknown error'));
    e.code = code;
    e.stage = stage || null;
    e.kept = kept || null;
    return e;
  }

  function hasDom() {
    return typeof root.document !== 'undefined' && !!root.document;
  }

  function getV() { return root.VORTEX || null; }

  /* Race a promise against a deadline. Rejects with a NAMED error. */
  function withTimeout(promise, ms, code, what, stage) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        reject(vxError(code, 'Timed out: ' + what + ' (' + ms + 'ms).', stage || null, null));
      }, ms);
      Promise.resolve(promise).then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
      );
    });
  }

  /* Classic <script> injection. Resolves on load, rejects with a NAMED
   * error on 404/network (VX_E_SCRIPT_ERROR) or on timeout
   * (VX_E_SCRIPT_TIMEOUT). Never hangs: the timer always settles it. */
  function loadScript(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!hasDom()) {
        reject(vxError('VX_E_SCRIPT_ERROR', 'No document: cannot inject script ' + url + '.', 'scripts', url));
        return;
      }
      var doc = root.document;
      var el = doc.createElement('script');
      el.src = url;
      el.async = false;
      var settled = false;
      function done(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.onload = null;
        el.onerror = null;
        fn(arg);
      }
      var timer = setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        done(reject, vxError('VX_E_SCRIPT_TIMEOUT',
          'Timed out loading ' + url + ' (' + timeoutMs + 'ms).', 'scripts', url));
      }, timeoutMs);
      el.onload = function () { done(resolve, url); };
      el.onerror = function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        done(reject, vxError('VX_E_SCRIPT_ERROR',
          'Failed to load ' + url + ' (404 or network blocked).', 'scripts', url));
      };
      (doc.head || doc.documentElement).appendChild(el);
    });
  }

  function loadWithRetry(url, timeoutMs) {
    return loadScript(url, timeoutMs).catch(function () {
      return loadScript(url, timeoutMs); /* one retry, then the error stands */
    });
  }

  /* Base URL = directory containing this init.js file. */
  function baseUrl() {
    try {
      var doc = root.document;
      if (doc && doc.currentScript && doc.currentScript.src) {
        var s = doc.currentScript.src;
        return s.slice(0, s.lastIndexOf('/') + 1);
      }
      /* fallback: last script tag (init.js is expected to be the last
       * classic script before the inline boot call) */
      if (doc) {
        var scripts = doc.getElementsByTagName('script');
        for (var i = scripts.length - 1; i >= 0; i--) {
          var src = scripts[i].getAttribute('src') || '';
          if (/init\.js(\?.*)?$/.test(src)) {
            return src.slice(0, src.lastIndexOf('/') + 1);
          }
        }
      }
    } catch (e) { /* headless: no base */ }
    return '';
  }

  function emitBus(name, detail) {
    var V = getV();
    if (V && V.bus) {
      try { V.bus.emit(name, detail || {}); } catch (e) { /* bus must never break boot */ }
    }
  }

  function emitStage(stage, status, detail) {
    emitBus('vx:stage', { stage: stage, status: status, detail: detail || null });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  var bootCache = null;          /* in-flight or successful boot promise */
  var stageListenerInstalled = false;

  function makeCtx(opts) {
    return {
      mode: opts.mode || 'standalone',
      rootEl: null,
      backendName: null,
      backendFactory: null,
      tracers: opts.tracers || 4000,
      seed: (typeof opts.seed === 'number') ? (opts.seed >>> 0) : 1,
      configId: opts.configId || 'spiral-default',
      field: null,
      loadedScripts: [],
      keptNotes: [],
      chromeDegraded: false,
      activeStage: null,
      slots: null
    };
  }

  function setStatus(text) {
    if (!hasDom()) return;
    try {
      var el = root.document.getElementById('vx-status');
      if (el) el.textContent = text;
    } catch (e) { /* status is cosmetic; never break boot */ }
  }

  function installStageListener() {
    if (stageListenerInstalled) return;
    var V = getV();
    if (!hasDom() || !V || !V.bus) return; /* namespace not loaded yet; namespace stage retries this */
    stageListenerInstalled = true;
    V.bus.on('vx:stage', function (d) {
      if (d && d.status !== 'ok') setStatus('INITIALIZING FIELD — ' + d.stage + ' · ' + d.status);
    });
  }

  function failFallback(code, message, kept) {
    /* Namespace itself failed: render #vx-fatal by hand. */
    if (!hasDom()) return;
    try {
      var el = root.document.getElementById('vx-fatal');
      if (!el) return;
      el.removeAttribute('hidden');
      el.style.display = 'block';
      el.innerHTML = '';
      var h = root.document.createElement('h2');
      h.textContent = 'VORTEX stopped: ' + code;
      var p = root.document.createElement('p');
      p.textContent = message;
      var k = root.document.createElement('p');
      k.textContent = kept ? ('Kept: ' + kept) : 'No state was kept.';
      el.appendChild(h); el.appendChild(p); el.appendChild(k);
    } catch (e) { /* last resort failed; nothing more to do */ }
  }

  function failBoot(ctx, err) {
    var code = (err && err.code) || 'VX_E_FIELD_INIT';
    if (KNOWN_CODES.indexOf(code) < 0) code = 'VX_E_FIELD_INIT';
    var message = (PLAIN[code] || 'The lab failed to start.') +
      ' ' + ((err && err.message) || '') +
      ' What was kept: ' + (ctx.keptNotes.join('; ') || 'nothing yet — boot never reached the field.') +
      ' Next step: reload the page. If it persists, use Copy diagnostics and send it to Shawn.';
    var kept = ctx.keptNotes.join('; ') || null;
    var V = getV();
    if (V && V.ui && typeof V.ui.fail === 'function') {
      try { V.ui.fail(code, message, kept); } catch (e) { failFallback(code, message, kept); }
    } else {
      failFallback(code, message, kept);
    }
    emitBus('vx:error', { code: code, message: message, stage: (err && err.stage) || ctx.activeStage });
    setStatus('FAILED — ' + code);
    throw vxError(code, message, (err && err.stage) || ctx.activeStage, kept);
  }

  /* ---------------- stage implementations ---------------- */

  function stageShellDetect(ctx, opts) {
    if (MODES.indexOf(ctx.mode) < 0) {
      throw vxError('VX_E_SHELL', 'Unknown mode "' + ctx.mode + '". Expected one of: ' + MODES.join(', ') + '.', 'shell-detect', null);
    }
    if (!hasDom()) {
      throw vxError('VX_E_SHELL', 'No document object: the shell needs a DOM host (browser page or embed root).', 'shell-detect', null);
    }
    var doc = root.document;
    var rootEl = null;
    if (opts.root) {
      if (typeof opts.root === 'string') rootEl = doc.getElementById(opts.root);
      else if (opts.root.nodeType === 1) rootEl = opts.root;
    } else if (ctx.mode === 'standalone') {
      rootEl = doc.getElementById('vx-lab') || doc.body;
    }
    if (!rootEl) {
      throw vxError('VX_E_SHELL', 'Embed root not found: pass {root} for embedded/observatory mode.', 'shell-detect', null);
    }
    ctx.rootEl = rootEl;
    ctx.slots = function (id) {
      var el = null;
      try { el = rootEl.querySelector('#' + id); } catch (e) { el = null; }
      if (!el && ctx.mode === 'standalone') el = doc.getElementById(id);
      return el;
    };
    /* standalone sanity: the shell skeleton must exist */
    if (ctx.mode === 'standalone') {
      var missing = ['vx-toolbar', 'vx-canvas-wrap', 'vx-panel-dock', 'vx-footer', 'vx-status', 'vx-fatal']
        .filter(function (id) { return !ctx.slots(id); });
      if (missing.length) {
        throw vxError('VX_E_SHELL', 'Standalone shell is missing mount points: ' + missing.join(', ') + '.', 'shell-detect', null);
      }
    }
    ctx.keptNotes.push('shell: mode=' + ctx.mode);
    return Promise.resolve();
  }

  function namespaceOK() {
    var V = getV();
    return !!(V && V.version && V.bus && V.utils && V.register && V.ui &&
      typeof V.register === 'function' && typeof V.has === 'function');
  }

  function stageNamespace(ctx) {
    if (namespaceOK()) {
      ctx.keptNotes.push('namespace: preloaded ' + getV().version);
      registerApi();
      installStageListener();
      return Promise.resolve();
    }
    var url = baseUrl() + 'js/vx-namespace.js';
    /* single attempt here; the stage runner performs the one retry */
    return loadScript(url, 2000).then(function () {
      if (!namespaceOK()) {
        throw vxError('VX_E_NAMESPACE', 'js/vx-namespace.js loaded but VORTEX global is incomplete.', 'namespace', url);
      }
      ctx.keptNotes.push('namespace: loaded ' + getV().version);
      registerApi();
      installStageListener();
    }).catch(function (e) {
      if (e && e.code === 'VX_E_NAMESPACE') throw e;
      throw vxError('VX_E_NAMESPACE',
        'Could not load js/vx-namespace.js (' + ((e && e.message) || e) + ').', 'namespace', url);
    });
  }

  function stageScripts(ctx) {
    var base = baseUrl();
    var chain = Promise.resolve();
    MODULE_FILES.forEach(function (f) {
      chain = chain.then(function () {
        if (ctx.loadedScripts.indexOf(f) >= 0) return; /* stage-level retry resumes here; never double-execute */
        /* per-file: one attempt + one retry of THAT file, 8s each */
        return loadWithRetry(base + f, 8000).then(function () {
          ctx.loadedScripts.push(f);
          setStatus('INITIALIZING FIELD — scripts · ' + ctx.loadedScripts.length + '/' + MODULE_FILES.length);
        });
      });
    });
    return chain.then(function () {
      ctx.keptNotes.push('scripts: ' + ctx.loadedScripts.length + '/' + MODULE_FILES.length + ' modules loaded');
    });
    /* A rejection here already carries VX_E_SCRIPT_TIMEOUT / VX_E_SCRIPT_ERROR
     * with the file URL attached. The stage runner retries the stage once
     * (resuming at the first unloaded file), then the named on-screen error
     * fires. No hang possible. */
  }

  /* Registry id of the W15 selector module. NOTE (audit 2026-09-20): the module
   * registers as 'w15-backends' (backend-select.js); every other consumer uses
   * that id. The old 'w15-backend-select' spelling is kept as a fallback only. */
  var SELECTOR_IDS = ['w15-backends', 'w15-backend-select'];

  /* Backend name -> live module, normalized to { init(canvas, opts) }.
   * NOTE (audit 2026-09-20): the three backend modules have different shapes —
   * w14-cpu is a singleton field whose init() resolves the api itself;
   * w02-gpu is a FACTORY (create() -> backend, no .init on the module);
   * w15-webgpu is an honest stub whose init() rejects with a named error.
   * This resolver is the single place that knows the shapes, so the probe
   * stage and the selector can never disagree about them again. */
  function resolveBackend(V, name) {
    try {
      if (name === 'cpu') {
        var cpu = V.get('w14-cpu');
        if (cpu && typeof cpu.init === 'function') return cpu;
      } else if (name === 'webgl2') {
        var w02 = V.get('w02-gpu');
        if (w02 && typeof w02.create === 'function') {
          var inst = w02.create();
          if (inst && typeof inst.init === 'function') {
            return { init: function (c, o) {
              return Promise.resolve(inst.init(c, o)).then(function (f) {
                return (f && typeof f.step === 'function') ? f : inst;
              });
            } };
          }
        }
      } else if (name === 'webgpu') {
        var w15 = V.get('w15-webgpu');
        if (w15 && typeof w15.init === 'function') return w15; /* rejects honestly */
      }
    } catch (e) { /* fall through to null */ }
    return null;
  }

  function pickSelector(V) {
    /* W15 owns the selector. Guard with VORTEX.has(): other workers' modules
     * may not exist yet, and that must be a NAMED error, not a hang. */
    for (var i = 0; i < SELECTOR_IDS.length; i++) {
      if (V.has(SELECTOR_IDS[i])) return V.get(SELECTOR_IDS[i]);
    }
    return null;
  }

  function stageBackendProbe(ctx) {
    var V = getV();
    var selector = V ? pickSelector(V) : null;
    if (!selector) {
      throw vxError('VX_E_NO_BACKEND',
        'Backend selector module (w15-backends) is not loaded, so WebGPU/WebGL2/CPU cannot be probed.', 'backend-probe', null);
    }
    /* NOTE (audit 2026-09-20): the selector's entry point is selectBackend(canvas, opts).
     * Older spellings are tolerated, but the (canvas, opts) argument shape is canonical. */
    var fn = selector.selectBackend || selector.select || selector.probe || selector.pick;
    if (typeof fn !== 'function') {
      throw vxError('VX_E_NO_BACKEND',
        'Backend selector has no selectBackend/select/probe/pick function.', 'backend-probe', null);
    }
    var canvas = ctx.slots('vx-canvas');
    return withTimeout(
      Promise.resolve().then(function () {
        return fn.call(selector, canvas, { mode: ctx.mode, seed: ctx.seed });
      }),
      5000, 'VX_E_NO_BACKEND', 'backend probe', 'backend-probe'
    ).then(function (res) {
      res = res || {};
      ctx.backendName = res.name || 'unknown';
      /* The selector is the authority on tier tracers (e.g. WebGL2 → tier B =
       * 262,144). The old code ignored res.tracers and always inited the field
       * with the boot default, so the badge claimed 262,144 while the field ran
       * 4,000. Adopt the probed count — the status line then reports reality. */
      if (typeof res.tracers === 'number' && isFinite(res.tracers) && res.tracers > 0) {
        ctx.tracers = Math.floor(res.tracers);
      }
      var backendMod = resolveBackend(V, res.backend) || res.create || res.factory || null;
      if (res.steppedDown) {
        emitBus('vx:degraded', { from: res.steppedDown.from, to: res.steppedDown.to, reason: res.steppedDown.reason || 'warm-up' });
      }
      if (!backendMod || typeof backendMod.init !== 'function') {
        throw vxError('VX_E_NO_BACKEND',
          'Backend "' + ctx.backendName + '" selected but no usable module was found for it ' +
          '(selector said "' + res.backend + '").', 'backend-probe', null);
      }
      ctx.backendFactory = backendMod;
      ctx.keptNotes.push('backend-probe: ' + ctx.backendName + (res.tier ? ' tier ' + res.tier : ''));
    });
  }

  function stageFieldInit(ctx, opts) {
    var canvas = ctx.slots('vx-canvas');
    if (!canvas) {
      throw vxError('VX_E_FIELD_INIT', 'Canvas element #vx-canvas not found in the shell.', 'field-init', null);
    }
    /* size the canvas to its wrap (cosmetic; backend owns the GL state) */
    try {
      var wrap = ctx.slots('vx-canvas-wrap');
      var w = (wrap && wrap.clientWidth) || 800;
      var h = (wrap && wrap.clientHeight) || 600;
      var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
    } catch (e) { /* non-fatal */ }

    /* Step-down order for field-init (lane-14 fix 2026-09-20): the probe can
     * select WebGPU while the lane-14 WebGPU fluid solver is a documented
     * stub whose init() honestly rejects. A field-init failure must step down
     * to the next backend instead of killing the boot — CPU is the floor. */
    var ORDER = ['webgpu', 'webgl2', 'cpu'];
    var TIER_OF = { webgpu: 'B', webgl2: 'B', cpu: 'C' };
    var TRACERS_OF = { webgpu: 262144, webgl2: 262144, cpu: 4096 };
    var V = getV();
    var startIdx = ORDER.indexOf(ctx.backendName);
    if (startIdx < 0) startIdx = 0;
    var firstErr = null;
    var tried = [];

    function badgeNames() {
      try {
        var sel = pickSelector(V);
        if (sel && typeof sel.badgeNames === 'function') return sel.badgeNames();
      } catch (e) { /* fall through */ }
      return { webgpu: 'GPU · WebGPU', webgl2: 'GPU · WebGL2', cpu: 'CPU' };
    }
    function renderBadge(name) {
      try {
        var sel = pickSelector(V);
        if (sel && typeof sel.renderBackendBadge === 'function') {
          sel.renderBackendBadge(
            { name: badgeNames()[name] || name, backend: name, tier: TIER_OF[name], tracers: TRACERS_OF[name] },
            null);
        }
      } catch (e) { /* badge is cosmetic; never blocks init */ }
    }
    function describeErr(e) {
      return String((e && (e.message || e.code)) || e);
    }
    function stepDown(i, err) {
      tried.push(ORDER[i]);
      if (!firstErr) firstErr = err;
      var next = i + 1;
      if (next >= ORDER.length) {
        throw vxError('VX_E_FIELD_INIT',
          'Field failed to initialize on every backend (' + tried.join(' → ') + '). ' +
          'First failure: ' + describeErr(firstErr), 'field-init', null);
      }
      var from = ORDER[i], to = ORDER[next];
      var reason = describeErr(err);
      ctx.backendName = to;
      ctx.backendFactory = resolveBackend(V, to);
      ctx.tracers = TRACERS_OF[to];
      ctx.keptNotes.push('field-init: stepped down ' + from + ' → ' + to + ' (' + reason + ')');
      try { emitBus('vx:degraded', { from: from, to: to, reason: reason }); } catch (e) { /* bus optional */ }
      renderBadge(to);
      setStatus('BACKEND ' + from.toUpperCase() + ' UNAVAILABLE — TRYING ' + to.toUpperCase() + '…');
      return attempt(next);
    }
    function attempt(i) {
      var name = ORDER[i];
      var b = (i === startIdx) ? ctx.backendFactory : resolveBackend(V, name);
      if (!b || typeof b.init !== 'function') {
        return stepDown(i, vxError('VX_E_FIELD_INIT',
          'Backend "' + name + '" has no init(canvas, opts).', 'field-init', null));
      }
      var initP = Promise.resolve().then(function () {
        return b.init(canvas, { tracers: (i === startIdx) ? ctx.tracers : TRACERS_OF[name], seed: ctx.seed, config: ctx.configId });
      });
      return withTimeout(initP, 10000, 'VX_E_FIELD_INIT', 'field init', 'field-init')
        .then(function (field) {
          if (!field || typeof field.step !== 'function' || typeof field.render !== 'function') {
            throw vxError('VX_E_FIELD_INIT',
              'Backend "' + name + '" did not return a field with step()/render().', 'field-init', null);
          }
          return field;
        })
        .catch(function (e) { return stepDown(i, e); });
    }
    return attempt(startIdx).then(function (field) {
      ctx.field = field;
      /* NOTE (audit 2026-09-20): getTracers() returns {count, simulated} —
       * `simulated` is a BOOLEAN. The old code read t.simulated as the count
       * and the UI printed "true tracers". */
      try {
        var t = field.getTracers ? field.getTracers() : null;
        if (t && typeof t.count === 'number' && isFinite(t.count)) ctx.tracers = t.count;
      } catch (e) { /* keep default */ }
      ctx.keptNotes.push('field-init: ' + ctx.backendName + ' live, ' + ctx.tracers + ' tracers');
    });
  }

  /* ---------------- chrome (NON-FATAL) ---------------- */

  function uiAnnounce(ctx, msg) {
    var V = getV();
    if (V && V.ui && typeof V.ui.announce === 'function') {
      try { V.ui.announce(msg); return; } catch (e) { /* fall through */ }
    }
    if (hasDom()) {
      var f = ctx.slots('vx-footer');
      if (f) {
        var d = root.document.createElement('div');
        d.className = 'vx-announce';
        d.textContent = String(msg);
        f.appendChild(d);
      }
    }
  }

  function wireChrome(ctx) {
    var V = getV();
    var S = ctx.slots;
    var doc = root.document;
    var readonly = (ctx.mode === 'observatory');

    var badge = S('vx-backend-badge');
    if (badge) badge.textContent = 'backend: ' + (ctx.backendName || '—');

    /* Move / Stir / Orbit: toggle + bus event; behavior hooks are W22/W20's. */
    ['move', 'stir', 'orbit'].forEach(function (m) {
      var b = S('vx-btn-' + m);
      if (!b) return;
      if (readonly) { b.disabled = true; b.title = 'Observatory: observe only'; return; }
      b.addEventListener('click', function () {
        ['move', 'stir', 'orbit'].forEach(function (x) {
          var o = S('vx-btn-' + x);
          if (o) { o.classList.toggle('active', x === m); o.setAttribute('aria-pressed', x === m ? 'true' : 'false'); }
        });
        emitBus('vx:mode', { mode: m });
        uiAnnounce(ctx, 'Mode: ' + m);
      });
    });
    var stir = S('vx-btn-stir');
    if (stir) { stir.classList.add('active'); stir.setAttribute('aria-pressed', 'true'); }

    /* Presets: guarded on w18-presets; otherwise announce honestly. */
    [['spiral', 'vx-preset-spiral'], ['collision', 'vx-preset-collision'], ['wake', 'vx-preset-wake']]
      .forEach(function (pair) {
        var id = pair[0], b = S(pair[1]);
        if (!b) return;
        if (readonly) { b.disabled = true; b.title = 'Observatory: observe only'; return; }
        b.addEventListener('click', function () {
          emitBus('vx:preset', { preset: id });
          var lib = (V && V.has('w18-presets')) ? V.get('w18-presets') : null;
          if (lib && typeof lib.apply === 'function') {
            try { lib.apply(id); uiAnnounce(ctx, 'Preset: ' + id); }
            catch (e) { uiAnnounce(ctx, 'Preset "' + id + '" rejected: ' + (e.message || e)); }
          } else {
            uiAnnounce(ctx, 'Preset "' + id + '" noted — preset library not loaded yet.');
          }
        });
      });

    /* Sliders -> backend uniforms (no recompile), guarded on field. */
    var sliderDefs = [
      ['circulation', 'vx-slider-circulation', 'vx-out-circulation'],
      ['turbulence', 'vx-slider-turbulence', 'vx-out-turbulence'],
      ['persistence', 'vx-slider-persistence', 'vx-out-persistence']
    ];
    sliderDefs.forEach(function (def) {
      var name = def[0], input = S(def[1]), out = S(def[2]);
      if (!input) return;
      if (readonly) { input.disabled = true; return; }
      var apply = function () {
        var v = Number(input.value);
        if (out) out.textContent = String(v);
        var p = {};
        p[name] = v / 100;
        if (ctx.field && typeof ctx.field.setParams === 'function') {
          try { ctx.field.setParams(p); }
          catch (e) { uiAnnounce(ctx, 'Slider rejected: ' + (e.message || e)); }
        }
      };
      input.addEventListener('input', apply);
      apply();
    });

    /* Probes: always emit on the bus; inject only with catalog + field. */
    var probeDefs = [
      ['vx-probe-oppose', 'Oppose winding', 'oppose-winding'],
      ['vx-probe-wake', 'Test the wake', 'test-wake'],
      ['vx-probe-perturb', 'Perturb the field', 'perturb-field']
    ];
    probeDefs.forEach(function (def) {
      var b = S(def[0]);
      if (!b) return;
      if (readonly) { b.disabled = true; b.title = 'Observatory: observe only'; return; }
      b.addEventListener('click', function () {
        var label = def[1], pid = def[2];
        emitBus('vx:probe', { probe: pid, params: {} });
        var cat = (V && V.has('w05-probe-catalog')) ? V.get('w05-probe-catalog') : null;
        if (cat && ctx.field && typeof ctx.field.addProbe === 'function') {
          try {
            var spec = (typeof cat.get === 'function') ? cat.get(pid) : { id: pid };
            ctx.field.addProbe(spec);
            uiAnnounce(ctx, 'Probe injected: ' + label);
          } catch (e) { uiAnnounce(ctx, 'Probe rejected: ' + (e.message || e)); }
        } else {
          uiAnnounce(ctx, 'Probe "' + label + '" noted — probe catalog/field not loaded yet.');
        }
      });
    });

    /* Other workers' panels mount here. One remount retry per panel, then
     * mark degraded and move on — chrome never kills the lab. */
    var dock = S('vx-panel-dock');
    var panels = (V && V.ui && typeof V.ui.panels === 'function') ? V.ui.panels() : [];
    panels.forEach(function (p) {
      var sec = doc.createElement('section');
      sec.className = 'vx-panel';
      sec.id = 'vx-panel-' + p.id;
      var h = doc.createElement('h3');
      h.textContent = p.title;
      sec.appendChild(h);
      var body = doc.createElement('div');
      body.className = 'vx-panel-body';
      sec.appendChild(body);
      if (dock) dock.appendChild(sec);
      try {
        p.mount(body);
      } catch (e1) {
        try { body.innerHTML = ''; p.mount(body); }
        catch (e2) {
          sec.classList.add('vx-panel-degraded');
          uiAnnounce(ctx, 'Panel "' + p.title + '" failed to mount: ' + ((e2 && e2.message) || e2));
          ctx.chromeDegraded = true;
        }
      }
    });

    /* Footer chips: boot's own; W11 (governor) / W32 (lab metrics) add theirs. */
    var chips = S('vx-chips');
    if (chips) {
      chips.innerHTML = '';
      var chipData = [
        'VORTEX ' + (V && V.version ? V.version : '?.?.?'),
        'mode:' + ctx.mode,
        'tracers:' + ctx.tracers
      ];
      chipData.forEach(function (t) {
        var c = doc.createElement('span');
        c.className = 'vx-chip';
        c.textContent = t;
        chips.appendChild(c);
      });
    }
  }

  function stageChrome(ctx) {
    /* Non-fatal by contract: lab stays usable. Per-panel retry lives inside
     * wireChrome; a stage-level throw degrades instead of rejecting boot. */
    try {
      wireChrome(ctx);
      if (ctx.chromeDegraded) {
        emitBus('vx:error', { code: 'VX_E_CHROME', message: 'one or more panels failed to mount', stage: 'chrome' });
        uiAnnounce(ctx, 'Some lab chrome failed to mount — the lab remains usable.');
      }
    } catch (e) {
      ctx.chromeDegraded = true;
      emitBus('vx:error', { code: 'VX_E_CHROME', message: (e && e.message) || String(e), stage: 'chrome' });
      uiAnnounce(ctx, 'Lab chrome hit an error (' + ((e && e.message) || e) + ') — continuing without it.');
    }
    return Promise.resolve();
  }

  /* The host animation loop. NOTE (audit 2026-09-20): nothing ever started this —
   * the field initialized and the page showed "Ready" while the canvas stayed
   * black. The director (w20-director) is the time-control ADVISOR: its frame()
   * tells the host how many fixed steps to run this rAF. The host (here) steps
   * the field, renders it, and feeds frame times to the governor (w11-governor).
   * Browser-only; headless self-tests never enter it. */
  function startMainLoop(ctx) {
    var V = getV();
    if (!V || !V.utils || !V.utils.isBrowser()) return null;
    if (typeof requestAnimationFrame !== 'function') return null;
    var field = ctx.field;
    if (!field) return null;
    var director = null, governor = null;
    try { director = V.get('w20-director'); } catch (e) { /* optional */ }
    try { governor = V.get('w11-governor'); } catch (e) { /* optional */ }
    var state = { running: true, raf: 0, lastT: 0, frames: 0, failStreak: 0,
      stop: function () {
        state.running = false;
        try { cancelAnimationFrame(state.raf); } catch (e) { /* ignore */ }
      } };
    function frame(t) {
      if (!state.running) return;
      state.raf = requestAnimationFrame(frame);
      var dt = state.lastT ? Math.min((t - state.lastT) / 1000, 0.25) : V.SIM_DT;
      state.lastT = t;
      try {
        var steps = 1;
        if (director && typeof director.frame === 'function') {
          var fr = director.frame(dt);
          steps = fr.paused ? 0 : Math.max(0, Math.min(fr.steps | 0, 8)); /* clamp: never death-spiral */
        }
        var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        for (var i = 0; i < steps; i++) field.step();
        field.render();
        var ms = t0 ? performance.now() - t0 : 0;
        if (governor && typeof governor.ingestFrame === 'function') {
          try { governor.ingestFrame(ms); } catch (e) { /* governor never breaks the loop */ }
        }
        /* vx:frame is the lab's observable frame tick (monitors, onboarding
         * tour). dt is wall seconds; simMs is the measured step+render cost. */
        try {
          emitBus('vx:frame', { dt: dt, simMs: ms, steps: steps, frame: state.frames,
            backend: ctx.backendName, paused: steps === 0 });
        } catch (e) { /* bus never breaks the loop */ }
        state.frames++;
        state.failStreak = 0;
      } catch (e) {
        state.failStreak++;
        if (state.failStreak >= 30) {
          state.stop();
          uiFail(ctx, 'VX_E_FIELD_INIT',
            'The render loop failed 30 frames in a row (' + (e && e.message) + '). Reload to retry.');
        }
      }
    }
    state.raf = requestAnimationFrame(frame);
    return state;
  }

  function stageReady(ctx) {
    var label = 'Ready — ' + (ctx.backendName || 'unknown backend') + ' · ' + ctx.tracers + ' tracers';
    setStatus(label);
    var st = ctx.slots('vx-status');
    if (st) st.classList.add('vx-ready');
    /* Debug handle: the lab bus + live context, read-only from the console.
     * Lets owners (and audits) observe vx:frame / vx:ready / vx:error. */
    try {
      var V = getV();
      root.window.__vortex = {
        bus: V.bus, ctx: ctx, ns: V,
        frames: function () { return ctx.loop ? ctx.loop.frames : -1; }
      };
    } catch (e) { /* debug handle never breaks boot */ }
    ctx.loop = startMainLoop(ctx);
    emitBus('vx:ready', { backend: ctx.field, backendName: ctx.backendName, tracers: ctx.tracers });
    return Promise.resolve({ backend: ctx.field, backendName: ctx.backendName, tracers: ctx.tracers, mode: ctx.mode, loop: ctx.loop });
  }

  var STAGE_FNS = {
    'shell-detect': stageShellDetect,
    'namespace': stageNamespace,
    'scripts': stageScripts,
    'backend-probe': stageBackendProbe,
    'field-init': stageFieldInit,
    'chrome': stageChrome,
    'ready': stageReady
  };

  function normalizeStageError(def, e) {
    if (e && KNOWN_CODES.indexOf(e.code) >= 0) {
      if (!e.stage) e.stage = def.name;
      return e;
    }
    var code = def.error || 'VX_E_FIELD_INIT';
    return vxError(code, (e && e.message) || String(e), def.name, null);
  }

  function runStageAttempt(def, ctx, opts) {
    /* One attempt gets the stage's full timeout. On failure: one retry with
     * a fresh full timeout, then the named error. Retries re-enter the stage
     * fn, which is written to resume (scripts skip already-loaded files). */
    function once() {
      var p = Promise.resolve().then(function () { return STAGE_FNS[def.name](ctx, opts); });
      if (def.timeoutMs > 0) {
        p = withTimeout(p, def.timeoutMs, def.error || 'VX_E_FIELD_INIT', 'stage ' + def.name, def.name);
      }
      return p;
    }
    function failed(e) { throw normalizeStageError(def, e); }
    return once().catch(function (e1) {
      if (def.retries > 0 && def.fatal !== false) {
        emitStage(def.name, 'retry');
        setStatus('INITIALIZING FIELD — ' + def.name + ' (retry)…');
        return once().catch(failed);
      }
      return failed(e1);
    });
  }

  function runBoot(opts) {
    var ctx = makeCtx(opts || {});
    var settled = false;
    var watchdogReject = null;

    var chain = Promise.resolve();
    var result = null;
    STAGES.forEach(function (def) {
      chain = chain.then(function () {
        if (settled) return;
        ctx.activeStage = def.name;
        emitStage(def.name, 'start');
        if (def.name !== 'ready') setStatus('INITIALIZING FIELD — ' + def.name + '…');
        return runStageAttempt(def, ctx, opts).then(function (r) {
          emitStage(def.name, 'ok');
          if (def.name === 'ready') result = r;
        }, function (err) {
          if (def.fatal === false) {
            /* chrome: non-fatal by contract — degraded, lab stays usable */
            emitStage(def.name, 'degraded');
            ctx.chromeDegraded = true;
            return;
          }
          throw err; /* runStageAttempt already normalized + retried */
        });
      });
    });

    var done = new Promise(function (resolve, reject) {
      watchdogReject = reject;
      chain.then(resolve, reject);
    });

    var watchdog = setTimeout(function () {
      if (settled || !watchdogReject) return;
      settled = true;
      var def = null;
      for (var i = 0; i < STAGES.length; i++) {
        if (STAGES[i].name === ctx.activeStage) { def = STAGES[i]; break; }
      }
      def = def || STAGES[4];
      var err = vxError(def.error || 'VX_E_FIELD_INIT',
        'Boot watchdog fired: stage "' + ctx.activeStage + '" never settled.', ctx.activeStage, null);
      try { failBoot(ctx, err); } catch (e) { watchdogReject(e); }
    }, WATCHDOG_MS);
    if (watchdog.unref) { try { watchdog.unref(); } catch (e) {} }

    installStageListener();

    return done.then(function () {
      settled = true;
      clearTimeout(watchdog);
      return result || { backend: ctx.field || null, backendName: ctx.backendName, tracers: ctx.tracers, mode: ctx.mode };
    }, function (err) {
      settled = true;
      clearTimeout(watchdog);
      return failBoot(ctx, err);
    });
  }

  function boot(opts) {
    /* Cache in-flight + successful boots (idempotent). Failures clear the
     * cache so a later boot() can retry after the cause is fixed. */
    if (!bootCache) {
      bootCache = runBoot(opts || {}).catch(function (e) {
        bootCache = null;
        throw e;
      });
    }
    return bootCache;
  }

  /* ------------------------------------------------------------------ */
  /* Registration                                                        */
  /* ------------------------------------------------------------------ */
  var api = {
    boot: boot,
    selfTest: selfTest,
    runSelfTestAsync: runSelfTestAsync,
    STAGES: STAGES,
    MODULE_FILES: MODULE_FILES
  };

  function registerApi() {
    var V = getV();
    if (!V || typeof V.register !== 'function') return false;
    if (typeof V.has === 'function' && V.has('w01-init')) return true; /* double include: keep first */
    try {
      V.register('w01-init', api);
      if (!V.init) V.init = { boot: boot };
      return true;
    } catch (e) { return false; }
  }

  registerApi(); /* no-op until the namespace stage loads VORTEX */

  /* Pre-namespace global: vortex.html calls VortexInit.boot() — VORTEX does
   * not exist yet at that point by design (init.js loads it). */
  root.VortexInit = root.VortexInit || { boot: boot, STAGES: STAGES, MODULE_FILES: MODULE_FILES };

  /* ------------------------------------------------------------------ */
  /* selfTest — headless-safe: guard DOM, skip with a note, never throw.  */
  /* ------------------------------------------------------------------ */
  function check(name, ok, detail) {
    return { name: name, ok: !!ok, detail: String(detail) };
  }

  function selfTest() {
    var checks = [];
    try {
      /* 1. stage table completeness: every stage has timeout + error + retry */
      var names = STAGES.map(function (s) { return s.name; });
      var expected = ['shell-detect', 'namespace', 'scripts', 'backend-probe', 'field-init', 'chrome', 'ready'];
      var orderOk = expected.length === names.length &&
        expected.every(function (n, i) { return names[i] === n; });
      checks.push(check('stage-table-order', orderOk,
        orderOk ? '7 stages in CONTRACTS §4 order' : 'got: ' + names.join(',')));
      var complete = STAGES.every(function (s) {
        return typeof s.name === 'string' && typeof s.timeoutMs === 'number' && s.timeoutMs >= 0 &&
          typeof s.retries === 'number' && s.retries >= 0 &&
          (s.name === 'ready' ? s.error === null : KNOWN_CODES.indexOf(s.error) >= 0);
      });
      checks.push(check('stage-table-complete', complete,
        complete ? 'every stage has timeoutMs, named VX_E_* error (null only for ready), retries'
                 : 'a stage is missing timeout/error/retry'));
      var scripts = STAGES.filter(function (s) { return s.name === 'scripts'; })[0];
      checks.push(check('scripts-stage-timeout', scripts && scripts.timeoutMs === 8000 && scripts.perScript === true,
        'scripts stage: 8s per script, one retry'));

      /* 2. load order contract */
      var orderOk2 = MODULE_FILES.length === 34 &&
        MODULE_FILES[0] === 'js/field-contract.js' &&
        MODULE_FILES[MODULE_FILES.length - 1] === 'js/integration.js' &&
        MODULE_FILES.indexOf('js/substrate.js') > 0 &&
        MODULE_FILES.indexOf('vortex-embed.js') < 0 &&
        MODULE_FILES.every(function (f) { return /^js\/[a-z0-9-]+\.js$/.test(f); });
      var dupes = MODULE_FILES.some(function (f, i) { return MODULE_FILES.indexOf(f) !== i; });
      checks.push(check('module-load-order', orderOk2 && !dupes,
        orderOk2 && !dupes ? '34 js/* modules in CONTRACTS §10 order, namespace first via its own stage, embed entry excluded'
                           : 'load order deviates from CONTRACTS §10'));

      /* 3. error vocabulary covers every fatal stage */
      var vocabOk = KNOWN_CODES.every(function (c) { return typeof PLAIN[c] === 'string' && PLAIN[c].length > 0; });
      checks.push(check('error-vocabulary', vocabOk,
        vocabOk ? KNOWN_CODES.length + ' named codes each have a plain-language sentence' : 'missing plain text'));

      /* 4. api shape */
      checks.push(check('api-shape',
        typeof api.boot === 'function' && typeof api.selfTest === 'function' &&
        typeof api.runSelfTestAsync === 'function' && Array.isArray(api.STAGES),
        'boot/selfTest/runSelfTestAsync/STAGES present'));

      /* 5. registration (guard: namespace may not be loaded in this context) */
      var V = getV();
      if (V && typeof V.has === 'function') {
        checks.push(check('registered', V.has('w01-init'), 'VORTEX.has("w01-init") === true'));
      } else {
        checks.push(check('registered', true, 'skipped: VORTEX namespace not loaded in this context (headless pre-boot)'));
      }

      /* 6. loader rejects-without-DOM: the promise must reject, never throw
       * synchronously and never hang. The async settlement itself is asserted
       * in runSelfTestAsync(); here we only assert the sync contract. */
      var loaderSyncOk = false;
      try {
        var p = loadScript('js/__w01-probe__.js', 50);
        loaderSyncOk = !!(p && typeof p.then === 'function');
        if (p && typeof p.catch === 'function') p.catch(function () { /* expected */ });
      } catch (e) { loaderSyncOk = false; }
      checks.push(check('loader-sync-contract', loaderSyncOk,
        loaderSyncOk ? 'loadScript() returns a rejecting promise without throwing (no DOM: immediate named rejection)'
                     : 'loadScript() threw synchronously — must return a promise'));

      /* 7. boot() returns a thenable without throwing synchronously.
       * Uses a bogus mode on purpose: it fails fast at shell-detect with
       * VX_E_SHELL and never touches scripts — safe to call from a test in
       * any environment. The async rejection is asserted in A3. */
      var bootSyncOk = false;
      try {
        var b = boot({ mode: 'nope-not-a-mode' });
        bootSyncOk = !!(b && typeof b.then === 'function');
        if (b && typeof b.catch === 'function') {
          b.catch(function () { /* expected: VX_E_SHELL, fast */ });
        }
      } catch (e) { bootSyncOk = false; }
      checks.push(check('boot-sync-contract', bootSyncOk,
        bootSyncOk ? 'boot() returns a promise without throwing synchronously (bad mode -> fast VX_E_SHELL, asserted async in A3)'
                   : 'boot() threw synchronously'));

      /* 8. async coverage pointer (DOM-only 404 simulation can't run sync) */
      checks.push(check('async-loader-tests',
        true,
        hasDom() ? 'skipped in sync path — call runSelfTestAsync() for the 404/timeout rejection proofs'
                 : 'headless: runSelfTestAsync() covers no-DOM loader rejection + timeout machinery'));
    } catch (e) {
      checks.push(check('selftest-did-not-throw', false, 'selfTest threw: ' + (e && e.message)));
      return { ok: false, checks: checks };
    }
    return { ok: checks.every(function (c) { return c.ok; }), checks: checks };
  }

  /* Async proofs: boot rejects (not hangs) on 404/timeout; timeout
   * machinery fires with the named error. Headless-safe. */
  function runSelfTestAsync() {
    var checks = [];
    var sync = selfTest();
    checks = checks.concat(sync.checks);
    var seq = Promise.resolve();

    /* A1. bogus script URL -> named rejection, fast (404 path). */
    seq = seq.then(function () {
      var t0 = Date.now();
      var url = baseUrl() + 'js/__w01-bogus-' + Date.now().toString(36) + '.js';
      return loadWithRetry(url, 400).then(function () {
        checks.push(check('loader-404-rejects', false, 'bogus URL unexpectedly loaded: ' + url));
      }, function (e) {
        var named = e && (e.code === 'VX_E_SCRIPT_ERROR' || e.code === 'VX_E_SCRIPT_TIMEOUT');
        var fast = (Date.now() - t0) < 5000;
        checks.push(check('loader-404-rejects', named && fast,
          'bogus URL rejected with ' + (e && e.code) + ' in ' + (Date.now() - t0) + 'ms (named error, no hang)'));
      });
    });

    /* A2. timeout machinery: a never-settling promise -> VX_E_SCRIPT_TIMEOUT. */
    seq = seq.then(function () {
      var t0 = Date.now();
      var never = new Promise(function () { /* never settles: the timeout must */ });
      return withTimeout(never, 150, 'VX_E_SCRIPT_TIMEOUT', 'selftest-never', 'scripts').then(function () {
        checks.push(check('timeout-machinery', false, 'withTimeout resolved a never-settling promise'));
      }, function (e) {
        var ok = e && e.code === 'VX_E_SCRIPT_TIMEOUT' && (Date.now() - t0) < 2000;
        checks.push(check('timeout-machinery', ok,
          'never-settling promise rejected with VX_E_SCRIPT_TIMEOUT in ' + (Date.now() - t0) + 'ms'));
      });
    });

    /* A3. boot() with a bad mode rejects with a named error (no hang). */
    seq = seq.then(function () {
      var t0 = Date.now();
      var b;
      try { b = boot({ mode: 'nope-not-a-mode' }); }
      catch (e) {
        checks.push(check('boot-bad-mode-rejects', false, 'boot() threw synchronously'));
        return;
      }
      /* note: a previous failed boot clears the cache, so this runs fresh */
      return b.then(function () {
        checks.push(check('boot-bad-mode-rejects', false, 'boot() resolved with a bad mode'));
      }, function (e) {
        var ok = e && e.code === 'VX_E_SHELL' && (Date.now() - t0) < 8000;
        checks.push(check('boot-bad-mode-rejects', ok,
          'boot({mode:"nope-not-a-mode"}) rejected with VX_E_SHELL in ' + (Date.now() - t0) + 'ms'));
      });
    });

    return seq.then(function () {
      return { ok: checks.every(function (c) { return c.ok; }), checks: checks };
    });
  }

})(typeof window !== 'undefined' ? window : globalThis);
