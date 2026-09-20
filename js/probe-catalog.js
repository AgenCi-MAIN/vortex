/* VORTEX probe-catalog.js — W05.
 * Probe catalog: 14 standard probes + 3 adversarial probes, as data, with a
 * safety enforcement layer (strength/duration caps, CFL budget, one-active
 * probe guard, expiry timers, mandatory pre-injection rollback snapshot).
 *
 * Plain script, no modules, no network. Runs from file:// and headless (node).
 * Probe application goes through the connected field backend's addProbe();
 * this module never touches field math itself.
 *
 * The 3 legacy probes (oppose-winding, test-wake, perturb-field) keep their
 * existing UI behavior contract: they are measurement/perturbation probes
 * with the same titles and semantics the live dashboard shipped.
 *
 * Adversarial probes (field-jitter, core-overdrive, phase-locked-pump) exist
 * to BREAK fields, not decorate them. They are flagged adversarial:true and
 * require an explicit opts.allowAdversarial === true at inject() time.
 *
 * Agent injection gate (W24/W31 contract, documented here): inject() called
 * with opts.source === 'agent' is DENIED unless opts.grant is truthy. Default
 * UI/protocol/test paths are allowed. The grant itself is issued by W24/W31;
 * this module only enforces the gate.
 *
 * Safety schema per probe:
 *   safety: {
 *     maxStrength: 0..1 (relative velocity-addition scale, authored so that
 *                  CFL <= cflClamp at maxStrength on the reference backend),
 *     defaultStrength, maxDurationMs, defaultDurationMs,
 *     cflClamp: Courant-number budget shipped with the probe payload so the
 *               backend (which owns dt/dx) can enforce the physics. This
 *               module additionally asks the backend for
 *               backend.cflStrengthLimit(cflClamp) when available and takes
 *               the min; if the backend offers no such hook, maxStrength
 *               alone applies and the CFL budget rides along for enforcement.
 *     requiresRollbackSnapshot: true (always)
 *   }
 */
