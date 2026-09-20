/* VORTEX js/capture-compare.js — W13 capture & compare.
 *
 * Every probe injection captures a T0 snapshot, runs N sim-seconds, captures
 * T1, and auto-spawns a CONTROL TWIN (same seed/config, no probe) with its
 * own T0/T1. Metric deltas are flagged green/amber/red against control drift,
 * entries land in an immutable lab notebook, verdicts are owner-only and
 * never auto-assigned, and probes rank by effect size with a vx:ranking feed
 * for W26 A/B winners and W08 market settlement.
 *
 * Integrations (all degrade-safe — guarded by VORTEX.has):
 *   w06-protocols  — active protocol id attached to notebook entries when present.
 *   w07-metrics    — per-metric delta table uses W07 metric names when present,
 *                    else raw sampleMetrics() deltas.
 *   w12-snapshots  — T0/T1 stored via W12's store when present, else in-memory refs.
 *   w31-permissions— verdict role check binds to W31's authority when present;
 *                    otherwise a local owner flag, defaulting to the single
 *                    local user as owner.
 *
 * The lab field is attached explicitly (attachField) or via a vx:field bus
 * event carrying {field}. Capture is non-destructive: the field is restored
 * to its pre-capture state afterwards.
 *
 * Plain script, no modules, no network. Headless-safe (node).
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w13-compare: VORTEX namespace missing (load vx-namespace.js first)');

  var MODULE_ID = 'w13-compare';
  var STORE_KEY = 'vortex.w13.notebook.v1';

  // ---------------------------------------------------------------- state

  var _field = null;            // attached VortexField (see CONTRACTS §5)
  var _fieldProvider = null;    // optional lazy provider fn -> field
  var _notebook = [];           // frozen entries, append-only
  var _verdicts = {};           // entryId -> frozen verdict record
  var _snapStore = {};          // local fallback snapshot refs: id -> snapshot
  var _captures = [];           // every captureInjection result (for ranking)
  var _localOwner = true;       // local fallback: single local user IS the owner

  // ------------------------------------------------- degrade-safe lookups

  function findModule(ids) {
    for (var i = 0; i < ids.length; i++) {
      if (V.has(ids[i])) return V.get(ids[i]);
    }
    return null;
  }

  function w07MetricNames() {
    var m = findModule(['w07-metrics', 'w07', 'metrics']);
    if (!m) return null;
    var fns = ['metricNames', 'names', 'list', 'metricList'];
    for (var i = 0; i < fns.length; i++) {
      if (typeof m[fns[i]] === 'function') {
        try {
          var r = m[fns[i]]();
          if (Array.isArray(r) && r.length) return r.slice();
        } catch (e) { /* keep degrading */ }
      }
    }
    if (Array.isArray(m.metrics) && m.metrics.length) {
      return m.metrics.map(function (x) { return x.name || x.id || String(x); });
    }
    return null;
  }

  function w06ActiveProtocolId() {
    var p = findModule(['w06-protocols', 'w06', 'protocols']);
    if (!p) return null;
    var fns = ['activeProtocol', 'getActive', 'current'];
    for (var i = 0; i < fns.length; i++) {
      if (typeof p[fns[i]] === 'function') {
        try {
          var r = p[fns[i]]();
          if (r && (r.id || r.protocolId)) return r.id || r.protocolId;
        } catch (e) { /* keep degrading */ }
      }
    }
    return null;
  }

  // Returns { id } for a stored snapshot, via W12 when present.
  function storeSnapshot(tag, snapObj) {
    var s = findModule(['w12-snapshots', 'w12', 'snapshots']);
    if (s) {
      var fns = ['save', 'store', 'put'];
      for (var i = 0; i < fns.length; i++) {
        if (typeof s[fns[i]] === 'function') {
          try {
            var id = s[fns[i]]({ tag: tag, module: MODULE_ID, snapshot: snapObj });
            if (id !== undefined && id !== null) return { id: String(id), via: 'w12' };
          } catch (e) { /* fall through to local */ }
        }
      }
    }
    var lid = V.utils.uid('snap');
    _snapStore[lid] = { tag: tag, snapshot: snapObj };
    return { id: lid, via: 'local' };
  }

  // Verdict authority: W31 when present, local owner flag otherwise.
  // DOCUMENTED: the role check binds to W31 permissions when that module is
  // registered. W31's public surface is canDo(action)/currentTier()/setRole():
  // 'verdict.record' is an administer-tier action, so canDo('verdict.record')
  // is true exactly for an owner session. Without W31 the local fallback
  // treats the single local user as owner by default; setLocalOwner(false)
  // revokes that fallback (e.g. kiosk/observatory mode).
  function isOwner(actorRole) {
    var p = findModule(['w31-permissions', 'w31', 'permissions']);
    if (p) {
      try {
        if (typeof p.currentRole === 'function') return p.currentRole() === 'owner';
        if (typeof p.role === 'function') return p.role() === 'owner';
        if (typeof p.can === 'function') {
          try { return !!p.can(actorRole || 'owner', 'inject'); } catch (e) { return false; }
        }
        if (typeof p.hasRole === 'function') return !!p.hasRole('owner');
        if (typeof p.canDo === 'function') {
          try { return !!p.canDo('verdict.record'); } catch (e) { return false; }
        }
        if (typeof p.currentTier === 'function') {
          try { return p.currentTier() === 'administer'; } catch (e) { return false; }
        }
      } catch (e) { return false; }
      return false; // W31 present but unreadable -> deny
    }
    return actorRole === 'owner' && _localOwner;
  }

  // ------------------------------------------------------------- utilities

  function deepCopy(o) {
    try { return JSON.parse(JSON.stringify(o)); }
    catch (e) { return o; }
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }

  function mean(xs) {
    if (!xs.length) return 0;
    var s = 0, i;
    for (i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }

  function std(xs) {
    if (xs.length < 2) return 0;
    var m = mean(xs), s = 0, i;
    for (i = 0; i < xs.length; i++) { var d = xs[i] - m; s += d * d; }
    return Math.sqrt(s / (xs.length - 1));
  }

  function flagFor(delta, sigma) {
    var a = Math.abs(delta);
    if (sigma <= 0) return a === 0 ? 'green' : 'red';
    if (a < sigma) return 'green';
    if (a < 2 * sigma) return 'amber';
    return 'red';
  }

  function getField() {
    if (_field) return _field;
    if (_fieldProvider) {
      try { _field = _fieldProvider() || null; } catch (e) { _field = null; }
    }
    return _field;
  }

  function requireField() {
    var f = getField();
    if (!f) {
      throw V.VortexError('VX_E_NO_BACKEND',
        'capture & compare: no field attached. Attach one with attachField(field) or emit vx:field {field}.',
        'capture', 'notebook and earlier captures kept');
    }
    var need = ['snapshotState', 'restoreState', 'step', 'sampleMetrics', 'addProbe'];
    for (var i = 0; i < need.length; i++) {
      if (typeof f[need[i]] !== 'function') {
        throw V.VortexError('VX_E_FIELD_INIT',
          'capture & compare: attached field is missing ' + need[i] + '() (see CONTRACTS §5).',
          'capture', 'notebook and earlier captures kept');
      }
    }
    return f;
  }

  // ------------------------------------------------------- capture + twin

  function runSteps(field, steps, sampleEvery, series) {
    for (var i = 1; i <= steps; i++) {
      field.step();
      if (sampleEvery > 0 && i % sampleEvery === 0 && series) {
        series.push(field.sampleMetrics());
      }
    }
  }

  // sigma per metric from control-run increment noise (the control drift band)
  function controlSigma(series) {
    var sig = {};
    if (!series || series.length < 3) return sig;
    var keys = {};
    series.forEach(function (m) {
      Object.keys(m || {}).forEach(function (k) {
        if (typeof m[k] === 'number' && isFinite(m[k])) keys[k] = 1;
      });
    });
    Object.keys(keys).forEach(function (k) {
      var inc = [];
      for (var i = 1; i < series.length; i++) inc.push(series[i][k] - series[i - 1][k]);
      sig[k] = std(inc);
    });
    return sig;
  }

  function metricUniverse(w07names, samples) {
    if (w07names) return w07names.slice();
    var keys = {};
    samples.forEach(function (m) {
      Object.keys(m || {}).forEach(function (k) {
        if (typeof m[k] === 'number' && isFinite(m[k])) keys[k] = 1;
      });
    });
    return Object.keys(keys).sort();
  }

  /**
   * captureInjection(probeId, params, opts)
   * opts: { simSeconds=2, seed, note, metricNames }.
   * Runs a treatment (probe injected) and a control twin (same seed/config,
   * no probe) for `simSeconds` sim-seconds each, computes per-metric deltas
   * flagged against control drift, appends a frozen notebook entry, updates
   * the cross-probe ranking, and emits vx:capture + vx:ranking.
   * Non-destructive: the field is restored to its pre-capture state.
   */
  function captureInjection(probeId, params, opts) {
    opts = opts || {};
    var field = requireField();
    params = params || {};
    var simSeconds = Math.max(0.25, Math.min(60, Number(opts.simSeconds) || 2));
    var steps = Math.max(1, Math.round(simSeconds / V.SIM_DT));
    var seed = (opts.seed !== undefined && opts.seed !== null)
      ? (opts.seed >>> 0)
      : (parseInt(V.utils.hash53(String(probeId) + V.utils.stableStringify(params), 7), 16) >>> 0);

    var injectionId = V.utils.uid('inj');
    var manifest = V.makeManifest({
      seed: seed,
      params: { probeId: probeId, probeParams: deepCopy(params), simSeconds: simSeconds },
      configId: 'w13-capture',
      probeTimeline: [{ t: 0, probe: probeId, params: deepCopy(params) }],
      backend: field.name || 'unknown',
      tracers: (typeof field.getTracers === 'function') ? (field.getTracers().count || 0) : 0
    });

    // ---- treatment: T0 snapshot, inject, run, T1
    var preState = deepCopy(field.snapshotState());
    var t0Metrics = deepCopy(field.sampleMetrics());
    var t0Ref = storeSnapshot(injectionId + ':T0', preState);
    field.addProbe({ id: probeId, params: deepCopy(params), t: 0 });
    runSteps(field, steps, 0, null);
    var t1Metrics = deepCopy(field.sampleMetrics());
    var t1Ref = storeSnapshot(injectionId + ':T1', deepCopy(field.snapshotState()));

    // ---- control twin: same seed/config, no probe
    field.restoreState(deepCopy(preState));
    var c0Metrics = deepCopy(field.sampleMetrics());
    var c0Ref = storeSnapshot(injectionId + ':C0', deepCopy(preState));
    var sampleEvery = Math.max(1, Math.floor(steps / 20));
    var cSeries = [];
    runSteps(field, steps, sampleEvery, cSeries);
    var c1Metrics = deepCopy(field.sampleMetrics());
    var c1Ref = storeSnapshot(injectionId + ':C1', deepCopy(field.snapshotState()));

    // ---- restore the lab field, probe-free, exactly as found
    try { field.restoreState(deepCopy(preState)); } catch (e) { /* lab keeps last state; noted */ }

    var sigma = controlSigma(cSeries);
    var names = opts.metricNames || w07MetricNames() ||
      metricUniverse(null, [t0Metrics, t1Metrics, c0Metrics, c1Metrics]);
    names = metricUniverse(names, [t0Metrics, t1Metrics, c0Metrics, c1Metrics]);

    var deltas = names.map(function (k) {
      var tv = (typeof t1Metrics[k] === 'number') ? t1Metrics[k] : NaN;
      var cv = (typeof c1Metrics[k] === 'number') ? c1Metrics[k] : NaN;
      var d = (isFinite(tv) && isFinite(cv)) ? tv - cv : NaN;
      var s = sigma[k] || 0;
      return {
        metric: k,
        treatment: tv,
        control: cv,
        delta: d,
        controlSigma: s,
        controlDrift: (isFinite(c1Metrics[k]) && isFinite(c0Metrics[k]))
          ? Math.abs(c1Metrics[k] - c0Metrics[k]) : NaN,
        flag: isFinite(d) ? flagFor(d, s) : 'amber'
      };
    });

    // effect size per probe = max |delta|/sigma over metrics
    var best = { metric: null, effect: 0 };
    deltas.forEach(function (r) {
      var e = (r.controlSigma > 1e-12 && isFinite(r.delta))
        ? r.delta / r.controlSigma
        : (r.delta === 0 ? 0 : (r.delta > 0 ? 1e9 : -1e9));
      if (Math.abs(e) > Math.abs(best.effect)) best = { metric: r.metric, effect: e };
    });

    var entry = deepFreeze({
      id: V.utils.uid('nb'),
      timestamp: V.utils.now(),
      injectionId: injectionId,
      probeId: probeId,
      params: deepCopy(params),
      seed: seed,
      simSeconds: simSeconds,
      steps: steps,
      manifestHash: manifest.hash,
      protocolId: w06ActiveProtocolId(),
      t0: { ref: t0Ref.id, via: t0Ref.via, metrics: t0Metrics },
      t1: { ref: t1Ref.id, via: t1Ref.via, metrics: t1Metrics },
      control: {
        t0ref: c0Ref.id, t1ref: c1Ref.id, via: c0Ref.via,
        metrics: c1Metrics, sigma: sigma, checkpoints: cSeries.length
      },
      deltas: deltas,
      effectSize: best.effect,
      primaryMetric: best.metric,
      note: String(opts.note || '')
    });

    _notebook.push(entry);
    persistNotebook();

    var cap = {
      injectionId: injectionId, entryId: entry.id, probeId: probeId,
      params: deepCopy(params), effectSize: best.effect, primaryMetric: best.metric,
      timestamp: entry.timestamp, deltas: deltas
    };
    _captures.push(cap);
    updateRanking();

    V.bus.emit('vx:capture', { injectionId: injectionId, entryId: entry.id, probeId: probeId });
    return cap;
  }

  // ------------------------------------------------------------- ranking

  var _ranking = [];

  function updateRanking() {
    _ranking = _captures
      .map(function (c) {
        return {
          probeId: c.probeId, injectionId: c.injectionId, entryId: c.entryId,
          effectSize: c.effectSize, primaryMetric: c.primaryMetric, timestamp: c.timestamp
        };
      })
      .sort(function (a, b) { return Math.abs(b.effectSize) - Math.abs(a.effectSize); });
    // Feed hook for W26 A/B winners and W08 market settlement.
    V.bus.emit('vx:ranking', { ranked: _ranking.map(function (r) {
      return { probeId: r.probeId, effectSize: r.effectSize, primaryMetric: r.primaryMetric };
    }) });
  }

  function getRanking() {
    return _ranking.map(function (r) { return deepCopy(r); });
  }

  // ------------------------------------------------------------ notebook

  function persistNotebook() {
    try {
      if (typeof root.localStorage === 'undefined') return;
      root.localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1,
        entries: _notebook,
        verdicts: _verdicts,
        savedAt: V.utils.now()
      }));
    } catch (e) { /* storage unavailable: notebook stays in-memory, still immutable */ }
  }

  function loadNotebook() {
    try {
      if (typeof root.localStorage === 'undefined') return;
      var raw = root.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.entries)) {
        _notebook = d.entries.map(deepFreeze);
        _verdicts = {};
        Object.keys(d.verdicts || {}).forEach(function (k) { _verdicts[k] = deepFreeze(d.verdicts[k]); });
      }
    } catch (e) { /* corrupted store: start empty rather than crash */ }
  }

  function getNotebook() {
    return _notebook.slice();
  }

  function getEntry(entryId) {
    for (var i = 0; i < _notebook.length; i++) {
      if (_notebook[i].id === entryId) return _notebook[i];
    }
    return null;
  }

  function exportNotebook() {
    return JSON.stringify({
      module: MODULE_ID,
      version: 1,
      codeVersion: V.codeVersion,
      exportedAt: V.utils.now(),
      entries: _notebook,
      verdicts: _verdicts,
      ranking: _ranking
    }, null, 2);
  }

  // ------------------------------------------------------------ verdicts

  var VERDICTS = ['confirmed', 'refuted', 'inconclusive'];

  /**
   * setVerdict(entryId, verdict, actorRole)
   * Verdicts are NEVER auto-assigned. Requires the owner role:
   * binds to W31 permissions when present, else the local owner flag
   * (default: the single local user is the owner).
   */
  function setVerdict(entryId, verdict, actorRole) {
    var entry = getEntry(entryId);
    if (!entry) return { ok: false, error: 'unknown notebook entry: ' + entryId };
    if (VERDICTS.indexOf(verdict) < 0) {
      return { ok: false, error: 'verdict must be one of ' + VERDICTS.join('/') };
    }
    if (!isOwner(actorRole)) {
      V.bus.emit('vx:verdict-denied', { entryId: entryId, actorRole: actorRole || null });
      return { ok: false, error: 'owner role required — verdicts are never auto-assigned' };
    }
    var prev = _verdicts[entryId] || null;
    var rec = deepFreeze({
      entryId: entryId,
      verdict: verdict,
      actorRole: 'owner',
      timestamp: V.utils.now(),
      supersedes: prev ? prev.timestamp : null
    });
    _verdicts[entryId] = rec;
    persistNotebook();
    V.bus.emit('vx:verdict', { entryId: entryId, verdict: verdict });
    return { ok: true, verdict: rec };
  }

  function getVerdict(entryId) {
    return _verdicts[entryId] ? deepCopy(_verdicts[entryId]) : null;
  }

  // --------------------------------------------------------------- panel

  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a !== 0 && (a >= 1e6 || a < 1e-4)) return n.toExponential(2);
    return String(Math.round(n * 1e6) / 1e6);
  }

  function flagBadge(flag) {
    var colors = { green: '#2f9e44', amber: '#e8a13a', red: '#d64545' };
    return { text: flag.toUpperCase(), color: colors[flag] || '#888' };
  }

  function mountPanel(el) {
    if (!el || typeof root.document === 'undefined') return;
    var doc = root.document;
    el.innerHTML = '';

    function h(tag, text, style) {
      var n = doc.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (style) n.setAttribute('style', style);
      return n;
    }
    function row(label, value) {
      var d = h('div', '', 'display:flex;justify-content:space-between;padding:2px 0;');
      d.appendChild(h('span', label, 'opacity:.7;'));
      d.appendChild(h('span', value, 'font-variant-numeric:tabular-nums;'));
      return d;
    }

    var wrap = h('div', '', 'font-size:12px;line-height:1.45;');

    // --- capture controls
    wrap.appendChild(h('h3', 'Capture & compare', 'margin:0 0 6px;'));
    var status = h('div', 'No field attached.', 'opacity:.75;margin-bottom:8px;');
    wrap.appendChild(status);

    var form = h('div', '', 'display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;margin-bottom:8px;');
    form.appendChild(h('label', 'Probe'));
    var probeInput = doc.createElement('input');
    probeInput.value = 'oppose-winding'; probeInput.setAttribute('style', 'width:100%;');
    form.appendChild(probeInput);
    form.appendChild(h('label', 'Params (JSON)'));
    var paramsInput = doc.createElement('input');
    paramsInput.value = '{"strength":0.5}'; paramsInput.setAttribute('style', 'width:100%;');
    form.appendChild(paramsInput);
    form.appendChild(h('label', 'Sim seconds'));
    var secsInput = doc.createElement('input');
    secsInput.value = '2'; secsInput.setAttribute('style', 'width:100%;');
    form.appendChild(secsInput);
    form.appendChild(h('label', 'Note'));
    var noteInput = doc.createElement('input');
    noteInput.placeholder = 'lab notebook note (optional)';
    noteInput.setAttribute('style', 'width:100%;');
    form.appendChild(noteInput);
    wrap.appendChild(form);

    var capBtn = h('button', 'Capture T0 → inject → run → T1 (+ control twin)');
    wrap.appendChild(capBtn);
    var out = h('div', '', 'margin-top:10px;');
    wrap.appendChild(out);

    function renderCapture(cap) {
      out.innerHTML = '';
      var entry = getEntry(cap.entryId);
      out.appendChild(h('h4', 'Injection ' + cap.injectionId, 'margin:8px 0 4px;'));
      out.appendChild(row('Probe', cap.probeId));
      out.appendChild(row('Seed / sim-seconds / steps',
        entry.seed + ' / ' + entry.simSeconds + ' / ' + entry.steps));
      out.appendChild(row('T0 → T1 refs', entry.t0.ref + ' → ' + entry.t1.ref + ' (' + entry.t1.via + ')'));
      out.appendChild(row('Control twin refs', entry.control.t0ref + ' → ' + entry.control.t1ref));
      out.appendChild(row('Protocol', entry.protocolId || 'none (w06 absent)'));
      out.appendChild(row('Effect size (' + (cap.primaryMetric || '—') + ')', fmt(cap.effectSize) + ' σ'));

      var tbl = doc.createElement('table');
      tbl.setAttribute('style', 'border-collapse:collapse;margin-top:6px;width:100%;');
      var head = doc.createElement('tr');
      ['metric', 'treatment', 'control', 'delta', 'ctrl σ', 'flag'].forEach(function (c) {
        var th = h('th', c, 'text-align:left;border-bottom:1px solid #888;padding:2px 4px;font-weight:600;');
        head.appendChild(th);
      });
      tbl.appendChild(head);
      entry.deltas.forEach(function (r) {
        var tr = doc.createElement('tr');
        tr.appendChild(h('td', r.metric, 'padding:2px 4px;'));
        tr.appendChild(h('td', fmt(r.treatment), 'padding:2px 4px;'));
        tr.appendChild(h('td', fmt(r.control), 'padding:2px 4px;'));
        tr.appendChild(h('td', fmt(r.delta), 'padding:2px 4px;'));
        tr.appendChild(h('td', fmt(r.controlSigma), 'padding:2px 4px;'));
        var badge = flagBadge(r.flag);
        var td = h('td', '', 'padding:2px 4px;');
        var b = h('span', badge.text, 'color:#fff;background:' + badge.color +
          ';border-radius:3px;padding:1px 6px;font-size:11px;');
        td.appendChild(b);
        tr.appendChild(td);
        tbl.appendChild(tr);
      });
      out.appendChild(tbl);
      refreshNotebook();
      refreshRanking();
    }

    capBtn.onclick = function () {
      var params = {};
      try { params = JSON.parse(paramsInput.value || '{}'); }
      catch (e) { status.textContent = 'Params must be valid JSON.'; return; }
      try {
        var cap = captureInjection(probeInput.value.trim() || 'probe',
          params, { simSeconds: parseFloat(secsInput.value) || 2, note: noteInput.value });
        status.textContent = 'Captured ' + cap.injectionId + ' — notebook entry ' + cap.entryId + '.';
        renderCapture(cap);
        V.ui.announce('W13 captured ' + cap.probeId + ' vs control twin.');
      } catch (e) {
        status.textContent = 'Capture failed: ' + (e && e.message ? e.message : e);
      }
    };

    // --- notebook
    wrap.appendChild(h('h4', 'Lab notebook (append-only, immutable)', 'margin:12px 0 4px;'));
    var nbList = h('div', '', '');
    wrap.appendChild(nbList);

    function refreshNotebook() {
      nbList.innerHTML = '';
      if (!_notebook.length) { nbList.appendChild(h('div', 'No entries yet.', 'opacity:.6;')); return; }
      _notebook.forEach(function (e) {
        var d = h('div', '', 'border:1px solid #555;border-radius:4px;padding:6px;margin:4px 0;');
        d.appendChild(row('Entry', e.id));
        d.appendChild(row('Injection', e.probeId + ' · ' + new Date(e.timestamp).toLocaleString()));
        d.appendChild(row('Effect', fmt(e.effectSize) + ' σ on ' + (e.primaryMetric || '—')));
        if (e.note) d.appendChild(row('Note', e.note));
        var v = _verdicts[e.id];
        d.appendChild(row('Verdict', v ? v.verdict.toUpperCase() + ' (owner, ' +
          new Date(v.timestamp).toLocaleTimeString() + ')' : 'none — never auto-assigned'));
        nbList.appendChild(d);
      });
      refreshVerdictSelect();
    }

    // --- verdict controls
    wrap.appendChild(h('h4', 'Owner verdict', 'margin:12px 0 4px;'));
    var vf = h('div', '', 'display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;');
    vf.appendChild(h('label', 'Entry'));
    var entrySel = doc.createElement('select'); entrySel.setAttribute('style', 'width:100%;');
    vf.appendChild(entrySel);
    vf.appendChild(h('label', 'Verdict'));
    var verdictSel = doc.createElement('select');
    ['confirmed', 'refuted', 'inconclusive'].forEach(function (v) {
      var o = doc.createElement('option'); o.value = v; o.textContent = v; verdictSel.appendChild(o);
    });
    vf.appendChild(verdictSel);
    vf.appendChild(h('label', 'Role'));
    var roleSel = doc.createElement('select');
    ['owner', 'viewer', 'agent'].forEach(function (v) {
      var o = doc.createElement('option'); o.value = v; o.textContent = v; roleSel.appendChild(o);
    });
    roleSel.value = 'viewer';
    vf.appendChild(roleSel);
    wrap.appendChild(vf);
    var vBtn = h('button', 'Set verdict (owner only)', 'margin-top:6px;');
    var vMsg = h('div', '', 'margin-top:4px;opacity:.8;');
    wrap.appendChild(vBtn); wrap.appendChild(vMsg);
    vBtn.onclick = function () {
      var r = setVerdict(entrySel.value, verdictSel.value, roleSel.value);
      vMsg.textContent = r.ok ? 'Verdict recorded: ' + r.verdict.verdict
        : 'Rejected: ' + r.error;
      refreshNotebook();
    };

    function refreshVerdictSelect() {
      entrySel.innerHTML = '';
      _notebook.forEach(function (e) {
        var o = doc.createElement('option');
        o.value = e.id; o.textContent = e.id + ' · ' + e.probeId;
        entrySel.appendChild(o);
      });
    }

    // --- ranking
    wrap.appendChild(h('h4', 'Cross-probe ranking (effect size, |Δ|/σ)', 'margin:12px 0 4px;'));
    var rankDiv = h('div', '', '');
    wrap.appendChild(rankDiv);
    function refreshRanking() {
      rankDiv.innerHTML = '';
      var rk = getRanking();
      if (!rk.length) { rankDiv.appendChild(h('div', 'No captures yet.', 'opacity:.6;')); return; }
      var tbl = doc.createElement('table');
      tbl.setAttribute('style', 'border-collapse:collapse;width:100%;');
      var head = doc.createElement('tr');
      ['#', 'probe', 'effect σ', 'metric'].forEach(function (c) {
        head.appendChild(h('th', c, 'text-align:left;border-bottom:1px solid #888;padding:2px 4px;'));
      });
      tbl.appendChild(head);
      rk.forEach(function (r, i) {
        var tr = doc.createElement('tr');
        tr.appendChild(h('td', String(i + 1), 'padding:2px 4px;'));
        tr.appendChild(h('td', r.probeId, 'padding:2px 4px;'));
        tr.appendChild(h('td', fmt(r.effectSize), 'padding:2px 4px;'));
        tr.appendChild(h('td', r.primaryMetric || '—', 'padding:2px 4px;'));
        tbl.appendChild(tr);
      });
      rankDiv.appendChild(tbl);
      rankDiv.appendChild(h('div',
        'Ranking also emitted as vx:ranking for W26 A/B winners and W08 market settlement.',
        'opacity:.6;margin-top:4px;'));
    }

    // --- export
    var expBtn = h('button', 'Export notebook JSON', 'margin-top:12px;');
    wrap.appendChild(expBtn);
    expBtn.onclick = function () {
      try {
        var blob = new root.Blob([exportNotebook()], { type: 'application/json' });
        var a = doc.createElement('a');
        a.href = root.URL.createObjectURL(blob);
        a.download = 'vortex-lab-notebook.json';
        doc.body.appendChild(a); a.click();
        doc.body.removeChild(a);
        setTimeout(function () { root.URL.revokeObjectURL(a.href); }, 4000);
      } catch (e) { status.textContent = 'Export failed: ' + e.message; }
    };

    if (getField()) status.textContent = 'Field attached — ready to capture.';
    refreshNotebook();
    refreshRanking();
    el.appendChild(wrap);
  }

  V.ui.registerPanel('capture-compare', 'Capture & compare', mountPanel);

  // Pick up a live field if the lab announces one.
  V.bus.on('vx:field', function (d) {
    if (d && d.field) _field = d.field;
  });

  // -------------------------------------------------------------- selfTest

  // Synthetic field with deterministic per-step noise: treatment adds a
  // known shift per step to `ke`; control noise has known sigma. Identical
  // step-index noise for treatment/control mirrors CPU determinism, so a
  // null probe yields delta exactly 0 (green), and a real shift yields a
  // large red flag.
  function synthField(shiftPerStep, sigma, seed) {
    var t = 0, probe = null;
    function noise(i) {
      var h = parseInt(V.utils.hash53('w13n' + i, seed || 11), 16) / 0xfffffffffffff;
      return (h * 2 - 1) * sigma; // uniform(-sigma, sigma), deterministic in i
    }
    var m = { ke: 1.0, enstrophy: 0.5, mixing: 0.2 };
    return {
      name: 'synth',
      snapshotState: function () { return { t: t, m: { ke: m.ke, enstrophy: m.enstrophy, mixing: m.mixing }, p: probe ? probe.id : null }; },
      restoreState: function (s) { t = s.t; m = { ke: s.m.ke, enstrophy: s.m.enstrophy, mixing: s.m.mixing }; probe = s.p ? { id: s.p } : null; },
      addProbe: function (p) { probe = p; },
      step: function () {
        t += 1;
        var n = noise(t);
        m.ke += 0.001 + (probe ? shiftPerStep : 0) + n;
        m.enstrophy += 0.0005 + noise(t + 100000) * 0.2;
        m.mixing += 0.0002 + noise(t + 200000) * 0.1;
      },
      sampleMetrics: function () { return { ke: m.ke, enstrophy: m.enstrophy, mixing: m.mixing }; },
      getTracers: function () { return { count: 100, simulated: 100 }; }
    };
  }

  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }

    var keptField = _field, keptNotebook = _notebook, keptVerdicts = _verdicts,
        keptCaptures = _captures, keptRanking = _ranking, keptOwner = _localOwner;
    _notebook = []; _verdicts = {}; _captures = []; _ranking = []; _localOwner = true;
    _field = null;

    try {
      // 1. no field -> named error, nothing captured
      var threw = null;
      try { captureInjection('x', {}, { simSeconds: 0.5 }); }
      catch (e) { threw = e; }
      check('capture without field throws VX_E_NO_BACKEND',
        !!threw && threw.code === 'VX_E_NO_BACKEND',
        threw ? threw.code : 'no throw');
      check('failed capture leaves notebook empty', _notebook.length === 0, 'entries=' + _notebook.length);

      // 2. flags: known shift -> red on ke; untouched metrics -> green.
      // Explicit metricNames: the synth field emits ke/enstrophy/mixing, while
      // a present w07-metrics would otherwise lend its scorecard names (amber
      // by design when the field cannot produce them). The flagging logic is
      // what this asserts; W07-name wiring is asserted separately below.
      _field = synthField(0.05, 0.01, 11); // shift 5x sigma per step
      var cap = captureInjection('delta-probe', { strength: 1 },
        { simSeconds: 2, seed: 7, metricNames: ['ke', 'enstrophy', 'mixing'] });
      var byMetric = {};
      cap.deltas.forEach(function (r) { byMetric[r.metric] = r; });
      check('ke delta flagged red for known shift',
        byMetric.ke && byMetric.ke.flag === 'red',
        'flag=' + (byMetric.ke && byMetric.ke.flag) + ' delta=' + (byMetric.ke && byMetric.ke.delta));
      check('untouched enstrophy flagged green',
        byMetric.enstrophy && byMetric.enstrophy.flag === 'green',
        'flag=' + (byMetric.enstrophy && byMetric.enstrophy.flag));
      check('control sigma positive and finite',
        byMetric.ke && isFinite(byMetric.ke.controlSigma) && byMetric.ke.controlSigma > 0,
        'sigma=' + (byMetric.ke && byMetric.ke.controlSigma));

      // 3. null probe (no shift) -> identical trajectories -> green everywhere
      _field = synthField(0, 0.01, 11);
      var cap0 = captureInjection('null-probe', {},
        { simSeconds: 2, seed: 7, metricNames: ['ke', 'enstrophy', 'mixing'] });
      var allGreen = cap0.deltas.every(function (r) { return r.flag === 'green'; });
      check('null probe yields all-green flags', allGreen,
        cap0.deltas.map(function (r) { return r.metric + ':' + r.flag; }).join(','));

      // 4. ranking orders by effect size: delta-probe above null-probe
      var rk = getRanking();
      check('ranking orders probes by effect size',
        rk.length === 2 && rk[0].probeId === 'delta-probe' && rk[1].probeId === 'null-probe',
        rk.map(function (r) { return r.probeId + '=' + r.effectSize.toFixed(1); }).join(' > '));

      // 5. verdict authority. Without W31 the local owner flag decides; with
      // W31 present, authority binds to W31's session via canDo('verdict.record')
      // (administer tier = owner). The lab-build default session is owner.
      var w31Here = !!findModule(['w31-permissions', 'w31', 'permissions']);
      var entryId = cap.entryId;
      if (!w31Here) {
        var denied = setVerdict(entryId, 'confirmed', 'viewer');
        check('verdict without owner role rejected',
          denied.ok === false && getVerdict(entryId) === null, denied.error || 'accepted?!');
        _localOwner = false;
        var denied2 = setVerdict(entryId, 'confirmed', 'owner');
        check('owner verdict rejected when local owner flag revoked',
          denied2.ok === false, denied2.error || 'accepted?!');
        _localOwner = true;
        var allowed = setVerdict(entryId, 'confirmed', 'owner');
        check('owner verdict accepted', allowed.ok === true && getVerdict(entryId).verdict === 'confirmed',
          JSON.stringify(getVerdict(entryId)));
      } else {
        var w31mod = findModule(['w31-permissions', 'w31', 'permissions']);
        var w31Owner = false;
        try { w31Owner = !!(w31mod && typeof w31mod.canDo === 'function' && w31mod.canDo('verdict.record')); }
        catch (e) { w31Owner = false; }
        var allowedW = setVerdict(entryId, 'confirmed', 'owner');
        var gv = getVerdict(entryId);
        check('verdict authority bound to W31 session',
          (w31Owner && allowedW.ok === true && gv && gv.verdict === 'confirmed') ||
          (!w31Owner && allowedW.ok === false && gv === null),
          'w31-owner-session=' + w31Owner + ' ok=' + allowedW.ok);
      }
      var bad = setVerdict(entryId, 'maybe', 'owner');
      check('invalid verdict value rejected', bad.ok === false, bad.error || 'accepted?!');
      var unknown = setVerdict('nb-nope', 'confirmed', 'owner');
      check('verdict on unknown entry rejected', unknown.ok === false, unknown.error || 'accepted?!');

      // 6. notebook entries immutable
      var e0 = getNotebook()[0];
      var frozenOk = Object.isFrozen(e0) && Object.isFrozen(e0.deltas) && Object.isFrozen(e0.t1);
      var before = e0.note;
      var threwOnMut = false;
      try { e0.note = 'tampered'; } catch (err) { threwOnMut = true; }
      check('notebook entries frozen (mutation throws or ignored)',
        frozenOk && e0.note === before, 'isFrozen=' + frozenOk + ' threw=' + threwOnMut);

      // 7. export JSON round-trips
      var exp = null, expOk = false;
      try { exp = JSON.parse(exportNotebook()); expOk = exp && exp.entries.length === 2; }
      catch (err) { expOk = false; }
      check('exportNotebook JSON parses with entries+verdicts+ranking',
        expOk && exp.verdicts && Object.keys(exp.verdicts).length === 1 && exp.ranking.length === 2,
        'entries=' + (exp && exp.entries.length));

      // 8. vx:ranking emitted
      var seen = null;
      V.bus.on('vx:ranking', function (d) { seen = d; });
      _field = synthField(0.02, 0.01, 11);
      captureInjection('third-probe', {}, { simSeconds: 1, seed: 9 });
      check('vx:ranking emitted on capture',
        !!seen && Array.isArray(seen.ranked) && seen.ranked.length === 3,
        seen ? 'ranked=' + seen.ranked.length : 'no event');

      // 9. degrade/integrate paths: without w06/w07/w12/w31 the entry degrades
      // (protocolId null, snapshots local); with them present the documented
      // wiring applies (W06 protocol id when one is active, W07 names only
      // when the caller does not pin metricNames, W12 store when it offers
      // save/store/put, W31 verdict authority).
      var w06Here = !!findModule(['w06-protocols', 'w06', 'protocols']);
      var w07Here = !!findModule(['w07-metrics', 'w07', 'metrics']);
      var w12Here = !!findModule(['w12-snapshots', 'w12', 'snapshots']);
      var ent = getEntry(cap.entryId);
      var wireOk = true, wireNote = [];
      if (!w06Here && ent.protocolId !== null) { wireOk = false; wireNote.push('protocolId should be null without w06'); }
      if (!w12Here && ent.t0.via !== 'local') { wireOk = false; wireNote.push('t0.via should be local without w12'); }
      if (w12Here && !(ent.t0.via === 'w12' || ent.t0.via === 'local')) { wireOk = false; wireNote.push('t0.via unexpected: ' + ent.t0.via); }
      check('module wiring matches environment', wireOk,
        wireNote.join('; ') || ('protocolId=' + ent.protocolId + ' t0.via=' + ent.t0.via +
          ' w06=' + w06Here + ' w07=' + w07Here + ' w12=' + w12Here + ' w31=' + w31Here));

      // 9b. W07 metric-name wiring: when w07 is present and the caller does
      // not pin metricNames, the delta table uses W07's names (documented).
      if (w07Here) {
        _field = synthField(0.05, 0.01, 11);
        var capW = captureInjection('w07-names-probe', { strength: 1 }, { simSeconds: 1, seed: 21 });
        var w07names = null;
        try {
          var m7 = findModule(['w07-metrics', 'w07', 'metrics']);
          if (m7 && Array.isArray(m7.metrics)) w07names = m7.metrics.map(function (x) { return x.id || x.name; });
        } catch (e) { /* keep null */ }
        var tableNames = capW.deltas.map(function (r) { return r.metric; });
        var namesMatch = !!w07names && tableNames.length === w07names.length &&
          tableNames.every(function (n, i) { return n === w07names[i]; });
        check('w07 present -> delta table uses W07 metric names', namesMatch,
          'table=' + tableNames.join(','));
      } else {
        check('w07 absent -> delta table uses field metric universe', true, 'skipped: w07 not registered');
      }

      // 10. panel is DOM-guarded (headless skip, must not throw)
      var panelOk = true, panelNote = 'headless: mount not invoked';
      if (V.utils.isBrowser()) {
        try {
          var ps = V.ui.panels().filter(function (p) { return p.id === 'capture-compare'; });
          panelOk = ps.length === 1;
          panelNote = 'panel registered: ' + ps.length;
        } catch (err) { panelOk = false; panelNote = String(err); }
      }
      check('panel registered / headless-safe', panelOk, panelNote);
    } finally {
      _field = keptField; _notebook = keptNotebook; _verdicts = keptVerdicts;
      _captures = keptCaptures; _ranking = keptRanking; _localOwner = keptOwner;
    }

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  // -------------------------------------------------------------- public

  loadNotebook();

  var api = {
    captureInjection: captureInjection,
    getNotebook: getNotebook,
    getEntry: getEntry,
    exportNotebook: exportNotebook,
    setVerdict: setVerdict,
    getVerdict: getVerdict,
    getRanking: getRanking,
    attachField: function (f) { _field = f || null; return api; },
    setFieldProvider: function (fn) { _fieldProvider = (typeof fn === 'function') ? fn : null; return api; },
    setLocalOwner: function (b) { _localOwner = !!b; return _localOwner; },
    isLocalOwner: function () { return _localOwner; },
    selfTest: selfTest
  };

  VORTEX.register(MODULE_ID, api);
  return api;

})(typeof window !== 'undefined' ? window : globalThis);
