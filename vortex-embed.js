/* vortex-embed.js — W33. MasterSwitch embed contract.
 *
 * One script tag boots VORTEX inside any dashboard page:
 *
 *   <script src="/simulation/vortex-embed.js" data-vortex-mode="lab"></script>
 *   <div id="vortex-root"></div>
 *
 * or programmatically:
 *
 *   var h = VortexEmbed.mount(el, { mode: 'lab' | 'observatory',
 *                                   basePath: '/simulation/vortex' });
 *   // h = { unmount(), ready, mode, version }
 *
 * mode 'lab'        -> full interactive lab  (W01 boot mode 'embedded')
 * mode 'observatory'-> read-only harness     (W01 boot mode 'observatory')
 *
 * Guard: if VORTEX.init.boot (W01, init.js) is absent, mount() throws a NAMED
 * error (VX_E_EMBED_INIT) immediately — never a hang, never a silent failure.
 * Contract version is recorded in the W33 workspace registry.
 *
 * Plain script, no modules, no network, no eval. Must run from file://.
 */
(function (root) {
  'use strict';

  var VERSION = '0.2.0-lane14';
  var CONTRACT = 'vortex-embed/1.0';

  // Named error for the W01-absence guard. Uses VORTEX.VortexError when the
  // namespace loaded; otherwise a plain Error carrying .code.
  function namedError(code, message) {
    var V = root.VORTEX;
    if (V && typeof V.VortexError === 'function') {
      return V.VortexError(code, message, 'embed');
    }
    var e = new Error('[' + code + '] ' + message);
    e.code = code;
    e.stage = 'embed';
    return e;
  }

  var _mounts = [];

  function bootMode(mode) {
    return mode === 'observatory' ? 'observatory' : 'embedded';
  }

  function mount(el, opts) {
    opts = opts || {};
    var mode = opts.mode || 'lab';
    if (mode !== 'lab' && mode !== 'observatory') {
      throw namedError('VX_E_SCRIPT_ERROR',
        'VortexEmbed.mount: mode must be "lab" or "observatory", got "' + mode + '".');
    }

    // ---- W01 guard FIRST: named error, never a hang ----
    var V = root.VORTEX;
    if (!V) {
      throw namedError('VX_E_NAMESPACE',
        'VortexEmbed.mount: the VORTEX namespace is not loaded. ' +
        'Load js/vx-namespace.js before vortex-embed.js.');
    }
    if (!V.init || typeof V.init.boot !== 'function') {
      throw namedError('VX_E_EMBED_INIT',
        'VortexEmbed.mount: VORTEX.init.boot is not available — init.js (W01 boot lane) ' +
        'has not loaded. The lab cannot start; nothing was mounted. ' +
        'Next step: include the W01 init script, or check for a VX_E_SCRIPT_ERROR in the console.');
    }

    // ---- element validation ----
    var doc = root.document;
    if (!el || el.nodeType !== 1 || typeof el.appendChild !== 'function') {
      throw namedError('VX_E_SCRIPT_ERROR',
        'VortexEmbed.mount: el must be a DOM element. Nothing was mounted.');
    }

    var handle = {
      version: VERSION,
      contract: CONTRACT,
      mode: mode,
      el: el,
      unmounted: false,
      bootResult: null,
      ready: null,
      unmount: function () { unmount(handle); }
    };

    // Container the lab owns. Removed on unmount.
    var container = doc.createElement('div');
    container.className = 'vortex-embed-root';
    container.setAttribute('data-vortex-embed-mode', mode);
    container.setAttribute('data-vortex-embed-contract', CONTRACT);
    el.appendChild(container);
    handle.container = container;

    var ready;
    try {
      ready = V.init.boot({
        root: container,
        mode: bootMode(mode),
        basePath: opts.basePath || '/simulation/vortex',
        protocolFamily: opts.protocolFamily || null
      });
    } catch (e) {
      // Synchronous boot failure: clean up the container, surface the error.
      if (container.parentNode) container.parentNode.removeChild(container);
      throw e;
    }
    handle.ready = ready;

    ready.then(function (res) {
      if (!handle.unmounted) handle.bootResult = res || null;
      try { V.bus.emit('vx:embed-mount', { mode: mode, contract: CONTRACT }); } catch (e) {}
    }, function (err) {
      // Boot rejected: narrate through the lab's own failure surface, then
      // clean up our container. Never leave a half-mounted shell.
      try {
        if (V.ui && typeof V.ui.fail === 'function') {
          V.ui.fail(err && err.code ? err.code : 'VX_E_SCRIPT_ERROR',
            (err && err.message) || 'VORTEX boot failed inside the embed.',
            'the host page is untouched');
        }
      } catch (e2) {}
      try { unmount(handle); } catch (e3) {}
    });

    _mounts.push(handle);
    return handle;
  }

  function unmount(handle) {
    if (!handle || handle.unmounted) return;
    handle.unmounted = true;
    // Dispose the backend if boot completed — guarded, best effort.
    try {
      var b = handle.bootResult && handle.bootResult.backend;
      if (b && typeof b.dispose === 'function') b.dispose();
    } catch (e) {}
    try {
      if (handle.container && handle.container.parentNode) {
        handle.container.parentNode.removeChild(handle.container);
      }
    } catch (e2) {}
    try {
      var V = root.VORTEX;
      if (V && V.bus) V.bus.emit('vx:embed-unmount', { mode: handle.mode });
    } catch (e3) {}
    var i = _mounts.indexOf(handle);
    if (i >= 0) _mounts.splice(i, 1);
  }

  // ---- auto-mount from <script data-vortex-mode="..."> ----
  function currentScript() {
    var doc = root.document;
    if (!doc) return null;
    if (doc.currentScript) return doc.currentScript;
    var scripts = doc.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].getAttribute && scripts[i].hasAttribute('data-vortex-mode')) return scripts[i];
    }
    return null;
  }

  function autoMount() {
    var doc = root.document;
    if (!doc) return null;
    var script = currentScript();
    if (!script) return null;
    var mode = script.getAttribute('data-vortex-mode') || 'lab';
    if (script.getAttribute('data-vortex-mount') === 'false') return null;
    var target = doc.getElementById('vortex-root') || script.parentNode;
    try {
      return mount(target, {
        mode: mode,
        basePath: script.getAttribute('data-vortex-base') || '/simulation/vortex',
        protocolFamily: script.getAttribute('data-vortex-family') || null
      });
    } catch (e) {
      // Named error, on screen, never a hang: write into the target when we can.
      try {
        var box = doc.createElement('div');
        box.className = 'vortex-embed-error';
        box.textContent = 'VORTEX embed failed: ' + (e && e.code ? e.code : 'unknown') +
          ' — ' + (e && e.message ? e.message : String(e));
        (target && target.appendChild ? target : doc.body).appendChild(box);
      } catch (e2) {}
      return null;
    }
  }

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', autoMount);
    } else {
      try { autoMount(); } catch (e) {}
    }
  }

  var api = {
    version: VERSION,
    contract: CONTRACT,
    mount: mount,
    unmount: unmount,
    autoMount: autoMount,
    mounts: function () { return _mounts.slice(); },
    selfTest: function () {
      var checks = [];
      function check(name, fn) {
        try {
          var r = fn();
          checks.push({ name: name, ok: !!r.ok, detail: r.detail || '' });
        } catch (e) {
          checks.push({ name: name, ok: false, detail: 'threw: ' + (e && e.message) });
        }
      }
      check('version + contract present', function () {
        return { ok: api.version === '0.2.0-lane14' && api.contract === 'vortex-embed/1.0',
                 detail: api.version + ' / ' + api.contract };
      });
      check('mount with missing VORTEX.init throws NAMED VX_E_EMBED_INIT (no hang)', function () {
        var V = root.VORTEX;
        if (!V) return { ok: false, detail: 'namespace absent — embed cannot run here at all' };
        var saved = V.init;
        try {
          V.init = undefined;
          var threw = null;
          try { api.mount({}, { mode: 'lab' }); } catch (e) { threw = e; }
          if (!threw) return { ok: false, detail: 'mount() did NOT throw — would hang' };
          return { ok: threw.code === 'VX_E_EMBED_INIT',
                   detail: 'code=' + threw.code };
        } finally {
          V.init = saved;
        }
      });
      check('mount validates mode', function () {
        var V = root.VORTEX;
        if (!V || !V.init) return { ok: true, detail: 'skipped — init absent (guard check above covers it)' };
        var threw = null;
        try { api.mount({}, { mode: 'nope' }); } catch (e) { threw = e; }
        return { ok: !!threw && !!threw.code, detail: threw ? threw.code : 'no throw' };
      });
      var okAll = checks.every(function (c) { return c.ok; });
      return { ok: okAll, checks: checks };
    }
  };

  root.VortexEmbed = api;
})(typeof window !== 'undefined' ? window : globalThis);
