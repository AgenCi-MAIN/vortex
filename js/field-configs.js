/* VORTEX js/field-configs.js — W04: field configurations as DATA + recipe schema.
 *
 * BOUNDARY DOCUMENTATION (read before touching this file):
 * ---------------------------------------------------------------------------
 * These configs are DECLARATIVE DATA ONLY. The `recipe` on each config is a
 * JSON-safe description of the field math (terms, parameters, boundary
 * conditions) — it is NOT executable code and this module never evaluates it.
 * Executable field math for a recipe ships only through the reviewed path:
 * an engineer implements the recipe against the W02 VortexField contract,
 * the implementation is reviewed, and its reference id is recorded in
 * `recipe.reviewedImplementation`. Until that reference is set, a config is
 * flagged `recipeStatus: 'declarative-only'` and the panel warns before apply.
 * The `validate()` gate in this module enforces schema shape; it does not
 * certify the physics. No eval, no Function(), no codegen anywhere here.
 * ---------------------------------------------------------------------------
 *
 * Each config:
 *   { id, title, description,
 *     defaults: { circulation, turbulence, persistence, ...extra },
 *     coreRanges: (shared CORE_PARAM_RANGES, documented here),
 *     sliderRanges: [ up to 3 EXTRA sliders {key,min,max,step,label} ],
 *     probeCompatibility: [probeIds],
 *     phenomenaTags: [],
 *     seed: integer (deterministic),
 *     hypothesisSeed: string (what to test),
 *     recipe: { schemaVersion:'recipe-v1', summary, initialField, forcing,
 *               boundary, reviewedImplementation, notes },
 *     recipeStatus: 'declarative-only' | 'reviewed' }
 *
 * Panel "Field configs" switches configs via backend.setParams through the
 * field contract; guarded when no backend is registered yet.
 *
 * Module id: 'w04-configs'. Headless-safe. Plain script, no modules.
 */
