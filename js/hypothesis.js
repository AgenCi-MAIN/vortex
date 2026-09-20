/* VORTEX js/hypothesis.js — [W17] Hypothesis compiler.
 *
 * Turns a researcher's loose idea into a falsifiable HypothesisProto and
 * compiles valid protos into W06-style experiment protocol drafts.
 *
 * Design source: lane-14-vortex.md §7 "Hypothesis compiler".
 *
 * Hard rules (from the spec):
 *  1. Falsifiability gate — a prediction WITHOUT a kill sentence is REFUSED.
 *     validate() fails with reason exactly "no falsifiability sentence".
 *  2. No templates — the compiler never emits canned hypotheses. Drafts and
 *     clarification options are assembled from the USER'S OWN WORDS plus the
 *     lab's actual knobs. Missing pieces stay blank for the human to fill.
 *  3. Human-in-the-loop — compileToProtocolDraft() returns per-field
 *     confidence and needsReview[]; the human signs off, never the compiler.
 *  4. Clarification UX — vague input gets concrete options drawn from REAL
 *     knob ids (W04 configs / W05 probes when registered, else the 3 core
 *     sliders + 3 base probes). After 3 failed validations (per session), a
 *     guided 4-question wizard activates.
 *
 * Plain script, no modules, no network, headless-safe. Works from file://.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('w17-hypothesis: VORTEX namespace must load first');

  /* ------------------------------------------------------------------ */
  /* Lab knobs — the REAL controls. Core fallback first, external pull  */
  /* guarded: W04/W05 modules are not required to exist.                */
  /* ------------------------------------------------------------------ */

  // Core 3 sliders — the W01 core controls (CONTRACTS.md §7).
  var CORE_SLIDERS = [
    { id: 'circulation', label: 'Circulation', kind: 'slider', min: 0, max: 1, def: 0.5 },
    { id: 'turbulence',  label: 'Turbulence',  kind: 'slider', min: 0, max: 1, def: 0.35 },
    { id: 'persistence', label: 'Persistence', kind: 'slider', min: 0, max: 1, def: 0.6 }
  ];

  // Base 3 probes — the currently exposed probes (lane-14 doc §0).
  var CORE_PROBES = [
    { id: 'oppose-winding',    label: 'Oppose winding' },
    { id: 'test-the-wake',     label: 'Test the wake' },
    { id: 'perturb-the-field', label: 'Perturb the field' }
  ];

  // Probe-param grammar: "probe:<probe-id>:<param>".
  var PROBE_PARAMS = ['strength', 'duration', 'radius'];

  // W07 metric ids — the 12 protocol-relative metrics (lane-14 doc §6).
  // Used even when the w07-metrics module is absent; if it IS registered
  // we merge its ids in via the guarded pull below.
  var METRIC_DEFS = [
    { id: 'mixing_rate',               label: 'Mixing rate' },
    { id: 'dispersion',                label: 'Dispersion' },
    { id: 'enstrophy',                label: 'Enstrophy proxy' },
    { id: 'kinetic_energy',           label: 'KE proxy' },
    { id: 'merger_time',              label: 'Merger time' },
    { id: 'filament_topology',        label: 'Filament topology' },
    { id: 'symmetry_breaking',        label: 'Symmetry-breaking' },
    { id: 'predictability_horizon',   label: 'Predictability horizon' },
    { id: 'energy_decay',             label: 'Energy decay' },
    { id: 'vorticity_correlation_length', label: 'Vorticity correlation length' },
    { id: 'injection_influence_radius',   label: 'Injection influence radius' },
    { id: 'rollback_fidelity',        label: 'Rollback fidelity' }
  ];
  var CUSTOM_METRIC_ID = 'custom';

  // Guarded external pull: w04-configs / w05-probes / w07-metrics.
  // Best-effort, never throws, falls back to the core sets above.
  var _ext = null;
  function externalLab() {
    if (_ext) return _ext;
    _ext = { knobs: [], probes: [], metrics: [] };
    try {
      var w04 = V.get('w04-configs');
      if (w04) {
        var cl = null;
        if (typeof w04.knobs === 'function') cl = w04.knobs();
        else if (typeof w04.configs === 'function') cl = w04.configs();
        else if (typeof w04.list === 'function') cl = w04.list();
        if (cl && cl.length) {
          for (var i = 0; i < cl.length; i++) {
            var c = cl[i];
            if (c && typeof c.id === 'string') {
              _ext.knobs.push({ id: c.id, label: c.label || c.id, kind: 'config' });
            } else if (typeof c === 'string') {
              _ext.knobs.push({ id: c, label: c, kind: 'config' });
            }
          }
        }
      }
    } catch (e) { /* fall back to core */ }
    try {
      var w05 = V.get('w05-probes');
      if (w05) {
        var pl = null;
        if (typeof w05.probes === 'function') pl = w05.probes();
        else if (typeof w05.catalog === 'function') pl = w05.catalog();
        else if (typeof w05.list === 'function') pl = w05.list();
        if (pl && pl.length) {
          for (var j = 0; j < pl.length; j++) {
            var p = pl[j];
            if (p && typeof p.id === 'string') {
              _ext.probes.push({ id: p.id, label: p.label || p.name || p.id });
            } else if (typeof p === 'string') {
              _ext.probes.push({ id: p, label: p });
            }
          }
        }
      }
    } catch (e) { /* fall back to core */ }
    try {
      var w07 = V.get('w07-metrics');
      if (w07) {
        var ml = null;
        if (typeof w07.metricIds === 'function') ml = w07.metricIds();
        else if (typeof w07.metrics === 'function') ml = w07.metrics();
        else if (typeof w07.list === 'function') ml = w07.list();
        if (ml && ml.length) {
          for (var k = 0; k < ml.length; k++) {
            var m = ml[k];
            if (m && typeof m.id === 'string' && !metricKnown(m.id)) {
              _ext.metrics.push({ id: m.id, label: m.label || m.id });
            } else if (typeof m === 'string' && !metricKnown(m)) {
              _ext.metrics.push({ id: m, label: m });
            }
          }
        }
      }
    } catch (e) { /* fall back to the 12 */ }
    return _ext;
  }

  function metricKnown(id) {
    for (var i = 0; i < METRIC_DEFS.length; i++) {
      if (METRIC_DEFS[i].id === id) return true;
    }
    return false;
  }

  function listProbes() {
    var out = CORE_PROBES.slice();
    var ext = externalLab().probes;
    for (var i = 0; i < ext.length; i++) {
      var seen = false;
      for (var j = 0; j < out.length; j++) {
        if (out[j].id === ext[i].id) { seen = true; break; }
      }
      if (!seen) out.push(ext[i]);
    }
    return out;
  }

  function listKnobs() {
    var out = [];
    var i, j;
    for (i = 0; i < CORE_SLIDERS.length; i++) out.push(CORE_SLIDERS[i]);
    var probes = listProbes();
    for (i = 0; i < probes.length; i++) {
      for (j = 0; j < PROBE_PARAMS.length; j++) {
        out.push({
          id: 'probe:' + probes[i].id + ':' + PROBE_PARAMS[j],
          label: probes[i].label + ' · ' + PROBE_PARAMS[j],
          kind: 'probe-param'
        });
      }
    }
    var ext = externalLab().knobs;
    for (i = 0; i < ext.length; i++) {
      var seen = false;
      for (j = 0; j < out.length; j++) {
        if (out[j].id === ext[i].id) { seen = true; break; }
      }
      if (!seen) out.push(ext[i]);
    }
    return out;
  }

  function listMetrics() {
    var out = METRIC_DEFS.slice();
    var ext = externalLab().metrics;
    for (var i = 0; i < ext.length; i++) out.push(ext[i]);
    return out;
  }

  function knobSet() {
    var s = {}, ks = listKnobs();
    for (var i = 0; i < ks.length; i++) s[ks[i].id] = ks[i];
    return s;
  }

  function metricSet() {
    var s = {}, ms = listMetrics();
    for (var i = 0; i < ms.length; i++) s[ms[i].id] = ms[i];
    return s;
  }

  /* ------------------------------------------------------------------ */
  /* Miss counter (per session) → wizard trigger after 3 failures.       */
  /* ------------------------------------------------------------------ */

  var MISS_KEY = 'vx-w17-misses';
  var _misses = -1;

  function readMisses() {
    if (_misses >= 0) return _misses;
    _misses = 0;
    try {
      var raw = (typeof sessionStorage !== 'undefined')
        ? sessionStorage.getItem(MISS_KEY) : null;
      var n = parseInt(raw, 10);
      if (!isNaN(n) && n >= 0) _misses = n;
    } catch (e) { _misses = 0; }
    return _misses;
  }

  function writeMisses(n) {
    _misses = n;
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(MISS_KEY, String(n));
      }
    } catch (e) { /* headless or blocked — memory copy still works */ }
  }

  function noteMiss() {
    var n = readMisses() + 1;
    writeMisses(n);
    if (n === 3) { // 3rd failed validation: arm the guided wizard
      wiz.armed = true;
      wiz.active = true;
      V.bus.emit('vx:hypothesis', { kind: 'wizard-armed', misses: n });
    }
    return n;
  }

  function resetMisses() { writeMisses(0); }

  /* ------------------------------------------------------------------ */
  /* HypothesisProto schema + validation.                               */
  /*                                                                     */
  /*  { iv, dependentMetric, customMetric?, prediction, conditions,      */
  /*    falsifiability }                                                */
  /* ------------------------------------------------------------------ */

  var HAS_NUM = /-?\d+(\.\d+)?/;
  // Units: %, named units, or a letter directly after a number ("12ms", "3x").
  var HAS_UNIT = /(%|°|σ)|(\b(percent|pct|ms|millisec|s|sec|second|seconds|minute|minutes|fps|hz|px|pixel|pixels|tracer|tracers|run|runs|replicate|replicates|replication|replications|sigma|std|unit|units|step|steps|frame|frames|shot|shots|kelvin|k)\b)|(\d\s*[a-zA-Z])/i;

  function err(field, reason, message) {
    return { field: field, reason: reason, message: message };
  }

  // Pure validator — no side effects. validate() wraps it with the miss
  // counter so every rejected submission feeds the wizard trigger.
  function validateProto(proto) {
    var errors = [];

    if (!proto || typeof proto !== 'object' || Array.isArray(proto)) {
      errors.push(err('proto', 'not an object',
        'HypothesisProto must be a JSON object with iv, dependentMetric, prediction, conditions, falsifiability.'));
      return { ok: false, errors: errors };
    }

    // --- iv: must be a REAL lab knob ---
    if (typeof proto.iv !== 'string' || !proto.iv.trim()) {
      errors.push(err('iv', 'missing iv',
        'iv must name a real lab knob (e.g. "turbulence", "persistence", or a probe param like "probe:oppose-winding:strength").'));
    } else {
      var iv = proto.iv.trim();
      var knobs = knobSet();
      if (!knobs[iv]) {
        errors.push(err('iv', 'unknown knob',
          'iv "' + iv + '" is not a real lab knob. Known knobs: ' +
          Object.keys(knobs).join(', ') + '.'));
      }
    }

    // --- dependentMetric: a W07 metric id, or "custom" with a description ---
    if (typeof proto.dependentMetric !== 'string' || !proto.dependentMetric.trim()) {
      errors.push(err('dependentMetric', 'missing metric',
        'dependentMetric must be a W07 metric id or "custom".'));
    } else {
      var dm = proto.dependentMetric.trim();
      if (dm === CUSTOM_METRIC_ID) {
        if (typeof proto.customMetric !== 'string' || proto.customMetric.trim().length < 8) {
          errors.push(err('dependentMetric', 'missing custom metric',
            'dependentMetric is "custom", so customMetric must describe the metric (≥8 chars: name + how it is measured).'));
        }
      } else if (!metricSet()[dm]) {
        errors.push(err('dependentMetric', 'unknown metric',
          'dependentMetric "' + dm + '" is not a known metric. Use a W07 metric id or "custom".'));
      }
    }

    // --- prediction: quantitative, with units ---
    if (typeof proto.prediction !== 'string' || !proto.prediction.trim()) {
      errors.push(err('prediction', 'missing prediction',
        'prediction is required and must be quantitative, e.g. "mixing_rate rises by ≥15%".'));
    } else {
      var pr = proto.prediction;
      if (!HAS_NUM.test(pr)) {
        errors.push(err('prediction', 'prediction not quantitative',
          'prediction must include a number (e.g. "rises by 15%", "falls to 0.3 s").'));
      }
      if (!HAS_UNIT.test(pr)) {
        errors.push(err('prediction', 'prediction missing units',
          'prediction must state units (%, s, ms, fps, tracers, runs, …).'));
      }
    }

    // --- conditions: required object (config, replicates, …) ---
    if (!proto.conditions || typeof proto.conditions !== 'object' || Array.isArray(proto.conditions)) {
      errors.push(err('conditions', 'missing conditions',
        'conditions must be an object, e.g. {configId, replicates, seed, stopConditions}.'));
    } else if (Object.keys(proto.conditions).length === 0) {
      errors.push(err('conditions', 'conditions empty',
        'conditions must say under what setup the prediction holds (configId, replicates, seed, …).'));
    }

    // --- falsifiability: THE GATE. No kill sentence → refused. ---
    if (typeof proto.falsifiability !== 'string' || !proto.falsifiability.trim()) {
      errors.push(err('falsifiability', 'no falsifiability sentence',
        'Refused: a prediction without a kill sentence is not a hypothesis. ' +
        'State what single observation would prove it WRONG.'));
    } else if (proto.falsifiability.trim().length < 20) {
      errors.push(err('falsifiability', 'kill sentence too vague',
        'The kill sentence must be a concrete observation (≥20 characters), e.g. ' +
        '"mixing_rate changes by less than 5% over 5 replicates".'));
    }

    return { ok: errors.length === 0, errors: errors };
  }

  function validate(proto) {
    var r = validateProto(proto);
    if (r.ok) resetMisses(); else noteMiss();
    V.bus.emit('vx:hypothesis', { kind: r.ok ? 'validated' : 'rejected', errors: r.errors });
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* Per-field confidence + review gate.                                 */
  /* ------------------------------------------------------------------ */

  function confidences(proto) {
    var c = { iv: 0, dependentMetric: 0, prediction: 0, conditions: 0, falsifiability: 0 };
    proto = (proto && typeof proto === 'object') ? proto : {};

    if (typeof proto.iv === 'string' && knobSet()[proto.iv.trim()]) c.iv = 1;

    if (typeof proto.dependentMetric === 'string') {
      var dm = proto.dependentMetric.trim();
      if (metricSet()[dm]) c.dependentMetric = 1;
      else if (dm === CUSTOM_METRIC_ID) {
        c.dependentMetric = (typeof proto.customMetric === 'string' &&
          proto.customMetric.trim().length >= 8) ? 0.7 : 0.3;
      }
    }

    if (typeof proto.prediction === 'string') {
      var n = HAS_NUM.test(proto.prediction), u = HAS_UNIT.test(proto.prediction);
      c.prediction = (n && u) ? 0.95 : (n ? 0.5 : 0.15);
    }

    if (proto.conditions && typeof proto.conditions === 'object' && !Array.isArray(proto.conditions)) {
      var keys = Object.keys(proto.conditions);
      if (keys.length === 0) c.conditions = 0.2;
      else c.conditions = (proto.conditions.configId && proto.conditions.replicates) ? 1 : 0.65;
    }

    if (typeof proto.falsifiability === 'string') {
      var f = proto.falsifiability.trim();
      c.falsifiability = f.length >= 20 ? (HAS_NUM.test(f) ? 1 : 0.85) : (f.length > 0 ? 0.25 : 0);
    }
    return c;
  }

  function needsReviewList(conf) {
    var out = [];
    for (var k in conf) {
      if (Object.prototype.hasOwnProperty.call(conf, k) && conf[k] < 0.7) out.push(k);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* compileToProtocolDraft — maps HypothesisProto onto the W06 protocol */
  /* schema (lane-14 doc §6): hypothesis, config, timed probe sequence,  */
  /* paired control, replication count (5+5 default), stop conditions,   */
  /* content hash. The gate: invalid protos (esp. no kill sentence)      */
  /* NEVER produce a draft.                                              */
  /* ------------------------------------------------------------------ */

  function compileToProtocolDraft(proto) {
    var v = validateProto(proto); // pure: compile itself does not count misses
    var conf = confidences(proto);
    var review = needsReviewList(conf);

    if (!v.ok) {
      V.bus.emit('vx:hypothesis', { kind: 'compile-refused', errors: v.errors });
      return { ok: false, draft: null, errors: v.errors, perFieldConfidence: conf, needsReview: review };
    }

    var cond = proto.conditions;
    var body = {
      protocolVersion: 1,
      codeVersion: V.codeVersion,
      hypothesis: {
        iv: proto.iv.trim(),
        dependentMetric: proto.dependentMetric.trim(),
        customMetric: proto.dependentMetric.trim() === CUSTOM_METRIC_ID
          ? String(proto.customMetric).trim() : null,
        prediction: proto.prediction.trim(),
        conditions: cond,
        falsifiability: proto.falsifiability.trim()
      },
      config: cond.configId || 'default',
      probeSequence: Array.isArray(cond.probeSequence) ? cond.probeSequence : [],
      pairedControl: cond.pairedControl || { mode: 'twin', seeded: true },
      // 5+5 default: five treatment replicates, five control replicates
      replicationCount: cond.replicates || { treatment: 5, control: 5 },
      stopConditions: cond.stopConditions || ['replicates_complete', 'effect_ci_excludes_zero'],
      seed: (typeof cond.seed === 'number') ? (cond.seed >>> 0) : null,
      compiledAt: V.utils.now(),
      contentHash: null
    };
    body.contentHash = V.utils.hash53(V.utils.stableStringify(body));

    V.bus.emit('vx:hypothesis', { kind: 'compiled', hash: body.contentHash });
    return { ok: true, draft: body, errors: [], perFieldConfidence: conf, needsReview: review };
  }

  /* ------------------------------------------------------------------ */
  /* Clarification UX — vague input → concrete, knob-grounded options.   */
  /* Options quote the user's own words; blanks stay blank (no canned    */
  /* hypotheses). Every option references a REAL knob id.                */
  /* ------------------------------------------------------------------ */

  var STOPWORDS = /\b(make|it|the|a|an|to|of|and|or|more|less|very|really|please|just|with)\b/g;

  function mentions(hay, id, label) {
    hay = ' ' + hay + ' ';
    return hay.indexOf(' ' + id + ' ') >= 0 ||
      hay.indexOf(id.replace(/[-_]/g, ' ')) >= 0 ||
      (label && hay.indexOf(' ' + label.toLowerCase() + ' ') >= 0);
  }

  // Default knob→metric pairings for the option scaffolds.
  var OPTION_PAIRS = [
    { knob: 'circulation', metric: 'vorticity_correlation_length' },
    { knob: 'turbulence',  metric: 'mixing_rate' },
    { knob: 'persistence', metric: 'predictability_horizon' },
    { knob: 'probe:oppose-winding:strength',    metric: 'symmetry_breaking' },
    { knob: 'probe:test-the-wake:duration',    metric: 'filament_topology' },
    { knob: 'probe:perturb-the-field:strength', metric: 'dispersion' }
  ];

  function clarify(text) {
    var raw = String(text == null ? '' : text).trim();
    var t = ' ' + raw.toLowerCase().replace(STOPWORDS, ' ') + ' ';

    var knobs = knobSet(), mets = metricSet();
    var hitKnob = null, hitMetric = null;
    var ks = listKnobs();
    for (var i = 0; i < ks.length; i++) {
      if (mentions(t, ks[i].id, ks[i].label)) { hitKnob = ks[i]; break; }
    }
    var ms = listMetrics();
    for (var j = 0; j < ms.length; j++) {
      if (mentions(t, ms[j].id, ms[j].label)) { hitMetric = ms[j]; break; }
    }
    var hitNum = HAS_NUM.test(raw);

    var vague = !(hitKnob && hitMetric && hitNum);
    if (!vague) {
      return { vague: false, options: [], note: 'Input names a knob, a metric, and a number — no clarification needed.' };
    }

    // Build concrete options from the lab's ACTUAL knobs, quoting the
    // user's own words. The prediction amount and kill sentence are left
    // as blanks for the human — never filled by the compiler.
    var quoted = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
    var options = [];
    var seenKnobs = {};
    var pairs = OPTION_PAIRS.slice();
    // If the user did name one real knob, put matching options first.
    if (hitKnob) {
      pairs.sort(function (a, b) {
        return (b.knob === hitKnob.id ? 1 : 0) - (a.knob === hitKnob.id ? 1 : 0);
      });
    }
    for (var k = 0; k < pairs.length; k++) {
      var knob = knobs[pairs[k].knob];
      var met = mets[pairs[k].metric];
      if (!knob || !met || seenKnobs[pairs[k].knob]) continue;
      seenKnobs[pairs[k].knob] = true;
      options.push({
        knobId: knob.id,               // REAL knob id — asserted in selfTest
        knobLabel: knob.label,
        metricId: met.id,
        metricLabel: met.label,
        title: 'Change ' + knob.label + ' → watch ' + met.label,
        seed: '“' + quoted + '”',       // the user's own words, not a template
        sketch: '“' + quoted + '” means turning the ' + knob.label.toLowerCase() +
          ' knob and watching ' + met.label.toLowerCase() + '.' +
          ' Prediction: ' + met.id + ' changes by __ (fill in a number + units).' +
          ' Kill sentence: ' + met.id + ' changes by less than __ over 5 replicates.',
        missing: ['prediction amount + units', 'kill sentence']
      });
    }

    V.bus.emit('vx:hypothesis', { kind: 'clarified', input: raw, options: options.length });
    return {
      vague: true,
      input: raw,
      detected: { knob: hitKnob ? hitKnob.id : null, metric: hitMetric ? hitMetric.id : null, number: hitNum },
      options: options
    };
  }

  /* ------------------------------------------------------------------ */
  /* Guided 4-question wizard. Armed after 3 failed validations.         */
  /* ------------------------------------------------------------------ */

  var WIZARD_QUESTIONS = [
    { key: 'iv', prompt: 'Which lab knob are you changing?', kind: 'knob',
      help: 'Pick a real control: a slider, or a probe parameter.' },
    { key: 'dependentMetric', prompt: 'What do you expect to move?', kind: 'metric',
      help: 'Pick the metric you will score against.' },
    { key: 'prediction', prompt: 'By how much? Give a NUMBER with UNITS.', kind: 'text',
      help: 'Example: "mixing_rate rises by ≥15%" or "merger_time falls to 0.3 s".' },
    { key: 'falsifiability', prompt: 'What single observation would prove you WRONG?', kind: 'kill',
      help: 'The kill sentence. Concrete, ≥20 characters.' }
  ];

  var wiz = {
    armed: false,   // becomes true after 3 failed validations
    active: false,  // wizard currently on screen
    step: 0,
    answers: {},
    done: false,
    result: null
  };

  function getWizardState() {
    return {
      armed: wiz.armed || readMisses() >= 3,
      active: wiz.active,
      step: wiz.step,
      questions: WIZARD_QUESTIONS,
      answers: wiz.answers,
      done: wiz.done,
      result: wiz.result
    };
  }

  function wizardStart() {
    wiz.armed = true; wiz.active = true; wiz.step = 0;
    wiz.answers = {}; wiz.done = false; wiz.result = null;
    V.bus.emit('vx:hypothesis', { kind: 'wizard-started' });
    return getWizardState();
  }

  function wizardReset() {
    wiz.armed = readMisses() >= 3;
    wiz.active = false; wiz.step = 0;
    wiz.answers = {}; wiz.done = false; wiz.result = null;
    return getWizardState();
  }

  // Validate one wizard answer; on the last step, assemble + validate the proto.
  function wizardAnswer(step, value) {
    if (!wiz.active) return { ok: false, error: 'wizard not active' };
    if (step !== wiz.step) return { ok: false, error: 'expected step ' + wiz.step };
    var q = WIZARD_QUESTIONS[step];
    var v = String(value == null ? '' : value).trim();
    var fieldErr = null;

    if (q.kind === 'knob') {
      if (!knobSet()[v]) fieldErr = 'Pick a real lab knob id (e.g. "turbulence").';
    } else if (q.kind === 'metric') {
      if (v !== CUSTOM_METRIC_ID && !metricSet()[v]) fieldErr = 'Pick a real metric id or "custom".';
    } else if (q.kind === 'text') {
      if (!HAS_NUM.test(v)) fieldErr = 'The prediction needs a number.';
      else if (!HAS_UNIT.test(v)) fieldErr = 'The prediction needs units (%, s, ms, …).';
    } else if (q.kind === 'kill') {
      if (v.length < 20) fieldErr = 'The kill sentence must be a concrete observation (≥20 chars).';
    }
    if (fieldErr) return { ok: false, error: fieldErr, step: step };

    wiz.answers[q.key] = v;

    if (step < WIZARD_QUESTIONS.length - 1) {
      wiz.step++;
      return { ok: true, done: false, step: wiz.step, next: WIZARD_QUESTIONS[wiz.step] };
    }

    // Final step: assemble the proto from the user's own answers.
    var proto = {
      iv: wiz.answers.iv,
      dependentMetric: wiz.answers.dependentMetric,
      prediction: wiz.answers.prediction,
      conditions: { configId: 'default', replicates: { treatment: 5, control: 5 }, via: 'wizard' },
      falsifiability: wiz.answers.falsifiability
    };
    if (proto.dependentMetric === CUSTOM_METRIC_ID && wiz.answers.customMetric) {
      proto.customMetric = wiz.answers.customMetric;
    }
    var res = validate(proto); // counts as a validation attempt
    wiz.done = true; wiz.active = false;
    wiz.result = res.ok
      ? { ok: true, proto: proto }
      : { ok: false, errors: res.errors };
    V.bus.emit('vx:hypothesis', { kind: 'wizard-finished', ok: res.ok });
    return { ok: true, done: true, result: wiz.result };
  }

  /* ------------------------------------------------------------------ */
  /* Panel: "Hypothesis compiler". DOM-guarded — headless-safe.          */
  /* ------------------------------------------------------------------ */

  var PANEL_CSS = [
    '.vx-w17{font:12px/1.45 system-ui,sans-serif;color:inherit;max-width:560px}',
    '.vx-w17 h3{margin:0 0 6px;font-size:13px}',
    '.vx-w17 label{display:block;margin:8px 0 2px;font-weight:600}',
    '.vx-w17 select,.vx-w17 input[type=text],.vx-w17 textarea{width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px}',
    '.vx-w17 textarea{min-height:52px;resize:vertical}',
    '.vx-w17 .vx-w17-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.vx-w17 button{background:#1f6feb;border:0;color:#fff;border-radius:6px;padding:6px 12px;cursor:pointer}',
    '.vx-w17 button.ghost{background:#21262d}',
    '.vx-w17 .vx-conf{margin-top:10px}',
    '.vx-w17 .vx-conf-row{display:flex;align-items:center;gap:8px;margin:3px 0}',
    '.vx-w17 .vx-conf-row .nm{width:110px;flex:none}',
    '.vx-w17 .vx-conf-bar{flex:1;height:8px;background:#21262d;border-radius:4px;overflow:hidden}',
    '.vx-w17 .vx-conf-bar i{display:block;height:100%;background:#3fb950}',
    '.vx-w17 .vx-conf-row.low .vx-conf-bar i{background:#d29922}',
    '.vx-w17 .vx-kill{font-size:11px;margin-top:2px}',
    '.vx-w17 .vx-kill.bad{color:#f85149}',
    '.vx-w17 .vx-kill.good{color:#3fb950}',
    '.vx-w17 .vx-out{margin-top:10px;white-space:pre-wrap;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px;max-height:260px;overflow:auto}',
    '.vx-w17 .vx-opt{border:1px solid #30363d;border-radius:6px;padding:8px;margin:6px 0;cursor:pointer}',
    '.vx-w17 .vx-opt:hover{border-color:#1f6feb}',
    '.vx-w17 .vx-wizq{font-weight:600;margin:10px 0 4px}',
    '.vx-w17 .vx-wizopts button{margin:2px 4px 2px 0}'
  ].join('\n');

  function ensureCss(doc) {
    if (doc.getElementById('vx-w17-css')) return;
    var s = doc.createElement('style');
    s.id = 'vx-w17-css';
    s.textContent = PANEL_CSS;
    doc.head.appendChild(s);
  }

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mountPanel(host) {
    if (!host || typeof document === 'undefined') return; // headless: skip, don't throw
    var doc = document;
    ensureCss(doc);
    host.innerHTML = '';
    var wrap = el(doc, 'div', 'vx-w17');

    wrap.appendChild(el(doc, 'h3', null, 'Hypothesis compiler'));
    wrap.appendChild(el(doc, 'div', null,
      'Draft a falsifiable hypothesis. No kill sentence, no hypothesis — the compiler refuses.'));

    // --- form fields ---
    var fields = {};

    function labeled(name, control) {
      wrap.appendChild(el(doc, 'label', null, name));
      wrap.appendChild(control);
      return control;
    }

    var ivSel = el(doc, 'select');
    (function () {
      var ks = listKnobs();
      var groups = {};
      for (var i = 0; i < ks.length; i++) {
        var g = ks[i].kind === 'slider' ? 'Sliders' : (ks[i].kind === 'probe-param' ? 'Probe params' : 'Field configs');
        (groups[g] = groups[g] || []).push(ks[i]);
      }
      for (var gn in groups) {
        if (!Object.prototype.hasOwnProperty.call(groups, gn)) continue;
        var og = doc.createElement('optgroup'); og.label = gn;
        for (var j = 0; j < groups[gn].length; j++) {
          var o = doc.createElement('option');
          o.value = groups[gn][j].id;
          o.textContent = groups[gn][j].label + '  (' + groups[gn][j].id + ')';
          og.appendChild(o);
        }
        ivSel.appendChild(og);
      }
    })();
    fields.iv = labeled('Independent variable (real lab knob)', ivSel);

    var metSel = el(doc, 'select');
    (function () {
      var ms = listMetrics();
      for (var i = 0; i < ms.length; i++) {
        var o = doc.createElement('option');
        o.value = ms[i].id; o.textContent = ms[i].label + '  (' + ms[i].id + ')';
        metSel.appendChild(o);
      }
      var oc = doc.createElement('option');
      oc.value = CUSTOM_METRIC_ID; oc.textContent = 'Custom…';
      metSel.appendChild(oc);
    })();
    fields.dependentMetric = labeled('Dependent metric', metSel);
    var customBox = el(doc, 'input'); customBox.type = 'text';
    customBox.placeholder = 'Custom metric: name + how it is measured';
    customBox.style.display = 'none';
    wrap.appendChild(customBox);
    fields.customMetric = customBox;
    metSel.onchange = function () {
      customBox.style.display = (metSel.value === CUSTOM_METRIC_ID) ? '' : 'none';
    };

    var predBox = el(doc, 'input'); predBox.type = 'text';
    predBox.placeholder = 'e.g. mixing_rate rises by ≥15% over 5 replicates';
    fields.prediction = labeled('Prediction (number + units)', predBox);

    var condBox = el(doc, 'textarea');
    condBox.placeholder = '{"configId":"default","replicates":{"treatment":5,"control":5},"seed":42}';
    condBox.value = '{"configId":"default","replicates":{"treatment":5,"control":5}}';
    fields.conditions = labeled('Conditions (JSON)', condBox);

    var killBox = el(doc, 'textarea');
    killBox.placeholder = 'What single observation would prove this WRONG?';
    fields.falsifiability = labeled('Kill sentence (falsifiability)', killBox);
    var killCheck = el(doc, 'div', 'vx-kill bad', '✗ no kill sentence — the compiler will refuse this hypothesis');
    wrap.appendChild(killCheck);
    killBox.oninput = function () {
      var t = killBox.value.trim();
      if (t.length >= 20) {
        killCheck.className = 'vx-kill good';
        killCheck.textContent = '✓ kill sentence present (' + t.length + ' chars)';
      } else {
        killCheck.className = 'vx-kill bad';
        killCheck.textContent = t.length === 0
          ? '✗ no kill sentence — the compiler will refuse this hypothesis'
          : '✗ kill sentence too vague (' + t.length + '/20 chars minimum)';
      }
    };

    // --- per-field confidence ---
    var confBox = el(doc, 'div', 'vx-conf');
    wrap.appendChild(confBox);
    function renderConf(conf) {
      confBox.innerHTML = '';
      var names = { iv: 'IV', dependentMetric: 'Metric', prediction: 'Prediction', conditions: 'Conditions', falsifiability: 'Kill sentence' };
      for (var k in names) {
        if (!Object.prototype.hasOwnProperty.call(names, k)) continue;
        var row = el(doc, 'div', 'vx-conf-row' + (conf[k] < 0.7 ? ' low' : ''));
        row.appendChild(el(doc, 'span', 'nm', names[k]));
        var bar = el(doc, 'div', 'vx-conf-bar');
        var fill = el(doc, 'i'); fill.style.width = Math.round(conf[k] * 100) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el(doc, 'span', null, Math.round(conf[k] * 100) + '%'));
        confBox.appendChild(row);
      }
    }
    renderConf(confidences({}));

    // --- output ---
    var out = el(doc, 'div', 'vx-out', 'Compile a draft to see the protocol + review flags here.');
    wrap.appendChild(out);

    function readProto() {
      var cond;
      try { cond = JSON.parse(condBox.value || '{}'); }
      catch (e) { cond = condBox.value; } // let validate flag it
      var p = {
        iv: ivSel.value,
        dependentMetric: metSel.value,
        prediction: predBox.value,
        conditions: cond,
        falsifiability: killBox.value
      };
      if (metSel.value === CUSTOM_METRIC_ID) p.customMetric = customBox.value;
      return p;
    }

    // --- buttons ---
    var row = el(doc, 'div', 'vx-w17-row');
    var btnCompile = el(doc, 'button', null, 'Validate & compile draft');
    var btnClarify = el(doc, 'button', 'ghost', 'Clarify vague idea…');
    var btnWizard = el(doc, 'button', 'ghost', 'Guided wizard');
    row.appendChild(btnCompile); row.appendChild(btnClarify); row.appendChild(btnWizard);
    wrap.appendChild(row);

    btnCompile.onclick = function () {
      var r = compileToProtocolDraft(readProto());
      renderConf(r.perFieldConfidence);
      if (!r.ok) {
        out.textContent = 'REFUSED — no draft emitted:\n' +
          r.errors.map(function (e) { return '• [' + e.field + '] ' + e.reason + ': ' + e.message; }).join('\n') +
          '\n\nneedsReview: ' + r.needsReview.join(', ');
        V.ui.announce('Hypothesis refused: ' + r.errors[0].reason);
        renderWizardSlot();
        return;
      }
      out.textContent = 'DRAFT (needs your review — nothing auto-approved):\n' +
        'needsReview: ' + (r.needsReview.length ? r.needsReview.join(', ') : 'none') + '\n' +
        JSON.stringify(r.draft, null, 2);
      V.ui.announce('Protocol draft compiled · hash ' + r.draft.contentHash.slice(0, 8));
      renderWizardSlot();
    };

    // --- clarification UX ---
    var clarBox = el(doc, 'div'); clarBox.style.display = 'none';
    var clarInput = el(doc, 'input'); clarInput.type = 'text';
    clarInput.placeholder = 'e.g. "make it prettier" — describe it loosely';
    var clarGo = el(doc, 'button', null, 'Get concrete options');
    var clarOut = el(doc, 'div');
    clarBox.appendChild(el(doc, 'label', null, 'Vague idea'));
    clarBox.appendChild(clarInput);
    clarBox.appendChild(clarGo);
    clarBox.appendChild(clarOut);
    wrap.appendChild(clarBox);
    btnClarify.onclick = function () {
      clarBox.style.display = clarBox.style.display === 'none' ? '' : 'none';
    };
    clarGo.onclick = function () {
      var r = clarify(clarInput.value);
      clarOut.innerHTML = '';
      if (!r.vague) {
        clarOut.appendChild(el(doc, 'div', null, r.note));
        return;
      }
      clarOut.appendChild(el(doc, 'div', null,
        '“' + r.input + '” is vague. Pick a concrete starting point — each option uses a REAL lab knob:'));
      for (var i = 0; i < r.options.length; i++) {
        (function (opt) {
          var d = el(doc, 'div', 'vx-opt');
          d.appendChild(el(doc, 'div', null, opt.title));
          var small = el(doc, 'div', null, opt.seed + ' → knob ' + opt.knobId + ' · metric ' + opt.metricId);
          small.style.fontSize = '11px'; small.style.opacity = '0.75';
          d.appendChild(small);
          d.title = opt.sketch;
          d.onclick = function () {
            ivSel.value = opt.knobId;
            metSel.value = opt.metricId;
            customBox.style.display = 'none';
            predBox.value = '';
            killBox.value = '';
            killBox.oninput();
            V.ui.announce('Option loaded: ' + opt.title + ' — fill in the prediction and kill sentence.');
            clarBox.style.display = 'none';
          };
          clarOut.appendChild(d);
        })(r.options[i]);
      }
    };

    // --- wizard slot ---
    var wizSlot = el(doc, 'div');
    wrap.appendChild(wizSlot);
    function renderWizardSlot() {
      wizSlot.innerHTML = '';
      var st = getWizardState();
      if (!st.active) {
        if (st.armed && readMisses() >= 3) {
          var hint = el(doc, 'div', null,
            'Three drafts were refused this session. The guided wizard is ready — 4 questions, your words, real knobs.');
          var start = el(doc, 'button', null, 'Start guided wizard');
          start.onclick = function () { wizardStart(); renderWizardSlot(); };
          wizSlot.appendChild(hint); wizSlot.appendChild(start);
        }
        return;
      }
      var q = st.questions[st.step];
      wizSlot.appendChild(el(doc, 'div', 'vx-wizq',
        'Wizard ' + (st.step + 1) + '/4 — ' + q.prompt));
      wizSlot.appendChild(el(doc, 'div', null, q.help));
      if (q.kind === 'knob' || q.kind === 'metric') {
        var opts = el(doc, 'div', 'vx-wizopts');
        var items = q.kind === 'knob' ? listKnobs() : listMetrics();
        var list = q.kind === 'knob' ? items.slice(0, 12) : items; // keep it scannable
        for (var i = 0; i < list.length; i++) {
          (function (id, label) {
            var b = el(doc, 'button', 'ghost', label);
            b.onclick = function () { stepAnswer(id); };
            opts.appendChild(b);
          })(list[i].id, list[i].label);
        }
        if (q.kind === 'metric') {
          var bc = el(doc, 'button', 'ghost', 'Custom…');
          bc.onclick = function () {
            var cm = prompt('Describe the custom metric (name + how it is measured):');
            if (cm && cm.trim().length >= 8) {
              wiz.answers.customMetric = cm.trim();
              stepAnswer(CUSTOM_METRIC_ID);
            }
          };
          opts.appendChild(bc);
        }
        wizSlot.appendChild(opts);
      } else {
        var ta = el(doc, q.kind === 'kill' ? 'textarea' : 'input');
        if (q.kind !== 'kill') ta.type = 'text';
        ta.placeholder = q.kind === 'kill'
          ? 'The observation that would prove you wrong…'
          : 'e.g. mixing_rate rises by ≥15%';
        var next = el(doc, 'button', null, 'Next');
        next.onclick = function () { stepAnswer(ta.value); };
        wizSlot.appendChild(ta); wizSlot.appendChild(next);
      }
      var back = el(doc, 'button', 'ghost', 'Cancel wizard');
      back.onclick = function () { wizardReset(); renderWizardSlot(); };
      wizSlot.appendChild(back);
    }
    function stepAnswer(value) {
      var r = wizardAnswer(wiz.step, value);
      if (!r.ok) {
        V.ui.announce('Wizard: ' + r.error);
        return;
      }
      if (r.done) {
        if (r.result.ok) {
          var p = r.result.proto;
          ivSel.value = p.iv;
          if (metricSet()[p.dependentMetric]) { metSel.value = p.dependentMetric; customBox.style.display = 'none'; }
          predBox.value = p.prediction;
          killBox.value = p.falsifiability;
          killBox.oninput();
          condBox.value = JSON.stringify(p.conditions);
          out.textContent = 'Wizard assembled a hypothesis from your answers. Review it above, then Validate & compile.';
          V.ui.announce('Wizard complete — hypothesis assembled from your answers.');
        } else {
          out.textContent = 'Wizard could not assemble a valid hypothesis:\n' +
            r.result.errors.map(function (e) { return '• [' + e.field + '] ' + e.reason; }).join('\n');
        }
      }
      renderWizardSlot();
    }
    btnWizard.onclick = function () { wizardStart(); renderWizardSlot(); };
    renderWizardSlot();

    host.appendChild(wrap);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  var api = {
    SCHEMA: ['iv', 'dependentMetric', 'customMetric?', 'prediction', 'conditions', 'falsifiability'],

    listKnobs: listKnobs,
    listProbes: listProbes,
    listMetrics: listMetrics,
    knobIds: function () { return listKnobs().map(function (k) { return k.id; }); },
    metricIds: function () {
      var ids = listMetrics().map(function (m) { return m.id; });
      ids.push(CUSTOM_METRIC_ID);
      return ids;
    },

    validate: validate,
    validateProto: validateProto, // pure variant (no miss counting)
    confidences: confidences,
    compileToProtocolDraft: compileToProtocolDraft,
    clarify: clarify,

    getMisses: readMisses,
    resetMisses: resetMisses,

    getWizardState: getWizardState,
    wizardStart: wizardStart,
    wizardReset: wizardReset,
    wizardAnswer: wizardAnswer,

    selfTest: selfTest
  };

  /* ------------------------------------------------------------------ */
  /* selfTest — headless-safe. No DOM touched except via guarded panel.  */
  /* ------------------------------------------------------------------ */

  function check(name, ok, detail) {
    return { name: name, ok: !!ok, detail: detail || '' };
  }

  function selfTest() {
    var checks = [];
    resetMisses();

    // 1. A valid proto passes.
    var good = {
      iv: 'turbulence',
      dependentMetric: 'mixing_rate',
      prediction: 'mixing_rate rises by ≥15% over 5 replicates',
      conditions: { configId: 'default', replicates: { treatment: 5, control: 5 }, seed: 42 },
      falsifiability: 'mixing_rate changes by less than 5% across all 5 replicates'
    };
    var r1 = validate(good);
    checks.push(check('valid proto passes', r1.ok && r1.errors.length === 0,
      'ok=' + r1.ok + ' errors=' + JSON.stringify(r1.errors)));

    // 2. Missing kill sentence → refused with the EXACT reason.
    var noKill = {
      iv: 'circulation',
      dependentMetric: 'dispersion',
      prediction: 'dispersion falls to 0.3 units',
      conditions: { configId: 'default', replicates: 5 }
    };
    var r2 = validate(noKill);
    var reasonHit = r2.errors.some(function (e) { return e.reason === 'no falsifiability sentence'; });
    checks.push(check('missing kill sentence refused', !r2.ok && reasonHit,
      'ok=' + r2.ok + ' reasons=' + r2.errors.map(function (e) { return e.reason; }).join('|')));

    // 2b. Empty-string kill sentence → same refusal.
    var emptyKill = {
      iv: 'persistence', dependentMetric: 'energy_decay',
      prediction: 'energy_decay slows by 20%',
      conditions: { configId: 'x', replicates: 5 }, falsifiability: '   '
    };
    var r2b = validate(emptyKill);
    var reasonHitB = r2b.errors.some(function (e) { return e.reason === 'no falsifiability sentence'; });
    checks.push(check('empty kill sentence refused', !r2b.ok && reasonHitB,
      'reasons=' + r2b.errors.map(function (e) { return e.reason; }).join('|')));

    // 3. Vague input → knob-grounded options; every option names a real knob.
    var cl = clarify('make it prettier');
    var real = knobSet();
    var allReal = cl.options.length > 0 && cl.options.every(function (o) { return !!real[o.knobId]; });
    var quotesUser = cl.options.every(function (o) { return o.seed.indexOf('make it prettier') >= 0; });
    checks.push(check('vague input → knob-grounded options',
      cl.vague === true && allReal && quotesUser,
      'vague=' + cl.vague + ' options=' + cl.options.length + ' allReal=' + allReal));

    // 3b. Specific input is not flagged vague.
    var cl2 = clarify('raise turbulence and measure mixing_rate up 15 percent');
    checks.push(check('specific input not vague', cl2.vague === false,
      'vague=' + cl2.vague));

    // 4. Three failed validations → wizard arms.
    resetMisses();
    validate(noKill); validate(noKill); validate(noKill);
    var wst = getWizardState();
    checks.push(check('3 misses triggers wizard', wst.armed === true && wst.active === true,
      'misses=' + readMisses() + ' armed=' + wst.armed + ' active=' + wst.active));
    resetMisses();

    // 5. Compile maps onto the W06 protocol schema fields.
    var comp = compileToProtocolDraft(good);
    var d = comp.draft;
    var hasFields = comp.ok && d &&
      d.hypothesis && typeof d.config === 'string' &&
      Array.isArray(d.probeSequence) && d.pairedControl &&
      d.replicationCount && d.stopConditions && typeof d.contentHash === 'string';
    var hashHex = hasFields && /^[0-9a-f]+$/.test(d.contentHash);
    checks.push(check('draft maps to protocol schema', hasFields && hashHex,
      'fields=' + (d ? Object.keys(d).join(',') : 'none') + ' hash=' + (d && d.contentHash)));
    var pc = comp.perFieldConfidence;
    var confOk = pc && ['iv', 'dependentMetric', 'prediction', 'conditions', 'falsifiability']
      .every(function (k) { return typeof pc[k] === 'number' && pc[k] >= 0 && pc[k] <= 1; });
    checks.push(check('per-field confidence 0..1', confOk,
      'conf=' + JSON.stringify(pc) + ' needsReview=' + JSON.stringify(comp.needsReview)));

    // 6. Compile REFUSES an invalid proto — no draft emitted.
    var compBad = compileToProtocolDraft(noKill);
    var badRefused = !compBad.ok && compBad.draft === null &&
      compBad.errors.some(function (e) { return e.reason === 'no falsifiability sentence'; });
    checks.push(check('compile refuses without kill sentence', badRefused,
      'ok=' + compBad.ok + ' draft=' + compBad.draft));
    resetMisses();

    // 7. Unknown knob iv is rejected.
    var badKnob = validate({
      iv: 'vibes', dependentMetric: 'mixing_rate',
      prediction: 'mixing_rate rises by 10%',
      conditions: { configId: 'x', replicates: 5 },
      falsifiability: 'mixing_rate does not change beyond 2% in any replicate run'
    });
    checks.push(check('unknown knob rejected',
      !badKnob.ok && badKnob.errors.some(function (e) { return e.field === 'iv'; }),
      'reasons=' + badKnob.errors.map(function (e) { return e.reason; }).join('|')));

    // 8. Probe-param iv is a real knob.
    var probeProto = {
      iv: 'probe:oppose-winding:strength',
      dependentMetric: 'symmetry_breaking',
      prediction: 'symmetry_breaking index rises by 0.2 units',
      conditions: { configId: 'default', replicates: 5 },
      falsifiability: 'symmetry_breaking index moves by less than 0.05 units in 5 runs'
    };
    var r8 = validate(probeProto);
    checks.push(check('probe param iv accepted', r8.ok,
      'ok=' + r8.ok + ' errors=' + JSON.stringify(r8.errors)));
    resetMisses();

    // 9. 'custom' metric requires a customMetric description.
    var customBad = validate({
      iv: 'turbulence', dependentMetric: 'custom',
      prediction: 'florp rises by 10%',
      conditions: { configId: 'x', replicates: 5 },
      falsifiability: 'florp does not move beyond noise across 5 replicate runs'
    });
    var customGood = validate({
      iv: 'turbulence', dependentMetric: 'custom', customMetric: 'florp: peak dye-front speed, px/s',
      prediction: 'florp rises by 10 px/s',
      conditions: { configId: 'x', replicates: 5 },
      falsifiability: 'florp does not move beyond noise across 5 replicate runs'
    });
    checks.push(check('custom metric needs description',
      !customBad.ok && customGood.ok,
      'bad ok=' + customBad.ok + ' good ok=' + customGood.ok));
    resetMisses();

    // 10. Non-quantitative / unitless predictions are rejected.
    var noNum = validate({
      iv: 'turbulence', dependentMetric: 'mixing_rate',
      prediction: 'mixing gets much better',
      conditions: { configId: 'x', replicates: 5 },
      falsifiability: 'mixing_rate does not change beyond 2% across 5 replicate runs'
    });
    var noUnit = validate({
      iv: 'turbulence', dependentMetric: 'mixing_rate',
      prediction: 'mixing_rate rises by 15',
      conditions: { configId: 'x', replicates: 5 },
      falsifiability: 'mixing_rate does not change beyond 2% across 5 replicate runs'
    });
    checks.push(check('prediction needs number + units',
      !noNum.ok && !noUnit.ok &&
      noNum.errors.some(function (e) { return e.reason === 'prediction not quantitative'; }) &&
      noUnit.errors.some(function (e) { return e.reason === 'prediction missing units'; }),
      'noNum=' + noNum.errors.map(function (e) { return e.reason; }).join('|') +
      ' noUnit=' + noUnit.errors.map(function (e) { return e.reason; }).join('|')));
    resetMisses();

    // 11. Wizard walkthrough: 4 answers assemble a valid proto.
    wizardStart();
    wizardAnswer(0, 'turbulence');
    wizardAnswer(1, 'mixing_rate');
    wizardAnswer(2, 'mixing_rate rises by ≥15%');
    var wfin = wizardAnswer(3, 'mixing_rate changes by less than 5% over the 5 replicates');
    checks.push(check('wizard assembles valid proto',
      wfin.ok && wfin.done && wfin.result.ok && wfin.result.proto.iv === 'turbulence',
      'done=' + wfin.done + ' ok=' + (wfin.result && wfin.result.ok)));
    wizardReset(); resetMisses();

    // 12. Panel registration is headless-safe (mount guarded, not called here).
    var panelOk = false, panelNote = '';
    try {
      var panels = V.ui.panels();
      panelOk = panels.some(function (p) { return p.id === 'w17-hypothesis'; });
      panelNote = panelOk ? 'registered; mount not invoked headless' : 'NOT registered';
    } catch (e) { panelNote = 'panels() threw: ' + e.message; }
    checks.push(check('panel registered, headless-safe', panelOk, panelNote));

    var allOk = checks.every(function (c) { return c.ok; });
    return { ok: allOk, checks: checks };
  }

  /* ------------------------------------------------------------------ */
  /* Register (panel registration is DOM-independent — mountFn guards).  */
  /* ------------------------------------------------------------------ */

  V.ui.registerPanel('w17-hypothesis', 'Hypothesis compiler', mountPanel);
  V.register('w17-hypothesis', api);

})(typeof window !== 'undefined' ? window : globalThis);
