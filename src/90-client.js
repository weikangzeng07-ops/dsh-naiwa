// ===========================================================================
// 90 — Client entry: mount the overlay into `shell.overlay`
// ===========================================================================
//
// Why `shell.overlay`: it is the only frame-wide floating layer the Harness
// renders above every column and outside their scroll containers, and it is
// explicitly click-through (occupants opt back into pointer events). A desktop
// pet needs exactly that: a transparent full-frame surface that never blocks
// the app underneath.
//
// `tools/build.mjs` concatenates `src/*.js` in filename order and wraps the
// result in the `window.__ModuleLoader__.load({ id, factory })` registration
// the Client module system requires.

var CLIENT_STATE = {
  config: null,
  assets: null,
  world: null,
  group: null,
  container: null,
  pointer: { x: 0, y: 0, inside: false },
  ledger: null,
  turnSeq: null,
  disposed: false,
  timers: [],
  listeners: [],
  overlayCss: null,
  cssEl: null,
  booted: false,
}

var CLIENT_CSS = [
  // `position:fixed` rather than `absolute`: the overlay host is a list entry
  // inside `shell.overlay`, whose own positioning context and height are not
  // guaranteed. Fixed-to-viewport makes the layer cover the frame regardless
  // of any ancestor's height, which is what a desktop pet needs.
  //
  // z-index: the pet must float above the conversation and the right sidebar
  // (verified: at z-index 1 the task panel covered it). The value is below the
  // host's modal band so dialogs still win, and dsh-whale-widget's own bands
  // start at 9999 for its body, so 5000 stays clear of that plugin.
  '.' + CLS + '-layer{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;',
  'overflow:hidden;z-index:5000}',
  '.' + CLS + '-layer.' + CLS + '-hidden{display:none}',
  '.' + CLS + '-pet{position:absolute;top:0;left:0;pointer-events:auto;cursor:grab;',
  'touch-action:none;user-select:none;-webkit-user-select:none;will-change:transform;',
  'background:transparent}',
  '.' + CLS + '-pet:active{cursor:grabbing}',
  '.' + CLS + '-bubble{position:absolute;top:0;left:0;pointer-events:none;',
  'background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1f2328);',
  'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));',
  'border-radius:10px;padding:6px 10px;font-size:12px;line-height:1.45;',
  'box-shadow:0 4px 16px rgba(0,0,0,.16);white-space:pre-wrap;word-break:break-word;',
  'opacity:0;transform-origin:50% 100%;transition:opacity .16s ease,scale .16s ease;',
  'scale:.94;font-family:inherit}',
  '.' + CLS + '-bubble-in{opacity:1;scale:1}',

  // ---- whale-style account bubble (bubble menu + editor) -------------------
  '.' + CLS + '-abubble{position:absolute;top:0;left:0;aspect-ratio:1026/700;',
  'pointer-events:none;opacity:0;transform-origin:50% 100%;',
  'transition:opacity .16s ease,scale .16s ease;scale:.94;',
  'filter:drop-shadow(0 8px 18px rgba(15,25,60,.18));z-index:2;font-family:inherit}',
  '.' + CLS + '-abubble-in{opacity:1;scale:1}',
  '.' + CLS + '-abubble svg{display:block;width:100%;height:100%;overflow:visible}',
  '.' + CLS + '-abubble-below svg{transform:scaleY(-1)}',
  // When the shape is flipped, the large ellipse moves to the lower part; keep
  // the text and menu inside it instead of over the transparent top.
  '.' + CLS + '-abubble-below .' + CLS + '-abubble-text{top:33%;height:42%}',
  '.' + CLS + '-abubble-text{position:absolute;left:18%;top:15%;width:49%;height:46%;',
  'display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:4px;',
  'color:#203170;text-align:center;pointer-events:none;box-sizing:border-box;',
  'font-size:calc(11.5px * var(--naiwa-ab-fs, 1))}',
  '.' + CLS + '-abubble-title{font-size:1em;line-height:1.2;font-weight:800;',
  'letter-spacing:.04em;color:#536ba9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.' + CLS + '-abubble-title-turn{color:#203170;font-size:1.06em}',
  '.' + CLS + '-abubble-rows{display:flex;flex-direction:column;gap:3px;width:100%}',
  '.' + CLS + '-abubble-row{display:flex;align-items:baseline;justify-content:center;',
  'gap:4px;width:100%;white-space:nowrap}',
  '.' + CLS + '-abubble-label{flex:0 1 auto;min-width:0;font-size:1em;line-height:1.3;color:#6f84b8;',
  'overflow:hidden;text-overflow:ellipsis}',
  '.' + CLS + '-abubble-value{flex:0 0 auto;font-size:1.2em;line-height:1.2;font-weight:800;',
  'color:#203170;font-variant-numeric:tabular-nums}',
  '.' + CLS + '-abubble-value-today{font-size:1.2em;font-weight:700}',
  '.' + CLS + '-abubble-value-balance{font-size:1.43em;font-weight:800}',
  '.' + CLS + '-abubble-menu{position:absolute;top:34%;right:23%;',
  'width:calc(18px * var(--naiwa-ab-fs, 1));height:calc(18px * var(--naiwa-ab-fs, 1));',
  'border:0;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;',
  'pointer-events:auto;display:flex;flex-direction:column;align-items:center;',
  'justify-content:center;gap:3px;padding:0;z-index:3;opacity:.85;',
  'transition:opacity .15s ease,background .15s ease}',
  '.' + CLS + '-abubble-menu:hover{opacity:1;background:#203170}',
  '.' + CLS + '-abubble-menu span{display:block;width:calc(12px * var(--naiwa-ab-fs, 1));',
  'height:2px;background:#fff;border-radius:1px}',

  '.' + CLS + '-amenupop{position:absolute;top:0;left:0;pointer-events:auto;min-width:188px;',
  'max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;box-sizing:border-box;',
  'background:rgba(255,255,255,.96);border:1px solid rgba(32,49,112,.35);border-radius:10px;',
  'padding:6px;box-shadow:0 10px 28px rgba(15,25,60,.22);color:#203170;font-size:12px;',
  'display:flex;flex-direction:column;gap:1px;z-index:6;opacity:0;',
  'transition:opacity .12s ease;font-family:inherit}',
  '.' + CLS + '-amenupop-in{opacity:1}',
  '.' + CLS + '-amenuitem{display:block;width:100%;text-align:left;border:0;background:transparent;',
  'color:inherit;font:inherit;padding:6px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}',
  '.' + CLS + '-amenuitem:hover:not(:disabled){background:rgba(32,49,112,.14)}',
  '.' + CLS + '-amenuitem:disabled{opacity:.4;cursor:default}',
  '.' + CLS + '-amenusep{height:1px;margin:4px 5px;background:rgba(32,49,112,.16)}',
  '.' + CLS + '-amenulabel{padding:4px 9px 2px;font-size:10px;letter-spacing:.06em;',
  'color:#7d8fc4;text-transform:uppercase}',

  '.' + CLS + '-bedit{position:absolute;width:300px;max-height:calc(100vh - 24px);',
  'overflow:auto;box-sizing:border-box;pointer-events:auto;background:rgba(255,255,255,.97);',
  'border:1px solid rgba(32,49,112,.35);border-radius:12px;',
  'box-shadow:0 14px 34px rgba(15,25,60,.26);color:#203170;font-size:12px;',
  'z-index:7;opacity:0;transition:opacity .14s ease;font-family:inherit}',
  '.' + CLS + '-bedit-in{opacity:1}',
  '.' + CLS + '-bedit-head{display:flex;align-items:center;justify-content:space-between;',
  'padding:9px 12px;border-bottom:1px solid rgba(32,49,112,.16)}',
  '.' + CLS + '-bedit-title{font-weight:700;font-size:13px}',
  '.' + CLS + '-bedit-close{border:0;background:transparent;color:#203170;font-size:18px;',
  'line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}',
  '.' + CLS + '-bedit-close:hover{background:rgba(32,49,112,.12)}',
  '.' + CLS + '-bedit-body{display:flex;flex-direction:column;gap:8px;padding:10px 12px}',
  '.' + CLS + '-bedit-field{display:flex;flex-direction:column;gap:3px}',
  '.' + CLS + '-bedit-label{font-size:10px;color:#6f84b8;letter-spacing:.04em}',
  '.' + CLS + '-bedit-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;',
  'border-radius:6px;border:1px solid rgba(32,49,112,.35);background:#fff;color:#203170;',
  'font:inherit;font-size:12px}',
  '.' + CLS + '-bedit-input:focus{outline:2px solid rgba(32,49,112,.25);outline-offset:1px}',
  '.' + CLS + '-bedit-check{display:flex;align-items:center;gap:7px;font-size:12px;cursor:pointer}',
  '.' + CLS + '-bedit-check input{accent-color:#203170}',
  '.' + CLS + '-bedit-foot{display:flex;align-items:center;gap:7px;padding:9px 12px 11px;',
  'border-top:1px solid rgba(32,49,112,.16)}',
  '.' + CLS + '-bedit-status{flex:1;min-width:0;font-size:10px;color:#b42318;',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.' + CLS + '-bedit-btn{border:1px solid rgba(32,49,112,.4);border-radius:6px;',
  'background:rgba(32,49,112,.08);color:#203170;font:inherit;font-size:11px;',
  'padding:5px 8px;cursor:pointer;white-space:nowrap}',
  '.' + CLS + '-bedit-btn:hover{background:rgba(32,49,112,.16)}',
  '.' + CLS + '-bedit-save{background:#203170;color:#fff;border-color:#203170}',
  '.' + CLS + '-bedit-save:hover{background:#2b418f}',

  '@media (prefers-reduced-motion: reduce){.' + CLS + '-bubble{transition:none}}',

  // ---- settings page ----
  '.' + CLS + '-set{display:flex;flex-direction:column;gap:2px;padding:4px 0;font-size:12px}',
  '.' + CLS + '-set-head{font-size:15px;font-weight:600;margin:2px 0 10px}',
  '.' + CLS + '-set-section{font-size:11px;font-weight:600;letter-spacing:.03em;',
  'text-transform:uppercase;color:var(--dsw-alias-label-secondary,#6b7280);',
  'margin:16px 0 4px;padding-top:10px;',
  'border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
  '.' + CLS + '-set-row{display:flex;align-items:center;justify-content:space-between;',
  'gap:12px;padding:6px 0}',
  '.' + CLS + '-set-label{flex:1;min-width:0}',
  '.' + CLS + '-set-input{width:120px;padding:3px 6px;border-radius:6px;font:inherit;',
  'color:inherit;background:var(--dsw-alias-bg-layer-1,#f7f7f8);',
  'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}',
  '.' + CLS + '-set-range{width:120px}',
  '.' + CLS + '-set-tiers{display:flex;gap:4px}',
  '.' + CLS + '-set-tier{padding:3px 7px;border-radius:999px;font:inherit;cursor:pointer;',
  'color:inherit;background:var(--dsw-alias-bg-layer-1,#f7f7f8);',
  'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}',
  '.' + CLS + '-set-tier-on{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;',
  'border-color:transparent}',
  '.' + CLS + '-set-hint{font-size:11px;line-height:1.5;margin:6px 0 8px;',
  'color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.' + CLS + '-set-lines{display:flex;flex-direction:column;gap:8px}',
  '.' + CLS + '-set-line{display:flex;flex-direction:column;gap:3px}',
  '.' + CLS + '-set-line-label{font-size:11px;display:flex;align-items:center;gap:6px}',
  '.' + CLS + '-set-line-key{font-size:9px;opacity:.6;font-family:ui-monospace,monospace}',
  '.' + CLS + '-set-textarea{width:100%;box-sizing:border-box;padding:5px 7px;border-radius:6px;',
  'font:inherit;resize:vertical;color:inherit;background:var(--dsw-alias-bg-layer-1,#f7f7f8);',
  'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}',
  '.' + CLS + '-set-ledger{display:flex;flex-direction:column;gap:3px;padding:8px 10px;',
  'border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f7f7f8);line-height:1.5}',
  '.' + CLS + '-set-note{font-size:11px;line-height:1.6;',
  'color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.' + CLS + '-set-actions{display:flex;align-items:center;gap:10px;margin:18px 0 4px}',
  '.' + CLS + '-set-save{padding:6px 18px;border-radius:8px;font:inherit;font-weight:600;',
  'cursor:pointer;border:0;color:#fff;background:var(--dsw-alias-brand-primary,#4d6bfe)}',
  '.' + CLS + '-set-save:hover{filter:brightness(1.06)}',
  '.' + CLS + '-set-status{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}',
].join('')

// ---------------------------------------------------------------------------
// Boot / teardown
// ---------------------------------------------------------------------------

/**
 * Inject the plugin stylesheet exactly once per Client run.
 *
 * Without this the overlay host has no `position:absolute;inset:0` and each
 * pet `<canvas>` has no `position:absolute` — the canvases stack in normal
 * flow inside a zero-height click-through layer, so the pet never becomes
 * visible even though it is created and drawn.
 */
function clientEnsureCss() {
  if (CLIENT_STATE.cssEl) return
  var el = document.createElement('style')
  el.setAttribute('data-plugin-css', 'dsh-naiwa')
  el.textContent = CLIENT_CSS
  ;(document.head || document.documentElement).appendChild(el)
  CLIENT_STATE.cssEl = el
}

function clientRemoveCss() {
  if (!CLIENT_STATE.cssEl) return
  if (CLIENT_STATE.cssEl.parentNode) CLIENT_STATE.cssEl.parentNode.removeChild(CLIENT_STATE.cssEl)
  CLIENT_STATE.cssEl = null
}

function clientBoot(container) {
  // A React effect can run more than once (StrictMode double-invoke, a re-mount
  // after the slot re-declares, HMR). `clientTeardown` sets `disposed`, so
  // without clearing it here the second mount is a permanent no-op: the engine
  // logs "started" from the first mount, teardown removes the canvas, and the
  // pet never comes back.
  CLIENT_STATE.disposed = false
  CLIENT_STATE.container = container
  clientEnsureCss()
  // Every boot gets a token; a completion from an older boot is ignored.
  var token = (CLIENT_STATE.bootToken || 0) + 1
  CLIENT_STATE.bootToken = token

  fetch(API_BASE + '/config.json', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) throw new Error('config-http-' + res.status)
      return res.json()
    })
    .then(function (body) {
      if (CLIENT_STATE.disposed || token !== CLIENT_STATE.bootToken) return
      CLIENT_STATE.config = normalizeClientConfig(body && body.config)
      clientStart(container)
    })
    .catch(function (err) {
      if (CLIENT_STATE.disposed || token !== CLIENT_STATE.bootToken) return
      try {
        console.warn('[dsh-naiwa] config unavailable, using defaults:', String((err && err.message) || err))
      } catch (e) { /* no console */ }
      CLIENT_STATE.config = normalizeClientConfig(null)
      clientStart(container)
    })
}

