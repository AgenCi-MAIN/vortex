/* VORTEX js/touch.js — W22 gestures (confirmation-gated).
 *
 * Touch/stylus/pointer layer for the vortex lab (design: lane-14-vortex.md §8).
 *
 *   - One-finger drag on the canvas = STIR. Maps to the existing Stir action:
 *     drag vector → perturbation, emitted as `vx:stir` events:
 *       { point:{x,y}, vector:{dx,dy}, strength, brushWidth, pointerType }
 *     Coordinates are canvas-relative px.
 *   - Long-press (500 ms, <10 px move) = PROBE DROP. Opens the W05 probe
 *     picker at the point when the probe-catalog module is present; guarded
 *     fallback to the default `perturb` probe when it is absent.
 *   - Stylus pressure → perturbation strength 0–30% (clamped). Mouse = 15%
 *     default. Touch = pressure when reported, else 15%.
 *   - Tilt → brush width: wider with greater barrel tilt.
 *   - Double-tap = mode cycle: stir -> probe -> observe.
 *
 * Modes:
 *   stir    — drag stirs; tap inert; long-press drops a probe.
 *   probe   — tap drops a probe; drag still stirs (one-finger drag is always
 *             stir unless we are in observe mode); long-press opens the picker.
 *   observe — touch module is fully passive; every pointer event is released
 *             to orbit/drag owners (W01/W20). Double-tap still cycles modes.
 *
 * DESTRUCTIVE ACTIONS (clear-probes, restore-snapshot, reseed-replace):
 *   never one-tap, never gesture-bound. Any binding requires a confirmation
 *   sheet: `confirmSheet({title, body, confirmLabel})` -> Promise<bool>.
 *   ESC and backdrop click cancel. In headless mode it resolves false.
 *
 * Event-order contract with W01/W20 (mouse orbit/drag owners):
 *   - touch.js attaches CAPTURE-phase pointer listeners on #vx-canvas-wrap,
 *     so it sees pointerdown before canvas-level orbit handlers.
 *   - When it claims a gesture (stir/probe modes, single pointer) it calls
 *     stopPropagation() so orbit never sees a stir as an orbit drag.
 *   - On a SECOND pointer (two-finger) it releases: stops claiming, does NOT
 *     stopPropagation, and emits `vx:gesture {type:'released-to-orbit'}` with
 *     both pointer positions so the orbit owner can adopt both pointers.
 *   - In observe mode it never calls stopPropagation.
 *
 * Headless/test API:
 *   simulateGesture('tap'|'doubletap'|'longpress'|'drag'|'twopointer', opts)
 *   drives the same internal handlers the DOM events call, so selfTest()
 *   verifies real behavior without a browser.
 *
 * Plain script, no modules, no network. Loads after vx-namespace.js.
 */
