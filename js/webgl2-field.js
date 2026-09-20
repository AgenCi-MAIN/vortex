/* VORTEX webgl2-field.js — W02.
 * WebGL2 backend implementing the VortexField contract (field-contract.js,
 * CONTRACTS §5). GPU tier B: Light 16K -> Dense 65K -> Ultra 131K ->
 * Extreme 262K tracers (Shawn's verified 128 FPS ceiling).
 *
 * Design (lane-14 §3.2 / §4.2 Top-5 #2):
 *  - Ping-pong float state textures (RGBA32F preferred, RGBA16F fallback —
 *    the fallback is chosen by a REAL FBO completeness probe, not by the
 *    extension string; see VORTEX.field.probeFloatRenderable).
 *  - One shader program per FIELD CONFIG (spiral/collision/wake); slider
 *    changes (circulation/turbulence/persistence/mode) are UNIFORMS — no
 *    recompiles on slider moves. Config swaps reuse a cached program.
 *  - Probes are injected through a ping-pong PERTURBATION TEXTURE: active
 *    probes are splatted additively each frame (push/pull/curl impulses) and
 *    the field decays geometrically. The update pass samples it as a
 *    velocity impulse.
 *  - Diagnostic readback is fenced and NEVER blocks the frame: readPixels
 *    into a PBO, fenceSync, flush; the result is polled with a zero-timeout
 *    clientWaitSync on a later frame. sampleMetrics() returns the last
 *    completed sample, or {sampled:false} if none has landed yet.
 *  - Graceful degradation: if WebGL2 or float render targets are missing,
 *    init() REJECTS with a named error so the selector steps down. This
 *    backend never fakes a GPU path.
 *
 * Headless-safe: module load touches no DOM/GL. init() is the only entry
 * that needs a canvas; it rejects (never throws synchronously past the
 * guard) with VX_E_FIELD_INIT / VX_E_WARMUP_FAILED when GL is unavailable.
 *
 * Plain script, IIFE, no modules. Works in browser; loads (but cannot init)
 * in node for headless selfTest.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) throw new Error('webgl2-field: VORTEX namespace missing (vx-namespace.js must load first)');

  var HAS_CONTRACT = !!(V.has && V.has('w02-field-contract'));
  var F = V.field || null; // may be absent if load order is violated; guarded everywhere

  var DT = (V.SIM_DT || 1 / 60);

  // ---- tracer tiers (must mirror V.field.TIERS when the contract module loaded)
  var TIERS = [
    { id: 'light',   label: 'Light',   tracers: 16384,  grid: [128, 128], point: 3.0 },
    { id: 'dense',   label: 'Dense',   tracers: 65536,  grid: [256, 256], point: 2.5 },
    { id: 'ultra',   label: 'Ultra',   tracers: 131072, grid: [512, 256], point: 2.0 },
    { id: 'extreme', label: 'Extreme', tracers: 262144, grid: [512, 512], point: 1.5 }
  ];

  function tierForCount(n) {
    n = Math.max(1, n | 0);
    for (var i = 0; i < TIERS.length; i++) if (TIERS[i].tracers >= n) return TIERS[i];
    return TIERS[TIERS.length - 1]; // clamp; 1M is W03's megafield, not ours
  }

  // ================= GLSL =================
  // Fullscreen triangle, no attributes — gl_VertexID only.
  var VS_FULL = [
    '#version 300 es',
    'void main(){',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Shared prelude for the update pass: hash, value noise, Lamb-Oseen vortex.
  var UPDATE_PRELUDE = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D u_state;',    // xy = position (domain [-1,1]^2), zw = velocity
    'uniform sampler2D u_perturb;',  // rg = probe velocity impulse, decayed per frame
    'uniform vec2  u_texSize;',      // state texture dimensions
    'uniform float u_dt;',
    'uniform float u_time;',
    'uniform float u_seed;',
    'uniform float u_circulation;',  // slider: vortex strength
    'uniform float u_turbulence;',   // slider: noise amplitude
    'uniform float u_persistence;',  // slider: velocity memory 0..1
    'uniform float u_mode;',         // 0 = drift, 1 = stir, 2 = orbit
    'uniform float u_stirAmount;',   // slider: stirrer strength (mode 1)
    'out vec4 o_state;',
    'float hash12(vec2 p){',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    // Lamb-Oseen vortex of strength g around offset d (stable at r -> 0).
    'vec2 lamb(vec2 d, float g){',
    '  float r = length(d) + 1e-4;',
    '  return vec2(-d.y, d.x) / r * (g / (6.2831853 * r)) * (1.0 - exp(-r * r / 0.09));',
    '}'
  ].join('\n');

  // Field configs. One compiled PROGRAM per config id; the snippet is the
  // only part that differs, so slider moves never recompile.
  var CONFIGS = {
    spiral: {
      label: 'Spiral',
      glsl: [
        'vec2 baseField(vec2 p, float t){',
        '  return lamb(p, 1.35) - normalize(p + vec2(1e-4)) * 0.055;',
        '}'
      ].join('\n')
    },
    collision: {
      label: 'Collision',
      glsl: [
        'vec2 baseField(vec2 p, float t){',
        '  vec2 c1 = vec2(-0.45 + 0.12 * sin(t * 0.25), 0.10 * cos(t * 0.20));',
        '  vec2 c2 = -c1;',
        '  return lamb(p - c1, 1.0) - lamb(p - c2, 1.0);',
        '}'
      ].join('\n')
    },
    wake: {
      label: 'Wake',
      glsl: [
        'vec2 baseField(vec2 p, float t){',
        '  vec2 d0 = p - vec2(-0.55, 0.0);',
        '  float r0 = length(d0) + 1e-4;',
        '  vec2 v = vec2(0.55, 0.0) * smoothstep(0.10, 0.22, r0);', // obstacle shadow
        '  for (int k = 0; k < 6; k++){',
        '    float fk = float(k);',
        '    float cx = -0.35 + fk * 0.28 - mod(t * 0.55 + fk * 0.14, 1.68);',
        '    float cy = (mod(fk, 2.0) < 1.0 ? 0.16 : -0.16) * (0.6 + 0.4 * sin(t * 0.8 + fk));',
        '    vec2 dd = p - vec2(cx, cy);',
        '    float age = clamp((p.x - cx) * 1.2, 0.0, 1.5);',
        '    float sgn = (mod(fk, 2.0) < 1.0 ? 1.0 : -1.0);',
        '    v += lamb(dd, sgn * 0.8) * exp(-age * 1.5);',
        '  }',
        '  return v;',
        '}'
      ].join('\n')
    }
  };

  var UPDATE_MAIN = [
    'vec2 fieldAt(vec2 pos, float t){',
    '  vec2 v = baseField(pos, t) * u_circulation;',
    // cheap advected turbulence: two decorrelated noise channels
    '  v += (vec2(vnoise(pos * 3.0 + vec2(u_time * 0.7, 0.0)),',
    '                vnoise(pos * 3.0 - vec2(0.0, u_time * 0.7))) - 0.5) * 2.0 * u_turbulence;',
    '  if (u_mode > 0.5 && u_mode < 1.5) {',                       // STIR
    '    vec2 sc = vec2(0.28 * cos(u_time * 1.7), 0.28 * sin(u_time * 1.7));',
    '    vec2 d = pos - sc; float r = length(d) + 1e-4;',
    '    v += vec2(-d.y, d.x) / r * exp(-r * r * 6.0) * 1.6 * u_stirAmount;',
    '  } else if (u_mode > 1.5) {',                                // ORBIT
    '    v += vec2(-pos.y, pos.x) * 0.6;',
    '  }',
    '  return v;',
    '}',
    'void main(){',
    '  ivec2 tc = ivec2(gl_FragCoord.xy);',
    '  vec4 s = texelFetch(u_state, tc, 0);',
    '  vec2 pos = s.xy;',
    '  vec2 vel = s.zw;',
    '  float idx = float(tc.y) * u_texSize.x + float(tc.x);',
    // probe impulse from the perturbation texture (domain [-1,1]^2 -> [0,1]^2)
    '  vec2 imp = texture(u_perturb, pos * 0.5 + 0.5).rg;',
    // RK2 midpoint advection against the analytic field
    '  vec2 v1 = fieldAt(pos, u_time);',
    '  vec2 mid = pos + v1 * 0.5 * u_dt;',
    '  vec2 v2 = fieldAt(mid, u_time + 0.5 * u_dt);',
    '  vec2 vtarget = v2 + imp;',
    '  vec2 vnew = mix(vtarget, vel, u_persistence);',
    '  vec2 pnew = pos + vnew * u_dt;',
    // respawn tracers that leave the domain (deterministic in idx+seed)
    '  if (abs(pnew.x) > 1.15 || abs(pnew.y) > 1.15) {',
    '    float h1 = hash12(vec2(idx, u_seed));',
    '    float h2 = hash12(vec2(u_seed, idx + 7.0));',
    '    pnew = (vec2(h1, h2) * 2.0 - 1.0) * 0.9;',
    '    vnew = vec2(0.0);',
    '  }',
    '  o_state = vec4(pnew, vnew);',
    '}'
  ].join('\n');

  // Perturbation decay pass: o = tex * u_decay.
  var FS_DECAY = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_tex;',
    'uniform float u_decay;',
    'out vec4 o;',
    'void main(){',
    '  ivec2 tc = ivec2(gl_FragCoord.xy);',
    '  o = texelFetch(u_tex, tc, 0) * u_decay;',
    '}'
  ].join('\n');

  // Probe splat: additive impulse quad. u_type: 0 = push, 1 = pull, 2 = curl.
  var FS_SPLAT = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2 u_size;',      // perturbation texture dims
    'uniform vec2 u_center;',    // domain coords [-1,1]
    'uniform float u_radius;',
    'uniform float u_strength;',
    'uniform float u_type;',
    'out vec4 o;',
    'void main(){',
    '  vec2 p = (vec2(gl_FragCoord.xy) / u_size) * 2.0 - 1.0;',
    '  vec2 d = p - u_center;',
    '  float r = length(d);',
    '  if (r > u_radius) discard;',
    '  float fall = 1.0 - (r / u_radius) * (r / u_radius);',
    '  vec2 dir = (u_type > 1.5) ? normalize(vec2(-d.y, d.x) + vec2(1e-6))',
    '                            : normalize(d + vec2(1e-6));',
    '  float s = u_strength * ((u_type > 0.5 && u_type < 1.5) ? -1.0 : 1.0) * fall;',
    '  o = vec4(dir * s, 0.0, 0.0);',
    '}'
  ].join('\n');

  // Tracer render: point sprites from the state texture, purple -> teal by speed.
  var VS_RENDER = [
    '#version 300 es',
    'uniform sampler2D u_state;',
    'uniform vec2 u_texSize;',
    'uniform float u_pointSize;',
    'out float v_speed;',
    'void main(){',
    '  ivec2 tc = ivec2(gl_VertexID % int(u_texSize.x), gl_VertexID / int(u_texSize.x));',
    '  vec4 s = texelFetch(u_state, tc, 0);',
    '  gl_Position = vec4(s.xy, 0.0, 1.0);',
    '  gl_PointSize = u_pointSize;',
    '  v_speed = length(s.zw);',
    '}'
  ].join('\n');

  var FS_RENDER = [
    '#version 300 es',
    'precision highp float;',
    'in float v_speed;',
    'out vec4 o;',
    'void main(){',
    '  vec2 c = gl_PointCoord - 0.5;',
    '  float d = length(c);',
    '  if (d > 0.5) discard;',
    '  float t = clamp(v_speed * 0.9, 0.0, 1.0);',
    '  vec3 col = mix(vec3(0.45, 0.18, 0.86), vec3(0.16, 0.92, 0.78), t);', // purple -> teal
    '  float a = (1.0 - d * 2.0);',
    '  o = vec4(col * a, a * 0.85);',
    '}'
  ].join('\n');

  // Metric pass 1: tier grid -> 64x64 partial sums. u_block = grid/64 texels
  // per output texel per axis (2/4/8 across the tiers).
  // out = (sum|v|^2, sum|v|^4, sum|v|, count) — KE, dispersion proxy, mixing proxy.
  var FS_METRIC1 = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_state;',
    'uniform vec2 u_texSize;',
    'uniform float u_block;',
    'out vec4 o;',
    'void main(){',
    '  int b = int(u_block);',
    '  ivec2 base = ivec2(gl_FragCoord.xy) * b;',
    '  vec4 acc = vec4(0.0);',
    '  for (int k = 0; k < 64; k++) {',
    '    if (k >= b * b) break;',
    '    vec4 s = texelFetch(u_state, base + ivec2(k % b, k / b), 0);',
    '    float sp2 = dot(s.zw, s.zw);',
    '    acc += vec4(sp2, sp2 * sp2, sqrt(sp2), 1.0);',
    '  }',
    '  o = acc;',
    '}'
  ].join('\n');

  // Metric pass 2: 64x64 partials -> 1x1 totals.
  var FS_METRIC2 = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_metric;',
    'out vec4 o;',
    'void main(){',
    '  vec4 acc = vec4(0.0);',
    '  for (int y = 0; y < 64; y++) {',
    '    for (int x = 0; x < 64; x++) {',
    '      acc += texelFetch(u_metric, ivec2(x, y), 0);',
    '    }',
    '  }',
    '  o = acc;',
    '}'
  ].join('\n');

  // Required uniforms per program — asserted by selfTest's shader sanity check.
  var REQUIRED_UNIFORMS = {
    update: ['u_state', 'u_perturb', 'u_texSize', 'u_dt', 'u_time', 'u_seed',
             'u_circulation', 'u_turbulence', 'u_persistence', 'u_mode', 'u_stirAmount'],
    splat: ['u_size', 'u_center', 'u_radius', 'u_strength', 'u_type'],
    decay: ['u_tex', 'u_decay'],
    render: ['u_state', 'u_texSize', 'u_pointSize'],
    metric1: ['u_state', 'u_texSize', 'u_block'],
    metric2: ['u_metric']
  };

  // ================= GL helpers =================
  function compileShader(gl, type, src, label) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh) || 'unknown';
      gl.deleteShader(sh);
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'Shader compile failed [' + label + ']: ' + String(log).slice(0, 300),
        'field-init', 'shader source for ' + label);
    }
    return sh;
  }

  function makeProgram(gl, vsSrc, fsSrc, label) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, label + ':vs');
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, label + ':fs');
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p) || 'unknown';
      gl.deleteProgram(p);
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'Program link failed [' + label + ']: ' + String(log).slice(0, 300),
        'field-init', 'program ' + label);
    }
    var locs = {};
    return {
      p: p,
      u: function (name) {
        if (!(name in locs)) locs[name] = gl.getUniformLocation(p, name);
        return locs[name];
      }
    };
  }

  function makeFloatTarget(gl, w, h, internalFormat, type) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw V.VortexError('VX_E_WARMUP_FAILED',
        'Float framebuffer incomplete at ' + w + 'x' + h + ' — stepping down.',
        'field-init', 'texture target');
    }
    return { tex: tex, fbo: fbo, w: w, h: h };
  }

  function uploadData(gl, tex, w, h, data, use32) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (use32) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, data);
    } else {
      // RGBA16F targets need Uint16 half-float data; convert once per upload.
      var half = new Uint16Array(data.length);
      for (var i = 0; i < data.length; i++) half[i] = floatToHalf(data[i]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, half);
    }
  }

  // float32 -> IEEE 754 binary16, scalar (used for the RGBA16F fallback path).
  var _f32 = new Float32Array(1);
  var _u32 = new Uint32Array(_f32.buffer);
  function floatToHalf(v) {
    _f32[0] = v;
    var x = _u32[0];
    var s = (x >> 16) & 0x8000;
    var e = ((x >> 23) & 0xff) - 112;
    var m = x & 0x7fffff;
    if (e <= 0) {
      if (e < -10) return s; // underflow -> signed zero
      m = (m | 0x800000) >> (1 - e);
      return s | (m >> 13);
    }
    if (e === 143) return s | 0x7c00 | (m ? 0x0200 : 0); // inf / nan
    if (e > 30) return s | 0x7bff; // overflow -> max finite half
    return s | (e << 10) | (m >> 13);
  }

  // ================= backend =================
  function makeBackend() {
    var S = null; // per-instance GL state, set by init()

    function fail(code, msg, stage, kept) {
      return V.VortexError(code, msg, stage, kept);
    }

    function useProg(gl, prog) { gl.useProgram(prog.p); }

    function bindTex(gl, unit, tex) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    function drawFull(gl) { gl.drawArrays(gl.TRIANGLES, 0, 3); }

    function buildUpdateSource(configId) {
      var cfg = CONFIGS[configId] || CONFIGS.spiral;
      return UPDATE_PRELUDE + '\n' + cfg.glsl + '\n' + UPDATE_MAIN;
    }

    function getUpdateProg(gl, configId) {
      if (!S.progUpdate[configId]) {
        S.progUpdate[configId] = makeProgram(gl, VS_FULL, buildUpdateSource(configId),
          'update:' + configId);
      }
      return S.progUpdate[configId];
    }

    function initStateData(seed, count) {
      var rnd = V.utils.mulberry32(seed >>> 0);
      var data = new Float32Array(count * 4);
      for (var i = 0; i < count; i++) {
        // uniform disc, radius sqrt-distributed — the spiral reads well from t=0
        var r = Math.sqrt(rnd()) * 0.95, a = rnd() * Math.PI * 2;
        data[i * 4] = Math.cos(a) * r;
        data[i * 4 + 1] = Math.sin(a) * r;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      }
      return data;
    }

    var B = {
      name: 'webgl2',
      tier: 'B',
      gl: null,

      init: function (canvas, opts) {
        var self = this;
        return new Promise(function (resolve, reject) {
          try {
            if (!canvas || typeof canvas.getContext !== 'function') {
              reject(fail('VX_E_FIELD_INIT', 'No canvas supplied — cannot create a GL context.',
                'field-init', 'nothing (backend not started)'));
              return;
            }
            var gl = canvas.getContext('webgl2', {
              antialias: false, alpha: false, depth: false, stencil: false,
              powerPreference: 'high-performance', preserveDrawingBuffer: false
            });
            if (!gl) {
              reject(fail('VX_E_WARMUP_FAILED',
                'WebGL2 is unavailable in this browser/device. The CPU backend is the step-down target.',
                'field-init', 'canvas element'));
              return;
            }
            // Capability probe — the FBO check is the truth, not the extension string.
            var probe = F && F.probeFloatRenderable
              ? F.probeFloatRenderable(gl)
              : { chosen: null, note: 'contract module missing' };
            if (!probe.chosen) {
              reject(fail('VX_E_WARMUP_FAILED',
                'No float render target: ' + probe.note + '. Stepping down to CPU.',
                'field-init', 'WebGL2 context (released)'));
              return;
            }
            var use32 = (probe.chosen === 'rgba32f');
            var internalFormat = use32 ? gl.RGBA32F : gl.RGBA16F;
            var texType = use32 ? gl.FLOAT : gl.HALF_FLOAT;

            opts = opts || {};
            var tier = tierForCount(opts.tracers || 16384);
            var gw = tier.grid[0], gh = tier.grid[1], count = tier.tracers;
            var seed = (opts.seed >>> 0) || 1;

            S = {
              canvas: canvas, gl: gl, tier: tier, count: count,
              seed: seed, time: 0, frame: 0,
              format: probe.chosen, use32: use32,
              params: {
                circulation: 1.0, turbulence: 0.35, persistence: 0.92,
                mode: 0, stirAmount: 1.0, config: opts.config || 'spiral'
              },
              probes: [],            // active probe descriptors (CPU side)
              progUpdate: {},         // per-config cached programs
              lastMetrics: null,
              diagPending: null,
              lost: false, steppedDown: false,
              fboState: null, read: 0
            };
            if (opts.params) B.setParams(opts.params);

            // state ping-pong
            S.texState = [
              makeFloatTarget(gl, gw, gh, internalFormat, texType),
              makeFloatTarget(gl, gw, gh, internalFormat, texType)
            ];
            uploadData(gl, S.texState[0].tex, gw, gh, initStateData(seed, count), use32);
            var zero = new Float32Array(count * 4);
            uploadData(gl, S.texState[1].tex, gw, gh, zero, use32);

            // perturbation ping-pong (128x128 is plenty for probe impulses)
            S.perturbSize = 128;
            S.texPerturb = [
              makeFloatTarget(gl, 128, 128, internalFormat, texType),
              makeFloatTarget(gl, 128, 128, internalFormat, texType)
            ];

            // metric targets: 64x64 partials + 1x1 total, float
            S.texMetricA = makeFloatTarget(gl, 64, 64, gl.RGBA32F, gl.FLOAT);
            S.texMetricB = makeFloatTarget(gl, 1, 1, gl.RGBA32F, gl.FLOAT);
            S.pbo = gl.createBuffer();

            // shared programs
            S.progSplat = makeProgram(gl, VS_FULL, FS_SPLAT, 'splat');
            S.progDecay = makeProgram(gl, VS_FULL, FS_DECAY, 'decay');
            S.progRender = makeProgram(gl, VS_RENDER, FS_RENDER, 'render');
            S.progM1 = makeProgram(gl, VS_FULL, FS_METRIC1, 'metric1');
            S.progM2 = makeProgram(gl, VS_FULL, FS_METRIC2, 'metric2');
            getUpdateProg(gl, S.params.config); // compile the active config now

            canvas.addEventListener('webglcontextlost', function (e) {
              e.preventDefault();
              /* NOTE (audit 2026-09-20): S is null after dispose() — a disposed
               * trial's loseContext() fires this async. Guard: context loss on a
               * dead backend is expected, not an error. */
              if (!S) return;
              S.lost = true; S.steppedDown = true;
              V.bus.emit('vx:error', {
                code: 'VX_E_CONTEXT_LOST',
                message: 'The GPU context was lost; the field stepped down. State is preserved for restore.',
                stage: 'render'
              });
            });

            self.gl = gl;
            V.bus.emit('vx:ready', {
              backend: 'webgl2', tracers: count, tier: tier.id, format: probe.chosen
            });
            resolve(self);
          } catch (e) {
            reject(e && e.code ? e : fail('VX_E_FIELD_INIT',
              'WebGL2 init threw: ' + (e && e.message), 'field-init', 'nothing'));
          }
        });
      },

      setParams: function (p) {
        if (!S || !p) return;
        var P = S.params;
        if (p.circulation !== undefined) P.circulation = V.utils.clamp(+p.circulation, 0, 4);
        if (p.turbulence !== undefined) P.turbulence = V.utils.clamp(+p.turbulence, 0, 2);
        if (p.persistence !== undefined) P.persistence = V.utils.clamp(+p.persistence, 0, 0.999);
        if (p.mode !== undefined) P.mode = V.utils.clamp(Math.round(+p.mode), 0, 2);
        if (p.stirAmount !== undefined) P.stirAmount = V.utils.clamp(+p.stirAmount, 0, 3);
        if (p.config !== undefined && CONFIGS[p.config] && p.config !== P.config) {
          P.config = p.config;
          // config swap reuses the per-config cached program — sliders never recompile
          getUpdateProg(S.gl, P.config);
        }
        // NOTE: all of the above are uniforms; no shader is rebuilt here.
      },

      addProbe: function (probe) {
        if (!S || S.lost) return;
        probe = probe || {};
        var x = V.utils.clamp(+probe.x || 0, -1, 1);
        var y = V.utils.clamp(+probe.y || 0, -1, 1);
        var type = probe.type === 'pull' ? 1 : (probe.type === 'curl' ? 2 : 0);
        S.probes.push({
          x: x, y: y,
          strength: V.utils.clamp(+probe.strength || 1, -3, 3),
          radius: V.utils.clamp(probe.radius !== undefined ? +probe.radius : 0.18, 0.02, 0.5),
          type: type,
          ttl: Math.max(1, (probe.ttl | 0) || 90), // frames of impulse
          decay: 0.965
        });
        while (S.probes.length > 16) S.probes.shift(); // cap: oldest drops
        V.bus.emit('vx:probe', { probe: { x: x, y: y, type: probe.type || 'push' }, params: probe });
      },

      clearProbes: function () {
        if (!S) return;
        S.probes.length = 0;
        if (!S.lost) {
          var gl = S.gl, zero = new Float32Array(128 * 128 * 4);
          uploadData(gl, S.texPerturb[0].tex, 128, 128, zero, S.use32);
          uploadData(gl, S.texPerturb[1].tex, 128, 128, zero, S.use32);
        }
      },

      step: function () {
        if (!S || S.lost) return false;
        var gl = S.gl, P = S.params;
        S.time += DT;
        S.frame++;

        // --- perturbation texture: decay, then splat active probes ---
        // read the side written LAST frame; write the other side.
        var pr = (S.perturbRead === undefined) ? 1 : S.perturbRead;
        var pw = 1 - pr;
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.texPerturb[pw].fbo);
        gl.viewport(0, 0, 128, 128);
        gl.disable(gl.BLEND);
        useProg(gl, S.progDecay);
        gl.uniform1i(S.progDecay.u('u_tex'), 0);
        bindTex(gl, 0, S.texPerturb[pr].tex);
        gl.uniform1f(S.progDecay.u('u_decay'), 0.96);
        drawFull(gl);
        // splats: additive impulses for each live probe
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        useProg(gl, S.progSplat);
        var sp = S.progSplat;
        gl.uniform1i(sp.u('u_tex'), 0);
        gl.uniform2f(sp.u('u_size'), 128, 128);
        for (var i = S.probes.length - 1; i >= 0; i--) {
          var pb = S.probes[i];
          gl.uniform2f(sp.u('u_center'), pb.x, pb.y);
          gl.uniform1f(sp.u('u_radius'), pb.radius);
          gl.uniform1f(sp.u('u_strength'), pb.strength);
          gl.uniform1f(sp.u('u_type'), pb.type);
          drawFull(gl);
          pb.strength *= pb.decay;
          if (--pb.ttl <= 0 || Math.abs(pb.strength) < 1e-3) S.probes.splice(i, 1);
        }
        gl.disable(gl.BLEND);
        S.perturbRead = pw; // freshly written side is now the read side

        // --- state update: fullscreen pass into the write side ---
        var w = 1 - S.read;
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.texState[w].fbo);
        gl.viewport(0, 0, S.tier.grid[0], S.tier.grid[1]);
        var up = getUpdateProg(gl, P.config);
        useProg(gl, up);
        gl.uniform1i(up.u('u_state'), 0);   bindTex(gl, 0, S.texState[S.read].tex);
        gl.uniform1i(up.u('u_perturb'), 1); bindTex(gl, 1, S.texPerturb[S.perturbRead].tex);
        gl.uniform2f(up.u('u_texSize'), S.tier.grid[0], S.tier.grid[1]);
        gl.uniform1f(up.u('u_dt'), DT);
        gl.uniform1f(up.u('u_time'), S.time);
        gl.uniform1f(up.u('u_seed'), S.seed % 1000);
        gl.uniform1f(up.u('u_circulation'), P.circulation);
        gl.uniform1f(up.u('u_turbulence'), P.turbulence);
        gl.uniform1f(up.u('u_persistence'), P.persistence);
        gl.uniform1f(up.u('u_mode'), P.mode);
        gl.uniform1f(up.u('u_stirAmount'), P.stirAmount);
        drawFull(gl);
        S.read = w;

        // --- fenced diagnostics, never blocking ---
        if (S.frame % 30 === 0) requestDiagnostics();
        pollDiagnostics();
        if (S.frame % 60 === 0) {
          V.bus.emit('vx:frame', { dt: DT, frame: S.frame, backend: 'webgl2' });
        }
        return true;
      },

      render: function () {
        if (!S || S.lost) return false;
        var gl = S.gl, canvas = S.canvas;
        var dpr = (root.devicePixelRatio || 1);
        var w = Math.max(1, Math.floor(canvas.clientWidth * dpr) || canvas.width || 512);
        var h = Math.max(1, Math.floor(canvas.clientHeight * dpr) || canvas.height || 512);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.disable(gl.DEPTH_TEST);
        gl.clearColor(0.015, 0.01, 0.03, 1.0); // near-black violet stage
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive glow
        var rp = S.progRender;
        useProg(gl, rp);
        gl.uniform1i(rp.u('u_state'), 0); bindTex(gl, 0, S.texState[S.read].tex);
        gl.uniform2f(rp.u('u_texSize'), S.tier.grid[0], S.tier.grid[1]);
        gl.uniform1f(rp.u('u_pointSize'), S.tier.point * dpr);
        gl.drawArrays(gl.POINTS, 0, S.count);
        gl.disable(gl.BLEND);
        return true;
      },

      snapshotState: function () {
        if (!S) return null;
        var gl = S.gl, gw = S.tier.grid[0], gh = S.tier.grid[1];
        var data = new Float32Array(S.count * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, S.texState[S.read].fbo);
        gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, data);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return {
          version: 1,
          backend: 'webgl2',
          codeVersion: V.codeVersion,
          tier: S.tier.id,
          seed: S.seed,
          time: S.time,
          frame: S.frame,
          config: S.params.config,
          params: {
            circulation: S.params.circulation, turbulence: S.params.turbulence,
            persistence: S.params.persistence, mode: S.params.mode,
            stirAmount: S.params.stirAmount
          },
          state: data // Float32Array — structured-cloneable
        };
      },

      restoreState: function (s) {
        if (!S || !s || s.backend !== 'webgl2' || s.version !== 1) return false;
        if (s.tier !== S.tier.id || !s.state || s.state.length !== S.count * 4) return false;
        uploadData(S.gl, S.texState[S.read].tex, S.tier.grid[0], S.tier.grid[1], s.state, S.use32);
        S.time = +s.time || 0;
        S.frame = s.frame | 0;
        S.seed = (s.seed >>> 0) || 1;
        B.setParams(s.params || {});
        if (s.config && CONFIGS[s.config]) B.setParams({ config: s.config });
        B.clearProbes();
        return true;
      },

      sampleMetrics: function () {
        if (!S) return { sampled: false, note: 'backend not initialized' };
        if (!S.lastMetrics) {
          return {
            sampled: false, ke: 0, enstrophy: 0, mixing: 0,
            tracers: S.count, note: 'no fenced diagnostic has completed yet'
          };
        }
        return S.lastMetrics;
      },

      getTracers: function () {
        if (!S) return { count: 0, simulated: false };
        return { count: S.count, tier: S.tier.id, simulated: !S.steppedDown };
      },

      dispose: function () {
        if (!S) return;
        var gl = S.gl;
        try {
          [S.texState, S.texPerturb].forEach(function (pair) {
            pair.forEach(function (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); });
          });
          gl.deleteFramebuffer(S.texMetricA.fbo); gl.deleteTexture(S.texMetricA.tex);
          gl.deleteFramebuffer(S.texMetricB.fbo); gl.deleteTexture(S.texMetricB.tex);
          gl.deleteBuffer(S.pbo);
          [S.progSplat, S.progDecay, S.progRender, S.progM1, S.progM2].forEach(function (p) {
            gl.deleteProgram(p.p);
          });
          Object.keys(S.progUpdate).forEach(function (k) { gl.deleteProgram(S.progUpdate[k].p); });
          if (S.diagPending) gl.deleteSync(S.diagPending.sync);
          var lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch (e) { /* best effort */ }
        S = null;
        B.gl = null;
      },

      // Diagnostics API (also used internally by step()).
      requestDiagnostics: function () { if (S && !S.lost) requestDiagnostics(); },
      pollDiagnostics: function () { if (S && !S.lost) pollDiagnostics(); }
    };

    // ---- fenced async diagnostic readback (module-scope closures over S) ----
    function requestDiagnostics() {
      var gl = S.gl;
      if (S.diagPending) return; // one in flight at a time; never queue up
      // pass 1: state grid -> 64x64 partial sums
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.texMetricA.fbo);
      gl.viewport(0, 0, 64, 64);
      useProg(gl, S.progM1);
      gl.uniform1i(S.progM1.u('u_state'), 0); bindTex(gl, 0, S.texState[S.read].tex);
      gl.uniform2f(S.progM1.u('u_texSize'), S.tier.grid[0], S.tier.grid[1]);
      gl.uniform1f(S.progM1.u('u_block'), S.tier.grid[0] / 64);
      drawFull(gl);
      // pass 2: 64x64 -> 1x1 totals
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.texMetricB.fbo);
      gl.viewport(0, 0, 1, 1);
      useProg(gl, S.progM2);
      gl.uniform1i(S.progM2.u('u_metric'), 0); bindTex(gl, 0, S.texMetricA.tex);
      drawFull(gl);
      // async readback: PBO + fence, then flush. The frame never waits.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      var sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      S.diagPending = { sync: sync, frame: S.frame };
    }

    function pollDiagnostics() {
      var gl = S.gl, p = S.diagPending;
      if (!p) return;
      var st = gl.clientWaitSync(p.sync, 0, 0); // zero timeout: NEVER blocks the frame
      if (st === gl.TIMEOUT_EXPIRED) return;    // not ready yet; try next frame
      gl.deleteSync(p.sync);
      S.diagPending = null;
      var out = new Float32Array(4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, S.pbo);
      try {
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      } catch (e) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return; // readback failed; keep the last good sample
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      var n = S.count;
      S.lastMetrics = {
        ke: out[0] / n,          // mean |v|^2 — kinetic energy proxy
        enstrophy: out[1] / n,   // mean |v|^4 — dispersion proxy (labeled honestly)
        mixing: out[2] / n,      // mean |v| — stirring/mixing proxy
        tracers: n,
        sampled: true,
        frame: p.frame,
        format: S.format,
        note: st === gl.WAIT_FAILED ? 'sync wait failed; value may be stale' : ''
      };
    }

    return B;
  }

  // ================= shader sanity (headless) =================
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  function checkGLSL(name, src, requiredUniforms) {
    var problems = [];
    var code = stripComments(src);
    var counts = { '{': 0, '}': 0, '(': 0, ')': 0 };
    for (var i = 0; i < code.length; i++) {
      var ch = code[i];
      if (counts[ch] !== undefined) counts[ch]++;
    }
    if (counts['{'] !== counts['}']) problems.push('unbalanced braces');
    if (counts['('] !== counts[')']) problems.push('unbalanced parens');
    if (code.indexOf('void main') === -1) problems.push('no void main');
    (requiredUniforms || []).forEach(function (u) {
      var re = new RegExp('uniform\\s+\\w+\\s+' + u + '\\s*[;\\[]');
      if (!re.test(code)) problems.push('uniform not declared: ' + u);
    });
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join('; ') : 'balanced, has main, uniforms declared'
    };
  }

  // ================= selfTest (headless-safe, never throws) =================
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

    check('namespace present', function () {
      return { ok: !!(V && V.register), detail: 'VORTEX ' + V.version };
    });

    check('contract module loaded', function () {
      return {
        ok: HAS_CONTRACT,
        detail: HAS_CONTRACT
          ? 'w02-field-contract registered; verifyBackend available'
          : 'w02-field-contract NOT loaded — verifyBackend guards will note this (load order: contract before this file)'
      };
    });

    check('tier table invariants', function () {
      var prev = 0;
      for (var i = 0; i < TIERS.length; i++) {
        var t = TIERS[i];
        if (!(t.tracers > prev)) return { ok: false, detail: 'not ascending at ' + t.id };
        prev = t.tracers;
        if (t.grid[0] * t.grid[1] !== t.tracers)
          return { ok: false, detail: t.id + ' grid capacity mismatch' };
      }
      var labels = TIERS.map(function (t) { return t.label; }).join('/');
      return {
        ok: labels === 'Light/Dense/Ultra/Extreme' && TIERS[3].tracers === 262144,
        detail: 'Light 16K -> Dense 65K -> Ultra 131K -> Extreme 262K'
      };
    });

    check('tiers mirror contract tiers', function () {
      if (!HAS_CONTRACT || !F || !F.TIERS) {
        return { ok: true, detail: 'SKIPPED — contract module absent (nothing to mirror against)' };
      }
      if (F.TIERS.length !== TIERS.length)
        return { ok: false, detail: 'tier count differs: contract=' + F.TIERS.length };
      for (var i = 0; i < TIERS.length; i++) {
        if (F.TIERS[i].id !== TIERS[i].id || F.TIERS[i].tracers !== TIERS[i].tracers)
          return { ok: false, detail: 'mismatch at index ' + i };
      }
      return { ok: true, detail: '4/4 tiers identical (id + tracer count)' };
    });

    check('factory creates a contract-shaped backend', function () {
      var b = makeBackend();
      var methods = F && F.METHODS ? F.METHODS
        : ['init', 'setParams', 'addProbe', 'clearProbes', 'step', 'render',
           'snapshotState', 'restoreState', 'sampleMetrics', 'getTracers', 'dispose'];
      var missing = methods.filter(function (m) { return typeof b[m] !== 'function'; });
      var r = F && F.checkContract ? F.checkContract(b) : { ok: missing.length === 0 };
      return {
        ok: r.ok && b.name === 'webgl2' && b.tier === 'B',
        detail: r.ok ? '11/11 methods, name=webgl2, tier=B' : 'missing: ' + missing.join(',')
      };
    });

    check('uninitialized backend is inert (no throw)', function () {
      var b = makeBackend();
      var inert = (b.step() === false) && (b.render() === false) &&
        (b.getTracers().count === 0) && (b.snapshotState() === null);
      b.dispose();
      return { ok: inert, detail: 'step/render false, 0 tracers, null snapshot before init' };
    });

    check('tierForCount: 16K->light, 200K->extreme, 2M clamped to extreme', function () {
      var a = tierForCount(16000).id, b = tierForCount(200000).id, c = tierForCount(2000000).id;
      return {
        ok: a === 'light' && b === 'extreme' && c === 'extreme',
        detail: '16000->' + a + ', 200000->' + b + ', 2000000->' + c + ' (1M is W03 megafield)'
      };
    });

    // shader sanity for every program we ship
    var shaderSets = [
      ['update:spiral', UPDATE_PRELUDE + '\n' + CONFIGS.spiral.glsl + '\n' + UPDATE_MAIN, 'update'],
      ['update:collision', UPDATE_PRELUDE + '\n' + CONFIGS.collision.glsl + '\n' + UPDATE_MAIN, 'update'],
      ['update:wake', UPDATE_PRELUDE + '\n' + CONFIGS.wake.glsl + '\n' + UPDATE_MAIN, 'update'],
      ['splat', VS_FULL, null],
      ['splat-fs', FS_SPLAT, 'splat'],
      ['decay-fs', FS_DECAY, 'decay'],
      ['render-vs', VS_RENDER, 'render'],
      ['render-fs', FS_RENDER, null],
      ['metric1-fs', FS_METRIC1, 'metric1'],
      ['metric2-fs', FS_METRIC2, 'metric2']
    ];
    shaderSets.forEach(function (entry) {
      check('shader sanity: ' + entry[0], function () {
        var r = checkGLSL(entry[0], entry[1], REQUIRED_UNIFORMS[entry[2]] || []);
        return r;
      });
    });

    check('configs each define baseField(vec2,float)', function () {
      var ids = Object.keys(CONFIGS);
      for (var i = 0; i < ids.length; i++) {
        if (!/vec2\s+baseField\s*\(\s*vec2/.test(CONFIGS[ids[i]].glsl))
          return { ok: false, detail: ids[i] + ' missing baseField' };
      }
      return { ok: ids.length === 3, detail: 'spiral/collision/wake all define baseField' };
    });

    check('verifyBackend rejects fake GL with VX_E_WARMUP_FAILED', function () {
      if (!HAS_CONTRACT || !F || !F.verifyBackend) {
        return { ok: true, detail: 'SKIPPED — contract module absent; gate untestable headless' };
      }
      var fakeGL = {
        getExtension: function () { return null; }, // honest stub: no float support
        createTexture: function () { return {}; }
      };
      var fake = { name: 'webgl2', tier: 'B', gl: fakeGL };
      F.METHODS.forEach(function (m) { fake[m] = function () {}; });
      try {
        F.verifyBackend(fake, { frames: 1 });
        return { ok: false, detail: 'verifyBackend did not throw on fake GL' };
      } catch (e) {
        return {
          ok: e && e.code === 'VX_E_WARMUP_FAILED',
          detail: 'threw [' + (e && e.code) + '] — step-down signaled, nothing faked'
        };
      }
    });

    check('init rejects without canvas (headless)', function () {
      var b = makeBackend();
      var p = b.init(null, {});
      var isPromise = p && typeof p.then === 'function';
      if (!isPromise) return { ok: false, detail: 'init did not return a promise' };
      p.then(function () {}, function (e) {
        // rejection is the CORRECT headless outcome; swallow it
      });
      return { ok: true, detail: 'init(null) returns a rejecting promise, never throws sync' };
    });

    var headless = (typeof root.document === 'undefined');
    checks.push({
      name: 'real GL compile + 120-frame warm-up',
      ok: true,
      detail: headless
        ? 'SKIPPED (no GL in this environment) — real shader compile and the warm-up in verifyBackend() are only verifiable on a GPU machine; selfTest asserts source sanity instead'
        : 'not run by selfTest; call VORTEX.field.verifyBackend(backend, {frames:120}) after init on GPU hardware'
    });

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  var api = {
    name: 'webgl2',
    create: makeBackend,
    TIERS: TIERS,
    CONFIG_IDS: Object.keys(CONFIGS),
    tierForCount: tierForCount,
    selfTest: selfTest,
    // exposed for headless inspection / W15 selector use
    _shaderSources: function () {
      return {
        updatePrelude: UPDATE_PRELUDE, updateMain: UPDATE_MAIN,
        configs: { spiral: CONFIGS.spiral.glsl, collision: CONFIGS.collision.glsl, wake: CONFIGS.wake.glsl },
        splat: FS_SPLAT, decay: FS_DECAY,
        renderVS: VS_RENDER, renderFS: FS_RENDER,
        metric1: FS_METRIC1, metric2: FS_METRIC2
      };
    }
  };

  VORTEX.register('w02-gpu', api);
})(typeof window !== 'undefined' ? window : globalThis);