function clientStart(container) {
  if (CLIENT_STATE.disposed) return
  var config = CLIENT_STATE.config
  if (!config.enabled || !config.pet.visible) return

  // A re-mount starts a clean engine: stop the previous group and audio before
  // building a new one, otherwise the old rAF loop keeps drawing into canvases
  // that are about to be replaced.
  if (CLIENT_STATE.group) {
    try { CLIENT_STATE.group.dispose() } catch (err) { /* already gone */ }
    CLIENT_STATE.group = null
  }
  if (CLIENT_STATE.assets && CLIENT_STATE.assets.audio) {
    try { CLIENT_STATE.assets.audio.dispose() } catch (err) { /* already gone */ }
  }

  var assets = new Assets(config)
  // Repaint hook must exist BEFORE the first Pet is constructed: constructing a
  // pet starts the idle-frame request, and the callback is what turns that
  // arrival into the first visible paint.
  assets.onFrameReady = function () {
    if (!CLIENT_STATE.group) return
    var pets = CLIENT_STATE.group.pets
    for (var i = 0; i < pets.length; i += 1) {
      if (!pets[i].destroyed) pets[i].draw()
    }
  }
  assets.onEyeReady = function () {
    if (!CLIENT_STATE.group) return
    var pets = CLIENT_STATE.group.pets
    for (var i = 0; i < pets.length; i += 1) {
      if (!pets[i].destroyed) pets[i].draw()
    }
  }
  assets.onAssetError = function (url) {
    // A missing asset must not silently blank the pet; log once and continue
    // so whatever DID load can still render.
    try { console.error('[dsh-naiwa] missing asset:', url) } catch (err) { /* no console */ }
  }
  assets.loadEyes()
  assets.audio = new AudioBank(config)
  assets.audio.host = container
  assets.audio.prewarm()
  CLIENT_STATE.assets = assets

  var world = new PhysicsWorld()
  CLIENT_STATE.world = world

  var deps = {
    config: config,
    assets: assets,
    world: world,
    container: container,
    pointer: CLIENT_STATE.pointer,
    group: null,
    // `?naiwa-debug=1` turns on interaction tracing without a rebuild.
    debug: /[?&]naiwa-debug=1/.test(window.location.search),
  }
  var group = new Group(deps)
  deps.group = group
  CLIENT_STATE.group = group

  group.refreshBounds()

  var first = new Pet(deps, { scale: config.pet.scale })
  var bounds = world.bounds
  var box = first.visibleBox()
  var placement = initialPlacement(config.pet.startPosition, bounds, box)
  first.setPosition(placement.x, placement.y)
  group.register(first)

  // The overlay may not have its final box during the first synchronous frame
  // (the host mounts and lays out asynchronously). Re-measure once after the
  // first paint and re-place the pet if the world actually changed, so a pet
  // placed against a 1x1 world never stays stranded in a corner.
  requestAnimationFrame(function () {
    if (CLIENT_STATE.disposed) return
    var before = { w: world.bounds.right, h: world.bounds.bottom }
    group.refreshBounds()
    var after = { w: world.bounds.right, h: world.bounds.bottom }
    if (before.w === after.w && before.h === after.h) return
    var b2 = first.visibleBox()
    var p2 = initialPlacement(config.pet.startPosition, world.bounds, b2)
    first.setPosition(p2.x, p2.y)
    group.setHover(first)
    first.draw()
  })
  assets.onFrameReady = function () {
    if (!CLIENT_STATE.group) return
    var pets = CLIENT_STATE.group.pets
    for (var i = 0; i < pets.length; i += 1) pets[i].draw()
  }

  // ---- pointer (eyes) ----------------------------------------------------
  var onPointerMove = function (ev) {
    CLIENT_STATE.pointer.x = ev.clientX
    CLIENT_STATE.pointer.y = ev.clientY
    CLIENT_STATE.pointer.inside = true
  }
  var onPointerOut = function (ev) {
    if (!ev.relatedTarget) CLIENT_STATE.pointer.inside = false
  }
  var onResize = function () {
    group.refreshBounds()
  }
  var onVisibility = function () {
    if (!config.pet.pauseWhenHidden) return
    group.paused = document.hidden
    if (document.hidden) {
      // Do not freeze a laugh while its audio is stopped: the media clock would
      // be gone when the tab comes back. End the action instead, so the pet
      // returns to idle in sync rather than jumping to the last frame.
      group.stopAllLaughs()
      assets.audio.stopAll()
    } else {
      group.lastPhysicsAt = nowSec()
    }
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  document.addEventListener('pointerout', onPointerOut)
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  CLIENT_STATE.listeners.push(
    function () { window.removeEventListener('pointermove', onPointerMove) },
    function () { document.removeEventListener('pointerout', onPointerOut) },
    function () { window.removeEventListener('resize', onResize) },
    function () { document.removeEventListener('visibilitychange', onVisibility) },
  )

  // Interaction tracing: proves whether the pointer reaches the page at all and
  // which element it lands on. Enabled by `?naiwa-debug=1`.
  if (deps.debug) {
    var traceDown = function (ev) {
      var t = ev.target || {}
      var at = document.elementFromPoint(ev.clientX, ev.clientY)
      function desc(node) {
        if (!node) return 'null'
        var cls = node.className && typeof node.className === 'string' ? node.className : ''
        return (node.nodeName || '?') + (cls ? '.' + cls.split(/\s+/).join('.') : '')
      }
      console.info(
        '[dsh-naiwa] down type=' + ev.type +
        ' xy=' + Math.round(ev.clientX) + ',' + Math.round(ev.clientY) +
        ' target=' + desc(t) +
        ' hitAt=' + desc(at) +
        ' canvases=' + document.querySelectorAll('canvas.' + CLS + '-pet').length,
      )
    }
    var traceMove = function (ev) {
      if (traceMove.count > 2) return
      traceMove.count += 1
      console.info('[dsh-naiwa] move xy=' + Math.round(ev.clientX) + ',' + Math.round(ev.clientY))
    }
    traceMove.count = 0
    document.addEventListener('pointerdown', traceDown, true)
    document.addEventListener('mousedown', traceDown, true)
    document.addEventListener('pointermove', traceMove, true)
    CLIENT_STATE.listeners.push(
      function () { document.removeEventListener('pointerdown', traceDown, true); document.removeEventListener('mousedown', traceDown, true) },
      function () { document.removeEventListener('pointermove', traceMove, true) },
    )

    // Audio/video clock probe. `frame` is the animation content and `audio` the
    // media time; while the laugh is audible they should advance together, with
    // `frame / 30` trailing `audio` by the output latency only.
    var traceSync = function () {
      var pet = group.pets[0]
      if (!pet || pet.mode !== 'playing') return
      var audio = pet.audioEl
      console.info(
        '[dsh-naiwa] sync frame=' + pet.currentIndex() +
        ' elapsed=' + pet.elapsedSec().toFixed(3) +
        ' audio=' + (audio && isFinite(audio.currentTime) ? audio.currentTime.toFixed(3) : 'null') +
        ' rate=' + (audio ? audio.playbackRate : 'null') +
        ' paused=' + (audio ? audio.paused : 'null'),
      )
    }
    CLIENT_STATE.timers.push(setInterval(traceSync, 1000))
  }

  // ---- accounting --------------------------------------------------------
  if (config.accounting.enabled) {
    var poll = function () {
      fetch(API_BASE + '/ledger.json', { cache: 'no-store' })
        .then(function (res) { return res.json() })
        .then(function (snapshot) {
          if (CLIENT_STATE.disposed) return
          CLIENT_STATE.ledger = snapshot
          group.ledger = snapshot
          group.refreshAccountBubble()
        })
        .catch(function () {
          CLIENT_STATE.ledger = { ok: false, reason: 'network' }
          group.ledger = CLIENT_STATE.ledger
          group.refreshAccountBubble()
        })
    }
    poll()
    CLIENT_STATE.timers.push(setInterval(poll, Math.max(5, config.accounting.pollSec) * 1000))

    // The Host exposes one entry per completed turn (seq + amount). Poll it so
    // the whale-style account bubble, not the old prompt box, reports each
    // turn's cost. The first read only primes the sequence.
    if (config.accounting.announce) {
      var pollTurn = function () {
        fetch(API_BASE + '/turn.json', { cache: 'no-store' })
          .then(function (res) {
            if (!res.ok) throw new Error('no-turn-feed')
            return res.json()
          })
          .then(function (payload) {
            if (CLIENT_STATE.disposed || !payload || payload.ok === false) return
            var seq = Number(payload.seq) || 0
            if (CLIENT_STATE.turnSeq === null) {
              CLIENT_STATE.turnSeq = seq
              return
            }
            // Host reload may restart the sequence; follow it down without
            // replaying an old turn.
            if (seq < CLIENT_STATE.turnSeq) {
              CLIENT_STATE.turnSeq = seq
              return
            }
            if (seq === CLIENT_STATE.turnSeq) return
            CLIENT_STATE.turnSeq = seq
            if (isFinite(Number(payload.amount))) {
              group.announceTurn({
                amount: payload.amount,
                tokens: payload.tokens,
                ts: payload.ts,
              })
            }
          })
          .catch(function () { /* host not ready: silent */ })
      }
      pollTurn()
      CLIENT_STATE.timers.push(setInterval(pollTurn, 2000))
    }
  }

  // ---- hotkeys (in-page; the reference uses global hotkeys, unavailable here)
  var onKey = function (ev) {
    var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : ''
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    if (ev.target && ev.target.isContentEditable) return
    if (ev.ctrlKey && ev.altKey && ev.key === '1') {
      ev.preventDefault()
      group.playAll(true)
    } else if (ev.ctrlKey && ev.altKey && (ev.key === 'q' || ev.key === 'Q')) {
      ev.preventDefault()
      group.hideAll()
    }
  }
  window.addEventListener('keydown', onKey)
  CLIENT_STATE.listeners.push(function () { window.removeEventListener('keydown', onKey) })

  // One startup line so a failure is diagnosable from the console alone.
  try {
    console.info(
      '[dsh-naiwa] engine started',
      'pets=1',
      'scale=' + first.scale,
      'win=' + first.winW + 'x' + first.winH,
      'at=' + Math.round(placement.x) + ',' + Math.round(placement.y),
      'bounds=' + Math.round(bounds.right) + 'x' + Math.round(bounds.bottom),
      'eyes=' + (assets.eyeReady ? 'loading' : 'pending'),
    )
  } catch (err) {
    /* no console */
  }
}

function clientTeardown() {
  CLIENT_STATE.disposed = true
  for (var i = 0; i < CLIENT_STATE.timers.length; i += 1) clearInterval(CLIENT_STATE.timers[i])
  CLIENT_STATE.timers.length = 0
  for (var j = 0; j < CLIENT_STATE.listeners.length; j += 1) {
    try { CLIENT_STATE.listeners[j]() } catch (err) { /* already gone */ }
  }
  CLIENT_STATE.listeners.length = 0
  if (CLIENT_STATE.group) CLIENT_STATE.group.dispose()
  if (CLIENT_STATE.assets && CLIENT_STATE.assets.audio) CLIENT_STATE.assets.audio.dispose()
  CLIENT_STATE.group = null
  CLIENT_STATE.assets = null
  CLIENT_STATE.world = null
  CLIENT_STATE.ledger = null
  CLIENT_STATE.turnSeq = null
  CLIENT_STATE.container = null
  clientRemoveCss()
  CLIENT_STATE.booted = false
}

function initialPlacement(position, bounds, box) {
  var margin = 24
  var x
  var y = bounds.bottom - box.y1 - margin
  if (position === 'bottom-left') {
    x = bounds.left + margin - box.x0
  } else if (position === 'bottom-center') {
    x = (bounds.right - bounds.left) / 2 - (box.x0 + box.x1) / 2
  } else if (position === 'random') {
    var hi = Math.max(bounds.left + margin, bounds.right - box.x1 - margin)
    x = randFloat(bounds.left + margin, hi) - box.x0
  } else {
    x = bounds.right - box.x1 - margin
  }
  return { x: x, y: y }
}

// ---------------------------------------------------------------------------
// The React overlay component
// ---------------------------------------------------------------------------

function createOverlayComponent(React) {
  return function NaiwaOverlay() {
    var ref = React.useRef(null)
    React.useEffect(function () {
      var el = ref.current
      if (!el) return undefined
      clientBoot(el)
      return function () { clientTeardown() }
    }, [])
    return React.createElement('div', {
      ref: ref,
      className: CLS + '-layer',
      'data-dsh-naiwa': 'layer',
    })
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

var CLIENT_EXPORTS = { inject: ['slots'], apply: clientApply }

function clientApply(ctx) {
  var React = ctx.get('react') || require('react')
  var Overlay = createOverlayComponent(React)
  var SettingsSection = createSettingsSection(React)

  if (typeof ctx.effect === 'function') {
    ctx.effect(function () {
      return function () { clientTeardown() }
    }, 'dsh-naiwa: pet engine')
  }

  var slots = ctx.get('slots') || ctx.slots
  if (!slots || typeof slots.inject !== 'function') {
    try { console.warn('[dsh-naiwa] slots service unavailable; the pet cannot mount') } catch (e) {}
    return
  }

  // The pet itself: a frame-wide click-through layer.
  slots.inject('shell.overlay', function () {
    return slots.register(
      { name: 'shell.overlay', id: 'dsh-naiwa-pet', order: 120 },
      Overlay,
    )
  })

  // Configuration page in Settings → 奶蛙桌宠.
  slots.inject('settings.section', function () {
    return slots.register(
      {
        name: 'settings.section',
        id: 'dsh-naiwa',
        order: 120,
        label: function () { return '奶蛙桌宠' },
      },
      SettingsSection,
    )
  })
}