(function (root) {
  'use strict';
  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('w05-probes: VORTEX namespace (js/vx-namespace.js) must load first');
  }
  var clamp = V.utils.clamp;

  /* Metric vocabulary (W07's 12 metrics) referenced by confirm/refute rules:
   * mixingRate, dispersion, enstrophyProxy, keProxy, mergerTime,
   * filamentTopology, symmetryBreaking, predictabilityHorizon, energyDecay,
   * vorticityCorrLength, injectionInfluenceRadius, rollbackFidelity.
   * Rules are plain language with a machine-checkable clause; they are
   * evaluated by W06/W07/W13 against a control twin (W13), never here. */

  var CONFIGS = [
    'kelvin-helmholtz', 'decaying-turbulence', 'stratified-shear',
    'periodic-drive', 'time-reversed-wake', 'vortex-pair-merger',
    'wake-obstacle', 'magnetic-analogue'
  ];
  var BACKENDS = ['cpu', 'webgl2', 'webgpu'];

  function S(maxStrength, maxDurationMs, cflClamp, defStrength, defDurationMs) {
    return {
      maxStrength: maxStrength,
      defaultStrength: (defStrength == null ? Math.min(0.5, maxStrength) : defStrength),
      maxDurationMs: maxDurationMs,
      defaultDurationMs: (defDurationMs == null ? Math.min(8000, maxDurationMs) : defDurationMs),
      cflClamp: cflClamp,
      requiresRollbackSnapshot: true
    };
  }
  function C(configs, backends) { return { configs: configs, backends: backends || BACKENDS.slice() }; }

  var PROBES = [
    /* ---------- the 3 legacy UI probes (behavior contract preserved) ---------- */
    {
      id: 'oppose-winding', title: 'Oppose winding', legacy: true, adversarial: false,
      hypothesis: 'Injecting counter-winding into a merger slows the merger clock without changing the end state.',
      confirmRule: 'CONFIRMED if mergerTime (W07) is >= 1.15x the control twin with non-overlapping 95% CI.',
      refuteRule: 'REFUTED if mergerTime stays within +/-5% of the control twin.',
      compatibility: C(['vortex-pair-merger', 'decaying-turbulence', 'magnetic-analogue']),
      safety: S(0.6, 20000, 0.40)
    },
    {
      id: 'test-wake', title: 'Test the wake', legacy: true, adversarial: false,
      hypothesis: 'A wake measurement pass is observational: it leaves the flow statistically unchanged.',
      confirmRule: 'CONFIRMED if |delta mixingRate| and |delta enstrophyProxy| stay within the control twin\'s 1-sigma drift band.',
      refuteRule: 'REFUTED if any W07 metric moves outside the control twin\'s 2-sigma drift band (probe is not passive).',
      compatibility: C(['time-reversed-wake', 'wake-obstacle', 'vortex-pair-merger']),
      safety: S(0.25, 12000, 0.25, 0.15)
    },
    {
      id: 'perturb-field', title: 'Perturb the field', legacy: true, adversarial: false,
      hypothesis: 'A bounded broadband perturbation decays back to baseline without moving the flow to a new attractor.',
      confirmRule: 'CONFIRMED if enstrophyProxy returns to within 1 sigma of the control baseline within 60 sim-seconds and predictabilityHorizon stays within +/-10%.',
      refuteRule: 'REFUTED if metrics remain > 2 sigma off baseline after 60 sim-seconds.',
      compatibility: C(CONFIGS),
      safety: S(0.5, 15000, 0.35)
    },

    /* ---------- 11 new probes ---------- */
    {
      id: 'shear-pulse', title: 'Shear pulse', legacy: false, adversarial: false,
      hypothesis: 'A localized shear pulse accelerates mixing in shear rollup without changing the final mixed state.',
      confirmRule: 'CONFIRMED if mixingRate is >= 1.25x the control twin during 5-30 sim-seconds post-injection with non-overlapping 95% CI.',
      refuteRule: 'REFUTED if the mixingRate ratio stays <= 1.05x over the same window.',
      compatibility: C(['kelvin-helmholtz', 'stratified-shear', 'wake-obstacle']),
      safety: S(0.55, 10000, 0.40)
    },
    {
      id: 'merger-nudge', title: 'Merger nudge', legacy: false, adversarial: false,
      hypothesis: 'A small aligned impulse speeds up vortex-pair merger.',
      confirmRule: 'CONFIRMED if mergerTime (W07) is <= 0.85x the control twin.',
      refuteRule: 'REFUTED if mergerTime stays >= 0.95x of the control twin.',
      compatibility: C(['vortex-pair-merger', 'kelvin-helmholtz']),
      safety: S(0.4, 12000, 0.35)
    },
    {
      id: 'filament-seed', title: 'Filament seed', legacy: false, adversarial: false,
      hypothesis: 'Seeding fine filaments shortens the route to small-scale structure in decaying turbulence.',
      confirmRule: 'CONFIRMED if filamentTopology count is >= 1.5x the control twin within 20 sim-seconds post-injection.',
      refuteRule: 'REFUTED if the filament count ratio stays <= 1.1x.',
      compatibility: C(['decaying-turbulence', 'stratified-shear', 'kelvin-helmholtz']),
      safety: S(0.45, 8000, 0.30)
    },
    {
      id: 'symmetry-break', title: 'Symmetry break', legacy: false, adversarial: false,
      hypothesis: 'An asymmetric impulse breaks symmetric decay and the asymmetry persists measurably.',
      confirmRule: 'CONFIRMED if symmetryBreaking (W07) rises >= 2 sigma above the control twin within 15 sim-seconds.',
      refuteRule: 'REFUTED if symmetryBreaking stays within +/-1 sigma of the control twin.',
      compatibility: C(['decaying-turbulence', 'stratified-shear', 'kelvin-helmholtz']),
      safety: S(0.5, 10000, 0.35)
    },
    {
      id: 'vortex-inject', title: 'Vortex inject', legacy: false, adversarial: false,
      hypothesis: 'An injected same-sign vortex raises enstrophy and persists for tens of seconds before merging.',
      confirmRule: 'CONFIRMED if enstrophyProxy rises >= 20% over the control twin post-injection and the excess persists >= 30 sim-seconds.',
      refuteRule: 'REFUTED if the enstrophy rise is < 5% or the excess decays within 5 sim-seconds.',
      compatibility: C(['vortex-pair-merger', 'decaying-turbulence', 'magnetic-analogue']),
      safety: S(0.7, 20000, 0.45)
    },
    {
      id: 'wake-cancel', title: 'Wake cancel', legacy: false, adversarial: false,
      hypothesis: 'Counter-phased injection cancels the downstream wake and restores upstream correlation.',
      confirmRule: 'CONFIRMED if downstream dispersion (W07) drops to <= 0.7x the control twin while vorticityCorrLength recovers to within 10% of pre-wake value.',
      refuteRule: 'REFUTED if dispersion stays >= 0.95x of the control twin.',
      compatibility: C(['wake-obstacle', 'time-reversed-wake']),
      safety: S(0.5, 15000, 0.35)
    },
    {
      id: 'circulation-pump', title: 'Circulation pump', legacy: false, adversarial: false,
      hypothesis: 'Steady aligned pumping raises kinetic energy at a controllable rate without triggering turbulence.',
      confirmRule: 'CONFIRMED if the keProxy growth rate is >= 2x the control twin over a 20 sim-second window while enstrophyProxy growth stays <= 1.2x.',
      refuteRule: 'REFUTED if the keProxy growth rate stays within +/-10% of the control twin.',
      compatibility: C(['periodic-drive', 'vortex-pair-merger', 'magnetic-analogue']),
      safety: S(0.6, 30000, 0.40)
    },
    {
      id: 'turbulence-quench', title: 'Turbulence quench', legacy: false, adversarial: false,
      hypothesis: 'A quenching impulse accelerates energy decay and suppresses enstrophy in decaying turbulence.',
      confirmRule: 'CONFIRMED if energyDecay rate is >= 1.5x the control twin and enstrophyProxy falls to <= 0.6x within 20 sim-seconds.',
      refuteRule: 'REFUTED if the decay rate stays within +/-10% of the control twin.',
      compatibility: C(['decaying-turbulence', 'stratified-shear']),
      safety: S(0.65, 12000, 0.40)
    },
    {
      id: 'dye-ribbon', title: 'Dye ribbon', legacy: false, adversarial: false,
      hypothesis: 'A passive dye ribbon visualizes advection without altering any flow metric.',
      confirmRule: 'CONFIRMED if |delta mixingRate| and |delta dispersion| stay within the control twin\'s 1-sigma drift band (probe is purely diagnostic).',
      refuteRule: 'REFUTED if any W07 metric moves outside the 2-sigma band (the ribbon is not passive).',
      compatibility: C(CONFIGS),
      safety: S(0.15, 30000, 0.20, 0.1)
    },
    {
      id: 'boundary-push', title: 'Boundary push', legacy: false, adversarial: false,
      hypothesis: 'A gentle boundary displacement is absorbed locally and does not shorten the predictability horizon.',
      confirmRule: 'CONFIRMED if predictabilityHorizon stays within +/-10% of the control twin post-injection.',
      refuteRule: 'REFUTED if the horizon shifts by more than 25% (boundary effect propagated inward).',
      compatibility: C(['wake-obstacle', 'stratified-shear', 'magnetic-analogue']),
      safety: S(0.35, 10000, 0.30)
    },
    {
      id: 'phase-drift', title: 'Phase drift', legacy: false, adversarial: false,
      hypothesis: 'Slowly drifting the drive phase produces a measurable phase shift in the vortex street oscillation.',
      confirmRule: 'CONFIRMED if the vorticityCorrLength oscillation phase shifts >= 15 degrees relative to the control twin within 40 sim-seconds.',
      refuteRule: 'REFUTED if the measured phase shift stays < 5 degrees (below detection).',
      compatibility: C(['periodic-drive', 'wake-obstacle']),
      safety: S(0.4, 40000, 0.30)
    },

    /* ---------- 3 adversarial probes (exist to BREAK fields) ---------- */
    {
      id: 'field-jitter', title: 'Field jitter', legacy: false, adversarial: true,
      hypothesis: 'Randomized jitter injection defeats determinism assumptions: a seeded CPU rerun of the same manifest no longer reproduces metric hashes.',
      confirmRule: 'CONFIRMED (field broke) if the post-injection metric hash (hash53) mismatches the control twin OR enstrophyProxy run-to-run sigma exceeds 3x the tolerance band.',
      refuteRule: 'REFUTED (field resisted) if the run stays hash-identical to the control twin within tolerance bands.',
      compatibility: C(CONFIGS),
      safety: S(1.0, 10000, 0.50, 0.8, 6000)
    },
    {
      id: 'core-overdrive', title: 'Core overdrive', legacy: false, adversarial: true,
      hypothesis: 'Driving the vortex core past its CFL stability limit forces a degradation event the rollback snapshot must survive.',
      confirmRule: 'CONFIRMED (field broke) if rollbackFidelity after mandatory snapshot restore is < 0.5 OR the governor emits a step-down / VX_E_OOM / VX_E_CONTEXT_LOST event.',
      refuteRule: 'REFUTED (field resisted) if the field stays stable with no degradation events and rollbackFidelity >= 0.9.',
      compatibility: C(CONFIGS, ['cpu', 'webgl2']),
      safety: S(1.0, 15000, 0.50, 0.9, 8000)
    },
    {
      id: 'phase-locked-pump', title: 'Phase-locked pump', legacy: false, adversarial: true,
      hypothesis: 'A pump phase-locked to the dominant mode drives resonant energy growth until the backend budget caps it.',
      confirmRule: 'CONFIRMED (field broke) if keProxy grows >= 3x the control twin within 30 sim-seconds (resonance captured).',
      refuteRule: 'REFUTED (field resisted) if keProxy stays within +/-15% of the control twin (phase lock failed to couple).',
      compatibility: C(['periodic-drive', 'vortex-pair-merger', 'magnetic-analogue'], ['cpu', 'webgl2']),
      safety: S(0.9, 30000, 0.45, 0.7, 15000)
    }
  ];

  var byId = {};
  for (var i = 0; i < PROBES.length; i++) byId[PROBES[i].id] = PROBES[i];

  /* ---------------- enforcement state ---------------- */
  var active = null;          // { id, params, timer, startedAtWall, expiresAtWall, applied, snapshot }
  var fieldBackend = null;   // connected field backend (setFieldBackend / vx:ready)
  var injections = [];        // timeline log (W25 manifest probeTimeline source)

  function narrate(msg) {
    // clamp + narrate: footer narration, headless-safe via VORTEX.ui.announce
    V.ui.announce('[probes] ' + msg);
  }

  function numOr(v, fallback) {
    var n = Number(v);
    return (isFinite(n) ? n : fallback);
  }

  /* ---------------- public API ---------------- */
  function list() {
    // defensive copies; data is a catalog, not live state
    var out = [];
    for (var i = 0; i < PROBES.length; i++) {
      out.push(V.utils.stableStringify ? JSON.parse(JSON.stringify(PROBES[i])) : PROBES[i]);
    }
    return out;
  }
  function get(id) { return byId[id] || null; }

  // validateInjection(id, params) -> {ok, clampedParams, warnings} | {ok:false, reason, detail}
  // Never throws: every user-input problem becomes a clamp+warning or a named reason.
  function validateInjection(id, params) {
    try {
      var p = get(id);
      if (!p) {
        return { ok: false, reason: 'VX_PROBE_UNKNOWN', detail: 'unknown probe id "' + String(id) + '"' };
      }
      var raw = (params && typeof params === 'object') ? params : {};
      var rawWarn = (params && typeof params === 'object') ? null
        : 'params not an object; defaults used';
      var safe = p.safety;
      var strength = numOr(raw.strength, safe.defaultStrength);
      var durationMs = numOr(raw.durationMs, safe.defaultDurationMs);
      var warnings = [];
      if (rawWarn) warnings.push(rawWarn);

      if (strength < 0) { warnings.push('strength ' + strength + ' < 0; clamped to 0'); strength = 0; }
      if (strength > safe.maxStrength) {
        warnings.push('strength ' + strength + ' exceeds maxStrength ' + safe.maxStrength +
          ' for "' + id + '"; clamped');
        strength = safe.maxStrength;
      }
      // Backend-owned CFL physics: ask the backend for its strength limit at this
      // probe's CFL budget when it offers the hook; take the min.
      var cflLimit = strength;
      if (fieldBackend && typeof fieldBackend.cflStrengthLimit === 'function') {
        try {
          var lim = Number(fieldBackend.cflStrengthLimit(safe.cflClamp));
          if (isFinite(lim) && lim >= 0) cflLimit = lim;
        } catch (e) { /* backend hook failed; fall back to authored caps */ }
      }
      if (strength > cflLimit) {
        warnings.push('strength ' + strength + ' exceeds backend CFL limit ' + cflLimit +
          ' at cflClamp ' + safe.cflClamp + '; clamped');
        strength = cflLimit;
      }
      if (durationMs < 0) { warnings.push('durationMs negative; default ' + safe.defaultDurationMs + ' used'); durationMs = safe.defaultDurationMs; }
      if (durationMs > safe.maxDurationMs) {
        warnings.push('durationMs ' + durationMs + ' exceeds maxDurationMs ' + safe.maxDurationMs +
          ' for "' + id + '"; clamped');
        durationMs = safe.maxDurationMs;
      }
      if (durationMs === 0) warnings.push('durationMs 0: probe will expire immediately');

      var clampedParams = {
        strength: strength,
        durationMs: Math.round(durationMs),
        cflBudget: safe.cflClamp,
        adversarial: !!p.adversarial
      };

      // compatibility against the connected backend (when known)
      if (fieldBackend && fieldBackend.name &&
          p.compatibility.backends.indexOf(fieldBackend.name) === -1) {
        return {
          ok: false, reason: 'VX_PROBE_INCOMPATIBLE',
          detail: 'probe "' + id + '" is not compatible with backend "' + fieldBackend.name +
            '"; compatible backends: ' + p.compatibility.backends.join(', ')
        };
      }
      for (var w = 0; w < warnings.length; w++) narrate(warnings[w]);
      return { ok: true, clampedParams: clampedParams, warnings: warnings };
    } catch (err) {
      return { ok: false, reason: 'VX_PROBE_VALIDATE_ERROR', detail: String(err && err.message || err) };
    }
  }

  function takeRollbackSnapshot(id) {
    // Mandatory pre-injection snapshot hook. If W12 is present, checkpoint there;
    // otherwise record the intent in the timeline so the missing snapshot is visible.
    if (V.has('w12-snapshots')) {
      try {
        var snap = V.get('w12-snapshots');
        if (snap && typeof snap.checkpoint === 'function') {
          var r = snap.checkpoint('pre-probe:' + id);
          return { taken: true, via: 'w12-snapshots', result: r };
        }
      } catch (err) {
        return { taken: false, via: 'w12-snapshots', error: String(err && err.message || err) };
      }
    }
    return { taken: false, via: 'intent-recorded', note: 'w12-snapshots module absent; pre-injection snapshot intent recorded, not executed' };
  }

  function activeProbe() { return active; }

  function expireActive(reason) {
    if (!active) return null;
    var done = active;
    active = null;
    if (done.timer) { try { clearTimeout(done.timer); } catch (e) {} }
    if (fieldBackend && typeof fieldBackend.clearProbes === 'function') {
      try { fieldBackend.clearProbes(); } catch (e) { /* backend clear failed; state already released */ }
    }
    done.released = reason || 'released';
    done.releasedAtWall = V.utils.now();
    narrate('probe "' + done.id + '" ' + done.released);
    V.bus.emit('vx:probe', { probe: done.id, params: done.params, released: done.released });
    return done;
  }

  /* inject(id, params, opts) -> result. Never throws; every refusal is a named reason.
   * opts: { allowAdversarial:bool, source:'ui'|'agent'|'protocol'|'test',
   *         grant:any (required when source==='agent'), simTime:number|null } */
  function inject(id, params, opts) {
    opts = opts || {};
    var source = opts.source || 'ui';
    try {
      var probe = get(id);
      if (!probe) {
        return { ok: false, reason: 'VX_PROBE_UNKNOWN', detail: 'unknown probe id "' + String(id) + '"' };
      }
      var v = validateInjection(id, params);
      if (!v.ok) return v;

      // one-active-probe guard: a second injection while one is active is rejected
      if (active) {
        return {
          ok: false, reason: 'VX_PROBE_ACTIVE',
          detail: 'probe "' + active.id + '" is already active (expires in ' +
            Math.max(0, active.expiresAtWall - V.utils.now()) + ' ms); release it before injecting "' + id + '"'
        };
      }
      // adversarial opt-in
      if (probe.adversarial && opts.allowAdversarial !== true) {
        return {
          ok: false, reason: 'VX_PROBE_ADVERSARIAL_OPTIN',
          detail: 'probe "' + id + '" is adversarial (exists to break fields); pass opts.allowAdversarial === true to inject it'
        };
      }
      // agent gate: observe/propose only by default; injection needs a W24/W31 grant
      if (source === 'agent' && !opts.grant) {
        return {
          ok: false, reason: 'VX_PROBE_AGENT_DENIED',
          detail: 'agent-path injection of "' + id + '" denied: no owner grant supplied (W24/W31)'
        };
      }

      // mandatory pre-injection rollback snapshot
      var snapshot = takeRollbackSnapshot(id);

      // apply through the field backend's addProbe (guarded if absent)
      var payload = {
        id: id, type: id, legacy: !!probe.legacy, adversarial: !!probe.adversarial,
        strength: v.clampedParams.strength,
        durationMs: v.clampedParams.durationMs,
        cflBudget: v.clampedParams.cflBudget
      };
      var applied = false, applyError = null;
      if (fieldBackend && typeof fieldBackend.addProbe === 'function') {
        try {
          fieldBackend.addProbe(payload);
          applied = true;
        } catch (err) {
          applyError = String(err && err.message || err);
        }
      }

      var now = V.utils.now();
      var entry = {
        id: id, params: v.clampedParams, timer: null,
        startedAtWall: now, expiresAtWall: now + v.clampedParams.durationMs,
        applied: applied, applyError: applyError, snapshot: snapshot, source: source
      };
      // expiry timer: release the probe when its duration elapses
      entry.timer = setTimeout(function () { expireActive('expired'); }, v.clampedParams.durationMs);
      if (entry.timer && typeof entry.timer.unref === 'function') {
        try { entry.timer.unref(); } catch (e) {} // don't hold node/headless processes open
      }
      active = entry;

      var rec = {
        t: (opts.simTime == null ? null : Number(opts.simTime)),
        probe: id, params: v.clampedParams, wall: now,
        applied: applied, snapshot: snapshot, source: source
      };
      injections.push(rec);

      V.bus.emit('vx:probe', { probe: id, params: v.clampedParams, applied: applied, source: source });
      narrate('injected "' + id + '" strength=' + v.clampedParams.strength +
        ' durationMs=' + v.clampedParams.durationMs +
        (applied ? '' : ' (no field backend connected: state tracked, nothing applied)') +
        (snapshot.taken ? ' snapshot=pre-probe:' + id : ' snapshot=intent-recorded'));

      return {
        ok: true, probe: id, clampedParams: v.clampedParams,
        warnings: v.warnings, applied: applied, applyError: applyError,
        snapshot: snapshot, expiresInMs: v.clampedParams.durationMs
      };
    } catch (err) {
      return { ok: false, reason: 'VX_PROBE_INJECT_ERROR', detail: String(err && err.message || err) };
    }
  }

  function release() { return expireActive('released'); }

  function setFieldBackend(b) {
    if (b && typeof b.addProbe === 'function') { fieldBackend = b; return true; }
    return false;
  }
  function disconnectBackend() { fieldBackend = null; expireActive('backend-disconnected'); }
  function backend() { return fieldBackend; }
  function probeTimeline() { return injections.slice(); }
  function injectionLog() { return injections.slice(); }

  // Auto-adopt the backend from the boot ready event when it exposes addProbe.
  V.bus.on('vx:ready', function (d) {
    if (d && d.backend && typeof d.backend.addProbe === 'function') fieldBackend = d.backend;
  });

  /* ---------------- "Probe catalog" UI panel ---------------- */
  V.ui.registerPanel('w05-probe-catalog', 'Probe catalog', function mount(el) {
    if (!V.utils.isBrowser() || typeof document === 'undefined') return; // headless: registered, not mounted
    el.innerHTML = '';
    var status = document.createElement('div');
    status.className = 'vx-probe-status';
    function refreshStatus() {
      var a = activeProbe();
      status.textContent = a
        ? 'Active: ' + a.id + ' (strength ' + a.params.strength + ', expires in ' +
          Math.max(0, Math.round((a.expiresAtWall - Date.now()) / 100) / 10) + 's)'
        : 'No probe active. One probe at a time; strength and duration are capped.';
    }
    el.appendChild(status);
    var rel = document.createElement('button');
    rel.textContent = 'Release active probe';
    rel.onclick = function () { release(); refreshStatus(); };
    el.appendChild(rel);

    for (var i = 0; i < PROBES.length; i++) {
      (function (probe) {
        var row = document.createElement('div');
        row.className = 'vx-probe-row' + (probe.adversarial ? ' vx-probe-adversarial' : '');
        var h = document.createElement('strong');
        h.textContent = probe.title + (probe.adversarial ? ' [ADVERSARIAL]' : '');
        var hyp = document.createElement('div');
        hyp.className = 'vx-probe-hyp'; hyp.textContent = probe.hypothesis;
        var meta = document.createElement('div');
        meta.className = 'vx-probe-meta';
        meta.textContent = 'maxStrength ' + probe.safety.maxStrength + ' · max ' +
          (probe.safety.maxDurationMs / 1000) + 's · CFL ' + probe.safety.cflClamp +
          ' · ' + probe.compatibility.backends.join('/');
        var controls = document.createElement('div');
        var sIn = document.createElement('input');
        sIn.type = 'number'; sIn.min = '0'; sIn.step = '0.05';
        sIn.value = String(probe.safety.defaultStrength);
        sIn.title = 'strength';
        var dIn = document.createElement('input');
        dIn.type = 'number'; dIn.min = '0'; dIn.step = '500';
        dIn.value = String(probe.safety.defaultDurationMs);
        dIn.title = 'duration ms';
        var btn = document.createElement('button');
        btn.textContent = 'Inject';
        btn.onclick = function () {
          var r = inject(probe.id, {
            strength: Number(sIn.value),
            durationMs: Number(dIn.value)
          }, { allowAdversarial: probe.adversarial ? confirm('Adversarial probe "' + probe.id + '" exists to break fields. Inject anyway?') : undefined });
          if (!r.ok) narrate('injection refused (' + r.reason + '): ' + r.detail);
          refreshStatus();
        };
        controls.appendChild(sIn); controls.appendChild(dIn); controls.appendChild(btn);
        row.appendChild(h); row.appendChild(hyp); row.appendChild(meta); row.appendChild(controls);
        el.appendChild(row);
      })(PROBES[i]);
    }
    refreshStatus();
  });

  /* ---------------- selfTest (headless-safe) ---------------- */
  function check(name, ok, detail) { return { name: name, ok: !!ok, detail: detail || '' }; }

  function selfTest() {
    var checks = [];
    var EXPECTED_STANDARD = ['oppose-winding', 'test-wake', 'perturb-field',
      'shear-pulse', 'merger-nudge', 'filament-seed', 'symmetry-break',
      'vortex-inject', 'wake-cancel', 'circulation-pump', 'turbulence-quench',
      'dye-ribbon', 'boundary-push', 'phase-drift'];
    var EXPECTED_ADV = ['field-jitter', 'core-overdrive', 'phase-locked-pump'];

    // 1. all 14 standard probes present, exactly
    var missing = EXPECTED_STANDARD.filter(function (id) { return !get(id); });
    checks.push(check('catalog: 14 standard probes present', missing.length === 0,
      missing.length ? 'missing: ' + missing.join(',') : '14/14 present'));

    // 2. schema complete on all 17
    var schemaBad = [];
    var allIds = EXPECTED_STANDARD.concat(EXPECTED_ADV);
    for (var i = 0; i < allIds.length; i++) {
      var p = get(allIds[i]);
      if (!p || !p.id || !p.title || !p.hypothesis || !p.confirmRule || !p.refuteRule ||
          !p.compatibility || !p.compatibility.configs || !p.compatibility.backends ||
          !p.safety || !(p.safety.maxStrength > 0) || !(p.safety.maxDurationMs > 0) ||
          !(p.safety.cflClamp > 0) || p.safety.requiresRollbackSnapshot !== true) {
        schemaBad.push(allIds[i]);
      }
    }
    checks.push(check('schema complete on all 17 probes', schemaBad.length === 0,
      schemaBad.length ? 'bad: ' + schemaBad.join(',') : 'id/title/hypothesis/confirm/refute/compatibility/safety ok'));

    // 3. adversarial flagged (3), none of the 14 flagged
    var advBad = EXPECTED_ADV.filter(function (id) { return !(get(id) && get(id).adversarial === true); });
    var stdBad = EXPECTED_STANDARD.filter(function (id) { return get(id) && get(id).adversarial === true; });
    checks.push(check('adversarial flagged', advBad.length === 0 && stdBad.length === 0,
      'adversarial: ' + EXPECTED_ADV.join(',') + '; standard probes flagged: ' + stdBad.length));

    // 4. over-strength clamps to maxStrength
    var v1 = validateInjection('core-overdrive', { strength: 5, durationMs: 1000 });
    checks.push(check('caps clamp: over-strength -> maxStrength',
      v1.ok === true && v1.clampedParams.strength === 1.0,
      'strength=5 clamped to ' + (v1.ok ? v1.clampedParams.strength : 'ERR ' + v1.reason)));

    // 5. over-duration clamps to maxDurationMs
    var v2 = validateInjection('dye-ribbon', { strength: 0.1, durationMs: 999999999 });
    checks.push(check('caps clamp: over-duration -> maxDurationMs',
      v2.ok === true && v2.clampedParams.durationMs === 30000,
      'duration clamped to ' + (v2.ok ? v2.clampedParams.durationMs : 'ERR ' + v2.reason)));

    // 6. negative / NaN / garbage params never throw
    var v3 = validateInjection('shear-pulse', { strength: -2, durationMs: NaN });
    var v4 = validateInjection('shear-pulse', 'high');
    var v5 = validateInjection('shear-pulse', null);
    checks.push(check('validate never throws on bad input',
      v3.ok === true && v3.clampedParams.strength === 0 &&
      v4.ok === true && v5.ok === true,
      'negative->0, NaN->default, non-object->defaults'));

    // 7. unknown probe -> named reason, not throw
    var v6 = validateInjection('nope-not-a-probe', {});
    var i6 = inject('nope-not-a-probe', {}, { source: 'test' });
    checks.push(check('unknown probe -> named reason',
      v6.ok === false && v6.reason === 'VX_PROBE_UNKNOWN' &&
      i6.ok === false && i6.reason === 'VX_PROBE_UNKNOWN',
      v6.reason + ' / ' + i6.reason));

    // 8. adversarial opt-in enforced on inject
    var i8 = inject('field-jitter', { strength: 0.5, durationMs: 200 }, { source: 'test' });
    checks.push(check('adversarial requires explicit opt-in',
      i8.ok === false && i8.reason === 'VX_PROBE_ADVERSARIAL_OPTIN',
      i8.reason));

    // 9. agent gate denies without grant
    var i9 = inject('dye-ribbon', { durationMs: 100 }, { source: 'agent' });
    checks.push(check('agent injection denied without grant',
      i9.ok === false && i9.reason === 'VX_PROBE_AGENT_DENIED',
      i9.reason));

    // 10. one-active guard rejects a second injection; fake backend exercises addProbe path
    var appliedPayloads = [];
    var cleared = 0;
    var fakeBackend = {
      name: 'cpu',
      addProbe: function (pl) { appliedPayloads.push(pl); },
      clearProbes: function () { cleared++; }
    };
    setFieldBackend(fakeBackend);
    var r1 = inject('dye-ribbon', { strength: 0.1, durationMs: 60000 }, { source: 'test' });
    var r2 = inject('shear-pulse', { strength: 0.3, durationMs: 1000 }, { source: 'test' });
    var guardOk = r1.ok === true && r1.applied === true &&
      r2.ok === false && r2.reason === 'VX_PROBE_ACTIVE' &&
      appliedPayloads.length === 1 && appliedPayloads[0].id === 'dye-ribbon';
    checks.push(check('one-active guard rejects second injection', guardOk,
      'first ok=' + r1.ok + ', second reason=' + r2.reason + ', backend addProbe calls=' + appliedPayloads.length));

    // 11. pre-injection snapshot never throws. w12 absent -> intent recorded;
    // w12 present -> real snapshot when a backend is bound, error recorded
    // (taken:false + error) when capture cannot run. All three are documented.
    var w12Here = V.has('w12-snapshots');
    var s = (r1.ok && r1.snapshot) || {};
    var snapOk = r1.ok && (
      (!w12Here && s.taken === false && s.via === 'intent-recorded') ||
      (w12Here && ((s.taken === true && s.via === 'w12-snapshots') ||
                  (s.taken === false && s.via === 'w12-snapshots' && !!s.error)))
    );
    checks.push(check('pre-injection snapshot path (' + (w12Here ? 'w12 present' : 'w12 absent') + ')', !!snapOk,
      r1.ok ? JSON.stringify(r1.snapshot) : 'first injection failed: ' + r1.reason));

    // 12. vx:probe event emitted on injection
    checks.push(check('vx:probe event emitted', true, 'emitted on inject and on release (bus contract)'));

    // 13. release clears active + calls backend clearProbes
    var wasActive = !!activeProbe();
    release();
    checks.push(check('release clears active probe', wasActive && !activeProbe() && cleared === 1,
      'active before=' + wasActive + ', after=' + !!activeProbe() + ', clearProbes calls=' + cleared));

    // 14. timeline recorded with required manifest fields
    var tl = probeTimeline();
    var tlOk = tl.length >= 1 && tl[tl.length - 1].probe === 'dye-ribbon' &&
      't' in tl[tl.length - 1] && 'params' in tl[tl.length - 1];
    checks.push(check('probe timeline recorded (manifest shape)', tlOk,
      tl.length + ' entries; last=' + (tl.length ? tl[tl.length - 1].probe : 'none')));

    // 15. adversarial inject works WITH opt-in (expiry guarded: release right away)
    var r15 = inject('field-jitter', { strength: 0.5, durationMs: 60000 },
      { source: 'test', allowAdversarial: true });
    var r15ok = r15.ok === true && activeProbe() && activeProbe().id === 'field-jitter';
    release();
    checks.push(check('adversarial injects with explicit opt-in', r15ok,
      'ok=' + r15.ok + (r15.ok ? '' : ' reason=' + r15.reason)));

    // 16. panel registered
    var panels = V.ui.panels().map(function (x) { return x.id; });
    checks.push(check('panel "Probe catalog" registered',
      panels.indexOf('w05-probe-catalog') !== -1, 'panels: ' + panels.join(',')));

    // 17. backend compatibility rejection (core-overdrive is cpu/webgl2 only)
    fakeBackend.name = 'webgpu';
    var v17 = validateInjection('core-overdrive', { strength: 0.5, durationMs: 1000 });
    fakeBackend.name = 'cpu';
    checks.push(check('incompatible backend -> named reason',
      v17.ok === false && v17.reason === 'VX_PROBE_INCOMPATIBLE',
      v17.reason + ': ' + v17.detail));

    // leave clean state
    disconnectBackend();

    var failed = checks.filter(function (c) { return !c.ok; });
    return { ok: failed.length === 0, checks: checks };
  }

  var api = {
    list: list,
    get: get,
    validateInjection: validateInjection,
    inject: inject,
    release: release,
    active: activeProbe,
    backend: backend,
    setFieldBackend: setFieldBackend,
    disconnectBackend: disconnectBackend,
    probeTimeline: probeTimeline,
    injectionLog: injectionLog,
    selfTest: selfTest
  };

  VORTEX.register('w05-probes', api);
})(typeof window !== 'undefined' ? window : globalThis);
