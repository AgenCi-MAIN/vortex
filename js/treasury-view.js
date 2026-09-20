/* VORTEX treasury-view.js — W28: read-only paper fund-flow visualization.
 *
 * Design source: lane-14-vortex.md §3.7 (money never touches the lab;
 * bounties enter the treasury only after Shawn's verdict) + §10 "Treasury
 * tie-in" (tab in the Crypto workspace; reads /api/paper/state + vortex cost
 * ledger; never writes).
 *
 * PAPER ONLY. This module cannot move funds: it renders numbers and tables
 * only. Zero order buttons, zero buy/sell/order controls, zero network calls.
 *
 * DATA SEAM (documented, not yet wired):
 *   Production shape: GET /api/paper/state ->
 *     { points, runs: [{ runId, workerMinutes, cost }],
 *       bounties: [{ id, amount, status }] }
 *   There is deliberately NO network in this build (per CONTRACTS §9: "No
 *   network calls. Period."). The module ships against a LOCAL SAMPLE,
 *   clearly labeled SAMPLE DATA in code and on screen. The server-side
 *   binding happens later: the integrator (W33) hydrates this module with the
 *   real state via api.bindState(serverState) after its own server-side GET,
 *   then re-renders. bindState() runs the same strict validator as the
 *   sample — bad bounty data is refused with reasons, never rendered.
 *
 * ACCOUNTING RULE (documented once, applied everywhere):
 *   balance = points − Σ(run costs) − Σ(awarded bounty payouts).
 *   "pending" bounties are listed but NOT debited — no outflow happens until
 *   Shawn's verdict lands. An "awarded" bounty without verdictBy:'shawn'
 *   fails validation and is flagged, never counted.
 *
 * COST RULE: run cost = workerMinutes × ratePerWorkerMinute. The state carries
 * its own rate; the validator cross-checks each run's stated cost against the
 * recomputation and flags mismatches (honesty over silence).
 *
 * Plain IIFE script, no modules, no network, no build step.
 * Works in browser and node (headless selfTest).
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w28-treasury: VORTEX namespace missing — load vx-namespace.js first');

  // ------------------------------------------------- permanent watermark ---
  // CONTRACTS §9: any fund view carries a permanent "PAPER — simulated funds"
  // watermark. It is rendered inside every panel instance (sticky banner, CSS
  // class vx-treasury-watermark) and asserted by selfTest.
  var WATERMARK = 'PAPER — simulated funds';

  // ---------------------------------------------------------------- rules ---
  var BOUNTY_RULE =
    "Bounty rule: Awards enter only after Shawn's verdict. Never self-awarded.";
  var READONLY_NOTE =
    'Read-only: this view cannot move funds. There are no buy, sell, or order ' +
    'controls anywhere in this panel, and this module performs no network calls.';
  var SAMPLE_NOTE =
    'SAMPLE DATA — local mock only. The real state binds server-side later ' +
    'via GET /api/paper/state and api.bindState(). See source header for the seam.';

  var AWARDED_VERDICT_BY = 'shawn';   // the only accepted verdict source
  var VALID_STATUSES = ['pending', 'awarded'];
  var COST_EPS = 1e-9;

  // ------------------------------------------------------------- sample ----
  // Documented /api/paper/state shape, filled with local sample values.
  // cost == workerMinutes × ratePerWorkerMinute for every run (validator-enforced).
  function sampleState() {
    return {
      points: 2500,                 // paper lab-points granted to the treasury
      ratePerWorkerMinute: 0.50,    // paper-points per worker-minute (sample rate)
      runs: [
        { runId: 'run-20260918-kh',    workerMinutes: 40, cost: 20.0 },
        { runId: 'run-20260918-merge', workerMinutes: 95, cost: 47.5 },
        { runId: 'run-20260919-wake',  workerMinutes: 12, cost: 6.0 }
      ],
      bounties: [
        { id: 'bounty-001', amount: 200, status: 'awarded', verdictBy: 'shawn' },
        { id: 'bounty-002', amount: 100, status: 'pending' },
        { id: 'bounty-003', amount: 150, status: 'pending' }
      ]
    };
  }

  var _state = sampleState();   // current view state; starts as labeled sample
  var _mount = null;            // panel host element, if mounted

  // ------------------------------------------------------------ validator ---
  // validateState(s) -> { ok, issues: [{ field, code, detail }] }.
  // Refuses (ok=false) anything that violates the paper-fund rules — most
  // importantly: an 'awarded' bounty whose verdictBy is not 'shawn'.
  function validateState(s) {
    var issues = [];
    function issue(field, code, detail) {
      issues.push({ field: field, code: code, detail: detail });
    }

    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      issue('state', 'not-an-object', 'state must be a plain object');
      return { ok: false, issues: issues };
    }

    // points
    if (!isFinite(s.points) || s.points < 0) {
      issue('points', 'bad-points', 'points must be a non-negative number, got ' + JSON.stringify(s.points));
    }

    // rate
    if (!isFinite(s.ratePerWorkerMinute) || s.ratePerWorkerMinute <= 0) {
      issue('ratePerWorkerMinute', 'bad-rate', 'rate must be a positive number, got ' + JSON.stringify(s.ratePerWorkerMinute));
    }

    // runs
    if (!Array.isArray(s.runs)) {
      issue('runs', 'not-an-array', 'runs must be an array');
    } else {
      var seenRuns = {};
      s.runs.forEach(function (r, i) {
        var f = 'runs[' + i + ']';
        if (!r || typeof r !== 'object') { issue(f, 'not-an-object', 'run must be an object'); return; }
        if (typeof r.runId !== 'string' || !r.runId) {
          issue(f + '.runId', 'bad-id', 'runId must be a non-empty string');
        } else if (seenRuns[r.runId]) {
          issue(f + '.runId', 'duplicate-id', 'duplicate runId ' + r.runId);
        } else { seenRuns[r.runId] = true; }
        if (!isFinite(r.workerMinutes) || r.workerMinutes < 0) {
          issue(f + '.workerMinutes', 'bad-minutes', 'workerMinutes must be a non-negative number');
        }
        if (!isFinite(r.cost) || r.cost < 0) {
          issue(f + '.cost', 'bad-cost', 'cost must be a non-negative number');
        }
        // cost honesty: stated cost must match workerMinutes × rate
        if (isFinite(s.ratePerWorkerMinute) && s.ratePerWorkerMinute > 0 &&
            isFinite(r.workerMinutes) && isFinite(r.cost)) {
          var expected = r.workerMinutes * s.ratePerWorkerMinute;
          if (Math.abs(r.cost - expected) > COST_EPS) {
            issue(f + '.cost', 'cost-mismatch',
              'stated cost ' + r.cost + ' != workerMinutes(' + r.workerMinutes +
              ') × rate(' + s.ratePerWorkerMinute + ') = ' + expected);
          }
        }
      });
    }

    // bounties — the §3.7 gate lives here
    if (!Array.isArray(s.bounties)) {
      issue('bounties', 'not-an-array', 'bounties must be an array');
    } else {
      var seenB = {};
      s.bounties.forEach(function (b, i) {
        var f = 'bounties[' + i + ']';
        if (!b || typeof b !== 'object') { issue(f, 'not-an-object', 'bounty must be an object'); return; }
        if (typeof b.id !== 'string' || !b.id) {
          issue(f + '.id', 'bad-id', 'bounty id must be a non-empty string');
        } else if (seenB[b.id]) {
          issue(f + '.id', 'duplicate-id', 'duplicate bounty id ' + b.id);
        } else { seenB[b.id] = true; }
        if (!isFinite(b.amount) || b.amount < 0) {
          issue(f + '.amount', 'bad-amount', 'amount must be a non-negative number');
        }
        if (VALID_STATUSES.indexOf(b.status) === -1) {
          issue(f + '.status', 'bad-status',
            "status must be one of " + VALID_STATUSES.join('/') + ", got " + JSON.stringify(b.status));
          return;
        }
        // §3.7 enforcement: awarded REQUIRES Shawn's verdict. Anything else —
        // missing verdict, a verdict by anyone else — is refused.
        if (b.status === 'awarded') {
          if (b.verdictBy !== AWARDED_VERDICT_BY) {
            issue(f, 'bounty-awarded-without-owner-verdict',
              "bounty '" + b.id + "' is marked awarded but lacks verdictBy:'shawn' " +
              "(got " + JSON.stringify(b.verdictBy) + "). Awards enter only after " +
              "Shawn's verdict — never self-awarded, never by anyone else. Refused.");
          }
        }
      });
    }

    return { ok: issues.length === 0, issues: issues };
  }

  // ----------------------------------------------------------------- math ---
  function costForRun(run, rate) {
    return Math.max(0, run.workerMinutes) * rate;
  }

  // computeBalance(s) applies the documented accounting rule:
  //   balance = points − Σ(run.cost) − Σ(awarded bounty.amount).
  // Pending bounties are NOT debited.
  // Throws on invalid state (caller gets the validator issues).
  function computeBalance(s) {
    var v = validateState(s);
    if (!v.ok) {
      throw new Error('w28-treasury: refusing to compute balance on invalid state: ' +
        v.issues.map(function (i) { return i.code + ' @ ' + i.field; }).join('; '));
    }
    var runCost = 0;
    s.runs.forEach(function (r) { runCost += r.cost; });
    var awarded = 0;
    s.bounties.forEach(function (b) { if (b.status === 'awarded') awarded += b.amount; });
    var pending = 0;
    s.bounties.forEach(function (b) { if (b.status === 'pending') pending += b.amount; });
    return {
      points: s.points,
      totalRunCost: runCost,
      awardedPayouts: awarded,
      pendingObligated: pending,      // listed, not debited
      balance: s.points - runCost - awarded,
      runCount: s.runs.length,
      bountyCount: s.bounties.length
    };
  }

  // ---------------------------------------------------------------- render ---
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPts(x) {
    return (Math.round(x * 100) / 100).toFixed(2) + ' pts';
  }
  function fmtStatus(b) {
    if (b.status === 'awarded') return 'awarded (verdict by ' + esc(b.verdictBy) + ')';
    return 'pending — awaiting verdict';
  }

  // renderPanelHTML(s) -> HTML string for the whole panel. Used by the browser
  // mount AND headless by selfTest (string assertions on watermark, rule text,
  // and the absence of order buttons). No user input is ever read here.
  function renderPanelHTML(s) {
    var b = computeBalance(s);
    var h = [];

    // Embedded styles: the watermark must be impossible to miss and impossible
    // to lose by scrolling (sticky). CSS owned by W23 (css/vortex.css) may
    // restyle later; this block guarantees the contract on its own.
    h.push('<style>' +
      '.vx-treasury{position:relative;font-family:inherit}' +
      '.vx-treasury-watermark{position:sticky;top:0;z-index:5;text-align:center;' +
      'font-weight:700;letter-spacing:.12em;font-size:12px;padding:6px 8px;' +
      'color:#ffd23f;background:rgba(20,20,8,.92);border:1px solid #ffd23f;' +
      'border-radius:4px;margin-bottom:10px}' +
      '.vx-tr-h{margin:.4em 0}.vx-tr-rule{font-style:italic;margin:.4em 0}' +
      '.vx-tr-sample,.vx-tr-note{font-size:12px;opacity:.85;margin:.4em 0}' +
      '.vx-tr-balance{font-size:18px;font-weight:700;margin:.6em 0}' +
      '.vx-tr-table{border-collapse:collapse;width:100%;font-size:13px}' +
      '.vx-tr-table th,.vx-tr-table td{border:1px solid #555;padding:4px 8px;text-align:right}' +
      '.vx-tr-table th:first-child,.vx-tr-table td:first-child{text-align:left}' +
      '.vx-tr-bounties{list-style:none;padding:0;font-size:13px}' +
      '.vx-tr-bounties li{margin:4px 0}' +
      '.vx-tr-status-pending{color:#e0a458}.vx-tr-status-awarded{color:#7fd67f}' +
      '</style>');

    h.push('<div class="vx-treasury" data-vortex-paper="true">');
    // Permanent watermark — first child, always visible, contract-required.
    h.push('<div class="vx-treasury-watermark">' + esc(WATERMARK) + '</div>');
    h.push('<h3 class="vx-tr-h">Treasury (paper)</h3>');
    h.push('<p class="vx-tr-rule">' + esc(BOUNTY_RULE) + '</p>');
    h.push('<p class="vx-tr-sample">' + esc(SAMPLE_NOTE) + '</p>');

    h.push('<div class="vx-tr-balance">Paper balance: ' + esc(fmtPts(b.balance)) + '</div>');
    h.push('<p class="vx-tr-note">Paper grant ' + esc(fmtPts(b.points)) +
      ' − run costs ' + esc(fmtPts(b.totalRunCost)) +
      ' − awarded payouts ' + esc(fmtPts(b.awardedPayouts)) +
      ' = balance. Pending bounties (' + esc(fmtPts(b.pendingObligated)) +
      ') are listed, not debited — no outflow until a verdict lands.</p>');

    // cost ledger table
    h.push('<h4 class="vx-tr-h">Cost ledger</h4>');
    h.push('<table class="vx-tr-table"><tr><th>Run</th><th>Worker-min</th><th>Rate (pts/min)</th><th>Cost (pts)</th></tr>');
    s.runs.forEach(function (r) {
      h.push('<tr><td>' + esc(r.runId) + '</td><td>' + esc(r.workerMinutes) + '</td><td>' +
        esc(s.ratePerWorkerMinute) + '</td><td>' + esc(fmtPts(r.cost)) + '</td></tr>');
    });
    h.push('<tr><td><strong>Total</strong></td><td></td><td></td><td><strong>' +
      esc(fmtPts(b.totalRunCost)) + '</strong></td></tr></table>');

    // bounty list with statuses
    h.push('<h4 class="vx-tr-h">Bounties</h4>');
    if (!s.bounties.length) {
      h.push('<p class="vx-tr-note">no bounties recorded</p>');
    } else {
      h.push('<ul class="vx-tr-bounties">');
      s.bounties.forEach(function (x) {
        var cls = x.status === 'awarded' ? 'vx-tr-status-awarded' : 'vx-tr-status-pending';
        h.push('<li><span class="' + cls + '">' + esc(x.status).toUpperCase() + '</span>' +
          ' — ' + esc(x.id) + ' — ' + esc(fmtPts(x.amount)) +
          ' — ' + fmtStatus(x) + '</li>');
      });
      h.push('</ul>');
    }

    h.push('<p class="vx-tr-note">' + esc(READONLY_NOTE) + '</p>');
    h.push('</div>');
    return h.join('');
  }

  // -------------------------------------------------------------- binding ---
  // The documented seam. W33 (or the Crypto-workspace tab host) calls this
  // with the server-side GET /api/paper/state result. Validation runs first;
  // invalid data is refused (nothing rendered, nothing swapped) and the
  // refusal is returned with reasons. Returns { ok, issues }.
  function bindState(next) {
    var v = validateState(next);
    if (!v.ok) {
      V.bus.emit('vx:error', {
        code: 'VX_E_SCRIPT_ERROR',
        message: 'treasury refused invalid paper state: ' +
          v.issues.map(function (i) { return i.code; }).join(', '),
        stage: 'treasury-bind',
        kept: 'previous state still displayed'
      });
      return { ok: false, issues: v.issues };
    }
    _state = JSON.parse(JSON.stringify(next));   // deep copy; no shared refs
    if (_mount) { _mount.innerHTML = renderPanelHTML(_state); }
    V.bus.emit('vx:treasury-state', { ok: true, runs: _state.runs.length, bounties: _state.bounties.length });
    return { ok: true, issues: [] };
  }
  function currentState() { return JSON.parse(JSON.stringify(_state)); }

  // ----------------------------------------------------------------- panel ---
  function mountPanel(host) {
    _mount = host;
    host.innerHTML = renderPanelHTML(_state);
  }
  if (V.utils.isBrowser()) {
    V.ui.registerPanel('treasury', 'Treasury (paper)', mountPanel);
  }

  // -------------------------------------------------------------- selfTest ---
  // Headless-safe: all DOM assertions run against renderPanelHTML() strings,
  // never a live document. The no-network assertion scans this file's own
  // source when locatable (node), and is skipped with a note otherwise.
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }

    var sample = sampleState();

    // 1. Validator: awarded bounty without Shawn's verdict is REJECTED.
    try {
      var bad1 = JSON.parse(JSON.stringify(sample));
      bad1.bounties.push({ id: 'bounty-evil', amount: 500, status: 'awarded' }); // no verdictBy
      var v1 = validateState(bad1);
      check('validator-rejects-awarded-without-verdict',
        v1.ok === false && v1.issues.some(function (i) { return i.code === 'bounty-awarded-without-owner-verdict'; }),
        'ok=' + v1.ok + ' codes=' + v1.issues.map(function (i) { return i.code; }).join(','));

      var bad2 = JSON.parse(JSON.stringify(sample));
      bad2.bounties.push({ id: 'bounty-evil2', amount: 500, status: 'awarded', verdictBy: 'vera' }); // wrong verdict source
      var v2 = validateState(bad2);
      check('validator-rejects-awarded-by-non-owner',
        v2.ok === false && v2.issues.some(function (i) { return i.code === 'bounty-awarded-without-owner-verdict'; }),
        'verdictBy:"vera" refused, codes=' + v2.issues.map(function (i) { return i.code; }).join(','));

      var bad3 = JSON.parse(JSON.stringify(sample));
      bad3.bounties[1].status = 'self-awarded'; // unknown status
      var v3 = validateState(bad3);
      check('validator-rejects-unknown-status',
        v3.ok === false && v3.issues.some(function (i) { return i.code === 'bad-status'; }),
        'codes=' + v3.issues.map(function (i) { return i.code; }).join(','));
    } catch (e) { check('validator-rejects-awarded-without-verdict', false, String(e && e.message)); }

    // 2. Validator: clean sample passes; cost-mismatch is flagged.
    try {
      var v0 = validateState(sample);
      check('validator-accepts-clean-sample', v0.ok === true,
        'issues=' + v0.issues.length);
      var badc = JSON.parse(JSON.stringify(sample));
      badc.runs[0].cost = 999; // stated cost != workerMinutes × rate
      var vc = validateState(badc);
      check('validator-flags-cost-mismatch',
        vc.ok === false && vc.issues.some(function (i) { return i.code === 'cost-mismatch'; }),
        'codes=' + vc.issues.map(function (i) { return i.code; }).join(','));
    } catch (e) { check('validator-accepts-clean-sample', false, String(e && e.message)); }

    // 3. Cost + balance math on the sample.
    //    runs: 40×0.50=20, 95×0.50=47.5, 12×0.50=6 → total 73.5
    //    awarded payouts: 200 → balance = 2500 − 73.5 − 200 = 2226.5
    try {
      var per = sample.runs.map(function (r) { return costForRun(r, sample.ratePerWorkerMinute); });
      var mathOk = per.length === 3 &&
        Math.abs(per[0] - 20) < COST_EPS &&
        Math.abs(per[1] - 47.5) < COST_EPS &&
        Math.abs(per[2] - 6) < COST_EPS;
      check('cost-math-per-run', mathOk, 'per-run costs=' + per.join(','));
      var bal = computeBalance(sample);
      check('balance-math',
        Math.abs(bal.totalRunCost - 73.5) < COST_EPS &&
        Math.abs(bal.awardedPayouts - 200) < COST_EPS &&
        Math.abs(bal.pendingObligated - 250) < COST_EPS &&
        Math.abs(bal.balance - 2226.5) < COST_EPS,
        'balance=' + bal.balance + ' runCost=' + bal.totalRunCost +
        ' awarded=' + bal.awardedPayouts + ' pending=' + bal.pendingObligated);
      // computeBalance refuses invalid state instead of silently computing
      var threw = false;
      try { computeBalance(bad1); } catch (e2) { threw = true; }
      check('balance-refuses-invalid-state', threw, 'computeBalance threw on verdict-less awarded bounty');
    } catch (e) { check('cost-math-per-run', false, String(e && e.message)); }

    // 4. Watermark + bounty rule present in panel markup; CSS class present.
    try {
      var html = renderPanelHTML(sample);
      check('watermark-present',
        html.indexOf('vx-treasury-watermark') !== -1 && html.indexOf(WATERMARK) !== -1,
        'class + text "' + WATERMARK + '" found in panel markup');
      check('bounty-rule-visible', html.indexOf(esc(BOUNTY_RULE)) !== -1,
        'rule text present (escaped form) in panel markup');
      check('sample-label-visible', html.indexOf('SAMPLE DATA') !== -1,
        'mock data is labeled as sample in the panel');
    } catch (e) { check('watermark-present', false, String(e && e.message)); }

    // 5. No network calls in this file's own source. The scan below builds
    // its token list from concatenated fragments so the source never
    // contains the literal banned substrings (the scanner would trip on
    // its own list otherwise).
    try {
      var netOk = null, netDetail = 'source scan skipped: own source not locatable in this runtime';
      var locatable = (typeof module !== 'undefined' && module && module.filename);
      if (locatable) {
        try {
          var fs = require('fs');
          var src = fs.readFileSync(module.filename, 'utf8');
          var tokens = ['fet' + 'ch(', 'XML' + 'HttpRequest', 'WebSoc' + 'ket(', 'ev' + 'al('];
          var hits = tokens.filter(function (t) { return src.indexOf(t) !== -1; });
          netOk = hits.length === 0;
          netDetail = hits.length ? ('banned tokens in own source: ' + hits.join(',')) : 'scanned ' + src.length + ' chars, no network tokens';
        } catch (e2) { netDetail = 'scan unavailable: ' + (e2 && e2.message); }
      }
      check('no-network-calls-in-source', netOk !== false, netDetail);
    } catch (e) { check('no-network-calls-in-source', false, String(e && e.message)); }

    // 6. Read-only: no interactive controls at all in the panel — no buttons,
    // no inputs, no selects. The read-only note *describes* the absence of
    // buy/sell/order controls in prose, so the check targets elements, not
    // vocabulary.
    try {
      var h2 = renderPanelHTML(sample);
      var interactive = /<(button|input|select|textarea)\b/i.test(h2);
      check('no-order-buttons', !interactive, interactive ? 'interactive control found in panel markup' : 'zero interactive controls (buttons/inputs/selects) in panel markup');
      check('no-order-labels', !interactive, 'no control exists that could carry an order label');
      check('readonly-note-visible', h2.indexOf(esc(READONLY_NOTE)) !== -1, 'read-only note rendered');
    } catch (e) { check('no-order-buttons', false, String(e && e.message)); }

    // 7. bindState seam: valid swap works, invalid swap refused without clobbering.
    try {
      var before = currentState();
      var alt = sampleState();
      alt.points = 1000;
      var r1 = bindState(alt);
      var mid = currentState();
      var r2 = bindState(JSON.parse(JSON.stringify(bad1))); // invalid: verdict-less award
      var after = currentState();
      check('bind-accepts-valid', r1.ok === true && mid.points === 1000,
        'valid state swapped in');
      check('bind-refuses-invalid', r2.ok === false && after.points === 1000,
        'invalid state refused; previous state kept (points=' + after.points + ')');
      // restore sample for cleanliness
      bindState(before);
    } catch (e) { check('bind-accepts-valid', false, String(e && e.message)); }

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  var api = {
    WATERMARK: WATERMARK,
    BOUNTY_RULE: BOUNTY_RULE,
    AWARDED_VERDICT_BY: AWARDED_VERDICT_BY,
    VALID_STATUSES: VALID_STATUSES.slice(),
    // data
    sampleState: sampleState,
    currentState: currentState,
    bindState: bindState,          // the documented server-side seam
    validateState: validateState,
    // math
    costForRun: costForRun,
    computeBalance: computeBalance,
    // render
    renderPanelHTML: renderPanelHTML,
    // contract
    selfTest: selfTest
  };

  VORTEX.register('w28-treasury', api);
})(typeof window !== 'undefined' ? window : globalThis);
