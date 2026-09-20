/* VORTEX presets.js — W18: versioned preset library.
 * Built-in presets (Spiral / Collision / Wake) as v1 JSON, fork/remix lineage
 * (append-only, git-style), collections, thumbnails, .vortex export + URL-hash
 * links, applyPreset() with field-contract + W04 config guards, "Presets" panel.
 * Plain script, no modules. Headless-safe (node): all DOM/canvas/localStorage
 * access guarded; selfTest() never throws.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V) { return; /* namespace must load first */ }

  var MODULE_ID = 'w18-presets';
  var STORE_KEY = 'vortex.presets.v1';

  // ---------------------------------------------------------------- presets

  // record: { id, name, version, parentId, params, configId, probeDefaults,
  //           thumbnail (dataURL|null), createdAt }
  var _presets = {};   // id -> record (immutable once stored; edits copy)
  var _collections = {}; // id -> { id, name, presetIds[] }

  function _clone(o) { return JSON.parse(JSON.stringify(o)); }

  function _now() { return new Date().toISOString(); }

  function _mkId(base, version) {
    // content-addressed-ish stable id: base + vN (git-style, human-readable)
    return base + '-v' + version;
  }

  function _validate(rec) {
    var errs = [];
    if (!rec || typeof rec !== 'object') return ['not an object'];
    if (typeof rec.id !== 'string' || !rec.id) errs.push('id');
    if (typeof rec.name !== 'string' || !rec.name) errs.push('name');
    if (typeof rec.version !== 'number' || rec.version < 1) errs.push('version');
    if (rec.parentId !== null && typeof rec.parentId !== 'string') errs.push('parentId');
    if (!rec.params || typeof rec.params !== 'object') errs.push('params');
    else {
      ['circulation', 'turbulence', 'persistence'].forEach(function (k) {
        if (typeof rec.params[k] !== 'number' || !isFinite(rec.params[k])) errs.push('params.' + k);
      });
    }
    if (typeof rec.configId !== 'string' || !rec.configId) errs.push('configId');
    if (!Array.isArray(rec.probeDefaults)) errs.push('probeDefaults');
    if (rec.thumbnail !== null && rec.thumbnail !== undefined &&
        !(typeof rec.thumbnail === 'string' && rec.thumbnail.indexOf('data:image') === 0)) {
      errs.push('thumbnail');
    }
    return errs;
  }

  // --- built-ins: v1 presets reproducing today's UI behavior ---
  // Spiral: 1-vortex scene (matches W19 scene) with default slider positions.
  // Collision: 2 opposing vortices, same defaults the UI ships with.
  // Wake: time-reversed-wake-flavored defaults, higher turbulence.
  function _builtins() {
    var t = _now();
    return [
      {
        id: _mkId('vx-spiral', 1), name: 'Spiral', version: 1, parentId: null,
        params: {
          circulation: 1.0, turbulence: 0.15, persistence: 0.85, seed: 42,
          tracers: 4000, backend: 'auto',
          scene: { mode: 'spiral', vortices: [{ x: 0.5, y: 0.5, gamma: 1.0, core: 0.08 }] }
        },
        configId: 'spiral-default',
        probeDefaults: [{ probe: 'oppose-winding', params: { strength: 0.5, duration: 2.0 } }],
        thumbnail: null, createdAt: t
      },
      {
        id: _mkId('vx-collision', 1), name: 'Collision', version: 1, parentId: null,
        params: {
          circulation: 1.0, turbulence: 0.10, persistence: 0.90, seed: 7,
          tracers: 4000, backend: 'auto',
          scene: { mode: 'collision', vortices: [
            { x: 0.35, y: 0.5, gamma: 1.0, core: 0.08 },
            { x: 0.65, y: 0.5, gamma: -1.0, core: 0.08 }
          ] }
        },
        configId: 'vortex-pair-merger',
        probeDefaults: [
          { probe: 'oppose-winding', params: { strength: 0.4, duration: 2.0 } },
          { probe: 'perturb-field', params: { strength: 0.3, duration: 1.0 } }
        ],
        thumbnail: null, createdAt: t
      },
      {
        id: _mkId('vx-wake', 1), name: 'Wake', version: 1, parentId: null,
        params: {
          circulation: 0.8, turbulence: 0.35, persistence: 0.70, seed: 21,
          tracers: 4000, backend: 'auto',
          scene: { mode: 'wake', vortices: [] }
        },
        configId: 'wake-obstacle',
        probeDefaults: [{ probe: 'test-wake', params: { strength: 0.5, duration: 3.0 } }],
        thumbnail: null, createdAt: t
      }
    ];
  }

  function _registerBuiltins() {
    _builtins().forEach(function (rec) {
      var errs = _validate(rec);
      if (!errs.length) _presets[rec.id] = _clone(rec);
    });
  }

  // ---------------------------------------------------------------- storage

  function _persist() {
    // localStorage only inside try/catch (contract §2); never fatal.
    if (!V.utils.isBrowser()) return;
    try {
      if (typeof root.localStorage === 'undefined') return;
      root.localStorage.setItem(STORE_KEY, JSON.stringify({ presets: _presets, collections: _collections }));
    } catch (e) { /* quota or private-mode: keep in-memory copy */ }
  }

  function _restore() {
    if (!V.utils.isBrowser()) return;
    try {
      if (typeof root.localStorage === 'undefined') return;
      var raw = root.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.presets) {
        Object.keys(data.presets).forEach(function (id) {
          var rec = data.presets[id];
          if (_validate(rec).length === 0 && !_presets[id]) _presets[id] = rec;
        });
      }
      if (data && data.collections) {
        Object.keys(data.collections).forEach(function (id) {
          if (!_collections[id]) _collections[id] = data.collections[id];
        });
      }
    } catch (e) { /* corrupt store: keep built-ins */ }
  }

  // ------------------------------------------------------------- thumbnails

  function captureThumbnail(canvas) {
    // Guarded: headless or absent canvas -> null, never throw.
    try {
      var el = canvas || null;
      if (!el && V.utils.isBrowser() && root.document) {
        el = root.document.querySelector('#vx-canvas-wrap canvas') ||
             root.document.getElementById('vx-canvas');
      }
      if (!el || typeof el.toDataURL !== 'function') return null;
      return el.toDataURL('image/png');
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ core

  function list() {
    return Object.keys(_presets).sort().map(function (id) { return _clone(_presets[id]); });
  }

  function get(id) {
    return _presets[id] ? _clone(_presets[id]) : null;
  }

  // save a brand-new preset (version 1). Editing an existing preset uses edit()
  // which appends a new versioned record instead of mutating.
  function save(data) {
    var rec = {
      id: null, name: data.name, version: 1, parentId: data.parentId || null,
      params: _clone(data.params || {}),
      configId: data.configId || 'spiral-default',
      probeDefaults: _clone(data.probeDefaults || []),
      thumbnail: data.thumbnail === undefined ? captureThumbnail(data.canvas) : data.thumbnail,
      createdAt: _now()
    };
    var base = 'vx-' + String(rec.name || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vx-preset';
    var id = _mkId(base, 1), n = 1;
    while (_presets[id]) { n += 1; id = _mkId(base + '-' + n, 1); }
    rec.id = id;
    var errs = _validate(rec);
    if (errs.length) return { ok: false, errors: errs };
    _presets[rec.id] = _clone(rec);
    _persist();
    V.bus.emit('vx:preset-saved', { id: rec.id, name: rec.name, version: 1 });
    return { ok: true, preset: _clone(rec) };
  }

  // Edit: append-only. The old versioned record is never mutated; a new record
  // with version = old + 1 and parentId = old id is stored.
  function edit(id, changes) {
    var old = _presets[id];
    if (!old) return { ok: false, errors: ['unknown preset ' + id] };
    var rec = _clone(old);
    changes = changes || {};
    if (changes.name !== undefined) rec.name = changes.name;
    if (changes.params !== undefined) rec.params = _clone(changes.params);
    if (changes.configId !== undefined) rec.configId = changes.configId;
    if (changes.probeDefaults !== undefined) rec.probeDefaults = _clone(changes.probeDefaults);
    if (changes.thumbnail !== undefined) rec.thumbnail = changes.thumbnail;
    else if (changes.canvas !== undefined) rec.thumbnail = captureThumbnail(changes.canvas);
    rec.parentId = old.id;
    rec.version = old.version + 1;
    var base = old.id.replace(/-v\d+$/, '');
    var nid = _mkId(base, rec.version), n = rec.version;
    while (_presets[nid]) { n += 1; nid = _mkId(base + '-fork', n); }
    rec.id = nid;
    rec.createdAt = _now();
    var errs = _validate(rec);
    if (errs.length) return { ok: false, errors: errs };
    _presets[rec.id] = _clone(rec); // stored copy; caller's old record untouched
    _persist();
    V.bus.emit('vx:preset-saved', { id: rec.id, name: rec.name, version: rec.version });
    return { ok: true, preset: _clone(rec) };
  }

  // Fork/remix: new record with a fresh id, parentId chain to the source.
  function fork(id, name) {
    var src = _presets[id];
    if (!src) return { ok: false, errors: ['unknown preset ' + id] };
    var rec = _clone(src);
    rec.parentId = src.id;
    rec.version = 1;
    rec.name = name || (src.name + ' (remix)');
    rec.thumbnail = null; // thumbnails are per-record; recapture at save
    var base = 'vx-' + rec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var nid = _mkId(base, 1), n = 1;
    while (_presets[nid]) { n += 1; nid = _mkId(base + '-' + n, 1); }
    rec.id = nid;
    rec.createdAt = _now();
    var errs = _validate(rec);
    if (errs.length) return { ok: false, errors: errs };
    _presets[rec.id] = _clone(rec);
    _persist();
    V.bus.emit('vx:preset-saved', { id: rec.id, name: rec.name, version: 1, forkedFrom: src.id });
    return { ok: true, preset: _clone(rec) };
  }

  function remove(id) {
    if (!_presets[id]) return { ok: false, errors: ['unknown preset ' + id] };
    if (_presets[id].parentId === null) {
      return { ok: false, errors: ['built-in presets cannot be removed'] };
    }
    delete _presets[id];
    _persist();
    return { ok: true };
  }

  // lineage(id): ancestor records, oldest first (self last).
  function lineage(id) {
    var chain = [];
    var seen = {};
    var cur = _presets[id];
    while (cur && !seen[cur.id]) {
      seen[cur.id] = true;
      chain.unshift(_clone(cur));
      cur = cur.parentId ? _presets[cur.parentId] : null;
    }
    return chain;
  }

  // -------------------------------------------------------------- collections

  function _seedCollections() {
    if (_collections['merger-studies']) return; // already seeded/restored
    _collections = {
      'merger-studies': {
        id: 'merger-studies', name: 'Merger studies',
        presetIds: ['vx-collision-v1']
      },
      'teach-her-curriculum': {
        id: 'teach-her-curriculum', name: 'Teach-her curriculum',
        presetIds: ['vx-spiral-v1', 'vx-collision-v1', 'vx-wake-v1']
      },
      'overnight-queue-seeds': {
        id: 'overnight-queue-seeds', name: 'Overnight queue seeds',
        presetIds: ['vx-spiral-v1', 'vx-collision-v1', 'vx-wake-v1']
      }
    };
  }

  function createCollection(name) {
    var id = 'col-' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var n = 1, nid = id;
    while (_collections[nid]) { n += 1; nid = id + '-' + n; }
    _collections[nid] = { id: nid, name: name, presetIds: [] };
    _persist();
    return _clone(_collections[nid]);
  }

  function addToCollection(colId, presetId) {
    var c = _collections[colId];
    if (!c) return { ok: false, errors: ['unknown collection ' + colId] };
    if (!_presets[presetId]) return { ok: false, errors: ['unknown preset ' + presetId] };
    if (c.presetIds.indexOf(presetId) === -1) c.presetIds.push(presetId);
    _persist();
    return { ok: true, collection: _clone(c) };
  }

  function removeFromCollection(colId, presetId) {
    var c = _collections[colId];
    if (!c) return { ok: false, errors: ['unknown collection ' + colId] };
    c.presetIds = c.presetIds.filter(function (p) { return p !== presetId; });
    _persist();
    return { ok: true, collection: _clone(c) };
  }

  function listCollections() {
    return Object.keys(_collections).sort().map(function (id) { return _clone(_collections[id]); });
  }

  // ------------------------------------------------------------------ export

  function _b64urlEncode(str) {
    // JSON -> UTF-8 -> base64url. Guarded for headless/node.
    try {
      var b64;
      if (typeof root.btoa === 'function') {
        b64 = root.btoa(unescape(encodeURIComponent(str)));
      } else if (typeof Buffer !== 'undefined') {
        b64 = Buffer.from(str, 'utf8').toString('base64');
      } else { return null; }
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return null; }
  }

  function _b64urlDecode(s) {
    try {
      var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var str;
      if (typeof root.atob === 'function') {
        str = decodeURIComponent(escape(root.atob(b64)));
      } else if (typeof Buffer !== 'undefined') {
        str = Buffer.from(b64, 'base64').toString('utf8');
      } else { return null; }
      return JSON.parse(str);
    } catch (e) { return null; }
  }

  // .vortex file: JSON download via Blob + a.download. Guarded: headless or
  // any failure -> { ok:false } without throwing.
  function exportFile(id) {
    var rec = _presets[id];
    if (!rec) return { ok: false, errors: ['unknown preset ' + id] };
    try {
      if (!V.utils.isBrowser() || typeof root.Blob === 'undefined') {
        return { ok: false, errors: ['no browser download surface'] };
      }
      var blob = new root.Blob([JSON.stringify(_clone(rec), null, 2)], { type: 'application/json' });
      var url = root.URL.createObjectURL(blob);
      var a = root.document.createElement('a');
      a.href = url;
      a.download = rec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.vortex';
      root.document.body.appendChild(a);
      a.click();
      root.document.body.removeChild(a);
      setTimeout(function () { try { root.URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      return { ok: true };
    } catch (e) {
      return { ok: false, errors: ['export failed: ' + e.message] };
    }
  }

  // URL link: preset encoded into location hash (#p=<base64url>).
  function exportLink(id) {
    var rec = _presets[id];
    if (!rec) return { ok: false, errors: ['unknown preset ' + id] };
    var enc = _b64urlEncode(JSON.stringify(_clone(rec)));
    if (enc === null) return { ok: false, errors: ['encoding unavailable'] };
    var base = '';
    try {
      if (V.utils.isBrowser() && root.location) {
        base = root.location.href.split('#')[0];
      }
    } catch (e) {}
    return { ok: true, hash: '#p=' + enc, url: base + '#p=' + enc };
  }

  // importFromHash(): reads location.hash (guarded), decodes, validates, stores.
  function importFromHash(hash) {
    try {
      var h = hash;
      if (h === undefined && V.utils.isBrowser() && root.location) h = root.location.hash;
      if (typeof h !== 'string' || h.indexOf('#p=') !== 0) {
        return { ok: false, errors: ['no preset in hash'] };
      }
      var rec = _b64urlDecode(h.slice(3));
      if (!rec) return { ok: false, errors: ['hash decode failed'] };
      // re-id to avoid collisions with existing lineage
      rec.thumbnail = rec.thumbnail || null;
      var saved = save({
        name: rec.name || 'imported',
        parentId: rec.parentId || null,
        params: rec.params || {},
        configId: rec.configId,
        probeDefaults: rec.probeDefaults || [],
        thumbnail: rec.thumbnail
      });
      if (!saved.ok) return saved;
      return { ok: true, preset: saved.preset };
    } catch (e) {
      return { ok: false, errors: ['import failed: ' + e.message] };
    }
  }

  // import a .vortex JSON payload (e.g. read by W01 from a file input).
  function importJson(json) {
    try {
      var rec = typeof json === 'string' ? JSON.parse(json) : json;
      if (_validate(rec).length) {
        // tolerate foreign-but-shaped payloads via save()
        rec = null;
      }
      return save({
        name: (json && json.name) || 'imported',
        parentId: (json && json.parentId) || null,
        params: (json && json.params) || {},
        configId: (json && json.configId) || 'spiral-default',
        probeDefaults: (json && json.probeDefaults) || [],
        thumbnail: (json && json.thumbnail) || null
      });
    } catch (e) {
      return { ok: false, errors: ['invalid .vortex payload'] };
    }
  }

  // ------------------------------------------------------------------ apply

  // Find the live field backend without depending on exact module ids.
  function _findBackend() {
    try {
      var ids = V.modules();
      for (var i = 0; i < ids.length; i++) {
        var m = V.get(ids[i]);
        if (!m) continue;
        if (typeof m.getBackend === 'function') {
          var b = m.getBackend();
          if (b && typeof b.setParams === 'function') return b;
        }
        if (typeof m.setParams === 'function' && typeof m.step === 'function') return m;
      }
    } catch (e) {}
    return null;
  }

  // Find the W04 field-config module (registered as w04-configs).
  function _findConfigApi() {
    try {
      var ids = V.modules();
      for (var i = 0; i < ids.length; i++) {
        var m = V.get(ids[i]);
        if (m && (typeof m.applyConfig === 'function' || typeof m.getConfig === 'function')) return m;
      }
      var cand = V.get('w04-field-configs') || V.get('w04-configs');
      if (cand) return cand;
    } catch (e) {}
    return null;
  }

  // applyPreset(id): sets backend params (uniforms, no recompile) + config via
  // W04 (guarded), then emits vx:preset. Never throws.
  function applyPreset(id) {
    var rec = _presets[id];
    if (!rec) return { ok: false, errors: ['unknown preset ' + id] };
    var notes = [];
    // 1) field backend params via field contract (uniforms, no recompile)
    try {
      var backend = _findBackend();
      if (backend) {
        backend.setParams({
          circulation: rec.params.circulation,
          turbulence: rec.params.turbulence,
          persistence: rec.params.persistence,
          seed: rec.params.seed
        });
        notes.push('backend params set');
      } else {
        notes.push('no field backend registered; params not pushed (panel still usable)');
      }
    } catch (e) {
      notes.push('backend setParams failed: ' + e.message);
    }
    // 2) field config via W04 (guarded)
    try {
      var cfg = _findConfigApi();
      if (cfg && typeof cfg.applyConfig === 'function') {
        cfg.applyConfig(rec.configId);
        notes.push('config ' + rec.configId + ' applied');
      } else if (cfg && typeof cfg.getConfig === 'function') {
        cfg.getConfig(rec.configId);
        notes.push('config ' + rec.configId + ' fetched (no applyConfig)');
      } else {
        notes.push('no W04 config module registered; configId recorded only');
      }
    } catch (e) {
      notes.push('config apply failed: ' + e.message);
    }
    var detail = { id: rec.id, name: rec.name, version: rec.version, configId: rec.configId, notes: notes };
    V.bus.emit('vx:preset', detail);
    return { ok: true, notes: notes, detail: detail };
  }

  // --------------------------------------------------------------- W01 shell

  // Stable entry points for the W01 shell's Spiral / Collision / Wake buttons:
  //   VORTEX.get('w18-presets').applyPreset('vx-spiral-v1') etc.
  var BUILTIN_IDS = { spiral: 'vx-spiral-v1', collision: 'vx-collision-v1', wake: 'vx-wake-v1' };

  // ------------------------------------------------------------------ panel

  function _el(tag, cls, text) {
    var d = root.document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  function mountPanel(host) {
    if (!host || !V.utils.isBrowser()) return;
    host.innerHTML = '';
    var wrap = _el('div', 'vx-presets-panel');

    var toolbar = _el('div', 'vx-presets-toolbar');
    var filter = _el('select', 'vx-presets-filter');
    function refreshFilter() {
      filter.innerHTML = '';
      var all = _el('option', null, 'All presets'); all.value = '';
      filter.appendChild(all);
      listCollections().forEach(function (c) {
        var o = _el('option', null, c.name); o.value = c.id; filter.appendChild(o);
      });
    }
    refreshFilter();
    toolbar.appendChild(filter);
    var saveBtn = _el('button', 'vx-btn', 'Save current as preset');
    saveBtn.onclick = function () {
      var name = 'Custom ' + _now().slice(11, 19);
      var r = save({ name: name });
      if (r.ok) { render(); V.ui.announce('Preset saved: ' + r.preset.name); }
      else V.ui.announce('Preset save failed: ' + r.errors.join(', '));
    };
    toolbar.appendChild(saveBtn);
    wrap.appendChild(toolbar);

    var grid = _el('div', 'vx-presets-grid');
    wrap.appendChild(grid);

    function render() {
      refreshFilter();
      grid.innerHTML = '';
      var colId = filter.value;
      var ids = null;
      if (colId) {
        var col = null;
        listCollections().forEach(function (c) { if (c.id === colId) col = c; });
        ids = col ? col.presetIds : [];
      }
      var recs = list().filter(function (r) { return !ids || ids.indexOf(r.id) !== -1; });
      if (!recs.length) {
        grid.appendChild(_el('div', 'vx-presets-empty', 'No presets in this collection yet.'));
        return;
      }
      recs.forEach(function (rec) {
        var card = _el('div', 'vx-preset-card');
        if (rec.thumbnail) {
          var img = _el('img', 'vx-preset-thumb');
          img.src = rec.thumbnail;
          img.alt = rec.name + ' thumbnail';
          card.appendChild(img);
        } else {
          card.appendChild(_el('div', 'vx-preset-thumb vx-preset-thumb-none', 'no preview'));
        }
        card.appendChild(_el('div', 'vx-preset-name', rec.name));
        card.appendChild(_el('div', 'vx-preset-meta',
          'v' + rec.version + (rec.parentId ? ' · fork' : ' · built-in') + ' · ' + rec.configId));
        var row = _el('div', 'vx-preset-actions');
        var apply = _el('button', 'vx-btn', 'Apply');
        apply.onclick = function () {
          var r = applyPreset(rec.id);
          V.ui.announce(r.ok ? 'Preset applied: ' + rec.name : 'Apply failed');
        };
        var forkBtn = _el('button', 'vx-btn', 'Fork');
        forkBtn.onclick = function () {
          var r = fork(rec.id);
          if (r.ok) { render(); V.ui.announce('Forked as ' + r.preset.name); }
          else V.ui.announce('Fork failed: ' + r.errors.join(', '));
        };
        var dlBtn = _el('button', 'vx-btn', '.vortex');
        dlBtn.title = 'Download .vortex file';
        dlBtn.onclick = function () {
          var r = exportFile(rec.id);
          V.ui.announce(r.ok ? 'Exported ' + rec.name + '.vortex' : 'Export unavailable here');
        };
        var linkBtn = _el('button', 'vx-btn', 'Link');
        linkBtn.title = 'Copy shareable URL link';
        linkBtn.onclick = function () {
          var r = exportLink(rec.id);
          if (r.ok && root.navigator && root.navigator.clipboard) {
            root.navigator.clipboard.writeText(r.url).then(function () {
              V.ui.announce('Link copied');
            }, function () { V.ui.announce('Link: ' + r.url); });
          } else if (r.ok) {
            V.ui.announce('Link: ' + r.url);
          } else {
            V.ui.announce('Link export failed: ' + r.errors.join(', '));
          }
        };
        row.appendChild(apply); row.appendChild(forkBtn);
        row.appendChild(dlBtn); row.appendChild(linkBtn);
        card.appendChild(row);
        grid.appendChild(card);
      });
    }
    filter.onchange = render;
    V.bus.on('vx:preset-saved', render);
    render();
    host.appendChild(wrap);
  }

  // ---------------------------------------------------------------- selfTest

  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }

    // 1) built-ins validate
    var have = list();
    var ids = have.map(function (r) { return r.id; });
    var builtinOk = ids.indexOf('vx-spiral-v1') !== -1 &&
                    ids.indexOf('vx-collision-v1') !== -1 &&
                    ids.indexOf('vx-wake-v1') !== -1;
    var allValid = have.every(function (r) { return _validate(r).length === 0; });
    check('built-ins exist + validate', builtinOk && allValid,
      'presets=' + have.length + ', spiral/collision/wake present=' + builtinOk);

    // Spiral matches W19 1-vortex scene
    var spiral = get('vx-spiral-v1');
    var sceneOk = spiral && spiral.params.scene &&
      spiral.params.scene.mode === 'spiral' &&
      Array.isArray(spiral.params.scene.vortices) &&
      spiral.params.scene.vortices.length === 1;
    var coll = get('vx-collision-v1');
    var collOk = coll && coll.params.scene &&
      Array.isArray(coll.params.scene.vortices) &&
      coll.params.scene.vortices.length === 2;
    check('spiral=1v / collision=2v scenes', sceneOk && collOk,
      'spiral vortices=' + (spiral && spiral.params.scene.vortices.length) +
      ', collision vortices=' + (coll && coll.params.scene.vortices.length));

    // 2) fork lineage across 3 generations
    var f1 = fork('vx-spiral-v1', 't1');
    var f2 = f1.ok ? fork(f1.preset.id, 't2') : null;
    var f3 = f2 && f2.ok ? fork(f2.preset.id, 't3') : null;
    var lin = f3 && f3.ok ? lineage(f3.preset.id) : [];
    var linOk = f3 && f3.ok && lin.length === 4 &&
      lin[0].id === 'vx-spiral-v1' &&
      lin[3].id === f3.preset.id &&
      lin.every(function (r, i) {
        return i === 0 ? r.parentId === null : r.parentId === lin[i - 1].id;
      });
    check('fork lineage (3 generations)', linOk,
      'chain length=' + lin.length + ', ids=' + lin.map(function (r) { return r.id; }).join('>'));
    // clean up test forks (keep built-ins pristine)
    if (f1.ok) remove(f1.preset.id);
    if (f2 && f2.ok) remove(f2.preset.id);
    if (f3 && f3.ok) remove(f3.preset.id);

    // 3) version immutability: edit creates v2, v1 unchanged
    var before = JSON.stringify(get('vx-wake-v1'));
    var edited = edit('vx-wake-v1', { params: (function () {
      var p = _clone(get('vx-wake-v1').params); p.turbulence = 0.99; return p;
    })() });
    var after = JSON.stringify(get('vx-wake-v1'));
    var v2 = edited.ok ? get(edited.preset.id) : null;
    var immutOk = edited.ok && before === after &&
      edited.preset.version === 2 && edited.preset.parentId === 'vx-wake-v1' &&
      v2 && v2.params.turbulence === 0.99 &&
      get('vx-wake-v1').params.turbulence !== 0.99;
    check('version immutability (edit -> v2, v1 unchanged)', immutOk,
      'v1 hash-stable=' + (before === after) + ', new id=' + (edited.ok ? edited.preset.id : 'n/a'));
    if (edited.ok) remove(edited.preset.id);

    // 4) export/import round-trip via hash encoding
    var link = exportLink('vx-collision-v1');
    var imp = link.ok ? importFromHash(link.hash) : null;
    var rtOk = link.ok && imp && imp.ok &&
      imp.preset.name === 'Collision' &&
      JSON.stringify(imp.preset.params) === JSON.stringify(get('vx-collision-v1').params) &&
      JSON.stringify(imp.preset.probeDefaults) === JSON.stringify(get('vx-collision-v1').probeDefaults);
    check('hash export/import round-trip', rtOk,
      'link=' + (link.ok ? link.hash.slice(0, 12) + '...' : 'n/a') +
      ', reimported=' + (imp && imp.ok ? imp.preset.id : 'n/a'));
    if (imp && imp.ok) remove(imp.preset.id);

    // 5) collections reference existing presets
    var cols = listCollections();
    var colNames = ['merger-studies', 'teach-her-curriculum', 'overnight-queue-seeds'];
    var colsOk = colNames.every(function (n) {
      return cols.some(function (c) { return c.id === n; });
    });
    var refsOk = true, dangling = [];
    cols.forEach(function (c) {
      c.presetIds.forEach(function (pid) {
        if (!_presets[pid]) { refsOk = false; dangling.push(c.id + '->' + pid); }
      });
    });
    check('collections reference existing presets', colsOk && refsOk,
      'collections=' + cols.length + ', dangling=' + (dangling.join(',') || 'none'));

    // 6) headless thumbnail guard (no DOM/canvas here) — must return null, not throw
    var thumb = null, thumbOk = false;
    try { thumb = captureThumbnail(); thumbOk = (thumb === null); } catch (e) { thumbOk = false; }
    check('thumbnail headless guard', thumbOk, 'captureThumbnail()=' + JSON.stringify(thumb));

    // 7) applyPreset: event + graceful absence of backend/W04
    var got = null;
    V.bus.on('vx:preset', function (d) { got = d; });
    var ap = applyPreset('vx-spiral-v1');
    check('applyPreset emits vx:preset, never throws', ap.ok && got && got.id === 'vx-spiral-v1',
      'notes=' + (ap.notes || []).join('; '));

    // 8) edit of unknown id is a clean error (no throw)
    var bad = edit('no-such-preset', {});
    check('unknown-id edits/forks are clean errors', !bad.ok && !fork('nope', 'x').ok,
      'edit errors=' + bad.errors.join(','));

    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  // ------------------------------------------------------------------ boot

  _registerBuiltins();
  _restore();          // localStorage (guarded) — never overwrites built-ins
  _seedCollections();

  V.ui.registerPanel('presets', 'Presets', mountPanel);

  var api = {
    selfTest: selfTest,
    list: list, get: get, save: save, edit: edit, fork: fork, remove: remove,
    lineage: lineage,
    collections: listCollections, createCollection: createCollection,
    addToCollection: addToCollection, removeFromCollection: removeFromCollection,
    captureThumbnail: captureThumbnail,
    exportFile: exportFile, exportLink: exportLink,
    importFromHash: importFromHash, importJson: importJson,
    applyPreset: applyPreset,
    builtinIds: BUILTIN_IDS
  };

  V.register(MODULE_ID, api);
})(typeof window !== 'undefined' ? window : globalThis);