(function (root) {
  'use strict';

  var CORE_PARAM_RANGES = {
    circulation: { min: 0, max: 2, step: 0.01, label: 'Circulation' },
    turbulence:  { min: 0, max: 1, step: 0.01, label: 'Turbulence' },
    persistence: { min: 0, max: 1, step: 0.01, label: 'Persistence' }
  };
  var CORE_KEYS = ['circulation', 'turbulence', 'persistence'];
  var MAX_EXTRA_SLIDERS = 3;
  var RECIPE_SCHEMA = 'recipe-v1';
  var ID_RE = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;

  // Core probe ids known from the current UI (W01 chrome). W05's 14-probe
  // catalog is anticipated via 'w05:'-prefixed ids; resolveProbeCompat()
  // re-resolves against the real catalog when it registers.
  var CORE_PROBES = ['oppose-winding', 'test-the-wake', 'perturb-field'];

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // ---------------------------------------------------------------- configs
  var CONFIGS = [
    {
      id: 'spiral-default',
      title: 'Spiral (default)',
      description: "Today's lab state: a single seeded spiral vortex with the standard Circulation / Turbulence / Persistence sliders. Baseline every other config is compared against.",
      defaults: { circulation: 1.0, turbulence: 0.3, persistence: 0.7 },
      sliderRanges: [],
      probeCompatibility: CORE_PROBES.slice(),
      phenomenaTags: ['baseline', 'single-vortex', 'spiral'],
      seed: 7,
      hypothesisSeed: 'Baseline: is the spiral core stable across the full circulation range before any other config is introduced?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Single point vortex with Gaussian core; tracer dye advected by the induced velocity field.',
        initialField: { type: 'point-vortex', params: { coreRadius: 0.12, peakVorticity: 1.0 } },
        forcing: [],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Reference config. Executable math to be reviewed against the W02 VortexField contract before any "reviewed" status.'
      }
    },
    {
      id: 'kelvin-helmholtz',
      title: 'Kelvin–Helmholtz shear',
      description: 'Two counter-flowing layers with a perturbed interface. Shear rolls the interface into the classic KH billows; watch merger cascade as billows pair up.',
      defaults: { circulation: 1.0, turbulence: 0.25, persistence: 0.8, shearRate: 1.2, layerThickness: 0.12, perturbAmp: 0.15 },
      sliderRanges: [
        { key: 'shearRate', min: 0, max: 3, step: 0.05, label: 'Shear rate' },
        { key: 'layerThickness', min: 0.02, max: 0.5, step: 0.01, label: 'Layer thickness' },
        { key: 'perturbAmp', min: 0, max: 1, step: 0.01, label: 'Seed perturbation' }
      ],
      probeCompatibility: ['oppose-winding', 'perturb-field', 'w05:field-jitter', 'w05:phase-locked-pump'],
      phenomenaTags: ['shear-instability', 'billow-formation', 'mixing-layer', 'merger-cascade'],
      seed: 1407,
      hypothesisSeed: 'Do billow merger times scale inversely with shear rate at fixed layer thickness?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Hyperbolic-tangent shear profile u(y) = U0 * tanh(y/d) seeded with a single-wavelength sinusoidal interface perturbation; seeded PRNG picks the perturbation phase.',
        initialField: { type: 'shear-layer', params: { profile: 'tanh', perturbation: 'sinusoidal', wavelength: 'domain/1' } },
        forcing: [],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Executable path must reproduce the seeded perturbation phase exactly (mulberry32, config seed).'
      }
    },
    {
      id: 'decaying-turbulence',
      title: 'Decaying turbulence',
      description: 'A seeded random vorticity field with a prescribed energy spectrum, left to decay. Measures the energy cascade and enstrophy decay without any forcing.',
      defaults: { circulation: 0.8, turbulence: 0.9, persistence: 0.9, spectralSlope: 3.0, largeScaleEnergy: 1.0, dampingRate: 0.2 },
      sliderRanges: [
        { key: 'spectralSlope', min: 1, max: 5, step: 0.1, label: 'Spectrum slope' },
        { key: 'largeScaleEnergy', min: 0, max: 2, step: 0.05, label: 'Large-scale energy' },
        { key: 'dampingRate', min: 0, max: 1, step: 0.01, label: 'Damping rate' }
      ],
      probeCompatibility: ['perturb-field', 'test-the-wake', 'w05:field-jitter'],
      phenomenaTags: ['energy-cascade', 'enstrophy-decay', 'homogeneous-turbulence'],
      seed: 20260,
      hypothesisSeed: 'Does the measured enstrophy decay exponent match the spectral-slope prediction from the initial condition?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Random-phase Fourier vorticity field with E(k) ~ k^-slope between kMin and kMax; amplitudes from seeded PRNG; viscous damping term -nu*omega.',
        initialField: { type: 'random-spectrum', params: { kMin: 2, kMax: 32, phases: 'seeded' } },
        forcing: [],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Determinism-sensitive: phase table must be generated from mulberry32(seed) in fixed k-order.'
      }
    },
    {
      id: 'stratified-shear',
      title: 'Stratified shear',
      description: 'Shear across a density interface: buoyancy fights the roll-up. Below the Richardson threshold the billows still form; above it, internal waves radiate instead.',
      defaults: { circulation: 1.0, turbulence: 0.2, persistence: 0.85, buoyancyFreq: 1.0, shearRate: 1.0, interfaceThickness: 0.08 },
      sliderRanges: [
        { key: 'buoyancyFreq', min: 0, max: 3, step: 0.05, label: 'Buoyancy frequency' },
        { key: 'shearRate', min: 0, max: 3, step: 0.05, label: 'Shear rate' },
        { key: 'interfaceThickness', min: 0.02, max: 0.5, step: 0.01, label: 'Interface thickness' }
      ],
      probeCompatibility: ['oppose-winding', 'perturb-field', 'w05:phase-locked-pump'],
      phenomenaTags: ['stratification', 'internal-waves', 'richardson-criterion', 'shear-instability'],
      seed: 31415,
      hypothesisSeed: 'At what Richardson number does the billow roll-up give way to radiating internal waves?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Boussinesq analogue: tanh shear profile plus a stably stratified density interface; buoyancy term -N^2 * displacement opposes vertical motion.',
        initialField: { type: 'stratified-shear-layer', params: { densityProfile: 'tanh', perturbation: 'sinusoidal' } },
        forcing: [],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'The tracer field carries a dye scalar standing in for density; reviewed implementation must define the Boussinesq coupling explicitly.'
      }
    },
    {
      id: 'periodic-drive',
      title: 'Periodic drive',
      description: 'Time-periodic body forcing on top of a base vortex. Sweep the drive frequency to hunt resonances and parametric instability tongues.',
      defaults: { circulation: 1.0, turbulence: 0.3, persistence: 0.75, driveFreq: 1.0, driveAmp: 0.5, driveWavenumber: 2 },
      sliderRanges: [
        { key: 'driveFreq', min: 0.1, max: 4, step: 0.05, label: 'Drive frequency' },
        { key: 'driveAmp', min: 0, max: 2, step: 0.05, label: 'Drive amplitude' },
        { key: 'driveWavenumber', min: 1, max: 8, step: 1, label: 'Drive wavenumber' }
      ],
      probeCompatibility: ['perturb-field', 'test-the-wake', 'w05:phase-locked-pump', 'w05:core-overdrive'],
      phenomenaTags: ['resonance', 'parametric-instability', 'forced-flow', 'frequency-sweep'],
      seed: 555,
      hypothesisSeed: 'Is there a drive frequency that resonantly amplifies the base vortex (amplitude peak in a frequency sweep)?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Base point vortex plus body force F = A * sin(2*pi*f*t) * cos(k*x) * x-hat, applied as a velocity increment each step.',
        initialField: { type: 'point-vortex', params: { coreRadius: 0.12, peakVorticity: 1.0 } },
        forcing: [{ type: 'oscillatory-body-force', params: {}, schedule: 'continuous' }],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Drive phase must be a deterministic function of sim-step count (fixed dt), never wall-clock time.'
      }
    },
    {
      id: 'time-reversed-wake',
      title: 'Time-reversed wake',
      description: 'Evolve a wake forward for a fixed window, then run the identical field backward in time. A reversible engine should re-form the obstacle signature.',
      defaults: { circulation: 0.9, turbulence: 0.15, persistence: 1.0, reversalTime: 30, wakeStrength: 1.0, mirrorSymmetric: 1 },
      sliderRanges: [
        { key: 'reversalTime', min: 5, max: 120, step: 1, label: 'Reversal time (s)' },
        { key: 'wakeStrength', min: 0, max: 2, step: 0.05, label: 'Wake strength' },
        { key: 'mirrorSymmetric', min: 0, max: 1, step: 1, label: 'Mirror symmetry' }
      ],
      probeCompatibility: ['test-the-wake', 'oppose-winding'],
      phenomenaTags: ['time-reversal', 'reversibility', 'wake-recovery'],
      seed: 8675309,
      hypothesisSeed: 'After time reversal, does the wake re-form the obstacle signature within the W25 tolerance bands?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Phase 1: uniform inflow past a circular obstacle for reversalTime seconds (forward advection). Phase 2: sign of dt flips; the identical velocity field advects tracers backward along their trajectories.',
        initialField: { type: 'uniform-inflow-with-obstacle', params: { obstacle: 'circle' } },
        forcing: [],
        boundary: { type: 'open-inflow-outflow' },
        reviewedImplementation: null,
        notes: 'Reversal requires a deterministic, non-diffusive advection kernel; any added diffusion breaks the test by construction — record diffusion=0 as a precondition.'
      }
    },
    {
      id: 'vortex-pair-merger',
      title: 'Vortex-pair merger',
      description: 'Two co-rotating vortices at a seeded separation. Below the critical separation ratio they merge into one; the merger clock is the phenomenon to measure.',
      defaults: { circulation: 1.2, turbulence: 0.2, persistence: 0.9, pairSeparation: 0.6, strengthRatio: 1.0, coreRadius: 0.12 },
      sliderRanges: [
        { key: 'pairSeparation', min: 0.2, max: 2.0, step: 0.02, label: 'Pair separation' },
        { key: 'strengthRatio', min: 0.2, max: 2.0, step: 0.05, label: 'Strength ratio' },
        { key: 'coreRadius', min: 0.05, max: 0.5, step: 0.01, label: 'Core radius' }
      ],
      probeCompatibility: ['oppose-winding', 'perturb-field', 'w05:core-overdrive'],
      phenomenaTags: ['merger', 'vortex-dynamics', 'filamentation', 'critical-separation'],
      seed: 2718,
      hypothesisSeed: 'Is there a sharp critical separation ratio (a/d) above which the pair never merges within the run window?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Two Gaussian-core point vortices of same-sign circulation, placed symmetrically about the domain center at seeded angle; mutual induction drives the orbit and eventual merger.',
        initialField: { type: 'vortex-pair', params: { placement: 'symmetric', angle: 'seeded' } },
        forcing: [],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Merger time is a W07 metric; reviewed implementation must define the merger-detection criterion (e.g. core-distance < coreRadius).'
      }
    },
    {
      id: 'karman-street',
      title: 'Kármán street (wake + obstacle)',
      description: 'Steady inflow past a cylinder. Past the critical Reynolds proxy, alternating vortices shed into the classic von Kármán street.',
      defaults: { circulation: 0.7, turbulence: 0.25, persistence: 0.85, inflowSpeed: 1.0, obstacleRadius: 0.12, viscosityProxy: 0.02 },
      sliderRanges: [
        { key: 'inflowSpeed', min: 0.2, max: 2.0, step: 0.05, label: 'Inflow speed' },
        { key: 'obstacleRadius', min: 0.05, max: 0.3, step: 0.01, label: 'Obstacle radius' },
        { key: 'viscosityProxy', min: 0.001, max: 0.1, step: 0.001, label: 'Viscosity proxy' }
      ],
      probeCompatibility: ['test-the-wake', 'perturb-field', 'w05:field-jitter'],
      phenomenaTags: ['karman-street', 'wake', 'vortex-shedding', 'obstacle', 'reynolds-sweep'],
      seed: 1949,
      hypothesisSeed: 'Does the shedding frequency (Strouhal number) stay constant across a sweep of inflow speed at fixed viscosity proxy?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Uniform inflow from the left boundary, circular no-through-flow obstacle at domain center-left; outflow on the right; shear layers from the obstacle roll up into alternating shed vortices.',
        initialField: { type: 'uniform-inflow-with-obstacle', params: { obstacle: 'circle' } },
        forcing: [],
        boundary: { type: 'open-inflow-outflow' },
        reviewedImplementation: null,
        notes: 'Shed vortices are emergent, not seeded; the reviewed implementation must specify how the obstacle boundary is represented on the tracer grid.'
      }
    },
    {
      id: 'magnetic-analogue',
      title: 'Magnetic-field analogue',
      description: 'A Lorentz-like body force stands in for a background magnetic field. Alfvén-style waves propagate along the field direction; the beta proxy tunes field stiffness.',
      defaults: { circulation: 0.8, turbulence: 0.3, persistence: 0.8, alfvenSpeed: 0.8, fieldAngle: 45, betaProxy: 2.0 },
      sliderRanges: [
        { key: 'alfvenSpeed', min: 0, max: 2, step: 0.05, label: 'Alfvén speed' },
        { key: 'fieldAngle', min: 0, max: 180, step: 1, label: 'Field angle (deg)' },
        { key: 'betaProxy', min: 0.1, max: 10, step: 0.1, label: 'Plasma beta proxy' }
      ],
      probeCompatibility: ['perturb-field', 'oppose-winding', 'w05:phase-locked-pump'],
      phenomenaTags: ['mhd-analogue', 'lorentz-force', 'alfven-waves', 'field-line-tension'],
      seed: 424242,
      hypothesisSeed: 'Does the measured wave speed along the field direction scale linearly with the Alfvén speed parameter?',
      recipeStatus: 'declarative-only',
      recipe: {
        schemaVersion: RECIPE_SCHEMA,
        summary: 'Base vortex plus a tension-like restoring force along a uniform background direction B0 at fieldAngle; force ~ (alfvenSpeed^2 / betaProxy) * curvature of tracer displacement from the field line.',
        initialField: { type: 'point-vortex', params: { coreRadius: 0.12, peakVorticity: 1.0 } },
        forcing: [{ type: 'field-line-tension', params: {}, schedule: 'continuous' }],
        boundary: { type: 'periodic' },
        reviewedImplementation: null,
        notes: 'Analogue only: no real MHD. Reviewed implementation must state the exact discrete tension operator so the wave-speed claim is testable.'
      }
    }
  ];

  var _byId = {};
  CONFIGS.forEach(function (c) { _byId[c.id] = c; });

  // ---------------------------------------------------------------- validate
  function validate(config) {
    var reasons = [];
    function bad(reason) { reasons.push(reason); }

    if (!config || typeof config !== 'object') { bad('NOT_AN_OBJECT'); return done(); }
    if (typeof config.id !== 'string' || !ID_RE.test(config.id)) bad('INVALID_ID');
    if (typeof config.title !== 'string' || !config.title) bad('MISSING_TITLE');
    if (typeof config.description !== 'string' || !config.description) bad('MISSING_DESCRIPTION');

    var d = config.defaults;
    if (!d || typeof d !== 'object') {
      bad('MISSING_DEFAULTS');
    } else {
      CORE_KEYS.forEach(function (k) {
        if (!isNum(d[k])) { bad('MISSING_CORE_DEFAULT:' + k); return; }
        var r = CORE_PARAM_RANGES[k];
        if (d[k] < r.min || d[k] > r.max) bad('CORE_DEFAULT_OUT_OF_RANGE:' + k);
      });
    }

    var sr = config.sliderRanges;
    if (!Array.isArray(sr)) {
      bad('MISSING_SLIDER_RANGES');
    } else {
      if (sr.length > MAX_EXTRA_SLIDERS) bad('TOO_MANY_SLIDERS:' + sr.length);
      var seen = {};
      sr.forEach(function (s, i) {
        if (!s || typeof s !== 'object') { bad('BAD_SLIDER_SCHEMA:' + i); return; }
        if (typeof s.key !== 'string' || !ID_RE.test(s.key)) { bad('BAD_SLIDER_KEY:' + i); return; }
        var keyUsable = true;
        if (seen[s.key]) { bad('DUPLICATE_SLIDER_KEY:' + s.key); keyUsable = false; }
        else seen[s.key] = true;
        if (CORE_KEYS.indexOf(s.key) !== -1) { bad('SLIDER_KEY_COLLISION:' + s.key); keyUsable = false; }
        if (!isNum(s.min) || !isNum(s.max) || !(s.min < s.max)) bad('BAD_SLIDER_BOUNDS:' + s.key);
        if (!isNum(s.step) || s.step <= 0) bad('BAD_SLIDER_STEP:' + s.key);
        if (typeof s.label !== 'string' || !s.label) bad('MISSING_SLIDER_LABEL:' + s.key);
        if (d && typeof d === 'object' && keyUsable) {
          if (!isNum(d[s.key])) bad('SLIDER_DEFAULT_MISSING:' + s.key);
          else if (d[s.key] < s.min || d[s.key] > s.max) bad('SLIDER_DEFAULT_OUT_OF_RANGE:' + s.key);
        }
      });
      if (d && typeof d === 'object') {
        Object.keys(d).forEach(function (k) {
          if (CORE_KEYS.indexOf(k) === -1 && !seen[k]) bad('UNKNOWN_DEFAULT_KEY:' + k);
        });
      }
    }

    var pc = config.probeCompatibility;
    if (!Array.isArray(pc) || !pc.length) {
      bad('MISSING_PROBE_COMPATIBILITY');
    } else {
      pc.forEach(function (p) {
        if (typeof p !== 'string' || !p) { bad('BAD_PROBE_ID:empty'); return; }
        if (p.indexOf('w05:') === 0) {
          if (!ID_RE.test(p.slice(4))) bad('BAD_PROBE_ID:' + p);
        } else if (!ID_RE.test(p)) {
          bad('BAD_PROBE_ID:' + p);
        }
      });
    }

    if (!Array.isArray(config.phenomenaTags) || !config.phenomenaTags.length) {
      bad('MISSING_PHENOMENA_TAGS');
    } else {
      config.phenomenaTags.forEach(function (t) {
        if (typeof t !== 'string' || !t) bad('BAD_PHENOMENA_TAG');
      });
    }

    if (!Number.isInteger(config.seed)) bad('NON_INTEGER_SEED');
    if (typeof config.hypothesisSeed !== 'string' || !config.hypothesisSeed) bad('MISSING_HYPOTHESIS');

    var r = config.recipe;
    if (!r || typeof r !== 'object') {
      bad('MISSING_RECIPE');
    } else {
      if (r.schemaVersion !== RECIPE_SCHEMA) bad('BAD_RECIPE_SCHEMA');
      if (typeof r.summary !== 'string' || !r.summary) bad('MISSING_RECIPE_SUMMARY');
      if (config.recipeStatus === 'reviewed' && !r.reviewedImplementation) bad('REVIEWED_WITHOUT_REFERENCE');
    }
    if (config.recipeStatus !== 'declarative-only' && config.recipeStatus !== 'reviewed') {
      bad('BAD_RECIPE_STATUS');
    }

    return done();
    function done() { return { ok: reasons.length === 0, reasons: reasons }; }
  }

  // Re-resolve probe ids against the W05 catalog when present; drops ids the
  // catalog does not know, returns { compatible, unresolved }.
  function resolveProbeCompat(config) {
    var unresolved = [];
    var compatible = (config.probeCompatibility || []).filter(function (p) {
      if (p.indexOf('w05:') !== 0) return true;
      if (VORTEX.has('w05-probes')) {
        var cat = VORTEX.get('w05-probes');
        var id = p.slice(4);
        if (cat && typeof cat.has === 'function' && cat.has(id)) return true;
      }
      unresolved.push(p);
      return false;
    });
    return { compatible: compatible, unresolved: unresolved };
  }

  // ---------------------------------------------------------------- backend
  var _pendingConfigId = null;

  function resolveBackend() {
    // Field contract is W02-owned. Guard: nothing here assumes it exists.
    if (!VORTEX.has('w02-field-contract')) return null;
    var fc = VORTEX.get('w02-field-contract');
    if (!fc || typeof fc.getActiveBackend !== 'function') return null;
    try { return fc.getActiveBackend() || null; } catch (e) { return null; }
  }

  function applyConfig(id) {
    var cfg = _byId[id];
    if (!cfg) {
      VORTEX.ui.announce('Unknown field config: ' + id);
      return { ok: false, reason: 'UNKNOWN_CONFIG' };
    }
    var params = {};
    Object.keys(cfg.defaults).forEach(function (k) { params[k] = cfg.defaults[k]; });

    var backend = resolveBackend();
    if (!backend || typeof backend.setParams !== 'function') {
      _pendingConfigId = id;
      VORTEX.ui.announce('Config "' + cfg.title + '" staged — no backend yet. It will apply when the field is ready.');
      VORTEX.bus.emit('vx:config-staged', { configId: id, params: params });
      return { ok: true, staged: true };
    }
    try {
      backend.setParams(params);
    } catch (e) {
      VORTEX.ui.announce('Config apply failed: ' + (e && e.message ? e.message : e));
      return { ok: false, reason: 'SETPARAMS_FAILED' };
    }
    _pendingConfigId = null;
    var note = cfg.recipeStatus === 'reviewed'
      ? 'Field config applied: ' + cfg.title + ' (reviewed implementation)'
      : 'Field config applied: ' + cfg.title + ' — recipe is declarative-only, params applied to the current field';
    VORTEX.ui.announce(note);
    VORTEX.bus.emit('vx:config', { configId: id, params: params, seed: cfg.seed });
    return { ok: true, staged: false };
  }

  // When the backend becomes ready, flush any staged config.
  VORTEX.bus.on('vx:ready', function () {
    if (_pendingConfigId) applyConfig(_pendingConfigId);
  });

  // ---------------------------------------------------------------- api
  function list() {
    return CONFIGS.map(function (c) {
      return { id: c.id, title: c.title, seed: c.seed, recipeStatus: c.recipeStatus };
    });
  }
  function get(id) { return _byId[id] ? JSON.parse(JSON.stringify(_byId[id])) : null; }

  function mountPanel(el) {
    if (typeof document === 'undefined' || !el) return;
    el.innerHTML = '';
    var doc = root.document;

    var wrap = doc.createElement('div');
    wrap.className = 'vx-w04-configs';

    var label = doc.createElement('label');
    label.textContent = 'Field config';
    label.setAttribute('for', 'vx-w04-config-select');

    var sel = doc.createElement('select');
    sel.id = 'vx-w04-config-select';
    CONFIGS.forEach(function (c) {
      var o = doc.createElement('option');
      o.value = c.id;
      o.textContent = c.title + (c.recipeStatus === 'reviewed' ? '' : ' (declarative)');
      sel.appendChild(o);
    });

    var desc = doc.createElement('p');
    desc.className = 'vx-w04-desc';
    var hyp = doc.createElement('p');
    hyp.className = 'vx-w04-hyp';

    function refresh() {
      var c = _byId[sel.value];
      desc.textContent = c ? c.description : '';
      hyp.textContent = c ? 'Test: ' + c.hypothesisSeed : '';
    }
    sel.addEventListener('change', refresh);
    refresh();

    var btn = doc.createElement('button');
    btn.textContent = 'Apply config';
    btn.addEventListener('click', function () { applyConfig(sel.value); });

    wrap.appendChild(label);
    wrap.appendChild(sel);
    wrap.appendChild(desc);
    wrap.appendChild(hyp);
    wrap.appendChild(btn);
    el.appendChild(wrap);
  }

  // Register panel only where the DOM exists; headless stays silent.
  if (typeof root.document !== 'undefined') {
    try { VORTEX.ui.registerPanel('w04-field-configs', 'Field configs', mountPanel); }
    catch (e) { /* chrome not ready yet; panel simply absent */ }
  }

  function selfTest() {
    var checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

    // 1. All shipped configs validate cleanly.
    var badOnes = [];
    CONFIGS.forEach(function (c) {
      var v = validate(c);
      if (!v.ok) badOnes.push(c.id + ':' + v.reasons.join(','));
    });
    check('all-configs-validate', badOnes.length === 0,
      badOnes.length ? badOnes.join(' | ') : CONFIGS.length + ' configs clean');

    // 2. A deliberately broken config fails with named reasons.
    var broken = {
      id: '', title: 'x', description: 'x',
      defaults: { circulation: 99, turbulence: 0, persistence: 0, mystery: 1, ghost: 2 },
      sliderRanges: [{ key: 'mystery', min: 0, max: 1, step: 0, label: '' }],
      probeCompatibility: [], phenomenaTags: [],
      seed: 1.5, hypothesisSeed: '', recipeStatus: 'bogus',
      recipe: { schemaVersion: 'nope' }
    };
    var bv = validate(broken);
    var expected = ['INVALID_ID', 'CORE_DEFAULT_OUT_OF_RANGE:circulation',
      'UNKNOWN_DEFAULT_KEY:ghost', 'BAD_SLIDER_STEP:mystery',
      'MISSING_SLIDER_LABEL:mystery', 'MISSING_PROBE_COMPATIBILITY',
      'MISSING_PHENOMENA_TAGS', 'NON_INTEGER_SEED', 'MISSING_HYPOTHESIS',
      'BAD_RECIPE_SCHEMA', 'MISSING_RECIPE_SUMMARY', 'BAD_RECIPE_STATUS'];
    var missing = expected.filter(function (r) { return bv.reasons.indexOf(r) === -1; });
    check('broken-config-fails-named', !bv.ok && missing.length === 0,
      bv.ok ? 'broken config PASSED validate' :
      (missing.length ? 'missing reasons: ' + missing.join(',') : 'got ' + bv.reasons.length + ' named reasons'));

    // Too many extra sliders also fails with a named reason.
    var tooMany = get('kelvin-helmholtz');
    tooMany.sliderRanges = tooMany.sliderRanges.concat([
      { key: 'x1', min: 0, max: 1, step: 0.1, label: 'x1' },
      { key: 'x2', min: 0, max: 1, step: 0.1, label: 'x2' },
      { key: 'x3', min: 0, max: 1, step: 0.1, label: 'x3' }
    ]);
    var tv = validate(tooMany);
    check('slider-cap-enforced', !tv.ok && tv.reasons.some(function (r) { return r.indexOf('TOO_MANY_SLIDERS') === 0; }),
      'extra sliders beyond 3 rejected');

    // 3. Defaults within slider ranges (re-checked independently of validate).
    var rangeBad = [];
    CONFIGS.forEach(function (c) {
      (c.sliderRanges || []).forEach(function (s) {
        var v = c.defaults[s.key];
        if (!isNum(v) || v < s.min || v > s.max) rangeBad.push(c.id + '.' + s.key);
      });
    });
    check('defaults-within-ranges', rangeBad.length === 0,
      rangeBad.length ? rangeBad.join(',') : 'all extra-slider defaults in range');

    // 4. Seeds are integers.
    var seedBad = CONFIGS.filter(function (c) { return !Number.isInteger(c.seed); })
      .map(function (c) { return c.id; });
    check('seeds-are-integers', seedBad.length === 0,
      seedBad.length ? seedBad.join(',') : CONFIGS.length + ' integer seeds');

    // 5. list()/get() contract.
    var l = list();
    check('list-get-contract',
      Array.isArray(l) && l.length === CONFIGS.length && get('karman-street') !== null && get('nope') === null,
      l.length + ' listed; get() deep-copies');

    // 6. Registry + recipe boundary flag present on every config.
    var statusBad = CONFIGS.filter(function (c) {
      return c.recipeStatus !== 'declarative-only' && c.recipeStatus !== 'reviewed';
    }).map(function (c) { return c.id; });
    check('recipe-status-flagged', statusBad.length === 0,
      statusBad.length ? statusBad.join(',') : 'all configs carry recipeStatus');

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  VORTEX.register('w04-configs', {
    selfTest: selfTest,
    list: list,
    get: get,
    validate: validate,
    resolveProbeCompat: resolveProbeCompat,
    applyConfig: applyConfig,
    coreParamRanges: function () { return JSON.parse(JSON.stringify(CORE_PARAM_RANGES)); }
  });
})(typeof window !== 'undefined' ? window : globalThis);
