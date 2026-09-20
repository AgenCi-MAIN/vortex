/* VORTEX onboarding.js — W29: 5-minute first-run arc.
 *
 * Five steps: stir -> slider -> probe -> scorecard -> snapshot. Each step
 * completes automatically when its bus event fires. Guidance is delivered as
 * NON-MODAL hint chips (never alert/confirm/prompt, never a blocking overlay):
 * chips are pure data + a pointer-events-limited DOM renderer, dismissable via
 * (x), resumable from a "Tour" button, and dismissal persists in localStorage
 * (always guarded in try/catch).
 *
 * After the scorecard step the "aha moment" fires: if W09 teach-her is present
 * and holds a pending prediction, it is compared against the scorecard and a
 * mismatch is tagged "hypothesis vs scorecard mismatch"; otherwise the aha is
 * "your first snapshot is evidence". After snapshot #1 the module emits
 * vx:onboarding-handoff suggesting the teach-her panel. Simple mode is
 * recommended default-on for first visits (W23 call when present; documented
 * recommendation when absent; covered by the persistent dismiss key).
 *
 * Headless-safe: no DOM access without utils.isBrowser() + guards.
 * No fetch/XHR/WebSocket/eval. No secrets. Plain IIFE, no modules.
 */
(function (root) {
  'use strict';
  var V = root.VORTEX;
  var utils = V.utils;

  var LS_DISMISSED = 'vortex.onboarding.dismissed';   // '1' once the tour is dismissed
  var LS_PROGRESS = 'vortex.onboarding.progress';     // JSON {complete:bool, done:[ids]}

  /* Steps. doneWhen must be a bus event name from the KNOWN allowlist;
   * a step with an unknown doneWhen is flagged blocked and can NEVER
   * advance (asserted in selfTest). 'vx:frame' is the closest observable to
   * "stir the field": the throttled frame event means the field is live and
   * advecting; 'vx:params' is assumed to be emitted by the param sliders
   * (W01/W02 chrome), 'vx:probe' by the probe bus, 'vx:scorecard' by W07's
   * scorecard render, 'vx:snapshot' by W12 on snapshot capture. */
  var STEPS = [
    { id: 'stir',      title: 'Stir the field',
      hint: 'The field is live — drag across the canvas (or press Move) and watch the tracers swirl.',
      doneWhen: 'vx:frame' },
    { id: 'sliders',   title: 'Move a slider',
      hint: 'Change Circulation, Turbulence or Persistence and feel the field change.',
      doneWhen: 'vx:params' },
    { id: 'probe',     title: 'Drop a probe',
      hint: 'Click a probe button (e.g. Perturb the field) to inject a disturbance.',
      doneWhen: 'vx:probe' },
    { id: 'scorecard', title: 'Read the scorecard',
      hint: 'Run once, then read the composite — percentiles show where this run sits.',
      doneWhen: 'vx:scorecard' },
    { id: 'snapshot',  title: 'Take a snapshot',
      hint: 'Save this run. Snapshots store seed + params + history, not buffers.',
      doneWhen: 'vx:snapshot' }
  ];

  // Bus events the onboarding trusts to complete steps. Unknown events are
  // ignored on purpose: a mistyped doneWhen must never silently advance.
  var KNOWN = {
    'vx:frame': true,
    'vx:params': true,
    'vx:probe': true,
    'vx:scorecard': true,
    'vx:snapshot': true
  };

  function stepIsLive(step) {
    return !!(step && KNOWN[step.doneWhen]);
  }

  /* ---- guarded storage (shim-swappable for tests) ---- */
  function defaultStore() {
    return {
      get: function (k) {
        try {
          if (typeof root.localStorage === 'undefined') return null;
          return root.localStorage.getItem(k);
        } catch (e) { return null; }
      },
      set: function (k, v) {
        try {
          if (typeof root.localStorage !== 'undefined') root.localStorage.setItem(k, v);
        } catch (e) { /* quota / private mode: tour simply won't persist */ }
      },
      remove: function (k) {
        try {
          if (typeof root.localStorage !== 'undefined') root.localStorage.removeItem(k);
        } catch (e) {}
      }
    };
  }
  var store = defaultStore();

  /* ---- state ---- */
  var state = {
    active: false,
    idx: 0,
    done: {},
    dismissed: false,
    complete: false,
    aha: null,
    handoff: false,
    simpleMode: null,   // recommendation record
    lastScorecard: null
  };

  function readJSON(raw) {
    try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function loadPersisted() {
    state.dismissed = store.get(LS_DISMISSED) === '1';
    var p = readJSON(store.get(LS_PROGRESS));
    if (p && p.complete) { state.complete = true; }
    if (p && Array.isArray(p.done)) {
      var n = Math.min(p.done.length, STEPS.length);
      for (var i = 0; i < n; i++) { state.done[p.done[i]] = true; }
      state.idx = n;
    }
  }
  function saveProgress() {
    var ids = [];
    for (var i = 0; i < STEPS.length; i++) {
      if (state.done[STEPS[i].id]) ids.push(STEPS[i].id);
    }
    store.set(LS_PROGRESS, JSON.stringify({ complete: state.complete, done: ids }));
  }

  /* ---- chips: pure data, never modal, never blocking ---- */
  function chipFor(step, kind, extra) {
    return {
      type: 'chip',          // informational chip; no modal semantics, ever
      modal: false,
      blocking: false,
      dismissable: true,
      id: 'chip-' + step.id + (kind ? '-' + kind : ''),
      stepId: step.id,
      title: step.title,
      hint: step.hint,
      kind: kind || 'step',
      text: extra || null
    };
  }
  function currentChip() {
    var step = STEPS[state.idx];
    if (!step) return null;
    return chipFor(step);
  }

  /* ---- aha moment ---- */
  // Returns {kind:'mismatch'|'first-evidence', text, detail}. Guarded: no W09
  // module -> falls back to the first-evidence aha; W09 API shape differences
  // are absorbed by try/catch and field checks.
  function comparePrediction(pred, scorecard) {
    if (!pred || !scorecard) return false;
    var metric = pred.metric || 'composite';
    var actual = null, baseline = null;
    if (metric === 'composite' && typeof scorecard.composite === 'number') {
      actual = scorecard.composite;
    } else if (Array.isArray(scorecard.perMetric)) {
      for (var i = 0; i < scorecard.perMetric.length; i++) {
        var r = scorecard.perMetric[i];
        if (r && (r.id === metric || r.title === metric)) {
          actual = (typeof r.value === 'number') ? r.value : null;
          baseline = (typeof r.baseline === 'number') ? r.baseline : null;
          break;
        }
      }
    }
    if (actual === null || typeof pred.value !== 'number') {
      // direction-only prediction: compare sign vs baseline
      if (pred.direction && actual !== null && baseline !== null) {
        var observedUp = actual > baseline;
        var predictedUp = pred.direction === 'up';
        return observedUp !== predictedUp;
      }
      return false;
    }
    var tol = (typeof pred.tolerance === 'number') ? pred.tolerance
      : Math.abs(baseline || actual || 1) * 0.15;
    return Math.abs(pred.value - actual) > tol;
  }
  function computeAha(scorecard) {
    var w09 = V.has('w09-teachher') ? V.get('w09-teachher') : null;
    var pred = null;
    if (w09 && typeof w09.getPendingPrediction === 'function') {
      try { pred = w09.getPendingPrediction(); } catch (e) { pred = null; }
    }
    if (pred) {
      var mismatch = false;
      try { mismatch = comparePrediction(pred, scorecard); } catch (e) { mismatch = false; }
      if (mismatch) {
        state.aha = {
          kind: 'mismatch',
          text: 'hypothesis vs scorecard mismatch',
          detail: 'A teach-her prediction disagrees with the scorecard. ' +
                  'Scorecards are protocol-relative (W07) — this is evidence, not failure.'
        };
        return state.aha;
      }
    }
    // W09 absent or no prediction to compare: the aha is the snapshot-as-evidence.
    state.aha = {
      kind: 'first-evidence',
      text: 'your first snapshot is evidence',
      detail: 'Take a snapshot and you hold a reproducible claim: seed + params + history, ' +
              'ready to compare against a control twin.'
    };
    return state.aha;
  }

  /* ---- simple mode recommendation (W23) ---- */
  function recommendSimpleMode() {
    var rec = {
      recommendation: 'simple-mode default-on for first visit',
      rationale: 'Five controls instead of the full lab on first sight; toggleable anytime.',
      applied: false,
      via: null,
      note: null
    };
    if (V.has('w23-a11y')) {
      var w23 = V.get('w23-a11y');
      var setter = (w23 && (w23.setSimpleMode || w23.simpleMode || w23.setSimple));
      try {
        if (typeof setter === 'function') { setter.call(w23, true); rec.applied = true; rec.via = 'w23-a11y.setSimpleMode(true)'; }
        else if (w23 && typeof w23 === 'object' && 'simpleMode' in w23) { w23.simpleMode = true; rec.applied = true; rec.via = 'w23-a11y.simpleMode=true'; }
        else { rec.note = 'w23-a11y present but exposes no simple-mode setter; recommend manual toggle.'; }
      } catch (e) { rec.note = 'w23-a11y call threw: ' + String(e && e.message || e); }
    } else {
      rec.note = 'w23-a11y not present in this build — recommendation recorded; ' +
                 'the persistent tour dismiss key covers this recommendation.';
    }
    state.simpleMode = rec;
    return rec;
  }

  /* ---- step engine ---- */
  function emit(name, detail) { V.bus.emit(name, detail || {}); }
  function doneCount() {
    var n = 0;
    for (var i = 0; i < STEPS.length; i++) if (state.done[STEPS[i].id]) n++;
    return n;
  }
  function progressText() { return doneCount() + '/' + STEPS.length; }

  function doHandoff() {
    if (state.handoff) return;
    state.handoff = true;
    emit('vx:onboarding-handoff', {
      from: 'onboarding',
      suggest: 'teach-her',
      after: 'snapshot-1',
      message: 'First snapshot saved — open Teach-her and make a prediction about the next run.'
    });
    V.ui.announce('Onboarding: first snapshot saved — try the Teach-her loop next.');
  }

  function finish() {
    state.complete = true;
    state.active = false;
    saveProgress();
    emit('vx:onboarding-done', { steps: STEPS.length, progress: progressText() });
    V.ui.announce('Onboarding complete: 5/5. The tour is dismissed for good; reopen it from the Tour button anytime.');
    renderChrome();
  }

  function completeStep(id) {
    var i = -1;
    for (var k = 0; k < STEPS.length; k++) if (STEPS[k].id === id) { i = k; break; }
    if (i < 0 || i !== state.idx || state.done[id]) return false;
    var step = STEPS[i];
    if (!stepIsLive(step)) return false;      // unknown doneWhen: never advances
    state.done[id] = true;
    if (id === 'scorecard') {
      var aha = computeAha(state.lastScorecard);
      emit('vx:onboarding-aha', { kind: aha.kind, text: aha.text, detail: aha.detail });
      V.ui.announce('Aha: ' + aha.text);
    }
    if (id === 'snapshot') doHandoff();
    state.idx = i + 1;
    saveProgress();
    emit('vx:onboarding-step', { stepId: id, done: doneCount(), total: STEPS.length, progress: progressText() });
    if (state.idx >= STEPS.length) finish();
    else renderChrome();
    return true;
  }

  // Routes ONE bus event name into the current step. Unknown event names and
  // steps with unknown doneWhen never advance anything.
  function route(eventName, detail) {
    if (!state.active || state.dismissed || state.complete) return;
    var step = STEPS[state.idx];
    if (!step || state.done[step.id]) return;
    if (!stepIsLive(step)) return;
    if (step.doneWhen === eventName) {
      if (eventName === 'vx:scorecard') state.lastScorecard = detail || null;
      completeStep(step.id);
    }
  }

  // One listener per trusted event; registered once at module load.
  Object.keys(KNOWN).forEach(function (name) {
    V.bus.on(name, function (detail) { route(name, detail); });
  });

  /* ---- DOM chrome (browser only; chips never block the canvas) ---- */
  var _els = null;
  function renderChrome() {
    if (!utils.isBrowser() || typeof root.document === 'undefined') return;
    if (!_els) mountChrome();
    if (!_els) return;
    var showTour = state.active && !state.dismissed && !state.complete;
    _els.wrap.style.display = showTour ? 'block' : 'none';
    _els.chipBox.innerHTML = '';
    if (showTour) {
      var chip = currentChip();
      if (chip) _els.chipBox.appendChild(buildChipEl(chip));
      if (state.aha && state.idx >= 4) {
        var aha = root.document.createElement('div');
        aha.className = 'vx-ob-chip vx-ob-aha';
        aha.textContent = 'Aha — ' + state.aha.text;
        _els.chipBox.appendChild(aha);
      }
      var prog = root.document.createElement('div');
      prog.className = 'vx-ob-progress';
      prog.textContent = 'Tour ' + progressText();
      _els.chipBox.appendChild(prog);
    }
  }
  function buildChipEl(chip) {
    var doc = root.document;
    var d = doc.createElement('div');
    d.className = 'vx-ob-chip';
    d.setAttribute('role', 'note');
    var t = doc.createElement('strong');
    t.textContent = chip.title + ' — ' + progressText();
    var h = doc.createElement('span');
    h.textContent = ' ' + chip.hint;
    var x = doc.createElement('button');
    x.className = 'vx-ob-x';
    x.setAttribute('aria-label', 'Dismiss tour');
    x.textContent = '×';
    x.onclick = function () { api.dismiss(); };
    d.appendChild(t); d.appendChild(h); d.appendChild(x);
    return d;
  }
  function mountChrome() {
    var doc = root.document;
    var anchor = doc.getElementById('vx-status') || doc.body;
    if (!anchor) return;
    var wrap = doc.createElement('div');
    wrap.id = 'vx-onboarding';
    wrap.className = 'vx-onboarding';
    // Container is pointer-transparent; only the chip/button capture input,
    // so the tour can never block canvas interaction.
    wrap.style.pointerEvents = 'none';
    var chipBox = doc.createElement('div');
    chipBox.className = 'vx-ob-chips';
    chipBox.style.pointerEvents = 'auto';
    var tourBtn = doc.createElement('button');
    tourBtn.className = 'vx-ob-tour';
    tourBtn.textContent = 'Tour';
    tourBtn.title = 'Reopen the first-run tour';
    tourBtn.style.pointerEvents = 'auto';
    tourBtn.onclick = function () { api.resume(); };
    wrap.appendChild(tourBtn);
    wrap.appendChild(chipBox);
    if (anchor === doc.body) doc.body.appendChild(wrap);
    else anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    _els = { wrap: wrap, chipBox: chipBox, tourBtn: tourBtn };
  }

  /* ---- public API ---- */
  var api = {
    steps: STEPS,
    knownEvents: function () { return Object.keys(KNOWN); },
    stepIsLive: stepIsLive,
    isActive: function () { return state.active; },
    isDismissed: function () { return state.dismissed; },
    isComplete: function () { return state.complete; },
    progress: function () { return { done: doneCount(), total: STEPS.length }; },
    progressText: progressText,
    currentStep: function () { return STEPS[state.idx] || null; },
    aha: function () { return state.aha; },
    chips: function () {
      // Data-only view of the current hint chip. Always type 'chip',
      // always modal:false — asserted in selfTest.
      var c = currentChip();
      return c ? [c] : [];
    },
    start: function () {
      loadPersisted();
      if (state.dismissed || state.complete) { state.active = false; renderChrome(); return false; }
      state.active = true;
      state.idx = Math.min(state.idx, STEPS.length);
      // First visit: recommend simple mode (persistent dismiss covers it).
      if (doneCount() === 0 && !state.simpleMode) recommendSimpleMode();
      emit('vx:onboarding-start', { progress: progressText() });
      renderChrome();
      return true;
    },
    stop: function () { state.active = false; renderChrome(); },
    dismiss: function () {
      state.dismissed = true;
      state.active = false;
      store.set(LS_DISMISSED, '1');     // persistent, guarded
      emit('vx:onboarding-dismiss', {});
      renderChrome();
      return true;
    },
    resume: function () {
      state.dismissed = false;
      store.remove(LS_DISMISSED);
      emit('vx:onboarding-resume', {});
      return api.start();
    },
    recommendSimpleMode: recommendSimpleMode,
    // Test hook: swaps the storage backend (restored by the test when done).
    _useStorage: function (shim) { store = shim; },
    _defaultStorage: function () { store = defaultStore(); },
    _resetState: function () {
      state.active = false; state.idx = 0; state.done = {};
      state.dismissed = false; state.complete = false; state.aha = null;
      state.handoff = false; state.simpleMode = null; state.lastScorecard = null;
    },
    selfTest: selfTest
  };

  // Autostart on first visit (never when dismissed or already complete).
  loadPersisted();
  if (utils.isBrowser() && typeof root.document !== 'undefined') {
    var boot = function () {
      if (!state.dismissed && !state.complete && doneCount() < STEPS.length) api.start();
      else renderChrome();
    };
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', boot);
    } else { boot(); }
  }

  VORTEX.register('w29-onboarding', api);

  /* ---------------- selfTest (headless-safe) ---------------- */
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }

    check('registered as w29-onboarding', V.has('w29-onboarding'),
      'VORTEX.has -> ' + V.has('w29-onboarding'));

    check('five steps defined', STEPS.length === 5,
      'ids=' + STEPS.map(function (s) { return s.id; }).join(','));
    var shape = STEPS.every(function (s) { return s.id && s.title && s.hint && s.doneWhen; });
    check('steps carry id/title/hint/doneWhen', shape, 'all five');

    var live = STEPS.every(function (s) { return stepIsLive(s); });
    check('all steps live on known events', live,
      'doneWhen=' + STEPS.map(function (s) { return s.doneWhen; }).join(','));

    // unknown doneWhen never advances
    check('unknown doneWhen is not live', stepIsLive({ id: 'x', doneWhen: 'vx:bogus' }) === false,
      'bogus step rejected by allowlist');

    // synthetic in-memory storage shim
    var mem = {};
    var shim = {
      get: function (k) { return (k in mem) ? mem[k] : null; },
      set: function (k, v) { mem[k] = String(v); },
      remove: function (k) { delete mem[k]; }
    };
    api._useStorage(shim);
    function newSession() { mem = {}; api._resetState(); } // fresh visit
    newSession();

    var seen = {};
    ['vx:onboarding-handoff', 'vx:onboarding-done', 'vx:onboarding-aha'].forEach(function (n) {
      V.bus.on(n, function (d) { seen[n] = d; });
    });

    api.start();
    check('tour starts', api.isActive() === true, 'active=' + api.isActive());

    // out-of-order: snapshot event first must not skip steps
    V.bus.emit('vx:snapshot', {});
    check('out-of-order event does not skip', api.progressText() === '0/5',
      'progress=' + api.progressText());

    // unknown event name never advances
    V.bus.emit('vx:bogus', {});
    check('unknown bus event never advances', api.progressText() === '0/5',
      'progress=' + api.progressText());

    // advance in order
    V.bus.emit('vx:frame', {});
    check('vx:frame completes stir', api.progressText() === '1/5', 'progress=' + api.progressText());
    V.bus.emit('vx:params', { circulation: 0.5 });
    check('vx:params completes slider step', api.progressText() === '2/5', 'progress=' + api.progressText());
    V.bus.emit('vx:probe', { probe: 'perturb' });
    check('vx:probe completes probe step', api.progressText() === '3/5', 'progress=' + api.progressText());
    V.bus.emit('vx:scorecard', { composite: 0.42, perMetric: [{ id: 'mixing', value: 0.3 }] });
    check('vx:scorecard completes scorecard step', api.progressText() === '4/5', 'progress=' + api.progressText());
    check('aha computed after scorecard', !!(api.aha() && api.aha().text),
      'aha=' + (api.aha() ? api.aha().kind + ':' + api.aha().text : 'null'));
    check('aha falls back without W09', !V.has('w09-teachher') ?
      (api.aha().kind === 'first-evidence') : true,
      'w09 present=' + V.has('w09-teachher') + ' kind=' + (api.aha() && api.aha().kind));
    V.bus.emit('vx:snapshot', { id: 'snap-1' });
    check('vx:snapshot completes tour', api.progressText() === '5/5' && api.isComplete(),
      'progress=' + api.progressText());

    check('handoff emitted after snapshot #1', !!seen['vx:onboarding-handoff'] &&
      seen['vx:onboarding-handoff'].suggest === 'teach-her',
      'detail=' + JSON.stringify(seen['vx:onboarding-handoff'] || null));
    check('done emitted on completion', !!seen['vx:onboarding-done'],
      'vx:onboarding-done received');

    // chips never modal / never blocking
    newSession();
    api.start();
    var chips = api.chips();
    var chipOk = chips.length === 1 && chips[0].type === 'chip' &&
                 chips[0].modal === false && chips[0].blocking === false &&
                 chips[0].dismissable === true;
    check('chips are non-modal hint chips', chipOk,
      'chip=' + JSON.stringify(chips[0] || null));

    // dismiss persists via shim
    newSession();
    api.start();
    api.dismiss();
    check('dismiss persists to storage', mem[LS_DISMISSED] === '1',
      'vortex.onboarding.dismissed=' + mem[LS_DISMISSED]);
    check('tour stops on dismiss', api.isActive() === false, 'active=false');

    // resume clears the dismiss key
    api.resume();
    check('resume clears dismiss and restarts', !(LS_DISMISSED in mem) && api.isActive(),
      'dismissed=' + api.isDismissed() + ' active=' + api.isActive());

    // simple-mode recommendation is documented when W23 absent
    var rec = api.recommendSimpleMode();
    check('simple-mode recommendation recorded', !!(rec && rec.recommendation),
      'applied=' + rec.applied + ' note=' + rec.note);

    // second full pass is idempotent: one done emission, progress stays 5/5
    newSession();
    var doneEmits = 0;
    V.bus.on('vx:onboarding-done', function () { doneEmits++; });
    api.start();
    V.bus.emit('vx:frame', {}); V.bus.emit('vx:params', {});
    V.bus.emit('vx:probe', {});
    V.bus.emit('vx:scorecard', { composite: 0.1 });
    V.bus.emit('vx:snapshot', {});
    check('second full pass completes cleanly', api.isComplete() && api.progressText() === '5/5',
      'progress=' + api.progressText());
    V.bus.emit('vx:frame', {}); V.bus.emit('vx:snapshot', {});
    check('post-completion events are inert', api.progressText() === '5/5' && doneEmits === 1,
      'doneEmits=' + doneEmits + ' progress=' + api.progressText());

    // completed tours do not autostart on a new visit
    api._resetState();
    check('no autostart when complete', api.start() === false && api.isActive() === false,
      'active=' + api.isActive() + ' (shim still holds complete:true)');

    api._resetState();
    api._defaultStorage();

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

})(typeof window !== 'undefined' ? window : globalThis);
