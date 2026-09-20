/* VORTEX vx-namespace.js — coordinator-owned global.
 * Loaded first by init.js. Defines: global registry, event bus, utils
 * (seeded PRNG, hash, math helpers), UI panel registry, named errors.
 * Plain script, no modules. Works in browser and node (headless tests).
 */
(function (root) {
  'use strict';

  var V = root.VORTEX = root.VORTEX || {};
  V.version = '0.2.0-lane14';
  V.codeVersion = 'lane14-2026-09-20';
  V.SIM_DT = 1 / 60;

  // ---- module registry ----
  var _mods = {};
  V.register = function (id, api) {
    if (typeof id !== 'string' || !id) throw new Error('VORTEX.register: bad id');
    if (_mods[id]) throw new Error('VORTEX.register: duplicate module ' + id);
    if (!api || typeof api.selfTest !== 'function') {
      throw new Error('VORTEX.register: module ' + id + ' must expose selfTest()');
    }
    _mods[id] = api;
    V.bus.emit('vx:module', { id: id });
    return api;
  };
  V.get = function (id) { return _mods[id] || null; };
  V.has = function (id) { return !!_mods[id]; };
  V.modules = function () { return Object.keys(_mods); };

  // ---- event bus ----
  var target = new root.EventTarget();
  V.bus = {
    on: function (name, fn) {
      target.addEventListener(name, function (e) { fn(e.detail); });
    },
    emit: function (name, detail) {
      target.dispatchEvent(new root.CustomEvent(name, { detail: detail || {} }));
    }
  };

  // ---- utils ----
  function mulberry32(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // cyrb53 -> hex string
  function hash53(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    var n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return n.toString(16);
  }
  var _uid = 0;
  V.utils = {
    mulberry32: mulberry32,
    hash53: hash53,
    clamp: function (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    uid: function (p) { _uid += 1; return (p || 'id') + '-' + Date.now().toString(36) + '-' + _uid; },
    now: function () { return Date.now(); },
    isBrowser: function () { return typeof root.document !== 'undefined'; },
    stableStringify: function (o) {
      // deterministic JSON: sorted keys, no undefined/functions
      function s(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(s).join(',') + ']';
        var ks = Object.keys(v).filter(function (k) {
          return v[k] !== undefined && typeof v[k] !== 'function';
        }).sort();
        return '{' + ks.map(function (k) { return JSON.stringify(k) + ':' + s(v[k]); }).join(',') + '}';
      }
      return s(o);
    }
  };

  // ---- named errors ----
  V.ErrorCodes = {
    VX_E_SHELL: 'shell detection failed',
    VX_E_NAMESPACE: 'core namespace failed to load',
    VX_E_SCRIPT_TIMEOUT: 'a module script timed out while loading',
    VX_E_SCRIPT_ERROR: 'a module script failed to load',
    VX_E_NO_BACKEND: 'no simulation backend available',
    VX_E_WARMUP_FAILED: 'backend failed warm-up verification',
    VX_E_FIELD_INIT: 'field failed to initialize',
    VX_E_CHROME: 'lab chrome failed (non-fatal)',
    VX_E_OOM: 'out of memory — stepped down',
    VX_E_CONTEXT_LOST: 'graphics context lost',
    VX_E_QUOTA: 'storage quota exceeded'
  };
  V.VortexError = function (code, message, stage, kept) {
    var e = new Error('[' + code + '] ' + (message || V.ErrorCodes[code] || 'unknown error'));
    e.code = code; e.stage = stage || null; e.kept = kept || null;
    return e;
  };

  // ---- UI registry (DOM-guarded; safe headless) ----
  var _panels = [];
  V.ui = {
    registerPanel: function (id, title, mountFn) {
      if (typeof mountFn !== 'function') throw new Error('registerPanel needs mountFn');
      _panels.push({ id: id, title: title, mount: mountFn });
    },
    panels: function () { return _panels.slice(); },
    announce: function (msg) {
      V.bus.emit('vx:announce', { message: String(msg) });
      if (!V.utils.isBrowser()) return;
      var f = root.document.getElementById('vx-footer');
      if (f) {
        var d = root.document.createElement('div');
        d.className = 'vx-announce'; d.textContent = String(msg);
        f.appendChild(d);
        while (f.children.length > 6) f.removeChild(f.firstChild);
      }
    },
    fail: function (code, message, kept) {
      V.bus.emit('vx:error', { code: code, message: message, kept: kept });
      if (!V.utils.isBrowser()) return;
      var el = root.document.getElementById('vx-fatal');
      if (el) {
        el.style.display = 'block';
        el.innerHTML = '';
        var h = root.document.createElement('h2'); h.textContent = 'VORTEX stopped: ' + code;
        var p = root.document.createElement('p'); p.textContent = message;
        var k = root.document.createElement('p'); k.className = 'vx-kept';
        k.textContent = kept ? 'Kept: ' + kept : 'No state was kept.';
        var c = root.document.createElement('button'); c.textContent = 'Copy diagnostics';
        c.onclick = function () {
          var diag = 'VORTEX ' + V.version + ' ' + code + ' :: ' + message +
            ' :: kept=' + (kept || 'none') + ' :: ua=' + (root.navigator && root.navigator.userAgent);
          if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(diag);
          c.textContent = 'Copied';
        };
        el.appendChild(h); el.appendChild(p); el.appendChild(k); el.appendChild(c);
      }
    }
  };

  // ---- run manifest helper (W25 owns the full module; this is the schema) ----
  V.manifestSchema = ['version', 'codeVersion', 'seed', 'params', 'configId',
    'probeTimeline', 'backend', 'tracers', 'toleranceBands'];
  V.makeManifest = function (o) {
    var m = {
      version: 1,
      codeVersion: V.codeVersion,
      seed: o.seed >>> 0,
      params: o.params || {},
      configId: o.configId || 'spiral-default',
      probeTimeline: o.probeTimeline || [],
      backend: o.backend || 'cpu',
      tracers: o.tracers || 0,
      toleranceBands: o.toleranceBands || {}
    };
    m.hash = V.utils.hash53(V.utils.stableStringify(m));
    return m;
  };

  V.bus.emit('vx:namespace', { version: V.version });
})(typeof window !== 'undefined' ? window : globalThis);
