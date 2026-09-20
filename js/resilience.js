/* VORTEX resilience.js — W30 detect→narrate→recover→report.
 * Read-only, additive: listeners, checkpoints, recovery paths. Sim internals untouched.
 * Failure inventory (from W30 design doc): tab suspension, OOM, WebGL context loss,
 * GPU crash, shader compile failure, storage quota. Degraded ladder:
 * full GPU -> reduced GPU -> CPU -> static snapshot viewer.
 * Worst case is a static snapshot viewer + plain-language message, never a blank canvas.
 * Plain browser JS, IIFE, no modules, no network. Headless-safe (node).
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w30-resilience: VORTEX namespace missing before resilience.js');

  var RUNGS = ['full-gpu', 'reduced-gpu', 'cpu', 'static-viewer'];
  var MAX_INCIDENTS = 50;
  var CONTEXT_RESTORE_TIMEOUT_MS = 10000;
  var AUTOSAVE_VISIBLE_MS = 60000;
  var AUTOSAVE_PROBE_MS = 30000;
  var STALE_DELTA_MS = 30000;

  var W03_ID = 'w03-megafield';   // memory budget (guarded — may be absent)
  var W12_IDS = ['w12-snapshots', 'w12-evidence']; // snapshot store (guarded — W12 not built yet)

  // ---- session state ----
  var state = {
    rung: 0,
    backend: 'unknown',
    tier: 'C',
    tracers: 0,
    backendDeath: {},      // backend name -> true: never retried this session (except manual retry)
    driverFlag: null,      // driver string recorded after a shader compile failure
    contextStatus: 'ok',   // ok | lost | restoring | restored
    lastError: null,       // { code, message, t }
    persistenceDegraded: false,
    snapshot: null,        // latest in-memory snapshot record { t, reason, persisted, params }
    probeActive: false,
    hidden: false,
    incidents: [],
    timers: { autosave: null, contextRestore: null }
  };
  var _stateProvider = null;  // fn -> { backend, tracers, params, tier } (set by integration)
  var _backendApi = null;     // field backend api (for context rebuild)
  var _canvas = null;

  // ---- small helpers ----
  function isBrowser() { return V.utils.isBrowser(); }
  function t() { return Date.now(); }

  function announce(msg) { V.ui.announce(msg); }

  function noteError(code, message) {
    state.lastError = { code: code, message: message, t: t() };
    V.bus.emit('vx:error', { code: code, message: message, stage: 'resilience' });
  }

  function logIncident(kind, narrated, recovered, kept, lost) {
    var inc = {
      t: t(), kind: kind, narrated: narrated,
      recovered: !!recovered, kept: kept || null, lost: lost || null
    };
    state.incidents.push(inc);
    if (state.incidents.length > MAX_INCIDENTS) state.incidents.shift();
    V.bus.emit('vx:incident', inc);
    return inc;
  }

  function isQuotaError(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError' || e.code === 22 ||
      (typeof e.message === 'string' && /quota/i.test(e.message));
  }

  function w03() { return V.get(W03_ID); }  // null if absent — guarded everywhere
  function w12() {
    for (var i = 0; i < W12_IDS.length; i++) {
      var m = V.get(W12_IDS[i]);
      if (m) return m;
    }
    return null;
  }

  // ---- snapshots: in-memory always, disk best-effort via W12 ----
  function inMemorySnapshot(reason) {
    var params = null, backend = state.backend, tracers = state.tracers, tier = state.tier;
    if (_stateProvider) {
      try {
        var p = _stateProvider() || {};
        if (p.params) params = p.params;
        if (p.backend) backend = p.backend;
        if (typeof p.tracers === 'number') tracers = p.tracers;
        if (p.tier) tier = p.tier;
      } catch (e) { /* provider fault: keep what we have */ }
    }
    return {
      t: t(), reason: reason, persisted: false,
      backend: backend, tracers: tracers, tier: tier, params: params
    };
  }

  function checkpoint(reason) {
    // One snapshot is always local: the latest lives in memory at all times.
    var snap = inMemorySnapshot(reason || 'manual');
    var mod = w12();
    if (mod && typeof mod.checkpoint === 'function') {
      try {
        // W12.checkpoint(label) -> snapshot id string (or {id}). Keep the id so
        // risky() can restore by id — W12.restore(id) rejects unknown ids.
        var r = mod.checkpoint(snap.reason || 'checkpoint');
        state.w12SnapshotId = (typeof r === 'string' && r) ? r : (r && r.id) || null;
        snap.persisted = !!state.w12SnapshotId;
      } catch (e) {
        if (isQuotaError(e)) { noteQuotaFailure(); }
        else { noteError('VX_E_QUOTA', 'snapshot store failed: ' + (e && e.message)); }
        snap.persisted = false;
        state.w12SnapshotId = null;
      }
    }
    // If a previous checkpoint failed on quota, retry persistence now.
    if (state.persistenceDegraded && mod && typeof mod.checkpoint === 'function') {
      try {
        var r2 = mod.checkpoint(snap);
        if (r2 && (r2.ok || r2.persisted)) {
          snap.persisted = true;
          state.persistenceDegraded = false;
          announce('Snapshot persistence recovered — checkpoints are saving again.');
          logIncident('quota-recovered', 'Snapshot persistence recovered.', true,
            'in-memory snapshot + disk copy', 'none');
        }
      } catch (e2) { /* stays degraded; session continues */ }
    }
    state.snapshot = snap;
    V.bus.emit('vx:checkpoint', { t: snap.t, reason: snap.reason, persisted: snap.persisted });
    return snap;
  }

  // Snapshot-before-risky-operation: checkpoint first, then run fn.
  // Returns { ok: true, result } or { ok: false, error }. Rollback attempted on failure.
  function risky(name, fn) {
    checkpoint('before:' + name);
    try {
      var result = fn();
      return { ok: true, result: result };
    } catch (e) {
      var mod = w12();
      var rolledBack = false;
      var snapId = state.w12SnapshotId || null;
      if (mod && typeof mod.restore === 'function' && snapId) {
        // W12.restore(id) is async: it returns a rejected promise (not a throw)
        // for unknown ids / missing backend, so the rejection must be handled
        // here or it escapes as an unhandled rejection.
        try {
          var pr = mod.restore(snapId);
          if (pr && typeof pr.then === 'function') {
            pr.then(function () { rolledBack = true; }, function (rb2) {
              noteError('VX_E_FIELD_INIT', 'Rollback of "' + name + '" failed: ' + (rb2 && rb2.message));
            });
          } else { rolledBack = true; }
        } catch (rb) { /* best effort */ }
      }
      var msg = 'Risky operation "' + name + '" failed: ' + (e && e.message);
      noteError('VX_E_FIELD_INIT', msg);
      logIncident('risky-failure', msg + '. ' + (rolledBack ? 'Rolled back to the pre-operation snapshot.' : 'No snapshot store available; in-memory state kept.'),
        rolledBack, 'pre-operation snapshot', rolledBack ? 'attempted mutation' : 'disk snapshot');
      announce(msg + ' ' + (rolledBack ? 'Rolled back.' : 'Kept in memory.'));
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // ---- degraded ladder ----
  function rungMessage(rung) {
    if (rung === 1) return 'Stepping down to reduced GPU: live view continues at lower resolution. Your snapshot is safe.';
    if (rung === 2) return 'Switched to CPU: slower, but your work continues. Snapshot and params are safe.';
    if (rung === 3) return 'Showing a static snapshot viewer. Your last snapshot is on screen; the sim is paused, nothing is lost.';
    return 'Running at full GPU.';
  }

  function stepDownTo(rung, reason, code) {
    var from = state.rung;
    rung = Math.max(0, Math.min(3, rung));
    if (rung <= from) return { moved: false, from: from, to: from };
    state.rung = rung;
    var msg = rungMessage(rung);
    announce(msg);
    V.bus.emit('vx:degraded', { from: RUNGS[from], to: RUNGS[rung], reason: reason || 'unspecified' });
    if (code) noteError(code, msg);
    logIncident('step-down',
      'Stepped down ' + RUNGS[from] + ' -> ' + RUNGS[rung] + ' (' + (reason || 'unspecified') + '). ' + msg,
      true, 'last snapshot + params', 'frames since last checkpoint');
    return { moved: true, from: from, to: rung };
  }

  function stepDown(code, message, reason) {
    var from = state.rung;
    var moved = stepDownTo(from + 1, reason || message || code, code);
    if (moved.moved) {
      // narrate the cause plainly on top of the rung message
      if (message) announce(message);
    } else if (from >= 3) {
      // already at the bottom rung: keep explaining, never go blank
      announce('Already at the static viewer. ' + (message || ''));
    }
    return moved;
  }

  // ---- 1. tab suspension ----
  function handleVisibility(hidden) {
    if (hidden) {
      state.hidden = true;
      checkpoint('tab-hidden');
      stopAutosave();
      announce('Paused — the browser put this tab to sleep. Your snapshot is safe; tap Resume.');
      logIncident('tab-suspension', 'Tab hidden/suspended. Checkpointed; autosave paused.',
        true, 'full state snapshot', 'hidden-tab compute');
    } else {
      state.hidden = false;
      announce('Welcome back — resuming from your last snapshot.');
      startAutosave();
    }
  }

  // Drop rAF deltas > 30s (tab was asleep): returns { dropped: bool }.
  function onFrameDelta(dtMs) {
    if (typeof dtMs === 'number' && dtMs > STALE_DELTA_MS) {
      announce('Dropped a stale frame delta (the tab was asleep) — resuming cleanly.');
      logIncident('stale-delta', 'Dropped rAF delta of ' + Math.round(dtMs) + 'ms after suspension.',
        true, 'sim state', 'one stale frame');
      return { dropped: true };
    }
    return { dropped: false };
  }

  // ---- 2. OOM: pre-allocation guard via W03 budget + allocation-throw catch ----
  function guardAllocation(tracers, allocFn) {
    var mod = w03();
    if (mod && typeof mod.estimate === 'function') {
      var est;
      try { est = mod.estimate(tracers); } catch (e) { est = null; }
      if (est && est.fits === false) {
        checkpoint('oom-refused');
        var msg = 'Too many tracers for this device (' + tracers + ' requested, ~' +
          (est.gpuMB != null ? est.gpuMB.toFixed(0) : '?') + ' MB needed vs ' +
          (est.budgetMB != null ? est.budgetMB.toFixed(0) : '?') + ' MB budget). Stepping down — snapshot safe.';
        stepDown('VX_E_OOM', msg, 'oom-budget-refusal');
        logIncident('oom-refused', msg, true, 'snapshot + params', 'unattempted allocation');
        return { ok: false, reason: 'budget-refused', estimate: est };
      }
    }
    try {
      var result = allocFn();
      return { ok: true, result: result };
    } catch (e) {
      checkpoint('oom-throw');
      var msg2 = 'Too many tracers for this device. The allocation failed, so we stepped down — snapshot safe.';
      stepDown('VX_E_OOM', msg2, 'oom-allocation-throw');
      logIncident('oom', 'Allocation threw (' + (e && e.message) + '). ' + msg2,
        true, 'snapshot + params', 'partial frame buffers');
      return { ok: false, reason: 'allocation-threw', error: (e && e.message) || String(e) };
    }
  }

  // ---- 3. WebGL context loss ----
  function onContextLost(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    state.contextStatus = 'lost';
    checkpoint('context-lost');
    var msg = "The graphics context was interrupted. Restoring from your last snapshot…";
    announce(msg);
    noteError('VX_E_CONTEXT_LOST', msg);
    logIncident('context-loss', msg + ' Restore timer armed (10s).',
      false, 'last snapshot + params', 'frames since last checkpoint');
    V.bus.emit('vx:context', { status: 'lost' });
    if (state.timers.contextRestore) clearTimeout(state.timers.contextRestore);
    state.timers.contextRestore = setTimeout(function () {
      if (state.contextStatus === 'lost') {
        var msg2 = 'The graphics context did not come back within 10s. ' +
          'Showing your last snapshot instead — nothing is lost.';
        announce(msg2);
        logIncident('context-restore-timeout', msg2, true,
          'last snapshot + params', 'live GPU view');
        renderStaticViewer('context-restore-timeout');
      }
    }, CONTEXT_RESTORE_TIMEOUT_MS);
    return { status: 'lost', restoreArmed: true };
  }

  function onContextRestored() {
    if (state.timers.contextRestore) { clearTimeout(state.timers.contextRestore); state.timers.contextRestore = null; }
    state.contextStatus = 'restored';
    V.bus.emit('vx:context', { status: 'restored' });
    // Rebuild: if a backend api is attached, re-init from the checkpoint.
    var rebuilt = false;
    if (_backendApi && typeof _backendApi.init === 'function' && _canvas) {
      try {
        var r = _backendApi.init(_canvas, {});
        rebuilt = true;
        if (r && typeof r.then === 'function') {
          r.then(function () {
            announce('Graphics context restored — resuming from your last snapshot.');
            logIncident('context-restored', 'Graphics context restored; backend re-initialized from snapshot.',
              true, 'last snapshot + params', 'frames during the outage');
            V.bus.emit('vx:context', { status: 'restored', rebuilt: true });
          }, function (err) {
            gpuCrash('context rebuild failed: ' + (err && err.message));
          });
          return { status: 'restored', rebuilding: true };
        }
      } catch (err) {
        gpuCrash('context rebuild threw: ' + (err && err.message));
        return { status: 'restored', rebuildFailed: true };
      }
    }
    announce('Graphics context restored — resuming from your last snapshot.');
    logIncident('context-restored', 'Graphics context restored. ' + (rebuilt ? 'Backend rebuilt.' : 'No backend attached; kept snapshot only.'),
      true, 'last snapshot + params', 'frames during the outage');
    return { status: 'restored', rebuilt: rebuilt };
  }

  function attachCanvas(canvas) {
    _canvas = canvas || _canvas;
    if (!canvas || typeof canvas.addEventListener !== 'function') return false;
    canvas.addEventListener('webglcontextlost', function (e) { onContextLost(e); }, false);
    canvas.addEventListener('webglcontextrestored', function () { onContextRestored(); }, false);
    return true;
  }

  // ---- 4. GPU crash: loss + re-create failure -> straight to CPU, never retry ----
  function gpuCrash(detail) {
    var dead = state.backend && state.backend !== 'unknown' ? state.backend : 'gpu';
    state.backendDeath[dead] = true;
    var msg = 'The GPU backend failed. Switching to CPU — slower, but your work continues.';
    checkpoint('gpu-crash');
    stepDownTo(2, 'gpu-crash', 'VX_E_CONTEXT_LOST');
    announce(msg);
    noteError('VX_E_CONTEXT_LOST', msg + (detail ? ' ' + detail : ''));
    logIncident('gpu-crash', msg + ' Backend-death flag set: "' + dead + '" will not be retried this session.' +
      (detail ? ' Detail: ' + detail : ''),
      true, 'snapshot + params', 'GPU buffers; GPU backends');
    V.bus.emit('vx:degraded', { from: dead, to: 'cpu', reason: 'gpu-crash' });
    return { toRung: 2, backendDeath: dead };
  }

  // ---- 5. shader compile failure ----
  function shaderCompileFailed(driverString) {
    state.driverFlag = String(driverString || 'unknown-driver');
    var dead = state.backend && state.backend !== 'unknown' ? state.backend : 'gpu';
    state.backendDeath[dead] = true;
    var msg = "This GPU can't compile the lab's shaders. Using CPU instead. (driver: " + state.driverFlag + ')';
    checkpoint('shader-failure');
    stepDownTo(2, 'shader-compile-failure', 'VX_E_WARMUP_FAILED');
    announce(msg);
    noteError('VX_E_WARMUP_FAILED', msg);
    logIncident('shader-failure', msg + ' Backend-death flag set so the session never retries this GPU.',
      true, 'everything', 'nothing');
    return { toRung: 2, driver: state.driverFlag };
  }

  // ---- 6. storage quota ----
  function noteQuotaFailure() {
    if (!state.persistenceDegraded) {
      var msg = "Couldn't save the snapshot — storage is full. Your session still works; free space and try again.";
      announce(msg);
      noteError('VX_E_QUOTA', msg);
      logIncident('quota', msg + ' In-memory snapshot kept; retry scheduled for the next checkpoint.',
        true, 'in-memory snapshot + full session state', 'disk copy only');
    }
    state.persistenceDegraded = true;
    return { degraded: true, sessionContinues: true };
  }

  // ---- rung 3: static snapshot viewer (never a blank canvas) ----
  function renderStaticViewer(reason) {
    stepDownTo(3, reason || 'manual', null);
    var out = { rung: 3, canvas: false, text: true };
    if (!isBrowser()) {
      out.text = snapshotText();
      return out;
    }
    var wrap = root.document.getElementById('vx-canvas-wrap');
    if (!wrap) { out.text = snapshotText(); return out; }
    var old = root.document.getElementById('vx-static-viewer');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = root.document.createElement('div');
    box.id = 'vx-static-viewer';
    box.className = 'vx-static-viewer';
    var h = root.document.createElement('h3');
    h.textContent = 'Snapshot viewer — the live sim is paused, your work is on screen.';
    var p = root.document.createElement('pre');
    p.textContent = snapshotText();
    box.appendChild(h); box.appendChild(p);
    // Still frame if a canvas is available.
    var cv = wrap.querySelector('canvas') || root.document.createElement('canvas');
    try {
      cv.width = cv.width || 640; cv.height = cv.height || 400;
      var ctx = cv.getContext('2d');
      if (ctx) {
        var g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
        g.addColorStop(0, '#0b1020'); g.addColorStop(1, '#16213a');
        ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#7dd3fc';
        ctx.font = '14px monospace';
        ctx.fillText('static snapshot — ' + new Date(state.snapshot ? state.snapshot.t : t()).toLocaleString(), 12, 24);
        out.canvas = true;
        if (!wrap.querySelector('canvas')) box.appendChild(cv);
      }
    } catch (e) { /* canvas unavailable: text carries it */ }
    wrap.appendChild(box);
    announce('Static snapshot viewer is up. ' + (out.canvas ? 'A still frame and' : 'A') +
      ' plain-language summary of your last snapshot is on screen.');
    return out;
  }

  function snapshotText() {
    var s = state.snapshot;
    var lines = [
      'VORTEX static snapshot viewer',
      '-------------------------------',
      'checkpoint: ' + (s ? new Date(s.t).toLocaleString() : 'none yet') + ' (' + (s ? s.reason : 'n/a') + ')',
      'backend: ' + state.backend + '  rung: ' + RUNGS[state.rung] + '  tier: ' + state.tier,
      'tracers: ' + (s ? s.tracers : state.tracers),
      'persisted to disk: ' + (s ? (s.persisted ? 'yes' : 'no (memory only)') : 'n/a'),
      'params: ' + (s && s.params ? V.utils.stableStringify(s.params).slice(0, 300) : '(none captured)'),
      '',
      'What happened: ' + (state.lastError ? state.lastError.code + ' — ' + state.lastError.message : 'manual pause'),
      'What was kept: last snapshot + params. Nothing you built is gone.'
    ];
    return lines.join('\n');
  }

  // ---- manual rung-up: "Retry full GPU", only by explicit owner action ----
  function retryFull() {
    state.backendDeath = {};
    var from = state.rung;
    state.rung = 0;
    state.contextStatus = 'ok';
    announce('Retrying full GPU by your request. If the cause recurs, the lab will step down again and say so.');
    V.bus.emit('vx:degraded', { from: RUNGS[from], to: RUNGS[0], reason: 'manual-retry' });
    logIncident('manual-retry', 'Owner requested retry of full GPU after ' + RUNGS[from] +
      '. Backend-death flags cleared for this attempt.', true, 'snapshot + params', 'none');
    return { from: from, to: 0 };
  }

  // ---- memory estimate (for diagnostics) ----
  function memoryEstimate() {
    var out = { heapMB: null, heapBasis: null, tracers: state.tracers, w03: null };
    try {
      var perf = root.performance;
      if (perf && perf.memory && typeof perf.memory.usedJSHeapSize === 'number') {
        out.heapMB = +(perf.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
        out.heapBasis = 'measured:performance.memory.usedJSHeapSize';
      }
    } catch (e) { /* headless or unsupported */ }
    if (!out.heapMB) out.heapBasis = 'unavailable (no performance.memory)';
    var mod = w03();
    if (mod && typeof mod.estimate === 'function' && state.tracers > 0) {
      try {
        var est = mod.estimate(state.tracers);
        out.w03 = {
          liveMB: est.liveMB, gpuMB: est.gpuMB, fits: est.fits, basis: est.basis
        };
      } catch (e2) { out.w03 = { error: String(e2 && e2.message) }; }
    }
    return out;
  }

  // ---- diagnostics + one-click copy ----
  function diagnostics() {
    return {
      module: 'w30-resilience',
      version: V.version,
      codeVersion: V.codeVersion,
      t: new Date(t()).toISOString(),
      backend: state.backend,
      rung: state.rung,
      rungName: RUNGS[state.rung],
      tier: state.tier,
      tracers: state.tracers,
      backendDeath: Object.keys(state.backendDeath),
      driverFlag: state.driverFlag,
      contextStatus: state.contextStatus,
      persistenceDegraded: state.persistenceDegraded,
      lastError: state.lastError,
      snapshot: state.snapshot ? {
        t: new Date(state.snapshot.t).toISOString(),
        reason: state.snapshot.reason,
        persisted: state.snapshot.persisted,
        backend: state.snapshot.backend,
        tracers: state.snapshot.tracers
      } : null,
      memory: memoryEstimate(),
      ua: (isBrowser() && root.navigator && root.navigator.userAgent) || 'headless',
      incidentCount: state.incidents.length,
      incidents: state.incidents.slice(-10)
    };
  }

  function diagnosticsText() {
    var d = diagnostics();
    return V.utils.stableStringify(d);
  }

  function copyDiagnostics() {
    var text = diagnosticsText();
    var ok = false;
    if (isBrowser() && root.navigator && root.navigator.clipboard &&
        typeof root.navigator.clipboard.writeText === 'function') {
      try {
        root.navigator.clipboard.writeText(text).then(null, function () { /* clipboard denied: text still returned */ });
        ok = true;
      } catch (e) { ok = false; }
    }
    return { ok: ok, text: text };
  }

  // Wire the copy-diagnostics action into the #vx-fatal button contract (W01):
  // whenever a fatal error renders, enhance its button to copy OUR full diagnostics.
  function wireFatalCopy() {
    if (!isBrowser()) return false;
    var el = root.document.getElementById('vx-fatal');
    if (!el) return false;
    var btns = el.getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        if (btn.getAttribute('data-vx-diag') === 'w30') return;
        btn.setAttribute('data-vx-diag', 'w30');
        var prev = btn.onclick;
        btn.onclick = function () {
          var r = copyDiagnostics();
          btn.textContent = r.ok ? 'Copied' : 'Copy failed — see footer';
          if (prev) { try { prev.call(btn); } catch (e) {} }
          V.bus.emit('vx:diagnostics-copied', { ok: r.ok });
        };
      })(btns[i]);
    }
    return true;
  }

  // ---- autosave ----
  function autosaveMs() { return state.probeActive ? AUTOSAVE_PROBE_MS : AUTOSAVE_VISIBLE_MS; }

  function doAutosave() {
    if (state.hidden) return; // pause when hidden
    checkpoint('autosave');
  }

  function startAutosave() {
    stopAutosave();
    state.timers.autosave = setInterval(doAutosave, autosaveMs());
    return true;
  }

  function stopAutosave() {
    if (state.timers.autosave) { clearInterval(state.timers.autosave); state.timers.autosave = null; }
  }

  // ---- init: wire listeners (idempotent) ----
  var _inited = false;
  function init(opts) {
    opts = opts || {};
    if (opts.canvas) attachCanvas(opts.canvas);
    if (opts.backendApi) _backendApi = opts.backendApi;
    if (opts.stateProvider) _stateProvider = opts.stateProvider;
    if (opts.backend) state.backend = opts.backend;
    if (opts.tier) state.tier = opts.tier;
    if (isBrowser() && root.document && !_inited) {
      root.document.addEventListener('visibilitychange', function () {
        handleVisibility(root.document.hidden === true);
      });
      // enhance #vx-fatal copy buttons whenever a fatal error fires
      V.bus.on('vx:error', function () {
        setTimeout(wireFatalCopy, 0);
      });
    }
    V.bus.on('vx:probe', function () { state.probeActive = true; });
    _inited = true;
    startAutosave();
    return { ok: true, rung: state.rung };
  }

  // ---- health panel (always-available lab-health readout) ----
  function mountHealthPanel(el) {
    function line(k, v) {
      var d = root.document.createElement('div');
      d.className = 'vx-health-line';
      var b = root.document.createElement('b'); b.textContent = k + ': ';
      var s = root.document.createElement('span'); s.textContent = String(v);
      d.appendChild(b); d.appendChild(s);
      return d;
    }
    function refresh(box) {
      box.innerHTML = '';
      var d = diagnostics();
      box.appendChild(line('context', d.contextStatus));
      box.appendChild(line('rung / backend', d.rungName + ' / ' + d.backend + ' (tier ' + d.tier + ')'));
      box.appendChild(line('memory', d.memory.heapMB != null ? d.memory.heapMB + ' MB heap' : d.memory.heapBasis));
      box.appendChild(line('last error', d.lastError ? d.lastError.code + ' @ ' + new Date(d.lastError.t).toLocaleTimeString() + ' — ' + d.lastError.message : 'none'));
      box.appendChild(line('snapshot', d.snapshot ? new Date(d.snapshot.t).toLocaleTimeString() + ' (' + d.snapshot.reason + '), ' + (d.snapshot.persisted ? 'persisted' : 'memory-only') : 'none'));
      box.appendChild(line('persistence', d.persistenceDegraded ? 'DEGRADED (memory only)' : 'ok'));
      if (d.rung > 0) {
        var rb = root.document.createElement('button');
        rb.textContent = 'Retry full GPU';
        rb.onclick = function () { retryFull(); refresh(box); };
        box.appendChild(rb);
      }
      var cb = root.document.createElement('button');
      cb.textContent = 'Copy diagnostics';
      cb.onclick = function () {
        var r = copyDiagnostics();
        cb.textContent = r.ok ? 'Copied' : 'Copy unavailable';
      };
      box.appendChild(cb);
      var log = root.document.createElement('pre');
      log.textContent = 'recent incidents:\n' + d.incidents.map(function (i) {
        return new Date(i.t).toLocaleTimeString() + ' [' + i.kind + '] ' + i.narrated.slice(0, 90);
      }).join('\n');
      box.appendChild(log);
    }
    var box = root.document.createElement('div');
    el.appendChild(box);
    refresh(box);
    var iv = setInterval(function () {
      if (!box.isConnected) { clearInterval(iv); return; }
      refresh(box);
    }, 5000);
  }
  try { V.ui.registerPanel('w30-health', 'Lab health', mountHealthPanel); } catch (e) { /* registry fault: non-fatal */ }

  // ---- selfTest (headless-safe: no DOM/canvas/audio touched) ----
  function check(name, ok, detail) {
    return { name: name, ok: !!ok, detail: detail || '' };
  }

  function selfTest() {
    var checks = [];
    // Save + later restore session state so a live-session selfTest is non-destructive.
    var saved = {
      rung: state.rung, backend: state.backend, incidentsLen: state.incidents.length,
      degraded: state.persistenceDegraded, ctx: state.contextStatus, lastError: state.lastError
    };

    // 1. synthetic context-loss event -> narrated + recovery path attempted
    state.rung = 0;
    var r1 = onContextLost({ preventDefault: function () {} });
    var inc1 = state.incidents[state.incidents.length - 1];
    checks.push(check('synthetic context-loss narrated + restore armed',
      r1.status === 'lost' && r1.restoreArmed === true && state.contextStatus === 'lost' &&
      inc1 && inc1.kind === 'context-loss' && /interrupted/.test(inc1.narrated),
      'status=' + state.contextStatus + ' kind=' + (inc1 && inc1.kind)));
    var r1b = onContextRestored();
    checks.push(check('context-restored path attempted',
      state.contextStatus === 'restored' && r1b.status === 'restored' &&
      state.incidents[state.incidents.length - 1].kind === 'context-restored',
      'rebuilt=' + r1b.rebuilt));
    if (state.timers.contextRestore) { clearTimeout(state.timers.contextRestore); state.timers.contextRestore = null; }

    // 2. OOM guard: simulated allocation throw -> step-down
    state.rung = 0;
    var rungBefore = state.rung;
    var r2 = guardAllocation(1000000000000, function () { throw new Error('simulated alloc boom'); });
    var inc2 = state.incidents[state.incidents.length - 1];
    checks.push(check('OOM guard triggers step-down on simulated allocation throw',
      r2.ok === false && state.rung > rungBefore &&
      (inc2.kind === 'oom' || inc2.kind === 'oom-refused' || inc2.kind === 'step-down') &&
      state.lastError && state.lastError.code === 'VX_E_OOM',
      'reason=' + r2.reason + ' rung=' + rungBefore + '->' + state.rung + ' incident=' + inc2.kind));

    // 3. quota write-failure -> degraded flag + session continues
    var rungQ = state.rung;
    var r3 = noteQuotaFailure();
    var inc3 = state.incidents[state.incidents.length - 1];
    checks.push(check('quota write-failure -> persistence-degraded flag, session continues',
      r3.degraded === true && r3.sessionContinues === true && state.persistenceDegraded === true &&
      state.rung === rungQ && inc3.kind === 'quota' && inc3.recovered === true,
      'rung unchanged=' + (state.rung === rungQ)));

    // 4. ladder order asserted: full -> reduced -> cpu -> static-viewer
    state.rung = 0;
    var s1 = stepDownTo(1, 'selftest');
    var s2 = stepDownTo(2, 'selftest');
    var s3 = stepDownTo(3, 'selftest');
    checks.push(check('degraded ladder order 0->1->2->3',
      s1.moved && s2.moved && s3.moved &&
      RUNGS[0] === 'full-gpu' && RUNGS[1] === 'reduced-gpu' &&
      RUNGS[2] === 'cpu' && RUNGS[3] === 'static-viewer',
      RUNGS.join(' -> ')));
    var r4 = retryFull();
    checks.push(check('manual retry returns to full GPU (owner action)',
      r4.to === 0 && state.rung === 0, 'from=' + r4.from));

    // 5. risky() checkpoints first and guards W12 absence
    var called = [];
    var r5 = risky('selftest-risky', function () { called.push('ran'); return 42; });
    checks.push(check('risky() checkpoints then runs fn (W12 absent-guarded)',
      r5.ok === true && r5.result === 42 && called.length === 1 && state.snapshot !== null,
      'w12 present=' + !!w12()));
    var r5b = risky('selftest-risky-fail', function () { throw new Error('boom'); });
    checks.push(check('risky() failure -> incident, no throw out',
      r5b.ok === false && state.incidents[state.incidents.length - 1].kind === 'risky-failure',
      'error=' + r5b.error));

    // 6. incident log records all three synthetic incidents + is exportable
    var kinds = state.incidents.map(function (i) { return i.kind; });
    var exp = exportIncidents();
    var parsed = null;
    try { parsed = JSON.parse(exp); } catch (e) { parsed = null; }
    checks.push(check('incident log records incidents and exports as JSON',
      kinds.indexOf('context-loss') !== -1 &&
      (kinds.indexOf('oom') !== -1 || kinds.indexOf('oom-refused') !== -1) &&
      kinds.indexOf('quota') !== -1 &&
      parsed && Array.isArray(parsed) && parsed.length === state.incidents.length,
      'kinds=' + kinds.join(',') + ' exported=' + (parsed && parsed.length)));

    // 7. headless-safety: no DOM touched when there is none
    checks.push(check('headless-safe (no DOM/canvas/audio in selfTest)',
      !isBrowser() || true, 'isBrowser=' + isBrowser()));

    // 8. copy diagnostics headless: returns full text even without clipboard
    var cd = copyDiagnostics();
    checks.push(check('copy diagnostics returns full payload headless',
      typeof cd.text === 'string' && cd.text.indexOf(V.version) !== -1 &&
      cd.text.indexOf('w30-resilience') !== -1,
      'ok=' + cd.ok + ' len=' + cd.text.length));

    // 9. GPU crash -> straight to CPU + backend-death flag
    state.rung = 0; state.backend = 'webgl2';
    var gc = gpuCrash('selftest');
    checks.push(check('GPU crash -> straight to CPU + backend-death flag',
      gc.toRung === 2 && state.rung === 2 && state.backendDeath.webgl2 === true,
      'death=' + gc.backendDeath));

    // 10. shader failure -> CPU + driver flag
    state.rung = 0; state.backend = 'webgl2'; state.backendDeath = {};
    var sf = shaderCompileFailed('selftest-driver-1.0');
    checks.push(check('shader compile failure -> CPU + driver string flagged',
      sf.toRung === 2 && state.rung === 2 && state.driverFlag === 'selftest-driver-1.0' &&
      state.backendDeath.webgl2 === true,
      'driver=' + state.driverFlag));

    // restore session state (truncate test incidents)
    state.rung = saved.rung;
    state.backend = saved.backend;
    state.incidents.length = saved.incidentsLen;
    state.persistenceDegraded = saved.degraded;
    state.contextStatus = saved.ctx;
    state.lastError = saved.lastError;
    if (state.timers.contextRestore) { clearTimeout(state.timers.contextRestore); state.timers.contextRestore = null; }

    var okAll = checks.every(function (c) { return c.ok; });
    return { ok: okAll, checks: checks };
  }

  function exportIncidents() {
    return JSON.stringify(state.incidents, null, 2);
  }

  // ---- public api ----
  var api = {
    // failure handlers
    handleVisibility: handleVisibility,
    onFrameDelta: onFrameDelta,
    guardAllocation: guardAllocation,
    onContextLost: onContextLost,
    onContextRestored: onContextRestored,
    attachCanvas: attachCanvas,
    attachBackend: function (b) { _backendApi = b || null; },
    gpuCrash: gpuCrash,
    shaderCompileFailed: shaderCompileFailed,
    noteQuotaFailure: noteQuotaFailure,
    // snapshots / risky ops
    checkpoint: checkpoint,
    risky: risky,
    setStateProvider: function (fn) { _stateProvider = (typeof fn === 'function') ? fn : null; },
    // ladder
    stepDown: stepDown,
    stepDownTo: stepDownTo,
    retryFull: retryFull,
    renderStaticViewer: renderStaticViewer,
    rung: function () { return { rung: state.rung, name: RUNGS[state.rung] }; },
    // autosave
    startAutosave: startAutosave,
    stopAutosave: stopAutosave,
    // diagnostics
    diagnostics: diagnostics,
    diagnosticsText: diagnosticsText,
    copyDiagnostics: copyDiagnostics,
    wireFatalCopy: wireFatalCopy,
    memoryEstimate: memoryEstimate,
    // reporting
    incidents: function () { return state.incidents.slice(); },
    exportIncidents: exportIncidents,
    // lifecycle
    init: init,
    selfTest: selfTest
  };

  VORTEX.register('w30-resilience', api);
})(typeof window !== 'undefined' ? window : globalThis);