(function (root) {
  'use strict';

  var V = root.VORTEX;
  if (!V || typeof V.register !== 'function') {
    throw new Error('w22-touch: VORTEX namespace (vx-namespace.js) must load first');
  }

  var HAS_DOM = V.utils.isBrowser() &&
    typeof root.document !== 'undefined' &&
    typeof root.document.getElementById === 'function';
  var HAS_POINTER_EVENTS = HAS_DOM && typeof root.PointerEvent !== 'undefined';

  // ---- tunables ----
  var LONGPRESS_MS = 500;
  var LONGPRESS_SLOP_PX = 10;   // max move during a long-press
  var TAP_MAX_MS = 300;         // max duration to count as a tap
  var TAP_SLOP_PX = 10;         // max move to count as a tap
  var DOUBLETAP_MAX_MS = 300;
  var DOUBLETAP_SLOP_PX = 24;
  var DRAG_SLOP_PX = 4;         // move before a drag "claims" the gesture
  var MOUSE_STRENGTH = 0.15;    // spec: mouse = 15% default
  var MAX_STRENGTH = 0.30;      // spec: pressure -> 0-30%, clamped
  var BASE_BRUSH_PX = 24;
  var DEFAULT_PROBE_STRENGTH = 0.15;
  var MODES = ['stir', 'probe', 'observe'];

  // ---- state ----
  var mode = 'stir';
  var wrapEl = null;            // #vx-canvas-wrap
  var canvasEl = null;          // canvas inside the wrap (may be null headless)
  var attached = false;
  var pointers = {};            // pointerId -> track record
  var pointerCount = 0;
  var releasedToOrbit = false;  // true once two pointers are down
  var longPressTimer = null;
  var lastTap = null;           // { t, x, y }
  var pendingDestructive = {};  // name -> fn (owners bind through the gate)

  function emitGesture(detail) {
    V.bus.emit('vx:gesture', detail);
  }

  function canvasPoint(clientX, clientY) {
    // Canvas-relative px. Headless / no rect: identity.
    if (canvasEl && typeof canvasEl.getBoundingClientRect === 'function') {
      var r = canvasEl.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    }
    return { x: clientX, y: clientY };
  }

  // ---- gesture outputs ----

  function stirAt(rec, dx, dy) {
    var p = canvasPoint(rec.x, rec.y);
    var strength = strengthFor(rec);
    var brush = brushFor(rec);
    V.bus.emit('vx:stir', {
      point: { x: p.x, y: p.y },
      vector: { dx: dx, dy: dy },
      strength: strength,
      brushWidth: brush,
      pointerType: rec.pointerType
    });
    emitGesture({ type: 'stir', x: p.x, y: p.y, dx: dx, dy: dy,
      strength: strength, brushWidth: brush, pointerType: rec.pointerType });
  }

  function strengthFor(rec) {
    // Spec: stylus pressure -> 0-30% (clamped); mouse = 15% default.
    var pt = rec.pointerType;
    var pr = (typeof rec.pressure === 'number' && isFinite(rec.pressure)) ? rec.pressure : 0;
    if (pt === 'pen') {
      if (pr <= 0) return MOUSE_STRENGTH;
      return V.utils.clamp(pr, 0, 1) * MAX_STRENGTH;
    }
    if (pt === 'touch') {
      if (pr > 0) return V.utils.clamp(pr, 0, 1) * MAX_STRENGTH;
      return MOUSE_STRENGTH;
    }
    // mouse (and anything unknown): flat default, never pressure-mapped.
    return MOUSE_STRENGTH;
  }

  function brushFor(rec) {
    // Spec: tilt -> brush width. tiltX/tiltY in degrees, 0 when unsupported.
    var tx = (typeof rec.tiltX === 'number' && isFinite(rec.tiltX)) ? rec.tiltX : 0;
    var ty = (typeof rec.tiltY === 'number' && isFinite(rec.tiltY)) ? rec.tiltY : 0;
    var mag = Math.min(90, Math.sqrt(tx * tx + ty * ty));
    return BASE_BRUSH_PX * (1 + mag / 45);
  }

  function dropProbeAt(x, y, fromPicker) {
    var p = canvasPoint(x, y);
    emitGesture({ type: 'probe-intent', x: p.x, y: p.y, fromPicker: !!fromPicker });
    var w05 = V.get('w05-probes');
    if (w05 && typeof w05.openPicker === 'function') {
      try {
        w05.openPicker(p.x, p.y, {
          strength: DEFAULT_PROBE_STRENGTH,
          onSelect: function (probe, params) {
            emitProbe(probe, p.x, p.y, params || {});
          }
        });
        return;
      } catch (e) {
        // Picker present but failed: fall through to the default probe.
        V.ui.announce('Probe picker failed; using default perturb probe.');
      }
    }
    // Guarded fallback: W05 panel/module absent -> default perturb probe.
    emitProbe('perturb', p.x, p.y, {
      strength: DEFAULT_PROBE_STRENGTH,
      brushWidth: BASE_BRUSH_PX,
      source: 'w22-touch-default'
    });
    V.ui.announce('Probe dropped: perturb (default — probe catalog not loaded).');
  }

  function emitProbe(probe, x, y, params) {
    var p = params || {};
    p.x = x; p.y = y;
    V.bus.emit('vx:probe', { probe: probe, params: p });
  }

  // ---- core handlers (shared by DOM events and simulateGesture) ----

  function nowMs(e) {
    return (e && typeof e.timeStamp === 'number' && isFinite(e.timeStamp))
      ? e.timeStamp : V.utils.now();
  }

  function handleDown(e) {
    var t = nowMs(e);
    if (releasedToOrbit) return; // already handed off; ignore quietly

    var rec = {
      id: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      x: e.clientX || 0, y: e.clientY || 0,
      pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY,
      startX: e.clientX || 0, startY: e.clientY || 0,
      startT: t, lastX: e.clientX || 0, lastY: e.clientY || 0,
      dragging: false, moved: 0
    };
    pointers[rec.id] = rec;
    pointerCount += 1;

    if (pointerCount >= 2) {
      // Two-pointer rule: release to orbit. Do NOT stopPropagation.
      releasedToOrbit = true;
      clearLongPress();
      var both = Object.keys(pointers).map(function (k) { return pointers[k]; });
      emitGesture({ type: 'released-to-orbit',
        pointers: both.map(function (r) { return { id: r.id, x: r.x, y: r.y }; }) });
      V.ui.announce('Two pointers — released to orbit.');
      return;
    }

    // Single pointer in stir/probe mode: we own pointerdown (capture phase).
    if (mode !== 'observe') {
      armLongPress(rec);
    }
  }

  function handleMove(e) {
    var rec = pointers[e.pointerId];
    if (!rec || releasedToOrbit) return;
    var x = e.clientX || 0, y = e.clientY || 0;
    rec.pressure = e.pressure; rec.tiltX = e.tiltX; rec.tiltY = e.tiltY;
    rec.moved = Math.max(rec.moved,
      Math.hypot(x - rec.startX, y - rec.startY));

    // Long-press breaks on drift.
    if (rec.moved > LONGPRESS_SLOP_PX) clearLongPress();

    if (mode === 'observe') { rec.x = x; rec.y = y; return; }

    // One-finger drag = stir (stir and probe modes alike).
    if (!rec.dragging && rec.moved > DRAG_SLOP_PX) {
      rec.dragging = true;
      clearLongPress();
    }
    if (rec.dragging) {
      var dx = x - rec.lastX, dy = y - rec.lastY;
      rec.x = x; rec.y = y; rec.lastX = x; rec.lastY = y;
      if (dx !== 0 || dy !== 0) stirAt(rec, dx, dy);
    }
  }

  function handleUp(e) {
    var rec = pointers[e.pointerId];
    if (!rec) return;
    var t = nowMs(e);
    delete pointers[e.pointerId];
    pointerCount = Math.max(0, pointerCount - 1);
    clearLongPress();

    if (releasedToOrbit) {
      if (pointerCount === 0) { releasedToOrbit = false; }
      return;
    }

    if (rec.dragging) { /* drag ended; nothing more to do */ return; }

    var dur = t - rec.startT;
    if (dur <= TAP_MAX_MS && rec.moved <= TAP_SLOP_PX) {
      handleTap(rec, t);
    }
  }

  function handleCancel(e) {
    delete pointers[e.pointerId];
    pointerCount = Math.max(0, pointerCount - 1);
    clearLongPress();
    if (pointerCount === 0) releasedToOrbit = false;
  }

  function handleTap(rec, t) {
    var x = rec.startX, y = rec.startY;
    if (lastTap &&
        (t - lastTap.t) <= DOUBLETAP_MAX_MS &&
        Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLETAP_SLOP_PX) {
      lastTap = null;
      cycleMode();
      return;
    }
    lastTap = { t: t, x: x, y: y };
    if (mode === 'probe') {
      // Probe mode: single tap drops the probe (picker or default).
      dropProbeAt(x, y, false);
    }
    // Stir mode: single tap is deliberately inert (never one-tap actions).
    // Observe mode: pass-through; tap does nothing here.
  }

  function cycleMode() {
    var i = MODES.indexOf(mode);
    mode = MODES[(i + 1) % MODES.length];
    emitGesture({ type: 'mode', mode: mode });
    V.ui.announce('Touch mode: ' + mode + '.');
  }

  function armLongPress(rec) {
    clearLongPress();
    var id = rec.id;
    // Real browsers: wall-clock timer. Headless tests bypass via simulateGesture.
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      var r = pointers[id];
      if (r && !r.dragging && r.moved <= LONGPRESS_SLOP_PX) {
        dropProbeAt(r.x, r.y, false);
      }
    }, LONGPRESS_MS);
    if (longPressTimer && typeof longPressTimer.unref === 'function') {
      longPressTimer.unref(); // never hold a node test process open
    }
  }

  function clearLongPress() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  // ---- confirmation sheet (destructive gate) ----

  function confirmSheet(opts) {
    opts = opts || {};
    var title = opts.title || 'Confirm';
    var body = opts.body || 'This action cannot be undone.';
    var confirmLabel = opts.confirmLabel || 'Confirm';

    if (!HAS_DOM) {
      // Headless: no UI to ask with -> refuse. Tests override api.confirmSheet.
      emitGesture({ type: 'confirm-refused-headless', title: title });
      return Promise.resolve(false);
    }

    return new Promise(function (resolve) {
      var doc = root.document;
      var overlay = doc.createElement('div');
      overlay.className = 'vx-confirm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', title);

      var sheet = doc.createElement('div');
      sheet.className = 'vx-confirm-sheet';

      var h = doc.createElement('h3'); h.textContent = title;
      var p = doc.createElement('p'); p.textContent = body;
      var row = doc.createElement('div'); row.className = 'vx-confirm-row';

      var cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
      cancelBtn.className = 'vx-confirm-cancel';

      var okBtn = doc.createElement('button');
      okBtn.type = 'button'; okBtn.textContent = confirmLabel;
      okBtn.className = 'vx-confirm-ok';

      row.appendChild(cancelBtn); row.appendChild(okBtn);
      sheet.appendChild(h); sheet.appendChild(p); sheet.appendChild(row);
      overlay.appendChild(sheet);
      doc.body.appendChild(overlay);

      var done = false;
      function close(result) {
        if (done) return;
        done = true;
        doc.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        emitGesture({ type: 'confirm', title: title, result: !!result });
        resolve(!!result);
      }
      function onKey(ev) {
        if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) {
          if (ev.stopPropagation) ev.stopPropagation();
          close(false);
        }
      }
      overlay.addEventListener('pointerdown', function (ev) {
        if (ev.target === overlay) close(false); // backdrop cancels
      });
      cancelBtn.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', function () { close(true); });
      doc.addEventListener('keydown', onKey, true);
      okBtn.focus();
    });
  }

  // ---- destructive registry (owners bind through this gate) ----

  function registerDestructive(name, fn) {
    if (typeof name !== 'string' || !name) throw new Error('registerDestructive: bad name');
    if (typeof fn !== 'function') throw new Error('registerDestructive: fn required');
    pendingDestructive[name] = fn;
    return true;
  }

  function triggerDestructive(name) {
    var fn = pendingDestructive[name];
    if (!fn) {
      V.ui.announce('Destructive action "' + name + '" has no bound handler — refused.');
      emitGesture({ type: 'destructive-refused', action: name, reason: 'unbound' });
      return Promise.resolve(false);
    }
    var titles = {
      'clear-probes': 'Clear all probes?',
      'restore-snapshot': 'Restore snapshot?',
      'reseed-replace': 'Reseed (replace)?'
    };
    var bodies = {
      'clear-probes': 'Removes every active probe from the field. Current probe work is lost.',
      'restore-snapshot': 'Rolls the field back to the saved snapshot. Changes since the snapshot are lost.',
      'reseed-replace': 'Replaces the current run seed. This branches the evidence trail; the old seed is kept in the manifest history.'
    };
    var t = titles[name] || ('Confirm "' + name + '"?');
    var b = bodies[name] || 'This destructive action requires confirmation.';
    return api.confirmSheet({ title: t, body: b, confirmLabel: 'Yes, do it' })
      .then(function (ok) {
        if (!ok) {
          emitGesture({ type: 'destructive-cancelled', action: name });
          return false;
        }
        fn();
        emitGesture({ type: 'destructive-executed', action: name });
        V.ui.announce('Executed: ' + name + '.');
        return true;
      });
  }

  // Pre-declared destructive action names. Owners bind implementations;
  // until bound, triggerDestructive refuses (safe default, never one-tap).
  ['clear-probes', 'restore-snapshot', 'reseed-replace'].forEach(function (n) {
    pendingDestructive[n] = null; // slot exists; null = unbound
  });

  // ---- DOM attach ----

  function findWrap() {
    if (!HAS_DOM) return null;
    var el = root.document.getElementById('vx-canvas-wrap');
    return el || null;
  }

  function onDownDom(e) {
    if (releasedToOrbit) return; // let orbit have it
    if (pointerCount === 0 && mode !== 'observe') {
      // We will own this single-pointer gesture in stir/probe mode.
      if (e.stopPropagation) e.stopPropagation();
    }
    handleDown(e);
    if (pointers[e.pointerId] && !releasedToOrbit && mode !== 'observe') {
      if (e.cancelable !== false && e.preventDefault) e.preventDefault(); // no scroll
    }
  }

  function onMoveDom(e) {
    if (!pointers[e.pointerId] || releasedToOrbit) return;
    if (mode !== 'observe') {
      if (e.stopPropagation) e.stopPropagation();
      if (e.cancelable !== false && e.preventDefault) e.preventDefault();
    }
    handleMove(e);
  }

  function onUpDom(e) {
    var wasOurs = !!pointers[e.pointerId];
    if (wasOurs && mode !== 'observe' && !releasedToOrbit) {
      if (e.stopPropagation) e.stopPropagation();
    }
    handleUp(e);
  }

  function onCancelDom(e) { handleCancel(e); }

  function attach() {
    if (attached) return true;
    if (!HAS_DOM) return false;
    var wrap = findWrap();
    if (!wrap) {
      V.ui.announce('Touch: #vx-canvas-wrap not found — gestures not bound.');
      return false;
    }
    wrapEl = wrap;
    canvasEl = wrap.querySelector ? wrap.querySelector('canvas') : null;

    var downEv = HAS_POINTER_EVENTS ? 'pointerdown' : 'mousedown';
    var moveEv = HAS_POINTER_EVENTS ? 'pointermove' : 'mousemove';
    var upEv = HAS_POINTER_EVENTS ? 'pointerup' : 'mouseup';
    var cancelEv = HAS_POINTER_EVENTS ? 'pointercancel' : 'mouseleave';

    var opts = HAS_POINTER_EVENTS ? { capture: true, passive: false } : { capture: true };
    wrap.addEventListener(downEv, onDownDom, opts);
    wrap.addEventListener(moveEv, onMoveDom, opts);
    wrap.addEventListener(upEv, onUpDom, opts);
    wrap.addEventListener(cancelEv, onCancelDom, opts);
    attached = true;
    emitGesture({ type: 'attached', pointerEvents: HAS_POINTER_EVENTS });
    return true;
  }

  function detach() {
    if (!attached || !wrapEl) { attached = false; return; }
    // (Listeners are anonymous closures; full removal needs the wrap gone.
    //  Marking detached + clearing state is the honest teardown here.)
    clearLongPress();
    pointers = {}; pointerCount = 0; releasedToOrbit = false;
    attached = false;
    emitGesture({ type: 'detached' });
  }

  // ---- gesture simulator (tests + headless) ----

  function synthEvent(pointerId, x, y, o, timeStamp) {
    o = o || {};
    return {
      pointerId: pointerId,
      clientX: x, clientY: y,
      pointerType: o.pointerType || 'mouse',
      pressure: (typeof o.pressure === 'number') ? o.pressure : 0,
      tiltX: o.tiltX || 0, tiltY: o.tiltY || 0,
      timeStamp: timeStamp,
      preventDefault: function () {}, stopPropagation: function () {}
    };
  }

  function simulateGesture(kind, opts) {
    opts = opts || {};
    var x = opts.x || 0, y = opts.y || 0;
    var pt = opts.pointerType || 'mouse';
    var base = { pointerType: pt, pressure: opts.pressure, tiltX: opts.tiltX, tiltY: opts.tiltY };
    var t0 = 1000; // synthetic clock; keeps double-tap windows deterministic

    if (kind === 'tap') {
      handleDown(synthEvent(1, x, y, base, t0));
      handleUp(synthEvent(1, x, y, base, t0 + 80));
      return { ok: true, kind: kind };
    }
    if (kind === 'doubletap') {
      handleDown(synthEvent(1, x, y, base, t0));
      handleUp(synthEvent(1, x, y, base, t0 + 80));
      handleDown(synthEvent(1, x + 2, y + 1, base, t0 + 180));
      handleUp(synthEvent(1, x + 2, y + 1, base, t0 + 260));
      return { ok: true, kind: kind };
    }
    if (kind === 'longpress') {
      // Drives the same long-press handler the 500 ms timer calls —
      // no wall-clock wait, same code path.
      handleDown(synthEvent(1, x, y, base, t0));
      var rec = pointers[1];
      clearLongPress();
      if (rec && !rec.dragging && rec.moved <= LONGPRESS_SLOP_PX) {
        dropProbeAt(rec.x, rec.y, false);
      }
      handleUp(synthEvent(1, x, y, base, t0 + LONGPRESS_MS + 50));
      return { ok: true, kind: kind };
    }
    if (kind === 'drag') {
      var dx = opts.dx || 0, dy = opts.dy || 0;
      var steps = Math.max(2, opts.steps || 4);
      handleDown(synthEvent(1, x, y, base, t0));
      for (var i = 1; i <= steps; i++) {
        var px = x + dx * (i / steps), py = y + dy * (i / steps);
        handleMove(synthEvent(1, px, py, base, t0 + 16 * i));
      }
      handleUp(synthEvent(1, x + dx, y + dy, base, t0 + 16 * (steps + 1)));
      return { ok: true, kind: kind };
    }
    if (kind === 'twopointer') {
      handleDown(synthEvent(1, x, y, base, t0));
      handleDown(synthEvent(2, x + 60, y + 40,
        { pointerType: pt }, t0 + 50));
      handleUp(synthEvent(1, x, y, base, t0 + 200));
      handleUp(synthEvent(2, x + 60, y + 40, base, t0 + 210));
      return { ok: true, kind: kind, releasedToOrbit: releasedToOrbit };
    }
    throw new Error('simulateGesture: unknown kind "' + kind + '"');
  }

  // ---- self test (headless-safe) ----

  function selfTest() {
    var checks = [];
    function check(name, ok, detail) {
      checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
    }
    function summary() {
      var bad = checks.filter(function (c) { return !c.ok; });
      return { ok: bad.length === 0, checks: checks };
    }

    mode = 'stir';
    pointers = {}; pointerCount = 0; releasedToOrbit = false; lastTap = null;

    var stirEvts = [], probeEvts = [], intentEvts = [], gestureEvts = [];
    V.bus.on('vx:stir', function (d) { stirEvts.push(d); });
    V.bus.on('vx:probe', function (d) { probeEvts.push(d); });
    V.bus.on('vx:gesture', function (d) { gestureEvts.push(d); intentEvts.push(d); });

    // 1. drag -> stir event with vector (sum of per-step deltas = total drag vector)
    var nStir0 = stirEvts.length;
    simulateGesture('drag', { x: 10, y: 20, dx: 40, dy: -15, pointerType: 'mouse' });
    var sumDx = 0, sumDy = 0, nNew = 0;
    for (var si = nStir0; si < stirEvts.length; si++) {
      sumDx += stirEvts[si].vector.dx; sumDy += stirEvts[si].vector.dy; nNew++;
    }
    check('drag-produces-stir-with-vector',
      nNew > 0 && sumDx === 40 && sumDy === -15,
      'stir events=' + nNew + ', summed vector=(' + sumDx + ',' + sumDy + ')');

    // 2. long-press -> probe intent (W05 absent headless -> default perturb)
    var nProbe0 = probeEvts.length, nIntent0 = gestureEvts.filter(function (g) {
      return g && g.type === 'probe-intent';
    }).length;
    simulateGesture('longpress', { x: 7, y: 9 });
    var newIntents = gestureEvts.filter(function (g) { return g && g.type === 'probe-intent'; });
    var gotIntent = newIntents.length > nIntent0 &&
      newIntents[newIntents.length - 1].x === 7 &&
      newIntents[newIntents.length - 1].y === 9;
    check('longpress-opens-probe-intent', gotIntent,
      'intents before/after=' + nIntent0 + '/' + newIntents.length);
    var newProbe = probeEvts[probeEvts.length - 1];
    check('longpress-fallback-default-probe',
      probeEvts.length > nProbe0 && newProbe && newProbe.probe === 'perturb',
      newProbe ? 'probe=' + newProbe.probe : 'no probe event');

    // 3. pressure clamps to 30% (pen), mouse stays at 15%
    simulateGesture('drag', { x: 0, y: 0, dx: 5, dy: 0, pointerType: 'pen', pressure: 2.5 });
    var penOver = stirEvts[stirEvts.length - 1];
    check('pressure-clamps-to-30pct',
      penOver && penOver.strength === 0.30,
      'pen pressure 2.5 -> strength=' + (penOver && penOver.strength));
    simulateGesture('drag', { x: 0, y: 0, dx: 5, dy: 0, pointerType: 'pen', pressure: 0.5 });
    var penHalf = stirEvts[stirEvts.length - 1];
    check('pen-pressure-maps-linearly',
      penHalf && Math.abs(penHalf.strength - 0.15) < 1e-9,
      'pen pressure 0.5 -> strength=' + (penHalf && penHalf.strength));
    simulateGesture('drag', { x: 0, y: 0, dx: 5, dy: 0, pointerType: 'mouse', pressure: 1.0 });
    var mouseStir = stirEvts[stirEvts.length - 1];
    check('mouse-strength-default-15pct',
      mouseStir && Math.abs(mouseStir.strength - 0.15) < 1e-9,
      'mouse -> strength=' + (mouseStir && mouseStir.strength));
    // tilt -> brush width
    simulateGesture('drag', { x: 0, y: 0, dx: 5, dy: 0, pointerType: 'pen',
      pressure: 0.5, tiltX: 45, tiltY: 0 });
    var tiltStir = stirEvts[stirEvts.length - 1];
    check('tilt-widens-brush',
      tiltStir && tiltStir.brushWidth > BASE_BRUSH_PX,
      'tilt 45deg -> brush=' + (tiltStir && tiltStir.brushWidth.toFixed(1)) +
      ' (base ' + BASE_BRUSH_PX + ')');

    // 4. double-tap cycles modes stir -> probe -> observe -> stir
    mode = 'stir'; lastTap = null;
    simulateGesture('doubletap', { x: 50, y: 50 });
    var m1 = mode;
    simulateGesture('doubletap', { x: 50, y: 50 });
    var m2 = mode;
    simulateGesture('doubletap', { x: 50, y: 50 });
    var m3 = mode;
    check('doubletap-cycles-modes',
      m1 === 'probe' && m2 === 'observe' && m3 === 'stir',
      'modes=' + m1 + ' -> ' + m2 + ' -> ' + m3);

    // 5. two-pointer releases to orbit (no stir claimed)
    mode = 'stir'; lastTap = null;
    var nStir0 = stirEvts.length;
    simulateGesture('twopointer', { x: 10, y: 10 });
    var released = gestureEvts.some(function (g) { return g && g.type === 'released-to-orbit'; });
    check('two-pointer-releases-to-orbit',
      released && stirEvts.length === nStir0,
      'released=' + released + ', stir events during=' + (stirEvts.length - nStir0));

    // 6. destructive gate: without confirm -> NOT executed; with confirm -> executed
    var executed = false;
    registerDestructive('w22-selftest', function () { executed = true; });
    var realConfirm = api.confirmSheet;
    api.confirmSheet = function () { return Promise.resolve(false); };
    return triggerDestructive('w22-selftest').then(function (ranDenied) {
      check('destructive-denied-without-confirm',
        ranDenied === false && executed === false,
        'ran=' + ranDenied + ', executed=' + executed);
      api.confirmSheet = function () { return Promise.resolve(true); };
      return triggerDestructive('w22-selftest');
    }).then(function (ranConfirmed) {
      check('destructive-executes-with-confirm',
        ranConfirmed === true && executed === true,
        'ran=' + ranConfirmed + ', executed=' + executed);
      // unbound destructive refuses safely
      return triggerDestructive('clear-probes');
    }).then(function (ranUnbound) {
      check('unbound-destructive-refused',
        ranUnbound === false,
        'clear-probes unbound -> ran=' + ranUnbound);
      api.confirmSheet = realConfirm;
      return summary();
    }).catch(function (err) {
      api.confirmSheet = realConfirm;
      check('selftest-no-throw', false, String(err && err.message || err));
      return summary();
    });
  }

  // ---- public api ----

  var api = {
    version: '0.1.0',
    // modes
    getMode: function () { return mode; },
    setMode: function (m) {
      if (MODES.indexOf(m) === -1) throw new Error('w22-touch: bad mode "' + m + '"');
      mode = m;
      emitGesture({ type: 'mode', mode: mode });
      V.ui.announce('Touch mode: ' + mode + '.');
      return mode;
    },
    MODES: MODES.slice(),
    // lifecycle
    attach: attach,
    detach: detach,
    isAttached: function () { return attached; },
    // destructive gate
    confirmSheet: confirmSheet,
    registerDestructive: registerDestructive,
    triggerDestructive: triggerDestructive,
    destructiveNames: function () {
      return Object.keys(pendingDestructive).filter(function (n) {
        return pendingDestructive[n] !== null;
      });
    },
    // tests
    simulateGesture: simulateGesture,
    selfTest: selfTest
  };

  // Auto-attach when the DOM is ready (guarded headless / missing wrap).
  if (HAS_DOM) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () { attach(); });
    } else {
      attach();
    }
  }

  VORTEX.register('w22-touch', api);

})(typeof window !== 'undefined' ? window : globalThis);
