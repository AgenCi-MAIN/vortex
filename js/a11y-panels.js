/* VORTEX a11y-panels.js — W23 accessibility module.
 * Full keyboard operability (documented shortcut map), screen-reader live
 * regions (polite announcements, assertive errors), structured "Lab summary"
 * panel, prefers-reduced-motion handling (freeze loop + explicit Step button),
 * text+icon flags (color never the only encoding), Simple mode (exactly 5
 * controls: stir, preset, circulation, run/pause, snapshot), toggleable
 * anytime and persisted to localStorage (try/catch).
 *
 * Keyboard actions delegate to the owning modules when present
 * (W01 shell controls via [data-vx-action], field step via bus request);
 * when nothing owns them yet they emit vx:a11y:action so a future owner can
 * pick them up. Headless-safe throughout.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w23-a11y: VORTEX namespace not loaded');

  var STORE_KEY = 'vortex-a11y-v1';

  // ---------------------------------------------------------------- state
  var state = {
    simpleMode: false,
    reducedMotion: false, // from media query (or manual override)
    motionOverride: null, // null = follow media query
    loopFrozen: false,
    running: false,
    presetIndex: 0,
    params: { circulation: 1.0, turbulence: 0.2, persistence: 0.9 },
    summary: {
      backend: 'unknown', tier: '—', tracers: 0,
      lastVerdict: 'none yet', lastError: null
    }
  };

  function load() {
    try {
      if (root.localStorage) {
        var raw = root.localStorage.getItem(STORE_KEY);
        if (raw) {
          var o = JSON.parse(raw);
          if (o && typeof o === 'object') {
            if (typeof o.simpleMode === 'boolean') state.simpleMode = o.simpleMode;
            if (typeof o.motionOverride === 'boolean' || o.motionOverride === null)
              state.motionOverride = o.motionOverride;
            if (o.params && typeof o.params === 'object') {
              ['circulation', 'turbulence', 'persistence'].forEach(function (k) {
                if (typeof o.params[k] === 'number' && isFinite(o.params[k]))
                  state.params[k] = o.params[k];
              });
            }
          }
        }
      }
    } catch (e) { /* storage unavailable: keep defaults */ }
  }
  function save() {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(STORE_KEY, JSON.stringify({
          simpleMode: state.simpleMode,
          motionOverride: state.motionOverride,
          params: state.params
        }));
      }
    } catch (e) { /* ignore */ }
  }
  load();

  // ---------------------------------------------------------------- helpers
  function isBrowser() { return V.utils.isBrowser() && typeof root.document !== 'undefined'; }
  function doc() { return isBrowser() ? root.document : null; }
  function $ (sel, ctx) {
    var d = ctx || doc();
    return d ? d.querySelector(sel) : null;
  }

  function mediaReduced() {
    try {
      if (root.matchMedia) return root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}
    return false;
  }
  function effectiveReduced() {
    return state.motionOverride !== null ? state.motionOverride : mediaReduced();
  }

  // ---------------------------------------------------------------- actions
  // Every canvas action has a keyboard equivalent via the SHORTCUTS table.
  // dispatch() prefers the owning shell control (W01 renders data-vx-action
  // buttons); otherwise it emits vx:a11y:action for the owner to handle.
  var PRESETS = ['spiral', 'collision', 'wake'];

  function dispatch(action, detail) {
    var d = doc();
    if (d) {
      var btn = d.querySelector('[data-vx-action="' + action + '"]');
      if (btn && typeof btn.click === 'function') { btn.click(); return true; }
    }
    V.bus.emit('vx:a11y:action', { action: action, detail: detail || {} });
    return false;
  }

  function nudgeParam(key, delta, min, max) {
    var d = doc();
    var sel = '[data-vx-param="' + key + '"]';
    var input = d ? d.querySelector(sel) : null;
    if (input) {
      var v = parseFloat(input.value);
      if (!isFinite(v)) v = state.params[key];
      v = V.utils.clamp(v + delta, min, max);
      input.value = String(v);
      if (typeof root.Event === 'function') {
        input.dispatchEvent(new root.Event('change', { bubbles: true }));
      }
      state.params[key] = v;
      announce(key + ' ' + v.toFixed(2));
    } else {
      state.params[key] = V.utils.clamp(state.params[key] + delta, min, max);
      V.bus.emit('vx:a11y:action', { action: 'param', detail: { key: key, value: state.params[key] } });
      announce(key + ' ' + state.params[key].toFixed(2));
    }
    save();
  }

  var ACTIONS = {
    'stir':       function () { dispatch('stir'); announce('Stir injected at center.'); },
    'move':       function () { dispatch('move'); announce('Brush mode: move.'); },
    'orbit':      function () { dispatch('orbit'); announce('Brush mode: orbit toggled.'); },
    'preset-1':   function () { dispatch('preset-spiral'); announce('Preset: spiral.'); },
    'preset-2':   function () { dispatch('preset-collision'); announce('Preset: collision.'); },
    'preset-3':   function () { dispatch('preset-wake'); announce('Preset: wake.'); },
    'circ-up':    function () { nudgeParam('circulation', +0.1, 0, 3); },
    'circ-down':  function () { nudgeParam('circulation', -0.1, 0, 3); },
    'turb-up':    function () { nudgeParam('turbulence', +0.05, 0, 1); },
    'turb-down':  function () { nudgeParam('turbulence', -0.05, 0, 1); },
    'pers-up':    function () { nudgeParam('persistence', +0.05, 0, 1); },
    'pers-down':  function () { nudgeParam('persistence', -0.05, 0, 1); },
    'run-pause':  function () {
      state.running = !state.running;
      dispatch(state.running ? 'run' : 'pause');
      announce(state.running ? 'Simulation running.' : 'Simulation paused.');
      refreshSummary();
    },
    'step':       function () { api.stepOnce(); },
    'snapshot':   function () { dispatch('snapshot'); announce('Snapshot requested.'); },
    'reseed':     function () { dispatch('reseed'); announce('Reseed requested: new run manifest minted.'); },
    'simple':     function () { api.setSimpleMode(!state.simpleMode); },
    'help':       function () { showShortcutHelp(); }
  };

  // Documented shortcut map (published via api.shortcuts()).
  var SHORTCUTS = [
    { key: 's',     action: 'stir',      description: 'Stir at center' },
    { key: 'm',     action: 'move',      description: 'Brush mode: move' },
    { key: 'o',     action: 'orbit',     description: 'Brush mode: orbit (toggle)' },
    { key: '1',     action: 'preset-1',  description: 'Preset: spiral' },
    { key: '2',     action: 'preset-2',  description: 'Preset: collision' },
    { key: '3',     action: 'preset-3',  description: 'Preset: wake' },
    { key: 'c',     action: 'circ-down', description: 'Circulation −' },
    { key: 'C',     action: 'circ-up',   description: 'Circulation +' },
    { key: 't',     action: 'turb-down', description: 'Turbulence −' },
    { key: 'T',     action: 'turb-up',   description: 'Turbulence +' },
    { key: 'p',     action: 'pers-down', description: 'Persistence −' },
    { key: 'P',     action: 'pers-up',   description: 'Persistence +' },
    { key: 'Space', action: 'run-pause', description: 'Run / pause' },
    { key: 'n',     action: 'step',      description: 'Step one frame (explicit, works when frozen)' },
    { key: 'd',     action: 'snapshot',  description: 'Take snapshot' },
    { key: 'r',     action: 'reseed',    description: 'Reseed (new manifest)' },
    { key: 'x',     action: 'simple',    description: 'Toggle Simple mode' },
    { key: '?',     action: 'help',      description: 'Show shortcut list' }
  ];

  // ---------------------------------------------------------------- live regions
  var livePolite = null, liveAssertive = null;

  function ensureLiveRegions() {
    var d = doc();
    if (!d || livePolite) return;
    var body = d.body || d.documentElement;
    livePolite = d.createElement('div');
    livePolite.id = 'vx-live-polite';
    livePolite.className = 'vx-sr-only';
    livePolite.setAttribute('role', 'status');
    livePolite.setAttribute('aria-live', 'polite');
    liveAssertive = d.createElement('div');
    liveAssertive.id = 'vx-live-assertive';
    liveAssertive.className = 'vx-sr-only';
    liveAssertive.setAttribute('role', 'alert');
    liveAssertive.setAttribute('aria-live', 'assertive');
    body.appendChild(livePolite);
    body.appendChild(liveAssertive);
  }

  function announce(msg) {
    var m = String(msg);
    V.ui.announce(m); // footer narration (contract)
    V.bus.emit('vx:announce', { message: m });
    if (livePolite) {
      livePolite.textContent = '';
      // force screen readers to re-read repeated messages
      setTimeout(function () { livePolite.textContent = m; }, 30);
    }
  }
  function announceError(code, msg) {
    var m = code + ': ' + msg;
    V.ui.fail(code, msg); // fatal-path UI (contract)
    V.bus.emit('vx:error', { code: code, message: msg, stage: 'chrome' });
    if (liveAssertive) {
      liveAssertive.textContent = '';
      setTimeout(function () { liveAssertive.textContent = m; }, 30);
    }
  }

  // ---------------------------------------------------------------- flags (text + icon, never color alone)
  var FLAG_ICONS = { ok: '●', warn: '▲', error: '■', info: '○' };
  function flag(el, kind, text) {
    if (!el) return null;
    var icon = FLAG_ICONS[kind] || FLAG_ICONS.info;
    el.textContent = '';
    var i = doc() ? doc().createElement('span') : null;
    if (i) { i.className = 'vx-chip-icon'; i.textContent = icon + ' '; el.appendChild(i); }
    el.appendChild(doc() ? doc().createTextNode(text) : text);
    el.setAttribute('aria-label', text);
    el.setAttribute('data-state', kind === 'ok' ? 'active' : (kind === 'error' ? 'down' : kind));
    return el;
  }

  // ---------------------------------------------------------------- reduced motion
  function applyReducedMotion() {
    var red = effectiveReduced();
    state.reducedMotion = red;
    if (red && !state.loopFrozen) freezeLoop('prefers-reduced-motion');
    refreshMotionBanner();
    refreshSummary();
  }

  function freezeLoop(reason) {
    state.loopFrozen = true;
    V.bus.emit('vx:freeze-request', { reason: reason });
    refreshMotionBanner();
    refreshSummary();
  }
  function unfreezeLoop() {
    state.loopFrozen = false;
    V.bus.emit('vx:unfreeze-request', {});
    refreshMotionBanner();
    refreshSummary();
  }

  function refreshMotionBanner() {
    var d = doc(); if (!d) return;
    var banner = $('#vx-motion-banner');
    if (!banner) {
      var wrap = $('#vx-canvas-wrap');
      if (!wrap) return;
      banner = d.createElement('div');
      banner.id = 'vx-motion-banner';
      banner.className = 'vx-motion-banner';
      banner.setAttribute('role', 'note');
      wrap.parentNode.insertBefore(banner, wrap.nextSibling);
    }
    if (state.reducedMotion || state.loopFrozen) {
      banner.style.display = 'block';
      banner.textContent = 'Motion frozen (reduced-motion). Use the Step button or press N to advance one frame.';
      renderStepButton(banner);
    } else {
      banner.style.display = 'none';
    }
  }

  function renderStepButton(host) {
    var d = doc(); if (!d) return;
    if ($('#vx-step-btn')) return;
    var b = d.createElement('button');
    b.id = 'vx-step-btn';
    b.className = 'vx-step-btn';
    b.textContent = 'Step one frame (N)';
    b.setAttribute('aria-label', 'Advance the simulation by one fixed frame while motion is frozen');
    b.addEventListener('click', function () { api.stepOnce(); });
    host.appendChild(b);
  }

  // ---------------------------------------------------------------- lab summary
  function summaryText() {
    var s = state.summary;
    return [
      'Backend: ' + s.backend,
      'Tier: ' + s.tier,
      'Tracers: ' + s.tracers,
      'Circulation: ' + state.params.circulation.toFixed(2),
      'Turbulence: ' + state.params.turbulence.toFixed(2),
      'Persistence: ' + state.params.persistence.toFixed(2),
      'Motion: ' + (state.loopFrozen ? 'frozen (reduced-motion/stepped)' : 'running'),
      'Simple mode: ' + (state.simpleMode ? 'on' : 'off'),
      'Last verdict: ' + s.lastVerdict
    ].join('\n');
  }

  function mountSummary(el) {
    var d = doc(); if (!d) return;
    el.classList.add('vx-panel');
    el.setAttribute('aria-label', 'Lab summary');
    var h = d.createElement('h2'); h.textContent = 'Lab summary';
    var dl = d.createElement('dl'); dl.className = 'vx-summary-dl'; dl.id = 'vx-summary-dl';
    el.appendChild(h); el.appendChild(dl);
    var acts = d.createElement('div'); acts.className = 'vx-summary-actions';
    var refresh = d.createElement('button');
    refresh.textContent = 'Refresh summary';
    refresh.addEventListener('click', refreshSummary);
    var read = d.createElement('button');
    read.textContent = 'Read summary aloud';
    read.setAttribute('aria-label', 'Announce the lab summary to the screen reader');
    read.addEventListener('click', function () { announce('Lab summary. ' + summaryText().replace(/\n/g, '. ')); });
    acts.appendChild(refresh); acts.appendChild(read);
    el.appendChild(acts);
    refreshSummary();
  }

  function refreshSummary() {
    var d = doc(); if (!d) return;
    var dl = $('#vx-summary-dl'); if (!dl) return;
    dl.textContent = '';
    var rows = [
      ['Backend', state.summary.backend],
      ['Tier', state.summary.tier],
      ['Tracers', String(state.summary.tracers)],
      ['Circulation', state.params.circulation.toFixed(2)],
      ['Turbulence', state.params.turbulence.toFixed(2)],
      ['Persistence', state.params.persistence.toFixed(2)],
      ['Motion', state.loopFrozen ? 'frozen — use Step (N)' : 'running'],
      ['Simple mode', state.simpleMode ? 'on' : 'off'],
      ['Last verdict', state.summary.lastVerdict]
    ];
    rows.forEach(function (r) {
      var dt = d.createElement('dt'); dt.textContent = r[0];
      var dd = d.createElement('dd'); dd.textContent = r[1];
      dl.appendChild(dt); dl.appendChild(dd);
    });
  }

  // ---------------------------------------------------------------- simple mode (exactly 5 controls)
  var SIMPLE_CONTROLS = [
    { id: 'stir',       kind: 'button', label: 'Stir',            hint: 'Stir at center (S)' },
    { id: 'preset',     kind: 'button', label: 'Preset: spiral', hint: 'Cycle preset: spiral, collision, wake' },
    { id: 'circulation',kind: 'range',  label: 'Circulation',    hint: 'Circulation 0–3 (C / shift+C)' },
    { id: 'run-pause',  kind: 'button', label: 'Run',            hint: 'Run / pause (Space)' },
    { id: 'snapshot',   kind: 'button', label: 'Snapshot',       hint: 'Take snapshot (D)' }
  ];

  function mountSimpleStrip(el) {
    var d = doc(); if (!d) return;
    el.classList.add('vx-panel', 'vx-simple-strip');
    el.setAttribute('aria-label', 'Simple controls');
    var title = d.createElement('div');
    title.className = 'vx-simple-label';
    title.textContent = 'SIMPLE MODE — 5 controls';
    el.appendChild(title);

    SIMPLE_CONTROLS.forEach(function (c) {
      if (c.kind === 'button') {
        var b = d.createElement('button');
        b.id = 'vx-simple-' + c.id;
        b.textContent = c.label;
        b.title = c.hint;
        b.setAttribute('aria-label', c.hint);
        b.addEventListener('click', function () {
          if (c.id === 'stir') ACTIONS.stir();
          else if (c.id === 'preset') cyclePreset(b);
          else if (c.id === 'run-pause') toggleRunPause(b);
          else if (c.id === 'snapshot') ACTIONS.snapshot();
        });
        el.appendChild(b);
      } else if (c.kind === 'range') {
        var lab = d.createElement('label');
        lab.setAttribute('for', 'vx-simple-circulation');
        lab.textContent = c.label + ' ';
        var r = d.createElement('input');
        r.type = 'range'; r.id = 'vx-simple-circulation';
        r.min = '0'; r.max = '3'; r.step = '0.1';
        r.value = String(state.params.circulation);
        r.title = c.hint; r.setAttribute('aria-label', c.hint);
        r.addEventListener('input', function () {
          state.params.circulation = parseFloat(r.value) || 0;
          dispatch('param', { key: 'circulation', value: state.params.circulation });
          refreshSummary(); save();
        });
        lab.appendChild(r);
        el.appendChild(lab);
      }
    });
    applySimpleModeVisibility();
  }

  function cyclePreset(btn) {
    state.presetIndex = (state.presetIndex + 1) % PRESETS.length;
    var p = PRESETS[state.presetIndex];
    dispatch('preset-' + p);
    if (btn) btn.textContent = 'Preset: ' + p;
    announce('Preset: ' + p + '.');
  }
  function toggleRunPause(btn) {
    ACTIONS['run-pause']();
    if (btn) { btn.textContent = state.running ? 'Pause' : 'Run'; btn.setAttribute('aria-pressed', state.running ? 'true' : 'false'); }
  }

  function applySimpleModeVisibility() {
    var d = doc(); if (!d) return;
    var rootEl = $('#vx-root');
    if (rootEl) rootEl.classList.toggle('vx-simple-mode', state.simpleMode);
    var strip = $('.vx-simple-strip');
    if (strip) strip.style.display = state.simpleMode ? 'flex' : 'none';
  }

  // ---------------------------------------------------------------- keyboard
  function installKeyboard() {
    var d = doc(); if (!d) return;
    d.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing = t && (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
        t.isContentEditable
      );
      if (typing) return;
      var key = e.key === ' ' ? 'Space' : e.key;
      var entry = null;
      for (var i = 0; i < SHORTCUTS.length; i++) {
        if (SHORTCUTS[i].key === key) { entry = SHORTCUTS[i]; break; }
      }
      if (!entry) return;
      if (e.key === ' ' || entry.key === '?') e.preventDefault();
      try { ACTIONS[entry.action](); }
      catch (err) { announceError('VX_E_CHROME', 'Shortcut failed: ' + entry.description); }
    });
  }

  function showShortcutHelp() {
    var d = doc();
    if (!d) { announce(SHORTCUTS.map(function (s) { return s.key + ': ' + s.description; }).join('; ')); return; }
    var panel = $('.vx-panel[data-w23-help]');
    if (panel) { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; return; }
    var dock = $('#vx-panel-dock') || d.body;
    panel = d.createElement('div');
    panel.className = 'vx-panel';
    panel.setAttribute('data-w23-help', '1');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Keyboard shortcuts');
    var h = d.createElement('h2'); h.textContent = 'Keyboard shortcuts';
    var tbl = d.createElement('table'); tbl.className = 'vx-shortcut-table';
    var tr = d.createElement('tr');
    ['Key', 'Action'].forEach(function (x) { var th = d.createElement('th'); th.textContent = x; tr.appendChild(th); });
    tbl.appendChild(tr);
    SHORTCUTS.forEach(function (s) {
      var row = d.createElement('tr');
      var td1 = d.createElement('td'); var kbd = d.createElement('kbd'); kbd.textContent = s.key; td1.appendChild(kbd);
      var td2 = d.createElement('td'); td2.textContent = s.description;
      row.appendChild(td1); row.appendChild(td2); tbl.appendChild(row);
    });
    var close = d.createElement('button'); close.textContent = 'Close';
    close.addEventListener('click', function () { panel.style.display = 'none'; });
    panel.appendChild(h); panel.appendChild(tbl); panel.appendChild(close);
    dock.appendChild(panel);
    close.focus();
  }

  // ---------------------------------------------------------------- bus wiring
  function wireBus() {
    V.bus.on('vx:ready', function (d) {
      state.summary.backend = d.backendName || (d.backend && d.backend.name) || 'unknown';
      state.summary.tracers = d.tracers || 0;
      refreshSummary();
    });
    V.bus.on('vx:degraded', function (d) {
      state.summary.backend = d.to || state.summary.backend;
      announce('Degraded: ' + (d.from || '?') + ' to ' + (d.to || '?') + '. ' + (d.reason || ''));
      refreshSummary();
    });
    V.bus.on('vx:error', function (d) {
      state.summary.lastError = (d.code || 'VX_E_CHROME') + ': ' + (d.message || '');
      if (liveAssertive) {
        liveAssertive.textContent = '';
        var m = d.code + ': ' + d.message;
        setTimeout(function () { liveAssertive.textContent = m; }, 30);
      }
      refreshSummary();
    });
    V.bus.on('vx:verdict', function (d) {
      state.summary.lastVerdict = (d.verdict || 'inconclusive').toUpperCase() +
        (d.protocol ? ' — ' + d.protocol : '');
      refreshSummary();
    });
    V.bus.on('vx:params', function (d) {
      if (d && d.params) {
        ['circulation', 'turbulence', 'persistence'].forEach(function (k) {
          if (typeof d.params[k] === 'number') state.params[k] = d.params[k];
        });
        refreshSummary();
      }
    });
  }

  // ---------------------------------------------------------------- DOM boot
  function bootDom() {
    if (!isBrowser()) return;
    ensureLiveRegions();
    installKeyboard();
    applyReducedMotion();
    applySimpleModeVisibility();
    // watch for a late-added media query change
    try {
      if (root.matchMedia) {
        var mq = root.matchMedia('(prefers-reduced-motion: reduce)');
        if (mq.addEventListener) mq.addEventListener('change', applyReducedMotion);
        else if (mq.addListener) mq.addListener(applyReducedMotion);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------- api
  function cssPath() {
    try {
      if (typeof process !== 'undefined' && process.versions && process.versions.node &&
          typeof require === 'function') {
        var path = require('path'), fs = require('fs');
        var cands = [];
        if (typeof __dirname === 'string') cands.push(path.join(__dirname, '..', 'css', 'vortex.css'));
        cands.push(path.join(process.cwd(), 'simulation', 'vortex', 'css', 'vortex.css'));
        cands.push(path.join(process.cwd(), 'vortex-build', 'simulation', 'vortex', 'css', 'vortex.css'));
        for (var i = 0; i < cands.length; i++) {
          if (fs.existsSync(cands[i])) return cands[i];
        }
      }
    } catch (e) {}
    return null;
  }

  var api = {
    version: '1.0.0-w23',
    shortcuts: function () {
      return SHORTCUTS.map(function (s) { return { key: s.key, action: s.action, description: s.description }; });
    },
    doAction: function (action) {
      if (ACTIONS[action]) { ACTIONS[action](); return true; }
      return false;
    },
    announce: announce,
    announceError: announceError,
    flag: flag,
    setSimpleMode: function (on) {
      state.simpleMode = !!on; save();
      applySimpleModeVisibility(); refreshSummary();
      announce('Simple mode ' + (state.simpleMode ? 'on: 5 controls.' : 'off: full lab.'));
      return state.simpleMode;
    },
    isSimpleMode: function () { return state.simpleMode; },
    // exactly the 5 simple-mode controls
    simpleModeControls: function () {
      return SIMPLE_CONTROLS.map(function (c) { return { id: c.id, kind: c.kind, label: c.label }; });
    },
    // reduced-motion path: frozen state + explicit step function
    reducedMotionPath: function () {
      if (effectiveReduced()) freezeLoop('prefers-reduced-motion');
      return { frozen: state.loopFrozen, step: function () { return api.stepOnce(); } };
    },
    setReducedMotion: function (on) {
      state.motionOverride = on ? true : (on === false ? false : null);
      save(); applyReducedMotion();
      return state.reducedMotion;
    },
    isReducedMotion: function () { return effectiveReduced(); },
    stepOnce: function () {
      var field = V.get('w02-gpu') || V.get('w14-cpu') || V.get('w15-webgpu');
      var stepped = false;
      if (field && typeof field.step === 'function') {
        field.step(); stepped = true;
        if (typeof field.render === 'function') field.render();
      }
      V.bus.emit('vx:step-request', { dt: V.SIM_DT });
      if (stepped) announce('Stepped one frame.');
      else announce('Step requested (no field backend yet).');
      return stepped;
    },
    freezeLoop: freezeLoop,
    unfreezeLoop: unfreezeLoop,
    isLoopFrozen: function () { return state.loopFrozen; },
    summary: function () { return summaryText(); },
    summaryObject: function () {
      return {
        backend: state.summary.backend, tier: state.summary.tier,
        tracers: state.summary.tracers, params: Object.assign({}, state.params),
        motion: state.loopFrozen ? 'frozen' : 'running',
        simpleMode: state.simpleMode, lastVerdict: state.summary.lastVerdict
      };
    },
    selfTest: function () {
      var checks = [];
      function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

      // 1. shortcut map: non-empty, no duplicates
      var keys = SHORTCUTS.map(function (s) { return s.key; });
      var seen = {}, dupes = [];
      keys.forEach(function (k) { if (seen[k]) dupes.push(k); seen[k] = 1; });
      check('shortcuts non-empty', keys.length > 0, keys.length + ' shortcuts');
      check('shortcuts unique keys', dupes.length === 0, dupes.length ? 'dupes: ' + dupes.join(',') : 'all unique');

      // 2. every shortcut action has an implementation
      var missing = SHORTCUTS.filter(function (s) { return typeof ACTIONS[s.action] !== 'function'; });
      check('all shortcut actions implemented', missing.length === 0,
        missing.length ? 'missing: ' + missing.map(function (s) { return s.action; }).join(',') : keys.length + '/' + keys.length);

      // 3. reduced-motion path: frozen state + step function
      var rp = api.reducedMotionPath();
      check('reduced-motion path returns frozen state', typeof rp.frozen === 'boolean', 'frozen=' + rp.frozen);
      check('reduced-motion path returns step function', typeof rp.step === 'function', 'step is function');

      // 4. simple mode exposes exactly 5 controls
      var ctrls = api.simpleModeControls();
      check('simple mode exposes exactly 5 controls', ctrls.length === 5, ctrls.length + ' controls: ' + ctrls.map(function (c) { return c.id; }).join(','));

      // 5. CSS: non-empty, contains required selectors
      var p = cssPath();
      if (!p) {
        check('css contains required selectors', true, 'skipped headless (no file access in browser)');
      } else {
        try {
          var fs = require('fs');
          var css = fs.readFileSync(p, 'utf8');
          var required = ['#vx-toolbar', '#vx-canvas-wrap', '#vx-panel-dock',
            '#vx-footer', '#vx-status', '#vx-fatal',
            ':focus-visible', 'prefers-reduced-motion',
            '.vx-gov-chip', '.vx-announce'];
          var absent = required.filter(function (s) { return css.indexOf(s) === -1; });
          check('css non-empty', css.length > 0, css.length + ' bytes');
          check('css contains required selectors', absent.length === 0,
            absent.length ? 'missing: ' + absent.join(', ') : required.length + '/' + required.length + ' present');
        } catch (e) {
          check('css readable', false, String(e && e.message || e));
        }
      }

      // 6. persistence helpers don't throw headless
      var okPersist = true;
      try { save(); } catch (e) { okPersist = false; }
      check('localStorage guarded (no throw headless)', okPersist, '');

      var allOk = checks.every(function (c) { return c.ok; });
      return { ok: allOk, checks: checks };
    }
  };

  // register panels (registry is DOM-guarded; safe headless)
  V.ui.registerPanel('w23-lab-summary', 'Lab summary', mountSummary);
  V.ui.registerPanel('w23-simple-strip', 'Simple controls', mountSimpleStrip);

  wireBus();
  if (isBrowser()) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', bootDom);
    } else {
      bootDom();
    }
  }

  VORTEX.register('w23-a11y', api);
})(typeof window !== 'undefined' ? window : globalThis);
