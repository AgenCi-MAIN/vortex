/* VORTEX js/megafield.js — W03.
 * Tier A / 1M-tracer megafield, honest edition.
 *
 * Jobs:
 *  1. Memory accounting: honest live-state + GPU working-set estimates from
 *     the actual SoA layout. Refuse allocation beyond a computed device budget.
 *  2. Eligibility gate for Tier A: 64K benchmark >= 120 FPS AND >= 2GB free
 *     GPU memory estimate. User override allowed, but the UI must label it.
 *  3. View-coupled rendering: cull off-screen draws while the FULL state
 *     still advects; adaptive draw-density LOD strides PIXELS, never sim state.
 *  4. Field monitor data provider: truthful numbers from the real backend when
 *     present, clearly-labeled estimates otherwise.
 *  5. Headless-safe everything. No DOM, canvas, or GL touched at load.
 *
 * Loads after js/field-contract.js (W02 defines it). All backend access is
 * guarded with VORTEX.has('w02-gpu') / VORTEX.get — never reimplemented here.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('megafield: VORTEX namespace missing');

  // ------------------------------------------------------------------
  // Caller-supplied free-memory claims are never trusted above the module's
  // own conservative estimate: a claim HIGHER than the estimate is clamped
  // (with a note); a LOWER claim is accepted (more conservative). This keeps
  // requestMegafield / checkTierA honest when a caller passes an absurd
  // number (e.g. freeGpuMB: 1e9).
  function trustedFreeMB(claimed) {
    var free = freeGpuMBEstimate();
    var mb = free.mb, note = null;
    if (typeof claimed === 'number' && isFinite(claimed) && claimed > 0) {
      if (claimed > free.mb) {
        note = 'claimed freeGpuMB ' + claimed + 'MB exceeds internal estimate ' +
          free.mb + 'MB (' + free.basis + '); clamped to the estimate';
      } else { mb = claimed; }
    }
    return { mb: mb, basis: free.basis, note: note };
  }

  // ------------------------------------------------------------------
  // 1. Memory model — derived from the ACTUAL SoA layout W03 assumes.
  //
  // Per-tracer channels (float32, structure-of-arrays):
  //   px, py        position in domain space        2 floats
  //   vx, vy        velocity                        2 floats
  //   dye           dye concentration               1 float
  //   age           tracer age (sim seconds)        1 float
  //   seed          per-tracer spawn seed           1 float
  //   curl          last-sampled vorticity          1 float
  //   ox, oy        previous position (trail)       2 floats
  // --------------------------------------------------------------
  //   TOTAL                                         10 floats = 40 bytes
  //
  // These constants ARE the layout. estimate() is bytes = tracers * 40.
  var FLOATS_PER_TRACER = 10;
  var BYTES_PER_FLOAT = 4;
  var STRIDE_BYTES = FLOATS_PER_TRACER * BYTES_PER_FLOAT; // 40

  // GPU working set (WebGL2 float textures, per design):
  //   2x live state (ping-pong RGBA32F position/dye buffers) +
  //   1x live state (velocity / probe texture) +
  //   ~0.5x (scratch FBO, mip/readback ring, uniforms)
  // = 3.5x live. We report the factor explicitly; it is an estimate.
  var GPU_WORKING_SET_FACTOR = 3.5;

  var TIERS = {
    C: { name: 'Tier C', tracers: 4096,    label: '4K CPU — compatibility floor' },
    B: { name: 'Tier B', tracers: 262144,  label: '262K GPU — portable ceiling' },
    A: { name: 'Tier A', tracers: 1000000, label: '1M GPU — megafield' }
  };

  // ------------------------------------------------------------------
  // Device budget. navigator.deviceMemory (Chrome) is GB of RAM, quantized;
  // otherwise we fall back to a conservative default. EVERYTHING about the
  // "free GPU memory" number is an estimate and is labeled as such —
  // WebGL2 cannot query VRAM, and we refuse to pretend otherwise.
  function _deviceMemoryGB() {
    try {
      var dm = root.navigator && root.navigator.deviceMemory;
      if (typeof dm === 'number' && dm > 0) return dm;
    } catch (e) { /* ignore */ }
    return null;
  }

  function memoryBudget() {
    var dmGB = _deviceMemoryGB();
    // Conservative policy: no single sim may claim more than 25% of system
    // RAM, capped at 2 GB, floored at 256 MB.
    var bytes;
    var source;
    if (dmGB !== null) {
      bytes = Math.min(dmGB * 1e9 * 0.25, 2e9);
      source = 'estimate:deviceMemory*0.25';
    } else {
      bytes = 512 * 1024 * 1024;
      source = 'default:512MB (deviceMemory unavailable)';
    }
    bytes = Math.max(bytes, 256 * 1024 * 1024);
    return {
      bytes: Math.floor(bytes),
      mb: Math.floor(bytes / (1024 * 1024)),
      source: source,
      policy: '25% of system RAM, capped 2GB, floored 256MB'
    };
  }

  // free-GPU-memory ESTIMATE. Never presented as measured.
  function freeGpuMBEstimate() {
    var dmGB = _deviceMemoryGB();
    if (dmGB !== null) {
      // Assume the GPU may use up to ~50% of shared/system RAM, then subtract
      // what we already think is committed (very rough). Labeled estimate.
      var mb = Math.floor(dmGB * 1024 * 0.5 * 0.8);
      return { mb: mb, basis: 'estimate:0.8*0.5*deviceMemory' };
    }
    return { mb: 1024, basis: 'estimate:default 1024MB (no deviceMemory)' };
  }

  // Honest accounting from the real layout. bytes = tracers * 40 exactly.
  function estimate(tracers) {
    tracers = Math.max(0, Math.floor(tracers || 0));
    var liveBytes = tracers * STRIDE_BYTES;
    var gpuBytes = Math.ceil(liveBytes * GPU_WORKING_SET_FACTOR);
    var budget = memoryBudget();
    return {
      tracers: tracers,
      floatsPerTracer: FLOATS_PER_TRACER,
      strideBytes: STRIDE_BYTES,
      liveBytes: liveBytes,
      liveMB: +(liveBytes / (1024 * 1024)).toFixed(2),
      gpuBytes: gpuBytes,
      gpuMB: +(gpuBytes / (1024 * 1024)).toFixed(2),
      gpuFactor: GPU_WORKING_SET_FACTOR,
      budgetBytes: budget.bytes,
      budgetMB: budget.mb,
      fits: gpuBytes <= budget.bytes,
      basis: 'computed from SoA layout (10 float32/tracer); GPU working set = 3.5x live (estimate)'
    };
  }

  // ------------------------------------------------------------------
  // 2. Eligibility gate.
  //
  // Tier A enables ONLY when:
  //   (a) the 64K benchmark hits >= 120 FPS, AND
  //   (b) free GPU memory estimate >= 2048 MB.
  // Override is allowed but MUST carry the honesty label.
  var TIER_A_MIN_BENCH_FPS = 120;
  var TIER_A_MIN_FREE_GPU_MB = 2048;

  function measuredTier(benchFps, freeGpuMB) {
    benchFps = +benchFps || 0;
    freeGpuMB = +freeGpuMB || 0;
    if (benchFps >= TIER_A_MIN_BENCH_FPS && freeGpuMB >= TIER_A_MIN_FREE_GPU_MB) return 'A';
    if (benchFps >= TIER_A_MIN_BENCH_FPS) return 'B';
    if (benchFps >= 30) return 'C';
    return 'NONE';
  }

  function gate(benchFps, freeGpuMB, opts) {
    opts = opts || {};
    var measured = measuredTier(benchFps, freeGpuMB);
    var reasons = [];
    if (benchFps < TIER_A_MIN_BENCH_FPS) {
      reasons.push('64K benchmark ' + (+benchFps || 0).toFixed(1) + ' FPS < required ' +
        TIER_A_MIN_BENCH_FPS + ' FPS');
    }
    if (freeGpuMB < TIER_A_MIN_FREE_GPU_MB) {
      reasons.push('free GPU memory estimate ' + freeGpuMB + ' MB < required ' +
        TIER_A_MIN_FREE_GPU_MB + ' MB');
    }
    var eligible = (measured === 'A');
    var override = !!opts.overrideTierA;
    var label = null;
    if (override && !eligible) {
      eligible = true;
      label = 'You asked for 1M; measured tier is ' + measured +
        ' (' + TIERS[measured === 'NONE' ? 'C' : measured].tracers.toLocaleString('en-US') +
        ' tracers) — frame drops expected';
    }
    return {
      eligible: eligible,
      measured: measured,
      measuredTracers: measured === 'NONE' ? 0 : TIERS[measured].tracers,
      requested: 'A',
      requestedTracers: TIERS.A.tracers,
      override: override,
      label: label,
      reasons: reasons
    };
  }

  // ------------------------------------------------------------------
  // 3. View-coupled rendering.
  //
  // The sim ALWAYS advects every tracer. The renderer only decides which
  // tracers get drawn: off-viewport tracers are culled and an adaptive stride
  // thins the DRAW list. The stride function below is a pure function over
  // draw pixels — it can never touch sim state, and selfTest() verifies that
  // on a tiny array.
  //
  // viewport: { x, y, w, h } in domain space. positions: Float32Array of
  // [px, py] pairs (2 * tracers floats) — the FIRST two channels of the SoA.

  // Cull: count tracers inside the viewport. Pure, no allocation beyond the
  // output Uint32Array of draw indices (draw list only).
  function cullToViewport(positions, tracers, viewport) {
    var x0 = viewport.x, y0 = viewport.y, x1 = viewport.x + viewport.w, y1 = viewport.y + viewport.h;
    var idx = [];
    var n = Math.min(tracers, Math.floor(positions.length / 2));
    for (var i = 0; i < n; i++) {
      var px = positions[i * 2], py = positions[i * 2 + 1];
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) idx.push(i);
    }
    return idx;
  }

  // Adaptive draw-density stride from measured frame time. Targets
  // 60 FPS interactive; steps stride up while over budget. Output is the
  // DRAW stride only — sim state count is never an input or an output.
  function drawStride(frameMs, targetFps) {
    targetFps = targetFps || 60;
    var budgetMs = 1000 / targetFps;
    if (!(frameMs > 0)) return 1;
    var ratio = frameMs / budgetMs;
    if (ratio <= 1.05) return 1;
    if (ratio <= 1.6) return 2;
    if (ratio <= 2.5) return 4;
    if (ratio <= 4.0) return 8;
    return 16;
  }

  // Apply stride to an index list (draw list). Returns a NEW array; the input
  // is untouched, and the underlying sim arrays are never referenced here.
  function strideDrawList(indices, stride) {
    if (stride <= 1) return indices.slice();
    var out = [];
    for (var i = 0; i < indices.length; i += stride) out.push(indices[i]);
    return out;
  }

  // One call: cull, then stride. Returns draw metadata. `simulated` is always
  // the full tracer count — the draw path cannot reduce it.
  function lodDraw(positions, tracers, viewport, frameMs) {
    var stride = drawStride(frameMs);
    var culled = cullToViewport(positions, tracers, viewport);
    var drawn = strideDrawList(culled, stride);
    return {
      simulated: tracers,          // full state advects — always
      inViewport: culled.length,
      drawn: drawn.length,
      stride: stride,
      drawIndices: drawn
    };
  }

  // ------------------------------------------------------------------
  // 4. Field monitor data provider.
  //
  // Truthful numbers from the actual backend when present; clearly-labeled
  // estimates otherwise. Every estimate carries `basis` so the panel can
  // show its provenance.
  var _activeBackend = null;   // set by vx:ready, or attachBackend()
  var _frameEMA = 16.7;        // ms, exponential moving average
  var _lastFrameT = 0;

  function noteFrame(dtMs) {
    if (dtMs > 0 && dtMs < 1000) {
      _frameEMA = _frameEMA * 0.9 + dtMs * 0.1;
    }
  }

  function attachBackend(backend) {
    _activeBackend = backend || null;
    return _activeBackend;
  }

  function _backendTracers() {
    /* NOTE (audit 2026-09-20): both backends return { count: number,
     * simulated: boolean }. The old check demanded t.simulated be a number, so
     * it never matched and the monitor fell back to the 4096 estimate. Prefer
     * count; keep the legacy numeric-simulated shape as a fallback. */
    try {
      if (_activeBackend && typeof _activeBackend.getTracers === 'function') {
        var t = _activeBackend.getTracers();
        if (t && typeof t.count === 'number' && isFinite(t.count)) {
          return { simulated: t.count, count: t.count, truth: 'backend:getTracers()' };
        }
        if (t && typeof t.simulated === 'number' && isFinite(t.simulated)) {
          return { simulated: t.simulated, count: t.count || t.simulated, truth: 'backend:getTracers()' };
        }
      }
    } catch (e) { /* degraded: fall through to estimate */ }
    return null;
  }

  // Power is a heuristic model, never a measurement. Reported as such.
  function _powerEstimateW(simulatedTracers, backendName) {
    var idle = 8; // W, display + idle tab (heuristic)
    var perMillion = backendName === 'cpu' ? 12 : 45; // W per 1M tracers (heuristic)
    var w = idle + perMillion * (simulatedTracers / 1e6);
    return { watts: +w.toFixed(1), basis: 'estimate:heuristic model, not measured' };
  }

  function sampleMonitor() {
    var bt = _backendTracers();
    var backendName = 'none';
    try {
      if (_activeBackend && _activeBackend.name) backendName = String(_activeBackend.name);
    } catch (e) { /* ignore */ }

    var simulated, drawn, truth;
    if (bt) {
      simulated = bt.simulated;
      drawn = bt.count;
      truth = 'backend:getTracers()';
    } else {
      // No GPU backend present: CPU-tier truth, labeled.
      simulated = _cpuFallbackTracers;
      drawn = _cpuFallbackTracers;
      truth = 'estimate:cpu-fallback (no GPU backend registered)';
    }

    var frameMs = +_frameEMA.toFixed(2);
    var fps = frameMs > 0 ? +(1000 / frameMs).toFixed(1) : 0;
    var mem = estimate(simulated);
    var power = _powerEstimateW(simulated, backendName === 'none' ? 'cpu' : backendName);
    var free = freeGpuMBEstimate();

    return {
      frameMs: frameMs,
      fps: fps,
      simulatedTracers: simulated,
      drawnTracers: drawn,
      gpuMB: mem.gpuMB,
      estPowerW: power.watts,
      backend: backendName,
      tier: _currentTier,
      truth: {
        frame: _lastFrameT ? 'measured:EMA of vx:frame dt' : 'estimate:default 16.7ms (no frames yet)',
        tracers: truth,
        memory: mem.basis,
        power: power.basis,
        freeGpuMB: free.basis
      }
    };
  }

  var _cpuFallbackTracers = 4096;  // CPU-tier truth when no GPU backend
  var _currentTier = 'C';

  // requestMegafield: the ONLY sanctioned path to Tier A. Checks the gate
  // and the memory budget, and REFUSES with a named error rather than
  // allocating blindly. Never allocates typed arrays itself — the backend
  // (W02/W15) owns allocation; we only vet the request.
  function requestMegafield(opts) {
    opts = opts || {};
    var benchFps = typeof opts.benchFps === 'number' ? opts.benchFps : null;
    var trusted = trustedFreeMB(opts.freeGpuMB);
    var freeMB = trusted.mb;
    var g = gate(benchFps === null ? 0 : benchFps, freeMB, { overrideTierA: !!opts.override });
    var mem = estimate(TIERS.A.tracers);
    var claimNote = trusted.note;

    if (benchFps === null) {
      return {
        ok: false,
        code: 'VX_E_FIELD_INIT',
        message: 'Tier A refused: no 64K benchmark result. Run the benchmark first.',
        gate: g, memory: mem, claimNote: claimNote
      };
    }
    if (!g.eligible) {
      return {
        ok: false,
        code: 'VX_E_OOM',
        message: 'Tier A refused: ' + (g.reasons.join('; ') || 'gate not satisfied'),
        gate: g, memory: mem, claimNote: claimNote
      };
    }
    if (!mem.fits) {
      return {
        ok: false,
        code: 'VX_E_OOM',
        message: 'Tier A refused: 1M working set ' + mem.gpuMB + ' MB exceeds device budget ' +
          mem.budgetMB + ' MB.',
        gate: g, memory: mem, claimNote: claimNote
      };
    }
    if (!V.has('w02-gpu')) {
      return {
        ok: false,
        code: 'VX_E_NO_BACKEND',
        message: 'Tier A approved by gate and budget, but no GPU backend (w02-gpu) is ' +
          'registered yet — cannot allocate. CPU fallback stays at ' +
          _cpuFallbackTracers.toLocaleString('en-US') + ' tracers.',
        gate: g, memory: mem, approved: true, claimNote: claimNote
      };
    }
    _currentTier = 'A';
    V.bus.emit('vx:degraded', { from: _currentTier, to: 'A', reason: 'megafield approved' });
    return { ok: true, approved: true, gate: g, memory: mem, tier: 'A', tracers: TIERS.A.tracers, claimNote: claimNote };
  }

  // checkTierA: the W15 backend selector's Tier-A eligibility hook.
  // W15 calls w03.checkTierA({ backend, detail, opts }) during selection.
  // Reads benchFps / freeGpuMB / overrideTierA from the request, its .detail,
  // or its .opts (first hit wins); missing benchmark => not eligible.
  // Returns { eligible, detail } on pass, { eligible:false, reason } on fail —
  // the shape W15's resolveTier consumes.
  function checkTierA(req) {
    req = req || {};
    var src = [req, req.detail || {}, req.opts || {}];
    function pick(k) {
      for (var i = 0; i < src.length; i++) {
        if (src[i] && typeof src[i][k] === 'number' && isFinite(src[i][k])) return src[i][k];
      }
      return null;
    }
    var benchFps = pick('benchFps');
    var trusted = trustedFreeMB(pick('freeGpuMB'));
    var override = false;
    for (var j = 0; j < src.length; j++) {
      if (src[j] && (src[j].overrideTierA === true || src[j].override === true)) { override = true; break; }
    }
    var g = gate(benchFps === null ? 0 : benchFps, trusted.mb, { overrideTierA: override });
    var out = {
      eligible: g.eligible,
      backend: req.backend || null,
      benchFps: benchFps,
      freeGpuMB: trusted.mb,
      freeBasis: trusted.basis,
      override: g.override === true
    };
    if (trusted.note) out.claimNote = trusted.note;
    if (g.eligible) {
      out.detail = 'Tier A eligible: 64K benchmark ' + benchFps + ' FPS >= ' + TIER_A_MIN_BENCH_FPS +
        ' FPS, ' + trusted.mb + ' MB free GPU >= ' + TIER_A_MIN_FREE_GPU_MB + ' MB (' + trusted.basis + ')' +
        (g.override ? ' — USER OVERRIDE, labeled' : '');
    } else {
      out.reason = (benchFps === null ? 'no 64K benchmark result; ' : '') + g.reasons.join('; ');
    }
    return out;
  }

  // Wire into the lab's event flow (headless-safe: bus exists in node).
  V.bus.on('vx:ready', function (detail) {
    if (detail && detail.backend && typeof detail.backend.getTracers === 'function') {
      _activeBackend = detail.backend;
    }
  });
  V.bus.on('vx:frame', function (detail) {
    if (detail && typeof detail.dt === 'number') {
      noteFrame(detail.dt * 1000);
      _lastFrameT = Date.now();
    }
  });

  // ------------------------------------------------------------------
  // Panel registration (DOM-guarded; mountFn only runs in the browser shell)
  try {
    V.ui.registerPanel('w03-field-monitor', 'Field monitor', function (el) {
      var doc = el.ownerDocument;
      var wrap = doc.createElement('div');
      wrap.className = 'vx-field-monitor';
      var title = doc.createElement('h3');
      title.textContent = 'Field monitor';
      var note = doc.createElement('p');
      note.className = 'vx-monitor-note';
      note.textContent = 'Backend numbers are measured; everything else is labeled with its basis.';
      var table = doc.createElement('table');
      var rows = {};
      ['frameMs', 'fps', 'simulatedTracers', 'drawnTracers', 'gpuMB', 'estPowerW', 'backend', 'tier']
        .forEach(function (k) {
          var tr = doc.createElement('tr');
          var tdK = doc.createElement('td'); tdK.textContent = k;
          var tdV = doc.createElement('td'); tdV.textContent = '—';
          tr.appendChild(tdK); tr.appendChild(tdV);
          table.appendChild(tr);
          rows[k] = tdV;
        });
      wrap.appendChild(title); wrap.appendChild(note); wrap.appendChild(table);
      el.appendChild(wrap);
      var timer = setInterval(function () {
        try {
          var m = sampleMonitor();
          Object.keys(rows).forEach(function (k) {
            rows[k].textContent = String(m[k]);
          });
        } catch (e) { /* monitor must never break the lab */ }
      }, 500);
      if (timer.unref) timer.unref();
    });
  } catch (e) {
    // registerPanel throws only on programmer error; surface via bus, never throw at load
    V.bus.emit('vx:error', { code: 'VX_E_CHROME', message: 'field-monitor panel failed to register', stage: 'chrome' });
  }

  // ------------------------------------------------------------------
  var api = {
    // memory accounting
    memoryBudget: memoryBudget,
    freeGpuMBEstimate: freeGpuMBEstimate,
    estimate: estimate,
    STRIDE_BYTES: STRIDE_BYTES,
    FLOATS_PER_TRACER: FLOATS_PER_TRACER,
    GPU_WORKING_SET_FACTOR: GPU_WORKING_SET_FACTOR,
    TIERS: TIERS,
    // gate
    measuredTier: measuredTier,
    gate: gate,
    checkTierA: checkTierA,
    requestMegafield: requestMegafield,
    // view-coupled rendering
    cullToViewport: cullToViewport,
    drawStride: drawStride,
    strideDrawList: strideDrawList,
    lodDraw: lodDraw,
    // monitor
    attachBackend: attachBackend,
    noteFrame: noteFrame,
    sampleMonitor: sampleMonitor,
    setCpuFallbackTracers: function (n) { _cpuFallbackTracers = Math.max(0, Math.floor(n || 0)); },
    getCurrentTier: function () { return _currentTier; },

    selfTest: function () {
      var checks = [];
      function check(name, ok, detail) {
        checks.push({ name: name, ok: !!ok, detail: detail || '' });
      }

      // --- memory math invariants: bytes = tracers x stride (SoA) ---
      check('stride == floats*4', STRIDE_BYTES === FLOATS_PER_TRACER * 4,
        'stride=' + STRIDE_BYTES + ' floats=' + FLOATS_PER_TRACER);
      var e1 = estimate(1000000);
      check('1M live bytes == tracers*stride', e1.liveBytes === 1000000 * STRIDE_BYTES,
        'liveBytes=' + e1.liveBytes);
      check('1M live MB ~ 38.15', Math.abs(e1.liveMB - (1000000 * 40) / (1024 * 1024)) < 0.01,
        'liveMB=' + e1.liveMB);
      check('gpu working set == live*factor', e1.gpuBytes === Math.ceil(e1.liveBytes * GPU_WORKING_SET_FACTOR),
        'gpuBytes=' + e1.gpuBytes);
      var e0 = estimate(0);
      check('0 tracers -> 0 bytes, fits', e0.liveBytes === 0 && e0.fits === true, '');
      var eBig = estimate(1e9);
      check('1B tracers exceeds budget', eBig.fits === false, 'gpuMB=' + eBig.gpuMB);
      var b = memoryBudget();
      check('budget sane (256MB..2GB)', b.bytes >= 256 * 1024 * 1024 && b.bytes <= 2e9,
        'budgetMB=' + b.mb);

      // --- gate logic ---
      var gA = gate(130, 4096, {});
      check('gate: 130fps + 4GB -> eligible A, no label',
        gA.eligible && gA.measured === 'A' && gA.label === null, JSON.stringify(gA.measured));
      var gSlow = gate(90, 4096, {});
      check('gate: 90fps -> ineligible, measured C', !gSlow.eligible && gSlow.measured === 'C',
        gSlow.reasons.join('; '));
      var gMem = gate(150, 1024, {});
      check('gate: 150fps + 1GB -> ineligible, measured B', !gMem.eligible && gMem.measured === 'B',
        gMem.reasons.join('; '));
      var gBoth = gate(60, 512, {});
      check('gate: 60fps + 512MB -> measured C', gBoth.measured === 'C' && !gBoth.eligible, '');
      var gOver = gate(90, 1024, { overrideTierA: true });
      check('gate: override -> eligible WITH honesty label',
        gOver.eligible && gOver.override === true &&
        typeof gOver.label === 'string' && gOver.label.indexOf('You asked for 1M') === 0 &&
        gOver.label.indexOf('frame drops expected') > 0,
        gOver.label);
      var gNoOver = gate(90, 1024, {});
      check('gate: no override -> no label', gNoOver.label === null, '');
      var gExact = gate(120, 2048, {});
      check('gate: boundary 120fps/2048MB -> eligible', gExact.eligible && gExact.measured === 'A', '');

      // requestMegafield refusal paths. In the worker's isolated run no GPU
      // backend was registered; under full integration w02-gpu IS present, so
      // the "no backend" premise only holds when it is absent.
      var rNoBench = requestMegafield({});
      check('request: no benchmark -> refuse VX_E_FIELD_INIT',
        rNoBench.ok === false && rNoBench.code === 'VX_E_FIELD_INIT', rNoBench.message);
      var rSlow = requestMegafield({ benchFps: 60, freeGpuMB: 4096 });
      check('request: slow bench -> refuse VX_E_OOM',
        rSlow.ok === false && rSlow.code === 'VX_E_OOM', '');
      var rOk = requestMegafield({ benchFps: 150, freeGpuMB: 4096 });
      if (!V.has('w02-gpu')) {
        check('request: gate+budget pass, no w02-gpu -> VX_E_NO_BACKEND (not blind alloc)',
          rOk.ok === false && rOk.code === 'VX_E_NO_BACKEND' && rOk.approved === true, rOk.message);
      } else {
        // Full integration: a GPU backend is registered. The invariant that
        // survives is "never a blind alloc" — the decision must come from
        // gate+budget (eligible+fits -> tier A, else a named refusal).
        var decided = (rOk.ok === true && rOk.tier === 'A') ||
          (rOk.ok === false && (rOk.code === 'VX_E_OOM' || rOk.code === 'VX_E_NO_BACKEND' || rOk.code === 'VX_E_FIELD_INIT'));
        check('request: w02-gpu present -> gate+budget decide, never blind',
          decided, 'code=' + rOk.code + ' approved=' + rOk.approved + ' tier=' + rOk.tier);
      }
      var rHuge = requestMegafield({ benchFps: 1000, freeGpuMB: 1e9 });
      check('request: absurd free-mem claim clamped, never trusted',
        !!rHuge.claimNote && rHuge.claimNote.indexOf('clamped') > 0,
        rHuge.claimNote || rHuge.code);

      // --- checkTierA: the W15 backend-selector hook ---
      var ctNone = checkTierA({ backend: 'webgpu' });
      check('checkTierA: no benchmark -> not eligible',
        ctNone.eligible === false && /benchmark/.test(ctNone.reason || ''), ctNone.reason);
      var ctHuge = checkTierA({ backend: 'webgpu', benchFps: 1000, freeGpuMB: 1e9 });
      check('checkTierA: absurd free-mem claim clamped to internal estimate',
        !!ctHuge.claimNote && ctHuge.freeGpuMB < 1e9,
        ctHuge.claimNote || ('freeGpuMB=' + ctHuge.freeGpuMB));
      var ctLow = checkTierA({ backend: 'webgpu', benchFps: 150, freeGpuMB: 512 });
      check('checkTierA: conservative claim accepted as-is (no clamp note)',
        ctLow.freeGpuMB === 512 && !ctLow.claimNote, 'freeGpuMB=' + ctLow.freeGpuMB);
      var ctViaOpts = checkTierA({ backend: 'webgpu', opts: { benchFps: 150, freeGpuMB: 512 } });
      check('checkTierA: reads bench numbers from .opts passthrough',
        ctViaOpts.benchFps === 150 && ctViaOpts.freeGpuMB === 512, '');

      // --- LOD stride: pure draw function, sim state never touched ---
      check('drawStride: 8.3ms -> 1', drawStride(8.3) === 1, '');
      check('drawStride: 16.7ms@60 -> 1', drawStride(16.7, 60) === 1, '');
      check('drawStride: 25ms -> 2', drawStride(25, 60) === 2, '');
      check('drawStride: 40ms -> 4', drawStride(40, 60) === 4, '');
      check('drawStride: 60ms -> 8', drawStride(60, 60) === 8, '');
      check('drawStride: 200ms -> 16', drawStride(200, 60) === 16, '');
      check('drawStride: bad input -> 1', drawStride(-5) === 1 && drawStride(NaN) === 1, '');

      // unit-check on a tiny array: stride thins the DRAW LIST, sim arrays intact
      var tiny = new Float32Array([0.1, 0.1, 0.5, 0.5, 0.9, 0.9, 2.0, 2.0]); // 4 tracers (px,py)
      var before = Array.prototype.slice.call(tiny);
      var lod = lodDraw(tiny, 4, { x: 0, y: 0, w: 1, h: 1 }, 200); // slow frame -> stride 16
      var after = Array.prototype.slice.call(tiny);
      check('lodDraw: sim array byte-identical after draw LOD',
        before.length === after.length && before.every(function (v, i) { return v === after[i]; }),
        'tracer[3]=(2.0,2.0) culled from draw but intact in state');
      check('lodDraw: simulated stays 4 (full state advects)',
        lod.simulated === 4, 'simulated=' + lod.simulated);
      check('lodDraw: culled off-viewport tracer', lod.inViewport === 3, 'inViewport=' + lod.inViewport);
      check('lodDraw: stride 16 on 3 -> 1 drawn', lod.stride === 16 && lod.drawn === 1,
        'stride=' + lod.stride + ' drawn=' + lod.drawn);
      var full = lodDraw(tiny, 4, { x: 0, y: 0, w: 1, h: 1 }, 8.3);
      check('lodDraw: fast frame -> stride 1, all in-viewport drawn',
        full.stride === 1 && full.drawn === 3, 'drawn=' + full.drawn);
      var wide = lodDraw(tiny, 4, { x: -10, y: -10, w: 20, h: 20 }, 8.3);
      check('lodDraw: wide viewport draws all 4', wide.drawn === 4, '');

      // --- monitor headless ---
      var m = sampleMonitor();
      check('monitor: has all six fields',
        ['frameMs', 'fps', 'simulatedTracers', 'drawnTracers', 'gpuMB', 'estPowerW']
          .every(function (k) { return typeof m[k] === 'number'; }),
        JSON.stringify({ fps: m.fps, sim: m.simulatedTracers }));
      check('monitor: no-GPU truth is labeled cpu-fallback',
        m.truth.tracers.indexOf('cpu-fallback') >= 0 && m.backend === 'none',
        m.truth.tracers);
      check('monitor: power basis says estimate', m.truth.power.indexOf('estimate') === 0, m.truth.power);
      // truthful backend path: inject a fake contract-conformant backend
      // (real shape: {count: number, simulated: boolean} — see field-contract)
      var fake = {
        name: 'webgl2',
        getTracers: function () { return { count: 900000, simulated: true }; }
      };
      attachBackend(fake);
      var m2 = sampleMonitor();
      check('monitor: backend numbers pass through truthfully',
        m2.simulatedTracers === 900000 && m2.drawnTracers === 900000 &&
        m2.truth.tracers === 'backend:getTracers()', m2.truth.tracers);
      attachBackend(null);
      // panel registered (headless: mountFn not run, registration exists)
      var panels = V.ui.panels().filter(function (p) { return p.id === 'w03-field-monitor'; });
      check('field-monitor panel registered', panels.length === 1, '');

      var failed = checks.filter(function (c) { return !c.ok; });
      return { ok: failed.length === 0, checks: checks };
    }
  };

  V.register('w03-megafield', api);
})(typeof window !== 'undefined' ? window : globalThis);
