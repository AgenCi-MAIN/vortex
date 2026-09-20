/* VORTEX js/markets.js — W08: prediction markets ("calibration league").
 *
 * Paper lab-points only. LMSR pricing (liquidity b=100 default). Binary markets
 * are tied to protocol verdicts (e.g. "opposing-winding merger CONFIRMED by run N").
 * Resolution is automatic from scored run verdicts; explicit resolve() additionally
 * requires a scored protocol verdict AND the w06-protocols module to be present
 * (guard: VORTEX.has('w06-protocols')) AND the caller to not be the market creator
 * (no self-resolution). Brier-score calibration tracking per learner, with a
 * leaderboard ("calibration board") sorted by Brier (lower = better calibrated).
 *
 * USER-FACING TERMINOLOGY: "calibration league / calibration points". The word
 * "market" is internal-only and never appears in UI strings.
 *
 * PAPER ONLY: zero order buttons, zero real-money hooks, zero network calls.
 * Staking is a lab action (class 'vx-lab-action'), visually distinct from trading.
 * Permanent "PAPER — simulated funds" watermark on the panel.
 *
 * Plain script, no modules. Works in browser and node (headless selfTest).
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('w08-markets: VORTEX namespace is not loaded (load vx-namespace.js first)');
  }

  // ---------------- constants ----------------
  var START_POINTS = 100;   // paper lab-points per learner id
  var STAKE_CAP = 20;       // max points per single stake AND cumulative per learner per market
  var COOLDOWN_MS = 60000;  // minimum gap between stakes by the same learner (any market)
  var DEFAULT_B = 100;      // LMSR liquidity parameter
  var STORE_KEY = 'vortex.w08.markets.v1';
  var VERSION = '0.1.0-w08';

  // Test seam: clock used for cooldowns. selfTest swaps it; production uses Date.now.
  var _clock = function () { return V.utils.now(); };

  // ---------------- LMSR math (binary outcomes) ----------------
  // Outstanding shares q = (qYes, qNo). Cost function C(q) = b * ln(e^{qYes/b} + e^{qNo/b}).
  // Price of YES = e^{qYes/b} / (e^{qYes/b} + e^{qNo/b}) — always in (0,1) for finite q.
  function costFn(qYes, qNo, b) {
    return b * Math.log(Math.exp(qYes / b) + Math.exp(qNo / b));
  }
  function priceYes(qYes, qNo, b) {
    var eNo = Math.exp(qNo / b), eYes = Math.exp(qYes / b);
    return eYes / (eNo + eYes);
  }
  function priceOf(market, outcomeIdx) {
    var py = priceYes(market.qYes, market.qNo, market.b);
    return outcomeIdx === 0 ? py : 1 - py; // 0 = yes, 1 = no
  }
  // Cost in points to buy `shares` of one outcome. Strictly increasing in shares.
  function costToBuy(market, outcomeIdx, shares) {
    if (!(shares > 0)) return 0;
    var qy = market.qYes, qn = market.qNo;
    if (outcomeIdx === 0) qy += shares; else qn += shares;
    return costFn(qy, qn, market.b) - costFn(market.qYes, market.qNo, market.b);
  }
  // Invert costToBuy: how many shares does `cost` points buy? Bisection (monotone).
  function sharesForCost(market, outcomeIdx, cost) {
    if (!(cost > 0)) return 0;
    var lo = 0, hi = 1, i;
    for (i = 0; i < 200 && costToBuy(market, outcomeIdx, hi) < cost; i++) hi *= 2;
    for (i = 0; i < 80; i++) {
      var mid = (lo + hi) / 2;
      if (costToBuy(market, outcomeIdx, mid) < cost) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------------- state ----------------
  // state.learners[id] = { id, points, lastStakeAt (ms|null), brierTerms: [{marketId, forecast, actual}] }
  // state.markets[id]   = { id, question, detail, yesLabel, noLabel, b, qYes, qNo,
  //                         createdBy, createdAt, status: 'open'|'resolved'|'void',
  //                         link: {protocolId, runId}|null, stakes: [...], outcome, resolvedAt }
  // stake = { id, learnerId, outcomeIdx (0=yes,1=no), shares, cost, priceAtStake, at }
  var state = { markets: {}, learners: {}, currentLearner: 'learner-1', seq: 0 };

  function round2(x) { return Math.round(x * 100) / 100; }

  // ---- persistence (localStorage-guarded; in-memory is the source of truth) ----
  function storeGet() {
    try {
      if (typeof root.localStorage === 'undefined' || !root.localStorage) return null;
      return root.localStorage.getItem(STORE_KEY);
    } catch (e) { return null; }
  }
  function storeSet(s) {
    try {
      if (typeof root.localStorage === 'undefined' || !root.localStorage) return;
      root.localStorage.setItem(STORE_KEY, s);
    } catch (e) { /* quota / privacy mode: in-memory state still works */ }
  }
  function save() { storeSet(JSON.stringify(state)); }
  function load() {
    var raw = storeGet();
    if (!raw) return;
    try {
      var s = JSON.parse(raw);
      if (s && typeof s === 'object' && s.markets && s.learners) {
        state = s;
        if (typeof state.seq !== 'number') state.seq = 0;
        if (typeof state.currentLearner !== 'string') state.currentLearner = 'learner-1';
      }
    } catch (e) { /* corrupt snapshot: start fresh */ }
  }
  load();

  // ---------------- helpers ----------------
  function fail(code, message) { return { ok: false, code: code, message: message }; }
  function emit(type, detail) {
    detail = detail || {};
    detail.type = type;
    V.bus.emit('vx:markets', detail);
  }
  function getLearner(id) {
    id = String(id || state.currentLearner);
    var l = state.learners[id];
    if (!l) {
      l = { id: id, points: START_POINTS, lastStakeAt: null, brierTerms: [], nStakes: 0 };
      state.learners[id] = l;
    }
    return l;
  }
  function stakedInMarket(marketId, learnerId) {
    var m = state.markets[marketId];
    if (!m) return 0;
    var total = 0, i;
    for (i = 0; i < m.stakes.length; i++) {
      if (m.stakes[i].learnerId === learnerId) total += m.stakes[i].cost;
    }
    return total;
  }
  function normOutcome(o) {
    if (o === 0 || o === 'no') return 1;
    if (o === 1 || o === 'yes') return 0;
    if (o === 'void' || o === 'inconclusive' || o === -1) return -1;
    return null;
  }

  // ---------------- core API ----------------
  function createMarket(opts) {
    opts = opts || {};
    var question = String(opts.question || '').trim();
    if (!question) return fail('BAD_QUESTION', 'A calibration question needs text.');
    var b = (opts.b === undefined || opts.b === null) ? DEFAULT_B : Number(opts.b);
    if (!(b > 0) || !isFinite(b)) return fail('BAD_LIQUIDITY', 'Liquidity b must be a positive number.');
    var creatorId = String(opts.creatorId || state.currentLearner);
    state.seq += 1;
    var m = {
      id: 'cal-' + state.seq + '-' + V.utils.hash53(question + state.seq).slice(0, 6),
      question: question,
      detail: String(opts.detail || ''),
      yesLabel: String(opts.yesLabel || 'will confirm'),
      noLabel: String(opts.noLabel || 'will not confirm'),
      b: b,
      qYes: 0, qNo: 0,
      createdBy: creatorId,
      createdAt: _clock(),
      status: 'open',
      link: opts.link ? { protocolId: String(opts.link.protocolId || ''), runId: String(opts.link.runId || '') } : null,
      stakes: [],
      outcome: null,
      resolvedAt: null,
      verdictRef: null
    };
    getLearner(creatorId); // ensure the creator exists in the ledger
    state.markets[m.id] = m;
    save();
    emit('create', { marketId: m.id, question: m.question });
    return { ok: true, market: m };
  }

  function getMarket(id) { return state.markets[String(id)] || null; }
  function listMarkets() {
    var arr = Object.keys(state.markets).map(function (k) { return state.markets[k]; });
    arr.sort(function (a, b) {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (a.status !== 'open' && b.status === 'open') return 1;
      return b.createdAt - a.createdAt;
    });
    return arr;
  }

  // Stake `costPts` paper points on outcomeIdx (0=yes, 1=no) of an open market.
  // Returns { ok, stake, shares, price } or { ok:false, code, message }.
  function stake(marketId, outcomeIdx, costPts, opts) {
    opts = opts || {};
    var callerId = String(opts.callerId || state.currentLearner);
    var m = getMarket(marketId);
    if (!m) return fail('NO_MARKET', 'No calibration question with that id.');
    if (m.status !== 'open') return fail('CLOSED', 'This calibration question is already settled.');
    if (outcomeIdx !== 0 && outcomeIdx !== 1) return fail('BAD_OUTCOME', 'Outcome must be 0 (yes) or 1 (no).');
    var cost = Number(costPts);
    if (!(cost > 0) || !isFinite(cost)) return fail('BAD_STAKE', 'Stake must be a positive number of points.');
    if (cost > STAKE_CAP) return fail('STAKE_CAP', 'Stake cap is ' + STAKE_CAP + ' points per stake.');
    var l = getLearner(callerId);
    if (l.lastStakeAt !== null && _clock() - l.lastStakeAt < COOLDOWN_MS) {
      return fail('COOLDOWN', 'One stake per learner per 60s. Wait before staking again.');
    }
    if (stakedInMarket(m.id, callerId) + cost > STAKE_CAP) {
      return fail('STAKE_CAP', 'Stake cap is ' + STAKE_CAP + ' points per learner per question.');
    }
    if (cost > l.points) return fail('INSUFFICIENT_FUNDS', 'Not enough calibration points (have ' + round2(l.points) + ').');

    var shares = sharesForCost(m, outcomeIdx, cost);
    var price = priceOf(m, outcomeIdx);
    if (outcomeIdx === 0) m.qYes += shares; else m.qNo += shares;
    l.points = round2(l.points - cost);
    l.lastStakeAt = _clock();
    l.nStakes += 1;
    var s = {
      id: V.utils.uid('stake'),
      learnerId: callerId,
      outcomeIdx: outcomeIdx,
      shares: shares,
      cost: cost,
      priceAtStake: price, // implied probability of the chosen outcome = the learner's forecast
      at: _clock()
    };
    m.stakes.push(s);
    save();
    emit('stake', { marketId: m.id, learnerId: callerId, outcomeIdx: outcomeIdx, shares: shares, cost: cost });
    return { ok: true, stake: s, shares: shares, price: price, balance: l.points };
  }

  // Settle a market. Guards (all must pass):
  //  1. w06-protocols module present (verdicts are protocol-scored, not hand-picked).
  //  2. A scored protocol verdict for this market is supplied (status 'scored', marketId match).
  //  3. Caller is not the market creator (no self-resolution).
  //  4. outcome matches the verdict's outcome.
  // Payout: each share of the winning outcome pays 1 point. INCONCLUSIVE/void
  // refunds every stake (no Brier terms recorded).
  function resolveMarket(marketId, outcome, verdict, callerId) {
    if (!V.has('w06-protocols')) {
      return fail('NO_PROTOCOLS', 'Resolution needs the protocol layer (w06-protocols); refusing.');
    }
    var m = getMarket(marketId);
    if (!m) return fail('NO_MARKET', 'No calibration question with that id.');
    if (m.status !== 'open') return fail('CLOSED', 'This calibration question is already settled.');
    if (!verdict || verdict.status !== 'scored' || String(verdict.marketId) !== m.id) {
      return fail('NO_SCORED_VERDICT', 'Resolution requires a scored protocol verdict for this question.');
    }
    var outIdx = normOutcome(outcome);
    var verdictIdx = normOutcome(verdict.outcome);
    if (outIdx === null) return fail('BAD_OUTCOME', 'Outcome must be yes/no (or void).');
    if (outIdx !== verdictIdx) return fail('OUTCOME_MISMATCH', 'Outcome does not match the scored verdict.');
    var caller = String(callerId || state.currentLearner);
    if (caller === m.createdBy) return fail('SELF_RESOLVE', 'The question proposer cannot resolve their own question.');
    return _settle(m, outIdx, verdict, caller);
  }

  function _settle(m, outIdx, verdict, actor) {
    var i, s, l;
    if (outIdx === -1) {
      // void: refund every stake, no Brier terms
      for (i = 0; i < m.stakes.length; i++) {
        s = m.stakes[i];
        l = getLearner(s.learnerId);
        l.points = round2(l.points + s.cost);
      }
      m.status = 'void';
    } else {
      for (i = 0; i < m.stakes.length; i++) {
        s = m.stakes[i];
        l = getLearner(s.learnerId);
        var won = (s.outcomeIdx === outIdx);
        if (won) l.points = round2(l.points + s.shares); // each winning share pays 1 point
        // Brier term: forecast = implied probability at stake time; actual = 1 if won else 0
        l.brierTerms.push({ marketId: m.id, forecast: s.priceAtStake, actual: won ? 1 : 0, at: _clock() });
      }
      m.status = 'resolved';
    }
    m.outcome = outIdx;
    m.resolvedAt = _clock();
    m.verdictRef = verdict ? (verdict.verdictId || verdict.runId || String(verdict.verdict)) : null;
    save();
    emit('resolve', { marketId: m.id, outcomeIdx: outIdx, actor: actor, status: m.status });
    return { ok: true, status: m.status, outcomeIdx: outIdx };
  }

  // Automatic resolution from run metrics: listens for scored verdicts on the bus.
  // Links by verdict.marketId, or by market.link.runId / link.protocolId.
  // System-driven settlement bypasses the no-self-resolution rule on purpose:
  // the proposer never resolves; the scored run does.
  V.bus.on('vx:verdict', function (d) {
    if (!d || d.status !== 'scored') return;
    if (!V.has('w06-protocols')) return; // same guard as explicit resolve
    var vIdx = normOutcome(d.outcome);
    if (vIdx === null) {
      // allow raw protocol verdict words
      if (d.verdict === 'CONFIRMED') vIdx = 0;
      else if (d.verdict === 'REFUTED') vIdx = 1;
      else if (d.verdict === 'INCONCLUSIVE') vIdx = -1;
      else return;
    }
    Object.keys(state.markets).forEach(function (k) {
      var m = state.markets[k];
      if (m.status !== 'open') return;
      var linked = (d.marketId && String(d.marketId) === m.id) ||
        (m.link && d.runId && m.link.runId === String(d.runId)) ||
        (m.link && d.protocolId && m.link.protocolId === String(d.protocolId));
      if (!linked) return;
      var verdict = {
        status: 'scored', marketId: m.id,
        outcome: vIdx === 0 ? 'yes' : (vIdx === 1 ? 'no' : 'void'),
        runId: d.runId, verdictId: d.verdictId, verdict: d.verdict
      };
      _settle(m, vIdx, verdict, 'system');
    });
  });

  function leaderboard() {
    var rows = [];
    Object.keys(state.learners).forEach(function (id) {
      var l = state.learners[id];
      if (!l.brierTerms.length) return;
      var sum = 0, i;
      for (i = 0; i < l.brierTerms.length; i++) {
        var t = l.brierTerms[i];
        sum += (t.forecast - t.actual) * (t.forecast - t.actual);
      }
      rows.push({
        id: id,
        brier: sum / l.brierTerms.length,
        nResolved: l.brierTerms.length,
        points: round2(l.points)
      });
    });
    rows.sort(function (a, b) { return a.brier - b.brier; }); // lower Brier = better calibrated
    return rows;
  }

  function learnerState(id) {
    var l = getLearner(id);
    var terms = l.brierTerms;
    var brier = null;
    if (terms.length) {
      var sum = 0;
      for (var i = 0; i < terms.length; i++) sum += Math.pow(terms[i].forecast - terms[i].actual, 2);
      brier = sum / terms.length;
    }
    var cooldownLeft = 0;
    if (l.lastStakeAt !== null) cooldownLeft = Math.max(0, COOLDOWN_MS - (_clock() - l.lastStakeAt));
    return {
      id: l.id, points: round2(l.points), nStakes: l.nStakes,
      nResolved: terms.length, brier: brier, cooldownMsLeft: cooldownLeft
    };
  }

  function exportState() { return JSON.stringify(state); }
  function importState(json) {
    try {
      var s = typeof json === 'string' ? JSON.parse(json) : json;
      if (!s || typeof s !== 'object' || !s.markets || !s.learners) {
        return fail('BAD_IMPORT', 'Not a calibration-league snapshot.');
      }
      state = s;
      if (typeof state.seq !== 'number') state.seq = 0;
      if (typeof state.currentLearner !== 'string') state.currentLearner = 'learner-1';
      save();
      emit('import', {});
      return { ok: true };
    } catch (e) {
      return fail('BAD_IMPORT', 'Could not parse the snapshot: ' + e.message);
    }
  }
  function resetState() {
    state = { markets: {}, learners: {}, currentLearner: 'learner-1', seq: 0 };
    save();
    emit('reset', {});
    return { ok: true };
  }

  var api = {
    version: VERSION,
    config: { START_POINTS: START_POINTS, STAKE_CAP: STAKE_CAP, COOLDOWN_MS: COOLDOWN_MS, DEFAULT_B: DEFAULT_B },
    // LMSR math exposed for other modules (e.g. W26 settling from A/B fields)
    lmsr: { costFn: costFn, priceYes: priceYes, costToBuy: costToBuy, sharesForCost: sharesForCost },
    setLearner: function (id) { state.currentLearner = String(id); save(); return state.currentLearner; },
    getLearner: function () { return state.currentLearner; },
    learnerState: learnerState,
    createMarket: createMarket,
    getMarket: getMarket,
    listMarkets: listMarkets,
    price: function (marketId, outcomeIdx) {
      var m = getMarket(marketId);
      if (!m || (outcomeIdx !== 0 && outcomeIdx !== 1)) return null;
      return priceOf(m, outcomeIdx);
    },
    stake: stake,
    resolveMarket: resolveMarket,
    leaderboard: leaderboard,
    exportState: exportState,
    importState: importState,
    resetState: resetState,
    // test seam (headless selfTest only): override the clock for cooldown tests
    __setClock: function (fn) { _clock = fn; },
    __resetClock: function () { _clock = function () { return V.utils.now(); }; },
    selfTest: selfTest
  };

  // ---------------- "Calibration league" panel (DOM-guarded) ----------------
  // Panel copy never says "market" — only "calibration league / calibration points".
  // Stake controls are lab actions (class vx-lab-action), never order buttons.
  V.ui.registerPanel('w08-calibration-league', 'Calibration league', function (el) {
    if (!V.utils.isBrowser() || typeof root.document === 'undefined') return;
    var doc = root.document;

    function mk(tag, cls, text) {
      var d = doc.createElement(tag);
      if (cls) d.className = cls;
      if (text !== undefined && text !== null) d.textContent = text;
      return d;
    }
    function pct(x) { return (x * 100).toFixed(1) + '%'; }

    var wrap = mk('div', 'vx-cal');
    // permanent paper watermark
    var wm = mk('div', 'vx-paper-watermark', 'PAPER — simulated funds');
    wm.setAttribute('aria-label', 'Paper simulated funds only');
    wrap.appendChild(wm);

    wrap.appendChild(mk('h3', 'vx-cal-title', 'Calibration league'));
    var note = mk('p', 'vx-cal-note',
      'Stake calibration points on whether a protocol verdict will confirm. ' +
      'Odds are a prior to test, not an answer to copy.');
    wrap.appendChild(note);

    // learner row
    var lrow = mk('div', 'vx-cal-learner');
    lrow.appendChild(mk('label', null, 'Learner: '));
    var lin = mk('input', 'vx-cal-learner-in');
    lin.type = 'text'; lin.value = state.currentLearner;
    var lbtn = mk('button', 'vx-lab-action', 'Use learner id');
    lbtn.type = 'button';
    lbtn.onclick = function () { api.setLearner(lin.value || 'learner-1'); render(); };
    var lbal = mk('span', 'vx-cal-balance');
    lrow.appendChild(lin); lrow.appendChild(lbtn); lrow.appendChild(lbal);
    wrap.appendChild(lrow);

    var qlist = mk('div', 'vx-cal-questions');
    wrap.appendChild(mk('h4', null, 'Open calibration questions'));
    wrap.appendChild(qlist);

    // propose form
    var form = mk('div', 'vx-cal-form');
    form.appendChild(mk('h4', null, 'Propose a calibration question'));
    var qin = mk('input', 'vx-cal-q'); qin.type = 'text';
    qin.placeholder = 'e.g. opposing-winding merger CONFIRMED by run 12';
    var yin = mk('input'); yin.type = 'text'; yin.placeholder = '"yes" label (default: will confirm)';
    var nin = mk('input'); nin.type = 'text'; nin.placeholder = '"no" label (default: will not confirm)';
    var rin = mk('input'); rin.type = 'text'; rin.placeholder = 'linked run id (optional)';
    var cbtn = mk('button', 'vx-lab-action', 'Propose calibration question');
    cbtn.type = 'button';
    var cmsg = mk('p', 'vx-cal-msg');
    cbtn.onclick = function () {
      var r = api.createMarket({
        question: qin.value,
        yesLabel: yin.value || undefined,
        noLabel: nin.value || undefined,
        link: rin.value ? { runId: rin.value } : null
      });
      cmsg.textContent = r.ok ? 'Question proposed.' : r.message;
      if (r.ok) { qin.value = ''; rin.value = ''; }
      render();
    };
    form.appendChild(qin); form.appendChild(yin); form.appendChild(nin); form.appendChild(rin);
    form.appendChild(cbtn); form.appendChild(cmsg);
    wrap.appendChild(form);

    // calibration board
    wrap.appendChild(mk('h4', null, 'Calibration board — Brier score (lower = better calibrated)'));
    var board = mk('div', 'vx-cal-board');
    wrap.appendChild(board);

    // export / import
    var io = mk('div', 'vx-cal-io');
    var expBtn = mk('button', 'vx-lab-action', 'Export JSON'); expBtn.type = 'button';
    var impBtn = mk('button', 'vx-lab-action', 'Import JSON'); impBtn.type = 'button';
    var ta = mk('textarea', 'vx-cal-ta'); ta.rows = 4;
    ta.setAttribute('aria-label', 'Calibration league snapshot JSON');
    expBtn.onclick = function () { ta.value = api.exportState(); };
    impBtn.onclick = function () {
      var r = api.importState(ta.value);
      ta.value = r.ok ? 'Imported.' : r.message;
      render();
    };
    io.appendChild(expBtn); io.appendChild(impBtn); io.appendChild(ta);
    wrap.appendChild(io);

    var foot = mk('p', 'vx-cal-foot',
      'Settled automatically from scored protocol verdicts. ' +
      'The proposer of a question can never settle it. ' +
      'Paper lab-points only — no exchange, no withdrawal, no real money.');
    wrap.appendChild(foot);
    el.appendChild(wrap);

    function render() {
      var me = api.getLearner();
      var ls = api.learnerState(me);
      lbal.textContent = ' Calibration points: ' + ls.points.toFixed(2) +
        (ls.cooldownMsLeft > 0 ? ' (cooldown: ' + Math.ceil(ls.cooldownMsLeft / 1000) + 's)' : '');

      qlist.innerHTML = '';
      var ms = api.listMarkets();
      if (!ms.length) qlist.appendChild(mk('p', 'vx-cal-empty', 'No questions yet — propose one above.'));
      ms.forEach(function (m) {
        var card = mk('div', 'vx-cal-qcard');
        card.appendChild(mk('div', 'vx-cal-qtext', m.question));
        if (m.detail) card.appendChild(mk('div', 'vx-cal-qdetail', m.detail));
        var py = api.price(m.id, 0);
        var odds = mk('div', 'vx-cal-odds',
          'Current odds — ' + m.yesLabel + ': ' + pct(py) + ' · ' + m.noLabel + ': ' + pct(1 - py));
        card.appendChild(odds);
        card.appendChild(mk('div', 'vx-cal-prior', 'A prior to test, not an answer to copy.'));
        card.appendChild(mk('div', 'vx-cal-meta',
          'Proposed by ' + m.createdBy + ' · status: ' + m.status +
          (m.link && m.link.runId ? ' · run: ' + m.link.runId : '') +
          (m.status === 'resolved' ? ' · settled ' + (m.outcome === 0 ? m.yesLabel : m.noLabel) : '') +
          (m.status === 'void' ? ' · voided, stakes refunded' : '')));
        if (m.status === 'open') {
          var srow = mk('div', 'vx-cal-stake');
          var selY = mk('button', 'vx-lab-action vx-cal-pick', m.yesLabel); selY.type = 'button';
          var selN = mk('button', 'vx-lab-action vx-cal-pick', m.noLabel); selN.type = 'button';
          var amt = mk('input', 'vx-cal-amt'); amt.type = 'number'; amt.min = '0.5';
          amt.max = String(STAKE_CAP); amt.step = '0.5'; amt.value = '5';
          amt.setAttribute('aria-label', 'Points to stake (max ' + STAKE_CAP + ')');
          var pick = 0;
          function paintPick() {
            selY.classList.toggle('vx-cal-picked', pick === 0);
            selN.classList.toggle('vx-cal-picked', pick === 1);
            preview();
          }
          selY.onclick = function () { pick = 0; paintPick(); };
          selN.onclick = function () { pick = 1; paintPick(); };
          var pv = mk('span', 'vx-cal-preview');
          function preview() {
            var c = Number(amt.value);
            if (c > 0 && c <= STAKE_CAP) {
              var sh = api.lmsr.sharesForCost(m, pick, c);
              pv.textContent = ' ≈ ' + sh.toFixed(2) + ' shares at ' + pct(api.price(m.id, pick));
            } else pv.textContent = '';
          }
          amt.oninput = preview;
          var sbtn = mk('button', 'vx-lab-action', 'Stake calibration points'); sbtn.type = 'button';
          var smsg = mk('span', 'vx-cal-msg');
          sbtn.onclick = function () {
            var r = api.stake(m.id, pick, Number(amt.value));
            smsg.textContent = r.ok
              ? 'Staked ' + r.cost + ' pts → ' + r.shares.toFixed(2) + ' shares.'
              : r.message;
            render();
          };
          srow.appendChild(selY); srow.appendChild(selN); srow.appendChild(amt);
          srow.appendChild(sbtn); srow.appendChild(pv); srow.appendChild(smsg);
          card.appendChild(srow);
          paintPick();
        }
        qlist.appendChild(card);
      });

      board.innerHTML = '';
      var rows = api.leaderboard();
      if (!rows.length) board.appendChild(mk('p', null, 'No settled questions yet — nothing calibrated.'));
      rows.forEach(function (r, i) {
        board.appendChild(mk('div', 'vx-cal-brow',
          '#' + (i + 1) + ' ' + r.id + ' · Brier ' + r.brier.toFixed(3) +
          ' · ' + r.nResolved + ' settled forecasts · ' + r.points.toFixed(2) + ' pts'));
      });
    }

    V.bus.on('vx:markets', function () { render(); });
    render();
  });

  // ---------------- headless-safe selfTest ----------------
  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }

    // Guard dependency: resolution requires w06-protocols. Stub it in the test
    // only if the real module is absent (load order puts protocols before markets).
    var stubbed = false;
    if (!V.has('w06-protocols')) {
      V.register('w06-protocols', {
        __w08testStub: true,
        selfTest: function () { return { ok: true, checks: [] }; }
      });
      stubbed = true;
    }

    var savedState = exportState();
    resetState();

    var t = 1000000;
    api.__setClock(function () { return t; });
    function advance(ms) { t += ms; }

    try {
      // 1. LMSR price bounds (0,1)
      var c1 = createMarket({ question: 'opposing-winding merger CONFIRMED by run 7', creatorId: 't-creator' });
      check('create market ok', c1.ok, c1.ok ? c1.market.id : c1.message);
      var mid = c1.market.id;
      var p0 = api.price(mid, 0);
      check('lmsr initial price is 0.5', p0 === 0.5, 'price=' + p0);
      var s1 = stake(mid, 0, 10, { callerId: 't-alice' });
      check('stake accepted', s1.ok, s1.ok ? 'shares=' + s1.shares : s1.message);
      var p1 = api.price(mid, 0), p1n = api.price(mid, 1);
      check('lmsr price in (0,1) after buy', p1 > 0 && p1 < 1 && p1n > 0 && p1n < 1, 'yes=' + p1 + ' no=' + p1n);
      check('lmsr buying yes raises yes-price', p1 > p0, p0 + ' -> ' + p1);
      check('lmsr prices sum to 1', Math.abs(p1 + p1n - 1) < 1e-12, String(p1 + p1n));

      // 2. cost function monotonic
      var m = getMarket(mid);
      var cA = costToBuy(m, 0, 1), cB = costToBuy(m, 0, 5), cC = costToBuy(m, 0, 10);
      check('lmsr cost monotonic in shares', cA < cB && cB < cC, cA + ' < ' + cB + ' < ' + cC);
      check('lmsr costFn monotonic in qYes',
        costFn(0, 0, 100) < costFn(50, 0, 100) && costFn(50, 0, 100) < costFn(100, 0, 100), '');
      var shBack = sharesForCost(m, 0, cB);
      check('lmsr sharesForCost inverts costToBuy', Math.abs(shBack - 5) < 1e-6, 'shares=' + shBack);

      // 3. stake cap: 21 rejected, 20 accepted
      var over = stake(mid, 0, 21, { callerId: 't-bob' });
      check('stake cap rejects 21', !over.ok && over.code === 'STAKE_CAP', over.code + ': ' + over.message);
      var atCap = stake(mid, 0, 20, { callerId: 't-bob' });
      check('stake cap accepts 20', atCap.ok, atCap.ok ? 'ok' : atCap.message);
      var cum = stake(mid, 0, 1, { callerId: 't-bob' });
      check('immediate restake after 20-pt stake hits cooldown', !cum.ok && cum.code === 'COOLDOWN',
        cum.code + ': ' + cum.message);
      // The cumulative per-question cap (15+6 > 20) is exercised explicitly below with t-uma.

      // 4. cooldown: immediate second stake rejected, later one accepted
      var k1 = stake(mid, 1, 5, { callerId: 't-carol' });
      check('first stake ok', k1.ok, k1.ok ? 'ok' : k1.message);
      var k2 = stake(mid, 1, 5, { callerId: 't-carol' });
      check('cooldown rejects immediate restake', !k2.ok && k2.code === 'COOLDOWN', k2.code + ': ' + k2.message);
      advance(61000);
      var k3 = stake(mid, 1, 5, { callerId: 't-carol' });
      check('stake ok after 61s', k3.ok, k3.ok ? 'ok' : k3.message);

      // cumulative cap without cooldown interference
      var cm = createMarket({ question: 'cumulative cap probe', creatorId: 't-creator' }).market.id;
      var u1 = stake(cm, 0, 15, { callerId: 't-uma' });
      advance(61000);
      var u2 = stake(cm, 0, 6, { callerId: 't-uma' });
      check('cumulative per-question cap rejects 15+6', u1.ok && !u2.ok && u2.code === 'STAKE_CAP',
        (u1.ok ? '15 ok; ' : '15 failed; ') + u2.code + ': ' + u2.message);

      // 5. creator cannot resolve
      var m2 = createMarket({ question: 'k-h shear CONFIRMED by run 3', creatorId: 't-dave' }).market.id;
      var vYes = { status: 'scored', marketId: m2, outcome: 'yes', runId: 'run-3', verdict: 'CONFIRMED' };
      var selfR = resolveMarket(m2, 'yes', vYes, 't-dave');
      check('creator cannot resolve own question', !selfR.ok && selfR.code === 'SELF_RESOLVE',
        selfR.code + ': ' + selfR.message);

      // 6. Brier computed correctly on synthetic resolved markets
      var m3 = createMarket({ question: 'merger time under 40s in run 9', creatorId: 't-gus' }).market.id;
      var e1 = stake(m3, 0, 10, { callerId: 't-erin' });   // yes
      advance(61000);
      var f1 = stake(m3, 1, 8, { callerId: 't-fay' });    // no
      check('synthetic stakes placed', e1.ok && f1.ok, '');
      var pE = e1.price, pF = f1.price, shE = e1.shares;
      var v3 = { status: 'scored', marketId: m3, outcome: 'yes', runId: 'run-9', verdict: 'CONFIRMED' };
      var r3 = resolveMarket(m3, 'yes', v3, 't-heidi'); // non-creator resolves
      check('non-creator resolve with scored verdict ok', r3.ok && r3.status === 'resolved',
        r3.ok ? r3.status : r3.message);
      var expBrierE = Math.pow(pE - 1, 2);
      var expBrierF = Math.pow(pF - 0, 2);
      var lb = leaderboard();
      var rowE = null, rowF = null, i;
      for (i = 0; i < lb.length; i++) {
        if (lb[i].id === 't-erin') rowE = lb[i];
        if (lb[i].id === 't-fay') rowF = lb[i];
      }
      check('brier for winning yes-stake correct',
        !!rowE && Math.abs(rowE.brier - expBrierE) < 1e-9,
        rowE ? 'got ' + rowE.brier + ' want ' + expBrierE : 'row missing');
      check('brier for losing no-stake correct',
        !!rowF && Math.abs(rowF.brier - expBrierF) < 1e-9,
        rowF ? 'got ' + rowF.brier + ' want ' + expBrierF : 'row missing');
      check('leaderboard sorted by brier asc',
        lb.length >= 2 && lb[0].brier <= lb[1].brier, lb.map(function (r) { return r.id + ':' + r.brier.toFixed(4); }).join(', '));
      var erinPts = learnerState('t-erin').points;
      var expErin = Math.round((START_POINTS - 10 + shE) * 100) / 100; // points are 2-decimal
      check('winner payout = shares added back',
        Math.abs(erinPts - expErin) < 1e-9, 'points=' + erinPts + ' want=' + expErin);

      // 7. resolution without a scored verdict is rejected
      var m4 = createMarket({ question: 'unresolved probe', creatorId: 't-creator' }).market.id;
      var n1 = resolveMarket(m4, 'yes', null, 't-heidi');
      check('null verdict rejected', !n1.ok && n1.code === 'NO_SCORED_VERDICT', n1.code + '');
      var n2 = resolveMarket(m4, 'yes', { status: 'draft', marketId: m4, outcome: 'yes' }, 't-heidi');
      check('unscored verdict rejected', !n2.ok && n2.code === 'NO_SCORED_VERDICT', n2.code + '');
      var n3 = resolveMarket(m4, 'no', { status: 'scored', marketId: m4, outcome: 'yes', verdict: 'CONFIRMED' }, 't-heidi');
      check('outcome/verdict mismatch rejected', !n3.ok && n3.code === 'OUTCOME_MISMATCH', n3.code + '');
      var n4 = resolveMarket(m4, 'yes', { status: 'scored', marketId: 'cal-nope', outcome: 'yes' }, 't-heidi');
      check('verdict for another question rejected', !n4.ok && n4.code === 'NO_SCORED_VERDICT', n4.code + '');

      // 8. void (INCONCLUSIVE) refunds stakes, records no Brier terms
      var m5 = createMarket({ question: 'void probe run 11', creatorId: 't-creator' }).market.id;
      stake(m5, 0, 10, { callerId: 't-ivan' });
      advance(61000);
      stake(m5, 1, 6, { callerId: 't-june' });
      var vv = { status: 'scored', marketId: m5, outcome: 'void', runId: 'run-11', verdict: 'INCONCLUSIVE' };
      var r5 = resolveMarket(m5, 'void', vv, 't-heidi');
      var ivanPts = learnerState('t-ivan').points, junePts = learnerState('t-june').points;
      check('void refunds both stakes',
        r5.ok && r5.status === 'void' && ivanPts === START_POINTS && junePts === START_POINTS,
        'ivan=' + ivanPts + ' june=' + junePts);
      check('void records no brier terms',
        learnerState('t-ivan').nResolved === 0 && learnerState('t-june').nResolved === 0, '');

      // 9. export/import roundtrip
      var snap = exportState();
      resetState();
      check('reset clears questions', listMarkets().length === 0, '');
      var imp = importState(snap);
      check('import restores snapshot', imp.ok && listMarkets().length > 0,
        imp.ok ? listMarkets().length + ' questions' : imp.message);
      var bad = importState('not json{{{');
      check('bad import rejected', !bad.ok && bad.code === 'BAD_IMPORT', bad.code + '');

      // 10. automatic resolution from a scored-verdict bus event
      var m6 = createMarket({
        question: 'auto-settle probe', creatorId: 't-creator', link: { runId: 'run-auto-1' }
      }).market.id;
      stake(m6, 0, 5, { callerId: 't-kim' });
      V.bus.emit('vx:verdict', {
        status: 'scored', runId: 'run-auto-1', verdict: 'CONFIRMED', outcome: 'yes', verdictId: 'v-1'
      });
      var m6s = getMarket(m6);
      check('bus verdict auto-settles linked question',
        m6s.status === 'resolved' && m6s.outcome === 0,
        'status=' + m6s.status + ' outcome=' + m6s.outcome);

      check('w06 stub note', true, stubbed ? 'w06-protocols was absent; test stub registered' : 'real w06-protocols present');
    } finally {
      api.__resetClock();
      importState(savedState); // leave no test residue in memory or storage
    }

    var allOk = true, i;
    for (i = 0; i < checks.length; i++) if (!checks[i].ok) { allOk = false; break; }
    return { ok: allOk, checks: checks };
  }

  V.register('w08-markets', api);
})(typeof window !== 'undefined' ? window : globalThis);
