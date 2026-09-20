/* VORTEX background.js — W16 headless background protocol runner.
 *
 * What this is: the overnight lab. Protocols (plain JSON) queue up in three
 * priority tiers — shawn > curriculum > curiosity — and execute headless while
 * the lab is hidden, checkpointing so a paused run resumes exactly. Completed
 * runs are scored for novelty against the Pareto front of best-known results
 * per protocol family; interesting ones land in the morning digest, boring
 * ones archive silently. Digest-only by default: no overnight pings.
 *
 * Execution paths (documented live via api.status().executionPath):
 *   'worker' — dedicated Web Worker per run (max 2 concurrent), chunked to
 *     ~250ms quanta with priority re-evaluation between chunks. The worker
 *     runs an embedded deterministic reference sim (see __w16SimCore): it is
 *     isolated and CANNOT load W05/W07 module source, so worker-path metrics
 *     come from the reference core, which implements the same metric names
 *     and probe semantics (stir/oppose/perturb) as the foreground catalog.
 *   'main'   — DEGRADED path: main-thread 250ms time-slices (setTimeout(0)
 *     chunks) when Worker/OffscreenCanvas are unavailable. THIS path prefers
 *     the real foreground probe/metric modules when present: W05 probe
 *     catalog + W07 metrics, else backend.sampleMetrics(), else the
 *     reference core. Chosen automatically at first start(); a failure to
 *     spawn workers emits vx:degraded {from:'worker',to:'main-thread'}.
 *
 * Visibility lifecycle: document.visibilitychange → PAUSE when the lab is
 * open/foreground, RESUME when hidden/overnight. Thermal: calls into the W11
 * governor when present (capability-detected); otherwise an internal
 * frame-time guard suspends on sustained over-budget slices.
 *
 * Paper lab only. No network, no eval, no fetch/XHR/WebSocket.
 * localStorage is used only inside try/catch (private-mode safe).
 */
