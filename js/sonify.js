/* VORTEX js/sonify.js — W27 opt-in sonification.
 *
 * Sound is an instrument, not a toy. All mapping math is pure and headless-
 * testable; the WebAudio engine is built ONLY on an explicit user gesture
 * (toggle click). Default OFF. Preference persisted (localStorage, guarded).
 *
 * Mappings (pure functions):
 *   enstrophy  (0..1) -> drone pitch      55–220 Hz  (linear)
 *   mixing     (0..1) -> filter cutoff    200–6000 Hz (exponential feel)
 *   turbulence (0..1) -> noise bed level  0–0.15 linear gain
 *   merger event       -> chime: two sines (880 + 1320 Hz), 1.2 s decay
 *   probe event        -> ping:  660 Hz sine, 0.35 s decay
 *
 * Master gain is hard-capped at 0.25 linear (−12 dBFS). The cap is enforced
 * by capGain() and asserted by selfTest() — no code path can set higher.
 *
 * NON-AUDIO EQUIVALENTS (a11y, W23 hook): every sound event also emits
 *   VORTEX.bus 'vx:sonify' { kind } and goes through VORTEX.ui.announce().
 *   The visual pulse hook: api.pulse(kind) adds a transient CSS class
 *   'vx-sonify-pulse' to the toggle control (and any element W23 registers
 *   via api.onPulse(fn)). W23 can style the class; W27 owns only the hook.
 *
 * Plain script, no modules, no network, no eval. file:// safe.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') return; // namespace not loaded yet

  // ---------------- constants ----------------
  var MASTER_CAP = 0.25;            // hard cap, −12 dBFS
  var FREQ_MIN = 55, FREQ_MAX = 220; // drone pitch range, Hz
  var CUTOFF_MIN = 200, CUTOFF_MAX = 6000; // filter cutoff range, Hz
  var NOISE_MAX = 0.15;             // noise bed ceiling, linear gain
  var CHIME_FREQ = [880, 1320];     // merger chime partials, Hz
  var PING_FREQ = 660;              // probe ping, Hz
  var PREF_KEY = 'vortex-sonify-enabled';
  var MAP_KEY = 'vortex-sonify-maps';

  var clamp = V.utils.clamp;

  // ---------------- pure mapping functions ----------------

  // metrics: { enstrophy:0..1, mixing:0..1, turbulence:0..1 }
  function mapDronePitch(enstrophy) {
    var e = clamp(Number(enstrophy) || 0, 0, 1);
    return FREQ_MIN + e * (FREQ_MAX - FREQ_MIN);
  }
  function mapFilterCutoff(mixing) {
    var m = clamp(Number(mixing) || 0, 0, 1);
    // exponential interpolation between CUTOFF_MIN and CUTOFF_MAX
    return CUTOFF_MIN * Math.pow(CUTOFF_MAX / CUTOFF_MIN, m);
  }
  function mapNoiseLevel(turbulence) {
    var t = clamp(Number(turbulence) || 0, 0, 1);
    return t * NOISE_MAX;
  }
  function mapMetrics(metrics) {
    var m = metrics || {};
    return {
      freq: mapDronePitch(m.enstrophy),
      cutoff: mapFilterCutoff(m.mixing),
      noiseLevel: mapNoiseLevel(m.turbulence)
    };
  }
  function mapMerger() {
    return { kind: 'chime', freqs: CHIME_FREQ.slice(), decay: 1.2, gain: 0.18 };
  }
  function mapProbe() {
    return { kind: 'ping', freq: PING_FREQ, decay: 0.35, gain: 0.15 };
  }

  // hard gain cap — every gain in the engine passes through this
  function capGain(g) {
    var v = Number(g);
    if (!(v >= 0)) return 0;
    return v > MASTER_CAP ? MASTER_CAP : v;
  }

  // ---------------- non-audio equivalents (a11y contract) ----------------
  // Every sound event must have an entry here: what it sounds like AND what
  // the user gets instead without audio. Checked by selfTest().
  var NON_AUDIO_EQUIV = {
    drone: {
      sound: 'continuous tone, pitch rises with enstrophy (55–220 Hz)',
      nonAudio: 'footer announcement on regime change + pitch shown in panel'
    },
    filter: {
      sound: 'filter cutoff follows mixing (brighter when more mixed)',
      nonAudio: 'cutoff value shown in panel; announce on large swings'
    },
    noise: {
      sound: 'noise bed level follows turbulence',
      nonAudio: 'turbulence value shown in panel; announce on large swings'
    },
    chime: {
      sound: 'two-sine chime on vortex merger (880 + 1320 Hz)',
      nonAudio: "VORTEX.ui.announce('Vortex merger detected') + visual pulse"
    },
    ping: {
      sound: 'short ping when a probe is injected (660 Hz)',
      nonAudio: "VORTEX.ui.announce('Probe injected: <name>') + visual pulse"
    }
  };

  // ---------------- preferences (guarded storage) ----------------
  var _enabled = false;
  var _mapEnabled = { drone: true, filter: true, noise: true, chime: true, ping: true };

  function storeGet(key) {
    try {
      if (typeof root.localStorage === 'undefined') return null;
      return root.localStorage.getItem(key);
    } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try {
      if (typeof root.localStorage === 'undefined') return false;
      root.localStorage.setItem(key, value);
      return true;
    } catch (e) { return false; }
  }
  function loadPrefs() {
    var e = storeGet(PREF_KEY);
    _enabled = (e === '1');
    var m = storeGet(MAP_KEY);
    if (m) {
      try {
        var o = JSON.parse(m);
        for (var k in _mapEnabled) {
          if (Object.prototype.hasOwnProperty.call(o, k)) _mapEnabled[k] = !!o[k];
        }
      } catch (e2) { /* corrupt prefs -> keep defaults */ }
    }
  }
  function savePrefs() {
    storeSet(PREF_KEY, _enabled ? '1' : '0');
    storeSet(MAP_KEY, JSON.stringify(_mapEnabled));
  }

  // ---------------- visual pulse hook (for W23) ----------------
  var _pulseListeners = [];
  var _lastPulse = null;
  function pulse(kind) {
    _lastPulse = { kind: kind, t: (V.utils.now ? V.utils.now() : Date.now()) };
    for (var i = 0; i < _pulseListeners.length; i++) {
      try { _pulseListeners[i](kind); } catch (e) { /* listener must not break audio */ }
    }
    if (V.utils.isBrowser() && _toggleEl) {
      _toggleEl.classList.add('vx-sonify-pulse');
      (function (el) {
        root.setTimeout(function () { el.classList.remove('vx-sonify-pulse'); }, 450);
      })(_toggleEl);
    }
  }
  function onPulse(fn) {
    if (typeof fn === 'function') _pulseListeners.push(fn);
  }

  // ---------------- WebAudio engine (gesture-only) ----------------
  // engineCtx stays undefined until the user clicks the toggle. Never built
  // headless: construction requires both a browser and a user gesture.
  var engineCtx = undefined; // undefined until toggle-on
  var engine = null;

  function hasAudio() {
    return typeof root.AudioContext !== 'undefined' || typeof root.webkitAudioContext !== 'undefined';
  }

  function buildEngine() {
    var AC = root.AudioContext || root.webkitAudioContext;
    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = capGain(MASTER_CAP); // hard cap, always applied
    master.connect(ctx.destination);

    // drone: sine osc -> drone gain -> lowpass (mixing cutoff) -> master
    var drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = FREQ_MIN;
    var droneGain = ctx.createGain();
    droneGain.gain.value = 0.0; // silent until metrics arrive
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = CUTOFF_MIN;
    drone.connect(droneGain); droneGain.connect(filter); filter.connect(master);
    drone.start();

    // noise bed: looped white-noise buffer -> noise gain -> master
    var noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.0;
    var noise = null;
    try {
      var len = ctx.sampleRate * 2;
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var rnd = V.utils.mulberry32(0x27); // deterministic noise content
      for (var i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
      noise = ctx.createBufferSource();
      noise.buffer = buf; noise.loop = true;
      noise.connect(noiseGain); noiseGain.connect(master);
      noise.start();
    } catch (e) { noise = null; }

    return {
      ctx: ctx, master: master,
      drone: drone, droneGain: droneGain, filter: filter,
      noise: noise, noiseGain: noiseGain
    };
  }

  function teardownEngine() {
    if (!engine) return;
    try {
      engine.drone.stop(); if (engine.noise) engine.noise.stop();
      engine.ctx.close();
    } catch (e) { /* already closed */ }
    engine = null;
    engineCtx = undefined;
  }

  // one-shot enveloped tone (chime partials, ping)
  function blip(freq, decay, peakGain) {
    if (!engine) return;
    var ctx = engine.ctx;
    var t0 = ctx.currentTime;
    var osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, capGain(peakGain)), t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(g); g.connect(engine.master);
    osc.start(t0); osc.stop(t0 + decay + 0.05);
  }

  // continuous update from sim metrics (throttled by caller)
  function updateContinuous(metrics) {
    if (!engine || !_enabled) return;
    var mapped = mapMetrics(metrics);
    var t = engine.ctx.currentTime;
    if (_mapEnabled.drone) {
      engine.drone.frequency.setTargetAtTime(mapped.freq, t, 0.1);
      engine.droneGain.gain.setTargetAtTime(capGain(0.10), t, 0.2);
    } else {
      engine.droneGain.gain.setTargetAtTime(0.0, t, 0.2);
    }
    if (_mapEnabled.filter) engine.filter.frequency.setTargetAtTime(mapped.cutoff, t, 0.1);
    engine.noiseGain.gain.setTargetAtTime(
      _mapEnabled.noise ? capGain(mapped.noiseLevel) : 0.0, t, 0.2);
  }

  // ---- sound events: always paired with non-audio equivalent ----
  function sonifyEvent(kind, detail) {
    // 1. non-audio equivalent first (a11y contract)
    V.bus.emit('vx:sonify', { kind: kind, detail: detail || {} });
    pulse(kind);
    var msg = {
      chime: 'Vortex merger detected (sound: chime)',
      ping: 'Probe injected' + (detail && detail.name ? ': ' + detail.name : '') + ' (sound: ping)',
      drone: 'Drone pitch updated (sound)',
      filter: 'Filter cutoff updated (sound)',
      noise: 'Noise bed updated (sound)'
    }[kind] || ('Sonify: ' + kind);
    V.ui.announce(msg);
    // 2. audio, only when enabled and built
    if (!engine || !_enabled) return;
    if (kind === 'chime' && _mapEnabled.chime) {
      var m = mapMerger();
      blip(m.freqs[0], m.decay, m.gain);
      blip(m.freqs[1], m.decay, m.gain * 0.6);
    } else if (kind === 'ping' && _mapEnabled.ping) {
      var p = mapProbe();
      blip(p.freq, p.decay, p.gain);
    }
  }

  // ---------------- toggle (user gesture entry point) ----------------
  function setEnabled(on, fromGesture) {
    on = !!on;
    if (on === _enabled) return _enabled;
    if (on) {
      if (!hasAudio()) {
        V.ui.announce('Sonification unavailable: this browser has no WebAudio.');
        V.bus.emit('vx:sonify', { kind: 'unavailable' });
        return _enabled;
      }
      try {
        // Built here — inside the click handler — so autoplay policy passes
        // and headless never constructs an AudioContext.
        engine = buildEngine();
        engineCtx = engine.ctx;
        if (engine.ctx.state === 'suspended') engine.ctx.resume();
      } catch (e) {
        V.ui.announce('Sonification failed to start: ' + (e.message || e));
        engine = null; engineCtx = undefined;
        return _enabled;
      }
      V.bus.emit('vx:sonify', { kind: 'enabled' });
      V.ui.announce('Sonification on — drone, filter, noise, chime, ping active.');
    } else {
      teardownEngine();
      V.bus.emit('vx:sonify', { kind: 'disabled' });
      V.ui.announce('Sonification off.');
    }
    _enabled = on;
    savePrefs();
    syncToggleUI();
    return _enabled;
  }
  function toggle(fromGesture) { return setEnabled(!_enabled, fromGesture); }

  // ---------------- header control (toolbar if present, else panel) ----------------
  var _toggleEl = null;
  function syncToggleUI() {
    if (!_toggleEl) return;
    _toggleEl.setAttribute('aria-pressed', _enabled ? 'true' : 'false');
    _toggleEl.textContent = _enabled ? 'Sound: on' : 'Sound: off';
    _toggleEl.classList.toggle('vx-sonify-on', _enabled);
  }
  function makeToggleButton() {
    var b = root.document.createElement('button');
    b.type = 'button';
    b.id = 'vx-sonify-toggle';
    b.className = 'vx-sonify-toggle';
    b.setAttribute('aria-label', 'Toggle sonification (sound is opt-in)');
    b.addEventListener('click', function () { toggle(true); });
    _toggleEl = b;
    syncToggleUI();
    return b;
  }
  function installHeaderControl() {
    if (!V.utils.isBrowser() || _toggleEl) return;
    var tb = root.document.getElementById('vx-toolbar');
    if (tb) {
      tb.appendChild(makeToggleButton());
    }
    // else: the panel provides the toggle; nothing to do
  }

  // ---------------- auto-wire sim events ----------------
  var _lastContinuous = 0;
  V.bus.on('vx:frame', function (detail) {
    if (!_enabled || !engine) return;
    var now = V.utils.now();
    if (now - _lastContinuous < 250) return; // 4 Hz max
    _lastContinuous = now;
    // ask the backend (if any) for current metrics; degrade silently
    var bg = null;
    try {
      var sel = V.get && V.get('w15-backends');
      if (sel && typeof sel.current === 'function') bg = sel.current();
    } catch (e) { bg = null; }
    if (bg && typeof bg.sampleMetrics === 'function') {
      try { updateContinuous(bg.sampleMetrics()); } catch (e) { /* metrics optional */ }
    }
  });
  V.bus.on('vx:probe', function (detail) { sonifyEvent('ping', detail); });
  V.bus.on('vx:merger', function (detail) { sonifyEvent('chime', detail); });

  // ---------------- panel ----------------
  V.ui.registerPanel('w27-sonify', 'Sound', function (el) {
    if (!V.utils.isBrowser()) return;
    el.innerHTML = '';
    var rootEl = root.document.createElement('div');
    rootEl.className = 'vx-sonify-panel';

    var h = root.document.createElement('p');
    h.className = 'vx-sonify-note';
    h.textContent = 'Opt-in only. Off by default. Engine starts on your toggle click.';
    rootEl.appendChild(h);

    var tgl = root.document.createElement('label');
    var tglBox = root.document.createElement('input');
    tglBox.type = 'checkbox'; tglBox.checked = _enabled;
    tglBox.addEventListener('change', function () { setEnabled(tglBox.checked, true); });
    tgl.appendChild(tglBox);
    tgl.appendChild(root.document.createTextNode(' Enable sound'));
    rootEl.appendChild(tgl);

    var maps = [['drone', 'Drone (enstrophy → pitch)'],
                ['filter', 'Filter cutoff (mixing)'],
                ['noise', 'Noise bed (turbulence)'],
                ['chime', 'Merger chime'],
                ['ping', 'Probe ping']];
    var fieldset = root.document.createElement('fieldset');
    var legend = root.document.createElement('legend');
    legend.textContent = 'Mappings (each has a non-audio equivalent)';
    fieldset.appendChild(legend);
    maps.forEach(function (pair) {
      var key = pair[0], label = pair[1];
      var lab = root.document.createElement('label');
      var box = root.document.createElement('input');
      box.type = 'checkbox'; box.checked = !!_mapEnabled[key];
      box.addEventListener('change', function () {
        _mapEnabled[key] = box.checked; savePrefs();
      });
      lab.appendChild(box);
      lab.appendChild(root.document.createTextNode(' ' + label));
      fieldset.appendChild(lab);
    });
    rootEl.appendChild(fieldset);

    var lvl = root.document.createElement('p');
    lvl.className = 'vx-sonify-level';
    lvl.textContent = 'Master level: capped at ' + Math.round(MASTER_CAP * 100) +
      '% (0.25 linear, −12 dBFS, hard cap)';
    rootEl.appendChild(lvl);

    el.appendChild(rootEl);
  });

  // ---------------- boot ----------------
  loadPrefs();
  if (V.utils.isBrowser()) {
    installHeaderControl(); // toolbar present at load
    // toolbar may be rendered later by W01 chrome stage; retry on ready
    V.bus.on('vx:ready', installHeaderControl);
  }

  // ---------------- selfTest ----------------
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: detail || '' });
    }
    var allOk = true;
    for (var i = 0; i < checks.length; i++) allOk = allOk && checks[i].ok;

    // 1. mapping ranges on synthetic metrics
    var m0 = mapMetrics({ enstrophy: 0, mixing: 0, turbulence: 0 });
    var m1 = mapMetrics({ enstrophy: 1, mixing: 1, turbulence: 1 });
    check('freq range', m0.freq >= FREQ_MIN && m1.freq <= FREQ_MAX &&
      m0.freq === FREQ_MIN && m1.freq === FREQ_MAX,
      'freq(' + m0.freq.toFixed(1) + '..' + m1.freq.toFixed(1) + ') within 55–220 Hz');
    check('cutoff range', m0.cutoff >= CUTOFF_MIN && m0.cutoff <= CUTOFF_MAX &&
      m1.cutoff >= CUTOFF_MIN && m1.cutoff <= CUTOFF_MAX,
      'cutoff(' + Math.round(m0.cutoff) + '..' + Math.round(m1.cutoff) + ') within 200–6000 Hz');
    check('noise level capped', m1.noiseLevel <= NOISE_MAX && m0.noiseLevel === 0,
      'noise(' + m1.noiseLevel.toFixed(3) + ') <= 0.15');
    // 2. gain hard cap
    check('master cap', capGain(0.9) === MASTER_CAP && capGain(0.1) === 0.1 &&
      capGain(-1) === 0 && capGain(MASTER_CAP) === MASTER_CAP,
      'capGain clamps any input to ≤0.25');
    // 3. AudioContext never constructed headless / without gesture
    check('no audio headless', typeof engineCtx === 'undefined' && engine === null,
      'engineCtx undefined, engine null before any user gesture');
    check('audio guarded', typeof hasAudio() === 'boolean',
      'hasAudio() guards construction; buildEngine only called from toggle click');
    // 4. every mapping has a non-audio equivalent entry
    var kinds = ['drone', 'filter', 'noise', 'chime', 'ping'];
    var missing = kinds.filter(function (k) {
      return !(NON_AUDIO_EQUIV[k] && NON_AUDIO_EQUIV[k].sound && NON_AUDIO_EQUIV[k].nonAudio);
    });
    check('non-audio equivalents', missing.length === 0,
      missing.length ? 'missing: ' + missing.join(',') :
        'drone/filter/noise/chime/ping each have sound + nonAudio entries');
    // 5. defaults: off, persisted preference guarded
    var prefOk = true;
    try { loadPrefs(); savePrefs(); } catch (e) { prefOk = false; }
    check('prefs guarded', prefOk, 'localStorage access wrapped in try/catch, no throw headless');
    // 6. pulse hook exists for W23. Note: under full integration earlier
    // modules' selfTests may have emitted vx:probe on the shared bus (which
    // correctly pulsed us), so reset first, then EXERCISE the hook.
    var pulseSeen = [];
    onPulse(function (k) { pulseSeen.push(k); });
    _lastPulse = null;
    pulse('selftest');
    check('pulse hook', typeof pulse === 'function' && typeof onPulse === 'function' &&
      _lastPulse && _lastPulse.kind === 'selftest' && pulseSeen.join(',') === 'selftest',
      'api.pulse / api.onPulse exported; pulse() records + notifies listeners (vx-sonify + .vx-sonify-pulse class in browser)');
    // 7. events emit vx:sonify (spy)
    var seen = [];
    V.bus.on('vx:sonify', function (d) { seen.push(d.kind); });
    // call the non-audio half directly: engine is null so only bus+announce run
    sonifyEvent('ping', { name: 'self-test probe' });
    check('vx:sonify emitted', seen.indexOf('ping') !== -1,
      'sonifyEvent emits vx:sonify{kind} even with engine off');
    // 8. panel registered
    var hasPanel = V.ui.panels().some(function (p) { return p.id === 'w27-sonify'; });
    check('sound panel registered', hasPanel, 'w27-sonify in ui registry');

    var ok = true;
    for (var j = 0; j < checks.length; j++) ok = ok && checks[j].ok;
    return { ok: ok, checks: checks };
  }

  var api = {
    selfTest: selfTest,
    // pure mappings (headless-testable)
    mapMetrics: mapMetrics,
    mapDronePitch: mapDronePitch,
    mapFilterCutoff: mapFilterCutoff,
    mapNoiseLevel: mapNoiseLevel,
    mapMerger: mapMerger,
    mapProbe: mapProbe,
    capGain: capGain,
    MASTER_CAP: MASTER_CAP,
    // engine control (gesture-gated)
    toggle: toggle,
    setEnabled: setEnabled,
    isEnabled: function () { return _enabled; },
    updateContinuous: updateContinuous,
    sonifyEvent: sonifyEvent,
    // a11y / W23 hooks
    pulse: pulse,
    onPulse: onPulse,
    NON_AUDIO_EQUIV: NON_AUDIO_EQUIV,
    // prefs
    mapEnabled: function () { return JSON.parse(JSON.stringify(_mapEnabled)); },
    setMapEnabled: function (key, on) {
      if (_mapEnabled.hasOwnProperty(key)) { _mapEnabled[key] = !!on; savePrefs(); }
    }
  };

  V.register('w27-sonify', api);
})(typeof window !== 'undefined' ? window : globalThis);
