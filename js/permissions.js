/* VORTEX js/permissions.js — [W31] permission tiers, delegated grants,
 * hash-chained audit ledger, kill-switch.
 *
 * DOCUMENTED SCOPE (client-side enforcement only):
 *  - This is the LAB build's in-page enforcement. The dashboard server
 *    MUST re-check every tier decision server-side before touching
 *    shared state. Nothing here substitutes for server auth.
 *  - Local role defaults to 'owner' because this drop-in build has a
 *    single local user and no auth backend. The dashboard will replace
 *    resolveRole() with real session/auth and MUST NOT keep the
 *    default-owner shortcut.
 *  - Grant signatures are hash53 over a per-session secret. That is
 *    tamper-evidence for the lab session, not cryptography. Real HMAC
 *    belongs server-side; a JWT issued by the server replaces the grant
 *    object shape (same fields, HS256, server-held key).
 *  - CONTRACTS §9: agent injection default DENY. Money: paper only.
 *
 * Tiers (ascending): observe < interact < inject < administer
 *  - observe:    anyone incl. signed-out — view field, metrics, evidence,
 *                move camera
 *  - interact:   signed-in — sliders, staged probes, snapshots
 *                (private sandbox only; lab build treats local as sandbox)
 *  - inject:    owner OR a delegated 6h grant (JWT shape), NO chains
 *  - administer: Shawn only — issue/revoke grants, kill-switch, verdicts
 *
 * Plain script, IIFE, no modules. Headless-safe (node): all DOM guarded.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || !V.register) throw new Error('w31-permissions: VORTEX namespace missing');

  var U = V.utils;

  // ---------------------------------------------------------------- tiers
  var TIERS = ['observe', 'interact', 'inject', 'administer'];
  function rank(t) { return TIERS.indexOf(t); }

  // action -> minimum tier required
  var ACTION_TIERS = {
    // observe
    'field.view': 'observe',
    'metrics.view': 'observe',
    'evidence.view': 'observe',
    'camera.move': 'observe',
    // interact
    'sliders.set': 'interact',
    'probe.stage': 'interact',
    'snapshot.take': 'interact',
    'snapshot.restore': 'interact',
    // inject
    'probe.inject': 'inject',
    'params.commit': 'inject',
    // administer (Shawn only)
    'grant.issue': 'administer',
    'grant.revoke': 'administer',
    'killswitch.revokeAll': 'administer',
    'verdict.record': 'administer'
  };

  // roles -> tier. 'owner' = Shawn for this drop-in build.
  var ROLE_TIERS = {
    visitor: 'observe',   // signed-out
    user: 'interact',     // signed-in
    delegate: 'inject',   // holds a valid grant (tier enforced per-action)
    owner: 'administer'    // Shawn
  };

  // ---------------------------------------------------------------- session
  // Per-session secret: tamper-evidence only, NOT a real credential.
  // Resets every page load. Real HMAC lives server-side.
  var _secret = 'vx-lab-' + Date.now().toString(36) + '-' +
    Math.floor(U.mulberry32((Date.now() % 100000) | 0)() * 1e9).toString(36);

  var _session = {
    role: 'owner',      // lab-build default; dashboard replaces with real auth
    mode: 'lab',        // 'lab' | 'observatory'
    actor: 'owner'
  };

  function _queryMode() {
    try {
      if (root.location && root.location.search) {
        var m = /[?&]mode=([a-z]+)/.exec(root.location.search);
        if (m) return m[1];
      }
    } catch (e) { /* headless / file:// edge */ }
    return null;
  }
  if (_queryMode() === 'observatory') {
    _session.mode = 'observatory';
    _session.role = 'visitor';
    _session.actor = 'visitor';
  }

  function currentTier() {
    if (_session.mode === 'observatory') return 'observe'; // observatory caps all
    return ROLE_TIERS[_session.role] || 'observe';
  }

  // ---------------------------------------------------------------- grants
  // Delegated inject grant shape:
  //   { grantId, scope:{params}, ttlHours:6, issuer:'owner', chain:[], issuedAt, signature }
  var GRANT_TTL_HOURS = 6;
  var _grants = {}; // grantId -> stored (copied) grant

  function _grantDigest(g) {
    return U.hash53(U.stableStringify({
      grantId: g.grantId,
      scope: g.scope || {},
      ttlHours: g.ttlHours,
      issuer: g.issuer,
      chain: g.chain || [],
      issuedAt: g.issuedAt
    }) + '|' + _secret);
  }

  function _copy(o) {
    return JSON.parse(U.stableStringify(o));
  }

  function issueGrant(scopeParams, opts) {
    opts = opts || {};
    if (rank(currentTier()) < rank('administer')) {
      return _deny('grant.issue', scopeParams, 'not-owner');
    }
    var g = {
      grantId: U.uid('grant'),
      scope: { params: scopeParams || {} },
      ttlHours: (typeof opts.ttlHours === 'number') ? opts.ttlHours : GRANT_TTL_HOURS,
      issuer: _session.actor || 'owner',
      chain: [],
      issuedAt: Date.now()
    };
    g.signature = _grantDigest(g);
    _grants[g.grantId] = _copy(g);
    _log(_session.actor, 'grant.issue',
      { grantId: g.grantId, ttlHours: g.ttlHours }, 'allowed');
    return { ok: true, grant: g };
  }

  function validateGrant(g) {
    if (!g || typeof g !== 'object' || typeof g.grantId !== 'string') {
      return { ok: false, reason: 'not-a-grant' };
    }
    if (!_grants[g.grantId]) return { ok: false, reason: 'revoked-or-unknown' };
    if (Array.isArray(g.chain) && g.chain.length > 0) {
      return { ok: false, reason: 'chain-rejected' }; // delegation chains forbidden
    }
    var ttl = (typeof g.ttlHours === 'number' ? g.ttlHours : GRANT_TTL_HOURS) * 3600e3;
    if (Date.now() - (g.issuedAt || 0) > ttl) return { ok: false, reason: 'expired' };
    if (_grantDigest(g) !== g.signature) return { ok: false, reason: 'tampered' };
    return { ok: true };
  }

  function revokeGrant(grantId) {
    if (rank(currentTier()) < rank('administer')) {
      return _deny('grant.revoke', { grantId: grantId }, 'not-owner');
    }
    var existed = !!_grants[grantId];
    delete _grants[grantId];
    _log(_session.actor, 'grant.revoke', { grantId: grantId }, existed ? 'allowed' : 'not-found');
    V.bus.emit('vx:revoked', { grants: existed ? [grantId] : [], by: _session.actor });
    return { ok: true, revoked: existed };
  }

  // One-click kill-switch: invalidates EVERY grant, announces on the bus.
  function revokeAll() {
    if (rank(currentTier()) < rank('administer')) {
      return _deny('killswitch.revokeAll', {}, 'not-owner');
    }
    var ids = Object.keys(_grants);
    _grants = {};
    _log(_session.actor, 'killswitch.revokeAll', { grantsRevoked: ids }, 'allowed');
    V.bus.emit('vx:revoked', { grants: ids, by: _session.actor, all: true, t: Date.now() });
    return { ok: true, revoked: ids.length };
  }

  // ---------------------------------------------------------------- audit ledger
  // Hash-chained append-only ledger. Every inject-tier action (allowed or
  // denied) and every denied attempt at ANY tier lands here.
  var GENESIS = 'GENESIS';
  var _ledger = [];

  function _digest(e) {
    return U.hash53(U.stableStringify({
      t: e.t, actor: e.actor, action: e.action,
      paramsHash: e.paramsHash, result: e.result, prevHash: e.prevHash
    }));
  }

  function _log(actor, action, params, result) {
    var prevHash = _ledger.length ? _ledger[_ledger.length - 1].hash : GENESIS;
    var e = {
      t: Date.now(),
      actor: String(actor),
      action: String(action),
      paramsHash: U.hash53(U.stableStringify(params || {})),
      result: String(result),
      prevHash: prevHash
    };
    e.hash = _digest(e);
    _ledger.push(e);
    return e;
  }

  function verifyChain() {
    var prev = GENESIS;
    for (var i = 0; i < _ledger.length; i++) {
      var e = _ledger[i];
      if (e.prevHash !== prev) return { ok: false, brokenAt: i, reason: 'prev-mismatch' };
      if (_digest(e) !== e.hash) return { ok: false, brokenAt: i, reason: 'hash-mismatch' };
      prev = e.hash;
    }
    return { ok: true, brokenAt: -1, entries: _ledger.length };
  }

  function auditTail(n) {
    return _ledger.slice(Math.max(0, _ledger.length - (n || 10)));
  }

  // ---------------------------------------------------------------- authorize
  function _deny(action, params, reason) {
    var e = _log(_session.actor, action, params, 'denied:' + reason);
    return { ok: false, reason: 'denied', detail: reason, entry: e.hash };
  }

  // authorize(action, params, opts) -> {ok, reason?, detail?, entry?}
  // opts.grant: delegated grant presented for inject-tier actions.
  function authorize(action, params, opts) {
    opts = opts || {};
    var need = ACTION_TIERS[action];
    if (!need) return _deny(action, params, 'unknown-action');

    // Delegated path: valid grant satisfies inject-tier need.
    if (need === 'inject' && opts.grant) {
      var v = validateGrant(opts.grant);
      if (!v.ok) return _deny(action, params, 'grant-' + v.reason);
      // scope check: grant scope.params must cover the request params
      var want = (params && params.probe) || (params && params.kind) || null;
      var allow = (opts.grant.scope && opts.grant.scope.params) || {};
      var inScope = want === null || allow.all === true || allow.probe === want || allow.kind === want;
      if (!inScope) return _deny(action, params, 'grant-scope');
      var e = _log(_session.actor + ':delegate', action, params, 'allowed');
      return { ok: true, via: 'grant', entry: e.hash };
    }

    var have = currentTier();
    if (rank(have) >= rank(need)) {
      var entry = null;
      if (need === 'inject') { // every inject-tier action is audited
        entry = _log(_session.actor, action, params, 'allowed').hash;
      }
      return { ok: true, via: 'role', entry: entry };
    }
    return _deny(action, params, 'tier:' + have + '<' + need);
  }

  function canDo(action, opts) {
    var need = ACTION_TIERS[action];
    if (!need) return false;
    if (need === 'inject' && opts && opts.grant) return validateGrant(opts.grant).ok;
    return rank(currentTier()) >= rank(need);
  }

  // ---------------------------------------------------------------- session API
  function setRole(role) {
    if (!ROLE_TIERS[role]) return { ok: false, reason: 'unknown-role' };
    _session.role = role;
    _session.actor = role;
    return { ok: true, role: role, tier: currentTier() };
  }
  function setObservatory(on) {
    _session.mode = on ? 'observatory' : 'lab';
    return { ok: true, mode: _session.mode, tier: currentTier() };
  }

  // ---------------------------------------------------------------- panel
  function mountPanel(el) {
    if (!U.isBrowser() || !el) return;
    var d = root.document;
    el.innerHTML = '';

    function h(tag, text, cls) {
      var n = d.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }

    var tierBox = h('div', '', 'vx-perm-tier');
    function refreshTier() {
      tierBox.textContent = 'Tier: ' + currentTier().toUpperCase() +
        '  ·  role: ' + _session.role + '  ·  mode: ' + _session.mode +
        '  ·  grants: ' + Object.keys(_grants).length;
    }
    refreshTier();

    // --- grant issue / validate (owner only) ---
    var grantBox = h('div', '', 'vx-perm-grants');
    grantBox.appendChild(h('h3', 'Delegated inject grant (owner only, 6h, no chains)'));
    var scopeInput = h('input');
    scopeInput.type = 'text';
    scopeInput.placeholder = 'probe name (scope) e.g. vortex-merger';
    scopeInput.style.width = '70%';
    var issueBtn = h('button', 'Issue grant');
    var grantOut = h('pre', '', 'vx-perm-grant-out');
    issueBtn.onclick = function () {
      var r = issueGrant({ probe: scopeInput.value || 'any' });
      grantOut.textContent = r.ok
        ? JSON.stringify(r.grant, null, 1)
        : 'DENIED: ' + r.reason + ' (' + r.detail + ')';
      refreshTier();
    };
    var validateBtn = h('button', 'Validate pasted grant');
    validateBtn.onclick = function () {
      try {
        var g = JSON.parse(grantOut.textContent);
        var v = validateGrant(g);
        grantOut.textContent = JSON.stringify({ valid: v.ok, reason: v.reason || null }, null, 1);
      } catch (e) {
        grantOut.textContent = 'Paste a grant JSON above first (Issue a grant, it appears here).';
      }
    };
    grantBox.appendChild(scopeInput);
    grantBox.appendChild(issueBtn);
    grantBox.appendChild(validateBtn);
    grantBox.appendChild(grantOut);

    // --- audit tail ---
    var auditBox = h('div', '', 'vx-perm-audit');
    auditBox.appendChild(h('h3', 'Audit ledger (hash-chained)'));
    var chainState = h('div', '');
    var tailList = h('ul', '');
    function refreshAudit() {
      var vc = verifyChain();
      chainState.textContent = 'chain: ' + (vc.ok ? 'OK (' + vc.entries + ' entries)' :
        'BROKEN at ' + vc.brokenAt + ' (' + vc.reason + ')');
      tailList.innerHTML = '';
      auditTail(8).forEach(function (e) {
        var li = h('li', new Date(e.t).toLocaleTimeString() + ' ' + e.actor +
          ' ' + e.action + ' → ' + e.result + ' [' + e.hash.slice(0, 8) + ']');
        tailList.appendChild(li);
      });
    }
    var verifyBtn = h('button', 'Verify chain');
    verifyBtn.onclick = refreshAudit;
    auditBox.appendChild(chainState);
    auditBox.appendChild(verifyBtn);
    auditBox.appendChild(tailList);
    refreshAudit();

    // --- kill-switch ---
    var killBox = h('div', '', 'vx-perm-kill');
    var killBtn = h('button', '⛔ REVOKE ALL GRANTS', 'vx-kill-btn');
    killBtn.style.cssText = 'background:#a00;color:#fff;font-weight:bold;' +
      'padding:10px 18px;border:2px solid #600;font-size:14px;cursor:pointer;';
    killBtn.onclick = function () {
      if (!window.confirm('Revoke ALL delegated grants? This cannot be undone.')) return;
      var r = revokeAll();
      V.ui.announce(r.ok ? 'Kill-switch: revoked ' + r.revoked + ' grant(s).'
        : 'Kill-switch DENIED: ' + r.detail);
      refreshTier(); refreshAudit();
    };
    killBox.appendChild(killBtn);
    var note = h('p', 'Client-side lab enforcement. Server re-checks every tier decision.');
    note.style.fontSize = '11px'; note.style.opacity = '0.7';

    el.appendChild(tierBox);
    el.appendChild(grantBox);
    el.appendChild(auditBox);
    el.appendChild(killBox);
    el.appendChild(note);
  }

  V.ui.registerPanel('w31-permissions', 'Permissions', mountPanel);

  // ---------------------------------------------------------------- selfTest
  function check(name, cond, detail) {
    return { name: name, ok: !!cond, detail: detail || '' };
  }

  function selfTest() {
    var checks = [];
    var savedRole = _session.role, savedMode = _session.mode;

    // 1. chain verifies (baseline)
    _log('selftest', 'field.view', {}, 'allowed');
    var v0 = verifyChain();
    checks.push(check('chain-verifies', v0.ok, 'entries=' + v0.entries));

    // 2. tampered entry breaks chain at the right index
    _log('selftest', 'metrics.view', {}, 'allowed');
    _log('selftest', 'evidence.view', {}, 'allowed');
    var idx = _ledger.length - 1;
    var victim = _ledger[idx];
    var origPrev = victim.prevHash;
    victim.prevHash = 'tampered';
    var v1 = verifyChain();
    checks.push(check('tamper-breaks-chain-at-index',
      !v1.ok && v1.brokenAt === idx,
      'brokenAt=' + v1.brokenAt + ' expected=' + idx + ' reason=' + v1.reason));
    victim.prevHash = origPrev; // restore
    victim.hash = _digest(victim);
    var v1b = verifyChain();
    checks.push(check('chain-restores-after-tamper', v1b.ok, 'entries=' + v1b.entries));

    // 3. grant issue/validate round-trip (as owner)
    setRole('owner');
    var gi = issueGrant({ probe: 'test-probe' }, { ttlHours: 6 });
    checks.push(check('grant-issue', gi.ok && !!gi.grant.grantId,
      'grantId=' + (gi.grant && gi.grant.grantId)));
    var gv = gi.ok ? validateGrant(gi.grant) : { ok: false };
    checks.push(check('grant-validates', gv.ok, 'reason=' + (gv.reason || 'none')));

    // 4. chained grant rejected
    var chained = _copy(gi.grant);
    chained.chain = [{ grantId: 'parent-grant' }];
    chained.signature = _grantDigest(chained); // even correctly signed...
    var gc = validateGrant(chained);
    checks.push(check('chained-grant-rejected',
      !gc.ok && gc.reason === 'chain-rejected', 'reason=' + gc.reason));

    // 5. expired grant rejected
    var expired = _copy(gi.grant);
    expired.issuedAt = Date.now() - 7 * 3600e3; // 7h ago, ttl 6h
    expired.signature = _grantDigest(expired);
    var ge = validateGrant(expired);
    checks.push(check('expired-grant-rejected',
      !ge.ok && ge.reason === 'expired', 'reason=' + ge.reason));

    // 6. tampered grant rejected
    var tampered = _copy(gi.grant);
    tampered.scope.params.probe = 'evil-probe';
    var gt = validateGrant(tampered); // signature now stale
    checks.push(check('tampered-grant-rejected',
      !gt.ok && gt.reason === 'tampered', 'reason=' + gt.reason));

    // 7. delegated inject via valid grant works
    setRole('visitor'); // signed-out presenter
    var da = authorize('probe.inject', { probe: 'test-probe' }, { grant: gi.grant });
    checks.push(check('delegated-inject-allowed', da.ok && da.via === 'grant',
      'via=' + da.via));

    // 8. denied attempt is logged
    var before = _ledger.length;
    var dd = authorize('probe.inject', { probe: 'test-probe' }); // no grant, visitor
    var tail = _ledger[_ledger.length - 1];
    checks.push(check('denied-attempt-logged',
      !dd.ok && _ledger.length === before + 1 &&
      tail.action === 'probe.inject' && tail.result.indexOf('denied') === 0,
      'result=' + tail.result));

    // 9. revokeAll invalidates grants
    setRole('owner');
    var ri = issueGrant({ probe: 'x' });
    var beforeRevoke = validateGrant(ri.grant);
    var rr = revokeAll();
    var afterRevoke = validateGrant(ri.grant);
    checks.push(check('revokeAll-invalidates',
      beforeRevoke.ok && rr.ok && !afterRevoke.ok &&
      afterRevoke.reason === 'revoked-or-unknown',
      'revoked=' + rr.revoked + ' after=' + afterRevoke.reason));

    // 10. observatory mode disables inject (and caps tier at observe)
    setObservatory(true);
    var oi = authorize('probe.inject', { probe: 'test-probe' }, { grant: gi.grant });
    var oc = authorize('camera.move', {});
    var os = authorize('sliders.set', {});
    checks.push(check('observatory-disables-inject',
      !oi.ok && oc.ok && !os.ok && currentTier() === 'observe',
      'inject=' + oi.ok + ' camera=' + oc.ok + ' sliders=' + os.ok));
    setObservatory(false);

    // 11. unknown action denied + logged
    var ua = authorize('warp.drive', {});
    checks.push(check('unknown-action-denied', !ua.ok, 'reason=' + ua.reason));

    // 12. final chain still verifies
    var vf = verifyChain();
    checks.push(check('final-chain-verifies', vf.ok, 'entries=' + vf.entries));

    // restore session
    _session.role = savedRole;
    _session.mode = savedMode;
    _session.actor = savedRole;

    var okAll = checks.every(function (c) { return c.ok; });
    return { ok: okAll, checks: checks };
  }

  var api = {
    TIERS: TIERS,
    ACTION_TIERS: ACTION_TIERS,
    currentTier: currentTier,
    authorize: authorize,
    canDo: canDo,
    setRole: setRole,
    setObservatory: setObservatory,
    isObservatory: function () { return _session.mode === 'observatory'; },
    issueGrant: issueGrant,
    validateGrant: validateGrant,
    revokeGrant: revokeGrant,
    revokeAll: revokeAll,
    verifyChain: verifyChain,
    auditTail: auditTail,
    grantCount: function () { return Object.keys(_grants).length; },
    selfTest: selfTest
  };

  V.register('w31-permissions', api);
})(typeof window !== 'undefined' ? window : globalThis);