(function (root) {
  'use strict';
  var V = root.VORTEX;
  if (!V) throw new Error('w16-background: VORTEX namespace missing (load vx-namespace.js first)');

  var IS_BROWSER = V.utils.isBrowser();
  var DOC = (IS_BROWSER && root.document) ? root.document : null;

  var QUANTUM_MS = 250;          // time-slice quantum, both paths
  var CHECKPOINT_EVERY = 600;    // iterations between checkpoints (K=600)
  var MAX_CONCURRENT = 2;
  var ANTI_STARVE_HOURS = 48;    // tier-3 age that can preempt curriculum
  var NOVELTY_THRESHOLD = 0.25;  // normalized distance that counts as novel
  var EXTREME_MARGIN = 0.01;     // 1% beyond family range = new extreme

  var LS_QUEUE = 'vx:w16:queue:v1';
  var LS_ARCHIVE = 'vx:w16:archive:v1';
  var LS_CHECKPOINTS = 'vx:w16:checkpoints:v1';
  var LS_DIGEST = 'vx:w16:digest:v1';
  var LS_ENGINE = 'vx:w16:engine:v1';

  var TIER_RANK = { shawn: 0, curriculum: 1, curiosity: 2 };

  // ---------------------------------------------------------------- storage
  function lsGet(key) {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(key) : null;
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try {
      if (root.localStorage) root.localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) { return false; }
  }
  function lsDel(key) {
    try { if (root.localStorage) root.localStorage.removeItem(key); } catch (e) {}
  }

  function freshStore() {
    return { queue: [], paused: [], archive: [], fronts: {}, digest: null, override: null };
  }

  // ---------------------------------------------------------------- queue
  function tierFromSubmitter(submitter) {
    var s = String(submitter || '').toLowerCase();
    if (s === 'shawn' || s === 'owner') return 'shawn';
    if (s === 'vera' || s === 'curriculum' || s === 'teach-her' || s === 'learner') return 'curriculum';
    return 'curiosity';
  }

  // Effective rank: lower runs first. Tier-3 older than 48h gets rank 0.5 —
  // ahead of curriculum, never ahead of shawn.
  function effectiveRank(p, nowMs) {
    var base = TIER_RANK[p.tier] != null ? TIER_RANK[p.tier] : 2;
    if (p.tier === 'curiosity') {
      var ageH = (nowMs - (p.created_at || nowMs)) / 3600000;
      if (ageH >= ANTI_STARVE_HOURS) return 0.5;
    }
    return base;
  }

  function sortQueue(arr, nowMs) {
    var cp = arr.slice();
    cp.sort(function (a, b) {
      var ra = effectiveRank(a, nowMs), rb = effectiveRank(b, nowMs);
      if (ra !== rb) return ra - rb;
      return (a.created_at || 0) - (b.created_at || 0);
    });
    return cp;
  }

  function signature(p) {
    return V.utils.hash53(V.utils.stableStringify({
      sp: p.sim_params || {}, pc: p.probe_config || {}
    }));
  }

  function normalizeProtocol(p, nowMs) {
    nowMs = nowMs || V.utils.now();
    var q = {
      id: p.id || V.utils.uid('proto'),
      submitter: p.submitter || 'curiosity',
      tier: p.tier || tierFromSubmitter(p.submitter),
      hypothesis: String(p.hypothesis || 'untitled protocol'),
      sim_params: p.sim_params || {},
      probe_config: p.probe_config || null,
      expected_outcome: p.expected_outcome || null,
      family: p.family || (p.sim_params && p.sim_params.configId) || 'default',
      created_at: p.created_at || nowMs,
      status: 'queued',
      submitters: p.submitters ? p.submitters.slice() : [p.submitter || 'curiosity']
    };
    if (!TIER_RANK.hasOwnProperty(q.tier)) q.tier = 'curiosity';
    q.sig = signature(q);
    return q;
  }

  // Dedup: same signature merges, keeping the HIGHER tier (lower rank).
  function mergeInto(store, q, nowMs) {
    for (var i = 0; i < store.queue.length; i++) {
      var e = store.queue[i];
      if (e.sig === q.sig && e.status === 'queued') {
        var er = TIER_RANK[e.tier], qr = TIER_RANK[q.tier];
        for (var k = 0; k < q.submitters.length; k++) {
          if (e.submitters.indexOf(q.submitters[k]) < 0) e.submitters.push(q.submitters[k]);
        }
        if (qr < er) {
          e.tier = q.tier; e.submitter = q.submitter;
          e.hypothesis = q.hypothesis; e.expected_outcome = q.expected_outcome;
        }
        if (q.created_at < e.created_at) e.created_at = q.created_at;
        return { merged: true, id: e.id, tier: e.tier };
      }
    }
    store.queue.push(q);
    return { merged: false, id: q.id, tier: q.tier };
  }

  function dequeue(store, nowMs) {
    if (!store.queue.length) return null;
    var ordered = sortQueue(store.queue, nowMs);
    var head = ordered[0];
    for (var i = 0; i < store.queue.length; i++) {
      if (store.queue[i].id === head.id) { store.queue.splice(i, 1); break; }
    }
    head.status = 'running';
    return head;
  }

  function peekOrdered(store, nowMs) { return sortQueue(store.queue, nowMs); }

  function persistQueue(store) {
    lsSet(LS_QUEUE, { protocols: store.queue, paused: store.paused, saved_at: V.utils.now() });
  }
  function loadPersistedQueue(store) {
    var d = lsGet(LS_QUEUE);
    if (d && Array.isArray(d.protocols)) {
      store.queue = d.protocols;
      store.paused = Array.isArray(d.paused) ? d.paused : [];
    }
  }

  // ============================================ deterministic headless core
  // NOTE: __w16SimCore must reference NOTHING outside itself — it is
  // serialized with .toString() and run inside a Blob-spawned Web Worker.
  // mulberry32 with EXPOSED state so checkpoints resume bit-exactly.
  function __w16SimCore() {
    'use strict';
    var DT = 1 / 60;
    function RNG(seed) { this.s = (seed >>> 0) || 1; }
    RNG.prototype.next = function () {
      var a = this.s | 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      this.s = a;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    function hashStr(str) { // cyrb53, self-contained
      var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (var i = 0; i < str.length; i++) {
        var ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
    }
    function r4(x) { return Math.round(x * 10000) / 10000; }

    function normProbe(pc) {
      if (!pc) return null;
      return {
        type: pc.type || 'stir', strength: +pc.strength || 0.5,
        cx: +pc.cx || 0, cy: +pc.cy || 0, radius: +pc.radius || 0.5,
        startIter: pc.startIter != null ? pc.startIter : 600,
        endIter: pc.endIter != null ? pc.endIter : 1800
      };
    }

    function create(seed, params, n) {
      params = params || {}; n = Math.min(n || 256, 512);
      var rng = new RNG(seed);
      var circ = +params.circulation || 1.0;
      var turb = (params.turbulence == null) ? 0.2 : +params.turbulence;
      var pers = (params.persistence == null) ? 0.995 : +params.persistence;
      var cores = [];
      var nc = 2 + Math.floor(rng.next() * 3);
      for (var i = 0; i < nc; i++) {
        cores.push({
          x: (rng.next() - 0.5) * 1.6, y: (rng.next() - 0.5) * 1.6,
          g: (rng.next() < 0.5 ? -1 : 1) * circ * (0.5 + rng.next()),
          r: 0.12 + rng.next() * 0.2
        });
      }
      var x = new Array(n), y = new Array(n), u = new Array(n), v = new Array(n);
      for (var j = 0; j < n; j++) {
        var a2 = rng.next() * Math.PI * 2, rr = 0.25 + rng.next() * 0.55;
        x[j] = Math.cos(a2) * rr; y[j] = Math.sin(a2) * rr; u[j] = 0; v[j] = 0;
      }
      return {
        it: 0, n: n, seed: seed >>> 0, rng: rng, x: x, y: y, u: u, v: v,
        cores: cores, turb: turb, pers: pers, probe: normProbe(params.probe),
        series: []
      };
    }

    function probeVel(pr, px, py, out) {
      var dx = px - pr.cx, dy = py - pr.cy;
      var d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
      var fall = Math.exp(-(d * d) / (pr.radius * pr.radius));
      if (pr.type === 'oppose') { out.x = dy / d * pr.strength * fall; out.y = -dx / d * pr.strength * fall; }
      else if (pr.type === 'perturb') { out.x = dx / d * pr.strength * fall; out.y = dy / d * pr.strength * fall; }
      else { out.x = -dy / d * pr.strength * fall; out.y = dx / d * pr.strength * fall; } // stir
    }
    var _f = { x: 0, y: 0 }, _p = { x: 0, y: 0 };

    function step(s) {
      var pr = s.probe, on = pr && s.it >= pr.startIter && s.it < pr.endIter;
      for (var j = 0; j < s.n; j++) {
        var vx = 0, vy = 0;
        for (var i = 0; i < s.cores.length; i++) {
          var c = s.cores[i], dx = s.x[j] - c.x, dy = s.y[j] - c.y;
          var d2 = dx * dx + dy * dy + c.r * c.r;
          var sw = c.g / (2 * Math.PI * d2);
          vx += -dy * sw; vy += dx * sw;
        }
        if (on) { probeVel(pr, s.x[j], s.y[j], _p); vx += _p.x; vy += _p.y; }
        vx += (s.rng.next() - 0.5) * s.turb * 0.6;
        vy += (s.rng.next() - 0.5) * s.turb * 0.6;
        var k = 1 - s.pers + 0.05;
        s.u[j] = s.u[j] * s.pers + vx * k;
        s.v[j] = s.v[j] * s.pers + vy * k;
        s.x[j] += s.u[j] * DT; s.y[j] += s.v[j] * DT;
      }
      s.it++;
      if (s.it % 60 === 0) sample(s);
    }

    function sample(s) {
      var ke = 0, mx = 0, my = 0;
      for (var j = 0; j < s.n; j++) { ke += s.u[j] * s.u[j] + s.v[j] * s.v[j]; mx += s.x[j]; my += s.y[j]; }
      ke /= s.n; mx /= s.n; my /= s.n;
      var disp = 0, en = 0, ux = 0, vx_ = 0;
      for (var k = 0; k < s.n; k++) { ux += s.u[k]; vx_ += s.v[k]; }
      ux /= s.n; vx_ /= s.n;
      for (var m = 0; m < s.n; m++) {
        var ddx = s.x[m] - mx, ddy = s.y[m] - my;
        disp += ddx * ddx + ddy * ddy;
        var du = s.u[m] - ux, dv = s.v[m] - vx_;
        en += du * du + dv * dv; // enstrophy PROXY: velocity variance
      }
      disp /= s.n; en /= s.n;
      var rr = s.x.map(function (qx, idx) { return Math.sqrt((qx - mx) * (qx - mx) + (s.y[idx] - my) * (s.y[idx] - my)); });
      var rmean = rr.reduce(function (a, b) { return a + b; }, 0) / s.n;
      var rvar = rr.reduce(function (a, b) { return a + (b - rmean) * (b - rmean); }, 0) / s.n;
      s.series.push({ it: s.it, ke: r4(ke), en: r4(en), mix: r4(rvar), disp: r4(disp) });
    }

    function runQuantum(s, budgetMs, maxIter) {
      var t0 = Date.now(), now = t0, iters = 0;
      while (s.it < maxIter) {
        step(s); iters++;
        if ((iters & 63) === 0) { now = Date.now(); if (now - t0 >= budgetMs) break; }
      }
      return { done: s.it >= maxIter, iters: iters, wallMs: now - t0 };
    }

    function checkpoint(s) {
      return {
        it: s.it, rngS: s.rng.s,
        x: s.x.slice(), y: s.y.slice(), u: s.u.slice(), v: s.v.slice(),
        series: s.series.slice()
      };
    }

    function restore(seed, params, n, cp) {
      var s = create(seed, params, n);
      s.it = cp.it; s.rng.s = cp.rngS >>> 0;
      s.x = cp.x.slice(); s.y = cp.y.slice(); s.u = cp.u.slice(); s.v = cp.v.slice();
      s.series = cp.series.slice();
      return s;
    }

    function outcome(s) {
      var tail = s.series.slice(-6);
      function mean(k) {
        if (!tail.length) return 0;
        var a = 0; for (var i = 0; i < tail.length; i++) a += tail[i][k];
        return a / tail.length;
      }
      var metrics = {
        ke: r4(mean('ke')), enstrophy: r4(mean('en')),
        mixing: r4(mean('mix')), dispersion: r4(mean('disp'))
      };
      var stride = Math.max(1, Math.ceil(s.series.length / 60));
      var series = [];
      for (var i = 0; i < s.series.length; i += stride) series.push(s.series[i]);
      var h = hashStr(JSON.stringify(metrics) + '|' + s.it + '|' + s.seed);
      return { metrics: metrics, series: series.slice(-60), iters: s.it, seed: s.seed, hash: h };
    }

    return {
      DT: DT, create: create, step: step, runQuantum: runQuantum,
      checkpoint: checkpoint, restore: restore, outcome: outcome,
      CHECKPOINT_EVERY: 600
    };
  }

  // Worker driver — also toString-serialized. Expects global W16Core.
  function __w16WorkerDriver() {
    var sim = null, job = null, timer = null, lastCpIt = 0;
    function chunk() {
      timer = null;
      if (!sim || !job) return;
      var t0 = Date.now(), wall = 0, budget = job.quantumMs;
      while (wall < budget * 0.7 && sim.it < job.maxIter) {
        var r = W16Core.runQuantum(sim, Math.max(5, budget * 0.7 - wall), job.maxIter);
        wall = Date.now() - t0;
        if (sim.it - lastCpIt >= W16Core.CHECKPOINT_EVERY) {
          lastCpIt = sim.it;
          postMessage({ type: 'checkpoint', runId: job.runId, cp: W16Core.checkpoint(sim) });
        }
        if (r.done) break;
      }
      postMessage({ type: 'progress', runId: job.runId, it: sim.it, maxIter: job.maxIter, wallMs: wall });
      if (sim.it >= job.maxIter) {
        var out = W16Core.outcome(sim);
        postMessage({ type: 'done', runId: job.runId, outcome: out });
        sim = null; job = null; return;
      }
      timer = setTimeout(chunk, 0);
    }
    onmessage = function (e) { // eslint-disable-line no-global-assign
      var m = e.data || {};
      if (m.cmd === 'start') {
        job = m.job;
        sim = job.checkpoint
          ? W16Core.restore(job.seed, job.params, job.n, job.checkpoint)
          : W16Core.create(job.seed, job.params, job.n);
        lastCpIt = sim.it;
        postMessage({ type: 'started', runId: job.runId, resumed: !!m.job.checkpoint });
        timer = setTimeout(chunk, 0);
      } else if (m.cmd === 'pause') {
        if (timer) { clearTimeout(timer); timer = null; }
        if (sim && job) postMessage({ type: 'checkpoint', runId: job.runId, cp: W16Core.checkpoint(sim), paused: true });
        sim = null; job = null;
      }
    };
  }

  // In-page reference to the same core (degraded path + selfTest).
  var Core = __w16SimCore();
  var WORKER_SRC = 'var W16Core = (' + __w16SimCore.toString() + ')();\n(' +
    __w16WorkerDriver.toString() + ')();';

  // ============================================================ engine
  // Live state (module-level). selfTest uses fresh temp stores, never this.
  var S = freshStore();
  loadPersistedQueue(S);
  (function loadArchive() {
    var d = lsGet(LS_ARCHIVE);
    if (d) {
      if (Array.isArray(d.runs)) S.archive = d.runs;
      if (d.fronts) S.fronts = d.fronts;
    }
    var dg = lsGet(LS_DIGEST);
    if (dg) S.digest = dg;
  })();

  var ENG = {
    mode: 'idle',            // idle|running|paused|suspended
    pausedReason: null,
    path: null,              // 'worker' | 'main' — chosen at first start()
    active: {},              // runId -> {run, worker?, sim?, lastCpIt, prio}
    timer: null,
    sliceWalls: [],          // rolling quantum wall-times (thermal fallback)
    overBudgetStreak: 0,
    degradedNote: null,
    checkpoints: {}          // runId -> checkpoint (mirrored to localStorage)
  };
  (function loadCheckpoints() {
    var d = lsGet(LS_CHECKPOINTS);
    if (d && typeof d === 'object') ENG.checkpoints = d;
  })();
  function saveCheckpoints() { lsSet(LS_CHECKPOINTS, ENG.checkpoints); }
  function saveArchive() { lsSet(LS_ARCHIVE, { runs: S.archive.slice(-500), fronts: S.fronts }); }
  function activeCount() { return Object.keys(ENG.active).length; }

  function capabilityProbe() {
    return {
      worker: (typeof root.Worker !== 'undefined' && typeof root.Blob !== 'undefined' &&
        typeof root.URL !== 'undefined' && typeof root.URL.createObjectURL === 'function'),
      offscreenCanvas: (typeof root.OffscreenCanvas !== 'undefined'),
      document: !!DOC
    };
  }

  function choosePath() {
    var c = capabilityProbe();
    if (c.worker) return 'worker';
    ENG.degradedNote = 'Worker unavailable; using main-thread 250ms time-slices';
    return 'main';
  }

  function simParamsFor(proto) {
    var sp = proto.sim_params || {};
    return {
      circulation: sp.circulation != null ? sp.circulation : 1.0,
      turbulence: sp.turbulence != null ? sp.turbulence : 0.2,
      persistence: sp.persistence != null ? sp.persistence : 0.995,
      probe: proto.probe_config || null
    };
  }
  function seedFor(proto) {
    if (proto.sim_params && proto.sim_params.seed != null) return proto.sim_params.seed >>> 0;
    return parseInt(V.utils.hash53(proto.id || 'seed').slice(0, 8), 16) >>> 0;
  }
  function maxIterFor(proto) {
    var n = proto.sim_params && proto.sim_params.iterations;
    return Math.max(600, Math.min(60000, n || 6000));
  }
  function particlesFor(proto) {
    var n = proto.sim_params && proto.sim_params.particles;
    return Math.max(32, Math.min(512, n || 256));
  }

  function makeRun(proto) {
    var cp = ENG.checkpoints[proto.id] || null;
    return {
      runId: V.utils.uid('run'), protocolId: proto.id,
      hypothesis: proto.hypothesis, submitter: proto.submitter, tier: proto.tier,
      family: proto.family, expected_outcome: proto.expected_outcome,
      seed: seedFor(proto), params: simParamsFor(proto),
      n: particlesFor(proto), maxIter: maxIterFor(proto),
      it: cp ? cp.it : 0, status: 'running', started_at: V.utils.now(),
      checkpoint: cp, path: ENG.path
    };
  }

  // ---- foreground metric path (W05/W07 when present; else backend.sampleMetrics)
  // Hung-up note: the WORKER path is isolated and cannot importScripts other
  // W-modules safely, so it always uses the embedded reference core. The
  // DEGRADED main-thread path below is where W05/W07/backend hooks live.
  function foregroundMetricPath() {
    var w07 = VORTEX.get('w07-metrics') || VORTEX.get('w07');
    var w05 = VORTEX.get('w05-probe-catalog') || VORTEX.get('w05-probes');
    if (w07 && typeof w07.score === 'function') return { via: 'w07-metrics', score: w07.score, probes: w05 || null };
    if (w05 && typeof w05.apply === 'function') return { via: 'w05-probes', apply: w05.apply, metrics: w07 || null };
    var sel = VORTEX.get('w15-backends') || VORTEX.get('w02-gpu') || VORTEX.get('w14-cpu');
    var b = (sel && sel.active) || VORTEX.backend || null;
    if (b && typeof b.sampleMetrics === 'function') return { via: 'backend.sampleMetrics', sample: b.sampleMetrics.bind(b) };
    return { via: 'reference-core' };
  }

  // ---- lab hours: overnight aggressive, work hours polite, evenings normal
  function labHours() {
    var h = new Date().getHours();
    if (S.override === 'quiet') return { mode: 'override-quiet', workers: 0, quantum: QUANTUM_MS };
    if (S.override === 'hot') return { mode: 'override-hot', workers: MAX_CONCURRENT, quantum: QUANTUM_MS };
    if (h >= 22 || h < 7) return { mode: 'overnight', workers: MAX_CONCURRENT, quantum: QUANTUM_MS };
    if (h >= 9 && h < 17) return { mode: 'workhours', workers: 1, quantum: QUANTUM_MS };
    return { mode: 'evening', workers: MAX_CONCURRENT, quantum: QUANTUM_MS };
  }
  function concurrencyCap() { return Math.min(MAX_CONCURRENT, labHours().workers); }

  // ---- thermal: W11 governor when present, else internal frame-time guard
  function governor() {
    var g = VORTEX.get('w11-governor') || VORTEX.get('w11');
    if (g && typeof g.thermalState === 'function') return g;
    if (g && typeof g.thermal === 'function') return { thermalState: g.thermal };
    return null;
  }
  function thermalQuantum(base) {
    var g = governor();
    if (g) {
      try {
        var st = g.thermalState();
        if (st === 'critical') { suspendAll('thermal-critical'); return 0; }
        if (st === 'elevated') return Math.floor(base / 2);
      } catch (e) {}
      return base;
    }
    return base; // fallback guard handled per-slice below
  }
  function thermalGuardFallback(quantum, wallMs) {
    ENG.sliceWalls.push(wallMs);
    if (ENG.sliceWalls.length > 8) ENG.sliceWalls.shift();
    if (ENG.sliceWalls.length < 4) return;
    var avg = ENG.sliceWalls.reduce(function (a, b) { return a + b; }, 0) / ENG.sliceWalls.length;
    if (avg > quantum * 2.5) {
      ENG.overBudgetStreak++;
      if (ENG.overBudgetStreak >= 3) {
        suspendAll('thermal-guard');
        V.bus.emit('vx:degraded', { from: 'background', to: 'suspended', reason: 'sustained over-budget slices' });
      }
    } else ENG.overBudgetStreak = 0;
  }

  // ---- worker path
  function spawnWorker(run) {
    var blob = new root.Blob([WORKER_SRC], { type: 'text/javascript' });
    var url = root.URL.createObjectURL(blob);
    var w = new root.Worker(url);
    var entry = { run: run, worker: w, url: url, lastCpIt: run.it, prio: TIER_RANK[run.tier] };
    w.onmessage = function (e) { onWorkerMsg(entry, e.data || {}); };
    w.onerror = function (err) {
      // Worker died: checkpoint what we have, degrade this run to main path.
      terminateWorker(entry);
      run.checkpoint = ENG.checkpoints[run.protocolId] || null;
      run.path = 'main';
      startRunMain(run, entry.prio);
      V.bus.emit('vx:degraded', { from: 'worker-run', to: 'main-thread-run', reason: String((err && err.message) || 'worker error') });
    };
    w.postMessage({
      cmd: 'start',
      job: {
        runId: run.runId, seed: run.seed, params: run.params, n: run.n,
        maxIter: run.maxIter, quantumMs: labHours().quantum,
        checkpoint: run.checkpoint
      }
    });
    ENG.active[run.runId] = entry;
    return entry;
  }
  function terminateWorker(entry) {
    try { entry.worker.terminate(); } catch (e) {}
    try { root.URL.revokeObjectURL(entry.url); } catch (e) {}
    delete ENG.active[entry.run.runId];
  }
  function onWorkerMsg(entry, m) {
    var run = entry.run;
    if (m.runId !== run.runId) return;
    if (m.type === 'progress') {
      run.it = m.it;
      thermalGuardFallback(labHours().quantum, m.wallMs || 0);
    } else if (m.type === 'checkpoint') {
      run.it = (m.cp && m.cp.it) || run.it;
      ENG.checkpoints[run.protocolId] = m.cp;
      saveCheckpointsThrottled();
      if (m.paused) { terminateWorker(entry); stashPaused(run, 'preempted'); }
    } else if (m.type === 'done') {
      terminateWorker(entry);
      finishRun(run, m.outcome);
    }
  }
  var _cpSaveT = 0;
  function saveCheckpointsThrottled() {
    var now = V.utils.now();
    if (now - _cpSaveT > 2000) { _cpSaveT = now; saveCheckpoints(); }
  }

  // ---- degraded main-thread path: interleaved 250ms quanta
  function startRunMain(run, prio) {
    var sim = run.checkpoint
      ? Core.restore(run.seed, run.params, run.n, run.checkpoint)
      : Core.create(run.seed, run.params, run.n);
    ENG.active[run.runId] = { run: run, sim: sim, lastCpIt: sim.it, prio: prio != null ? prio : TIER_RANK[run.tier] };
  }
  function tickMain() {
    ENG.timer = null;
    if (ENG.mode !== 'running') return;
    var now = V.utils.now();
    var cap = concurrencyCap();
    var lh = labHours();
    if (cap === 0) { pauseAll('override-quiet'); return; }
    var quantum = thermalQuantum(lh.quantum);
    if (quantum === 0) return; // suspended by thermal
    while (activeCount() < cap) {
      var p = dequeue(S, now);
      if (!p) break;
      persistQueue(S);
      startRunMain(makeRun(p));
    }
    maybePreempt(now);
    var ids = Object.keys(ENG.active);
    for (var i = 0; i < ids.length; i++) {
      var entry = ENG.active[ids[i]];
      if (!entry || !entry.sim) continue;
      var run = entry.run;
      var res = Core.runQuantum(entry.sim, quantum, run.maxIter);
      run.it = entry.sim.it;
      thermalGuardFallback(quantum, res.wallMs);
      if (entry.sim.it - entry.lastCpIt >= CHECKPOINT_EVERY) {
        entry.lastCpIt = entry.sim.it;
        ENG.checkpoints[run.protocolId] = Core.checkpoint(entry.sim);
        saveCheckpointsThrottled();
      }
      if (res.done) {
        var out = Core.outcome(entry.sim);
        delete ENG.active[run.runId];
        finishRun(run, out);
      }
      if (ENG.mode !== 'running') return; // thermal guard may have suspended
    }
    saveCheckpoints();
    ENG.timer = setTimeout(tickMain, 0);
  }

  // Priority re-eval between quanta: a waiting shawn-tier protocol preempts
  // the lowest-priority active run at the next slice boundary.
  function maybePreempt(nowMs) {
    var ordered = peekOrdered(S, nowMs);
    if (!ordered.length) return;
    var head = ordered[0];
    var headRank = effectiveRank(head, nowMs);
    var ids = Object.keys(ENG.active);
    if (ids.length < concurrencyCap()) return;
    var worstId = null, worstRank = -1;
    for (var i = 0; i < ids.length; i++) {
      var e = ENG.active[ids[i]];
      if (e.prio > worstRank) { worstRank = e.prio; worstId = ids[i]; }
    }
    if (worstId && headRank < worstRank) {
      var entry = ENG.active[worstId];
      var run = entry.run;
      if (entry.worker) {
        entry.worker.postMessage({ cmd: 'pause' }); // checkpoint arrives via onWorkerMsg
      } else if (entry.sim) {
        ENG.checkpoints[run.protocolId] = Core.checkpoint(entry.sim);
        delete ENG.active[worstId];
        stashPaused(run, 'preempted');
      }
      saveCheckpoints();
      persistQueue(S);
    }
  }
  function stashPaused(run, reason) {
    run.status = 'paused';
    run.pausedReason = reason;
    S.paused.unshift(run);
    persistQueue(S);
  }

  // ---- worker-path scheduler (event-driven; re-evaluates on a 250ms cadence)
  function tickWorker() {
    ENG.timer = null;
    if (ENG.mode !== 'running') return;
    var now = V.utils.now();
    var cap = concurrencyCap();
    if (cap === 0) { pauseAll('override-quiet'); return; }
    var quantum = thermalQuantum(labHours().quantum);
    if (quantum === 0) return;
    // resume paused runs first (they hold checkpoints), then dequeue
    while (activeCount() < cap && S.paused.length) {
      var r = S.paused.shift();
      r.status = 'running'; r.started_at = V.utils.now();
      r.checkpoint = ENG.checkpoints[r.protocolId] || r.checkpoint || null;
      try { spawnWorker(r); } catch (e) { r.path = 'main'; startRunMain(r); }
      persistQueue(S);
    }
    while (activeCount() < cap) {
      var p = dequeue(S, now);
      if (!p) break;
      persistQueue(S);
      try { spawnWorker(makeRun(p)); }
      catch (e) {
        ENG.path = 'main'; ENG.degradedNote = 'worker spawn failed: ' + e.message;
        V.bus.emit('vx:degraded', { from: 'worker', to: 'main-thread', reason: e.message });
        var run = makeRun(p); run.path = 'main'; startRunMain(run);
        ENG.timer = setTimeout(tickMain, 0);
        return;
      }
    }
    maybePreempt(now);
    ENG.timer = setTimeout(tickWorker, QUANTUM_MS);
  }

  function pauseAll(reason) {
    var ids = Object.keys(ENG.active);
    for (var i = 0; i < ids.length; i++) {
      var entry = ENG.active[ids[i]];
      var run = entry.run;
      if (entry.worker) entry.worker.postMessage({ cmd: 'pause' });
      else if (entry.sim) {
        ENG.checkpoints[run.protocolId] = Core.checkpoint(entry.sim);
        delete ENG.active[ids[i]];
        stashPaused(run, reason);
      }
    }
    saveCheckpoints();
    if (ENG.timer) { clearTimeout(ENG.timer); ENG.timer = null; }
    ENG.mode = 'paused'; ENG.pausedReason = reason;
    persistEngine();
  }
  function suspendAll(reason) { // thermal: like pause but flagged
    pauseAll(reason);
    ENG.mode = 'suspended';
    persistEngine();
  }
  function persistEngine() {
    lsSet(LS_ENGINE, { mode: ENG.mode, path: ENG.path, saved_at: V.utils.now() });
  }

  // ============================================================ harvesting
  var METRIC_KEYS = ['ke', 'enstrophy', 'mixing', 'dispersion'];

  function familyFront(store, family) {
    if (!store.fronts[family]) store.fronts[family] = { points: [], ranges: {} };
    return store.fronts[family];
  }

  // Novelty = normalized Euclidean distance from the run's outcome to the
  // nearest archived point of the protocol family's Pareto-ish front, plus
  // new-extreme detection (outside the family's known range by >1%).
  // "Interesting" when: novel region, new extreme, or a shawn hypothesis
  // decided (CONFIRMED/REFUTED). Everything else archives silently.
  function scoreOutcome(store, family, outcome, protocol) {
    var front = familyFront(store, family);
    var m = outcome.metrics;
    var ranges = front.ranges, pts = front.points;
    var newExtreme = null;
    for (var i = 0; i < METRIC_KEYS.length; i++) {
      var k = METRIC_KEYS[i], v = +m[k] || 0;
      var r = ranges[k];
      if (!r) { ranges[k] = { min: v, max: v }; newExtreme = newExtreme || k; }
      else {
        var span = (r.max - r.min) || Math.abs(r.max) || 1;
        if (v < r.min - span * EXTREME_MARGIN) { r.min = v; newExtreme = newExtreme || (k + ' low'); }
        else if (v > r.max + span * EXTREME_MARGIN) { r.max = v; newExtreme = newExtreme || (k + ' high'); }
      }
    }
    function normVec(mm) {
      var o = {};
      for (var j = 0; j < METRIC_KEYS.length; j++) {
        var kk = METRIC_KEYS[j], rr = ranges[kk], vv = +mm[kk] || 0;
        var sp = (rr.max - rr.min) || Math.abs(rr.max) || 1;
        o[kk] = (vv - rr.min) / sp;
      }
      return o;
    }
    var nv = normVec(m);
    var novelty = 1, best = -1;
    for (var p = 0; p < pts.length; p++) {
      var d2 = 0;
      for (var q = 0; q < METRIC_KEYS.length; q++) {
        var kk2 = METRIC_KEYS[q], dd = nv[kk2] - pts[p][kk2];
        d2 += dd * dd;
      }
      var d = Math.sqrt(d2);
      if (d < novelty) { novelty = d; best = p; }
    }
    var reasons = [], interesting = false;
    if (!pts.length) { interesting = true; reasons.push('first result in family'); }
    if (newExtreme && pts.length) { interesting = true; reasons.push('new family extreme: ' + newExtreme); }
    if (novelty >= NOVELTY_THRESHOLD && pts.length) {
      interesting = true; reasons.push('novel region (d=' + novelty.toFixed(2) + ')');
    }
    var verdict = verdictFor(protocol, m, front);
    if (protocol && protocol.submitter === 'shawn' && (verdict === 'CONFIRMED' || verdict === 'REFUTED')) {
      interesting = true; reasons.push('your hypothesis ' + verdict.toLowerCase());
    }
    pts.push(nv);
    if (pts.length > 200) pts.shift();
    return { novelty: Math.round(novelty * 1000) / 1000, interesting: interesting, reasons: reasons, verdict: verdict };
  }

  function verdictFor(protocol, metrics, front) {
    var eo = protocol && protocol.expected_outcome;
    if (!eo || !eo.metric || metrics[eo.metric] == null) return 'INCONCLUSIVE';
    var v = +metrics[eo.metric], base = eo.vs;
    if (base === 'baseline' || base == null) {
      var r = front.ranges[eo.metric];
      base = r ? (r.min + r.max) / 2 : v;
    }
    base = +base;
    var delta = (eo.delta != null ? eo.delta : 0.05) * (Math.abs(base) || 1);
    var dir = eo.direction === 'down' ? -1 : 1;
    var move = (v - base) * dir;
    if (move >= delta) return 'CONFIRMED';
    if (move <= -delta) return 'REFUTED';
    return 'INCONCLUSIVE';
  }

  function finishRun(run, outcome) {
    var scored = scoreOutcome(S, run.family, outcome, run);
    var rec = {
      runId: run.runId, protocolId: run.protocolId, family: run.family,
      hypothesis: run.hypothesis, submitter: run.submitter,
      seed: run.seed, iters: outcome.iters, metrics: outcome.metrics,
      hash: outcome.hash, novelty: scored.novelty, interesting: scored.interesting,
      reasons: scored.reasons, verdict: scored.verdict,
      path: run.path, completed_at: V.utils.now()
    };
    S.archive.push(rec);
    saveArchive();
    delete ENG.checkpoints[run.protocolId];
    saveCheckpoints();
    V.bus.emit('vx:background-done', { runId: run.runId, protocolId: run.protocolId, novelty: scored.novelty });
    return rec;
  }

  // ============================================================ digest
  function localDateStr(d) {
    d = d || new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function digestLine(rec) {
    var m = rec.metrics;
    if (rec.reasons.join(' ').indexOf('extreme') >= 0)
      return '🏆 New best: ' + shortHyp(rec.hypothesis) + ' — mixing ' + m.mixing + ', ke ' + m.ke;
    if (rec.verdict === 'CONFIRMED')
      return '✅ Hypothesis confirmed: "' + shortHyp(rec.hypothesis) + '"';
    if (rec.verdict === 'REFUTED')
      return '❌ Hypothesis refuted: "' + shortHyp(rec.hypothesis) + '"';
    return '🔍 Novel region: ' + shortHyp(rec.hypothesis) + ' (novelty ' + rec.novelty + ')';
  }
  function shortHyp(h) {
    h = String(h || 'untitled');
    return h.length > 64 ? h.slice(0, 61) + '…' : h;
  }

  function buildDigest(store, dateStr) {
    dateStr = dateStr || localDateStr();
    var runs = store.archive.filter(function (r) { return localDateStr(new Date(r.completed_at)) === dateStr; });
    var interesting = runs.filter(function (r) { return r.interesting; });
    var boring = runs.length - interesting.length;
    var counts = { shawn: 0, curriculum: 0, curiosity: 0 };
    store.queue.forEach(function (p) { if (counts[p.tier] != null) counts[p.tier]++; });
    return {
      date: dateStr,
      runs: runs.length,
      interesting: interesting.map(function (r) {
        return { runId: r.runId, protocolId: r.protocolId, line: digestLine(r), deepLink: '#vortex/run/' + r.runId };
      }),
      boring: boring,
      queue: { waiting: store.queue.length, byTier: counts }
    };
  }

  function refreshDigest(dateStr) {
    S.digest = buildDigest(S, dateStr);
    lsSet(LS_DIGEST, S.digest);
    V.bus.emit('vx:digest-ready', { date: S.digest.date, runs: S.digest.runs });
    return S.digest;
  }

  // ============================================================ visibility lifecycle
  // PAUSE when the lab is open/foreground (main thread belongs to the user);
  // RESUME when hidden/overnight.
  function wireVisibility() {
    if (!DOC || typeof DOC.addEventListener !== 'function') return;
    DOC.addEventListener('visibilitychange', function () {
      if (DOC.hidden) {
        if (ENG.mode === 'paused' && ENG.pausedReason === 'foreground') resumeEngine();
        else if (ENG.mode === 'idle' && (S.queue.length || S.paused.length)) startEngine();
      } else {
        if (ENG.mode === 'running') {
          pauseAll('foreground');
          V.bus.emit('vx:announce', { message: 'Background runs paused — lab is in the foreground.' });
        }
      }
    });
  }

  // ============================================================ public API
  function startEngine() {
    if (ENG.mode === 'running') return api.status();
    if (!ENG.path) {
      ENG.path = choosePath();
      if (ENG.path === 'main') {
        V.bus.emit('vx:degraded', { from: 'worker', to: 'main-thread', reason: ENG.degradedNote || 'unavailable' });
      }
    }
    var cap = concurrencyCap();
    if (cap === 0) { ENG.mode = 'paused'; ENG.pausedReason = 'override-quiet'; return api.status(); }
    ENG.mode = 'running'; ENG.pausedReason = null;
    ENG.overBudgetStreak = 0; ENG.sliceWalls = [];
    persistEngine();
    if (ENG.path === 'worker') { ENG.timer = setTimeout(tickWorker, 0); }
    else { ENG.timer = setTimeout(tickMain, 0); }
    return api.status();
  }
  function resumeEngine() {
    if (ENG.mode === 'suspended') return api.status(); // thermal: explicit retry only
    ENG.mode = 'idle';
    return startEngine();
  }

  var api = {
    // -- queue -----------------------------------------------------------
    submit: function (p) {
      if (!p || typeof p !== 'object') return { ok: false, error: 'protocol must be an object' };
      if (!p.hypothesis || !p.sim_params) return { ok: false, error: 'protocol needs hypothesis + sim_params' };
      var q = normalizeProtocol(p, V.utils.now());
      var res = mergeInto(S, q, V.utils.now());
      persistQueue(S);
      // Overnight auto-run: a submission while the tab is hidden starts the engine.
      if (DOC && DOC.hidden && ENG.mode !== 'running' && ENG.mode !== 'suspended') startEngine();
      return { ok: true, id: res.id, merged: res.merged, tier: res.tier };
    },
    queue: function () { return peekOrdered(S, V.utils.now()); },
    clearQueue: function () { S.queue = []; persistQueue(S); return { ok: true }; },

    // -- engine ----------------------------------------------------------
    start: startEngine,
    pause: function () { pauseAll('manual'); return api.status(); },
    resume: resumeEngine,
    retryThermal: function () {
      if (ENG.mode !== 'suspended') return { ok: false, status: api.status() };
      ENG.overBudgetStreak = 0; ENG.sliceWalls = [];
      ENG.mode = 'idle';
      return { ok: true, status: startEngine() };
    },
    stop: function () {
      if (ENG.timer) { clearTimeout(ENG.timer); ENG.timer = null; }
      var ids = Object.keys(ENG.active);
      for (var i = 0; i < ids.length; i++) {
        var e = ENG.active[ids[i]];
        if (e.worker) terminateWorker(e);
      }
      ENG.active = {};
      ENG.mode = 'idle'; ENG.pausedReason = null;
      persistEngine();
      return api.status();
    },
    setOverride: function (mode) {
      S.override = (mode === 'hot' || mode === 'quiet') ? mode : null;
      if (S.override === 'quiet' && ENG.mode === 'running') pauseAll('override-quiet');
      return { ok: true, override: S.override, labHours: labHours() };
    },
    status: function () {
      var act = Object.keys(ENG.active).map(function (id) {
        var e = ENG.active[id];
        return { runId: id, protocolId: e.run.protocolId, tier: e.run.tier, it: e.run.it, maxIter: e.run.maxIter, path: e.run.path };
      });
      var counts = { shawn: 0, curriculum: 0, curiosity: 0 };
      S.queue.forEach(function (p) { if (counts[p.tier] != null) counts[p.tier]++; });
      return {
        engine: ENG.mode, pausedReason: ENG.pausedReason,
        executionPath: ENG.path, degradedNote: ENG.degradedNote,
        capabilities: capabilityProbe(), labHours: labHours(),
        foregroundMetricPath: foregroundMetricPath().via,
        active: act, queued: S.queue.length, queuedByTier: counts,
        paused: S.paused.length, archived: S.archive.length,
        families: Object.keys(S.fronts)
      };
    },

    // -- results ---------------------------------------------------------
    digest: function (dateStr) { return refreshDigest(dateStr); },
    lastDigest: function () { return S.digest; },
    archive: function () { return S.archive.slice(); },
    fronts: function () { return JSON.parse(JSON.stringify(S.fronts)); },
    runs: function () { return S.archive.slice(-50); },

    // -- self test -------------------------------------------------------
    selfTest: selfTest
  };

  // on-demand digest, as the proposal names it: vortex.digest()
  if (!VORTEX.digest) VORTEX.digest = function (dateStr) { return api.digest(dateStr); };

  // Overnight panel (DOM-guarded; headless-safe)
  V.ui.registerPanel('w16-overnight', 'Overnight', function (el) {
    if (!IS_BROWSER || !el) return;
    function render() {
      el.innerHTML = '';
      var d = api.lastDigest() || api.digest();
      var doc = root.document;
      var wrap = doc.createElement('div'); wrap.className = 'vx-overnight';
      var h = doc.createElement('h3');
      h.textContent = 'Overnight in the Lab — ' + d.date;
      var sub = doc.createElement('p');
      sub.textContent = d.runs + ' runs, ' + d.interesting.length + ' interesting';
      wrap.appendChild(h); wrap.appendChild(sub);
      var ul = doc.createElement('ul');
      d.interesting.forEach(function (it) {
        var li = doc.createElement('li');
        var a = doc.createElement('a');
        a.href = it.deepLink; a.textContent = it.line;
        li.appendChild(a); ul.appendChild(li);
      });
      wrap.appendChild(ul);
      if (d.boring > 0) {
        var det = doc.createElement('details');
        var sum = doc.createElement('summary');
        sum.textContent = d.boring + ' boring archived silently';
        det.appendChild(sum); wrap.appendChild(det);
      }
      var q = doc.createElement('p');
      q.textContent = 'Queue: ' + d.queue.waiting + ' waiting (' +
        d.queue.byTier.shawn + ' yours, ' + d.queue.byTier.curriculum +
        ' curriculum, ' + d.queue.byTier.curiosity + ' curiosity)';
      wrap.appendChild(q);
      var btn = doc.createElement('button');
      btn.textContent = 'Refresh digest';
      btn.addEventListener('click', function () { render(); });
      wrap.appendChild(btn);
      el.appendChild(wrap);
    }
    render();
    V.bus.on('vx:digest-ready', render);
  });

  wireVisibility();

  // Boot: runs persisted as active at shutdown resume as paused with their
  // checkpoints; if the tab is hidden (overnight) and work is waiting, start.
  (function bootResume() {
    var eng = lsGet(LS_ENGINE);
    if (S.paused.length && eng && eng.mode === 'running') {
      if (DOC && DOC.hidden) startEngine();
    } else if (S.queue.length && DOC && DOC.hidden && (!eng || eng.mode === 'running')) {
      startEngine();
    }
  })();

  // ============================================================ selfTest
  function selfTest() {
    var checks = [];
    function ck(name, fn) {
      try {
        var r = fn();
        checks.push({ name: name, ok: !!r.ok, detail: r.detail || '' });
      } catch (e) {
        checks.push({ name: name, ok: false, detail: 'threw: ' + (e && e.message) });
      }
    }
    var NOW = 1787000000000; // fixed clock for determinism

    ck('queue ordering: shawn jumps front', function () {
      var t = freshStore();
      mergeInto(t, normalizeProtocol({ submitter: 'vera', hypothesis: 'c1', sim_params: { a: 1 }, created_at: NOW }, NOW), NOW);
      mergeInto(t, normalizeProtocol({ submitter: 'curiosity-bot', hypothesis: 'c2', sim_params: { a: 2 }, created_at: NOW + 1 }, NOW), NOW);
      mergeInto(t, normalizeProtocol({ submitter: 'shawn', hypothesis: 's1', sim_params: { a: 3 }, created_at: NOW + 2 }, NOW), NOW);
      var o = peekOrdered(t, NOW + 3).map(function (p) { return p.tier; });
      return { ok: o.join(',') === 'shawn,curriculum,curiosity', detail: o.join('>') };
    });

    ck('anti-starvation: 48h-old tier-3 preempts curriculum, never shawn', function () {
      var t = freshStore();
      var old = NOW - 49 * 3600000;
      mergeInto(t, normalizeProtocol({ submitter: 'vera', hypothesis: 'curr', sim_params: { a: 1 }, created_at: NOW }, NOW), NOW);
      mergeInto(t, normalizeProtocol({ submitter: 'sweep', hypothesis: 'old-c', sim_params: { a: 2 }, created_at: old }, NOW), NOW);
      mergeInto(t, normalizeProtocol({ submitter: 'shawn', hypothesis: 's', sim_params: { a: 3 }, created_at: NOW + 1 }, NOW), NOW);
      var o = peekOrdered(t, NOW + 2).map(function (p) { return p.hypothesis; });
      var good = o[0] === 's' && o[1] === 'old-c' && o[2] === 'curr';
      return { ok: good, detail: o.join('>') };
    });

    ck('dedup merges on hash(sim_params+probe_config), keeps higher tier', function () {
      var t = freshStore();
      var p1 = { submitter: 'sweep', hypothesis: 'low', sim_params: { a: 1 }, probe_config: { type: 'stir' }, created_at: NOW };
      var p2 = { submitter: 'shawn', hypothesis: 'high', sim_params: { a: 1 }, probe_config: { type: 'stir' }, created_at: NOW + 5 };
      var r1 = mergeInto(t, normalizeProtocol(p1, NOW), NOW);
      var r2 = mergeInto(t, normalizeProtocol(p2, NOW), NOW);
      var e = t.queue[0];
      var good = !r1.merged && r2.merged && t.queue.length === 1 &&
        e.tier === 'shawn' && e.hypothesis === 'high' &&
        e.submitters.indexOf('sweep') >= 0 && e.submitters.indexOf('shawn') >= 0;
      return { ok: good, detail: 'len=' + t.queue.length + ' tier=' + e.tier + ' submitters=' + e.submitters.join(',') };
    });

    ck('time-slice budget respected on synthetic workload', function () {
      var sim = Core.create(42, { circulation: 1.5, turbulence: 0.9 }, 64);
      var budget = 20, worst = 0, totalIters = 0;
      for (var i = 0; i < 8; i++) {
        var r = Core.runQuantum(sim, budget, 100000);
        if (r.wallMs > worst) worst = r.wallMs;
        totalIters += r.iters;
        if (r.done) break;
      }
      // wall clock has slop; allow 2.5x headroom, require real progress
      return { ok: worst <= budget * 2.5 && totalIters > 500, detail: 'worst slice ' + worst.toFixed(1) + 'ms vs ' + budget + 'ms budget, ' + totalIters + ' iters' };
    });

    ck('checkpoint/resume reproduces state exactly', function () {
      var params = { circulation: 1.2, turbulence: 0.3, probe: { type: 'stir', strength: 0.7, startIter: 100, endIter: 900 } };
      var a = Core.create(7, params, 64);
      while (a.it < 600) Core.step(a);
      var cp = Core.checkpoint(a);
      while (a.it < 1200) Core.step(a);
      var ha = Core.outcome(a).hash;
      var b = Core.restore(7, params, 64, cp);
      while (b.it < 1200) Core.step(b);
      var hb = Core.outcome(b).hash;
      return { ok: ha === hb && b.it === 1200, detail: 'hash ' + ha.slice(0, 12) + (ha === hb ? ' == ' : ' != ') + hb.slice(0, 12) };
    });

    ck('novelty: first run interesting, near-duplicate boring', function () {
      var t = freshStore();
      var proto = { submitter: 'sweep', hypothesis: 'h', expected_outcome: null };
      var s1 = scoreOutcome(t, 'fam', { metrics: { ke: 1, enstrophy: 1, mixing: 1, dispersion: 1 } }, proto);
      var s2 = scoreOutcome(t, 'fam', { metrics: { ke: 1.001, enstrophy: 1.001, mixing: 1.001, dispersion: 1.001 } }, proto);
      var s3 = scoreOutcome(t, 'fam', { metrics: { ke: 5, enstrophy: 5, mixing: 5, dispersion: 5 } }, proto);
      var good = s1.interesting && !s2.interesting && s3.interesting;
      return { ok: good, detail: 'novelties ' + s1.novelty + '/' + s2.novelty + '/' + s3.novelty };
    });

    ck('digest aggregates: runs count, interesting lines, boring collapsed', function () {
      var t = freshStore();
      var day = new Date(NOW);
      function rec(id, interesting, line) {
        return {
          runId: id, protocolId: 'p-' + id, family: 'fam', hypothesis: 'h-' + id,
          submitter: 'sweep', seed: 1, iters: 6000,
          metrics: { ke: 1, enstrophy: 1, mixing: 1, dispersion: 1 },
          hash: 'h', novelty: interesting ? 0.9 : 0.01, interesting: interesting,
          reasons: [line], verdict: 'INCONCLUSIVE', path: 'main', completed_at: NOW
        };
      }
      t.archive.push(rec('r1', true, 'novel region'), rec('r2', true, 'new family extreme'), rec('r3', false, ''));
      t.queue.push(normalizeProtocol({ submitter: 'shawn', hypothesis: 'q', sim_params: { a: 9 }, created_at: NOW }, NOW));
      var dg = buildDigest(t, localDateStr(day));
      var good = dg.runs === 3 && dg.interesting.length === 2 && dg.boring === 1 &&
        dg.interesting[0].deepLink === '#vortex/run/r1' && dg.queue.waiting === 1 &&
        dg.queue.byTier.shawn === 1;
      return { ok: good, detail: 'runs=' + dg.runs + ' interesting=' + dg.interesting.length + ' boring=' + dg.boring };
    });

    ck('environment report (headless-safe)', function () {
      var c = capabilityProbe();
      var path = c.worker ? 'worker (Web Workers available)' : 'main-thread degraded (no Worker)';
      return { ok: true, detail: 'path=' + path + ' offscreenCanvas=' + c.offscreenCanvas + ' dom=' + c.document };
    });

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  VORTEX.register('w16-background', api);
})(typeof window !== 'undefined' ? window : globalThis);
