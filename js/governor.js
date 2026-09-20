/* VORTEX js/governor.js — W11 performance governor.
 *
 * Budgets, hysteresis, mobile tiers, thermal backoff, battery pin,
 * standardized 10s benchmark, tier persistence. Degradation is NARRATED,
 * never silent: every change goes through VORTEX.ui.announce(), the
 * GOV:ACTIVE / GOV:LOCKED footer chip, and a one-step undo.
 *
 * Plain script, no modules, no network, no eval. Headless-safe: with no
 * backend attached it operates on synthetic frame times (selfTest does this).
 *
 * Field-contract interface (W02/W14/W15): the governor NEVER re-inits a
 * backend itself. Cheap knobs (renderScale, substeps) go through
 * backend.setParams() when present; tier changes (tracers/grid) are
 * requested on the bus as 'vx:tier' {tier, tracers, grid, ...} so the
 * backend owner (boot/selector) can rebuild buffers without a black flash.
 * VORTEX.has()/get() are used to discover a registered backend; without one
 * the governor still adapts and records its intended actions.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('w11-governor: VORTEX namespace missing — load vx-namespace.js first');
  }

  /* ---------------- constants ---------------- */

  // Lane-14 §9 budgets. background = throughput-max: governor is passive.
  var BUDGETS = { interactive: 16.7, cinematic: 33.3, background: Infinity };

  // Mobile tier table (perf plan §2). Grid is the cost, not just tracers.
  var TIERS = [
    { tier: 0, name: 'Pocket',   tracers: 1024, grid: 128, fps: 24, renderScale: 0.50, substeps: 1, backendHint: 'cpu',
      note: 'compatibility floor — never off' },
    { tier: 1, name: 'Standard', tracers: 2048, grid: 192, fps: 30, renderScale: 0.75, substeps: 1, backendHint: 'gpu16f',
      note: 'balanced' },
    { tier: 2, name: 'Pro',      tracers: 4096, grid: 256, fps: 30, renderScale: 1.00, substeps: 2, backendHint: 'gpu16f',
      note: 'flagship; 60fps burst is labeled and time-boxed 30s' }
  ];
  var SCALE_NOTCHES = [0.50, 0.625, 0.75, 0.875, 1.00]; // render-scale ladder

  var WINDOW = 120;                    // rolling frame-time window
  var EVAL_MS = 2000;                  // evaluation cadence (never per-frame)
  var OVER_BUDGET_FRAMES = 5;          // lane spec §9: step DOWN after 5 frames over budget
  var UNDER_BUDGET_FRAMES = 120;       // step UP only after 120 frames under 0.6x budget
  var PROMOTE_FRac = 0.6;
  var COOLDOWN_AFTER_DROP_MS = 60000;  // no promote within 60s of a drop
  var MAX_TIER_CHANGES_PER_5MIN = 2;   // anti-oscillation rate limit
  var RATE_WINDOW_MS = 300000;
  var MIN_WINDOW_FOR_DROP = 60;        // don't judge on a half-empty window

  var THERMAL_DRIFT = 1.25;            // >25% p50 drift vs baseline => thermal
  var THERMAL_RESOLVE = 1.10;
  var THERMAL_CLEAR_MS = 300000;       // 5-min cooldown before flag can clear
  var EMA_ALPHA = 2 / 31;              // ~60s EMA over 2s evaluations

  var STORE_TIER_KEY = 'vortex.gov.tier.v1';
  var STORE_BENCH_KEY = 'vortex.gov.bench.v1';
  var STORE_TTL_MS = 30 * 24 * 3600 * 1000; // 30-day tier persistence
  var BENCH_SECONDS = 10;
  var BENCH_HISTORY_CAP = 50;

  /* ---------------- small helpers ---------------- */

  function sortedCopy(a) {
    var c = a.slice();
    c.sort(function (x, y) { return x - y; });
    return c;
  }
  function percentile(sortedAsc, q) {
    if (!sortedAsc.length) return 0;
    var i = Math.ceil(q * sortedAsc.length) - 1;
    if (i < 0) i = 0;
    if (i > sortedAsc.length - 1) i = sortedAsc.length - 1;
    return sortedAsc[i];
  }
  function median(a) {
    if (!a.length) return 0;
    var s = sortedCopy(a);
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(a) {
    if (!a.length) return 0;
    var t = 0, i;
    for (i = 0; i < a.length; i++) t += a[i];
    return t / a.length;
  }
  function r2(x) { return Math.round(x * 100) / 100; }

  function defaultStorage() {
    try {
      if (typeof root.localStorage === 'undefined' || !root.localStorage) return null;
      return {
        getItem: function (k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
        setItem: function (k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* quota etc: ignore */ } },
        removeItem: function (k) { try { root.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
      };
    } catch (e) { return null; }
  }

  function parseForceTier() {
    try {
      var loc = root.location;
      if (!loc || !loc.search) return null;
      var m = /[?&]vortex=force-tier=([0-2])/.exec(loc.search);
      return m ? parseInt(m[1], 10) : null;
    } catch (e) { return null; }
  }

  function probeWebGL2() {
    // Best-effort only. null = unknown (headless), false = absent, true = present.
    try {
      if (!V.utils.isBrowser() || typeof root.document === 'undefined') return null;
      var c = root.document.createElement('canvas');
      if (!c || typeof c.getContext !== 'function') return null;
      var gl = c.getContext('webgl2');
      return gl ? true : false;
    } catch (e) { return null; }
  }

  /* ---------------- governor factory ---------------- */

  function createGovernor(opts) {
    opts = opts || {};
    var now = (typeof opts.now === 'function') ? opts.now : V.utils.now;
    var storage = ('storage' in opts) ? opts.storage : defaultStorage();
    var onAnnounce = (typeof opts.onAnnounce === 'function') ? opts.onAnnounce : null;
    var busSpy = (typeof opts.busSpy === 'function') ? opts.busSpy : null;
    // Test seam: inject a fake navigator (device signals) without touching globals.
    var NAV = (opts.navigator && typeof opts.navigator === 'object') ? opts.navigator : (root.navigator || {});

    function fingerprint() {
      try {
        var fp = (NAV.userAgent || '') + '|' + (NAV.platform || '') + '|' +
                 (NAV.deviceMemory || '?') + '|' + (NAV.hardwareConcurrency || '?');
        if (root.screen) fp += '|' + root.screen.width + 'x' + root.screen.height;
        return V.utils.hash53(fp);
      } catch (e) { return 'unknown'; }
    }

    function emit(name, detail) {
      if (busSpy) { try { busSpy(name, detail); } catch (e) { /* spy must not break */ } }
      V.bus.emit(name, detail);
    }
    function announce(msg) {
      if (onAnnounce) { try { onAnnounce(msg); } catch (e) { /* ignore */ } }
      V.ui.announce('Governor: ' + msg);
    }

    /* ----- starting tier: conservative auto-detect (perf plan §3) ----- */
    function detectStartTier() {
      var forced = parseForceTier();
      if (forced !== null) return { tier: forced, locked: true, reason: 'force-tier flag' };
      var score = 2;
      try {
        var nav = NAV;
        var ua = nav.userAgent || '';
        var coarse = false;
        try { coarse = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches); } catch (e) {}
        var isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || coarse;
        if (isMobile) score = Math.min(score, 1); // mobile starts no higher than Tier 1
        var dm = nav.deviceMemory;
        if (typeof dm === 'number') {
          if (dm < 4) score = 0; else if (dm >= 8) score = Math.min(score, 2); else score = Math.min(score, 1);
        }
        var hc = nav.hardwareConcurrency;
        if (typeof hc === 'number') {
          if (hc <= 4) score = 0; else if (hc >= 8) score = Math.min(score, 2); else score = Math.min(score, 1);
        }
        var gl2 = probeWebGL2();
        if (gl2 === false) score = 0; // no WebGL2 -> CPU Tier 0 path
      } catch (e) { /* best effort; detection never throws */ }
      var tier = Math.max(0, Math.min(2, score));
      // Persisted tier starts near-correct (30-day expiry, device-fingerprinted).
      var persisted = loadPersistedTier();
      if (persisted !== null) tier = persisted;
      return { tier: tier, locked: false, reason: persisted !== null ? 'persisted' : 'auto-detect' };
    }

    function loadPersistedTier() {
      if (!storage) return null;
      try {
        var raw = storage.getItem(STORE_TIER_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (!o || typeof o.tier !== 'number') return null;
        if (o.fp !== fingerprint()) return null;      // different device
        if ((now() - o.ts) > STORE_TTL_MS) return null;      // older than 30 days
        if (o.tier < 0 || o.tier > 2) return null;
        return o.tier;
      } catch (e) { return null; }
    }
    function persistTier() {
      if (!storage) return;
      try {
        storage.setItem(STORE_TIER_KEY, JSON.stringify({ tier: s.tier, ts: now(), fp: fingerprint() }));
      } catch (e) { /* ignore */ }
    }

    /* ----- state ----- */
    var start = (typeof opts.startTier === 'number') ? opts.startTier : detectStartTier().tier;
    var s = {
      tier: Math.max(0, Math.min(2, start)),
      mode: 'cinematic', // default: cinematic 33.3ms budget (aligns with plan DROP_P95=33.4)
      substeps: TIERS[Math.max(0, Math.min(2, start))].substeps,
      scaleIdx: SCALE_NOTCHES.indexOf(TIERS[Math.max(0, Math.min(2, start))].renderScale),
      locked: false, lockReason: null,
      frames: [], totalFrames: 0,
      underCount: 0, overWindows: 0,
      tierChangeTimes: [], lastDropAt: 0, rateLimitedNoteAt: 0,
      thermalFlag: false, thermalFlagAt: 0, thermalBaseline: null, emaP50: null,
      baselineCandidates: [], tierStableSince: now(), warmupDone: false,
      batteryPin: false, batteryLevel: null, batteryCharging: null,
      atFloor: false,
      history: [],            // undo stack: {kind, from, to, at, reason}
      bench: null,            // live benchmark in progress
      benchHistory: loadBenchHistory(),
      backend: null,
      p50: null, p95: null, fps: null, meanMs: null,
      paused: false, skipFirst: false,
      startedAt: now(), intervalId: null,
      burstUntil: 0,
      lastBackendAction: null
    };
    var det = (typeof opts.startTier === 'number') ? null : detectStartTierMeta();
    function detectStartTierMeta() {
      // re-run cheaply to capture lock state when startTier wasn't injected
      var forced = parseForceTier();
      if (forced !== null) return { locked: true, reason: 'force-tier flag' };
      return { locked: false, reason: 'auto' };
    }
    if (det && det.locked) { s.locked = true; s.lockReason = det.reason; }
    if (opts.battery && typeof opts.battery.level === 'number') {
      // test seam: {level, charging}
      applyBatteryState(opts.battery.level, !!opts.battery.charging);
    }

    function loadBenchHistory() {
      if (!storage) return [];
      try {
        var raw = storage.getItem(STORE_BENCH_KEY);
        var h = raw ? JSON.parse(raw) : [];
        return Array.isArray(h) ? h.slice(-BENCH_HISTORY_CAP) : [];
      } catch (e) { return []; }
    }
    function persistBenchHistory() {
      if (!storage) return;
      try { storage.setItem(STORE_BENCH_KEY, JSON.stringify(s.benchHistory.slice(-BENCH_HISTORY_CAP))); }
      catch (e) { /* ignore */ }
    }

    function budget() { return BUDGETS[s.mode] !== undefined ? BUDGETS[s.mode] : BUDGETS.cinematic; }
    function maxTier() { return s.batteryPin ? 0 : deviceMaxTier(); }
    function deviceMaxTier() {
      try {
        var nav = NAV;
        var ua = nav.userAgent || '';
        var coarse = false;
        try { coarse = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches); } catch (e) {}
        if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua) || coarse) return 1;
      } catch (e) {}
      return 2;
    }
    function snap() { return { tier: s.tier, substeps: s.substeps, scaleIdx: s.scaleIdx }; }
    function tierName(t) { return 'Tier ' + t + ' ' + TIERS[t].name; }

    function effectiveConfig() {
      var t = TIERS[s.tier];
      return {
        tier: s.tier, name: t.name, tracers: t.tracers, grid: t.grid,
        fps: (s.burstUntil > now()) ? 60 : t.fps,
        renderScale: SCALE_NOTCHES[s.scaleIdx],
        substeps: s.substeps, backendHint: t.backendHint,
        burst: s.tier === 2 ? { fps: 60, label: '60 burst — labeled, time-boxed 30s, flagship only' } : null
      };
    }

    /* ----- backend driving ----- */
    function discoverBackend() {
      if (s.backend) return s.backend;
      try {
        var ids = V.modules();
        for (var i = 0; i < ids.length; i++) {
          var m = V.get(ids[i]);
          // field-contract shape: setParams + step (+render). Governor has none of these, no self-match.
          if (m && typeof m.setParams === 'function' && typeof m.step === 'function') {
            s.backend = m;
            return m;
          }
        }
      } catch (e) { /* never break on discovery */ }
      return null;
    }

    function applyToBackend(reason) {
      var cfg = effectiveConfig();
      var action = {
        tier: cfg.tier, tierName: cfg.name, tracers: cfg.tracers, grid: cfg.grid,
        renderScale: cfg.renderScale, substeps: cfg.substeps, fpsTarget: cfg.fps,
        reason: reason || ''
      };
      s.lastBackendAction = action;
      var b = s.backend || discoverBackend();
      if (b && typeof b.setParams === 'function') {
        try { b.setParams({ renderScale: cfg.renderScale, substeps: cfg.substeps }); }
        catch (e) { /* backend may not accept these knobs; vx:tier carries the full config */ }
      }
      // Tier changes (tracers/grid) need a backend rebuild: the backend owner
      // listens for vx:tier and re-inits without a black flash.
      emit('vx:tier', action);
    }

    /* ----- footer chips ----- */
    function renderChips() {
      if (!V.utils.isBrowser()) return;
      try {
        var f = root.document.getElementById('vx-footer');
        if (!f) return;
        var c = root.document.getElementById('vx-chip-governor');
        if (!c) {
          c = root.document.createElement('span');
          c.id = 'vx-chip-governor';
          c.className = 'vx-chip vx-chip-gov';
          c.style.cursor = 'pointer';
          c.addEventListener('click', function () { api.undo(); });
          f.appendChild(c);
        }
        var locked = s.locked || s.batteryPin;
        c.textContent = locked ? 'GOV:LOCKED' : 'GOV:ACTIVE';
        c.title = 'Governor: ' + tierName(s.tier) +
          (s.thermalFlag ? ' — thermal-limited' : '') +
          (s.batteryPin ? ' — battery pinned' : '') +
          ' (click to undo last change)';
      } catch (e) { /* headless / DOM-less: chips are optional */ }
    }

    /* ----- change application (all narrated, all undoable) ----- */
    function applyChange(kind, patch, reason) {
      var from = snap();
      if (patch.tier !== undefined) s.tier = patch.tier;
      if (patch.substeps !== undefined) s.substeps = patch.substeps;
      if (patch.scaleIdx !== undefined) s.scaleIdx = patch.scaleIdx;
      // ladder resets when the tier itself moves
      if (kind === 'tier' || kind === 'battery' || kind === 'thermal') {
        var t = TIERS[s.tier];
        s.substeps = t.substeps;
        s.scaleIdx = SCALE_NOTCHES.indexOf(t.renderScale);
        s.tierStableSince = now();
      }
      s.atFloor = false;
      s.history.push({ kind: kind, from: from, to: snap(), at: now(), reason: reason });
      if (s.history.length > 50) s.history.shift();
      applyToBackend(reason);
      renderChips();
      return true;
    }

    function describeChange(kind, from, reason) {
      var bits = [];
      if (kind === 'tier') bits.push('tier ' + from.tier + '→' + s.tier + ' (' + TIERS[from.tier].name + '→' + TIERS[s.tier].name + ')');
      else if (kind === 'substeps') bits.push('substeps ' + from.substeps + '→' + s.substeps);
      else if (kind === 'scale') bits.push('render scale ' + String(SCALE_NOTCHES[from.scaleIdx]) + '→' + String(SCALE_NOTCHES[s.scaleIdx]));
      else if (kind === 'thermal') bits.push('tier ' + from.tier + '→' + s.tier + ' (thermal)');
      else if (kind === 'battery') bits.push('tier ' + from.tier + '→' + s.tier + ' (battery)');
      else if (kind === 'promote') bits.push('tier ' + from.tier + '→' + s.tier + ' (' + TIERS[from.tier].name + '→' + TIERS[s.tier].name + ')');
      else if (kind === 'burst') bits.push('60fps burst for 30s');
      else if (kind === 'manual') bits.push('tier ' + from.tier + '→' + s.tier + ' (manual)');
      if (reason) bits.push(reason);
      return bits.join(' — ');
    }

    function tierChangesIn5Min(t) {
      s.tierChangeTimes = s.tierChangeTimes.filter(function (x) { return t - x < RATE_WINDOW_MS; });
      return s.tierChangeTimes.length;
    }

    function stepDown(reason) {
      var t = now();
      if (s.locked || s.batteryPin) return 'locked';
      if (tierChangesIn5Min(t) >= MAX_TIER_CHANGES_PER_5MIN) {
        if (t - s.rateLimitedNoteAt > 30000) {
          s.rateLimitedNoteAt = t;
          announce('at tier-change rate limit (2 per 5 min) — holding ' + tierName(s.tier) + '.');
        }
        return 'rate-limited';
      }
      // Degradation order within a tier first: substeps 2→1, render scale down
      // one notch, THEN the tier drop.
      if (s.substeps > 1) {
        applyChange('substeps', { substeps: s.substeps - 1 }, reason);
        announce('frame budget exceeded — ' + describeChange('substeps', s.history[s.history.length - 1].from, reason) + ' (undo: w11-governor.undo())');
        emit('vx:governor', { action: 'degrade', kind: 'substeps', state: getState() });
        return 'degraded';
      }
      if (s.scaleIdx > 0) {
        applyChange('scale', { scaleIdx: s.scaleIdx - 1 }, reason);
        announce('still over budget — ' + describeChange('scale', s.history[s.history.length - 1].from, reason) + ' (undo: w11-governor.undo())');
        emit('vx:governor', { action: 'degrade', kind: 'scale', state: getState() });
        return 'degraded';
      }
      if (s.tier > 0) {
        var fromTier = s.tier;
        applyChange('tier', { tier: s.tier - 1 }, reason);
        s.tierChangeTimes.push(t);
        s.lastDropAt = t;
        s.overWindows = 0; s.underCount = 0;
        persistTier();
        announce(describeChange('tier', { tier: fromTier, substeps: 0, scaleIdx: 0 }, reason) + ' (undo: w11-governor.undo())');
        emit('vx:degraded', { from: fromTier, to: s.tier, reason: reason });
        emit('vx:governor', { action: 'tier-drop', from: fromTier, to: s.tier, state: getState() });
        return 'tier-drop';
      }
      // Tier 0 is the floor — never "off".
      if (!s.atFloor) {
        s.atFloor = true;
        announce('already at Tier 0 floor (' + TIERS[0].tracers + ' tracers) — cannot degrade further. Close tabs or reduce workload.');
        emit('vx:governor', { action: 'floor', state: getState() });
      }
      return 'floor';
    }

    function tryPromote() {
      var t = now();
      if (s.locked || s.batteryPin || s.thermalFlag) return false;
      if (s.mode === 'background') return false; // throughput-max: hold, don't chase
      if (s.tier >= maxTier()) return false;
      if (s.overWindows > 0) return false;
      if (tierChangesIn5Min(t) >= MAX_TIER_CHANGES_PER_5MIN) return false;
      if (t - s.lastDropAt < COOLDOWN_AFTER_DROP_MS) return false; // 60s cooldown after a drop
      if (s.underCount < UNDER_BUDGET_FRAMES) return false;       // 120 frames under 0.6x budget
      var fromTier = s.tier;
      applyChange('promote', { tier: s.tier + 1 }, '120 frames under 60% of budget — headroom confirmed');
      s.tierChangeTimes.push(t);
      s.underCount = 0;
      persistTier();
      announce(describeChange('promote', { tier: fromTier, substeps: 0, scaleIdx: 0 }, '120 frames under 60% of budget') + ' (undo: w11-governor.undo())');
      emit('vx:governor', { action: 'tier-promote', from: fromTier, to: s.tier, state: getState() });
      return true;
    }

    /* ----- frame ingestion ----- */
    function ingestFrame(ms) {
      if (s.paused) return;
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
      if (s.skipFirst) { s.skipFirst = false; return; } // discard first frame after resume
      var t = now();
      s.frames.push(ms);
      if (s.frames.length > WINDOW) s.frames.shift();
      s.totalFrames++;
      var b = budget();
      if (ms < PROMOTE_FRac * b) s.underCount++;
      else s.underCount = 0;
      if (s.bench) s.bench.frames.push(ms);
    }

    /* ----- thermal ----- */
    function thermalUpdate(t) {
      // Baseline: median p50 of session minutes 1-2 at a stable tier (perf plan §5).
      var elapsed = t - s.startedAt;
      if (!s.warmupDone) {
        if (elapsed >= 60000 && elapsed <= 120000 && s.p50 !== null) {
          s.baselineCandidates.push(s.p50);
        }
        if (elapsed >= 120000 || s.baselineCandidates.length >= 30) {
          if (s.baselineCandidates.length >= 5) s.thermalBaseline = median(s.baselineCandidates);
          s.warmupDone = true;
        }
      }
      if (s.p50 === null) return;
      s.emaP50 = (s.emaP50 === null) ? s.p50 : s.emaP50 + EMA_ALPHA * (s.p50 - s.emaP50);
      if (s.mode === 'background') return;
      if (s.thermalBaseline && !s.thermalFlag && s.emaP50 > s.thermalBaseline * THERMAL_DRIFT) {
        // constant tier + constant workload required: tier stable for 60s+
        if (t - s.tierStableSince > 60000) {
          s.thermalFlag = true;
          s.thermalFlagAt = t;
          var driftPct = Math.round((s.emaP50 / s.thermalBaseline - 1) * 100);
          var fromTier = s.tier, stepped = false;
          if (s.tier > 0 && !(s.locked || s.batteryPin) && tierChangesIn5Min(t) < MAX_TIER_CHANGES_PER_5MIN) {
            applyChange('thermal', { tier: s.tier - 1 }, 'thermal drift +' + driftPct + '% vs baseline');
            s.tierChangeTimes.push(t);
            s.lastDropAt = t;
            stepped = true;
            persistTier();
            emit('vx:degraded', { from: fromTier, to: s.tier, reason: 'thermal' });
          }
          announce('thermal-limited — p50 drifted +' + driftPct + '% above baseline; ' +
            (stepped ? 'stepped down one tier. ' : 'holding tier. ') +
            'No auto-promote until cooldown clears. (undo: w11-governor.undo())');
          emit('vx:governor', { action: 'thermal', thermalFlag: true, driftPct: driftPct, state: getState() });
          renderChips();
        }
      }
      if (s.thermalFlag && s.emaP50 < s.thermalBaseline * THERMAL_RESOLVE &&
          t - s.thermalFlagAt > THERMAL_CLEAR_MS) {
        s.thermalFlag = false;
        announce('thermal drift resolved — adaptation resumed.');
        emit('vx:governor', { action: 'thermal-clear', state: getState() });
        renderChips();
      }
    }

    /* ----- evaluation tick (every 2s) ----- */
    function tick() {
      var t = now();
      if (s.paused) return;
      if (s.burstUntil && t > s.burstUntil) {
        s.burstUntil = 0;
        applyToBackend('burst ended');
        announce('60fps burst ended — back to 30fps sustained.');
        renderChips();
      }
      if (s.frames.length < 10) return;
      var sorted = sortedCopy(s.frames);
      s.p50 = percentile(sorted, 0.5);
      s.p95 = percentile(sorted, 0.95);
      s.meanMs = mean(s.frames);
      s.fps = s.meanMs > 0 ? 1000 / s.meanMs : 0;

      thermalUpdate(t);

      if (s.mode === 'background') return; // passive in background: record only
      var b = budget();
      var over = 0, i;
      for (i = 0; i < s.frames.length; i++) if (s.frames[i] > b) over++;

      if (over >= OVER_BUDGET_FRAMES && s.frames.length >= MIN_WINDOW_FOR_DROP) {
        // One bad window (>=5 frames over budget) = one step down the ladder:
        // substeps 2->1, render scale down one notch, then the tier drop.
        s.overWindows = 1;
        stepDown('p95 ' + r2(s.p95) + 'ms over ' + b + 'ms budget (' + over + '/' + s.frames.length + ' frames over)');
      } else {
        s.overWindows = 0;
        tryPromote();
      }
    }

    /* ----- battery ----- */
    function applyBatteryState(level, charging) {
      s.batteryLevel = level;
      s.batteryCharging = charging;
      var lowUnplugged = (typeof level === 'number') && level < 0.20 && !charging;
      if (lowUnplugged && !s.batteryPin) {
        s.batteryPin = true;
        var fromTier = s.tier;
        s.locked = true; s.lockReason = 'battery';
        if (s.tier !== 0) {
          applyChange('battery', { tier: 0 }, 'battery <20% and unplugged — pinned to Tier 0');
          s.tierChangeTimes.push(now());
          persistTier();
          emit('vx:degraded', { from: fromTier, to: 0, reason: 'battery' });
        }
        announce('battery below 20% and unplugged — pinned to Tier 0 (Pocket). Plug in to release.');
        emit('vx:governor', { action: 'battery-pin', state: getState() });
        renderChips();
      } else if (!lowUnplugged && s.batteryPin) {
        s.batteryPin = false;
        if (s.lockReason === 'battery') { s.locked = false; s.lockReason = null; }
        announce('battery OK — governor released from Tier 0 pin. Holding tier until headroom is confirmed.');
        emit('vx:governor', { action: 'battery-release', state: getState() });
        renderChips();
      }
    }

    function initBattery() {
      try {
        var nav = root.navigator;
        if (!nav || typeof nav.getBattery !== 'function') return;
        nav.getBattery().then(function (batt) {
          if (!batt) return;
          var upd = function () {
            try { applyBatteryState(batt.level, batt.charging); } catch (e) { /* ignore */ }
          };
          upd();
          if (typeof batt.addEventListener === 'function') {
            batt.addEventListener('levelchange', upd);
            batt.addEventListener('chargingchange', upd);
          }
        }, function () { /* battery API denied/unavailable: ignore */ });
      } catch (e) { /* guarded */ }
    }

    /* ----- benchmark: "Measure 10 seconds" ----- */
    function analyzeBenchmark(frames, tier) {
      var ms = frames.map(function (f) { return (typeof f === 'number') ? f : f.ms; });
      var sorted = sortedCopy(ms);
      var m = mean(ms);
      return {
        p50: r2(percentile(sorted, 0.5)),
        p95: r2(percentile(sorted, 0.95)),
        meanMs: r2(m),
        fps: m > 0 ? Math.round((1000 / m) * 10) / 10 : 0,
        frames: ms.length,
        tier: tier
      };
    }

    function recordBenchmark(analysis) {
      var prev = s.benchHistory.length ? s.benchHistory[s.benchHistory.length - 1] : null;
      var flag = 'baseline';
      if (prev && prev.p95 > 0) {
        var ratio = analysis.p95 / prev.p95;
        flag = ratio > 1.15 ? 'regression' : (ratio < 0.85 ? 'improved' : 'stable');
      }
      var rec = {
        ts: now(), p50: analysis.p50, p95: analysis.p95, meanMs: analysis.meanMs,
        fps: analysis.fps, frames: analysis.frames, tier: analysis.tier,
        tierName: TIERS[analysis.tier].name, mode: s.mode,
        regression: flag === 'regression', flag: flag,
        codeVersion: V.codeVersion
      };
      s.benchHistory.push(rec);
      if (s.benchHistory.length > BENCH_HISTORY_CAP) s.benchHistory.shift();
      persistBenchHistory();
      announce('10s benchmark — p50 ' + rec.p50 + 'ms, p95 ' + rec.p95 + 'ms, ~' + rec.fps +
        'fps @ ' + tierName(rec.tier) + ' (' + flag + ' vs previous).');
      emit('vx:governor', { action: 'benchmark', record: rec });
      return rec;
    }

    function startBenchmark(opts2) {
      opts2 = opts2 || {};
      if (s.bench && s.bench.promise) return s.bench.promise; // one at a time
      if (opts2.synthetic && Array.isArray(opts2.synthetic)) {
        // Deterministic path for tests/headless: analyze immediately.
        var rec = recordBenchmark(analyzeBenchmark(opts2.synthetic, s.tier));
        return Promise.resolve(rec);
      }
      var resolveFn, rejectFn;
      var promise = new Promise(function (res, rej) { resolveFn = res; rejectFn = rej; });
      var bench = { frames: [], t0: now(), promise: promise };
      s.bench = bench;
      announce('benchmark started — measuring ' + BENCH_SECONDS + 's @ ' + tierName(s.tier) + '…');
      var finish = function () {
        if (s.bench !== bench) return;
        s.bench = null;
        if (bench.frames.length < 5) {
          announce('benchmark aborted — too few frames collected.');
          rejectFn(new Error('insufficient frames'));
          return;
        }
        resolveFn(recordBenchmark(analyzeBenchmark(bench.frames, s.tier)));
      };
      try {
        bench.timer = root.setTimeout(finish, BENCH_SECONDS * 1000);
      } catch (e) {
        s.bench = null;
        rejectFn(e);
      }
      return promise;
    }

    /* ----- undo ----- */
    function undo() {
      var h = s.history.pop();
      if (!h) {
        announce('nothing to undo — no governor changes yet.');
        return null;
      }
      s.tier = h.from.tier; s.substeps = h.from.substeps; s.scaleIdx = h.from.scaleIdx;
      if (h.kind === 'burst') s.burstUntil = 0;
      s.tierStableSince = now();
      s.atFloor = false;
      s.underCount = 0; s.overWindows = 0;
      applyToBackend('undo');
      renderChips();
      announce('undone — back to ' + tierName(s.tier) + ', substeps ' + s.substeps +
        ', render scale ' + SCALE_NOTCHES[s.scaleIdx].toFixed(2) + '.');
      emit('vx:governor', { action: 'undo', reverted: h, state: getState() });
      return h;
    }

    /* ----- state snapshot ----- */
    function getState() {
      var cfg = effectiveConfig();
      return {
        tier: s.tier, tierName: cfg.name, mode: s.mode, budgetMs: budget(),
        tracers: cfg.tracers, grid: cfg.grid, fpsTarget: cfg.fps,
        renderScale: cfg.renderScale, substeps: s.substeps,
        locked: s.locked || s.batteryPin, lockReason: s.lockReason,
        thermalFlag: s.thermalFlag, thermalBaselineMs: s.thermalBaseline === null ? null : r2(s.thermalBaseline),
        emaP50Ms: s.emaP50 === null ? null : r2(s.emaP50),
        batteryPin: s.batteryPin, batteryLevel: s.batteryLevel, batteryCharging: s.batteryCharging,
        p50Ms: s.p50 === null ? null : r2(s.p50), p95Ms: s.p95 === null ? null : r2(s.p95),
        fps: s.fps === null ? null : Math.round(s.fps * 10) / 10,
        windowFrames: s.frames.length, totalFrames: s.totalFrames,
        tierChangesLast5Min: tierChangesIn5Min(now()),
        secondsSinceDrop: s.lastDropAt ? Math.round((now() - s.lastDropAt) / 1000) : null,
        undoDepth: s.history.length, atFloor: s.atFloor,
        burstActive: s.burstUntil > now(),
        backendAttached: !!(s.backend || discoverBackend()),
        lastBackendAction: s.lastBackendAction,
        benchmarks: s.benchHistory.length,
        codeVersion: V.codeVersion
      };
    }

    /* ----- public API ----- */
    var api = {
      ingestFrame: ingestFrame,
      tick: tick,
      start: function () {
        if (s.intervalId || !V.utils.isBrowser()) return;
        try { s.intervalId = root.setInterval(tick, EVAL_MS); } catch (e) { /* ignore */ }
      },
      stop: function () {
        if (s.intervalId) { try { root.clearInterval(s.intervalId); } catch (e) {} s.intervalId = null; }
      },
      pause: function (reason) {
        s.paused = true;
        api.stop();
        s.frames = []; s.overWindows = 0; // hidden gap must not poison p95
        emit('vx:governor', { action: 'pause', reason: reason || '' });
      },
      resume: function () {
        s.paused = false;
        s.frames = [];
        s.skipFirst = true; // discard first frame's dt (no giant catch-up)
        s.underCount = 0;
        api.start();
        emit('vx:governor', { action: 'resume' });
      },
      setMode: function (m) {
        if (!BUDGETS.hasOwnProperty(m)) throw new Error('w11-governor: unknown mode ' + m);
        s.mode = m;
        s.underCount = 0; s.overWindows = 0;
        announce('mode → ' + m + ' (budget ' + (budget() === Infinity ? 'throughput-max' : budget() + 'ms') + ').');
        renderChips();
      },
      requestTier: function (n, reason) {
        n = Math.max(0, Math.min(2, n | 0));
        if (n === s.tier && !s.locked) { announce('already at ' + tierName(n) + '.'); return getState(); }
        var from = snap();
        applyChange('manual', { tier: n }, reason || 'manual request');
        s.tierChangeTimes.push(now());
        s.underCount = 0; s.overWindows = 0;
        persistTier();
        announce(describeChange('manual', from, reason || 'manual request') + ' (undo: w11-governor.undo())');
        emit('vx:governor', { action: 'manual-tier', from: from.tier, to: n, state: getState() });
        return getState();
      },
      lock: function (reason) {
        s.locked = true; s.lockReason = reason || 'manual lock';
        announce('governor locked at ' + tierName(s.tier) + ' — no automatic changes until unlock().');
        renderChips();
      },
      unlock: function () {
        s.locked = false; s.lockReason = null;
        announce('governor unlocked — adaptation resumed at ' + tierName(s.tier) + '.');
        renderChips();
      },
      undo: undo,
      startBenchmark: startBenchmark,
      benchmarkHistory: function () { return s.benchHistory.slice(); },
      clearBenchmarkHistory: function () {
        s.benchHistory = []; persistBenchHistory();
        announce('benchmark history cleared.');
      },
      startBurst: function () {
        if (s.tier !== 2) { announce('60fps burst is Tier 2 only — currently ' + tierName(s.tier) + '.'); return false; }
        if (s.locked || s.batteryPin) { announce('burst denied — governor locked.'); return false; }
        s.burstUntil = now() + 30000;
        applyChange('burst', {}, '60fps burst started (30s)');
        announce('60fps burst — labeled, time-boxed 30s @ Tier 2 Pro. (undo: w11-governor.undo())');
        return true;
      },
      attach: function (backend) { s.backend = backend || null; return !!s.backend; },
      config: effectiveConfig,
      getState: getState,
      setStorage: function (shim) { storage = shim || null; },
      // Internal seams (underscore): used by the module wiring below and by tests.
      _batteryInit: initBattery,
      _paintChips: renderChips,
      _benchmarkSync: function (frames) { return recordBenchmark(analyzeBenchmark(frames, s.tier)); },
      selfTest: selfTest
    };

    /* ----- selfTest (headless-safe) ----- */
    function check(name, ok, detail) { return { name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) }; }

    function selfTest() {
      var checks = [];
      var announces = [];
      var events = [];
      var t = 1000000000000; // fixed fake clock
      var fakeNow = function () { return t; };
      function mkGov(o) {
        o = o || {};
        o.now = fakeNow;
        o.onAnnounce = function (m) { announces.push(m); };
        o.busSpy = function (n, d) { events.push({ name: n, detail: d }); };
        return createGovernor(o);
      }
      function feed(g, ms, n) {
        for (var i = 0; i < n; i++) g.ingestFrame(ms);
      }
      function adv(ms) { t += ms; }

      try {
        // 1. down-step ladder: stable -> spike at Tier 2 (substeps 2, scale 1.0)
        var g = mkGov({ startTier: 2 });
        feed(g, 12, 120); adv(2000); g.tick();
        checks.push(check('stable frames hold tier', g.getState().tier === 2 && g.getState().substeps === 2,
          'tier=' + g.getState().tier + ' substeps=' + g.getState().substeps));

        var sawSubstep = false, sawScale = false, dropped = false;
        for (var w = 0; w < 10 && !dropped; w++) {
          feed(g, 50, 120); adv(2000); g.tick(); // 50ms >> 33.3ms budget
          var st = g.getState();
          if (st.substeps === 1) sawSubstep = true;
          if (st.renderScale < 1.0) sawScale = true;
          if (st.tier === 1) dropped = true;
        }
        checks.push(check('over-budget degrades substeps first', sawSubstep, 'substeps reached 1'));
        checks.push(check('then render scale one notch at a time', sawScale, 'scale=' + g.getState().renderScale));
        checks.push(check('then tier drop after sustained pressure', dropped, 'tier=' + g.getState().tier));

        var degradedEvts = events.filter(function (e) { return e.name === 'vx:degraded'; });
        checks.push(check('tier drop emits vx:degraded', degradedEvts.length >= 1,
          degradedEvts.length + ' vx:degraded events'));
        checks.push(check('every change announced', announces.length >= 3, announces.length + ' announcements'));

        // 2. up-step: 60s cooldown after drop, then 120 frames under 0.6x budget
        var tierAfterDrop = g.getState().tier;
        feed(g, 10, 120); adv(10000); g.tick(); // only 10s since drop
        checks.push(check('no promote within 60s of drop', g.getState().tier === tierAfterDrop,
          'tier=' + g.getState().tier + ' (cooldown)'));
        adv(55000); // now 65s since drop
        feed(g, 10, 120); adv(2000); g.tick();
        checks.push(check('promote after 120 frames under 0.6x budget + cooldown',
          g.getState().tier === tierAfterDrop + 1, 'tier=' + g.getState().tier));

        // 3. rate limit: 2 tier changes per 5 min (drop + promote used both)
        var stBefore = g.getState().tier;
        for (var w2 = 0; w2 < 8 && g.getState().tier === stBefore; w2++) {
          feed(g, 60, 120); adv(2000); g.tick();
        }
        var rateNote = announces.some(function (m) { return /rate limit/.test(m); });
        checks.push(check('max 2 tier changes per 5 min', g.getState().tier === stBefore && rateNote,
          'tier held at ' + g.getState().tier + ', rate-limit announced=' + rateNote));

        // 4. undo walks one step back
        var g2 = mkGov({ startTier: 1 });
        g2.requestTier(2, 'test');
        var undone = g2.undo();
        checks.push(check('undo restores one step back',
          undone !== null && g2.getState().tier === 1, 'tier=' + g2.getState().tier));

        // 5. benchmark on synthetic data + regression flag (synchronous core)
        var g3 = mkGov({ startTier: 1 });
        var syn = []; for (var i = 0; i < 120; i++) syn.push(12);
        var worse = []; for (var j = 0; j < 120; j++) worse.push(22);
        var rec1 = g3._benchmarkSync(syn);
        var rec2 = g3._benchmarkSync(worse);
        checks.push(check('benchmark records history',
          rec1 && rec2 && g3.benchmarkHistory().length === 2 &&
          typeof rec1.p50 === 'number' && typeof rec1.p95 === 'number' &&
          typeof rec1.fps === 'number' && rec1.tier === 1,
          'runs=' + g3.benchmarkHistory().length + ' p95=' + (rec1 && rec1.p95)));
        checks.push(check('regression flagged vs previous',
          rec2 && rec2.flag === 'regression' && rec2.regression === true,
          'flag=' + (rec2 && rec2.flag)));

        // 6. tier persistence round-trips via storage shim.
        // Inject a low-end mobile navigator so auto-detect yields Tier 0 and the
        // persisted tier (2) is distinguishable from detection.
        var stubNav = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile',
          deviceMemory: 2, hardwareConcurrency: 4 };
        var mem = {};
        var shim = {
          getItem: function (k) { return (k in mem) ? mem[k] : null; },
          setItem: function (k, v) { mem[k] = String(v); },
          removeItem: function (k) { delete mem[k]; }
        };
        var g4 = mkGov({ storage: shim, navigator: stubNav }); // detects Tier 0
        g4.requestTier(2, 'persist test');
        var g5 = mkGov({ storage: shim, navigator: stubNav }); // should restore persisted Tier 2
        checks.push(check('tier persistence round-trips', g5.getState().tier === 2,
          'restored tier=' + g5.getState().tier));
        // expired entry ignored -> falls back to detection (Tier 0)
        var old = JSON.parse(mem[STORE_TIER_KEY]); old.ts = t - (31 * 24 * 3600 * 1000); mem[STORE_TIER_KEY] = JSON.stringify(old);
        var g6 = mkGov({ storage: shim, navigator: stubNav });
        checks.push(check('expired (30d+) tier ignored', g6.getState().tier === 0,
          'tier=' + g6.getState().tier));

        // 7. thermal: baseline minutes 1-2 at stable tier, then >25% p50 drift
        var g7 = mkGov({ startTier: 2 });
        for (var e1 = 0; e1 < 65; e1++) { feed(g7, 12, 60); adv(2000); g7.tick(); } // 130s: baseline ~12ms
        var base = g7.getState().thermalBaselineMs;
        for (var e2 = 0; e2 < 40; e2++) { feed(g7, 20, 60); adv(2000); g7.tick(); } // drift to 20ms
        var gs7 = g7.getState();
        checks.push(check('thermal drift sets thermalFlag + steps down',
          gs7.thermalFlag === true && gs7.tier === 1,
          'baseline=' + base + ' flag=' + gs7.thermalFlag + ' tier=' + gs7.tier));
        var thermNote = announces.some(function (m) { return /thermal-limited/.test(m); });
        checks.push(check('thermal announced as thermal-limited', thermNote, 'announced=' + thermNote));

        // 8. battery pin via seam
        var g8 = mkGov({ startTier: 2, battery: { level: 0.15, charging: false } });
        checks.push(check('battery <20% unplugged pins Tier 0', g8.getState().batteryPin === true &&
          g8.getState().tier === 0 && g8.getState().locked === true,
          'tier=' + g8.getState().tier + ' locked=' + g8.getState().locked));
        var g9 = mkGov({ startTier: 2, battery: { level: 0.15, charging: true } });
        checks.push(check('charging battery does not pin', g9.getState().batteryPin === false &&
          g9.getState().tier === 2, 'tier=' + g9.getState().tier));

        // 9. headless without backend: no throw, intended action recorded
        var g10 = mkGov({ startTier: 1 });
        var threw = false;
        try {
          feed(g10, 50, 120); adv(2000); g10.tick();
          var la = g10.getState().lastBackendAction;
          if (!la || typeof la.tier !== 'number') threw = 'no action recorded';
        } catch (e) { threw = e.message; }
        checks.push(check('headless-safe without backend', threw === false, String(threw)));

        // 10. background mode is passive
        var g11 = mkGov({ startTier: 2 });
        g11.setMode('background');
        for (var w3 = 0; w3 < 6; w3++) { feed(g11, 200, 120); adv(2000); g11.tick(); }
        checks.push(check('background mode never degrades (throughput-max)',
          g11.getState().tier === 2 && g11.getState().p95Ms > 0, 'tier=' + g11.getState().tier));
      } catch (e) {
        checks.push(check('selfTest harness', false, 'threw: ' + (e && e.stack || e)));
      }

      var ok = checks.every(function (c) { return c.ok; });
      return { ok: ok, checks: checks };
    }

    return api;
  }

  /* ---------------- singleton + wiring ---------------- */

  var gov = createGovernor({});

  V.register('w11-governor', gov);

  // Wire to boot, frame bus, visibility, and battery. Everything guarded: the
  // governor must never break boot, and must never throw headless.
  try {
    V.bus.on('vx:ready', function (d) {
      if (d && d.backend) gov.attach(d.backend);
      gov.start();
    });
    V.bus.on('vx:frame', function (d) {
      if (d && typeof d.dt === 'number') gov.ingestFrame(d.dt);
    });
    if (V.utils.isBrowser()) {
      try {
        root.document.addEventListener('visibilitychange', function () {
          if (root.document.hidden) gov.pause('tab hidden');
          else gov.resume();
        });
        root.addEventListener('pagehide', function () { gov.pause('pagehide'); });
      } catch (e) { /* ignore */ }
      gov.start();
      gov._paintChips(); // initial GOV:ACTIVE / GOV:LOCKED chip
    }
    gov._batteryInit(); // guarded internally; no-op where getBattery is absent
  } catch (e) { /* governor wiring must never break boot */ }

})(typeof window !== 'undefined' ? window : globalThis);
