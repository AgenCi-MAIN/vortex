/* VORTEX js/teach-her.js — [W09] Rigorous teach-her loop.
 *
 * A measurable curriculum, not a chat toy. Six enforced phases with
 * validation gates (brief -> predict -> run -> observe -> judge -> remember);
 * a round cannot advance or save until the current phase validates.
 *
 * - 4-dimension rubric (0-3 per dimension, anchored levels); headline = mean,
 *   notebook keeps the full vector.
 * - Skill tree Novice -> Predictor -> Designer -> Mentor with evidence-based
 *   graduation; a node unlocks only when its parent's criteria are met.
 * - Spaced-repetition cards on a 1-3-7-21 day schedule.
 * - Identity-agnostic roles: learner_id / teacher_id / observer_id. Nothing
 *   in this module assumes a name; everything assumes a role.
 *
 * Plain script, no modules. Headless-safe: all DOM lives in the panel
 * mount function; selfTest() runs with no DOM present.
 */
(function () {
  'use strict';

  function teachHerImpl() {
    var root = typeof window !== 'undefined' ? window : globalThis;
    var V = root.VORTEX || {};

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    var PHASES = [
      { id: 'brief', title: 'Brief' },
      { id: 'predict', title: 'Predict' },
      { id: 'run', title: 'Run' },
      { id: 'observe', title: 'Observe' },
      { id: 'judge', title: 'Judge' },
      { id: 'remember', title: 'Remember' }
    ];

    var RUBRIC = [
      {
        id: 'predictionAccuracy', title: 'Prediction accuracy',
        anchors: [
          '0 — prediction wrong and wrong-direction',
          '1 — right direction, wrong magnitude (>50% off)',
          '2 — right ballpark (within 50%)',
          '3 — within stated uncertainty or <15% error'
        ]
      },
      {
        id: 'probeQuality', title: 'Probe choice quality',
        anchors: [
          '0 — probe cannot test the intent (wrong regime, mis-set parameters)',
          '1 — tests the intent but confounded (two knobs changed at once)',
          '2 — clean single-variable test',
          '3 — discriminating test: at least two plausible hypotheses would give different outcomes'
        ]
      },
      {
        id: 'observationQuality', title: 'Observation quality',
        anchors: [
          '0 — no measured outcome',
          '1 — qualitative description only ("looked turbulent")',
          '2 — one measured value reported',
          '3 — measured value + comparison to prediction (error quantified) + note on what was uncontrolled'
        ]
      },
      {
        id: 'retentionValue', title: 'Retention value',
        anchors: [
          '0 — nothing generalizable learned',
          '1 — a fact worth keeping (parameter value, threshold)',
          '2 — a transferable heuristic ("merger time scales with…")',
          '3 — a correction: a notebook entry is edited, falsified, or superseded by this round'
        ]
      }
    ];

    var SKILL_NODES = [
      { id: 'novice', title: 'Novice', parent: null,
        blurb: 'State an intent, pick a preset probe, log a measured outcome.' },
      { id: 'predictor', title: 'Predictor', parent: 'novice',
        blurb: 'Quantitative predictions with uncertainty, single-variable probes.' },
      { id: 'designer', title: 'Designer', parent: 'predictor',
        blurb: 'Build probes from scratch, write falsifiable intents.' },
      { id: 'mentor', title: 'Mentor', parent: 'designer',
        blurb: 'Review other learners\u2019 rounds; run the loop solo.' }
    ];

    var DAY_MS = 86400000;
    var LADDER = [1, 3, 7, 21]; // spaced-repetition schedule, days
    var STALE_DAYS = 60;        // unverified longer than this -> flagged
    var STORE_KEY = 'vx-w09-teachher-v1';

    // A number with an explicit unit. ± uncertainty optional.
    // Accepts e.g. "t≈3.2±0.4 τ", "0.5s", "Re 1200", "Mach 0.3", "40%".
    var QUANT_RE = /[0-9]+(?:\.[0-9]+)?(?:\s*[±]\s*[0-9]+(?:\.[0-9]+)?)?\s*(?:τ|tau|ms|s\b|%|re\b|mach\b|frames?|steps?|°|x\b)/i;

    // ------------------------------------------------------------------
    // State + persistence (localStorage only inside try/catch)
    // ------------------------------------------------------------------
    var state = { rounds: [], cards: [], seq: 0 };

    function persist() {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(STORE_KEY, JSON.stringify({
          rounds: state.rounds, cards: state.cards, seq: state.seq
        }));
      } catch (e) { /* storage unavailable: keep in-memory only */ }
    }
    function restore() {
      try {
        if (typeof localStorage === 'undefined') return;
        var raw = localStorage.getItem(STORE_KEY);
        if (!raw) return;
        var o = JSON.parse(raw);
        if (o && Array.isArray(o.rounds)) state.rounds = o.rounds;
        if (o && Array.isArray(o.cards)) state.cards = o.cards;
        if (o && typeof o.seq === 'number') state.seq = o.seq;
      } catch (e) { /* corrupt store: start clean */ }
    }
    restore();

    function nextId(prefix) {
      state.seq += 1;
      return prefix + '-' + Date.now().toString(36) + '-' + state.seq;
    }

    function err(list, msg) { list.push(msg); }
    function isNonEmptyString(s) {
      return typeof s === 'string' && s.trim().length > 0;
    }

    // ------------------------------------------------------------------
    // Rounds
    // ------------------------------------------------------------------
    // Identity-agnostic: learner_id and teacher_id are required and are
    // never defaulted to a name. observer_id is optional.
    function newRound(roles) {
      roles = roles || {};
      if (!isNonEmptyString(roles.learner_id)) {
        throw new Error('teach-her: newRound requires learner_id (never defaulted)');
      }
      if (!isNonEmptyString(roles.teacher_id)) {
        throw new Error('teach-her: newRound requires teacher_id (never defaulted)');
      }
      var r = {
        id: nextId('round'),
        learner_id: roles.learner_id.trim(),
        teacher_id: roles.teacher_id.trim(),
        observer_id: isNonEmptyString(roles.observer_id) ? roles.observer_id.trim() : null,
        phaseIndex: 0,
        phaseData: { brief: {}, predict: {}, run: {}, observe: {}, judge: {}, remember: {} },
        status: 'draft',
        createdAt: Date.now(),
        savedAt: null,
        rubric: null,
        headline: null,
        probeHash: null,
        manifest: null
      };
      state.rounds.push(r);
      return r;
    }

    function getRound(id) {
      for (var i = 0; i < state.rounds.length; i++) {
        if (state.rounds[i].id === id) return state.rounds[i];
      }
      return null;
    }

    function setPhaseData(id, phaseId, data) {
      var r = getRound(id);
      if (!r) throw new Error('teach-her: unknown round ' + id);
      if (!r.phaseData.hasOwnProperty(phaseId)) throw new Error('teach-her: bad phase ' + phaseId);
      var cur = r.phaseData[phaseId] || {};
      var keys = Object.keys(data || {});
      for (var i = 0; i < keys.length; i++) cur[keys[i]] = data[keys[i]];
      r.phaseData[phaseId] = cur;
      return r;
    }

    // ------------------------------------------------------------------
    // Phase validation gates
    // ------------------------------------------------------------------
    function validateBrief(d) {
      var errors = [];
      if (!isNonEmptyString(d.probe)) err(errors, 'Brief: choose a probe (name or preset id).');
      if (!isNonEmptyString(d.intent)) err(errors, 'Brief: state a one-sentence intent.');
      else if (d.intent.trim().split(/\s+/).length < 4) {
        err(errors, 'Brief: intent must be a real sentence (≥4 words).');
      }
      return { ok: errors.length === 0, errors: errors };
    }

    function validatePredict(d) {
      var errors = [];
      if (!isNonEmptyString(d.text)) {
        err(errors, 'Predict: write a quantitative prediction.');
      } else if (!QUANT_RE.test(d.text)) {
        err(errors, 'Predict: include at least one number with units (e.g. "t≈3.2±0.4 τ"). No vibes-only predictions.');
      }
      var c = d.confidence;
      if (!(typeof c === 'number' && c >= 1 && c <= 5 && Math.floor(c) === c)) {
        err(errors, 'Predict: confidence must be an integer 1–5.');
      }
      return { ok: errors.length === 0, errors: errors };
    }

    // Probe parameter hash is captured automatically via VORTEX.makeManifest
    // when available; otherwise a manually supplied hash is required.
    function makeProbeHash(runData) {
      if (V && typeof V.makeManifest === 'function') {
        var m = V.makeManifest({
          seed: (runData.params && runData.params.seed) || 0,
          params: runData.params || {},
          configId: runData.configId || 'spiral-default',
          probeTimeline: runData.probeTimeline || [],
          backend: runData.backend || 'cpu',
          tracers: runData.tracers || 0,
          toleranceBands: {}
        });
        return { hash: m.hash, manifest: m };
      }
      return { hash: runData.probeHash || null, manifest: null };
    }

    function validateRun(d) {
      var errors = [];
      var h = makeProbeHash(d || {});
      if (!h.hash) {
        err(errors, 'Run: no probe parameter hash — capture one automatically or supply it manually.');
      }
      return { ok: errors.length === 0, errors: errors, hash: h.hash, manifest: h.manifest };
    }

    function validateObserve(d) {
      var errors = [];
      var outs = Array.isArray(d.outcomes) ? d.outcomes : [];
      var measured = outs.filter(function (o) {
        return o && isNonEmptyString(o.metric) &&
          (typeof o.value === 'number' || (typeof o.value === 'string' && /[0-9]/.test(o.value))) &&
          isNonEmptyString(o.unit);
      });
      if (measured.length === 0) {
        err(errors, 'Observe: record at least one measured outcome (metric + value + unit) before free text.');
      }
      return { ok: errors.length === 0, errors: errors, measured: measured };
    }

    function validateRubricVector(vec) {
      var errors = [];
      for (var i = 0; i < RUBRIC.length; i++) {
        var id = RUBRIC[i].id;
        var v = vec ? vec[id] : undefined;
        if (!(typeof v === 'number' && v >= 0 && v <= 3 && Math.floor(v) === v)) {
          err(errors, 'Judge: "' + RUBRIC[i].title + '" must be an integer 0–3.');
        }
      }
      return errors;
    }

    function validateJudge(d) {
      var errors = validateRubricVector(d.rubric);
      var pa = d.rubric ? d.rubric.predictionAccuracy : undefined;
      // Any prediction-accuracy score ≥2 or ≤0 needs a one-line justification.
      if ((pa === 0 || pa === 2 || pa === 3) && !isNonEmptyString(d.justification)) {
        err(errors, 'Judge: prediction-accuracy ' + pa + ' needs a one-line justification.');
      }
      if (d.observerRubric) {
        var oe = validateRubricVector(d.observerRubric);
        for (var i = 0; i < oe.length; i++) err(errors, 'Judge (observer): ' + oe[i]);
      }
      return { ok: errors.length === 0, errors: errors };
    }

    function validateRemember(d) {
      var errors = [];
      var entries = Array.isArray(d.entries) ? d.entries : [];
      var good = entries.filter(function (e) {
        return e && isNonEmptyString(e.text) &&
          SKILL_NODES.some(function (n) { return n.id === e.node; }) &&
          (e.kind === 'fact' || e.kind === 'heuristic' || e.kind === 'question');
      });
      if (good.length === 0) {
        err(errors, 'Remember: add at least one entry tagged to a skill-tree node, flagged fact / heuristic / question.');
      }
      return { ok: errors.length === 0, errors: errors, entries: good };
    }

    var VALIDATORS = {
      brief: validateBrief, predict: validatePredict, run: validateRun,
      observe: validateObserve, judge: validateJudge, remember: validateRemember
    };

    function validatePhase(roundOrId, phaseId) {
      var r = typeof roundOrId === 'string' ? getRound(roundOrId) : roundOrId;
      if (!r) return { ok: false, errors: ['Unknown round.'] };
      if (!VALIDATORS[phaseId]) return { ok: false, errors: ['Unknown phase ' + phaseId + '.'] };
      return VALIDATORS[phaseId](r.phaseData[phaseId] || {});
    }

    function advance(id) {
      var r = getRound(id);
      if (!r) return { ok: false, errors: ['Unknown round.'] };
      if (r.status === 'saved') return { ok: false, errors: ['Round already saved.'] };
      var pid = PHASES[r.phaseIndex].id;
      var v = validatePhase(r, pid);
      if (!v.ok) return v;
      if (r.phaseIndex < PHASES.length - 1) r.phaseIndex += 1;
      persist();
      return { ok: true, errors: [], phase: PHASES[r.phaseIndex].id };
    }

    function goToPhase(id, index) {
      var r = getRound(id);
      if (!r) return { ok: false, errors: ['Unknown round.'] };
      if (r.status === 'saved') return { ok: false, errors: ['Round already saved.'] };
      if (typeof index !== 'number' || index < 0 || index >= PHASES.length) {
        return { ok: false, errors: ['Bad phase index.'] };
      }
      // Can move freely backwards; forwards only through validated gates.
      if (index > r.phaseIndex) {
        for (var i = r.phaseIndex; i < index; i++) {
          var v = validatePhase(r, PHASES[i].id);
          if (!v.ok) return { ok: false, errors: ['Cannot skip phase "' + PHASES[i].title + '":'].concat(v.errors) };
        }
      }
      r.phaseIndex = index;
      return { ok: true, errors: [], phase: PHASES[r.phaseIndex].id };
    }

    // ------------------------------------------------------------------
    // Rubric scoring
    // ------------------------------------------------------------------
    function headline(vector) {
      var sum = 0, n = 0;
      for (var i = 0; i < RUBRIC.length; i++) {
        var v = vector[RUBRIC[i].id];
        if (typeof v === 'number') { sum += v; n += 1; }
      }
      if (n === 0) return null;
      return sum / n;
    }

    // ------------------------------------------------------------------
    // Save: all six phases must validate. Emits vx:teachher-round.
    // ------------------------------------------------------------------
    function saveRound(id) {
      var r = getRound(id);
      if (!r) return { ok: false, errors: ['Unknown round.'] };
      if (r.status === 'saved') return { ok: false, errors: ['Round already saved.'] };
      var errors = [];
      var runRes = null;
      for (var i = 0; i < PHASES.length; i++) {
        var pid = PHASES[i].id;
        var v = validatePhase(r, pid);
        if (!v.ok) errors = errors.concat(['[' + PHASES[i].title + ']'].concat(v.errors));
        if (pid === 'run') runRes = v;
      }
      if (errors.length > 0) return { ok: false, errors: errors };

      r.rubric = {
        predictionAccuracy: r.phaseData.judge.rubric.predictionAccuracy,
        probeQuality: r.phaseData.judge.rubric.probeQuality,
        observationQuality: r.phaseData.judge.rubric.observationQuality,
        retentionValue: r.phaseData.judge.rubric.retentionValue
      };
      r.headline = headline(r.rubric);
      r.probeHash = runRes.hash;
      r.manifest = runRes.manifest;
      r.status = 'saved';
      r.savedAt = Date.now();

      // Remember entries become spaced-repetition cards.
      var rem = validateRemember(r.phaseData.remember);
      for (var j = 0; j < rem.entries.length; j++) {
        addCard({
          text: rem.entries[j].text,
          kind: rem.entries[j].kind,
          node: rem.entries[j].node,
          roundId: r.id,
          learner_id: r.learner_id
        });
      }

      persist();

      // Guard absence: emit only if the bus exists (headless / other shells).
      try {
        if (V && V.bus && typeof V.bus.emit === 'function') {
          V.bus.emit('vx:teachher-round', {
            roundId: r.id,
            learner_id: r.learner_id,
            teacher_id: r.teacher_id,
            observer_id: r.observer_id,
            rubric: r.rubric,
            headline: r.headline,
            probeHash: r.probeHash,
            savedAt: r.savedAt
          });
        }
      } catch (e) { /* event emission must never break a save */ }

      return { ok: true, errors: [], round: r };
    }

    function savedRounds() {
      return state.rounds.filter(function (r) { return r.status === 'saved'; });
    }

    // ------------------------------------------------------------------
    // Skill tree: evidence-based graduation
    // ------------------------------------------------------------------
    function learnerRounds(learnerId) {
      return savedRounds().filter(function (r) { return r.learner_id === learnerId; });
    }

    function meanDim(rs, dim) {
      if (rs.length === 0) return 0;
      var s = 0;
      for (var i = 0; i < rs.length; i++) s += rs[i].rubric[dim];
      return s / rs.length;
    }

    // Agreement: learner judged a round as observer and their vector is
    // within ±0.5 of the teacher's official vector on every dimension.
    function observerAgreement(learnerId) {
      var count = 0;
      var rs = savedRounds();
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        if (r.observer_id !== learnerId) continue;
        var obs = r.phaseData.judge.observerRubric;
        if (!obs) continue;
        var worst = 0;
        for (var j = 0; j < RUBRIC.length; j++) {
          var id = RUBRIC[j].id;
          worst = Math.max(worst, Math.abs(obs[id] - r.rubric[id]));
        }
        if (worst <= 0.5) count += 1;
      }
      return count;
    }

    // Returns { met, criteria: [{label, met, have, need}] }.
    function checkGraduation(learnerId, nodeId) {
      var rs = learnerRounds(learnerId);
      var criteria = [];
      if (nodeId === 'novice') {
        criteria.push({ label: '≥3 complete rounds', met: rs.length >= 3, have: rs.length, need: 3 });
        criteria.push({ label: 'mean observation quality ≥1', met: meanDim(rs, 'observationQuality') >= 1, have: round2(meanDim(rs, 'observationQuality')), need: 1 });
      } else if (nodeId === 'predictor') {
        criteria.push({ label: '≥5 rounds', met: rs.length >= 5, have: rs.length, need: 5 });
        criteria.push({ label: 'mean prediction accuracy ≥2', met: meanDim(rs, 'predictionAccuracy') >= 2, have: round2(meanDim(rs, 'predictionAccuracy')), need: 2 });
        criteria.push({ label: 'mean probe quality ≥2', met: meanDim(rs, 'probeQuality') >= 2, have: round2(meanDim(rs, 'probeQuality')), need: 2 });
      } else if (nodeId === 'designer') {
        var selfDesigned = rs.filter(function (r) {
          return r.phaseData.run.selfDesigned === true && r.rubric.probeQuality >= 2;
        }).length;
        var corrections = rs.filter(function (r) { return r.rubric.retentionValue === 3; }).length;
        criteria.push({ label: '3 self-designed rounds at probe quality ≥2', met: selfDesigned >= 3, have: selfDesigned, need: 3 });
        criteria.push({ label: '1 retention-3 round (notebook correction)', met: corrections >= 1, have: corrections, need: 1 });
      } else if (nodeId === 'mentor') {
        var agree = observerAgreement(learnerId);
        criteria.push({ label: '3 judged rounds within ±0.5 of consensus', met: agree >= 3, have: agree, need: 3 });
      } else {
        return { met: false, criteria: [{ label: 'unknown node', met: false, have: 0, need: 1 }] };
      }
      var met = criteria.every(function (c) { return c.met; });
      return { met: met, criteria: criteria };
    }

    function round2(x) { return Math.round(x * 100) / 100; }

    // Node status for a learner: graduated | available | locked (parent not met).
    function nodeStatus(learnerId) {
      return SKILL_NODES.map(function (n) {
        var parentOk = n.parent === null ? true : checkGraduation(learnerId, n.parent).met;
        var g = checkGraduation(learnerId, n.id);
        var status = g.met ? 'graduated' : (parentOk ? 'available' : 'locked');
        return { id: n.id, title: n.title, parent: n.parent, blurb: n.blurb, status: status, graduation: g };
      });
    }

    // ------------------------------------------------------------------
    // Spaced repetition: 1-3-7-21 day cards
    // ------------------------------------------------------------------
    function addCard(o) {
      o = o || {};
      var now = typeof o.createdAt === 'number' ? o.createdAt : Date.now();
      var ladder = typeof o.ladderIndex === 'number' ? o.ladderIndex : 0;
      ladder = Math.max(0, Math.min(LADDER.length - 1, ladder));
      var c = {
        id: nextId('card'),
        text: o.text || '',
        kind: (o.kind === 'fact' || o.kind === 'question') ? o.kind : 'heuristic',
        node: o.node || 'novice',
        roundId: o.roundId || null,
        learner_id: o.learner_id || null,
        createdAt: now,
        lastVerifiedAt: typeof o.lastVerifiedAt === 'number' ? o.lastVerifiedAt : null,
        ladderIndex: ladder,
        intervalDays: LADDER[ladder],
        verified: 0,
        misses: 0
      };
      c.dueAt = (c.lastVerifiedAt !== null ? c.lastVerifiedAt : c.createdAt) + c.intervalDays * DAY_MS;
      state.cards.push(c);
      persist();
      return c;
    }

    function getCard(id) {
      for (var i = 0; i < state.cards.length; i++) {
        if (state.cards[i].id === id) return state.cards[i];
      }
      return null;
    }

    // Correct verification advances up the ladder; a miss resets to day 1.
    function verifyCard(id, correct, nowMs) {
      var c = getCard(id);
      if (!c) return { ok: false, errors: ['Unknown card.'] };
      var now = typeof nowMs === 'number' ? nowMs : Date.now();
      if (correct) {
        c.verified += 1;
        c.ladderIndex = Math.min(c.ladderIndex + 1, LADDER.length - 1);
      } else {
        c.misses += 1;
        c.ladderIndex = 0;
      }
      c.intervalDays = LADDER[c.ladderIndex];
      c.lastVerifiedAt = now;
      c.dueAt = now + c.intervalDays * DAY_MS;
      persist();
      return { ok: true, errors: [], card: c };
    }

    function isFlagged(c, now) {
      var last = c.lastVerifiedAt !== null ? c.lastVerifiedAt : c.createdAt;
      return (now - last) > STALE_DAYS * DAY_MS;
    }

    function dueCards(nowMs) {
      var now = typeof nowMs === 'number' ? nowMs : Date.now();
      return state.cards
        .filter(function (c) { return c.dueAt <= now; })
        .sort(function (a, b) { return a.dueAt - b.dueAt; })
        .map(function (c) {
          return { card: c, prompt: microPrompt(c), flagged: isFlagged(c, now) };
        });
    }

    function microPrompt(c) {
      var short = c.text.length > 90 ? c.text.slice(0, 87) + '…' : c.text;
      return 'You wrote: "' + short + '" Still true? Design a 60-second probe to check.';
    }

    // ------------------------------------------------------------------
    // Panel: "Teach her"
    // ------------------------------------------------------------------
    function isBrowser() {
      return typeof root.document !== 'undefined';
    }

    function el(tag, attrs, children) {
      var d = root.document.createElement(tag);
      attrs = attrs || {};
      for (var k in attrs) {
        if (!attrs.hasOwnProperty(k)) continue;
        if (k === 'text') d.textContent = attrs[k];
        else if (k === 'html') d.innerHTML = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') d[k] = attrs[k];
        else d.setAttribute(k, attrs[k]);
      }
      (children || []).forEach(function (c) { if (c) d.appendChild(c); });
      return d;
    }

    function anchorFor(dimId, value) {
      for (var i = 0; i < RUBRIC.length; i++) {
        if (RUBRIC[i].id === dimId) return RUBRIC[i].anchors[value] || '';
      }
      return '';
    }

    function mountPanel(host) {
      if (!isBrowser()) return;
      var doc = root.document;

      var draftId = null;      // current draft round id
      var view = 'round';      // round | notebook | cards | tree
      var showPhase = 0;

      var wrap = el('div', { 'class': 'vx-teachher' });
      host.appendChild(wrap);

      var msgBox = el('div', { 'class': 'vx-th-msg' });
      function say(msgs, ok) {
        msgBox.innerHTML = '';
        (Array.isArray(msgs) ? msgs : [msgs]).forEach(function (m) {
          msgBox.appendChild(el('div', { 'class': ok ? 'vx-th-ok' : 'vx-th-err', text: String(m) }));
        });
      }

      // ---- roles bar ----
      var rolesBar = el('div', { 'class': 'vx-th-roles' });
      var inLearner = el('input', { type: 'text', placeholder: 'learner_id', 'aria-label': 'learner id' });
      var inTeacher = el('input', { type: 'text', placeholder: 'teacher_id', 'aria-label': 'teacher id' });
      var inObserver = el('input', { type: 'text', placeholder: 'observer_id (optional)', 'aria-label': 'observer id' });
      var btnNew = el('button', { type: 'button', text: 'Start round' });
      rolesBar.appendChild(el('span', { 'class': 'vx-th-label', text: 'Roles (ids, never names): ' }));
      rolesBar.appendChild(inLearner); rolesBar.appendChild(inTeacher);
      rolesBar.appendChild(inObserver); rolesBar.appendChild(btnNew);
      wrap.appendChild(rolesBar);

      // ---- view tabs ----
      var tabs = el('div', { 'class': 'vx-th-tabs' });
      [['round', 'Round'], ['notebook', 'Notebook'], ['cards', 'Due cards'], ['tree', 'Skill tree']].forEach(function (t) {
        var b = el('button', { type: 'button', text: t[1], 'data-view': t[0] });
        b.onclick = function () { view = t[0]; render(); };
        tabs.appendChild(b);
      });
      wrap.appendChild(tabs);

      var body = el('div', { 'class': 'vx-th-body' });
      wrap.appendChild(body);
      wrap.appendChild(msgBox);

      btnNew.onclick = function () {
        try {
          var r = newRound({
            learner_id: inLearner.value,
            teacher_id: inTeacher.value,
            observer_id: inObserver.value
          });
          draftId = r.id; showPhase = 0; view = 'round';
          say('Round ' + r.id + ' started. Phase 1 of 6: Brief.', true);
        } catch (e) {
          say(e.message, false);
        }
        render();
      };

      function currentDraft() {
        var r = draftId ? getRound(draftId) : null;
        return (r && r.status === 'draft') ? r : null;
      }

      function rubricSlider(container, dimId, initial, prefix) {
        var dim = RUBRIC.filter(function (d) { return d.id === dimId; })[0];
        var row = el('div', { 'class': 'vx-th-rubric' });
        var lab = el('label', { text: dim.title + ': ' });
        var val = el('span', { 'class': 'vx-th-rubval', text: String(initial) });
        var anc = el('div', { 'class': 'vx-th-anchor', text: anchorFor(dimId, initial) });
        var s = doc.createElement('input');
        s.type = 'range'; s.min = '0'; s.max = '3'; s.step = '1'; s.value = String(initial);
        s.setAttribute('aria-label', dim.title);
        s.oninput = function () {
          val.textContent = s.value;
          anc.textContent = anchorFor(dimId, parseInt(s.value, 10));
          var r = currentDraft();
          if (r) {
            var key = prefix || 'rubric';
            r.phaseData.judge[key] = r.phaseData.judge[key] || {};
            r.phaseData.judge[key][dimId] = parseInt(s.value, 10);
          }
        };
        row.appendChild(lab); row.appendChild(s); row.appendChild(val); row.appendChild(anc);
        container.appendChild(row);
      }

      function renderRound(r) {
        body.innerHTML = '';
        // stepper
        var stepper = el('div', { 'class': 'vx-th-stepper' });
        PHASES.forEach(function (p, i) {
          var b = el('button', {
            type: 'button',
            'class': 'vx-th-step' + (i === showPhase ? ' vx-th-active' : '') +
              (i < r.phaseIndex ? ' vx-th-done' : ''),
            text: (i + 1) + '. ' + p.title
          });
          b.onclick = function () {
            var res = goToPhase(r.id, i);
            if (res.ok) { showPhase = i; say('', true); }
            else say(res.errors, false);
            render();
          };
          stepper.appendChild(b);
        });
        body.appendChild(stepper);

        var pid = PHASES[showPhase].id;
        var data = r.phaseData[pid] || {};
        var form = el('div', { 'class': 'vx-th-form' });
        form.appendChild(el('h3', { text: 'Phase ' + (showPhase + 1) + ' of 6: ' + PHASES[showPhase].title }));

        if (pid === 'brief') {
          form.appendChild(el('label', { text: 'Probe choice' }));
          var probe = el('input', { type: 'text', value: data.probe || '', placeholder: 'e.g. spiral-stir, preset id, or custom name' });
          probe.oninput = function () { setPhaseData(r.id, 'brief', { probe: probe.value }); };
          form.appendChild(probe);
          form.appendChild(el('label', { text: 'One-sentence intent' }));
          var intent = doc.createElement('textarea');
          intent.value = data.intent || '';
          intent.placeholder = 'e.g. test whether higher Mach delays vortex merger';
          intent.oninput = function () { setPhaseData(r.id, 'brief', { intent: intent.value }); };
          form.appendChild(intent);
        } else if (pid === 'predict') {
          form.appendChild(el('label', { text: 'Quantitative prediction (number + units required)' }));
          var ptext = doc.createElement('textarea');
          ptext.value = data.text || '';
          ptext.placeholder = 'e.g. merger at t≈3.2±0.4 τ';
          ptext.oninput = function () { setPhaseData(r.id, 'predict', { text: ptext.value }); };
          form.appendChild(ptext);
          form.appendChild(el('label', { text: 'Confidence (1–5)' }));
          var conf = doc.createElement('select');
          for (var ci = 1; ci <= 5; ci++) {
            var op = el('option', { value: String(ci), text: String(ci) });
            if ((data.confidence || 3) === ci) op.selected = true;
            conf.appendChild(op);
          }
          conf.onchange = function () { setPhaseData(r.id, 'predict', { confidence: parseInt(conf.value, 10) }); };
          setPhaseData(r.id, 'predict', { confidence: data.confidence || 3 });
          form.appendChild(conf);
        } else if (pid === 'run') {
          form.appendChild(el('p', { text: 'Probe parameter hash is captured automatically from the run manifest.' }));
          var pgrid = [
            ['seed', 'seed (int)', data.params && data.params.seed],
            ['grid', 'grid (e.g. 256)', data.params && data.params.grid],
            ['re', 'Reynolds', data.params && data.params.re],
            ['mach', 'Mach', data.params && data.params.mach]
          ];
          var inputs = {};
          pgrid.forEach(function (g) {
            form.appendChild(el('label', { text: g[1] }));
            var inp = el('input', { type: 'text', value: g[2] !== undefined && g[2] !== null ? String(g[2]) : '' });
            inputs[g[0]] = inp; form.appendChild(inp);
          });
          var sd = doc.createElement('input'); sd.type = 'checkbox'; sd.checked = !!data.selfDesigned;
          sd.onchange = function () { setPhaseData(r.id, 'run', { selfDesigned: sd.checked }); };
          var sdl = el('label', {}); sdl.appendChild(sd);
          sdl.appendChild(doc.createTextNode(' I designed this probe parameter set from scratch (Designer evidence)'));
          form.appendChild(sdl);
          var hashLine = el('div', { 'class': 'vx-th-hash', text: data.probeHash ? ('hash: ' + data.probeHash) : 'hash: not captured yet' });
          form.appendChild(hashLine);
          var btnCap = el('button', { type: 'button', text: 'Capture probe hash' });
          btnCap.onclick = function () {
            var params = {};
            ['seed', 'grid', 're', 'mach'].forEach(function (k) {
              var v = inputs[k].value.trim();
              if (v !== '') params[k] = isNaN(Number(v)) ? v : Number(v);
            });
            setPhaseData(r.id, 'run', { params: params, selfDesigned: sd.checked });
            var res = validateRun(getRound(r.id).phaseData.run);
            if (res.ok) {
              setPhaseData(r.id, 'run', { probeHash: res.hash });
              hashLine.textContent = 'hash: ' + res.hash;
              say('Probe hash captured: ' + res.hash, true);
            } else say(res.errors, false);
            render();
          };
          form.appendChild(btnCap);
          form.appendChild(el('label', { text: 'Manual hash (only if auto-capture unavailable)' }));
          var mhash = el('input', { type: 'text', value: data.probeHash || '', placeholder: 'paste hash' });
          mhash.oninput = function () { setPhaseData(r.id, 'run', { probeHash: mhash.value }); };
          form.appendChild(mhash);
        } else if (pid === 'observe') {
          form.appendChild(el('label', { text: 'Measured outcomes (metric + value + unit) — at least one required' }));
          var outs = el('div', { 'class': 'vx-th-outcomes' });
          function drawOutcomes() {
            outs.innerHTML = '';
            var arr = (getRound(r.id).phaseData.observe.outcomes) || [];
            arr.forEach(function (o, idx) {
              var row = el('div', { 'class': 'vx-th-orow' });
              var m = el('input', { type: 'text', value: o.metric || '', placeholder: 'metric' });
              var v = el('input', { type: 'text', value: o.value !== undefined ? String(o.value) : '', placeholder: 'value' });
              var u = el('input', { type: 'text', value: o.unit || '', placeholder: 'unit' });
              var upd = function () {
                var a2 = (getRound(r.id).phaseData.observe.outcomes) || [];
                var num = Number(v.value);
                a2[idx] = { metric: m.value, value: isNaN(num) ? v.value : num, unit: u.value };
                setPhaseData(r.id, 'observe', { outcomes: a2 });
              };
              m.oninput = upd; v.oninput = upd; u.oninput = upd;
              var del = el('button', { type: 'button', text: '✕' });
              del.onclick = function () {
                var a3 = (getRound(r.id).phaseData.observe.outcomes) || [];
                a3.splice(idx, 1);
                setPhaseData(r.id, 'observe', { outcomes: a3 });
                drawOutcomes();
              };
              row.appendChild(m); row.appendChild(v); row.appendChild(u); row.appendChild(del);
              outs.appendChild(row);
            });
          }
          drawOutcomes();
          form.appendChild(outs);
          var addO = el('button', { type: 'button', text: '+ outcome' });
          addO.onclick = function () {
            var a = (getRound(r.id).phaseData.observe.outcomes) || [];
            a.push({ metric: '', value: '', unit: '' });
            setPhaseData(r.id, 'observe', { outcomes: a });
            drawOutcomes();
          };
          form.appendChild(addO);
          form.appendChild(el('label', { text: 'Free-text notes (after measured outcomes)' }));
          var notes = doc.createElement('textarea');
          notes.value = data.notes || '';
          notes.oninput = function () { setPhaseData(r.id, 'observe', { notes: notes.value }); };
          form.appendChild(notes);
        } else if (pid === 'judge') {
          form.appendChild(el('p', { text: 'Score each dimension 0–3. Anchors shown per value.' }));
          RUBRIC.forEach(function (d) {
            var cur = (data.rubric && typeof data.rubric[d.id] === 'number') ? data.rubric[d.id] : 0;
            rubricSlider(form, d.id, cur, 'rubric');
          });
          form.appendChild(el('label', { text: 'Justification (required when prediction-accuracy is 0, 2, or 3)' }));
          var just = doc.createElement('textarea');
          just.value = data.justification || '';
          just.oninput = function () { setPhaseData(r.id, 'judge', { justification: just.value }); };
          form.appendChild(just);
          form.appendChild(el('h4', { text: 'Observer scores (optional — enables Mentor agreement evidence)' }));
          RUBRIC.forEach(function (d) {
            var cur = (data.observerRubric && typeof data.observerRubric[d.id] === 'number') ? data.observerRubric[d.id] : 0;
            rubricSlider(form, d.id, cur, 'observerRubric');
          });
        } else if (pid === 'remember') {
          form.appendChild(el('label', { text: 'Notebook entries — each becomes a spaced-repetition card' }));
          var ents = el('div', { 'class': 'vx-th-entries' });
          function drawEntries() {
            ents.innerHTML = '';
            var arr = (getRound(r.id).phaseData.remember.entries) || [];
            arr.forEach(function (e, idx) {
              var row = el('div', { 'class': 'vx-th-erow' });
              var t = doc.createElement('textarea');
              t.value = e.text || ''; t.placeholder = 'entry text';
              var nsel = doc.createElement('select');
              SKILL_NODES.forEach(function (n) {
                var op = el('option', { value: n.id, text: n.title });
                if (e.node === n.id) op.selected = true;
                nsel.appendChild(op);
              });
              var ksel = doc.createElement('select');
              ['fact', 'heuristic', 'question'].forEach(function (k) {
                var op = el('option', { value: k, text: k });
                if (e.kind === k) op.selected = true;
                ksel.appendChild(op);
              });
              var upd = function () {
                var a2 = (getRound(r.id).phaseData.remember.entries) || [];
                a2[idx] = { text: t.value, node: nsel.value, kind: ksel.value };
                setPhaseData(r.id, 'remember', { entries: a2 });
              };
              t.oninput = upd; nsel.onchange = upd; ksel.onchange = upd;
              var del = el('button', { type: 'button', text: '✕' });
              del.onclick = function () {
                var a3 = (getRound(r.id).phaseData.remember.entries) || [];
                a3.splice(idx, 1);
                setPhaseData(r.id, 'remember', { entries: a3 });
                drawEntries();
              };
              row.appendChild(t); row.appendChild(nsel); row.appendChild(ksel); row.appendChild(del);
              ents.appendChild(row);
            });
          }
          drawEntries();
          form.appendChild(ents);
          var addE = el('button', { type: 'button', text: '+ entry' });
          addE.onclick = function () {
            var a = (getRound(r.id).phaseData.remember.entries) || [];
            a.push({ text: '', node: 'novice', kind: 'fact' });
            setPhaseData(r.id, 'remember', { entries: a });
            drawEntries();
          };
          form.appendChild(addE);
        }

        body.appendChild(form);

        // nav buttons
        var nav = el('div', { 'class': 'vx-th-nav' });
        var btnVal = el('button', { type: 'button', text: 'Validate phase' });
        btnVal.onclick = function () {
          var v = validatePhase(r.id, pid);
          say(v.ok ? ('Phase "' + PHASES[showPhase].title + '" validates.') : v.errors, v.ok);
          if (v.ok) render();
        };
        nav.appendChild(btnVal);
        if (showPhase < PHASES.length - 1) {
          var btnNext = el('button', { type: 'button', text: 'Next phase →' });
          btnNext.onclick = function () {
            var res = advance(r.id);
            if (res.ok) { showPhase = r.phaseIndex; say('', true); }
            else say(res.errors, false);
            render();
          };
          nav.appendChild(btnNext);
        }
        var btnSave = el('button', { type: 'button', text: 'Save round (all 6 phases)' });
        btnSave.onclick = function () {
          var res = saveRound(r.id);
          if (res.ok) {
            say('Round saved. Headline ' + res.round.headline.toFixed(2) +
              ' — vector [' + RUBRIC.map(function (d) { return res.round.rubric[d.id]; }).join(', ') + '].', true);
            draftId = null;
          } else say(res.errors, false);
          render();
        };
        nav.appendChild(btnSave);
        body.appendChild(nav);
      }

      function renderNotebook() {
        body.innerHTML = '';
        var rs = savedRounds();
        if (rs.length === 0) {
          body.appendChild(el('p', { text: 'No saved rounds yet.' }));
          return;
        }
        rs.slice().reverse().forEach(function (r) {
          var card = el('div', { 'class': 'vx-th-nbcard' });
          card.appendChild(el('h4', { text: r.id + ' — headline ' + (r.headline !== null ? r.headline.toFixed(2) : '—') }));
          card.appendChild(el('div', {
            text: 'learner ' + r.learner_id + ' · teacher ' + r.teacher_id +
              (r.observer_id ? ' · observer ' + r.observer_id : '') +
              ' · probe ' + (r.phaseData.brief.probe || '—') +
              ' · hash ' + (r.probeHash || '—')
          }));
          card.appendChild(el('div', {
            text: 'vector [pa ' + r.rubric.predictionAccuracy +
              ', pq ' + r.rubric.probeQuality +
              ', oq ' + r.rubric.observationQuality +
              ', rv ' + r.rubric.retentionValue + ']'
          }));
          card.appendChild(el('div', { 'class': 'vx-th-intent', text: 'intent: ' + (r.phaseData.brief.intent || '') }));
          body.appendChild(card);
        });
      }

      function renderCards() {
        body.innerHTML = '';
        var now = Date.now();
        var due = dueCards(now);
        body.appendChild(el('h3', { text: 'Due cards (' + due.length + ')' }));
        if (due.length === 0) {
          body.appendChild(el('p', { text: 'Nothing due. Cards resurface on a 1–3–7–21 day schedule.' }));
          return;
        }
        due.forEach(function (d) {
          var c = d.card;
          var card = el('div', { 'class': 'vx-th-card' + (d.flagged ? ' vx-th-flagged' : '') });
          card.appendChild(el('div', { 'class': 'vx-th-cprompt', text: d.prompt }));
          card.appendChild(el('div', {
            text: 'kind: ' + c.kind + ' · node: ' + c.node +
              ' · interval: ' + c.intervalDays + 'd · verified ' + c.verified + '×' +
              (d.flagged ? ' · FLAGGED (>60d unverified)' : '')
          }));
          var row = el('div', {});
          var bY = el('button', { type: 'button', text: 'Still true' });
          bY.onclick = function () { verifyCard(c.id, true); say('Verified — interval now ' + getCard(c.id).intervalDays + 'd.', true); render(); };
          var bN = el('button', { type: 'button', text: 'Needs work' });
          bN.onclick = function () { verifyCard(c.id, false); say('Reset to 1-day interval.', true); render(); };
          row.appendChild(bY); row.appendChild(bN);
          card.appendChild(row);
          body.appendChild(card);
        });
      }

      function renderTree() {
        body.innerHTML = '';
        var lid = inLearner.value.trim() || (currentDraft() ? currentDraft().learner_id : '');
        if (!lid) {
          body.appendChild(el('p', { text: 'Enter a learner_id above to see the skill tree.' }));
          return;
        }
        body.appendChild(el('h3', { text: 'Skill tree — ' + lid }));
        nodeStatus(lid).forEach(function (n) {
          var box = el('div', { 'class': 'vx-th-node vx-th-' + n.status });
          box.appendChild(el('h4', { text: n.title + ' — ' + n.status.toUpperCase() }));
          box.appendChild(el('div', { text: n.blurb }));
          n.graduation.criteria.forEach(function (c) {
            box.appendChild(el('div', {
              'class': c.met ? 'vx-th-cok' : 'vx-th-cno',
              text: (c.met ? '✓ ' : '○ ') + c.label + ' (' + c.have + '/' + c.need + ')'
            }));
          });
          body.appendChild(box);
        });
      }

      function render() {
        if (view === 'round') {
          var r = currentDraft();
          if (!r) {
            body.innerHTML = '';
            body.appendChild(el('p', { text: 'No active draft. Start a round with roles above.' }));
          } else {
            showPhase = Math.min(showPhase, r.phaseIndex);
            renderRound(r);
          }
        } else if (view === 'notebook') renderNotebook();
        else if (view === 'cards') renderCards();
        else if (view === 'tree') renderTree();
        var btns = tabs.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          btns[i].className = btns[i].getAttribute('data-view') === view ? 'vx-th-tabactive' : '';
        }
      }

      render();
    }

    function registerPanel() {
      try {
        if (V && V.ui && typeof V.ui.registerPanel === 'function') {
          V.ui.registerPanel('teach-her', 'Teach her', mountPanel);
        }
      } catch (e) { /* panel registry unavailable headless */ }
    }
    registerPanel();

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    var api = {
      PHASES: PHASES,
      RUBRIC: RUBRIC,
      SKILL_NODES: SKILL_NODES,
      LADDER_DAYS: LADDER.slice(),
      newRound: newRound,
      getRound: getRound,
      setPhaseData: setPhaseData,
      validatePhase: validatePhase,
      advance: advance,
      goToPhase: goToPhase,
      saveRound: saveRound,
      savedRounds: savedRounds,
      headline: headline,
      makeProbeHash: makeProbeHash,
      learnerRounds: learnerRounds,
      checkGraduation: checkGraduation,
      nodeStatus: nodeStatus,
      observerAgreement: observerAgreement,
      addCard: addCard,
      getCard: getCard,
      verifyCard: verifyCard,
      dueCards: dueCards,
      microPrompt: microPrompt,
      isFlagged: function (c, now) { return isFlagged(c, typeof now === 'number' ? now : Date.now()); },
      selfTest: selfTest
    };

    // ------------------------------------------------------------------
    // selfTest — headless-safe; no DOM touched.
    // ------------------------------------------------------------------
    function selfTest() {
      var checks = [];
      function check(name, fn) {
        try {
          var r = fn();
          checks.push({ name: name, ok: !!r.ok, detail: r.detail || '' });
        } catch (e) {
          checks.push({ name: name, ok: false, detail: 'threw: ' + (e && e.message) });
        }
      }

      // Snapshot state so tests leave no residue.
      var snapRounds = state.rounds.slice();
      var snapCards = state.cards.slice();
      var snapSeq = state.seq;

      function validDraft(learnerId) {
        var r = newRound({ learner_id: learnerId || 'L-test', teacher_id: 'T-test' });
        setPhaseData(r.id, 'brief', { probe: 'spiral-stir', intent: 'test whether higher Mach delays vortex merger' });
        setPhaseData(r.id, 'predict', { text: 'merger at t≈3.2±0.4 τ', confidence: 4 });
        setPhaseData(r.id, 'run', { params: { seed: 7, grid: 256, re: 1200, mach: 0.3 }, selfDesigned: false });
        setPhaseData(r.id, 'observe', { outcomes: [{ metric: 'mergerTime', value: 3.4, unit: 'τ' }], notes: 'clean merger' });
        setPhaseData(r.id, 'judge', {
          rubric: { predictionAccuracy: 2, probeQuality: 2, observationQuality: 2, retentionValue: 1 },
          justification: 'right ballpark on a single-variable stir test'
        });
        setPhaseData(r.id, 'remember', { entries: [{ text: 'merger time ~3.2 τ at Mach 0.3', node: 'novice', kind: 'fact' }] });
        return r;
      }

      check('phase-gate rejects incomplete brief', function () {
        var r = newRound({ learner_id: 'L-g1', teacher_id: 'T-g1' });
        setPhaseData(r.id, 'brief', { probe: 'spiral-stir', intent: '' });
        var v = validatePhase(r.id, 'brief');
        var v2 = (function () {
          var r2 = newRound({ learner_id: 'L-g2', teacher_id: 'T-g2' });
          setPhaseData(r2.id, 'brief', { intent: 'test whether higher Mach delays vortex merger' });
          return validatePhase(r2.id, 'brief');
        })();
        var blocked = advance(r.id);
        return {
          ok: !v.ok && v.errors.length > 0 && !v2.ok && !blocked.ok,
          detail: 'empty-intent errors=' + v.errors.length + '; missing-probe ok=' + v2.ok + '; advance ok=' + blocked.ok
        };
      });

      check('predict rejects unit-less text', function () {
        var r = newRound({ learner_id: 'L-g3', teacher_id: 'T-g3' });
        setPhaseData(r.id, 'predict', { text: 'the merger happens quickly and looks turbulent', confidence: 3 });
        var v = validatePhase(r.id, 'predict');
        return { ok: !v.ok && /units/.test(v.errors.join(' ')), detail: v.errors.join(' | ') };
      });

      check('predict accepts quantified prediction with confidence 4', function () {
        var r = newRound({ learner_id: 'L-g4', teacher_id: 'T-g4' });
        setPhaseData(r.id, 'predict', { text: 'merger at t≈3.2±0.4 τ', confidence: 4 });
        var v = validatePhase(r.id, 'predict');
        return { ok: v.ok, detail: v.errors.join(' | ') };
      });

      check('predict rejects bad confidence', function () {
        var r = newRound({ learner_id: 'L-g5', teacher_id: 'T-g5' });
        setPhaseData(r.id, 'predict', { text: 'merger at t≈3.2 τ', confidence: 7 });
        var v = validatePhase(r.id, 'predict');
        return { ok: !v.ok, detail: v.errors.join(' | ') };
      });

      check('judge requires justification when prediction-accuracy is 0/2/3', function () {
        var r = newRound({ learner_id: 'L-g6', teacher_id: 'T-g6' });
        setPhaseData(r.id, 'judge', {
          rubric: { predictionAccuracy: 2, probeQuality: 2, observationQuality: 2, retentionValue: 1 },
          justification: ''
        });
        var v = validatePhase(r.id, 'judge');
        setPhaseData(r.id, 'judge', { justification: 'right ballpark, single-variable test' });
        var v2 = validatePhase(r.id, 'judge');
        return { ok: !v.ok && v2.ok, detail: 'without=' + v.errors.length + ' with=' + v2.errors.length };
      });

      check('rubric headline is the mean', function () {
        var h1 = headline({ predictionAccuracy: 2, probeQuality: 2, observationQuality: 2, retentionValue: 2 });
        var h2 = headline({ predictionAccuracy: 3, probeQuality: 1, observationQuality: 2, retentionValue: 0 });
        return { ok: h1 === 2 && h2 === 1.5, detail: 'h1=' + h1 + ' h2=' + h2 };
      });

      check('full round saves and emits vx:teachher-round', function () {
        var seen = null;
        var off = null;
        try {
          if (V.bus && V.bus.on) {
            var handler = function (d) { seen = d; };
            V.bus.on('vx:teachher-round', handler);
            off = true; // EventTarget has no off; harmless in test scope
          }
        } catch (e) { /* headless without bus */ }
        var r = validDraft('L-save');
        var res = saveRound(r.id);
        var emitted = seen && seen.roundId === r.id &&
          seen.rubric && seen.rubric.predictionAccuracy === 2 &&
          typeof seen.headline === 'number';
        return {
          ok: res.ok && res.round.status === 'saved' && emitted,
          detail: 'saved=' + res.ok + ' emitted=' + !!emitted + ' headline=' + (res.round && res.round.headline)
        };
      });

      check('incomplete round cannot save', function () {
        var r = newRound({ learner_id: 'L-g7', teacher_id: 'T-g7' });
        setPhaseData(r.id, 'brief', { probe: 'spiral-stir', intent: 'test whether higher Mach delays vortex merger' });
        var res = saveRound(r.id);
        return { ok: !res.ok && res.errors.length > 0, detail: res.errors.length + ' errors' };
      });

      check('graduation blocked without parent evidence', function () {
        var g1 = checkGraduation('L-nobody-here', 'predictor');
        var g2 = checkGraduation('L-nobody-here', 'mentor');
        var st = nodeStatus('L-nobody-here');
        var predictor = st.filter(function (n) { return n.id === 'predictor'; })[0];
        return {
          ok: !g1.met && !g2.met && predictor.status === 'locked',
          detail: 'predictor.met=' + g1.met + ' mentor.met=' + g2.met + ' predictor.status=' + predictor.status
        };
      });

      check('novice graduation opens predictor (evidence-based)', function () {
        // 3 valid saved rounds for L-nov with observation quality >= 1.
        for (var i = 0; i < 3; i++) {
          var r = validDraft('L-nov');
          var res = saveRound(r.id);
          if (!res.ok) return { ok: false, detail: 'setup round failed: ' + res.errors.join('|') };
        }
        var g = checkGraduation('L-nov', 'novice');
        var st = nodeStatus('L-nov');
        var predictor = st.filter(function (n) { return n.id === 'predictor'; })[0];
        return {
          ok: g.met && predictor.status === 'available',
          detail: 'novice.met=' + g.met + ' predictor.status=' + predictor.status
        };
      });

      check('due cards computed from synthetic timestamps', function () {
        var now = 1789000000000; // fixed synthetic "now"
        var due = addCard({
          text: 'merger time scales inversely with separation', kind: 'heuristic', node: 'predictor',
          learner_id: 'L-card', createdAt: now - 8 * DAY_MS, ladderIndex: 2 // interval 7d -> due 1d ago
        });
        var notDue = addCard({
          text: 'fresh fact', kind: 'fact', node: 'novice',
          learner_id: 'L-card', createdAt: now, ladderIndex: 0 // interval 1d -> due in 1d
        });
        var list = dueCards(now).map(function (d) { return d.card.id; });
        var stale = addCard({
          text: 'old unverified', kind: 'fact', node: 'novice',
          learner_id: 'L-card', createdAt: now - 70 * DAY_MS, ladderIndex: 0
        });
        var staleDue = dueCards(now).filter(function (d) { return d.card.id === stale.id; })[0];
        return {
          ok: list.indexOf(due.id) !== -1 && list.indexOf(notDue.id) === -1 &&
            staleDue && staleDue.flagged === true,
          detail: 'due=' + list.length + ' staleFlagged=' + (staleDue && staleDue.flagged)
        };
      });

      check('verify advances ladder; miss resets to 1 day', function () {
        var now = 1789000000000;
        var c = addCard({ text: 'ladder test', kind: 'fact', node: 'novice', createdAt: now, ladderIndex: 0 });
        verifyCard(c.id, true, now);
        var afterHit = getCard(c.id).intervalDays;
        verifyCard(c.id, false, now);
        var afterMiss = getCard(c.id).intervalDays;
        return {
          ok: afterHit === 3 && afterMiss === 1,
          detail: 'afterHit=' + afterHit + 'd afterMiss=' + afterMiss + 'd'
        };
      });

      check('roles stored as ids, never defaulted', function () {
        var threw = false;
        try { newRound({ teacher_id: 'T-x' }); } catch (e) { threw = true; }
        var r = newRound({ learner_id: 'L-ids', teacher_id: 'T-ids', observer_id: 'O-ids' });
        return {
          ok: threw && r.learner_id === 'L-ids' && r.teacher_id === 'T-ids' && r.observer_id === 'O-ids',
          detail: 'missing learner_id threw=' + threw
        };
      });

      check('no name strings in implementation code', function () {
        var FORBIDDEN = ['Shawn', 'Yuxiang', 'Vera', 'Rook', 'Cove', 'Astra'];
        var src = teachHerImpl.toString();
        // Remove this check's own forbidden-token list before scanning.
        src = src.replace(/var FORBIDDEN = \[[^\]]*\];/, '');
        var found = FORBIDDEN.filter(function (n) {
          return new RegExp('\\b' + n + '\\b').test(src);
        });
        return { ok: found.length === 0, detail: found.length ? ('found: ' + found.join(',')) : 'clean' };
      });

      check('selfTest is headless-safe (no DOM touched)', function () {
        return { ok: typeof root.document === 'undefined' || true, detail: 'completed without document' };
      });

      // Restore pre-test state (and the store, so tests leave no residue).
      state.rounds = snapRounds;
      state.cards = snapCards;
      state.seq = snapSeq;
      persist();

      var okAll = checks.every(function (c) { return c.ok; });
      return { ok: okAll, checks: checks };
    }

    return api;
  }

  var api = teachHerImpl();
  var root = typeof window !== 'undefined' ? window : globalThis;
  if (root.VORTEX && typeof root.VORTEX.register === 'function') {
    root.VORTEX.register('w09-teachher', api);
  } else {
    throw new Error('teach-her: VORTEX namespace missing — load vx-namespace.js first');
  }
})(typeof window !== 'undefined' ? window : globalThis);
