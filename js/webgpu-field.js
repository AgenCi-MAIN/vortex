/* webgpu-field.js — W15
 * =====================================================================
 * HONEST SCOPE (lane-14 recall-and-implement, 2026-09-20).
 *
 *   REAL (implemented, tested):
 *     - Capability detection:  navigator.gpu exists?
 *       → request high-performance adapter (timeout-guarded)
 *       → adapter exposes the 'timestamp-query' feature?
 *     - Warm-up probe: a REAL, minimal WebGPU compute dispatch —
 *       device → compute shader (4096 threads, pure arithmetic, NO fluid
 *       math) → buffer readback → value verification → full teardown.
 *       It proves the GPU pipeline works end-to-end. Nothing more.
 *     - Reason codes for every failure step, so the selector can narrate
 *       the step-down instead of guessing.
 *
 *   STUB (deliberately not implemented):
 *     - The full WebGPU FLUID SOLVER behind the VORTEX field contract
 *       (init/step/render/advection). This file is the SEAM for it: when a
 *       future worker (or a machine with a real implementation) provides
 *       the solver, it plugs in here — api.init() is the entry point.
 *       Until then api.init() REFUSES with a named error instead of
 *       faking frames, and api.canSimulate() returns false, asserted by
 *       selfTest().
 *
 *   Nothing here claims to simulate. Do not wire a "simulation" off the
 *   warm-up probe — the probe computes i*1.5+0.25 on 4096 floats, not a
 *   vortex field.
 *
 * Plain browser JS, IIFE, no modules, no build step, runs from file://.
 * No fetch / XHR / WebSocket / eval. Headless-safe (node): detection
 * simply reports 'no-navigator-gpu'.
 * =====================================================================
 */
