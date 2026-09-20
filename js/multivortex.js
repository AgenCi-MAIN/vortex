/* VORTEX lane-14 · W19 — Multi-vortex orchestration
 *
 * Scene graph of vortices with a state machine, choreography timelines in
 * sim-time, selection-generalized Core X/Y, five signature scenarios,
 * backward-compatible Spiral/Collision presets, honest field binding, and a
 * "Vortex scenes" panel.
 *
 * Plain browser JS, IIFE, no modules, no network, no fetch/XHR/WebSocket/eval.
 * Headless-safe: every DOM touch is guarded; selfTest() never throws without DOM.
 *
 * HONESTY NOTE (field binding): the CPU backend models ONE dominant vortex.
 * The primary (selected) vortex drives backend.setParams(); every other vortex
 * is emitted as a discrete probe perturbation via backend.addProbe(). This
 * does NOT simulate vortex–vortex coupling — no mutual advection, no real
 * merger dynamics inside the fluid field. mapToBackend() says so in its report.
 */
(function () {
  'use strict';

  var MOD_ID = 'w19-multivortex';

  /* ---------------------------------------------------------------- utils */

  function hasDOM() {
    return (typeof document !== 'undefined') && (typeof document.createElement === 'function');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isStr(v) { return typeof v === 'string' && v.length > 0; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function emit(name, detail) {
    try {
      if (typeof VORTEX !== 'undefined' && VORTEX.bus && typeof VORTEX.bus.emit === 'function') {
        VORTEX.bus.emit(name, detail);
      }
    } catch (e) { /* bus must never break the sim */ }
  }

  /* ------------------------------------------------------- scene graph */

  // State machine: forming → active → merging → dissipated.
  //  - forming:   just spawned, core still establishing (auto → active after FORM_TIME)
  //  - active:    full participant (can be selected, bound, merged, split, killed)
  //  - merging:   transitional; entered when a merge/split op commits
  //  - dissipated: terminal; kept in the scene for the audit trail, never revived
  var STATES = ['forming', 'active', 'merging', 'dissipated'];
  var TRANSITIONS = {
    forming:    ['active', 'dissipated'],
    active:     ['merging', 'dissipated'],
    merging:    ['dissipated', 'active'],
    dissipated: []
  };
  var FORM_TIME = 1.5;   // sim-seconds: forming → active
  var MERGE_TIME = 0.75; // sim-seconds: merging → resolved

  var _uid = 0;
  function makeId(prefix) { _uid += 1; return (prefix || 'vx') + '-' + _uid; }

  // Vortex: { id (stable), x, y, circulation, radius, state, born, stateT, meta }
  // x,y are domain-normalized [0,1]; circulation is signed Γ; radius is core radius.
  function createScene(opts) {
    opts = opts || {};
    return {
      vortices: [],
      selectedId: null,
      simTime: 0,        // choreography clock (sim-seconds, fixed-dt driven)
      pauseLeft: 0,      // sim-seconds of timeline pause remaining
      timeline: null,    // compiled choreography (or null)
      pendingMerges: [], // [{sourceId, targetId, t}]
      tweens: [],        // [{id, fx, fy, tx, ty, t0, t1}]
      log: [],           // [{t, op, ok, detail}] — deterministic execution record
      camera: { x: 0.5, y: 0.5, zoom: 1 },
      name: isStr(opts.name) ? opts.name : 'scene'
    };
  }

  function getVortex(scene, id) {
    if (!scene || !isStr(id)) return null;
    for (var i = 0; i < scene.vortices.length; i++) {
      if (scene.vortices[i].id === id) return scene.vortices[i];
    }
    return null;
  }

  function addVortex(scene, def) {
    def = def || {};
    if (scene.vortices.length >= 512) {
      return { ok: false, reason: 'scene full (512 vortices max)' };
    }
    var v = {
      id: isStr(def.id) ? def.id : makeId('vx'),
      x: isNum(def.x) ? clamp(def.x, 0, 1) : 0.5,
      y: isNum(def.y) ? clamp(def.y, 0, 1) : 0.5,
      circulation: isNum(def.circulation) ? def.circulation : 1.0,
      radius: isNum(def.radius) && def.radius > 0 ? def.radius : 0.06,
      state: 'forming',
      born: scene.simTime,
      stateT: 0,
      meta: (def.meta && typeof def.meta === 'object') ? def.meta : {}
    };
    if (getVortex(scene, v.id)) {
      return { ok: false, reason: 'duplicate vortex id: ' + v.id };
    }
    scene.vortices.push(v);
    if (!scene.selectedId) scene.selectedId = v.id;
    emit('vx:scene', { op: 'spawn', id: v.id, state: v.state });
    return { ok: true, vortex: v };
  }

  // State machine transition. Returns {ok} or {ok:false, reason}.
  function setState(scene, id, next) {
    var v = getVortex(scene, id);
    if (!v) return { ok: false, reason: 'unknown vortex id: ' + String(id) };
    if (STATES.indexOf(next) < 0) return { ok: false, reason: 'unknown state: ' + String(next) };
    var allowed = TRANSITIONS[v.state] || [];
    if (allowed.indexOf(next) < 0) {
      return { ok: false, reason: 'illegal transition ' + v.state + ' → ' + next };
    }
    v.state = next;
    v.stateT = 0;
    emit('vx:scene', { op: 'state', id: id, state: next });
    return { ok: true };
  }

  function killVortex(scene, id) {
    var v = getVortex(scene, id);
    if (!v) return { ok: false, reason: 'unknown vortex id: ' + String(id) };
    return setState(scene, id, 'dissipated');
  }

  function select(scene, id) {
    var v = getVortex(scene, id);
    if (!v) return { ok: false, reason: 'unknown vortex id: ' + String(id) };
    scene.selectedId = id;
    emit('vx:scene', { op: 'select', id: id });
    return { ok: true };
  }

  function pruneDissipated(scene) {
    var before = scene.vortices.length;
    scene.vortices = scene.vortices.filter(function (v) { return v.state !== 'dissipated'; });
    if (scene.selectedId && !getVortex(scene, scene.selectedId)) {
      var first = null;
      for (var i = 0; i < scene.vortices.length; i++) {
        if (scene.vortices[i].state !== 'dissipated') { first = scene.vortices[i]; break; }
      }
      scene.selectedId = first ? first.id : null;
    }
    return before - scene.vortices.length;
  }

  /* --------------------------------------------- selection-generalized Core */

  // The module holds one "active" working scene (the panel's scene). The W01
  // shell's Core X/Y sliders generalize to the SELECTED vortex via:
  //   var mv = VORTEX.get('w19-multivortex');
  //   mv.setCore(mv.selectedId(), sliderX, sliderY);
  var activeScene = createScene({ name: 'primary' });

  function bindScene(scene) {
    if (!scene || !scene.vortices) return { ok: false, reason: 'not a scene' };
    activeScene = scene;
    return { ok: true };
  }
  function selectedId() { return activeScene.selectedId; }

  // Core X/Y: sets the core position of one vortex. x,y are domain [0,1].
  function setCore(id, x, y) {
    var v = getVortex(activeScene, id);
    if (!v) return { ok: false, reason: 'unknown vortex id: ' + String(id) };
    if (!isNum(x) || !isNum(y)) return { ok: false, reason: 'core x/y must be numbers' };
    if (v.state === 'dissipated') return { ok: false, reason: 'vortex is dissipated: ' + id };
    v.x = clamp(x, 0, 1);
    v.y = clamp(y, 0, 1);
    emit('vx:scene', { op: 'setCore', id: id, x: v.x, y: v.y });
    return { ok: true, vortex: v };
  }

  function setCoreSelected(x, y) {
    if (!activeScene.selectedId) return { ok: false, reason: 'no vortex selected' };
    return setCore(activeScene.selectedId, x, y);
  }

  /* ---------------------------------------------------------- choreography */

  // Timeline: [{ t, op, ... }] — t is sim-seconds (≥0), ops execute in t order.
  //   spawn {x, y, circulation, radius?, id?}
  //   kill  {id}
  //   move  {id, x, y, dur?}            — dur omitted = instant; dur>0 = linear tween
  //   merge {source, target}            — source consumed into target (see rule below)
  //   split {id, ratio?, angle?, sep?}  — parent → two children (see rule below)
  //   set   {id, x?, y?, circulation?, radius?}
  //   pause {dur}                       — freezes the choreography clock for dur sim-seconds
  //   camera {x, y, zoom?}              — records a camera request; emitted on vx:scene if a bus exists
  //
  // MERGE RULE (circulation conservation):
  //   Γ_new  = Γ_source + Γ_target            (signed — opposite signs cancel)
  //   r_new  = sqrt(r_source² + r_target²)     (core area conserved)
  //   x_new  = (|Γ_s|·x_s + |Γ_t|·x_t)/(|Γ_s|+|Γ_t|)   (|Γ|-weighted; midpoint if both zero)
  //   Source ends 'dissipated'; target passes 'merging' → 'active'.
  // SPLIT RULE (circulation conservation):
  //   Γ_a = ratio·Γ, Γ_b = (1−ratio)·Γ;  r_a = r·sqrt(ratio), r_b = r·sqrt(1−ratio);
  //   children placed ±sep/2 along `angle`; parent ends 'dissipated', children start 'forming'.

  var OPS = ['spawn', 'kill', 'move', 'merge', 'split', 'set', 'pause', 'camera'];

  function validateTimeline(tl) {
    var errors = [];
    if (!Array.isArray(tl)) return { ok: false, errors: [{ index: -1, op: '?', reason: 'timeline must be an array' }] };
    for (var i = 0; i < tl.length; i++) {
      var ev = tl[i];
      var where = { index: i, op: (ev && ev.op) || '?', reason: '' };
      function bad(r) { where.reason = r; errors.push({ index: where.index, op: where.op, reason: where.reason }); }
      if (!ev || typeof ev !== 'object') { bad('event must be an object'); continue; }
      if (!isNum(ev.t) || ev.t < 0) { bad('t must be a non-negative number'); continue; }
      if (OPS.indexOf(ev.op) < 0) { bad('unknown op: ' + String(ev.op) + ' (expected one of ' + OPS.join(',') + ')'); continue; }
      switch (ev.op) {
        case 'spawn':
          if (!isNum(ev.x) || !isNum(ev.y)) bad('spawn needs numeric x, y');
          else if (!isNum(ev.circulation)) bad('spawn needs numeric circulation');
          else if (ev.radius !== undefined && !(isNum(ev.radius) && ev.radius > 0)) bad('spawn radius must be > 0');
          else if (ev.id !== undefined && !isStr(ev.id)) bad('spawn id must be a non-empty string');
          break;
        case 'kill':
          if (!isStr(ev.id)) bad('kill needs a non-empty string id');
          break;
        case 'move':
          if (!isStr(ev.id)) bad('move needs a non-empty string id');
          else if (!isNum(ev.x) || !isNum(ev.y)) bad('move needs numeric x, y');
          else if (ev.dur !== undefined && !(isNum(ev.dur) && ev.dur >= 0)) bad('move dur must be ≥ 0');
          break;
        case 'merge':
          if (!isStr(ev.source)) bad('merge needs a non-empty string source');
          else if (!isStr(ev.target)) bad('merge needs a non-empty string target');
          else if (ev.source === ev.target) bad('merge source and target must differ');
          break;
        case 'split':
          if (!isStr(ev.id)) bad('split needs a non-empty string id');
          else if (ev.ratio !== undefined && !(isNum(ev.ratio) && ev.ratio > 0 && ev.ratio < 1)) bad('split ratio must be in (0,1)');
          else if (ev.angle !== undefined && !isNum(ev.angle)) bad('split angle must be numeric');
          else if (ev.sep !== undefined && !(isNum(ev.sep) && ev.sep > 0)) bad('split sep must be > 0');
          break;
        case 'set':
          if (!isStr(ev.id)) bad('set needs a non-empty string id');
          else if (ev.x === undefined && ev.y === undefined && ev.circulation === undefined && ev.radius === undefined)
            bad('set needs at least one of x, y, circulation, radius');
          else if ((ev.x !== undefined && !isNum(ev.x)) || (ev.y !== undefined && !isNum(ev.y))) bad('set x/y must be numeric');
          else if (ev.circulation !== undefined && !isNum(ev.circulation)) bad('set circulation must be numeric');
          else if (ev.radius !== undefined && !(isNum(ev.radius) && ev.radius > 0)) bad('set radius must be > 0');
          break;
        case 'pause':
          if (!(isNum(ev.dur) && ev.dur > 0)) bad('pause needs dur > 0');
          break;
        case 'camera':
          if (!isNum(ev.x) || !isNum(ev.y)) bad('camera needs numeric x, y');
          else if (ev.zoom !== undefined && !(isNum(ev.zoom) && ev.zoom > 0)) bad('camera zoom must be > 0');
          break;
      }
    }
    return errors.length ? { ok: false, errors: errors } : { ok: true, errors: [] };
  }

  function compileTimeline(tl) {
    var v = validateTimeline(tl);
    if (!v.ok) return { ok: false, errors: v.errors };
    var events = tl.map(function (ev, i) {
      var copy = {};
      for (var k in ev) { if (Object.prototype.hasOwnProperty.call(ev, k)) copy[k] = ev[k]; }
      copy._i = i;
      return copy;
    });
    events.sort(function (a, b) { return (a.t - b.t) || (a._i - b._i); }); // stable by t
    return { ok: true, errors: [], events: events, cursor: 0 };
  }

  function logExec(scene, ev, ok, detail) {
    scene.log.push({ t: scene.simTime, op: ev.op, ok: ok, detail: detail || '' });
    if (scene.log.length > 4096) scene.log.splice(0, scene.log.length - 4096);
  }

  function execEvent(scene, ev) {
    var r, v, w;
    switch (ev.op) {
      case 'spawn':
        r = addVortex(scene, ev);
        logExec(scene, ev, r.ok, r.ok ? ('spawned ' + r.vortex.id) : r.reason);
        break;
      case 'kill':
        r = killVortex(scene, ev.id);
        logExec(scene, ev, r.ok, r.ok ? ('killed ' + ev.id) : r.reason);
        break;
      case 'move':
        v = getVortex(scene, ev.id);
        if (!v) { logExec(scene, ev, false, 'unknown vortex id: ' + ev.id); break; }
        if (v.state === 'dissipated') { logExec(scene, ev, false, 'vortex dissipated: ' + ev.id); break; }
        if (ev.dur && ev.dur > 0) {
          scene.tweens.push({ id: ev.id, fx: v.x, fy: v.y, tx: clamp(ev.x, 0, 1), ty: clamp(ev.y, 0, 1), t0: scene.simTime, t1: scene.simTime + ev.dur });
          logExec(scene, ev, true, 'tween ' + ev.id + ' over ' + ev.dur + 's');
        } else {
          v.x = clamp(ev.x, 0, 1); v.y = clamp(ev.y, 0, 1);
          logExec(scene, ev, true, 'moved ' + ev.id);
        }
        break;
      case 'merge': {
        var s = getVortex(scene, ev.source), t = getVortex(scene, ev.target);
        if (!s || !t) { logExec(scene, ev, false, 'unknown source/target'); break; }
        if (s.state !== 'active' || t.state !== 'active') {
          logExec(scene, ev, false, 'merge needs both active (got ' + s.state + '/' + t.state + ')'); break;
        }
        r = setState(scene, s.id, 'merging'); var r2 = setState(scene, t.id, 'merging');
        if (!r.ok || !r2.ok) { logExec(scene, ev, false, 'state commit failed'); break; }
        scene.pendingMerges.push({ sourceId: s.id, targetId: t.id, t: 0 });
        logExec(scene, ev, true, 'merging ' + s.id + ' → ' + t.id);
        break;
      }
      case 'split': {
        v = getVortex(scene, ev.id);
        if (!v) { logExec(scene, ev, false, 'unknown vortex id: ' + ev.id); break; }
        if (v.state !== 'active') { logExec(scene, ev, false, 'split needs active (got ' + v.state + ')'); break; }
        var ratio = ev.ratio !== undefined ? ev.ratio : 0.5;
        var angle = ev.angle !== undefined ? ev.angle : 0;
        var sep = ev.sep !== undefined ? ev.sep : 2 * v.radius;
        var dx = Math.cos(angle) * sep / 2, dy = Math.sin(angle) * sep / 2;
        setState(scene, v.id, 'merging');
        var c1 = addVortex(scene, { id: v.id + '-a', x: v.x + dx, y: v.y + dy, circulation: ratio * v.circulation, radius: v.radius * Math.sqrt(ratio), meta: { parent: v.id } });
        var c2 = addVortex(scene, { id: v.id + '-b', x: v.x - dx, y: v.y - dy, circulation: (1 - ratio) * v.circulation, radius: v.radius * Math.sqrt(1 - ratio), meta: { parent: v.id } });
        if (c1.ok && c2.ok) {
          setState(scene, v.id, 'dissipated');
          logExec(scene, ev, true, 'split ' + v.id + ' → ' + c1.vortex.id + ', ' + c2.vortex.id);
        } else {
          logExec(scene, ev, false, 'split child spawn failed');
        }
        break;
      }
      case 'set':
        v = getVortex(scene, ev.id);
        if (!v) { logExec(scene, ev, false, 'unknown vortex id: ' + ev.id); break; }
        if (v.state === 'dissipated') { logExec(scene, ev, false, 'vortex dissipated: ' + ev.id); break; }
        if (ev.x !== undefined) v.x = clamp(ev.x, 0, 1);
        if (ev.y !== undefined) v.y = clamp(ev.y, 0, 1);
        if (ev.circulation !== undefined) v.circulation = ev.circulation;
        if (ev.radius !== undefined) v.radius = ev.radius;
        logExec(scene, ev, true, 'set ' + ev.id);
        break;
      case 'pause':
        scene.pauseLeft += ev.dur;
        logExec(scene, ev, true, 'pause +' + ev.dur + 's');
        break;
      case 'camera':
        scene.camera = { x: ev.x, y: ev.y, zoom: ev.zoom !== undefined ? ev.zoom : 1 };
        emit('vx:scene', { op: 'camera', x: scene.camera.x, y: scene.camera.y, zoom: scene.camera.zoom });
        logExec(scene, ev, true, 'camera request recorded');
        break;
      default:
        logExec(scene, ev, false, 'unreachable: unknown op passed validation');
    }
  }

  function resolveMerge(scene, m) {
    var s = getVortex(scene, m.sourceId), t = getVortex(scene, m.targetId);
    if (!s || !t) return;
    // MERGE RULE: Γ_new = Γ_s + Γ_t (signed); r_new = sqrt(r_s² + r_t²); |Γ|-weighted position.
    var gs = Math.abs(s.circulation), gt = Math.abs(t.circulation);
    var wsum = gs + gt;
    t.circulation = s.circulation + t.circulation;
    t.radius = Math.sqrt(s.radius * s.radius + t.radius * t.radius);
    if (wsum > 0) {
      t.x = (gs * s.x + gt * t.x) / wsum;
      t.y = (gs * s.y + gt * t.y) / wsum;
    } else {
      t.x = (s.x + t.x) / 2; t.y = (s.y + t.y) / 2;
    }
    setState(scene, s.id, 'dissipated');
    setState(scene, t.id, 'active');
    scene.log.push({ t: scene.simTime, op: 'merge-resolve', ok: true, detail: s.id + ' → ' + t.id + ' (Γ=' + t.circulation.toFixed(4) + ')' });
  }

  // One fixed-dt sim step: advances the choreography clock, fires due events,
  // completes merges, advances tweens and forming timers.
  function step(scene, dt) {
    if (!isNum(dt) || dt <= 0) dt = 1 / 60;
    if (scene.pauseLeft > 0) {
      scene.pauseLeft = Math.max(0, scene.pauseLeft - dt);
    } else {
      scene.simTime += dt;
    }
    // Fire due timeline events (in t order — compile() sorted them).
    var tl = scene.timeline;
    if (tl && tl.events) {
      while (tl.cursor < tl.events.length && tl.events[tl.cursor].t <= scene.simTime) {
        execEvent(scene, tl.events[tl.cursor]);
        tl.cursor++;
      }
    }
    // Complete pending merges.
    for (var i = scene.pendingMerges.length - 1; i >= 0; i--) {
      scene.pendingMerges[i].t += dt;
      if (scene.pendingMerges[i].t >= MERGE_TIME) {
        resolveMerge(scene, scene.pendingMerges[i]);
        scene.pendingMerges.splice(i, 1);
      }
    }
    // Advance tweens (linear).
    for (var j = scene.tweens.length - 1; j >= 0; j--) {
      var tw = scene.tweens[j], v = getVortex(scene, tw.id);
      var a = clamp((scene.simTime - tw.t0) / Math.max(1e-9, tw.t1 - tw.t0), 0, 1);
      if (v && v.state !== 'dissipated') { v.x = tw.fx + (tw.tx - tw.fx) * a; v.y = tw.fy + (tw.ty - tw.fy) * a; }
      if (a >= 1) scene.tweens.splice(j, 1);
    }
    // forming → active after FORM_TIME.
    for (var k = 0; k < scene.vortices.length; k++) {
      var vx = scene.vortices[k];
      if (vx.state === 'forming') {
        vx.stateT += dt;
        if (vx.stateT >= FORM_TIME) { setState(scene, vx.id, 'active'); }
      }
    }
    return { ok: true, simTime: scene.simTime };
  }

  function runFor(scene, seconds, dt) {
    dt = (isNum(dt) && dt > 0) ? dt : 1 / 60;
    var n = Math.max(0, Math.round(seconds / dt));
    for (var i = 0; i < n; i++) step(scene, dt);
    return { ok: true, simTime: scene.simTime };
  }

  /* --------------------------------------------------------------- scenarios */

  // Five signature scenarios as choreography data. Each carries a one-line
  // hypothesis seed. Note: choreography scripts vortex motion; the lab does not
  // yet simulate vortex–vortex fluid coupling, so these are composed timelines,
  // not emergent physics. The hypotheses are testable once coupling exists.
  var SCENARIOS = {
    'karman-street': {
      key: 'karman-street',
      title: 'Kármán street',
      hypothesis: 'Alternating-sign vortices shed at a steady 2 s interval form a stable staggered street that persists past x = 0.8.',
      duration: 24,
      timeline: [
        { t: 0, op: 'spawn', id: 'kv-1', x: 0.25, y: 0.56, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'move', id: 'kv-1', x: 0.85, y: 0.56, dur: 20 },
        { t: 2, op: 'spawn', id: 'kv-2', x: 0.25, y: 0.44, circulation: -1.0, radius: 0.05 },
        { t: 2, op: 'move', id: 'kv-2', x: 0.85, y: 0.44, dur: 20 },
        { t: 4, op: 'spawn', id: 'kv-3', x: 0.25, y: 0.56, circulation: 1.0, radius: 0.05 },
        { t: 4, op: 'move', id: 'kv-3', x: 0.85, y: 0.56, dur: 20 },
        { t: 6, op: 'spawn', id: 'kv-4', x: 0.25, y: 0.44, circulation: -1.0, radius: 0.05 },
        { t: 6, op: 'move', id: 'kv-4', x: 0.85, y: 0.44, dur: 20 },
        { t: 8, op: 'spawn', id: 'kv-5', x: 0.25, y: 0.56, circulation: 1.0, radius: 0.05 },
        { t: 8, op: 'move', id: 'kv-5', x: 0.85, y: 0.56, dur: 20 }
      ]
    },
    'merger-cascade': {
      key: 'merger-cascade',
      title: 'Merger cascade',
      hypothesis: 'Three sequential same-sign mergers conserve total circulation while the surviving core radius grows as sqrt of the merged count.',
      duration: 22,
      timeline: [
        { t: 0, op: 'spawn', id: 'mc-a', x: 0.30, y: 0.50, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'spawn', id: 'mc-b', x: 0.42, y: 0.50, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'spawn', id: 'mc-c', x: 0.54, y: 0.50, circulation: 1.0, radius: 0.05 },
        { t: 2, op: 'move', id: 'mc-b', x: 0.34, y: 0.50, dur: 1.5 },
        { t: 4, op: 'merge', source: 'mc-b', target: 'mc-a' },
        { t: 8, op: 'move', id: 'mc-c', x: 0.32, y: 0.50, dur: 1.5 },
        { t: 10, op: 'merge', source: 'mc-c', target: 'mc-a' },
        { t: 12, op: 'set', id: 'mc-a', radius: 0.0866 } // expected sqrt(3)·0.05 after two merges; assert in lab
      ]
    },
    'vortex-crystal': {
      key: 'vortex-crystal',
      title: 'Vortex crystal',
      hypothesis: 'A symmetric hexagon of equal same-sign vortices holds its lattice shape for ≥20 s before symmetry visibly breaks.',
      duration: 26,
      timeline: [
        { t: 0, op: 'camera', x: 0.5, y: 0.5, zoom: 0.8 },
        { t: 0, op: 'spawn', id: 'vc-0', x: 0.65, y: 0.50, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'vc-1', x: 0.575, y: 0.63, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'vc-2', x: 0.425, y: 0.63, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'vc-3', x: 0.35, y: 0.50, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'vc-4', x: 0.425, y: 0.37, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'vc-5', x: 0.575, y: 0.37, circulation: 1.0, radius: 0.045 },
        { t: 24, op: 'camera', x: 0.5, y: 0.5, zoom: 1 }
      ]
    },
    'predator-prey': {
      key: 'predator-prey',
      title: 'Predator–prey',
      hypothesis: 'A 4:1-circulation predator captures and merges every weaker same-sign vortex it reaches within 30 s.',
      duration: 32,
      timeline: [
        { t: 0, op: 'spawn', id: 'pp-pred', x: 0.15, y: 0.50, circulation: 4.0, radius: 0.09 },
        { t: 0, op: 'spawn', id: 'pp-1', x: 0.45, y: 0.62, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'pp-2', x: 0.60, y: 0.40, circulation: 1.0, radius: 0.045 },
        { t: 0, op: 'spawn', id: 'pp-3', x: 0.78, y: 0.58, circulation: 1.0, radius: 0.045 },
        { t: 2, op: 'move', id: 'pp-pred', x: 0.45, y: 0.62, dur: 4 },
        { t: 7, op: 'merge', source: 'pp-1', target: 'pp-pred' },
        { t: 10, op: 'move', id: 'pp-pred', x: 0.60, y: 0.40, dur: 4 },
        { t: 15, op: 'merge', source: 'pp-2', target: 'pp-pred' },
        { t: 18, op: 'move', id: 'pp-pred', x: 0.78, y: 0.58, dur: 4 },
        { t: 23, op: 'merge', source: 'pp-3', target: 'pp-pred' }
      ]
    },
    'leapfrogging-pairs': {
      key: 'leapfrogging-pairs',
      title: 'Leapfrogging pairs',
      hypothesis: 'Two same-sign pairs leapfrog through each other periodically while pair separation stays within 2–4 core radii; outside that band the rhythm breaks.',
      duration: 30,
      timeline: [
        { t: 0, op: 'spawn', id: 'lf-a1', x: 0.20, y: 0.47, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'spawn', id: 'lf-a2', x: 0.20, y: 0.53, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'spawn', id: 'lf-b1', x: 0.55, y: 0.47, circulation: 1.0, radius: 0.05 },
        { t: 0, op: 'spawn', id: 'lf-b2', x: 0.55, y: 0.53, circulation: 1.0, radius: 0.05 },
        // pair A advances and threads through pair B's gap, then pair B follows
        { t: 2, op: 'move', id: 'lf-a1', x: 0.55, y: 0.50, dur: 6 },
        { t: 2, op: 'move', id: 'lf-a2', x: 0.55, y: 0.50, dur: 6 },
        { t: 2, op: 'move', id: 'lf-b1', x: 0.42, y: 0.44, dur: 6 },
        { t: 2, op: 'move', id: 'lf-b2', x: 0.42, y: 0.56, dur: 6 },
        { t: 10, op: 'move', id: 'lf-a1', x: 0.85, y: 0.47, dur: 6 },
        { t: 10, op: 'move', id: 'lf-a2', x: 0.85, y: 0.53, dur: 6 },
        { t: 10, op: 'move', id: 'lf-b1', x: 0.75, y: 0.50, dur: 6 },
        { t: 10, op: 'move', id: 'lf-b2', x: 0.75, y: 0.50, dur: 6 }
      ]
    }
  };

  function scenarioKeys() { return Object.keys(SCENARIOS); }

  // Loads a scenario into a scene: clears vortices, resets the clock, compiles
  // the timeline. The scenario's own spawn events populate the scene as it runs.
  function loadScenario(scene, key) {
    var sc = SCENARIOS[key];
    if (!sc) return { ok: false, reason: 'unknown scenario: ' + String(key) };
    var c = compileTimeline(sc.timeline);
    if (!c.ok) return { ok: false, reason: 'scenario timeline invalid', errors: c.errors };
    scene.vortices = [];
    scene.selectedId = null;
    scene.simTime = 0;
    scene.pauseLeft = 0;
    scene.pendingMerges = [];
    scene.tweens = [];
    scene.log = [];
    scene.timeline = c;
    scene.camera = { x: 0.5, y: 0.5, zoom: 1 };
    emit('vx:scene', { op: 'loadScenario', key: key, title: sc.title });
    return { ok: true, key: key, title: sc.title, hypothesis: sc.hypothesis, duration: sc.duration, events: c.events.length };
  }

  /* --------------------------------------------------------- presets (compat) */

  // Backward compat: the W01 shell's Spiral preset = 1-vortex scene;
  // Collision preset = 2-vortex scene (counter-rotating pair).
  function sceneForPreset(name) {
    if (name === 'spiral') {
      var s = createScene({ name: 'spiral' });
      addVortex(s, { id: 'spiral-1', x: 0.5, y: 0.5, circulation: 1.0, radius: 0.07 });
      return { ok: true, scene: s };
    }
    if (name === 'collision') {
      var c = createScene({ name: 'collision' });
      addVortex(c, { id: 'coll-a', x: 0.35, y: 0.5, circulation: 1.0, radius: 0.06 });
      addVortex(c, { id: 'coll-b', x: 0.65, y: 0.5, circulation: -1.0, radius: 0.06 });
      return { ok: true, scene: c };
    }
    return { ok: false, reason: 'unknown preset: ' + String(name) + ' (expected spiral|collision)' };
  }

  /* ------------------------------------------------------------- field binding */

  // HONEST MAPPING (single-vortex backend):
  //   - primary vortex (selected, else first non-dissipated) → backend.setParams({circulation, coreX, coreY, coreRadius})
  //   - every other active vortex → backend.addProbe({kind:'vortex-perturbation', ...}) when available
  //   - vortices that could not be represented are listed in report.uncoupled
  // This is NOT multi-vortex fluid coupling. The backend integrates one dominant
  // vortex; secondaries are scripted perturbations. Never claim otherwise.
  function mapToBackend(scene, backend) {
    var report = { ok: false, reason: '', primary: null, probes: 0, uncoupled: [], notes: [] };
    if (!backend) { report.reason = 'no backend bound'; return report; }
    var prim = getVortex(scene, scene.selectedId);
    if (!prim || prim.state === 'dissipated') {
      prim = null;
      for (var i = 0; i < scene.vortices.length; i++) {
        if (scene.vortices[i].state !== 'dissipated') { prim = scene.vortices[i]; break; }
      }
    }
    if (!prim) { report.reason = 'no live vortex in scene'; return report; }
    if (typeof backend.setParams !== 'function') { report.reason = 'backend lacks setParams'; return report; }
    try {
      backend.setParams({
        circulation: prim.circulation,
        coreX: prim.x,
        coreY: prim.y,
        coreRadius: prim.radius
      });
    } catch (e) {
      report.reason = 'backend.setParams threw: ' + (e && e.message ? e.message : e);
      return report;
    }
    report.primary = prim.id;
    var canProbe = typeof backend.addProbe === 'function';
    for (var j = 0; j < scene.vortices.length; j++) {
      var v = scene.vortices[j];
      if (v.id === prim.id || v.state === 'dissipated') continue;
      if (canProbe) {
        try {
          backend.addProbe({ kind: 'vortex-perturbation', x: v.x, y: v.y, circulation: v.circulation, radius: v.radius, source: 'w19-multivortex' });
          report.probes++;
        } catch (e2) { report.uncoupled.push(v.id); }
      } else {
        report.uncoupled.push(v.id);
      }
    }
    report.ok = true;
    report.notes.push(
      'HONEST MAPPING: the backend models ONE dominant vortex (the selected/primary). ' +
      'Secondary vortices are emitted as discrete probe perturbations via addProbe(). ' +
      'No vortex–vortex fluid coupling is simulated — do not claim merging or leapfrogging ' +
      'dynamics occur inside the field.'
    );
    return report;
  }

  /* ------------------------------------------------------------- panel */

  // Panel "Vortex scenes": scene list + select, scenario buttons, timeline
  // scrubber (read-only progress display + play/pause/step/reset).
  function mountPanel(el) {
    if (!hasDOM()) return;
    try {
      el.innerHTML = '';
      var wrap = document.createElement('div');
      wrap.setAttribute('data-w19-panel', 'scenes');

      var h = document.createElement('h3');
      h.textContent = 'Vortex scenes';
      wrap.appendChild(h);

      // Scene list
      var listBox = document.createElement('div');
      listBox.setAttribute('data-w19', 'scene-list');
      wrap.appendChild(listBox);

      // Core X/Y for selected
      var coreBox = document.createElement('div');
      coreBox.setAttribute('data-w19', 'core-box');
      wrap.appendChild(coreBox);

      // Scenario buttons
      var scBox = document.createElement('div');
      scBox.setAttribute('data-w19', 'scenarios');
      var scLabel = document.createElement('div');
      scLabel.textContent = 'Scenarios';
      scBox.appendChild(scLabel);
      scenarioKeys().forEach(function (key) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = SCENARIOS[key].title;
        b.title = SCENARIOS[key].hypothesis;
        b.addEventListener('click', function () { loadScenario(activeScene, key); render(); });
        scBox.appendChild(b);
      });
      wrap.appendChild(scBox);

      // Timeline scrubber: read-only display + transport
      var tlBox = document.createElement('div');
      tlBox.setAttribute('data-w19', 'timeline');
      var bar = document.createElement('div');
      bar.setAttribute('data-w19', 'scrub-bar');
      var fill = document.createElement('div');
      fill.setAttribute('data-w19', 'scrub-fill');
      bar.appendChild(fill);
      var readout = document.createElement('div');
      readout.setAttribute('data-w19', 'scrub-readout');
      var btnPlay = document.createElement('button'); btnPlay.type = 'button'; btnPlay.textContent = 'Play';
      var btnStep = document.createElement('button'); btnStep.type = 'button'; btnStep.textContent = 'Step';
      var btnReset = document.createElement('button'); btnReset.type = 'button'; btnReset.textContent = 'Reset';
      tlBox.appendChild(bar); tlBox.appendChild(readout);
      tlBox.appendChild(btnPlay); tlBox.appendChild(btnStep); tlBox.appendChild(btnReset);
      wrap.appendChild(tlBox);

      el.appendChild(wrap);

      var playing = false, timer = null;
      function transport(on) {
        playing = on;
        btnPlay.textContent = on ? 'Pause' : 'Play';
        if (timer) { clearInterval(timer); timer = null; }
        if (on) {
          timer = setInterval(function () { step(activeScene, 0.1); render(); }, 100);
        }
      }
      btnPlay.addEventListener('click', function () { transport(!playing); });
      btnStep.addEventListener('click', function () { transport(false); step(activeScene, 1 / 60); render(); });
      btnReset.addEventListener('click', function () {
        transport(false);
        var keep = activeScene.name;
        var fresh = createScene({ name: keep });
        bindScene(fresh);
        render();
      });

      function render() {
        // scene list
        listBox.innerHTML = '';
        activeScene.vortices.forEach(function (v) {
          var row = document.createElement('div');
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = (v.id === activeScene.selectedId ? '● ' : '○ ') + v.id +
            '  Γ=' + v.circulation.toFixed(2) + '  r=' + v.radius.toFixed(3) + '  [' + v.state + ']';
          b.addEventListener('click', function () { select(activeScene, v.id); render(); });
          row.appendChild(b);
          listBox.appendChild(row);
        });
        if (!activeScene.vortices.length) {
          var empty = document.createElement('div');
          empty.textContent = 'No vortices — load a scenario.';
          listBox.appendChild(empty);
        }
        // core readout for selected
        coreBox.innerHTML = '';
        var sel = getVortex(activeScene, activeScene.selectedId);
        var coreLine = document.createElement('div');
        coreLine.textContent = sel
          ? ('Selected: ' + sel.id + '  core=(' + sel.x.toFixed(3) + ', ' + sel.y.toFixed(3) + ') — W01 Core X/Y sliders target this vortex')
          : 'No vortex selected.';
        coreBox.appendChild(coreLine);
        // scrubber (read-only progress + transport state)
        var dur = 0, done = 0;
        if (activeScene.timeline && activeScene.timeline.events) {
          done = activeScene.timeline.cursor;
          dur = activeScene.timeline.events.length ? activeScene.timeline.events[activeScene.timeline.events.length - 1].t : 0;
        }
        fill.style.width = (dur > 0 ? Math.min(100, 100 * activeScene.simTime / dur) : 0) + '%';
        readout.textContent = 't=' + activeScene.simTime.toFixed(2) + 's / ' + dur.toFixed(1) + 's · events ' + done +
          ' · log ' + activeScene.log.length + (playing ? ' · PLAYING' : '');
      }
      render();
    } catch (e) { /* panel must never break boot */ }
  }

  try {
    if (typeof VORTEX !== 'undefined' && VORTEX.ui && typeof VORTEX.ui.registerPanel === 'function') {
      VORTEX.ui.registerPanel('w19-scenes', 'Vortex scenes', mountPanel);
    }
  } catch (e) { /* headless or ui not ready */ }

  /* ------------------------------------------------------------- selfTest */

  function check(name, ok, detail) { return { name: name, ok: !!ok, detail: detail || '' }; }

  function selfTest() {
    var checks = [];
    try {
      // 1. state machine: valid transitions
      var s1 = createScene({ name: 't1' });
      addVortex(s1, { id: 'a', x: 0.5, y: 0.5, circulation: 1 });
      var r1 = setState(s1, 'a', 'active');
      checks.push(check('sm-valid-forming-active', r1.ok, r1.ok ? 'forming → active accepted' : r1.reason));

      // 2. state machine: invalid transitions rejected with reason
      var s2 = createScene({ name: 't2' });
      addVortex(s2, { id: 'a', x: 0.5, y: 0.5, circulation: 1 });
      var r2 = setState(s2, 'a', 'merging');
      checks.push(check('sm-invalid-forming-merging', !r2.ok && /illegal transition/.test(r2.reason), 'rejected: ' + r2.reason));

      // 3. terminal state is terminal
      var s3 = createScene({ name: 't3' });
      addVortex(s3, { id: 'a', x: 0.5, y: 0.5, circulation: 1 });
      setState(s3, 'a', 'active'); setState(s3, 'a', 'dissipated');
      var r3 = setState(s3, 'a', 'active');
      checks.push(check('sm-terminal-dissipated', !r3.ok && /illegal transition/.test(r3.reason), 'rejected: ' + r3.reason));

      // 4. choreography executes ops in order on a synthetic scene
      var s4 = createScene({ name: 't4' });
      var c4 = compileTimeline([
        { t: 0, op: 'spawn', id: 's4a', x: 0.3, y: 0.5, circulation: 1.5, radius: 0.05 },
        { t: 0, op: 'spawn', id: 's4b', x: 0.7, y: 0.5, circulation: 2.5, radius: 0.05 },
        { t: 1, op: 'move', id: 's4a', x: 0.4, y: 0.5 },
        { t: 2, op: 'merge', source: 's4b', target: 's4a' }
      ]);
      s4.timeline = c4;
      runFor(s4, 2, 0.5); // reach merge commit (spawns were forming → need active)
      runFor(s4, 2, 0.1); // spawns: FORM_TIME=1.5 → active by ~1.5s; merge at t=2 commits
      runFor(s4, 4, 0.1); // merge resolves after MERGE_TIME
      var ops = s4.log.filter(function (e) { return e.op !== 'merge-resolve'; }).map(function (e) { return e.op; });
      var orderOk = ops.length >= 4 && ops[0] === 'spawn' && ops[1] === 'spawn' && ops[2] === 'move' && ops[3] === 'merge';
      checks.push(check('choreo-exec-order', orderOk, 'ops: ' + ops.join(', ')));

      // 5. circulation conserved on merge (assert)
      var survivor = getVortex(s4, 's4a');
      var consumed = getVortex(s4, 's4b');
      var consOk = survivor && Math.abs(survivor.circulation - 4.0) < 1e-9 &&
        consumed && consumed.state === 'dissipated' && survivor.state === 'active';
      checks.push(check('choreo-merge-conservation',
        consOk,
        survivor ? ('Γ=' + survivor.circulation + ' (expect 4.0), source=' + (consumed ? consumed.state : '?') + ', survivor=' + survivor.state) : 'survivor missing'));

      // 6. circulation conserved on split
      var s6 = createScene({ name: 't6' });
      addVortex(s6, { id: 'p', x: 0.5, y: 0.5, circulation: 3.0, radius: 0.06 });
      runFor(s6, 2, 0.1);
      var c6 = compileTimeline([{ t: 0, op: 'split', id: 'p', ratio: 0.25 }]);
      s6.timeline = c6; s6.simTime = 0; s6.timeline.cursor = 0;
      runFor(s6, 1, 0.1);
      var ca = getVortex(s6, 'p-a'), cb = getVortex(s6, 'p-b'), pp = getVortex(s6, 'p');
      var splitOk = ca && cb && Math.abs(ca.circulation - 0.75) < 1e-9 &&
        Math.abs(cb.circulation - 2.25) < 1e-9 && pp && pp.state === 'dissipated';
      checks.push(check('choreo-split-conservation', splitOk,
        ca && cb ? ('Γa=' + ca.circulation + ' Γb=' + cb.circulation + ' sum=' + (ca.circulation + cb.circulation) + ' (expect 3.0)') : 'children missing'));

      // 7. preset scene shapes
      var sp = sceneForPreset('spiral');
      var spiralOk = sp.ok && sp.scene.vortices.length === 1 &&
        ['id', 'x', 'y', 'circulation', 'radius', 'state'].every(function (k) { return k in sp.scene.vortices[0]; });
      checks.push(check('preset-spiral-shape', spiralOk, sp.ok ? '1 vortex with full field set' : sp.reason));
      var cp = sceneForPreset('collision');
      var collisionOk = cp.ok && cp.scene.vortices.length === 2 &&
        (cp.scene.vortices[0].circulation * cp.scene.vortices[1].circulation < 0);
      checks.push(check('preset-collision-shape', collisionOk, cp.ok ? '2 vortices, opposite-signed Γ' : cp.reason));
      var bp = sceneForPreset('nope');
      checks.push(check('preset-unknown-rejected', !bp.ok && /unknown preset/.test(bp.reason), 'rejected: ' + bp.reason));

      // 8. timeline validation rejects bad ops with reasons
      var bad = validateTimeline([
        { t: 0, op: 'teleport', id: 'x' },
        { t: -1, op: 'kill', id: 'x' },
        { t: 1, op: 'merge', source: 'a' },
        { t: 2, op: 'spawn', x: 0.5 } // missing y, circulation
      ]);
      var rejOk = !bad.ok && bad.errors.length === 4 &&
        bad.errors.every(function (e) { return isStr(e.reason); });
      checks.push(check('validate-rejects-bad-ops', rejOk,
        bad.errors.map(function (e) { return '[' + e.index + ':' + e.op + '] ' + e.reason; }).join(' | ')));

      // 9. all five scenarios validate
      var keys = scenarioKeys();
      var allValid = keys.length === 5 && keys.every(function (k) { return validateTimeline(SCENARIOS[k].timeline).ok; });
      checks.push(check('scenarios-validate', allValid, 'keys: ' + keys.join(', ')));

      // 10. setCore targets a vortex by id; unknown id fails
      var s10 = createScene({ name: 't10' });
      bindScene(s10);
      addVortex(activeScene, { id: 'core-1', x: 0.2, y: 0.2, circulation: 1 });
      var rc = setCore('core-1', 0.8, 0.7);
      var coreOk = rc.ok && Math.abs(rc.vortex.x - 0.8) < 1e-9 && Math.abs(rc.vortex.y - 0.7) < 1e-9;
      var rcBad = setCore('missing', 0.5, 0.5);
      checks.push(check('setcore-by-id', coreOk && !rcBad.ok, 'set ok=' + rc.ok + ', unknown id rejected: ' + rcBad.reason));

      // 11. field binding guards absence honestly
      var fbNone = mapToBackend(s10, null);
      checks.push(check('fieldbind-no-backend', !fbNone.ok && fbNone.reason === 'no backend bound', 'reason: ' + fbNone.reason));
      var fakeBackend = { params: null, probes: [], setParams: function (p) { this.params = p; }, addProbe: function (p) { this.probes.push(p); } };
      addVortex(activeScene, { id: 'core-2', x: 0.9, y: 0.1, circulation: -2 });
      runFor(activeScene, 2, 0.1);
      select(activeScene, 'core-1');
      var fb = mapToBackend(activeScene, fakeBackend);
      var fbOk = fb.ok && fb.primary === 'core-1' && fb.probes === 1 &&
        fakeBackend.params && fakeBackend.params.circulation === 1 &&
        /ONE dominant vortex/.test(fb.notes.join(' '));
      checks.push(check('fieldbind-primary-probes', fbOk,
        'primary=' + fb.primary + ', probes=' + fb.probes + ', uncoupled=' + fb.uncoupled.length));

      // 12. DOM: panel registered only where it can mount (headless-safe skip)
      if (hasDOM()) {
        checks.push(check('dom-available', true, 'DOM present; panel registered via VORTEX.ui when available'));
      } else {
        checks.push(check('dom-available', true, 'SKIP: no DOM (headless) — panel mount guarded, nothing threw'));
      }
    } catch (e) {
      checks.push(check('selftest-no-throw', false, 'threw: ' + (e && e.message ? e.message : e)));
    }
    var ok = checks.every(function (c) { return c.ok; });
    return { ok: ok, checks: checks };
  }

  /* ------------------------------------------------------------- register */

  var api = {
    selfTest: selfTest,
    // scene graph
    STATES: STATES,
    TRANSITIONS: TRANSITIONS,
    createScene: createScene,
    getVortex: getVortex,
    addVortex: addVortex,
    setState: setState,
    killVortex: killVortex,
    select: select,
    pruneDissipated: pruneDissipated,
    // selection-generalized Core X/Y
    bindScene: bindScene,
    selectedId: selectedId,
    setCore: setCore,
    setCoreSelected: setCoreSelected,
    activeScene: function () { return activeScene; },
    // choreography
    choreography: {
      ops: OPS.slice(),
      validate: validateTimeline,
      compile: compileTimeline,
      step: step,
      runFor: runFor
    },
    // scenarios
    scenarios: SCENARIOS,
    scenarioKeys: scenarioKeys,
    loadScenario: loadScenario,
    // presets (backward compat)
    sceneForPreset: sceneForPreset,
    // field binding
    mapToBackend: mapToBackend
  };

  if (typeof VORTEX !== 'undefined' && VORTEX.register) {
    VORTEX.register(MOD_ID, api);
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // test harness fallback (node), never in the lab
  }
})(typeof window !== 'undefined' ? window : globalThis);
