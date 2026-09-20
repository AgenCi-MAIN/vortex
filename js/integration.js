/* integration.js — W33. MasterSwitch hooks for the VORTEX lab.
 *
 * VORTEX becomes bank furniture: dashboard widgets, evidence feed, overnight
 * digest mirror, archive records, the All-workspaces registry, the Treasury
 * tab seam, and the Integration panel.
 *
 * Data contracts + emitters only. The MasterSwitch dashboard consumes them —
 * there is NO network anywhere in this file (no fetch/XHR/WebSocket/eval).
 *
 * Bus contract (integration consumes -> re-emits):
 *   consumes  vx:run, vx:frame                        (any runner)
 *   consumes  vx:protocol-verdict                     (W06 protocols)
 *   consumes  vx:teachher-round                       (W09 teach-her)
 *   consumes  vx:run-complete                         (any runner; defined here)
 *   consumes  vx:digest                               (W16 background runner)
 *   emits     vx:evidence-post   {run_id, protocol_id, novelty_score,
 *                                 best_score, parameter_hash, provenance,
 *                                 prominence: 'pinned'|'collapsed'}
 *   emits     vx:digest-card     {lines, actions, source:'vortex-lab'}
 *   emits     vx:archive-record  {record_id, protocol_json, run_params,
 *                                 outcome, snapshots, provenance,
 *                                 protocolImmutable:true}
 *
 * Sources that are absent are guarded: listeners transform only payloads that
 * carry the required fields; anything incomplete is skipped, never emitted
 * partially, never throws.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('w33-integrate: VORTEX namespace required — load js/vx-namespace.js first');
  }

  // ---------------------------------------------------------------- constants
  var SOURCE = 'vortex-lab';
  var LANE = 'lane14';
  var WORKER = 'w33';
  var THUMBNAIL_REFRESH_MS = 2000; // Overview auto-director refresh contract (~2s)
  var DIGEST_ACTIONS = ['run more like this', 'promote to lesson', 'dismiss'];
  var EMBED_CONTRACT = (root.VortexEmbed && root.VortexEmbed.contract) || 'vortex-embed/1.0';

  // Evidence scoring policy. Deterministic, documented, versioned — the
  // provenance of every evidence post names this policy so downstream
  // consumers know exactly how novelty/prominence were derived.
  var EVIDENCE_POLICY = 'w33-evidence/1';
  var NOTABLE_NOVELTY = 0.7;  // novelty_score >= 0.7 -> pinned
  var NOTABLE_SCORE = 0.9;    // best_score    >= 0.9 -> pinned

  // ---- caches -----------------------------------------------------------
  var _lastFrame = null;    // {dt, fps, at}
  var _lastRun = null;      // {id, seed, tracers, domain}
  var _lastEvidence = null;
  var _lastDigestCard = null;
  var _lastArchive = null;

  // ---- helpers ----------------------------------------------------------
  function now() { return Date.now(); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function shortHash(o) {
    try { return V.utils.hash53(V.utils.stableStringify(o)).slice(0, 12); }
    catch (e) { return 'unhashable'; }
  }
  function provenance(sourceEvent) {
    return {
      submitter: 'vortex-lab',
      lane: LANE,
      worker_id: WORKER,
      codeVersion: V.codeVersion,
      source_event: sourceEvent,
      policy: EVIDENCE_POLICY
    };
  }
  function safeGet(id) {
    try { return V.get(id); } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ (a) thumbnail
  // Overview card: auto-director frame refreshed ~2s. Binds W20 when present;
  // degrades to a lab-state descriptor when the director is absent.
  function frameDescriptor() {
    var fd = {
      source: SOURCE,
      mode: 'lab',
      at: new Date().toISOString(),
      directorBound: false,
      framing: null,
      run: _lastRun ? { id: _lastRun.id, seed: _lastRun.seed, tracers: _lastRun.tracers } : null,
      frame: _lastFrame
    };
    var director = safeGet('w20-director');
    if (director && typeof director.getRig === 'function') {
      try {
        fd.framing = director.getRig();
        fd.directorBound = true;
      } catch (e) { fd.directorBound = false; }
    }
    return fd;
  }

  function captionFor() {
    if (_lastEvidence) {
      var p = _lastEvidence;
      if (p.protocol_id === 'teach-her' || p.protocol_id === 'teachher') {
        return 'Teach-her round — score ' + Number(p.best_score).toFixed(3);
      }
      return 'Protocol ' + p.protocol_id + ' — novelty ' + Number(p.novelty_score).toFixed(3);
    }
    if (_lastRun) {
      return 'Run ' + _lastRun.id + ' — seed ' + _lastRun.seed +
        (_lastFrame ? ' — ' + Math.round(_lastFrame.fps || 0) + ' fps' : '');
    }
    return 'VORTEX idle — no run yet';
  }

  function describeThumbnail() {
    var fd = frameDescriptor();
    var caption = captionFor();
    fd.caption = caption;
    return {
      frameDescriptor: fd,
      caption: caption,
      refreshedMs: now()           // dashboard re-calls describeThumbnail() on the ~2s tick
    };
  }

  // Convenience loop for the Overview card: calls onTick(describeThumbnail())
  // every THUMBNAIL_REFRESH_MS. Returns a stop function. Never started by
  // selfTest.
  function startThumbnailLoop(onTick, intervalMs) {
    var ms = isNum(intervalMs) && intervalMs > 0 ? intervalMs : THUMBNAIL_REFRESH_MS;
    var id = setInterval(function () {
      try { onTick(describeThumbnail()); } catch (e) {}
    }, ms);
    return function stop() { clearInterval(id); };
  }

  // ------------------------------------------------- (b) evidence posts
  var EVIDENCE_FIELDS = ['run_id', 'protocol_id', 'novelty_score', 'best_score',
                         'parameter_hash', 'provenance'];

  function buildEvidencePost(input) {
    var missing = [];
    for (var i = 0; i < EVIDENCE_FIELDS.length; i++) {
      var k = EVIDENCE_FIELDS[i];
      if (input == null || input[k] === undefined || input[k] === null || input[k] === '') {
        missing.push(k);
      }
    }
    if (missing.length) return { ok: false, missing: missing };
    if (!isNum(input.novelty_score) || !isNum(input.best_score)) {
      return { ok: false, missing: [], reason: 'novelty_score and best_score must be finite numbers' };
    }
    var post = {
      run_id: String(input.run_id),
      protocol_id: String(input.protocol_id),
      novelty_score: clamp01(input.novelty_score),
      best_score: clamp01(input.best_score),
      parameter_hash: String(input.parameter_hash),
      provenance: input.provenance,
      prominence: (input.novelty_score >= NOTABLE_NOVELTY || input.best_score >= NOTABLE_SCORE)
        ? 'pinned' : 'collapsed',   // notable-pinned vs boring-collapsed
      policy: EVIDENCE_POLICY,
      postedAt: new Date().toISOString()
    };
    return { ok: true, post: post };
  }

  // Adapter: W06 'vx:protocol-verdict' -> evidence shape.
  // verdicts are CONFIRMED / REFUTED / INCONCLUSIVE; effect size |d| drives
  // novelty (a refuted hypothesis with a large effect is still notable).
  function adaptProtocolVerdict(d) {
    if (!d || !d.protocolId) return { ok: false, reason: 'no protocolId' };
    var dd = isNum(d.d) ? d.d : 0;
    var novelty = clamp01(Math.abs(dd) / 2);
    var r = buildEvidencePost({
      run_id: 'protocol:' + d.protocolId + ':' + shortHash(d),
      protocol_id: d.protocolId,
      novelty_score: novelty,
      best_score: clamp01(novelty),   // verdict carries effect size, not a 0-1 score
      parameter_hash: shortHash({ protocolId: d.protocolId, metric: d.metric || null }),
      provenance: provenance('vx:protocol-verdict')
    });
    if (r.ok) {
      r.post.verdict = d.verdict;
      r.post.effectSize = dd;
      if (d.verdict === 'CONFIRMED' || d.verdict === 'REFUTED') r.post.prominence = 'pinned';
    }
    return r;
  }

  // Adapter: W09 'vx:teachher-round' -> evidence shape.
  // Rubric headline is 0-3; novelty/score are headline/3.
  function adaptTeachRound(d) {
    if (!d || !d.roundId) return { ok: false, reason: 'no roundId' };
    var headline = isNum(d.headline) ? d.headline : NaN;
    if (!isNum(headline)) return { ok: false, reason: 'no numeric rubric headline' };
    return buildEvidencePost({
      run_id: 'teachher:' + d.roundId,
      protocol_id: 'teach-her',
      novelty_score: clamp01(headline / 3),
      best_score: clamp01(headline / 3),
      parameter_hash: String(d.probeHash || shortHash(d)),
      provenance: provenance('vx:teachher-round')
    });
  }

  function postEvidence(built) {
    if (!built || !built.ok) return { ok: false, reason: built && built.reason };
    _lastEvidence = built.post;
    try { V.bus.emit('vx:evidence-post', built.post); } catch (e) {}
    return { ok: true, post: built.post };
  }

  // ------------------------------------------------- (c) digest mirror
  // Consumes the W16 morning digest ('vx:digest') and mirrors it into Live
  // audit as a collapsible card. Guarded: W16 is not loaded yet — when the
  // event arrives, this just works.
  function buildDigestCard(digest) {
    var lines = (digest && Array.isArray(digest.lines)) ? digest.lines.slice() : [];
    return {
      title: (digest && digest.title) || 'VORTEX overnight digest',
      lines: lines,
      actions: DIGEST_ACTIONS.slice(),
      source: SOURCE,                    // audit timeline stays filterable by source
      deepLink: (digest && digest.deepLink) || '/simulation/vortex.html#runner',
      runCount: (digest && isNum(digest.runCount)) ? digest.runCount : lines.length,
      interestingCount: (digest && isNum(digest.interestingCount)) ? digest.interestingCount : 0,
      date: (digest && digest.date) || new Date().toISOString().slice(0, 10)
    };
  }

  function emitDigestCard(digest) {
    var card = buildDigestCard(digest);
    _lastDigestCard = card;
    try { V.bus.emit('vx:digest-card', card); } catch (e) {}
    return card;
  }

  // ------------------------------------------------- (d) archive records
  // On run completion the lab emits a record. Protocols are IMMUTABLE once
  // archived — edits spawn a superseding record (flag carried on the record).
  function buildArchiveRecord(input) {
    var i = input || {};
    var snaps = Array.isArray(i.snapshots) ? i.snapshots.slice(0, 3) : [];
    var labels = ['t0', 'tmid', 'tend'];
    var snapshots = snaps.map(function (s, n) {
      if (s && typeof s === 'object' && s.ref) return { label: s.label || labels[n], ref: s.ref };
      return { label: labels[n], ref: String(s) };
    });
    var rec = {
      record_id: String(i.record_id || V.utils.uid('arch')),
      protocol_json: i.protocol_json !== undefined ? i.protocol_json : null,
      run_params: i.run_params || {},
      outcome: i.outcome || null,
      snapshots: snapshots,
      provenance: i.provenance || provenance('vx:run-complete'),
      protocolImmutable: true,   // archived protocols are immutable; edits supersede
      archivedAt: new Date().toISOString()
    };
    return rec;
  }

  function emitArchiveRecord(input) {
    var rec = buildArchiveRecord(input);
    _lastArchive = rec;
    try { V.bus.emit('vx:archive-record', rec); } catch (e) {}
    return rec;
  }

  // ------------------------------------------------- (e) registry
  // All-workspaces: four entries, deep links, permission levels, the embed
  // contract version each honors.
  function registryEntries() {
    return [
      {
        id: 'vortex-lab',
        name: 'VORTEX Lab',
        description: 'Full interactive lab: sim core, auto-director, teach-her loop, background runner.',
        deepLink: '/simulation/vortex.html',
        permission: 'submit',
        capabilities: ['run', 'observe', 'archive'],
        embedContract: EMBED_CONTRACT
      },
      {
        id: 'vortex-consolidation',
        name: 'VORTEX in Consolidation',
        description: 'The embedded fragment — lab view inside the consolidation page.',
        deepLink: '/consolidation.html#simulation/vortex',
        permission: 'submit',
        capabilities: ['run', 'observe'],
        embedContract: EMBED_CONTRACT
      },
      {
        id: 'vortex-runner',
        name: 'VORTEX Background Runner',
        description: 'Headless queue, visibility lifecycle, morning digest (W16).',
        deepLink: '/simulation/vortex.html#runner',
        permission: 'read-only',
        capabilities: ['observe'],
        embedContract: EMBED_CONTRACT
      },
      {
        id: 'vortex-observatory',
        name: 'VORTEX Observatory Harnesses',
        description: 'Read-only probe viewers: watch a protocol family without touching controls.',
        deepLink: '/simulation/vortex.html#observatory/{protocol_family}',
        permission: 'read-only',
        capabilities: ['observe'],
        embedContract: EMBED_CONTRACT
      }
    ];
  }

  // ------------------------------------------------- (f) treasury seam
  // The fund-flow visualization is a tab in the Crypto workspace (Treasury).
  // The lab NEVER writes to the treasury; the dashboard reads two sources.
  // W28 owns the view — this only documents the seam, and exposes the
  // vortex-scoped cost ledger read (paper lab-points, watermarked).
  function treasurySeam() {
    return {
      owner: 'W28 treasury-view (renders the fund-flow tab)',
      reads: [
        {
          source: 'MasterSwitch dashboard',
          endpoint: '/api/paper/state',
          direction: 'read-only',
          note: 'fetched by the dashboard page itself — this module makes no network calls'
        },
        {
          source: 'vortex cost ledger',
          via: 'w33-integrate.costLedger()',
          direction: 'read-only',
          note: 'paper lab-points per run, derived from w21-telemetry when loaded'
        }
      ],
      writes: 'none — the lab never writes to the treasury. Awards enter only after Shawn\'s verdict.',
      watermark: 'PAPER — simulated funds',
      note: 'W28 owns the Treasury tab view; this module documents the seam and exposes the ledger read.'
    };
  }

  function costLedger() {
    var tel = safeGet('w21-telemetry');
    if (!tel || typeof tel.runLog !== 'function') {
      return { ok: false, watermark: 'PAPER — simulated funds',
               reason: 'w21-telemetry not loaded — no cost entries yet' };
    }
    var entries;
    try { entries = tel.runLog(); } catch (e) { entries = []; }
    return {
      ok: true,
      watermark: 'PAPER — simulated funds',
      entries: entries.map(function (r) {
        return { token: r.token, label: r.label, cost: r.cost, createdAt: r.createdAt };
      })
    };
  }

  // ---- bus wiring (guarded transforms; never throws, never emits partial) --
  V.bus.on('vx:frame', function (d) {
    _lastFrame = { dt: d && d.dt, fps: d && d.fps, at: now() };
  });
  V.bus.on('vx:run', function (d) {
    if (d && d.id) _lastRun = { id: d.id, seed: d.seed, tracers: d.tracers, domain: d.domain };
  });
  V.bus.on('vx:protocol-verdict', function (d) {
    postEvidence(adaptProtocolVerdict(d));
  });
  V.bus.on('vx:teachher-round', function (d) {
    postEvidence(adaptTeachRound(d));
  });
  V.bus.on('vx:digest', function (d) {
    emitDigestCard(d || {});
  });
  V.bus.on('vx:run-complete', function (d) {
    emitArchiveRecord(d || {});
  });

  // ---- Integration panel -------------------------------------------------
  function embedSnippet() {
    return '<script src="/simulation/vortex-embed.js" data-vortex-mode="lab"><\/script>\n' +
           '<div id="vortex-root"></div>\n' +
           '<script>\n' +
           '  // or programmatically:\n' +
           '  // VortexEmbed.mount(document.getElementById("vortex-root"), { mode: "observatory" });\n' +
           '<\/script>';
  }

  function mountPanel(el) {
    if (!el || !root.document) return;
    var doc = root.document;
    function h(tag, text, cls) {
      var n = doc.createElement(tag);
      if (text !== undefined && text !== null) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    }

    el.appendChild(h('h3', 'Embed snippet — ' + EMBED_CONTRACT));
    var pre = doc.createElement('pre');
    pre.className = 'vx-embed-snippet';
    pre.textContent = embedSnippet();
    el.appendChild(pre);
    var copy = h('button', 'Copy snippet');
    copy.onclick = function () {
      var done = function (ok) {
        copy.textContent = ok ? 'Copied' : 'Copy failed — select the text manually';
      };
      function fallback() {
        try {
          var ta = doc.createElement('textarea');
          ta.value = embedSnippet();
          doc.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = doc.execCommand('copy'); } catch (e) {}
          doc.body.removeChild(ta);
          done(ok);
        } catch (e) { done(false); }
      }
      try {
        if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
          root.navigator.clipboard.writeText(embedSnippet()).then(function () { done(true); }, fallback);
        } else fallback();
      } catch (e) { fallback(); }
    };
    el.appendChild(copy);

    el.appendChild(h('h3', 'All-workspaces registry'));
    var ul = doc.createElement('ul');
    ul.className = 'vx-registry-list';
    registryEntries().forEach(function (e) {
      var li = doc.createElement('li');
      var a = doc.createElement('a');
      a.href = e.deepLink;
      a.textContent = e.name;
      li.appendChild(a);
      li.appendChild(doc.createTextNode(' — ' + e.permission + ' — ' + e.description));
      ul.appendChild(li);
    });
    el.appendChild(ul);

    el.appendChild(h('h3', 'Evidence post preview'));
    var ev = doc.createElement('pre');
    ev.className = 'vx-evidence-preview';
    ev.textContent = _lastEvidence
      ? JSON.stringify(_lastEvidence, null, 2)
      : 'No evidence posted yet.\n\nSample shape:\n' +
        JSON.stringify(buildEvidencePost({
          run_id: 'protocol:bell-sweep:a1b2c3',
          protocol_id: 'bell-sweep',
          novelty_score: 0.82,
          best_score: 0.91,
          parameter_hash: 'deadbeef01',
          provenance: provenance('vx:protocol-verdict')
        }).post, null, 2);
    el.appendChild(ev);
  }

  try { V.ui.registerPanel('integration', 'Integration', mountPanel); } catch (e) { /* headless */ }

  // ---- api ---------------------------------------------------------------
  var api = {
    describeThumbnail: describeThumbnail,
    startThumbnailLoop: startThumbnailLoop,
    thumbnailRefreshMs: THUMBNAIL_REFRESH_MS,
    buildEvidencePost: buildEvidencePost,
    adaptProtocolVerdict: adaptProtocolVerdict,
    adaptTeachRound: adaptTeachRound,
    postEvidence: postEvidence,
    buildDigestCard: buildDigestCard,
    emitDigestCard: emitDigestCard,
    buildArchiveRecord: buildArchiveRecord,
    emitArchiveRecord: emitArchiveRecord,
    registryEntries: registryEntries,
    treasurySeam: treasurySeam,
    costLedger: costLedger,
    embedSnippet: embedSnippet,
    evidencePolicy: EVIDENCE_POLICY,
    lastEvidence: function () { return _lastEvidence; },
    lastDigestCard: function () { return _lastDigestCard; },
    lastArchive: function () { return _lastArchive; },
    selfTest: selfTest
  };

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

    check('embed guard: mount with missing init throws named VX_E_EMBED_INIT (no hang)', function () {
      var E = root.VortexEmbed;
      if (!E) return { ok: true, detail: 'skipped — VortexEmbed not loaded in this shell (covered by its own selfTest)' };
      var Vv = root.VORTEX, saved = Vv.init;
      try {
        Vv.init = undefined;
        var threw = null;
        try { E.mount({}, { mode: 'lab' }); } catch (e) { threw = e; }
        if (!threw) return { ok: false, detail: 'mount() did NOT throw — would hang' };
        return { ok: threw.code === 'VX_E_EMBED_INIT', detail: 'code=' + threw.code };
      } finally { Vv.init = saved; }
    });

    check('thumbnail descriptor has caption + frame', function () {
      var t = describeThumbnail();
      var ok = t && typeof t.caption === 'string' && t.caption.length > 0 &&
               t.frameDescriptor && typeof t.frameDescriptor === 'object' &&
               isNum(t.refreshedMs);
      return { ok: ok, detail: 'caption="' + (t && t.caption) + '"' };
    });

    check('evidence payload carries all required fields', function () {
      var r = buildEvidencePost({
        run_id: 'r-1', protocol_id: 'bell-sweep', novelty_score: 0.82,
        best_score: 0.91, parameter_hash: 'abc123',
        provenance: provenance('test')
      });
      var p = r.post || {};
      var ok = r.ok && EVIDENCE_FIELDS.every(function (k) { return p[k] !== undefined; }) &&
               (p.prominence === 'pinned' || p.prominence === 'collapsed');
      return { ok: ok, detail: 'prominence=' + p.prominence + ', fields ok=' + r.ok };
    });

    check('incomplete evidence is rejected, never emitted partially', function () {
      var seen = 0;
      function l() { seen++; }
      V.bus.on('vx:evidence-post', l);
      var before = seen;
      postEvidence(adaptProtocolVerdict({}));          // no protocolId
      postEvidence(buildEvidencePost({ run_id: 'x' })); // missing fields
      return { ok: seen === before, detail: 'emits during bad input: ' + (seen - before) };
    });

    check('registry has exactly 4 entries with deep links + permission levels', function () {
      var es = registryEntries();
      var ok = es.length === 4 && es.every(function (e) {
        return e.id && e.name && e.description && e.deepLink && e.permission &&
               Array.isArray(e.capabilities) && e.embedContract;
      });
      return { ok: ok, detail: es.map(function (e) { return e.id + ':' + e.permission; }).join(', ') };
    });

    check("digest card carries source:'vortex-lab' + 3 actions", function () {
      var c = buildDigestCard({ lines: ['34 runs', '3 interesting'], runCount: 34, interestingCount: 3 });
      var ok = c.source === 'vortex-lab' &&
               Array.isArray(c.actions) && c.actions.length === 3 &&
               c.actions[0] === 'run more like this' &&
               c.actions[1] === 'promote to lesson' &&
               c.actions[2] === 'dismiss';
      return { ok: ok, detail: 'source=' + c.source + ', actions=' + c.actions.join('|') };
    });

    check('archive record: id, protocol_json, run_params, outcome, 3 snapshot refs, provenance, immutable', function () {
      var rec = buildArchiveRecord({
        protocol_json: { id: 'p1', frozen: true },
        run_params: { seed: 7 },
        outcome: { verdict: 'CONFIRMED' },
        snapshots: ['snap-t0', 'snap-tmid', 'snap-tend'],
        provenance: provenance('test')
      });
      var ok = !!rec.record_id && rec.protocol_json && rec.run_params && rec.outcome &&
               Array.isArray(rec.snapshots) && rec.snapshots.length === 3 &&
               rec.snapshots.every(function (s) { return s.label && s.ref; }) &&
               !!rec.provenance && rec.protocolImmutable === true;
      return { ok: ok, detail: 'record_id=' + rec.record_id + ', snapshots=' +
               rec.snapshots.map(function (s) { return s.label + ':' + s.ref; }).join(',') };
    });

    check('treasury seam is read-only, names /api/paper/state + cost ledger, no writes', function () {
      var s = treasurySeam();
      var reads = (s.reads || []).map(function (r) { return r.endpoint || r.via || ''; }).join(' ');
      var ok = s.owner && reads.indexOf('/api/paper/state') >= 0 &&
               reads.indexOf('costLedger') >= 0 &&
               /no network|never writes/i.test(s.writes || '') &&
               s.watermark === 'PAPER — simulated funds';
      return { ok: ok, detail: 'owner=' + s.owner };
    });

    var okAll = checks.every(function (c) { return c.ok; });
    return { ok: okAll, checks: checks };
  }

  VORTEX.register('w33-integrate', api);
})(typeof window !== 'undefined' ? window : globalThis);
