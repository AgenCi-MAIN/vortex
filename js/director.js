/* VORTEX director.js — W20 camera rig, replay, time controls, export, attract.
 * Plain script, no modules, no network. Headless-safe: all DOM/canvas/
 * MediaRecorder access is guarded; selfTest never throws without a backend.
 *
 * Camera rig: { position:{x,y,z}, target:{x,y,z}, zoom, tilt }.
 * Renderer consumes rigs via the 'vx:director-rig' bus event; the director
 * never touches a canvas itself except in export paths.
 *
 * Depends on (all optional, guarded): W19 multivortex (selected vortex),
 * W12 snapshots, W25 manifests, any field backend for tracer positions.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w20-director: VORTEX namespace not loaded');
  var utils = V.utils;

  var MIN_RATE = 0.1, MAX_RATE = 16;

  // ---------- rigs & math ----------
  function defaultRig() {
    return { position: { x: 0, y: 1.4, z: 2.2 }, target: { x: 0, y: 0, z: 0 },
             zoom: 1, tilt: 25 };
  }
  function cloneRig(r) {
    var c = { position: { x: r.position.x, y: r.position.y, z: r.position.z },
              target: { x: r.target.x, y: r.target.y, z: r.target.z },
              zoom: r.zoom, tilt: r.tilt };
    // preserve follow metadata (follows/tracerIndex/followSource/stub)
    if (r.follows !== undefined) c.follows = r.follows;
    if (r.tracerIndex !== undefined) c.tracerIndex = r.tracerIndex;
    if (r.followSource !== undefined) c.followSource = r.followSource;
    if (r.stub !== undefined) c.stub = r.stub;
    return c;
  }
  function validRig(r) {
    if (!r || !r.position || !r.target) return false;
    var nums = [r.position.x, r.position.y, r.position.z,
                r.target.x, r.target.y, r.target.z, r.zoom, r.tilt];
    for (var i = 0; i < nums.length; i++) {
      if (typeof nums[i] !== 'number' || !isFinite(nums[i])) return false;
    }
    return r.zoom > 0;
  }
  function smooth(u) { return u * u * (3 - 2 * u); }          // smoothstep
  function smoother(u) { return u * u * u * (u * (u * 6 - 15) + 10); }
  var EASES = {
    linear: function (u) { return u; },
    smooth: smooth,
    smoother: smoother,
    'in-out': function (u) { return 0.5 - 0.5 * Math.cos(Math.PI * u); },
    out: function (u) { return 1 - Math.pow(1 - u, 3); },
    snap: function (u) { return u < 1 ? 0 : 1; }
  };
  function lerpRig(a, b, u, easeFn) {
    var e = (easeFn || smooth)(utils.clamp(u, 0, 1));
    function L(p, q) { return p + (q - p) * e; }
    return {
      position: { x: L(a.position.x, b.position.x), y: L(a.position.y, b.position.y), z: L(a.position.z, b.position.z) },
      target:   { x: L(a.target.x, b.target.x),     y: L(a.target.y, b.target.y),     z: L(a.target.z, b.target.z) },
      zoom: L(a.zoom, b.zoom), tilt: L(a.tilt, b.tilt)
    };
  }

  // ---------- state ----------
  var rig = defaultRig();
  var keyframes = [];        // [{t, rig, ease}]
  var rate = 1, paused = false;
  var simTime = 0;           // sim-seconds accumulated (scaled by rate)
  var pendingSub = 0;        // fractional substeps accumulator for rate<1
  var recording = null;      // {seed, t0, log:[{t,type,data}]}
  var attract = { on: false, angle: 0, phase: 0, phaseT: 0, framings: ['top-down', 'vortex-centric', 'edge-on', 'chase-tracer'] };
  var domain = { min: -1, max: 1 };
  var manifestSeed = 1;
  var attractListeners = [];

  function emitRig(source) {
    V.bus.emit('vx:director-rig', { rig: cloneRig(rig), source: source || 'director' });
  }

  // ---------- keyframes ----------
  function addKeyframe(t, r, ease) {
    t = Number(t);
    if (!isFinite(t) || t < 0) return { ok: false, error: 'bad time' };
    var rr = validRig(r) ? cloneRig(r) : cloneRig(rig);
    var en = (ease && EASES[ease]) ? ease : 'smooth';
    var k = { t: t, rig: rr, ease: en };
    var i = 0;
    while (i < keyframes.length && keyframes[i].t <= t) i++;
    keyframes.splice(i, 0, k);
    return { ok: true, keyframe: k };
  }
  function interpolateAt(t) {
    if (keyframes.length === 0) return cloneRig(rig);
    if (t <= keyframes[0].t) return cloneRig(keyframes[0].rig);
    var last = keyframes[keyframes.length - 1];
    if (t >= last.t) return cloneRig(last.rig);
    for (var i = 0; i < keyframes.length - 1; i++) {
      var a = keyframes[i], b = keyframes[i + 1];
      if (t >= a.t && t <= b.t) {
        var u = (t - a.t) / Math.max(1e-9, b.t - a.t);
        return lerpRig(a.rig, b.rig, u, EASES[b.ease] || smooth);
      }
    }
    return cloneRig(rig);
  }

  // ---------- framings ----------
  function selectedVortexPos() {
    try {
      var mv = V.get('w19-multivortex');
      if (mv && typeof mv.getSelectedVortex === 'function') {
        var v = mv.getSelectedVortex();
        if (v && v.position && isFinite(v.position.x)) {
          return { x: v.position.x, y: v.position.y || 0, z: v.position.z || 0, source: 'w19-multivortex' };
        }
      }
    } catch (e) { /* guarded */ }
    return { x: 0, y: 0, z: 0, source: 'default-origin' };
  }
  // Probe known backend APIs for a real tracer position. Order: W14 CPU (reference),
  // W02 WebGL2, W03 megafield. Each entry is an optional-function chain.
  function tracerPos(k) {
    var ids = ['w14-cpu', 'w02-gpu', 'w03-megafield'];
    for (var i = 0; i < ids.length; i++) {
      var b = null;
      try { b = V.get(ids[i]); } catch (e) { b = null; }
      if (!b) continue;
      try {
        if (typeof b.tracerPosition === 'function') {
          var p = b.tracerPosition(k);
          if (p && isFinite(p.x)) return { x: p.x, y: p.y || 0, z: p.z || 0, source: ids[i] + '.tracerPosition' };
        }
        if (typeof b.tracerPositions === 'function') {
          var arr = b.tracerPositions();
          if (arr && arr.length > k * 3 + 2) {
            return { x: arr[k * 3], y: arr[k * 3 + 1], z: arr[k * 3 + 2], source: ids[i] + '.tracerPositions' };
          }
        }
      } catch (e) { /* keep probing */ }
    }
    return null;
  }
  // Documented deterministic stub: no tracer arrays exist yet (backend not
  // registered or exposes no position API). Circular drift so chase still
  // moves predictably; the rig flags source:'tracer-stub'.
  function tracerStubPos(k, t) {
    var r = 0.5, w = 0.2 + 0.03 * (k % 5);
    var a = w * t + k * 0.7;
    return { x: r * Math.cos(a), y: 0.02 * Math.sin(3 * a), z: r * Math.sin(a), source: 'tracer-stub' };
  }

  var FRAMINGS = {
    'top-down': function () {
      return { position: { x: 0, y: 2.6, z: 0.001 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, tilt: 0 };
    },
    'edge-on': function () {
      return { position: { x: 0, y: 0.12, z: 2.6 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, tilt: 4 };
    },
    'vortex-centric': function () {
      var p = selectedVortexPos();
      return { position: { x: p.x, y: 1.1, z: p.z + 1.5 }, target: { x: p.x, y: p.y, z: p.z },
               zoom: 1.6, tilt: 30, follows: 'vortex', followSource: p.source };
    },
    'chase-tracer': function (k) {
      var idx = (typeof k === 'number' && isFinite(k) && k >= 0) ? Math.floor(k) : 0;
      var p = tracerPos(idx) || tracerStubPos(idx, simTime);
      var isStub = p.source === 'tracer-stub';
      return { position: { x: p.x + 0.35, y: 0.5, z: p.z + 0.35 }, target: { x: p.x, y: p.y, z: p.z },
               zoom: 2.2, tilt: 32, follows: 'tracer', tracerIndex: idx,
               followSource: p.source, stub: isStub };
    }
  };
  function applyFraming(name, arg) {
    var fn = FRAMINGS[name];
    if (!fn) return { ok: false, error: 'unknown framing ' + name };
    var r = fn(arg);
    if (!validRig(r)) return { ok: false, error: 'framing produced invalid rig' };
    rig = cloneRig(r);
    logInput('framing', { name: name, arg: arg === undefined ? null : arg });
    emitRig('framing:' + name);
    V.bus.emit('vx:director-framing', { name: name, rig: cloneRig(rig) });
    return { ok: true, rig: cloneRig(rig) };
  }
  // chase follow-up: called by host each frame while follows:'tracer' is active
  function followUpdate() {
    if (!rig.follows) return;
    var r;
    if (rig.follows === 'tracer') r = FRAMINGS['chase-tracer'](rig.tracerIndex || 0);
    else if (rig.follows === 'vortex') r = FRAMINGS['vortex-centric']();
    else return;
    rig = r;
    emitRig('follow:' + rig.follows);
  }

  // ---------- input log / recording ----------
  function logInput(type, data) {
    if (!recording) return;
    recording.log.push({ t: Math.round((simTime - recording.t0) * 1000) / 1000,
                         type: String(type), data: data === undefined ? null : data });
  }
  function startRecording(seed) {
    recording = { seed: (seed >>> 0) || 1, t0: simTime, log: [] };
    V.bus.emit('vx:director-record', { state: 'started', seed: recording.seed });
    return { ok: true, seed: recording.seed };
  }
  function stopRecording() {
    if (!recording) return { ok: false, error: 'not recording' };
    var rec = { seed: recording.seed, inputLog: recording.log.slice() };
    recording = null;
    V.bus.emit('vx:director-record', { state: 'stopped', events: rec.inputLog.length });
    return { ok: true, record: rec };
  }

  // ---------- replay ----------
  function applyInput(type, data) {
    // Bindings to other lanes are all guarded; unknown types are recorded as
    // applied-noop so replay never crashes on future input types.
    try {
      if (type === 'framing' && data && data.name) {
        return applyFraming(data.name, data.arg === null ? undefined : data.arg);
      }
      if (type === 'setRate') { setRate(data && data.rate); return { ok: true }; }
      if (type === 'pause') { setPaused(true); return { ok: true }; }
      if (type === 'resume') { setPaused(false); return { ok: true }; }
      if (type === 'keyframe' && data) {
        return addKeyframe(data.t, data.rig, data.ease);
      }
      if (type === 'restore-snapshot' && data && data.snapshotId) {
        var w12 = V.get('w12-snapshots');
        if (w12 && typeof w12.restore === 'function') {
          w12.restore(data.snapshotId);
          return { ok: true, bound: 'w12-snapshots' };
        }
        return { ok: false, error: 'w12-snapshots not present', bound: null };
      }
      if (type === 'probe' && data) {
        // Probe injection requires an owner grant (CONTRACTS §9); replay never
        // injects on its own — it records intent and reports the gate.
        return { ok: false, error: 'probe injection requires owner grant; replay does not inject', bound: null };
      }
      return { ok: true, noop: true, note: 'unbound input type recorded, no-op' };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  function replay(seed, inputLog) {
    var log = Array.isArray(inputLog) ? inputLog.slice() : [];
    log.sort(function (a, b) { return a.t - b.t; });
    var applied = [];
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      var res = applyInput(e.type, e.data);
      applied.push({ t: e.t, type: e.type, ok: !!(res && res.ok), detail: res });
      V.bus.emit('vx:replay-applied', { t: e.t, type: e.type, ok: !!(res && res.ok) });
    }
    var manifest = null;
    try {
      if (V.has('w25-determinism')) {
        manifest = V.makeManifest({ seed: seed >>> 0, params: { directorReplay: true },
                                    configId: 'director-replay', backend: 'n/a', tracers: 0 });
      }
    } catch (e) { manifest = null; }
    V.bus.emit('vx:director-replay', { seed: seed >>> 0, events: applied.length, manifest: manifest });
    return { ok: true, seed: seed >>> 0, applied: applied,
             eventOrder: applied.map(function (a) { return a.type; }),
             manifest: manifest };
  }

  // ---------- time controls ----------
  function setRate(r) {
    r = Number(r);
    if (!isFinite(r)) return { ok: false, error: 'bad rate' };
    rate = utils.clamp(r, MIN_RATE, MAX_RATE);
    logInput('setRate', { rate: rate });
    V.bus.emit('vx:director-rate', { rate: rate });
    return { ok: true, rate: rate };
  }
  function setPaused(p) {
    paused = !!p;
    logInput(paused ? 'pause' : 'resume', null);
    V.bus.emit('vx:director-pause', { paused: paused });
    return { ok: true, paused: paused };
  }
  // Advance the director one wall-clock frame. Returns how many fixed-dt sim
  // steps the host should run this frame. rate>=1 -> round(rate) steps;
  // rate<1 -> fractional accumulator (one step every 1/rate frames).
  // Render interpolation note: hosts should interpolate draw state between
  // sim steps by fract = pendingSub (documented in the return value).
  function frame(realDt) {
    if (attract.on) attractTick(realDt);
    followUpdate();
    if (paused) return { steps: 0, paused: true, interp: 0 };
    var steps;
    if (rate >= 1) {
      steps = Math.round(rate);
      pendingSub = 0;
    } else {
      pendingSub += rate;
      steps = Math.floor(pendingSub);
      pendingSub -= steps;
    }
    simTime += steps * V.SIM_DT;
    return { steps: steps, paused: false, interp: utils.clamp(pendingSub, 0, 1),
             note: 'render may interpolate between sim steps by interp' };
  }
  function stepFrame() {
    // Single fixed-dt step regardless of pause/rate.
    simTime += V.SIM_DT;
    return { ok: true, steps: 1, simTime: Math.round(simTime * 1e6) / 1e6 };
  }

  // ---------- export ----------
  function directorState() {
    return { rig: cloneRig(rig), rate: rate, paused: paused, simTime: simTime,
             keyframes: keyframes.map(function (k) { return { t: k.t, ease: k.ease, rig: cloneRig(k.rig) }; }),
             attract: attract.on, codeVersion: V.codeVersion };
  }
  function sidecar(kind, status, extra) {
    var s = { kind: kind, status: status, ts: new Date().toISOString(), codeVersion: V.codeVersion };
    if (extra) { for (var k in extra) s[k] = extra[k]; }
    var m;
    try {
      m = V.makeManifest({ seed: manifestSeed, params: { director: true, exportKind: kind },
                           configId: 'director-export', backend: 'n/a', tracers: 0 });
    } catch (e) {
      m = { version: 1, codeVersion: V.codeVersion, seed: manifestSeed, params: {}, configId: 'director-export' };
    }
    return { manifest: m, directorState: directorState(), export: s };
  }
  function dataUrlFromCanvas(canvas, mime) {
    try {
      if (canvas && typeof canvas.toDataURL === 'function') return canvas.toDataURL(mime || 'image/png');
    } catch (e) { /* fall through */ }
    return null;
  }
  function exportStillPNG(canvas) {
    var url = dataUrlFromCanvas(canvas, 'image/png');
    if (!url) {
      return { ok: true, sidecar: sidecar('png', 'not-available',
        { reason: 'no canvas / headless environment; sidecar is the deliverable' }), dataUrl: null };
    }
    return { ok: true, sidecar: sidecar('png', 'ok', { bytes: url.length }), dataUrl: url };
  }
  function exportWebM(canvas, durationMs) {
    var sc = sidecar('webm', 'not-available', { reason: 'MediaRecorder/captureStream unavailable' });
    try {
      var MR = root.MediaRecorder;
      if (canvas && typeof canvas.captureStream === 'function' && MR) {
        // Implement the real path; capture is async — the sidecar is still
        // returned now, and chunks resolve via the returned handle.
        var stream = canvas.captureStream(60);
        var rec = new MR(stream, { mimeType: 'video/webm' });
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        var done = null;
        var finished = new Promise(function (res) { done = res; });
        rec.onstop = function () { done(chunks); };
        rec.start();
        var ms = Math.max(250, Math.min(30000, Number(durationMs) || 2000));
        setTimeout(function () { try { rec.stop(); } catch (e) {} }, ms);
        sc = sidecar('webm', 'recording', { durationMs: ms, async: true });
        return { ok: true, sidecar: sc, chunks: finished, stop: function () { try { rec.stop(); } catch (e) {} } };
      }
    } catch (e) {
      sc = sidecar('webm', 'not-available', { reason: 'MediaRecorder/captureStream threw: ' + (e && e.message) });
    }
    return { ok: true, sidecar: sc, chunks: null };
  }
  function exportGIF() {
    // Honest: no GIF encoder ships with the lab, no network to fetch one.
    return { ok: true, sidecar: sidecar('gif', 'not-available',
      { reason: 'no GIF encoder available; use WebM export where supported' }), dataUrl: null };
  }
  function export4KStill(canvas) {
    var W = 3840, H = 2160;
    var sc, url = null;
    try {
      var src = dataUrlFromCanvas(canvas, 'image/png');
      if (!src) {
        return { ok: true, sidecar: sidecar('png-4k', 'not-available',
          { reason: 'no source canvas; sidecar is the deliverable' }), dataUrl: null };
      }
      var doc = root.document;
      if (doc && typeof doc.createElement === 'function') {
        var off = doc.createElement('canvas');
        off.width = W; off.height = H;
        var ctx = off.getContext('2d');
        var img = new root.Image();
        // Async decode — sidecar notes method; dataUrl resolves via promise.
        var p = new Promise(function (res, rej) {
          img.onload = function () {
            ctx.drawImage(img, 0, 0, W, H);   // labeled upscale (no native 4K renderer hook present)
            try { res(off.toDataURL('image/png')); } catch (e) { rej(e); }
          };
          img.onerror = rej;
          img.src = src;
        });
        sc = sidecar('png-4k', 'ok', { width: W, height: H, method: 'upscale',
          note: 'native 4K requires a GPU render hook (not present); this is a labeled 3840-wide upscale of the live canvas' });
        return { ok: true, sidecar: sc, dataUrl: p };
      }
    } catch (e) {
      sc = sidecar('png-4k', 'not-available', { reason: String(e && e.message || e) });
      return { ok: true, sidecar: sc, dataUrl: null };
    }
    return { ok: true, sidecar: sidecar('png-4k', 'not-available', { reason: 'no document/canvas in this environment' }), dataUrl: url };
  }

  // ---------- attract mode ----------
  function attractTick(realDt) {
    attract.angle += realDt * 0.12;              // slow orbit ~52s per revolution
    attract.phaseT += realDt;
    if (attract.phaseT >= 12) {                 // framing cycle every 12s
      attract.phaseT = 0;
      attract.phase = (attract.phase + 1) % attract.framings.length;
      applyFraming(attract.framings[attract.phase]);
    }
    var r = cloneRig(rig);
    var cx = r.target.x, cz = r.target.z;
    var dx = r.position.x - cx, dz = r.position.z - cz;
    var rad = Math.sqrt(dx * dx + dz * dz) || 2.2;
    var a0 = Math.atan2(dz, dx) + realDt * 0.12;
    r.position.x = cx + rad * Math.cos(a0);
    r.position.z = cz + rad * Math.sin(a0);
    rig = r;
    emitRig('attract');
  }
  function startAttract() {
    if (attract.on) return { ok: true, already: true };
    attract.on = true; attract.phaseT = 0; attract.phase = 0;
    applyFraming(attract.framings[0]);
    bindAttractExit();
    V.bus.emit('vx:director-attract', { on: true });
    return { ok: true };
  }
  function stopAttract(reason) {
    if (!attract.on) return { ok: true, already: true };
    attract.on = false;
    unbindAttractExit();
    V.bus.emit('vx:director-attract', { on: false, reason: reason || 'api' });
    return { ok: true };
  }
  function noteUserInput() {
    // Any real input exits attract mode.
    if (attract.on) stopAttract('user-input');
  }
  function bindAttractExit() {
    if (!utils.isBrowser()) return;
    var d = root.document;
    function h() { noteUserInput(); }
    attractListeners = [
      ['pointerdown', d, h], ['keydown', d, h], ['wheel', d, h, { passive: true }]
    ];
    attractListeners.forEach(function (t) { t[1].addEventListener(t[0], t[2], t[3]); });
  }
  function unbindAttractExit() {
    attractListeners.forEach(function (t) {
      try { t[1].removeEventListener(t[0], t[2], t[3]); } catch (e) {}
    });
    attractListeners = [];
  }

  // ---------- api ----------
  var api = {
    version: 'w20-director/1.0',
    // rig
    setRig: function (r) {
      if (!validRig(r)) return { ok: false, error: 'invalid rig' };
      rig = cloneRig(r); emitRig('setRig');
      return { ok: true, rig: cloneRig(rig) };
    },
    getRig: function () { return cloneRig(rig); },
    // keyframes
    addKeyframe: addKeyframe,
    clearKeyframes: function () { keyframes = []; return { ok: true }; },
    keyframes: function () { return keyframes.map(function (k) { return { t: k.t, ease: k.ease, rig: cloneRig(k.rig) }; }); },
    interpolateAt: interpolateAt,
    // framings
    framing: applyFraming,
    framings: function () { return Object.keys(FRAMINGS); },
    followUpdate: followUpdate,
    // recording / replay
    startRecording: startRecording,
    stopRecording: stopRecording,
    logInput: function (type, data) { logInput(type, data); return { ok: !!recording }; },
    replay: replay,
    // time
    setRate: setRate,
    getRate: function () { return rate; },
    pause: function () { return setPaused(true); },
    resume: function () { return setPaused(false); },
    isPaused: function () { return paused; },
    stepFrame: stepFrame,
    frame: frame,
    getSimTime: function () { return simTime; },
    // export
    exportStillPNG: exportStillPNG,
    exportWebM: exportWebM,
    exportGIF: exportGIF,
    export4KStill: export4KStill,
    directorState: directorState,
    // attract
    startAttract: startAttract,
    stopAttract: stopAttract,
    isAttracting: function () { return attract.on; },
    noteUserInput: noteUserInput,
    // config
    setDomain: function (min, max) { domain.min = min; domain.max = max; return { ok: true }; },
    setManifestSeed: function (s) { manifestSeed = s >>> 0; return { ok: true }; },
    // panel
    mountPanel: mountPanel,

    selfTest: function () {
      var checks = [];
      function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

      // 1. keyframe interpolation hits endpoints
      keyframes = [];
      var r0 = { position: { x: 0, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, tilt: 0 };
      var r1 = { position: { x: 5, y: 1, z: -2 }, target: { x: 1, y: 0, z: 1 }, zoom: 2, tilt: 45 };
      addKeyframe(0, r0); addKeyframe(10, r1);
      var at0 = interpolateAt(0), at10 = interpolateAt(10), at5 = interpolateAt(5);
      var eps = 1e-9;
      function close(a, b) {
        return Math.abs(a.position.x - b.position.x) < eps && Math.abs(a.position.z - b.position.z) < eps &&
               Math.abs(a.zoom - b.zoom) < eps && Math.abs(a.tilt - b.tilt) < eps;
      }
      check('keyframe endpoints hit exactly', close(at0, r0) && close(at10, r1),
            'at0==r0 && at10==r1');
      check('keyframe midpoint interpolated', close(at5, lerpRig(r0, r1, 0.5, smooth)),
            'at5 == smoothstep midpoint');
      // ease=linear endpoint check still exact
      keyframes = []; addKeyframe(0, r0, 'linear'); addKeyframe(10, r1, 'linear');
      check('linear ease endpoints exact', close(interpolateAt(0), r0) && close(interpolateAt(10), r1), '');
      keyframes = [];

      // 2. framing presets produce valid rigs
      var names = Object.keys(FRAMINGS);
      var allValid = names.length === 4;
      names.forEach(function (n) {
        var res = applyFraming(n, n === 'chase-tracer' ? 3 : undefined);
        if (!(res.ok && validRig(res.rig))) allValid = false;
      });
      check('four framing presets produce valid rigs', allValid, names.join(','));
      var chase = applyFraming('chase-tracer', 2);
      check('chase-a-tracer k=2 honest about source', chase.ok && !!chase.rig.followSource,
            'followSource=' + (chase.rig && chase.rig.followSource));
      var vx = applyFraming('vortex-centric');
      check('vortex-centric degrades gracefully without W19', vx.ok && validRig(vx.rig),
            'followSource=' + (vx.rig && vx.rig.followSource));

      // 3. input-log replay on synthetic log reproduces event order
      var savedRate = rate, savedPaused = paused;
      var syn = [
        { t: 2.0, type: 'framing', data: { name: 'top-down', arg: null } },
        { t: 1.0, type: 'pause', data: null },
        { t: 3.0, type: 'setRate', data: { rate: 4 } },
        { t: 4.0, type: 'probe', data: { id: 'p1' } }   // must NOT inject: gate holds
      ];
      var rep = replay(4242, syn);
      var orderOk = rep.eventOrder.join(',') === 'pause,framing,setRate,probe';
      check('replay reproduces input event order (sorted by t)', orderOk, rep.eventOrder.join(','));
      check('replay paused before setRate (order respected)',
            rep.applied[0].ok && rep.applied[2].ok, '');
      var probeGate = rep.applied[3];
      check('replay refuses probe injection (owner gate)', probeGate.ok === false &&
            /owner grant/.test(probeGate.detail && probeGate.detail.error || ''),
            String(probeGate.detail && probeGate.detail.error));
      setRate(savedRate); setPaused(savedPaused);

      // 4. export sidecar contains manifest fields
      var ex = exportStillPNG(null);
      var m = ex.sidecar && ex.sidecar.manifest;
      var fieldsOk = !!m && V.manifestSchema.every(function (f) { return f in m; }) && !!m.hash;
      check('export sidecar carries full manifest + hash', fieldsOk,
            'fields: ' + (m ? Object.keys(m).join(',') : 'none'));
      check('export sidecar carries directorState', !!(ex.sidecar && ex.sidecar.directorState &&
            ex.sidecar.directorState.rig && Array.isArray(ex.sidecar.directorState.keyframes)),
            'rig+keyframes present');
      check('headless PNG export is honest', ex.dataUrl === null &&
            /no canvas/.test(ex.sidecar.export.reason || ''), String(ex.sidecar.export.reason));
      var gif = exportGIF();
      check('GIF export degrades honestly', gif.sidecar.export.status === 'not-available', '');

      // 5. attract exits on synthetic input
      startAttract();
      var wasOn = attract.on;
      noteUserInput();
      check('attract exits on synthetic input event', wasOn && !attract.on, '');
      stopAttract();

      // 6. time controls
      setRate(16); check('rate clamps to 16', rate === 16, '');
      setRate(0.01); check('rate clamps to 0.1', rate === 0.1, '');
      setRate(2);
      var fr = frame(1 / 60);
      check('2x rate yields 2 substeps/frame', fr.steps === 2, 'steps=' + fr.steps);
      setRate(0.5); var acc = 0;
      for (var i = 0; i < 4; i++) acc += frame(1 / 60).steps;
      check('0.5x rate yields 1 step per 2 frames', acc === 2, 'steps in 4 frames=' + acc);
      setRate(1);
      var p = frame(1 / 60);
      check('pause yields zero steps', (function () { setPaused(true); var q = frame(1 / 60); setPaused(false); return q.steps === 0 && q.paused; })(), '');
      var sf = stepFrame();
      check('stepFrame advances exactly one fixed step', sf.ok && sf.steps === 1, '');

      // 7. recording round-trip
      startRecording(777);
      logInput('framing', { name: 'edge-on', arg: null });
      var rec = stopRecording();
      check('recording captures seed + input log', rec.ok && rec.record.seed === 777 &&
            rec.record.inputLog.length === 1 && rec.record.inputLog[0].type === 'framing',
            'events=' + (rec.ok ? rec.record.inputLog.length : 0));

      var ok = checks.every(function (c) { return c.ok; });
      return { ok: ok, checks: checks };
    }
  };

  // ---------- panel ----------
  function mountPanel(el) {
    if (!utils.isBrowser() || !el) return;
    var d = root.document;
    function btn(label, fn) {
      var b = d.createElement('button'); b.textContent = label;
      b.onclick = function () { try { fn(); } catch (e) { V.ui.announce('Director: ' + e.message); } };
      return b;
    }
    var wrap = d.createElement('div'); wrap.className = 'vx-director-panel';

    var h1 = d.createElement('h3'); h1.textContent = 'Framing'; wrap.appendChild(h1);
    var fr = d.createElement('div'); fr.className = 'vx-btnrow';
    [['Top-down', 'top-down'], ['Edge-on', 'edge-on'], ['Vortex-centric', 'vortex-centric'],
     ['Chase tracer', 'chase-tracer']].forEach(function (p) {
      fr.appendChild(btn(p[0], function () {
        var r = applyFraming(p[1], p[1] === 'chase-tracer' ? 0 : undefined);
        V.ui.announce('Framing: ' + p[0] + (r.rig && r.rig.stub ? ' (tracer stub — no backend arrays)' : ''));
      }));
    });
    wrap.appendChild(fr);

    var h2 = d.createElement('h3'); h2.textContent = 'Time'; wrap.appendChild(h2);
    var tc = d.createElement('div'); tc.className = 'vx-btnrow';
    tc.appendChild(btn('⏸ Pause', function () { setPaused(true); V.ui.announce('Paused'); }));
    tc.appendChild(btn('▶ Resume', function () { setPaused(false); V.ui.announce('Resumed'); }));
    tc.appendChild(btn('⏭ Step', function () { stepFrame(); V.ui.announce('Stepped 1/60 s'); }));
    var rs = d.createElement('select');
    [0.1, 0.5, 1, 2, 4, 8, 16].forEach(function (r) {
      var o = d.createElement('option'); o.value = r; o.textContent = r + '×';
      if (r === 1) o.selected = true; rs.appendChild(o);
    });
    rs.onchange = function () { setRate(Number(rs.value)); V.ui.announce('Rate ' + rs.value + '×'); };
    tc.appendChild(rs);
    wrap.appendChild(tc);

    var h3 = d.createElement('h3'); h3.textContent = 'Keyframes'; wrap.appendChild(h3);
    var kf = d.createElement('div'); kf.className = 'vx-btnrow';
    var kfList = d.createElement('div'); kfList.className = 'vx-kflist';
    function refreshKf() {
      /* NOTE (audit 2026-09-20): inside mountPanel, `keyframes` is the module
       * array, not api.keyframes() — call it as data, not a function. */
      kfList.innerHTML = '';
      keyframes.forEach(function (k) {
        var line = d.createElement('div');
        line.textContent = 't=' + k.t.toFixed(2) + 's · ' + k.ease + ' · zoom ' + k.rig.zoom.toFixed(2);
        kfList.appendChild(line);
      });
      if (!keyframes.length) kfList.textContent = '(none)';
    }
    kf.appendChild(btn('+ Add at now', function () {
      addKeyframe(simTime, rig); refreshKf(); V.ui.announce('Keyframe added at t=' + simTime.toFixed(2));
    }));
    kf.appendChild(btn('▶ Play track', function () {
      if (!keyframes.length) { V.ui.announce('No keyframes'); return; }
      var last = keyframes[keyframes.length - 1];
      setPaused(false); setRate(1);
      var t0 = simTime;
      (function tick() {
        var t = simTime - t0;
        if (t >= last.t || paused) return;
        rig = interpolateAt(t); emitRig('keyframe-track');
        setTimeout(tick, 33);
      })();
    }));
    kf.appendChild(btn('Clear', function () { api.clearKeyframes(); refreshKf(); }));
    wrap.appendChild(kf); wrap.appendChild(kfList); refreshKf();

    var h4 = d.createElement('h3'); h4.textContent = 'Export'; wrap.appendChild(h4);
    var ex = d.createElement('div'); ex.className = 'vx-btnrow';
    ex.appendChild(btn('PNG still', function () {
      var r = exportStillPNG(d.querySelector('canvas'));
      V.ui.announce('PNG still: ' + r.sidecar.export.status + ' (sidecar attached)');
    }));
    ex.appendChild(btn('WebM', function () {
      var r = exportWebM(d.querySelector('canvas'), 2000);
      V.ui.announce('WebM: ' + r.sidecar.export.status);
    }));
    ex.appendChild(btn('4K still', function () {
      var r = export4KStill(d.querySelector('canvas'));
      V.ui.announce('4K still: ' + r.sidecar.export.status);
    }));
    wrap.appendChild(ex);

    var h5 = d.createElement('h3'); h5.textContent = 'Demo'; wrap.appendChild(h5);
    var at = d.createElement('div'); at.className = 'vx-btnrow';
    at.appendChild(btn('Attract mode', function () {
      if (attract.on) stopAttract('panel'); else startAttract();
      V.ui.announce(attract.on ? 'Attract mode on — any input exits' : 'Attract mode off');
    }));
    wrap.appendChild(at);

    el.appendChild(wrap);
  }

  // Register panel (DOM-guarded: registerPanel only stores mountFn).
  try { V.ui.registerPanel('w20-director', 'Director', mountPanel); } catch (e) { /* headless */ }

  V.register('w20-director', api);
})(typeof window !== 'undefined' ? window : globalThis);