(function (root) {
  'use strict';
  var V = root.VORTEX;

  // ---- failure reason codes (public, so the selector can narrate) ----
  var REASON_DETAIL = {
    'ok': 'WebGPU adapter + timestamp queries + warm-up compute dispatch all verified',
    'no-navigator-gpu': 'navigator.gpu is undefined — no WebGPU implementation exposed by this browser',
    'adapter-timeout': 'requestAdapter() did not resolve within 4s',
    'no-adapter': 'requestAdapter() resolved to null — no compatible GPU adapter',
    'adapter-exception': 'requestAdapter() threw',
    'no-timestamp-queries': "adapter lacks the 'timestamp-query' feature (required for frame timing)",
    'device-exception': 'adapter.requestDevice() threw',
    'warmup-timeout': 'warm-up compute dispatch did not complete within 6s',
    'warmup-exception': 'warm-up compute dispatch threw',
    'warmup-mismatch': 'warm-up compute dispatch completed but readback values were wrong',
    'no-webgpu-globals': 'WebGPU entry points (GPUBufferUsage/GPUMapMode) not exposed alongside navigator.gpu'
  };

  var WARMUP_THREADS = 4096; // fixed: this is a pipeline proof, not a workload

  function rejectAfter(ms, err) {
    return new Promise(function (_, rej) {
      setTimeout(function () { rej(err); }, ms);
    });
  }

  function mkResult(over) {
    var r = {
      supported: false,
      reason: 'no-navigator-gpu',
      detail: REASON_DETAIL['no-navigator-gpu'],
      timestampQueries: false,
      adapterInfo: null,
      warmup: null,
      probeAt: Date.now()
    };
    if (over) for (var k in over) r[k] = over[k];
    return r;
  }

  // ---- warm-up probe: minimal REAL compute dispatch, verified readback ----
  function warmupProbe(adapter) {
    var GB = root.GPUBufferUsage;
    var GM = root.GPUMapMode;
    if (!GB || !GM) return Promise.reject(new Error(REASON_DETAIL['no-webgpu-globals']));

    var code = '@group(0) @binding(0) var<storage, read_write> out : array<f32>;\n' +
      '@compute @workgroup_size(64)\n' +
      'fn main(@builtin(global_invocation_id) gid : vec3<u32>) {\n' +
      '  out[gid.x] = f32(gid.x) * 1.5 + 0.25;\n' +
      '}\n';

    return Promise.race([
      (async function () {
        var device;
        try {
          device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] });
        } catch (e) {
          throw new Error(REASON_DETAIL['device-exception'] + ' — ' + (e && e.message));
        }
        try {
          var N = WARMUP_THREADS;
          var shader = device.createShaderModule({ code: code, label: 'w15-warmup' });
          var storage = device.createBuffer({
            size: N * 4,
            usage: GB.STORAGE | GB.COPY_SRC,
            label: 'w15-warmup-storage'
          });
          var readback = device.createBuffer({
            size: N * 4,
            usage: GB.COPY_DST | GB.MAP_READ,
            label: 'w15-warmup-readback'
          });
          var pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: shader, entryPoint: 'main' },
            label: 'w15-warmup-pipeline'
          });
          var bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: storage } }]
          });
          var enc = device.createCommandEncoder({ label: 'w15-warmup-enc' });
          var pass = enc.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(N / 64);
          pass.end();
          enc.copyBufferToBuffer(storage, 0, readback, 0, N * 4);
          device.queue.submit([enc.finish()]);
          await readback.mapAsync(GM.READ);
          var arr = new Float32Array(readback.getMappedRange().slice(0));
          readback.unmap();

          // verify a strided sample of the readback — wrong values = lying driver
          var ok = true, badAt = -1;
          for (var i = 0; i < N; i += 97) {
            var expected = i * 1.5 + 0.25;
            if (Math.abs(arr[i] - expected) > 1e-3) { ok = false; badAt = i; break; }
          }
          storage.destroy();
          readback.destroy();
          device.destroy();
          if (!ok) throw new Error(REASON_DETAIL['warmup-mismatch'] + ' (first bad index ' + badAt + ')');
          return { ok: true, threads: N, verified: true };
        } catch (e) {
          try { device.destroy(); } catch (_) {}
          throw e;
        }
      })(),
      rejectAfter(6000, new Error(REASON_DETAIL['warmup-timeout']))
    ]);
  }

  // ---- public detection: navigator.gpu → adapter → timestamp queries → warm-up ----
  function detect(opts) {
    opts = opts || {};
    var wantWarmup = opts.warmup !== false;

    var nav = root.navigator;
    if (!nav || !nav.gpu) {
      return Promise.resolve(mkResult({ reason: 'no-navigator-gpu' }));
    }

    return Promise.race([
      (async function () {
        var adapter;
        try {
          adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
        } catch (e) {
          return mkResult({ reason: 'adapter-exception', detail: REASON_DETAIL['adapter-exception'] + ' — ' + (e && e.message) });
        }
        if (!adapter) {
          return mkResult({ reason: 'no-adapter' });
        }
        var info = null;
        try {
          var ai = adapter.info || null;
          info = ai ? {
            vendor: ai.vendor || null,
            architecture: ai.architecture || null,
            device: ai.device || null,
            description: ai.description || null
          } : null;
        } catch (_) {}
        var hasTS = false;
        try { hasTS = adapter.features.has('timestamp-query'); } catch (_) {}
        if (!hasTS) {
          return mkResult({
            reason: 'no-timestamp-queries',
            detail: REASON_DETAIL['no-timestamp-queries'],
            timestampQueries: false,
            adapterInfo: info
          });
        }
        if (!wantWarmup) {
          // quick probe (selector fast path): adapter + features verified, dispatch not run
          return mkResult({
            supported: true,
            reason: 'ok',
            detail: 'WebGPU adapter + timestamp queries verified (warm-up dispatch skipped: quick mode)',
            timestampQueries: true,
            adapterInfo: info,
            warmup: null
          });
        }
        try {
          var w = await warmupProbe(adapter);
          return mkResult({
            supported: true,
            reason: 'ok',
            detail: REASON_DETAIL['ok'],
            timestampQueries: true,
            adapterInfo: info,
            warmup: w
          });
        } catch (e) {
          var msg = (e && e.message) || String(e);
          var reason = msg.indexOf('timed out') !== -1 ? 'warmup-timeout'
            : msg.indexOf('readback values were wrong') !== -1 ? 'warmup-mismatch'
            : 'warmup-exception';
          return mkResult({
            reason: reason,
            detail: msg,
            timestampQueries: true,
            adapterInfo: info
          });
        }
      })(),
      rejectAfter(4000, mkResult({ reason: 'adapter-timeout' }))
    ]).catch(function (e) {
      // the 4s race rejects with a result object already; anything else is an exception
      if (e && typeof e === 'object' && e.reason) return e;
      return mkResult({ reason: 'adapter-exception', detail: REASON_DETAIL['adapter-exception'] + ' — ' + String(e && e.message || e) });
    });
  }

  var api = {
    // Seams for a future real solver. Until one plugs in, these refuse honestly.
    name: 'webgpu',
    simulates: false, // THE invariant: this module never claims to simulate
    canSimulate: function () { return false; },
    detect: detect,
    reasonDetail: function (reason) { return REASON_DETAIL[reason] || 'unknown reason'; },

    // Field-contract seam: a real solver would return a backend here.
    // The stub REFUSES — named error, never fake frames.
    init: function (/* canvas, opts */) {
      return Promise.reject(V.VortexError(
        'VX_E_FIELD_INIT',
        'WebGPU fluid solver is a documented lane-14 stub: this module proves the GPU path ' +
        '(adapter + compute dispatch + readback) but does not simulate fluid. Use CPU/WebGL2, ' +
        'or plug a real solver behind this seam.',
        'backend-probe',
        'WebGPU detection + warm-up probe results retained'
      ));
    },

    selfTest: function () {
      var checks = [];
      function add(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: String(detail) }); }
      return Promise.resolve(detect({ warmup: false })).then(function (r) {
        add('detect-resolves', r && typeof r.supported === 'boolean',
          'detect() resolved with supported=' + (r && r.supported) + ', reason=' + (r && r.reason));
        add('reason-known', !!(r && REASON_DETAIL[r.reason]),
          'reason "' + (r && r.reason) + '" has a documented detail string');
        add('honest-scope', api.canSimulate() === false && api.simulates === false,
          'module does NOT claim simulation capability (canSimulate()===false)');
        return api.init(null, {}).then(
          function () {
            add('init-refuses', false, 'init() RESOLVED — this must never happen for the stub');
            return finish();
          },
          function (e) {
            add('init-refuses', e && e.code === 'VX_E_FIELD_INIT',
              'init() rejects with VX_E_FIELD_INIT, not fake frames');
            return finish();
          }
        );
        function finish() {
          var ok = checks.every(function (c) { return c.ok; });
          return { ok: ok, checks: checks };
        }
      }).catch(function (e) {
        return { ok: false, checks: [{ name: 'selftest-threw', ok: false, detail: String(e && e.message || e) }] };
      });
    }
  };

  V.register('w15-webgpu', api);
})(typeof window !== 'undefined' ? window : globalThis);
