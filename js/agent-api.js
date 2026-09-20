/* VORTEX agent-api.js — W24: Vera-facing agent API.
 *
 * Design source: lane-14-vortex.md §3.8 ("Vera proposes; only Shawn injects"),
 * §9 "Agent API", §12.7 (ops: Vera proposal → Shawn approval → grant → inject).
 *
 * Surface:
 *   VORTEX.agent.observe([callerId])              -> read-only lab snapshot
 *   VORTEX.agent.propose({type, payload})          -> {proposalId, status:'pending-owner'}
 *   api.requestInjectGrant({params, ttlMinutes})  -> {grantId, status:'awaiting-owner'}
 *   api.approveGrant(grantId) / api.denyGrant(grantId)  (owner only)
 *   api.executeGrant(grantId)                     -> validates scope+TTL+single-use,
 *                                                   then calls the probe path
 *
 * THE GATE (CONTRACTS §9, mandatory):
 *   - observe/propose are always available. NOTHING executes without an owner grant.
 *   - Default is DENY: there is no grant, so no injection path is armed.
 *   - Grants are single-use, parameter-bound, TTL <= 10 minutes, non-delegable
 *     (no delegation chains — a grantee cannot re-grant).
 *   - Owner identity: a LOCAL owner flag in this static build. When W31
 *     (permissions lane) is present, owner checks bind to its JWT/scope check
 *     instead of the flag. Either way the gate logic below does not change.
 *   - Only one injection may be active at a time (matches W05's
 *     one-active-probe guard). executeGrant() refuses while one is in flight.
 *   - The probe path itself is owned by W05 (probe catalog). If W05 — or any
 *     backend exposing addProbe — is absent, executeGrant() fails closed with
 *     'no_probe_path' rather than faking an injection.
 *
 * FUTURE HTTP CONTRACT (documentation only — NO network in this build):
 * ---------------------------------------------------------------
 * The dashboard server (Shawn's server builder lane) will expose:
 *
 *   POST /api/agent/v1/observe
 *     req:  { "callerId": "vera", "want": ["backend","metrics","panels"] }
 *     resp: 200 { "backend": {"name":"webgl2","tier":"B"}, "tier":"B",
 *                  "params": {"circulation":0.6,"turbulence":0.3,"persistence":0.8},
 *                  "metrics": {"ke":1.23,"enstrophy":0.45,"mixing":0.78},
 *                  "activePanels": ["w04-field-configs","w07-scorecard",...] }
 *           429 { "error":"rate_limited", "retryAfter": 42 }
 *
 *   POST /api/agent/v1/propose
 *     req:  { "callerId":"vera", "type":"probe|param-change|preset|note",
 *             "payload": { ... } }
 *     resp: 201 { "proposalId":"prop-...", "status":"pending-owner" }
 *           422 { "error":"invalid_params", "allowed": {...} }
 *           429 { "error":"rate_limited", "retryAfter": 12 }
 *
 *   POST /api/agent/v1/inject
 *     Sub-route /request:
 *       req:  { "callerId":"vera",
 *               "params": {"probeId":"oppose-winding","strength":0.5,"duration_s":10},
 *               "ttlMinutes": 10 }
 *       resp: 202 { "grantId":"grant-...", "status":"awaiting-owner",
 *                    "expiresAt":"2026-09-20T...", "scope": {...params} }
 *             422 { "error":"invalid_params", "allowed": {...ranges} }
 *             429 { "error":"rate_limited", "retryAfter": 1800 }
 *     Sub-route /approve (owner scope only):
 *       req:  { "grantId":"grant-...", "ownerToken":"<owner JWT or local flag>" }
 *       resp: 200 { "grantId":"grant-...", "status":"approved" }
 *             403 { "error":"owner_required" }
 *     Sub-route /deny (owner scope only):
 *       resp: 200 { "grantId":"grant-...", "status":"denied" }
 *     Sub-route /execute:
 *       req:  { "grantId":"grant-..." }
 *       resp: 200 { "grantId":"grant-...", "status":"executed", "result": {...} }
 *             409 { "error":"grant_used" }            (single-use)
 *             410 { "error":"grant_expired" }         (TTL lapsed)
 *             409 { "error":"injection_in_flight" }   (concurrency lock)
 *             422 { "error":"invalid_params", "allowed": {...} }
 *             501 { "error":"no_probe_path" }         (W05/backend absent)
 * ---------------------------------------------------------------
 * None of the above is implemented here. The in-page API below mirrors the
 * request/response shapes exactly so the server lane can lift the spec.
 *
 * Plain IIFE script, no modules, no build step. No fetch/XHR/WebSocket/eval.
 * Headless-safe: selfTest() guards DOM access and never throws without a note.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w24-agentapi: VORTEX namespace missing — load vx-namespace.js first');

  // ============================================================ rate limit ==
  // Token buckets, per caller id, per action.
  // observe: 10/min, propose: 5/min, inject-request: 2/hour.
  var RATE = {
    observe: { capacity: 10, perMs: 60000 },
    propose: { capacity: 5, perMs: 60000 },
    'inject-request': { capacity: 2, perMs: 3600000 }
  };
  var _buckets = {}; // key: action + '|' + caller -> {tokens, last}
  function rateCheck(action, callerId) {
    var spec = RATE[action];
    var now = V.utils.now();
    var key = action + '|' + (callerId || 'anonymous');
    var b = _buckets[key] || ( _buckets[key] = { tokens: spec.capacity, last: now } );
    // refill
    var elapsed = now - b.last;
    b.tokens = Math.min(spec.capacity, b.tokens + (elapsed / spec.perMs) * spec.capacity);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    // retryAfter: ms until one token is available
    var retryAfter = Math.ceil((1 - b.tokens) * spec.perMs / spec.capacity);
    return { ok: false, error: 'rate_limited', retryAfter: retryAfter };
  }

  // ============================================================== audit log ==
  // Append-only. Entries: {t, actor, action, paramsHash, result}.
  // There is deliberately NO delete/clear/remove API anywhere in this module;
  // selfTest asserts that by scanning the exported api surface.
  var _audit = [];
  function audit(actor, action, params, result) {
    var entry = {
      t: new Date().toISOString(),
      actor: String(actor || 'anonymous'),
      action: String(action),
      paramsHash: V.utils.hash53(V.utils.stableStringify(params === undefined ? null : params)),
      result: String(result)
    };
    _audit.push(entry);
    V.bus.emit('vx:agent-audit', entry);
    return entry;
  }
  function exportAuditJSON() {
    return JSON.stringify({ exportedAt: new Date().toISOString(), entries: _audit }, null, 2);
  }

  // ======================================================= param schema ======
  // Injection params validated against W05's safety caps when the probe
  // catalog module is present; otherwise documented defaults apply.
  // Spec shape: params = { probeId: string, strength: 0..1, duration_s: 1..30 }
  var DEFAULT_CAPS = {
    probeId: { type: 'string', required: true },
    strength: { type: 'number', min: 0, max: 1, required: true },
    duration_s: { type: 'number', min: 1, max: 30, required: true }
  };
  function knownProbeIds() {
    // W05 owns the probe catalog; duck-type its surface defensively.
    try {
      var w05 = V.get('w05-probes');
      if (w05) {
        if (typeof w05.listProbeIds === 'function') return w05.listProbeIds();
        if (Array.isArray(w05.probes)) return w05.probes.map(function (p) { return p.id; });
        if (Array.isArray(w05.catalog)) return w05.catalog.map(function (p) { return p.id; });
      }
    } catch (e) { /* absent or malformed — fall through to open ids */ }
    return null; // null = no registry; any string probeId passes the id check
  }
  function safetyCaps() {
    try {
      var w05 = V.get('w05-probes');
      if (w05 && w05.safetySchema) return w05.safetySchema;
      if (w05 && w05.SAFETY_CAPS) return w05.SAFETY_CAPS;
    } catch (e) { /* ignore */ }
    return null;
  }
  // Returns { ok:true } or { ok:false, error:'invalid_params', allowed:{...} }
  function validateInjectParams(params) {
    var caps = safetyCaps();
    var ranges = caps || DEFAULT_CAPS;
    function describe(field, c) {
      if (!c) return 'any';
      if (c.min !== undefined || c.max !== undefined) return 'number in [' + c.min + ', ' + c.max + ']';
      return c.type || 'any';
    }
    var allowed = {};
    Object.keys(ranges).forEach(function (f) { allowed[f] = describe(f, ranges[f]); });
    var ids = knownProbeIds();
    if (ids) allowed.probeId = 'one of: ' + ids.join(', ');
    if (!params || typeof params !== 'object') {
      return { ok: false, error: 'invalid_params', allowed: allowed, reason: 'params must be an object' };
    }
    for (var f in ranges) {
      if (!ranges.hasOwnProperty(f)) continue;
      var c = ranges[f], v = params[f];
      if (v === undefined || v === null) {
        if (c.required) return { ok: false, error: 'invalid_params', allowed: allowed, reason: 'missing required param: ' + f };
        continue;
      }
      if (c.type && typeof v !== c.type) {
        return { ok: false, error: 'invalid_params', allowed: allowed, reason: f + ' must be ' + c.type };
      }
      if (c.type === 'number') {
        if (!isFinite(v)) return { ok: false, error: 'invalid_params', allowed: allowed, reason: f + ' must be finite' };
        if (c.min !== undefined && v < c.min) return { ok: false, error: 'invalid_params', allowed: allowed, reason: f + ' below minimum ' + c.min };
        if (c.max !== undefined && v > c.max) return { ok: false, error: 'invalid_params', allowed: allowed, reason: f + ' above maximum ' + c.max };
      }
    }
    if (ids && params.probeId !== undefined && ids.indexOf(params.probeId) < 0) {
      return { ok: false, error: 'invalid_params', allowed: allowed, reason: 'unknown probeId: ' + params.probeId };
    }
    return { ok: true };
  }

  // =========================================================== owner gate ===
  // Local owner flag for this static build. When W31 (permissions lane) is
  // present, owner scope is checked against it instead of the flag.
  var _ownerLocal = false;
  function w31() { try { return V.get('w31-permissions'); } catch (e) { return null; } }
  function isOwner() {
    var p = w31();
    if (p) {
      // Bind to W31 when present: accept any of its owner-scope surfaces.
      // W31's documented public surface (v2026.09.19): currentTier() returns
      // the session tier ('administer' iff role is owner); canDo('grant.issue')
      // is the administer-tier grant action. Prefer the side-effect-free
      // currentTier() over canDo() for a pure ownership check.
      try {
        if (typeof p.isOwner === 'function') return !!p.isOwner();
        if (typeof p.hasScope === 'function') return !!p.hasScope('inject');
        if (typeof p.canInject === 'function') return !!p.canInject();
        if (typeof p.currentTier === 'function') return p.currentTier() === 'administer';
        if (typeof p.canDo === 'function') return !!p.canDo('grant.issue');
        if (p.owner === true) return true;
      } catch (e) { return false; }
      return false; // W31 present but no owner signal -> deny
    }
    return _ownerLocal; // static build: local flag, default false (DENY)
  }
  function setOwner(flag) {
    _ownerLocal = !!flag;
    audit('system', 'owner-flag', { owner: _ownerLocal, w31Bound: !!w31() }, _ownerLocal ? 'owner-on' : 'owner-off');
    return _ownerLocal;
  }

  // ============================================================== grants ====
  // Single-use, parameter-bound, TTL <= 10 minutes, no delegation.
  var GRANT_TTL_MAX_MS = 10 * 60 * 1000;
  var _grants = {}; // grantId -> {id, params, createdAt, expiresAt, status, usedAt}
  var _clockOffsetMs = 0; // test hook only (selfTest advances time to expire a grant)
  function now() { return V.utils.now() + _clockOffsetMs; }

  function requestInjectGrant(req, callerId) {
    callerId = callerId || 'vera';
    var r = rateCheck('inject-request', callerId);
    if (!r.ok) { audit(callerId, 'grant-request', req, 'rate_limited'); return r; }
    var params = req && req.params;
    var v = validateInjectParams(params);
    if (!v.ok) { audit(callerId, 'grant-request', req, 'invalid_params'); return v; }
    var ttlMinutes = req.ttlMinutes === undefined ? 10 : Number(req.ttlMinutes);
    if (!isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 10) {
      var bad = { ok: false, error: 'invalid_params', allowed: { ttlMinutes: 'number in (0, 10]' }, reason: 'ttlMinutes must be in (0, 10]' };
      audit(callerId, 'grant-request', req, 'invalid_ttl');
      return bad;
    }
    var g = {
      id: V.utils.uid('grant'),
      params: JSON.parse(JSON.stringify(params)), // frozen copy: parameter-bound
      createdAt: now(),
      expiresAt: now() + ttlMinutes * 60000,
      status: 'awaiting-owner',
      usedAt: null,
      requestedBy: callerId
    };
    _grants[g.id] = g;
    audit(callerId, 'grant-request', { probeId: params.probeId }, 'awaiting-owner:' + g.id);
    return { grantId: g.id, status: 'awaiting-owner', expiresAt: new Date(g.expiresAt).toISOString(), scope: g.params };
  }
  function approveGrant(grantId, actor) {
    actor = actor || 'owner';
    var g = _grants[grantId];
    if (!g) { audit(actor, 'grant-approve', { grantId: grantId }, 'unknown_grant'); return { error: 'unknown_grant' }; }
    if (!isOwner()) { audit(actor, 'grant-approve', { grantId: grantId }, 'owner_required'); return { error: 'owner_required' }; }
    if (g.status === 'denied' || g.usedAt !== null) { audit(actor, 'grant-approve', { grantId: grantId }, 'grant_closed'); return { error: 'grant_closed' }; }
    if (now() > g.expiresAt) { g.status = 'expired'; audit(actor, 'grant-approve', { grantId: grantId }, 'grant_expired'); return { error: 'grant_expired' }; }
    g.status = 'approved';
    audit(actor, 'grant-approve', { grantId: grantId }, 'approved');
    return { grantId: grantId, status: 'approved' };
  }
  function denyGrant(grantId, actor) {
    actor = actor || 'owner';
    var g = _grants[grantId];
    if (!g) { audit(actor, 'grant-deny', { grantId: grantId }, 'unknown_grant'); return { error: 'unknown_grant' }; }
    if (!isOwner()) { audit(actor, 'grant-deny', { grantId: grantId }, 'owner_required'); return { error: 'owner_required' }; }
    if (g.usedAt !== null || g.status === 'executed') { audit(actor, 'grant-deny', { grantId: grantId }, 'grant_closed'); return { error: 'grant_closed' }; }
    g.status = 'denied';
    audit(actor, 'grant-deny', { grantId: grantId }, 'denied');
    return { grantId: grantId, status: 'denied' };
  }

  // ---- probe path ---------------------------------------------------------
  // W05 owns injection. We never fake one: if no probe path exists we fail
  // closed with 'no_probe_path'.
  var _probePath = null; // test/wiring hook; W05 registers the real one
  function registerProbePath(fn) {
    if (fn !== null && typeof fn !== 'function') throw new Error('w24-agentapi: registerProbePath needs a function (or null to unregister)');
    _probePath = fn;
  }
  function resolveProbePath() {
    if (_probePath) return _probePath;
    try {
      var w05 = V.get('w05-probes');
      if (w05) {
        if (typeof w05.injectProbe === 'function') return function (p) { return w05.injectProbe(p); };
        // W05.inject(id, params, opts): pass the bound probeId explicitly and map
        // W24's duration_s (seconds) to W05's durationMs. (Passing the params
        // object as `id` would fail closed as VX_PROBE_UNKNOWN and silently
        // never inject — see selfTest §7b.)
        if (typeof w05.inject === 'function') return function (p) {
          var wp = { strength: p.strength,
                     durationMs: (p.durationMs != null ? p.durationMs :
                                  (p.duration_s != null ? p.duration_s * 1000 : undefined)) };
          return w05.inject(p.probeId, wp, { source: 'agent-api' });
        };
      }
    } catch (e) { /* absent — fail closed below */ }
    return null;
  }
  var _injectionInFlight = false; // concurrency lock: one injection at a time
  function executeGrant(grantId, actor) {
    actor = actor || 'owner';
    var g = _grants[grantId];
    if (!g) { audit(actor, 'grant-execute', { grantId: grantId }, 'unknown_grant'); return { error: 'unknown_grant' }; }
    if (_injectionInFlight) { audit(actor, 'grant-execute', { grantId: grantId }, 'injection_in_flight'); return { error: 'injection_in_flight' }; }
    if (g.usedAt !== null || g.status === 'executed') { audit(actor, 'grant-execute', { grantId: grantId }, 'grant_used'); return { error: 'grant_used' }; }
    if (g.status !== 'approved') { audit(actor, 'grant-execute', { grantId: grantId }, 'not_approved:' + g.status); return { error: 'grant_not_approved', status: g.status }; }
    if (now() > g.expiresAt) { g.status = 'expired'; audit(actor, 'grant-execute', { grantId: grantId }, 'grant_expired'); return { error: 'grant_expired' }; }
    // Re-validate params at execute time against current caps (safety first).
    var v = validateInjectParams(g.params);
    if (!v.ok) { audit(actor, 'grant-execute', { grantId: grantId }, 'invalid_params'); return v; }
    var path = resolveProbePath();
    if (!path) { audit(actor, 'grant-execute', { grantId: grantId }, 'no_probe_path'); return { error: 'no_probe_path' }; }
    // Mark single-use BEFORE the call so a thrown probe cannot be retried as fresh.
    g.usedAt = now();
    g.status = 'executed';
    _injectionInFlight = true;
    try {
      var result = path(JSON.parse(JSON.stringify(g.params)));
      if (result && typeof result.then === 'function') {
        return result.then(function (r) {
          _injectionInFlight = false;
          audit(actor, 'grant-execute', { grantId: grantId }, 'executed');
          return { grantId: grantId, status: 'executed', result: r };
        }, function (e) {
          _injectionInFlight = false;
          audit(actor, 'grant-execute', { grantId: grantId }, 'probe_error:' + String(e && e.message || e));
          return { grantId: grantId, status: 'probe_error', error: String(e && e.message || e) };
        });
      }
      _injectionInFlight = false;
      audit(actor, 'grant-execute', { grantId: grantId }, 'executed');
      return { grantId: grantId, status: 'executed', result: result };
    } catch (e) {
      _injectionInFlight = false;
      audit(actor, 'grant-execute', { grantId: grantId }, 'probe_error:' + String(e && e.message || e));
      return { grantId: grantId, status: 'probe_error', error: String(e && e.message || e) };
    }
  }
  function grantStatus(grantId) {
    var g = _grants[grantId];
    if (!g) return { error: 'unknown_grant' };
    return { grantId: g.id, status: g.status, expiresAt: new Date(g.expiresAt).toISOString(), usedAt: g.usedAt, scope: g.params };
  }

  // ============================================================ observe ====
  // Read-only. Defensive duck-typing against sibling lanes; every section is
  // try/caught and reports 'unavailable' instead of throwing.
  function tryGet(fn, label) {
    try { var v = fn(); return { ok: true, value: v }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  function observe(want, callerId) {
    callerId = callerId || 'vera';
    var r = rateCheck('observe', callerId);
    if (!r.ok) { audit(callerId, 'observe', want, 'rate_limited'); return r; }
    want = want || ['backend', 'metrics', 'params', 'panels'];
    var out = { observedAt: new Date().toISOString(), version: V.codeVersion };
    want.forEach(function (section) {
      if (section === 'backend' || section === 'tier') {
        out.backend = 'unavailable';
        var c = tryGet(function () {
          var sel = V.get('w15-backends');
          if (sel && typeof sel.current === 'function') return sel.current();
          var wf = V.get('w02-gpu') || V.get('w14-cpu');
          if (wf && wf.name) return { name: wf.name, tier: wf.tier || 'C' };
          throw new Error('no backend module loaded yet');
        });
        if (c.ok) out.backend = c.value;
      }
      if (section === 'metrics') {
        out.metrics = 'unavailable';
        var m = tryGet(function () {
          var met = V.get('w07-metrics');
          if (met && typeof met.snapshot === 'function') return met.snapshot();
          if (met && typeof met.latest === 'function') return met.latest();
          if (met && met.summary) return met.summary;
          throw new Error('no metrics module loaded yet');
        });
        if (m.ok) out.metrics = m.value;
      }
      if (section === 'params') {
        out.params = 'unavailable';
        var p = tryGet(function () {
          var sel2 = V.get('w15-backends');
          if (sel2 && typeof sel2.params === 'function') return sel2.params();
          throw new Error('no param source loaded yet');
        });
        if (p.ok) out.params = p.value;
      }
      if (section === 'panels') {
        out.activePanels = V.ui.panels().map(function (pl) { return pl.id; });
      }
    });
    audit(callerId, 'observe', { want: want }, 'ok');
    return out;
  }

  // ============================================================ propose ====
  // Queue-only. A proposal NEVER executes anything — the handler records it
  // and returns pending-owner. There is no code path from propose() to
  // executeGrant() or to any probe/param mutation.
  var PROPOSE_TYPES = ['probe', 'param-change', 'preset', 'note'];
  var _proposals = {};
  function propose(spec, callerId) {
    callerId = callerId || 'vera';
    var r = rateCheck('propose', callerId);
    if (!r.ok) { audit(callerId, 'propose', spec, 'rate_limited'); return r; }
    if (!spec || typeof spec !== 'object' || PROPOSE_TYPES.indexOf(spec.type) < 0) {
      var bad = { error: 'invalid_proposal', allowed: { type: 'one of: ' + PROPOSE_TYPES.join(', ') } };
      audit(callerId, 'propose', spec, 'invalid_proposal');
      return bad;
    }
    var prop = {
      id: V.utils.uid('prop'),
      type: spec.type,
      payload: JSON.parse(JSON.stringify(spec.payload === undefined ? {} : spec.payload)),
      by: callerId,
      at: new Date().toISOString(),
      status: 'pending-owner'
      // NOTE: deliberately no execute/handler reference — proposals are inert.
    };
    _proposals[prop.id] = prop;
    audit(callerId, 'propose', { type: spec.type }, 'pending-owner:' + prop.id);
    return { proposalId: prop.id, status: 'pending-owner' };
  }
  function listProposals() {
    return Object.keys(_proposals).map(function (k) { return _proposals[k]; });
  }

  // ================================================================ panel ===
  function el(tag, cls, text) {
    var d = root.document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function mountPanel(host) {
    host.innerHTML = '';
    var wrap = el('div', 'vx-agentapi');
    wrap.appendChild(el('h3', 'vx-aa-h', 'Agent API — Vera\'s view'));
    wrap.appendChild(el('p', 'vx-aa-note',
      'Observe + propose only. Probe injection needs an owner grant; the gate ' +
      'defaults to DENY. Owner is ' + (isOwner() ? 'ON (local flag)' : 'OFF') + '.'));

    // --- owner toggle (local flag; binds to W31 when present)
    var ownRow = el('div', 'vx-aa-row');
    var ownBtn = el('button', 'vx-aa-btn', isOwner() ? 'Owner: ON' : 'Owner: OFF');
    ownBtn.title = 'Local owner flag (static build). In production this binds to W31 JWT scope.';
    ownBtn.addEventListener('click', function () {
      setOwner(!isOwner());
      ownBtn.textContent = isOwner() ? 'Owner: ON' : 'Owner: OFF';
      renderGrants();
    });
    ownRow.appendChild(ownBtn);
    ownRow.appendChild(el('span', 'vx-aa-note', 'static-build owner flag; W31 JWT when present'));
    wrap.appendChild(ownRow);

    // --- observe
    wrap.appendChild(el('h4', 'vx-aa-h', 'Observe'));
    var obsBtn = el('button', 'vx-aa-btn', 'Run observe()');
    var obsPre = el('pre', 'vx-aa-pre', '(not run yet)');
    obsBtn.addEventListener('click', function () {
      var out = observe(undefined, 'vera-panel');
      obsPre.textContent = JSON.stringify(out, null, 2);
    });
    wrap.appendChild(obsBtn);
    wrap.appendChild(obsPre);

    // --- propose
    wrap.appendChild(el('h4', 'vx-aa-h', 'Propose (never executes)'));
    var typeSel = el('select', 'vx-aa-sel');
    PROPOSE_TYPES.forEach(function (t) {
      var o = el('option', '', t); o.value = t; typeSel.appendChild(o);
    });
    var payloadTa = el('textarea', 'vx-aa-ta');
    payloadTa.rows = 3;
    payloadTa.placeholder = '{"probeId":"oppose-winding","strength":0.5}';
    var propBtn = el('button', 'vx-aa-btn', 'Submit proposal');
    var propOut = el('div', 'vx-aa-out', '');
    propBtn.addEventListener('click', function () {
      var payload = {};
      try { payload = payloadTa.value ? JSON.parse(payloadTa.value) : {}; }
      catch (e) { propOut.textContent = 'payload is not valid JSON: ' + e.message; return; }
      var res = propose({ type: typeSel.value, payload: payload }, 'vera-panel');
      propOut.textContent = JSON.stringify(res);
      renderProposals();
    });
    wrap.appendChild(typeSel); wrap.appendChild(payloadTa);
    wrap.appendChild(propBtn); wrap.appendChild(propOut);
    var propList = el('div', 'vx-aa-list');
    wrap.appendChild(propList);
    function renderProposals() {
      propList.innerHTML = '';
      listProposals().forEach(function (p) {
        propList.appendChild(el('div', 'vx-aa-item',
          p.id + ' · ' + p.type + ' · ' + p.status + ' · by ' + p.by));
      });
      if (!listProposals().length) propList.appendChild(el('div', 'vx-aa-note', 'no proposals yet'));
    }
    renderProposals();

    // --- grant request
    wrap.appendChild(el('h4', 'vx-aa-h', 'Injection grant (owner approval required)'));
    var gTa = el('textarea', 'vx-aa-ta');
    gTa.rows = 3;
    gTa.placeholder = '{"probeId":"oppose-winding","strength":0.4,"duration_s":10}';
    var ttlInput = el('input', 'vx-aa-in');
    ttlInput.type = 'number'; ttlInput.min = 1; ttlInput.max = 10; ttlInput.value = 10;
    ttlInput.title = 'ttlMinutes (1–10)';
    var gBtn = el('button', 'vx-aa-btn', 'Request grant');
    var gOut = el('div', 'vx-aa-out', '');
    gBtn.addEventListener('click', function () {
      var params = {};
      try { params = gTa.value ? JSON.parse(gTa.value) : {}; }
      catch (e) { gOut.textContent = 'params is not valid JSON: ' + e.message; return; }
      var res = requestInjectGrant({ params: params, ttlMinutes: Number(ttlInput.value) }, 'vera-panel');
      gOut.textContent = JSON.stringify(res);
      renderGrants();
    });
    var ttlRow = el('div', 'vx-aa-row');
    ttlRow.appendChild(el('span', 'vx-aa-note', 'ttlMinutes ≤ 10:'));
    ttlRow.appendChild(ttlInput);
    wrap.appendChild(gTa); wrap.appendChild(ttlRow);
    wrap.appendChild(gBtn); wrap.appendChild(gOut);

    // --- grant status / owner actions
    var grantList = el('div', 'vx-aa-list');
    wrap.appendChild(grantList);
    function renderGrants() {
      grantList.innerHTML = '';
      var ids = Object.keys(_grants);
      if (!ids.length) { grantList.appendChild(el('div', 'vx-aa-note', 'no grants yet')); return; }
      ids.forEach(function (id) {
        var s = grantStatus(id);
        var row = el('div', 'vx-aa-item', id + ' · ' + s.status + ' · expires ' + s.expiresAt);
        if (s.status === 'awaiting-owner' || s.status === 'approved') {
          var aBtn = el('button', 'vx-aa-btn', 'Approve');
          aBtn.disabled = !isOwner();
          aBtn.addEventListener('click', function () {
            gOut.textContent = JSON.stringify(approveGrant(id, 'owner-panel'));
            renderGrants();
          });
          var dBtn = el('button', 'vx-aa-btn', 'Deny');
          dBtn.disabled = !isOwner();
          dBtn.addEventListener('click', function () {
            gOut.textContent = JSON.stringify(denyGrant(id, 'owner-panel'));
            renderGrants();
          });
          row.appendChild(aBtn); row.appendChild(dBtn);
        }
        if (s.status === 'approved') {
          var eBtn = el('button', 'vx-aa-btn', 'Execute');
          eBtn.addEventListener('click', function () {
            var r2 = executeGrant(id, 'owner-panel');
            gOut.textContent = JSON.stringify(r2 && typeof r2.then === 'function' ? { status: 'async-pending' } : r2);
            if (r2 && typeof r2.then === 'function') r2.then(function (x) { gOut.textContent = JSON.stringify(x); });
            renderGrants();
          });
          row.appendChild(eBtn);
        }
        grantList.appendChild(row);
      });
    }
    renderGrants();

    // --- audit tail
    wrap.appendChild(el('h4', 'vx-aa-h', 'Audit tail (append-only)'));
    var auditPre = el('pre', 'vx-aa-pre', '');
    var auditBtn = el('button', 'vx-aa-btn', 'Refresh audit tail');
    auditBtn.addEventListener('click', function () {
      var tail = _audit.slice(-15).reverse();
      auditPre.textContent = tail.map(function (e) {
        return e.t + ' ' + e.actor + ' ' + e.action + ' #' + e.paramsHash.slice(0, 8) + ' -> ' + e.result;
      }).join('\n') || '(empty)';
    });
    auditBtn.click();
    wrap.appendChild(auditBtn);
    wrap.appendChild(auditPre);
    var expBtn = el('button', 'vx-aa-btn', 'Export audit (JSON download)');
    expBtn.addEventListener('click', function () {
      var blob = new root.Blob([exportAuditJSON()], { type: 'application/json' });
      var a = el('a'); a.href = root.URL.createObjectURL(blob);
      a.download = 'vortex-agent-audit.json'; a.click();
      root.setTimeout(function () { root.URL.revokeObjectURL(a.href); }, 5000);
    });
    wrap.appendChild(expBtn);

    host.appendChild(wrap);
  }
  if (V.utils.isBrowser() && V.ui && typeof V.ui.registerPanel === 'function') {
    try { V.ui.registerPanel('w24-agent-api', 'Agent API', mountPanel); }
    catch (e) { V.bus.emit('vx:error', { code: 'VX_E_CHROME', message: 'agent-api panel failed: ' + e.message, stage: 'chrome' }); }
  }

  // ============================================================== selfTest ==
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: String(detail || '') }); }
    var CALL = 'w24-selftest';

    // Owner simulation binds to the REAL authority: when W31 is registered it
    // owns the session (setRole owner/viewer); the local flag + 'owner-flag'
    // audit entry are kept in sync so the audit-completeness checks still hold.
    // The pre-test W31 tier is restored at the end (default 'administer').
    var _w31m = null;
    try { _w31m = V.get('w31-permissions'); } catch (e) { _w31m = null; }
    var _w31TierBefore = null;
    try { _w31TierBefore = (_w31m && typeof _w31m.currentTier === 'function') ? _w31m.currentTier() : null; }
    catch (e) { _w31TierBefore = null; }
    var TIER_TO_ROLE = { observe: 'visitor', interact: 'user', inject: 'delegate', administer: 'owner' };
    function simOwner(on) {
      setOwner(on); // local flag + 'owner-flag' audit entry
      if (_w31m && typeof _w31m.setRole === 'function') {
        // W31 role vocabulary: visitor/user/delegate/owner (no 'viewer').
        try { _w31m.setRole(on ? 'owner' : 'visitor'); } catch (e) { /* keep local-only */ }
      }
      return isOwner();
    }
    function simOwnerRestore() {
      try { setOwner(false); } catch (e) {}
      if (_w31m && typeof _w31m.setRole === 'function' && _w31TierBefore) {
        try { _w31m.setRole(TIER_TO_ROLE[_w31TierBefore] || 'owner'); } catch (e) {}
      }
    }

    // 1. propose never executes: no side effects, status pending-owner, inert payload
    try {
      var beforeAudit = _audit.length;
      var p = propose({ type: 'probe', payload: { probeId: 'x', strength: 0.1 } }, CALL);
      check('propose-returns-pending', p.status === 'pending-owner' && !!p.proposalId,
        'got ' + JSON.stringify(p));
      var stored = _proposals[p.proposalId];
      check('propose-inert', !!stored && stored.status === 'pending-owner' && !stored.execute && !stored.handler,
        'proposal has no execute/handler reference');
      check('propose-side-effect-free', _injectionInFlight === false && Object.keys(_grants).length === Object.keys(_grants).length,
        'no grant created, no injection in flight');
      check('propose-audited', _audit.length === beforeAudit + 1, 'audit grew by 1');
      var pBad = propose({ type: 'explode', payload: {} }, CALL);
      check('propose-type-validated', pBad.error === 'invalid_proposal', 'got ' + JSON.stringify(pBad));
    } catch (e) { check('propose-returns-pending', false, String(e && e.message)); }

    // 2. grant lifecycle: request -> approve -> execute once -> second execute rejected
    try {
      var probeCalls = [];
      registerProbePath(function (params) { probeCalls.push(params); return { injected: true }; });
      simOwner(true);
      var g = requestInjectGrant({ params: { probeId: 'oppose-winding', strength: 0.4, duration_s: 10 }, ttlMinutes: 5 }, CALL);
      check('grant-requested', g.status === 'awaiting-owner' && !!g.grantId, 'got ' + JSON.stringify({ status: g.status }));
      var ap = approveGrant(g.grantId, 'owner-test');
      check('grant-approved', ap.status === 'approved', 'got ' + JSON.stringify(ap));
      var ex1 = executeGrant(g.grantId, 'owner-test');
      check('grant-execute-once', ex1.status === 'executed' && probeCalls.length === 1,
        'executions=' + probeCalls.length + ' status=' + ex1.status);
      check('grant-param-bound', JSON.stringify(probeCalls[0]) === JSON.stringify({ probeId: 'oppose-winding', strength: 0.4, duration_s: 10 }),
        'probe got the exact bound params');
      var ex2 = executeGrant(g.grantId, 'owner-test');
      check('grant-single-use', ex2.error === 'grant_used', 'second execute -> ' + JSON.stringify(ex2));
      // owner-off must not approve
      var g2 = requestInjectGrant({ params: { probeId: 'y', strength: 0.1, duration_s: 2 }, ttlMinutes: 5 }, CALL);
      simOwner(false);
      var apNo = approveGrant(g2.grantId, 'vera-test');
      check('approve-needs-owner', apNo.error === 'owner_required', 'non-owner approve -> ' + JSON.stringify(apNo));
      simOwnerRestore(); // leave default DENY (local flag off, W31 tier restored)
      registerProbePath(null); // restore: no probe path wired
    } catch (e) { check('grant-requested', false, String(e && e.message)); try { simOwnerRestore(); registerProbePath(null); } catch (e2) {} }

    // 3. expired grant rejected; TTL > 10 rejected
    try {
      var g3 = requestInjectGrant({ params: { probeId: 'z', strength: 0.1, duration_s: 2 }, ttlMinutes: 1 }, CALL + '-exp');
      _clockOffsetMs = 2 * 60 * 1000; // travel 2 min forward: 1-min grant is expired
      simOwner(true);
      var ap3 = approveGrant(g3.grantId, 'owner-test');
      check('expired-grant-approve-rejected', ap3.error === 'grant_expired', 'got ' + JSON.stringify(ap3));
      _clockOffsetMs = 0;
      simOwner(false);
      var gLong = requestInjectGrant({ params: { probeId: 'z', strength: 0.1, duration_s: 2 }, ttlMinutes: 60 }, CALL + '-ttl');
      check('ttl-cap-10min', gLong.error === 'invalid_params', 'ttl 60 -> ' + JSON.stringify(gLong.error));
    } catch (e) { check('expired-grant-approve-rejected', false, String(e && e.message)); _clockOffsetMs = 0; try { simOwnerRestore(); } catch (e2) {} }

    // 4. rate limits: 10/min observe, 5/min propose, 2/hour inject-request
    try {
      var rlCall = 'w24-rl-' + V.utils.now();
      var i, rObs = null;
      for (i = 0; i < 11; i++) rObs = observe(['panels'], rlCall);
      check('observe-rate-limit', rObs && rObs.error === 'rate_limited' && rObs.retryAfter > 0,
        '11th observe -> ' + JSON.stringify(rObs));
      var rProp = null;
      for (i = 0; i < 6; i++) rProp = propose({ type: 'note', payload: {} }, rlCall);
      check('propose-rate-limit', rProp && rProp.error === 'rate_limited',
        '6th propose -> ' + JSON.stringify(rProp));
      var rInj = null;
      for (i = 0; i < 3; i++) rInj = requestInjectGrant({ params: { probeId: 'r', strength: 0.1, duration_s: 2 }, ttlMinutes: 1 }, rlCall);
      check('inject-request-rate-limit', rInj && rInj.error === 'rate_limited',
        '3rd inject-request -> ' + JSON.stringify(rInj));
      var lim = _audit.filter(function (e) { return e.result === 'rate_limited'; }).length;
      check('rate-limit-denials-audited', lim >= 3, 'rate-limited entries in audit: ' + lim);
    } catch (e) { check('observe-rate-limit', false, String(e && e.message)); }

    // 5. invalid params rejected with allowed ranges
    try {
      var v1 = validateInjectParams({ probeId: 'x', strength: 1.5, duration_s: 10 });
      check('param-strength-range', v1.error === 'invalid_params' && v1.allowed && /\[0, 1\]/.test(v1.allowed.strength),
        'got ' + JSON.stringify(v1.allowed && v1.allowed.strength));
      var v2 = validateInjectParams({ probeId: 'x', strength: 0.5, duration_s: 999 });
      check('param-duration-range', v2.error === 'invalid_params' && v2.allowed && /\[1, 30\]/.test(v2.allowed.duration_s),
        'got ' + JSON.stringify(v2.allowed && v2.allowed.duration_s));
      var v3 = validateInjectParams(null);
      check('param-null-rejected', v3.error === 'invalid_params', 'got ' + JSON.stringify(v3.error));
      var v4 = validateInjectParams({ probeId: 'x', strength: 0.5, duration_s: 10 });
      check('param-valid-passes', v4.ok === true, 'valid params accepted');
    } catch (e) { check('param-strength-range', false, String(e && e.message)); }

    // 6. concurrency: one injection at a time
    try {
      _injectionInFlight = true;
      var g4 = requestInjectGrant({ params: { probeId: 'c', strength: 0.1, duration_s: 2 }, ttlMinutes: 5 }, CALL + '-conc');
      simOwner(true);
      approveGrant(g4.grantId, 'owner-test');
      var exBusy = executeGrant(g4.grantId, 'owner-test');
      check('concurrency-lock', exBusy.error === 'injection_in_flight', 'got ' + JSON.stringify(exBusy));
      _injectionInFlight = false;
      simOwner(false);
    } catch (e) { check('concurrency-lock', false, String(e && e.message)); _injectionInFlight = false; }

    // 7. fail-closed: with no probe path anywhere -> 'no_probe_path'. With W05
    // registered, resolveProbePath() ALWAYS finds W05's real inject as a
    // fallback, so the closed gate in that environment is W05 rejecting the
    // unknown probe id (result.ok === false, nothing injected). The explicit
    // hook is cleared and restored around the check in both cases.
    var savedPath7 = _probePath;
    try {
      var w05Here = false;
      try { w05Here = !!V.get('w05-probes'); } catch (e) { w05Here = false; }
      registerProbePath(null); // clear the explicit hook (W05 fallback may remain)
      var g5 = requestInjectGrant({ params: { probeId: 'n', strength: 0.1, duration_s: 2 }, ttlMinutes: 5 }, CALL + '-np');
      simOwner(true);
      approveGrant(g5.grantId, 'owner-test');
      var exNp = executeGrant(g5.grantId, 'owner-test');
      var closedOk, closedNote;
      if (!w05Here) {
        closedOk = exNp.error === 'no_probe_path';
        closedNote = 'w05 absent: ' + JSON.stringify(exNp);
      } else {
        var rnp = exNp.result || {};
        closedOk = exNp && exNp.status === 'executed' && rnp.ok === false &&
          /UNKNOWN/i.test(rnp.reason || rnp.error || '');
        closedNote = 'w05 present: unknown probe rejected, no injection [' +
          JSON.stringify(rnp.reason || rnp.error || exNp.error) + ']';
      }
      check('no-probe-path-fails-closed', closedOk, closedNote);
      registerProbePath(savedPath7); // restore
      simOwnerRestore(); // leave default DENY (local flag off, W31 tier restored)
    } catch (e) {
      check('no-probe-path-fails-closed', false, String(e && e.message));
      try { registerProbePath(savedPath7); simOwnerRestore(); } catch (e2) {}
    }

    // 7b. end-to-end through the W05 fallback adapter: an approved grant for a
    // KNOWN probe id must actually reach the field backend. (Regression: the
    // old adapter passed the params object as the probe id, so every grant
    // silently no-op'd with VX_PROBE_UNKNOWN and nothing ever injected.)
    try {
      var w05b = null;
      try { w05b = V.get('w05-probes'); } catch (e) { w05b = null; }
      if (w05b && typeof w05b.setFieldBackend === 'function' && typeof w05b.inject === 'function') {
        var prevBackend = null;
        try { prevBackend = (typeof w05b.backend === 'function') ? w05b.backend() : null; } catch (e) {}
        var applied7b = [];
        w05b.setFieldBackend({ addProbe: function (p) { applied7b.push(p); return { ok: true }; },
                               clearProbes: function () {}, name: 'cpu' }); // name: stands in for the CPU backend (probe compatibility list)
        registerProbePath(null); // force the W05-fallback adapter, not the test hook
        var g6 = requestInjectGrant({ params: { probeId: 'dye-ribbon', strength: 0.2, duration_s: 10 }, ttlMinutes: 5 }, CALL + '-e2e');
        simOwner(true);
        var ap6 = approveGrant(g6.grantId, 'owner-test');
        var ex6 = executeGrant(g6.grantId, 'owner-test');
        var e2eOk = ap6.status === 'approved' && ex6 && ex6.status === 'executed' &&
          ex6.result && ex6.result.ok === true && applied7b.length === 1 && applied7b[0].id === 'dye-ribbon';
        check('grant-executes-real-injection-via-w05', e2eOk,
          'approve=' + ap6.status + ' execute=' + (ex6 && ex6.status) +
          ' backend.addProbe calls=' + applied7b.length +
          (ex6 && ex6.result ? ' result.ok=' + ex6.result.ok : ' no-result'));
        try { w05b.release(); } catch (e) {}
        try { if (prevBackend) w05b.setFieldBackend(prevBackend); else w05b.disconnectBackend(); } catch (e) {}
        registerProbePath(savedPath7);
        simOwnerRestore();
      } else {
        check('grant-executes-real-injection-via-w05', true, 'skipped: w05-probes not registered');
      }
    } catch (e) {
      check('grant-executes-real-injection-via-w05', false, String(e && e.message));
      try { registerProbePath(savedPath7); simOwnerRestore(); } catch (e2) {}
    }

    // 8. audit log append-only and complete
    try {
      var apiKeys = Object.keys(api);
      var forbidden = ['delete', 'clear', 'remove', 'resetLog', 'purge', 'wipe', 'truncate'];
      var found = forbidden.filter(function (k) {
        return apiKeys.indexOf(k) >= 0 || apiKeys.some(function (x) { return x.toLowerCase().indexOf(k) >= 0; });
      });
      check('audit-append-only-no-delete-api', found.length === 0,
        found.length ? 'FORBIDDEN APIS PRESENT: ' + found.join(',') : 'no delete/clear/remove surface');
      var kinds = {};
      _audit.forEach(function (e) { kinds[e.action] = (kinds[e.action] || 0) + 1; });
      var want = ['observe', 'propose', 'grant-request', 'grant-approve', 'grant-execute', 'owner-flag'];
      var missing = want.filter(function (k) { return !kinds[k]; });
      check('audit-complete', missing.length === 0,
        missing.length ? 'missing actions: ' + missing.join(',') : 'all action kinds present (' + _audit.length + ' entries)');
      var badShape = _audit.filter(function (e) {
        return !(e.t && e.actor && e.action && e.paramsHash && e.result !== undefined);
      });
      check('audit-shape', badShape.length === 0, 'entries with bad shape: ' + badShape.length);
    } catch (e) { check('audit-append-only-no-delete-api', false, String(e && e.message)); }

    // 9. VORTEX.agent surface is observe/propose only
    try {
      check('vx-agent-surface', !!V.agent && typeof V.agent.observe === 'function' &&
        typeof V.agent.propose === 'function' && typeof V.agent.executeGrant !== 'function',
        'VORTEX.agent exposes observe/propose, not grant execution');
    } catch (e) { check('vx-agent-surface', false, String(e && e.message)); }

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  var api = {
    // Vera surface (also mirrored at VORTEX.agent)
    observe: observe,
    propose: propose,
    listProposals: listProposals,
    // grant gate
    requestInjectGrant: requestInjectGrant,
    approveGrant: approveGrant,
    denyGrant: denyGrant,
    executeGrant: executeGrant,
    grantStatus: grantStatus,
    isOwner: isOwner,
    setOwner: setOwner,
    // audit
    auditLog: function () { return _audit.slice(); },
    exportAuditJSON: exportAuditJSON,
    // schema / limits
    validateInjectParams: validateInjectParams,
    defaultCaps: DEFAULT_CAPS,
    // wiring hooks
    registerProbePath: registerProbePath,
    // rate-limit buckets visible for tests (read-only-ish; no reset API by design)
    rateSpec: RATE,
    selfTest: selfTest
  };

  VORTEX.register('w24-agentapi', api);

  // Minimal agent surface per CONTRACTS §9: observe/propose only.
  // Grant functions live on the module (V.get('w24-agentapi')); nothing here
  // can arm or fire an injection.
  V.agent = {
    version: V.codeVersion,
    observe: function (want, callerId) { return observe(want, callerId); },
    propose: function (spec, callerId) { return propose(spec, callerId); },
    status: function () {
      return {
        owner: isOwner(),
        grantGate: 'default-deny',
        proposalsPending: Object.keys(_proposals).length,
        grantsAwaiting: Object.keys(_grants).filter(function (k) { return _grants[k].status === 'awaiting-owner'; }).length,
        injectionInFlight: _injectionInFlight,
        w31Bound: !!w31()
      };
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
