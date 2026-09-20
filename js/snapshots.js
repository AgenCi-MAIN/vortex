/* VORTEX snapshots.js — W12 reconstruct-first snapshots.
 *
 * Default snapshots store { manifest, eventHistory } — seed + params +
 * probe/param events with sim-time — NOT field buffers. Restore re-seeds
 * and replays events. Full binary snapshots (backend.snapshotState())
 * are taken ONLY when:
 *   - eventHistory exceeds LONG_REPLAY_EVENTS (500), or
 *   - snapshot.pinned === true, or
 *   - the backend marks its state non-reconstructible (backend.nonReconstructible)
 *
 * restore(id) FIRST checkpoints the live state as 'pre-restore:<id>' so
 * restoration is always undoable via undoRestore().
 *
 * Storage: in-memory registry + guarded localStorage persistence for
 * reconstruct-type snapshots (small). Binary snapshots stay memory-only
 * unless pinned; quota failures surface as a VX_E_QUOTA narrative via
 * VORTEX.ui.fail and the session keeps working.
 *
 * Plain script, IIFE, no modules. Headless-safe (node) — selfTest runs
 * against a mock backend implementing the field contract shape.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('snapshots.js: VORTEX namespace missing (load vx-namespace.js first)');

  var LONG_REPLAY_EVENTS = 500;      // >500 events forces the binary path
  var LS_KEY = 'vortex.w12.snapshots.v1';
  var MAX_UNDO = 5;                  // pre-restore checkpoints kept for undo

  // ---- in-memory state ----
  var registry = {};                 // id -> snapshot object
  var undoStack = [];                // snapshot ids, most recent last
  var backend = null;                // bound field backend
  var ctx = {                        // run context for reconstruct restore
    canvas: null, seed: 1, params: {}, configId: 'spiral-default', tracers: 0
  };
  var simSteps = 0;                  // wrapped step() counter -> sim time
  var eventHistory = [];             // live recording: [{t, kind, probe?, params?}]

  function simTime() { return simSteps * V.SIM_DT; }

  // ---- manifest helpers (W25 owns full module; schema lives in namespace) ----
  function verifyManifest(m) {
    if (!m || typeof m !== 'object' || typeof m.hash !== 'string') return false;
    var copy = {};
    for (var k in m) { if (k !== 'hash' && Object.prototype.hasOwnProperty.call(m, k)) copy[k] = m[k]; }
    return V.utils.hash53(V.utils.stableStringify(copy)) === m.hash;
  }

  function metricHashOf(b) {
    try {
      return V.utils.hash53(V.utils.stableStringify(b.sampleMetrics()));
    } catch (e) { return null; }
  }

  // ---- localStorage (guarded) ----
  function lsGet() {
    try {
      if (typeof root.localStorage === 'undefined') return null;
      var raw = root.localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(obj) {
    try {
      if (typeof root.localStorage === 'undefined') return true;
      root.localStorage.setItem(LS_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      quotaNarrative('persisting snapshot list');
      return false;
    }
  }
  function quotaNarrative(what) {
    V.ui.fail(
      'VX_E_QUOTA',
      'Snapshot storage is full, so ' + what + ' was skipped. ' +
      'The session keeps working; snapshots stay in memory for this visit.',
      'in-memory snapshot registry; live simulation untouched'
    );
  }

  // ---- backend binding: wrap step/addProbe/setParams to record history ----
  function wrapBackend(b) {
    if (!b || b._vxSnapWrapped) return;
    var origStep = b.step, origAdd = b.addProbe, origSet = b.setParams;
    b.step = function () {
      // during restore-replay the clock is driven by replayEvents, not the live counter
      if (!_recordingSuspended) simSteps += 1;
      return origStep ? origStep.apply(this, arguments) : undefined;
    };
    b.addProbe = function (probe) {
      if (!_recordingSuspended) recordEvent('probe', { probe: cloneEventPayload(probe) });
      return origAdd ? origAdd.apply(this, arguments) : undefined;
    };
    b.setParams = function (p) {
      if (!_recordingSuspended) recordEvent('params', { params: cloneEventPayload(p) });
      return origSet ? origSet.apply(this, arguments) : undefined;
    };
    b._vxSnapWrapped = true;
  }

  function cloneEventPayload(v) {
    try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
    catch (e) { return null; }
  }

  function recordEvent(kind, payload) {
    var ev = { t: simTime(), kind: kind };
    if (payload.probe !== undefined) ev.probe = payload.probe;
    if (payload.params !== undefined) ev.params = payload.params;
    eventHistory.push(ev);
    V.bus.emit('vx:snapshot', { action: 'event', kind: kind, t: ev.t });
  }

  function bindBackend(b, runCtx) {
    // runCtx describes the SEED-TIME run: {canvas, seed, params, configId, tracers}.
    // runCtx.params MUST be the params the backend was initialized with, not the
    // live params — restore re-seeds with them and replays param changes from
    // eventHistory. Integrators (W01/W25): call bindBackend (or setRunContext)
    // with the init-time params right after backend init.
    if (!b) throw V.VortexError('VX_E_NO_BACKEND', 'snapshots: no backend to bind');
    backend = b;
    if (runCtx) {
      if (runCtx.canvas !== undefined) ctx.canvas = runCtx.canvas;
      if (runCtx.seed !== undefined) ctx.seed = runCtx.seed >>> 0;
      if (runCtx.params !== undefined) ctx.params = cloneEventPayload(runCtx.params) || {};
      if (runCtx.configId !== undefined) ctx.configId = runCtx.configId;
      if (runCtx.tracers !== undefined) ctx.tracers = runCtx.tracers;
    }
    simSteps = 0;
    eventHistory = [];
    wrapBackend(b);
  }

  // auto-bind when the lab boots (W01 emits vx:ready {backend, tracers})
  V.bus.on('vx:ready', function (d) {
    if (d && d.backend) {
      try { bindBackend(d.backend, { tracers: d.tracers }); }
      catch (e) { /* boot keeps its own error path; snapshots just stay unbound */ }
    }
  });

  // ---- snapshot construction ----
  function currentParams() {
    // best-known params: last recorded params event wins, else run context
    for (var i = eventHistory.length - 1; i >= 0; i--) {
      if (eventHistory[i].kind === 'params' && eventHistory[i].params) {
        return cloneEventPayload(eventHistory[i].params);
      }
    }
    return cloneEventPayload(ctx.params) || {};
  }

  function probeTimelineFrom(events) {
    var tl = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].kind === 'probe') {
        tl.push({ t: events[i].t, probe: events[i].probe, params: events[i].probeParams || null });
      }
    }
    return tl;
  }

  function needsBinary(pinned) {
    if (pinned) return true;
    if (eventHistory.length > LONG_REPLAY_EVENTS) return true;
    if (backend && backend.nonReconstructible === true) return true;
    return false;
  }

  function snapshotStateClone() {
    var s = backend.snapshotState();
    // structured-cloneable per contract; deep-copy so later sim can't mutate it
    if (typeof root.structuredClone === 'function') {
      try { return root.structuredClone(s); } catch (e) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(s));
  }

  function capture(label, opts) {
    opts = opts || {};
    if (!backend) throw V.VortexError('VX_E_NO_BACKEND', 'snapshots: capture with no backend bound');
    var pinned = opts.pin === true;
    var binary = opts.forceBinary === true || needsBinary(pinned);
    var events = eventHistory.slice();
    // manifest.params = SEED-TIME params (the replay starting point), NOT the
    // live params: param changes are replayed from eventHistory. Using live
    // params here would double-apply them and break replay determinism.
    var manifest = V.makeManifest({
      seed: ctx.seed >>> 0,
      params: cloneEventPayload(ctx.params) || {},
      configId: ctx.configId,
      probeTimeline: probeTimelineFrom(events),
      backend: backend.name || 'unknown',
      tracers: ctx.tracers || 0,
      toleranceBands: {}
    });
    var snap = {
      id: V.utils.uid('snap'),
      label: String(label || ('snapshot-' + V.utils.now())),
      type: binary ? 'binary' : 'reconstruct',
      kind: opts.checkpoint ? 'checkpoint' : 'snapshot',
      pinned: pinned,
      createdAt: V.utils.now(),
      manifest: manifest,
      manifestOk: verifyManifest(manifest),
      eventHistory: events,
      totalSteps: simSteps,
      totalSimTime: simTime(),
      paramsAtCapture: currentParams(), // informational only — replay uses manifest.params + events
      metricHash: metricHashOf(backend),
      backendName: backend.name || 'unknown',
      tracers: ctx.tracers || 0
    };
    if (binary) {
      try {
        snap.state = snapshotStateClone();
      } catch (e) {
        quotaNarrative('capturing the binary snapshot');
        snap.type = 'reconstruct'; // degrade: replay instead of failing
        snap.degradedFrom = 'binary';
      }
    }
    registry[snap.id] = snap;
    persistRegistry();
    V.bus.emit('vx:snapshot', {
      action: 'capture', id: snap.id, label: snap.label, type: snap.type,
      events: events.length, metricHash: snap.metricHash
    });
    V.ui.announce('Snapshot "' + snap.label + '" captured (' + snap.type +
      ', ' + events.length + ' events).');
    return snap.id;
  }

  function checkpoint(label) {
    // snapshot-before-risky-operation hook, used by W05 (probes) and W30 (resilience)
    return capture(label, { checkpoint: true });
  }

  // ---- persistence: reconstruct snapshots only (small); binary memory-only ----
  function persistRegistry() {
    var small = {};
    var ids = Object.keys(registry);
    for (var i = 0; i < ids.length; i++) {
      var s = registry[ids[i]];
      if (s.type !== 'reconstruct' || s.kind === 'pre-restore') continue;
      small[s.id] = {
        id: s.id, label: s.label, type: s.type, kind: s.kind, pinned: s.pinned,
        createdAt: s.createdAt, manifest: s.manifest,
        eventHistory: s.eventHistory, totalSteps: s.totalSteps,
        totalSimTime: s.totalSimTime, metricHash: s.metricHash,
        backendName: s.backendName, tracers: s.tracers
      };
    }
    lsSet(small);
  }

  // validate a snapshot object coming from anywhere (storage, restore path)
  function validateSnapshotObject(o) {
    if (!o || typeof o !== 'object') return { ok: false, reason: 'not an object' };
    if (typeof o.id !== 'string') return { ok: false, reason: 'missing id' };
    if (o.type !== 'reconstruct' && o.type !== 'binary') return { ok: false, reason: 'bad type' };
    if (!verifyManifest(o.manifest)) return { ok: false, reason: 'manifest hash mismatch (tampered or corrupt)' };
    if (!Array.isArray(o.eventHistory)) return { ok: false, reason: 'eventHistory missing' };
    if (o.type === 'binary' && (o.state === undefined || o.state === null)) {
      return { ok: false, reason: 'binary snapshot has no state' };
    }
    return { ok: true };
  }

  function loadPersisted() {
    var stored = lsGet();
    if (!stored) return { loaded: 0, rejected: 0 };
    var loaded = 0, rejected = 0;
    var ids = Object.keys(stored);
    for (var i = 0; i < ids.length; i++) {
      var o = stored[ids[i]];
      var v = validateSnapshotObject(o);
      if (!v.ok) { rejected += 1; continue; } // tampered/corrupt entries are dropped, never trusted
      if (!registry[o.id]) { registry[o.id] = o; loaded += 1; }
    }
    return { loaded: loaded, rejected: rejected };
  }

  // ---- replay cost ----
  function estimateReplayCost(snapOrId) {
    var s = typeof snapOrId === 'string' ? registry[snapOrId] : snapOrId;
    if (!s) throw new Error('estimateReplayCost: unknown snapshot');
    if (s.type === 'binary') {
      return { type: 'binary', events: 0, stepsPerEvent: 0, totalSteps: 0,
               label: 'binary load — no replay' };
    }
    var events = s.eventHistory.length;
    var stepsPerEvent = events > 0 ? Math.max(1, Math.round(s.totalSteps / events)) : s.totalSteps;
    return {
      type: 'reconstruct', events: events, stepsPerEvent: stepsPerEvent,
      totalSteps: s.totalSteps,
      label: '≈' + s.totalSteps + ' steps (' + events + ' events × ~' + stepsPerEvent + ' steps/event)'
    };
  }

  // ---- restore ----
  function preRestoreCheckpoint(restoreTargetId) {
    var id = capture('pre-restore:' + restoreTargetId, { checkpoint: true });
    registry[id].kind = 'pre-restore';
    undoStack.push(id);
    while (undoStack.length > MAX_UNDO) {
      var dropped = undoStack.shift();
      // keep registry entry; just forget the undo slot
      if (registry[dropped]) registry[dropped].kind = 'snapshot';
    }
    persistRegistry();
    return id;
  }

  function replayEvents(b, snap) {
    var events = snap.eventHistory.slice().sort(function (a, b2) { return a.t - b2.t; });
    var done = 0;
    function advanceTo(targetStep) {
      while (done < targetStep) { b.step(); done += 1; }
    }
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      advanceTo(Math.round(ev.t / V.SIM_DT));
      if (ev.kind === 'probe' && ev.probe) b.addProbe(ev.probe);
      else if (ev.kind === 'params' && ev.params) b.setParams(ev.params);
      // NOTE: replay uses the WRAPPED backend, whose wrappers would record
      // into the live eventHistory. Suppress that: restore runs with a
      // recording flag off (see restore()).
    }
    advanceTo(snap.totalSteps);
  }

  // wrapped methods consult this so replay doesn't pollute the live history
  var _recordingSuspended = false;

  function restore(id, opts) {
    opts = opts || {};
    var snap = registry[id];
    if (!snap) return Promise.reject(new Error('restore: unknown snapshot ' + id));
    var v = validateSnapshotObject(snap);
    if (!v.ok) return Promise.reject(new Error('restore: snapshot failed validation: ' + v.reason));
    if (!backend) return Promise.reject(V.VortexError('VX_E_NO_BACKEND', 'snapshots: restore with no backend bound'));

    var undoId = null;
    if (!opts.isUndo) undoId = preRestoreCheckpoint(id); // restoration is always undoable

    function finishRestored(b) {
      simSteps = snap.totalSteps;
      eventHistory = snap.eventHistory.slice(); // continue history from the restored point
      var nowHash = metricHashOf(b);
      var replayOk = snap.metricHash == null || nowHash == null ? null : (nowHash === snap.metricHash);
      V.bus.emit('vx:snapshot', {
        action: opts.isUndo ? 'undo-restore' : 'restore',
        id: id, label: snap.label, type: snap.type, undoId: undoId, replayOk: replayOk
      });
      V.ui.announce((opts.isUndo ? 'Undo restore' : 'Restored') + ' "' + snap.label + '"' +
        (replayOk === false ? ' — replay diverged from capture hash (check backend determinism).' : '.'));
      refreshPanel();
      return { id: id, replayOk: replayOk, undoId: undoId };
    }

    if (snap.type === 'binary') {
      try {
        var stateCopy = (typeof root.structuredClone === 'function')
          ? root.structuredClone(snap.state)
          : JSON.parse(JSON.stringify(snap.state));
        backend.restoreState(stateCopy);
        return Promise.resolve(finishRestored(backend));
      } catch (e) {
        return Promise.reject(new Error('restore: binary restoreState failed: ' + e.message));
      }
    }

    // reconstruct: re-seed via init, then replay events in sim time
    var initOpts = {
      tracers: snap.tracers || ctx.tracers || 0,
      seed: snap.manifest.seed,
      config: snap.manifest.params,
      configId: snap.manifest.configId
    };
    _recordingSuspended = true;
    var p;
    try {
      p = backend.init(ctx.canvas, initOpts);
    } catch (e) {
      _recordingSuspended = false;
      return Promise.reject(e);
    }
    return Promise.resolve(p).then(function (nb) {
      var b = nb || backend;
      if (b !== backend) { backend = b; wrapBackend(b); }
      else { simSteps = 0; } // same object re-inited: reset clock before replay
      replayEvents(b, snap);
      _recordingSuspended = false;
      return finishRestored(b);
    }, function (err) {
      _recordingSuspended = false;
      return Promise.reject(err);
    });
  }

  // wrapped methods consult this so replay doesn't pollute the live history
  function undoRestore() {
    if (undoStack.length === 0) return Promise.reject(new Error('undoRestore: nothing to undo'));
    var id = undoStack.pop();
    return restore(id, { isUndo: true });
  }

  function deleteSnapshot(id) {
    var s = registry[id];
    if (!s) return false;
    delete registry[id];
    var ix = undoStack.indexOf(id);
    if (ix >= 0) undoStack.splice(ix, 1);
    persistRegistry();
    V.bus.emit('vx:snapshot', { action: 'delete', id: id, label: s.label });
    refreshPanel();
    return true;
  }

  function list() {
    var out = [];
    var ids = Object.keys(registry);
    for (var i = 0; i < ids.length; i++) {
      var s = registry[ids[i]];
      out.push({
        id: s.id, label: s.label, type: s.type, kind: s.kind, pinned: !!s.pinned,
        createdAt: s.createdAt, events: s.eventHistory.length,
        totalSteps: s.totalSteps, metricHash: s.metricHash,
        replayCost: estimateReplayCost(s).label,
        inUndoStack: undoStack.indexOf(s.id) >= 0
      });
    }
    out.sort(function (a, b) { return a.createdAt - b.createdAt; });
    return out;
  }

  function get(id) { return registry[id] || null; }

  // ---- panel ----
  var panelEl = null;
  function refreshPanel() {
    if (!panelEl || !V.utils.isBrowser()) return;
    renderPanel(panelEl);
  }

  function renderPanel(el) {
    el.innerHTML = '';
    var doc = root.document;

    var row = doc.createElement('div');
    row.className = 'vx-snap-controls';
    var input = doc.createElement('input');
    input.type = 'text'; input.placeholder = 'snapshot label';
    input.className = 'vx-snap-label';
    input.setAttribute('aria-label', 'Snapshot label');
    var capBtn = doc.createElement('button');
    capBtn.textContent = 'Capture snapshot';
    capBtn.onclick = function () {
      try { capture(input.value || undefined); input.value = ''; }
      catch (e) { V.ui.fail('VX_E_FIELD_INIT', 'Capture failed: ' + e.message, 'live simulation untouched'); }
    };
    var undoBtn = doc.createElement('button');
    undoBtn.textContent = 'Undo restore';
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.title = undoStack.length ? 'Undo the most recent restore' : 'No restore to undo';
    undoBtn.onclick = function () { undoRestore().catch(function (e) { V.ui.announce('Undo failed: ' + e.message); }); };
    row.appendChild(input); row.appendChild(capBtn); row.appendChild(undoBtn);
    el.appendChild(row);

    var items = list();
    if (items.length === 0) {
      var empty = doc.createElement('p');
      empty.className = 'vx-snap-empty';
      empty.textContent = 'No snapshots yet. Capture one before a risky operation.';
      el.appendChild(empty);
      return;
    }
    var ul = doc.createElement('ul');
    ul.className = 'vx-snap-list';
    items.forEach(function (it) {
      var li = doc.createElement('li');
      li.className = 'vx-snap-item vx-snap-' + it.type + (it.kind === 'pre-restore' ? ' vx-snap-prerestore' : '');
      var head = doc.createElement('div');
      head.className = 'vx-snap-head';
      var name = doc.createElement('strong');
      name.textContent = it.label + (it.pinned ? ' 📌' : '');
      var meta = doc.createElement('span');
      meta.className = 'vx-snap-meta';
      meta.textContent = it.type + ' · ' + it.events + ' events · replay ' + it.replayCost +
        (it.kind === 'pre-restore' ? ' · pre-restore checkpoint' : '');
      head.appendChild(name); head.appendChild(meta);
      li.appendChild(head);
      var btns = doc.createElement('div');
      btns.className = 'vx-snap-btns';
      var rBtn = doc.createElement('button');
      rBtn.textContent = 'Restore';
      rBtn.onclick = function () {
        restore(it.id).catch(function (e) {
          V.ui.fail('VX_E_FIELD_INIT', 'Restore failed: ' + e.message, 'live simulation untouched');
        });
      };
      var dBtn = doc.createElement('button');
      dBtn.textContent = 'Delete';
      dBtn.onclick = function () { deleteSnapshot(it.id); };
      btns.appendChild(rBtn); btns.appendChild(dBtn);
      li.appendChild(btns);
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  V.ui.registerPanel('snapshots', 'Snapshots', function (el) {
    panelEl = el;
    renderPanel(el);
  });
  V.bus.on('vx:snapshot', function () { refreshPanel(); });

  // load persisted reconstruct snapshots at module init (guarded)
  var _bootLoad = loadPersisted();

  // ---- mock backend for selfTest (implements the field contract shape) ----
  function makeMockBackend() {
    var N = 16;
    var st = null;
    function freshState(seed) {
      var rnd = V.utils.mulberry32(seed >>> 0);
      var x = [];
      for (var i = 0; i < N; i++) x.push(rnd());
      return { x: x, steps: 0, seed: seed >>> 0, params: { circulation: 1, turbulence: 0.5 }, probes: [] };
    }
    var b = {
      name: 'cpu-mock', tier: 'C', nonReconstructible: false,
      init: function (canvas, opts) {
        st = freshState((opts && opts.seed !== undefined) ? opts.seed : 1);
        if (opts && opts.config) {
          for (var k in opts.config) st.params[k] = opts.config[k];
        }
        var nb = makeMockBackend();
        nb._injectState(st);
        return Promise.resolve(nb);
      },
      _injectState: function (s) { st = s; },
      setParams: function (p) { for (var k in p) st.params[k] = p[k]; },
      addProbe: function (probe) {
        st.probes.push(probe);
        var idx = Math.abs(probe.index || 0) % N;
        st.x[idx] = (st.x[idx] + (probe.strength || 0.1)) % 1;
      },
      clearProbes: function () { st.probes = []; },
      step: function () {
        var rnd = V.utils.mulberry32((st.seed ^ (st.steps * 2654435761)) >>> 0);
        for (var i = 0; i < N; i++) {
          st.x[i] = (st.x[i] * 1.0001 + rnd() * 0.001 + (st.params.circulation || 0) * 0.0001) % 1;
        }
        st.steps += 1;
      },
      render: function () {},
      snapshotState: function () { return JSON.parse(JSON.stringify(st)); },
      restoreState: function (s) { st = JSON.parse(JSON.stringify(s)); },
      sampleMetrics: function () {
        var ke = 0, en = 0;
        for (var i = 0; i < N; i++) { ke += st.x[i] * st.x[i]; en += Math.abs(st.x[i] - 0.5); }
        return {
          ke: Math.round(ke * 1e6) / 1e6,
          enstrophy: Math.round(en * 1e6) / 1e6,
          mixing: Math.round((en / N) * 1e6) / 1e6,
          steps: st.steps
        };
      },
      getTracers: function () { return { count: N, simulated: N }; },
      dispose: function () { st = null; }
    };
    return b;
  }

  // ---- selfTest (headless-safe) ----
  function check(name, ok, detail) { return { name: name, ok: !!ok, detail: detail || '' }; }

  function selfTest() {
    var checks = [];
    // reset module state so tests are hermetic
    var savedRegistry = registry, savedUndo = undoStack,
        savedBackend = backend, savedCtx = ctx,
        savedSteps = simSteps, savedHist = eventHistory;
    registry = {}; undoStack = [];
    backend = null; ctx = { canvas: null, seed: 1, params: {}, configId: 'spiral-default', tracers: 0 };
    simSteps = 0; eventHistory = [];

    function restoreModuleState() {
      registry = savedRegistry; undoStack = savedUndo; backend = savedBackend;
      ctx = savedCtx; simSteps = savedSteps; eventHistory = savedHist;
    }

    var chain = Promise.resolve();
    var results = {};

    chain = chain.then(function () {
      // 1. capture -> restore round-trip reproduces identical metric hash
      var mock = makeMockBackend();
      return mock.init(null, { seed: 7, config: { circulation: 1.2 } }).then(function (b0) {
        bindBackend(b0, { seed: 7, params: { circulation: 1.2 }, tracers: 16 });
        var i;
        for (i = 0; i < 30; i++) backend.step();
        backend.addProbe({ index: 3, strength: 0.25 });
        for (i = 0; i < 20; i++) backend.step();
        backend.setParams({ circulation: 2.0 });
        var id = capture('roundtrip');
        var snap = get(id);
        results.captureHash = snap.metricHash;
        results.captureType = snap.type;
        // diverge
        for (i = 0; i < 50; i++) backend.step();
        backend.addProbe({ index: 9, strength: 0.5 });
        var preRestoreHash = metricHashOf(backend);
        return restore(id).then(function (r) {
          var afterHash = metricHashOf(backend);
          checks.push(check('capture→restore reproduces identical metric hash',
            afterHash === results.captureHash,
            'capture=' + results.captureHash + ' restored=' + afterHash + ' replayOk=' + r.replayOk));
          checks.push(check('snapshot defaults to reconstruct type',
            results.captureType === 'reconstruct', 'type=' + results.captureType));
          // 2. undoRestore returns the pre-restore state
          return undoRestore().then(function () {
            var undoneHash = metricHashOf(backend);
            checks.push(check('undoRestore returns pre-restore state',
              undoneHash === preRestoreHash,
              'preRestore=' + preRestoreHash + ' undone=' + undoneHash));
          });
        });
      });
    }).then(function () {
      // 3. long replay (>500 events) forces the binary path
      var mock = makeMockBackend();
      return mock.init(null, { seed: 11 }).then(function (b0) {
        bindBackend(b0, { seed: 11, tracers: 16 });
        for (var i = 0; i < 10; i++) backend.step();
        for (var j = 0; j < 501; j++) backend.addProbe({ index: j % 16, strength: 0.01 });
        var id = capture('long-replay');
        var snap = get(id);
        checks.push(check('eventHistory > 500 forces binary snapshot',
          snap.type === 'binary', 'type=' + snap.type + ' events=' + snap.eventHistory.length));
        // binary restore round-trip works
        var beforeHash = metricHashOf(backend);
        for (var k = 0; k < 20; k++) backend.step();
        return restore(id).then(function () {
          var afterHash = metricHashOf(backend);
          checks.push(check('binary restore reproduces capture metric hash',
            afterHash === beforeHash, 'capture=' + beforeHash + ' restored=' + afterHash));
          // 3b. pinned reconstruct also goes binary
          bindBackend(b0, { seed: 12, tracers: 16 });
          for (var m = 0; m < 5; m++) backend.step();
          var pid = capture('pinned', { pin: true });
          checks.push(check('pinned snapshot takes binary path',
            get(pid).type === 'binary', 'type=' + get(pid).type));
          // 3c. non-reconstructible backend goes binary
          backend.nonReconstructible = true;
          var nid = capture('nonrecon');
          checks.push(check('non-reconstructible backend forces binary',
            get(nid).type === 'binary', 'type=' + get(nid).type));
          backend.nonReconstructible = false;
        });
      });
    }).then(function () {
      // 4. tampered manifest hash detected on load
      var m = V.makeManifest({ seed: 5, params: {}, configId: 'x', backend: 'cpu', tracers: 1 });
      checks.push(check('verifyManifest accepts a genuine manifest', verifyManifest(m) === true, 'hash=' + m.hash));
      var tampered = JSON.parse(JSON.stringify(m));
      tampered.seed = 6;
      checks.push(check('verifyManifest rejects a tampered manifest', verifyManifest(tampered) === false,
        'tampered seed 5->6, hash=' + tampered.hash));
      var fakeSnap = {
        id: 'snap-tampered', label: 'tampered', type: 'reconstruct', kind: 'snapshot',
        pinned: false, createdAt: 1, manifest: tampered, eventHistory: [], totalSteps: 0,
        totalSimTime: 0, metricHash: null, backendName: 'cpu-mock', tracers: 0
      };
      var v = validateSnapshotObject(fakeSnap);
      checks.push(check('tampered snapshot object rejected on load',
        v.ok === false && /hash mismatch/.test(v.reason), 'reason=' + v.reason));
      // 5. estimateReplayCost shape
      var mock = makeMockBackend();
      return mock.init(null, { seed: 21 }).then(function (b0) {
        bindBackend(b0, { seed: 21, tracers: 16 });
        for (var i = 0; i < 60; i++) backend.step();
        backend.addProbe({ index: 1, strength: 0.1 });
        backend.setParams({ turbulence: 0.9 });
        for (var j = 0; j < 60; j++) backend.step();
        var id = capture('costcheck');
        var cost = estimateReplayCost(id);
        checks.push(check('estimateReplayCost = events × per-event step estimate',
          cost.type === 'reconstruct' && cost.events === 2 &&
          cost.totalSteps === cost.events * cost.stepsPerEvent,
          JSON.stringify(cost)));
        var bcost = estimateReplayCost(get(id)); // object form also accepted
        checks.push(check('estimateReplayCost accepts snapshot object', bcost.events === 2, ''));
      });
    }).then(function () {
      // 6. checkpoint() hook shape used by W05/W30
      var mock = makeMockBackend();
      return mock.init(null, { seed: 31 }).then(function (b0) {
        bindBackend(b0, { seed: 31, tracers: 16 });
        var id = checkpoint('pre-probe:test-probe-1');
        var s = get(id);
        checks.push(check('checkpoint() creates a checkpoint snapshot',
          !!s && s.kind === 'checkpoint' && s.label === 'pre-probe:test-probe-1',
          'kind=' + (s && s.kind)));
      });
    }).then(function () {
      restoreModuleState();
      var failed = checks.filter(function (c) { return !c.ok; });
      return { ok: failed.length === 0, checks: checks };
    }, function (err) {
      restoreModuleState();
      checks.push(check('selfTest completed without exception', false, String(err && err.stack || err)));
      return { ok: false, checks: checks };
    });

    return chain;
  }

  var api = {
    bindBackend: bindBackend,
    setRunContext: function (runCtx) { bindBackend(backend, runCtx); },
    capture: capture,
    checkpoint: checkpoint,
    restore: restore,
    undoRestore: undoRestore,
    deleteSnapshot: deleteSnapshot,
    list: list,
    get: get,
    estimateReplayCost: estimateReplayCost,
    verifyManifest: verifyManifest,
    validateSnapshotObject: validateSnapshotObject,
    loadPersisted: loadPersisted,
    persistNow: persistRegistry,
    undoDepth: function () { return undoStack.length; },
    LONG_REPLAY_EVENTS: LONG_REPLAY_EVENTS,
    selfTest: selfTest
  };

  V.register('w12-snapshots', api);
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
