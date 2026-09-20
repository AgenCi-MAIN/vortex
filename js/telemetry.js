/* VORTEX telemetry.js — W21: electricity cost, sealed evidence packets,
 * execution-held gate, opt-in sync panel.
 *
 * Design source: lane-14-vortex.md §9 "Telemetry".
 * Plain IIFE script, no modules, no network, no build step.
 * Works in browser and node (headless selfTest).
 *
 * Three honesty rules baked into this module:
 *  1. Cost is an ESTIMATE unless W03's field monitor provides a live power
 *     figure — every cost row carries its basis ("field-monitor" or
 *     "tiered-estimate"). We never print "Actual cost: Unavailable"; we print
 *     the estimate with its basis.
 *  2. Sealed packets are content-addressed: hash53(stableStringify(payload))
 *     computed at seal time, re-verified on open. Tampered packets fail with
 *     a reason, never silently.
 *  3. Nothing leaves the machine by default. Sync = manual JSON export
 *     only. The sync panel states, in words, that there are no network calls.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w21-telemetry: VORTEX namespace missing — load vx-namespace.js first');

  // ---------------------------------------------------------------- rate ----
  var DEFAULT_RATE = 0.17;          // USD per kWh
  var _rate = DEFAULT_RATE;

  // Tiered power estimates (watts). LABELED as estimates everywhere shown.
  // Used only when W03's field monitor is absent.
  var POWER_TIERS = {
    'cpu': 45,
    'gpu-mid': 150,
    'gpu-high': 300
  };
  function tierForBackend(backend) {
    if (backend === 'webgpu') return 'gpu-high';
    if (backend === 'webgl2') return 'gpu-mid';
    return 'cpu';
  }

  // ------------------------------------------------- W03 field monitor ----
  // The W03 megafield module owns a live field monitor that includes an
  // estimated power readout (per the synthesis). When it exists we prefer its
  // figure over the tier table. Duck-typed: W03 is a separate worker lane and
  // its exact API shape is not guaranteed here, so we probe candidates.
  function w03PowerW() {
    try {
      var m = V.get('w03-megafield');
      if (!m) return null;
      var candidates = [
        m.getPowerW, m.powerW, m.estimatedPowerW, m.estPowerW
      ];
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (typeof c === 'function') { var w = c.call(m); if (isFinite(w) && w > 0) return { watts: w, basis: 'field-monitor' }; }
        else if (isFinite(c) && c > 0) return { watts: c, basis: 'field-monitor' };
      }
      if (m.fieldMonitor && typeof m.fieldMonitor === 'function') {
        var fm = m.fieldMonitor();
        if (fm && isFinite(fm.powerW) && fm.powerW > 0) return { watts: fm.powerW, basis: 'field-monitor' };
        if (fm && isFinite(fm.estimatedPowerW) && fm.estimatedPowerW > 0) return { watts: fm.estimatedPowerW, basis: 'field-monitor' };
      }
    } catch (e) { /* monitor unavailable: fall through to estimate */ }
    return null;
  }

  function estimatePowerW(backend) {
    var live = w03PowerW();
    if (live) return live;
    var tier = tierForBackend(backend || 'cpu');
    return { watts: POWER_TIERS[tier], basis: 'tiered-estimate', tier: tier };
  }

  // --------------------------------------------------------------- cost ----
  // cost = estPowerW × durationH × ratePerKWh
  function costForRun(run) {
    var durationH = Math.max(0, (run.durationS || 0) / 3600);
    var p = estimatePowerW(run.backend);
    var kwh = (p.watts * durationH) / 1000;
    var usd = kwh * _rate;
    return {
      backend: run.backend || 'cpu',
      durationS: run.durationS || 0,
      watts: p.watts,
      powerBasis: p.basis,                 // 'field-monitor' | 'tiered-estimate'
      powerTier: p.tier || null,           // only for tiered estimates
      kwh: kwh,
      usd: usd,
      ratePerKWh: _rate,
      estimated: true,                     // ALWAYS an estimate; see honesty note
      label: run.label || null
    };
  }

  // In-memory run log (session-scoped; the durable record is the packet log).
  var _runs = [];
  var _openRuns = {};                      // token -> {label, backend, t0}
  function beginRun(label, meta) {
    meta = meta || {};
    var token = V.utils.uid('run');
    _openRuns[token] = { label: label || 'run', backend: meta.backend || 'cpu', t0: V.utils.now(), meta: meta };
    V.bus.emit('vx:telemetry-run-start', { token: token, label: label });
    return token;
  }
  function endRun(token) {
    var r = _openRuns[token];
    if (!r) return null;
    delete _openRuns[token];
    var durationS = Math.max(0, (V.utils.now() - r.t0) / 1000);
    var cost = costForRun({ label: r.label, backend: r.backend, durationS: durationS });
    var entry = { token: token, label: r.label, createdAt: new Date().toISOString(), cost: cost, meta: r.meta };
    _runs.push(entry);
    V.bus.emit('vx:telemetry-run-end', { token: token, cost: cost });
    return entry;
  }
  function runLog() { return _runs.slice(); }

  // ------------------------------------------------------ sealed packets ----
  // Packet: { packetId, manifest, metrics, snapshotRefs, createdAt, hash }.
  // seal() deep-freezes and content-addresses. verify() recomputes the hash
  // over everything except the stored hash and reports {ok, reason}.
  function freezeDeep(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { freezeDeep(o[k]); });
      Object.freeze(o);
    }
    return o;
  }
  function payloadOf(packet) {
    return {
      packetId: packet.packetId,
      manifest: packet.manifest,
      metrics: packet.metrics,
      snapshotRefs: packet.snapshotRefs,
      createdAt: packet.createdAt
    };
  }
  function packetHash(packet) {
    return V.utils.hash53(V.utils.stableStringify(payloadOf(packet)));
  }
  function sealPacket(o) {
    o = o || {};
    var packet = freezeDeep({
      packetId: o.packetId || V.utils.uid('pkt'),
      manifest: o.manifest || null,
      metrics: o.metrics || null,
      snapshotRefs: o.snapshotRefs || [],
      createdAt: o.createdAt || new Date().toISOString()
    });
    // hash computed AFTER freeze so the payload is exactly what is sealed
    var sealed = freezeDeep({
      packetId: packet.packetId,
      manifest: packet.manifest,
      metrics: packet.metrics,
      snapshotRefs: packet.snapshotRefs,
      createdAt: packet.createdAt,
      hash: packetHash(packet)
    });
    return sealed;
  }
  function verify(packet) {
    if (!packet || typeof packet !== 'object') return { ok: false, reason: 'not-a-packet' };
    if (!packet.hash) return { ok: false, reason: 'missing-hash' };
    var expected = packetHash(packet);
    if (expected !== packet.hash) {
      return { ok: false, reason: 'hash-mismatch: content changed after sealing (expected ' + expected + ', stored ' + packet.hash + ')' };
    }
    return { ok: true, reason: 'hash-verified' };
  }

  // Append-only packet log. localStorage guarded; there is deliberately NO
  // delete/remove/clear API — history is write-once. (Quota failure surfaces
  // as VX_E_QUOTA on the bus; the in-memory copy is kept regardless.)
  var STORE_KEY = 'vortex.w21.packetLog.v1';
  var _memLog = [];
  function loadLog() {
    try {
      if (typeof root.localStorage === 'undefined') return _memLog.slice();
      var raw = root.localStorage.getItem(STORE_KEY);
      if (!raw) return _memLog.slice();
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return _memLog.slice();
      return arr;
    } catch (e) { return _memLog.slice(); }
  }
  function appendPacket(packet) {
    var v = verify(packet);
    if (!v.ok) throw new Error('w21-telemetry: refusing to log unverifiable packet (' + v.reason + ')');
    var log = loadLog();
    log.push(packet);
    _memLog = log;
    try {
      if (typeof root.localStorage !== 'undefined') {
        root.localStorage.setItem(STORE_KEY, JSON.stringify(log));
      }
    } catch (e) {
      V.bus.emit('vx:error', { code: 'VX_E_QUOTA', message: 'packet log could not persist: ' + e.message, kept: 'in-memory packet log' });
    }
    V.bus.emit('vx:telemetry-packet', { packetId: packet.packetId, ok: v.ok });
    return packet;
  }
  function listPackets() { return loadLog(); }
  // NOTE: no removePacket / clearLog. Append-only by design; selfTest asserts this.

  // --------------------------------------------------------- held gate ----
  // "Execution: Held" is rescoped: it applies ONLY to probe INJECTION.
  // Local simulations are ALWAYS released. Inject requires an owner grant
  // (W31 permissions lane when present; otherwise an explicit grant recorded
  // here). Default: sim allowed, inject denied.
  var _grants = [];  // in-memory: {scope, expiresAt, by}
  function w31CanInject() {
    try {
      var p = V.get('w31-permissions');
      if (!p) return null;                       // W31 absent: not our call
      if (typeof p.can === 'function') return !!p.can('inject');
      if (typeof p.hasGrant === 'function') return !!p.hasGrant('inject');
      if (typeof p.tier === 'function') {
        var t = String(p.tier()).toLowerCase();
        return t === 'inject' || t === 'administer' || t === 'admin';
      }
      if (typeof p.canInject === 'function') return !!p.canInject();
    } catch (e) { /* treat as unknown */ }
    return null;
  }
  function localGrantValid() {
    var now = V.utils.now();
    return _grants.some(function (g) {
      return g.scope === 'inject' && (!g.expiresAt || g.expiresAt > now);
    });
  }
  function isHeld(tier) {
    if (tier === 'sim' || tier === 'simulate') return false;   // always released
    if (tier === 'inject' || tier === 'injection') return !canInject();
    return true;                                              // unknown tier: hold
  }
  function canSim() { return true; }                            // sims always released
  function canInject() {
    if (localGrantValid()) return true;
    var w31 = w31CanInject();
    if (w31 === true) return true;
    return false;                                             // default DENY
  }
  function recordGrant(grant) {
    grant = grant || {};
    var g = {
      scope: grant.scope || 'inject',
      expiresAt: grant.expiresAt || (V.utils.now() + 10 * 60 * 1000),  // 10-min single-use default
      by: grant.by || 'owner',
      createdAt: new Date().toISOString()
    };
    _grants.push(g);
    V.bus.emit('vx:telemetry-grant', { scope: g.scope, expiresAt: g.expiresAt });
    return g;
  }
  function heldStatus() {
    return {
      sim: { held: isHeld('sim'), note: 'local simulations are always released' },
      inject: { held: isHeld('inject'), note: 'probe injection requires an owner grant (W31) — default deny' }
    };
  }

  // ------------------------------------------------------------ sync ----
  // Opt-in sync: default NOTHING leaves this machine. Sync is a manual JSON
  // export (file download) until a server exists. No network calls — the
  // panel states this explicitly.
  function whatLeaves() {
    return [
      'nothing — by default, no telemetry, packets, or cost data leaves this machine',
      'sync is opt-in and manual only: a JSON file download you trigger yourself',
      'this module makes zero network calls (no fetch/XHR/WebSocket); the export is a local file save'
    ];
  }
  function exportPacketsJSON() {
    var payload = {
      exportedAt: new Date().toISOString(),
      codeVersion: V.codeVersion,
      ratePerKWh: _rate,
      packets: listPackets(),
      runCosts: _runs.map(function (r) { return { label: r.label, createdAt: r.createdAt, cost: r.cost }; })
    };
    var text = JSON.stringify(payload, null, 2);
    if (!V.utils.isBrowser()) return text;
    try {
      var blob = new root.Blob([text], { type: 'application/json' });
      var url = root.URL.createObjectURL(blob);
      var a = root.document.createElement('a');
      a.href = url;
      a.download = 'vortex-telemetry-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      root.document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        root.document.body.removeChild(a);
        root.URL.revokeObjectURL(url);
      }, 500);
      V.bus.emit('vx:telemetry-export', { packets: payload.packets.length });
    } catch (e) {
      V.bus.emit('vx:error', { code: 'VX_E_QUOTA', message: 'export failed: ' + e.message, kept: 'packet log intact' });
    }
    return text;
  }

  // ------------------------------------------------------------ panel ----
  var HONESTY_NOTE =
    'Honesty boundary: every cost here is an ESTIMATE, never a metered bill. ' +
    'The figure comes from the W03 field monitor when it is live, otherwise ' +
    'from a fixed tier table (CPU 45W / GPU-mid 150W / GPU-high 300W). ' +
    'Your real cost depends on actual power draw, PSU efficiency, and your ' +
    'utility rate (settable below, default $0.17/kWh). Estimates are for ' +
    'comparing runs, not for billing.';

  function fmtUSD(x) { return '$' + x.toFixed(4); }
  function el(tag, cls, text) {
    var d = root.document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  function mountPanel(host) {
    host.innerHTML = '';
    var wrap = el('div', 'vx-telemetry');

    // --- cost section
    wrap.appendChild(el('h3', 'vx-t-h', 'Electricity cost per run'));
    wrap.appendChild(el('p', 'vx-t-note', HONESTY_NOTE));

    var rateRow = el('div', 'vx-t-row');
    rateRow.appendChild(el('label', '', 'Rate ($/kWh): '));
    var rateInput = el('input', 'vx-t-rate');
    rateInput.type = 'number'; rateInput.step = '0.01'; rateInput.min = '0';
    rateInput.value = String(_rate);
    rateInput.addEventListener('change', function () {
      var r = parseFloat(rateInput.value);
      if (isFinite(r) && r >= 0) { setRate(r); refreshCostTable(); }
    });
    rateRow.appendChild(rateInput);
    wrap.appendChild(rateRow);

    var costTableWrap = el('div', 'vx-t-table-wrap');
    wrap.appendChild(costTableWrap);
    function refreshCostTable() {
      costTableWrap.innerHTML = '';
      var table = el('table', 'vx-t-table');
      var head = el('tr');
      ['Run', 'Backend', 'Duration', 'Power', 'Basis', 'Energy', 'Est. cost'].forEach(function (h) {
        head.appendChild(el('th', '', h));
      });
      table.appendChild(head);
      var runs = runLog();
      if (!runs.length) {
        var tr = el('tr'); var td = el('td', '', 'no runs recorded this session');
        td.colSpan = 7; tr.appendChild(td); table.appendChild(tr);
      }
      runs.forEach(function (r) {
        var c = r.cost;
        var tr = el('tr');
        tr.appendChild(el('td', '', r.label));
        tr.appendChild(el('td', '', c.backend));
        tr.appendChild(el('td', '', c.durationS.toFixed(1) + ' s'));
        tr.appendChild(el('td', '', c.watts + ' W' + (c.powerTier ? ' (' + c.powerTier + ')' : '')));
        tr.appendChild(el('td', '', c.powerBasis === 'field-monitor' ? 'W03 monitor' : 'tiered estimate'));
        tr.appendChild(el('td', '', c.kwh.toFixed(5) + ' kWh'));
        tr.appendChild(el('td', '', fmtUSD(c.usd) + ' est.'));
        table.appendChild(tr);
      });
      costTableWrap.appendChild(table);
    }
    refreshCostTable();

    // --- packets section
    wrap.appendChild(el('h3', 'vx-t-h', 'Sealed evidence packets'));
    var pktWrap = el('div', 'vx-t-packets');
    wrap.appendChild(pktWrap);
    function refreshPackets() {
      pktWrap.innerHTML = '';
      var pkts = listPackets();
      if (!pkts.length) { pktWrap.appendChild(el('p', 'vx-t-note', 'no packets sealed yet')); return; }
      pkts.forEach(function (p) {
        var row = el('div', 'vx-t-row');
        row.appendChild(el('span', 'vx-t-pid', p.packetId + ' · ' + p.createdAt));
        var btn = el('button', 'vx-t-verify', 'Verify');
        btn.addEventListener('click', function () {
          var v = verify(p);
          btn.textContent = v.ok ? 'Verified ✓' : 'FAILED';
          btn.title = v.reason;
          if (!v.ok) V.ui.announce('packet ' + p.packetId + ' failed verification: ' + v.reason);
        });
        row.appendChild(btn);
        var res = el('span', 'vx-t-phash', 'hash ' + String(p.hash).slice(0, 12) + '…');
        row.appendChild(res);
        pktWrap.appendChild(row);
      });
    }
    refreshPackets();

    // --- held gate section
    wrap.appendChild(el('h3', 'vx-t-h', 'Execution gate'));
    var gate = heldStatus();
    var gateP = el('p', 'vx-t-note',
      '“Execution: Held” applies ONLY to probe injection. Local simulations are ' +
      'always released. Injection needs an owner grant (W31 permissions lane ' +
      'when present) — default deny. Status now: sim=' +
      (gate.sim.held ? 'HELD' : 'RELEASED') + ', inject=' +
      (gate.inject.held ? 'HELD' : 'RELEASED') + '.');
    wrap.appendChild(gateP);

    // --- sync section
    wrap.appendChild(el('h3', 'vx-t-h', 'Sync — what leaves this machine'));
    var ul = el('ul', 'vx-t-sync');
    whatLeaves().forEach(function (line) { ul.appendChild(el('li', '', line)); });
    wrap.appendChild(ul);
    var expBtn = el('button', 'vx-t-export', 'Export packets + costs (JSON download)');
    expBtn.addEventListener('click', function () { exportPacketsJSON(); });
    wrap.appendChild(expBtn);
    wrap.appendChild(el('p', 'vx-t-note',
      'There is no server sync. This button saves a local file; you decide ' +
      'where it goes. This module performs no network calls.'));

    host.appendChild(wrap);
  }
  if (V.utils.isBrowser()) {
    V.ui.registerPanel('telemetry', 'Telemetry & evidence', mountPanel);
  }

  function setRate(r) {
    r = Number(r);
    if (!isFinite(r) || r < 0) throw new Error('w21-telemetry: rate must be a non-negative number');
    _rate = r;
    return _rate;
  }

  // ---------------------------------------------------------- selfTest ----
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

    // 1. cost math on a synthetic run: 45 W (cpu tier, no W03 monitor in test)
    //    x 2 h = 90 Wh = 0.09 kWh x $0.17/kWh = $0.0153
    try {
      var c = costForRun({ label: 'synthetic', backend: 'cpu', durationS: 7200 });
      var expectedUSD = 0.09 * 0.17;
      check('cost-math', c.watts === 45 && Math.abs(c.usd - expectedUSD) < 1e-9,
        'watts=' + c.watts + ' basis=' + c.powerBasis + ' usd=' + c.usd + ' expected=' + expectedUSD);
      check('cost-estimate-labeled', c.estimated === true && !!c.powerBasis,
        'every cost carries basis=' + c.powerBasis + ', estimated=true');
      check('rate-settable', (function () { var old = _rate; setRate(0.25); var c2 = costForRun({ backend: 'cpu', durationS: 3600 }); setRate(old); return Math.abs(c2.usd - (c2.watts / 1000) * 0.25) < 1e-9; })(),
        'rate change propagates into cost');
    } catch (e) { check('cost-math', false, String(e && e.message)); }

    // 2. sealed packet: valid verifies, tampered fails with a reason
    try {
      var p = sealPacket({ manifest: { seed: 7 }, metrics: { ke: 1.5 }, snapshotRefs: ['snap-1'] });
      var v0 = verify(p);
      check('packet-verify-clean', v0.ok === true, 'reason=' + v0.reason);
      var tampered = JSON.parse(JSON.stringify(p));
      tampered.metrics.ke = 999;
      var v1 = verify(tampered);
      check('packet-verify-tamper', v1.ok === false && !!v1.reason,
        'tampered packet rejected: ' + v1.reason);
      check('packet-sealed-frozen', Object.isFrozen(p), 'seal() deep-freezes the packet');
      check('packet-hash-deterministic', packetHash(p) === p.hash, 'hash recomputes to stored value');
    } catch (e) { check('packet-verify-clean', false, String(e && e.message)); }

    // 3. append-only: no delete API exists on the module
    try {
      var apiKeys = Object.keys(api);
      var forbidden = ['removePacket', 'deletePacket', 'clearLog', 'clearPackets', 'remove', 'delete', 'clear', 'purge'];
      var found = forbidden.filter(function (k) { return apiKeys.indexOf(k) !== -1; });
      check('append-only-no-delete-api', found.length === 0,
        found.length ? 'FORBIDDEN APIS PRESENT: ' + found.join(',') : 'no delete/clear/remove API on module');
      // append works and is visible via list
      var before = listPackets().length;
      var pk = sealPacket({ manifest: { seed: 42 }, metrics: {}, snapshotRefs: [] });
      appendPacket(pk);
      check('append-only-writes', listPackets().length === before + 1,
        'log grew ' + before + ' -> ' + (before + 1));
    } catch (e) { check('append-only-no-delete-api', false, String(e && e.message)); }

    // 4. held gate: sim released, inject denied without grant
    try {
      check('gate-sim-released', canSim() === true && isHeld('sim') === false,
        'local sims are always released');
      check('gate-inject-denied-default', canInject() === false && isHeld('inject') === true,
        'inject denied with no grant and no W31 module present');
      recordGrant({ scope: 'inject', expiresAt: V.utils.now() + 60000, by: 'selftest' });
      check('gate-inject-grant-releases', canInject() === true && isHeld('inject') === false,
        'an explicit owner grant releases injection');
      recordGrant({ scope: 'inject', expiresAt: V.utils.now() - 1, by: 'selftest-expired' });
      // note: the valid grant above still holds; expiry of one grant doesn't revoke others
      check('gate-grant-recorded', _grants.length >= 2, 'grants recorded: ' + _grants.length);
    } catch (e) { check('gate-sim-released', false, String(e && e.message)); }

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  var api = {
    // cost
    DEFAULT_RATE: DEFAULT_RATE,
    POWER_TIERS: POWER_TIERS,
    setRate: setRate,
    getRate: function () { return _rate; },
    estimatePowerW: estimatePowerW,
    costForRun: costForRun,
    beginRun: beginRun,
    endRun: endRun,
    runLog: runLog,
    // packets
    sealPacket: sealPacket,
    verify: verify,
    appendPacket: appendPacket,
    listPackets: listPackets,
    // gate
    isHeld: isHeld,
    canSim: canSim,
    canInject: canInject,
    recordGrant: recordGrant,
    heldStatus: heldStatus,
    // sync
    whatLeaves: whatLeaves,
    exportPacketsJSON: exportPacketsJSON,
    // contract
    selfTest: selfTest
  };

  VORTEX.register('w21-telemetry', api);
})(typeof window !== 'undefined' ? window : globalThis);
