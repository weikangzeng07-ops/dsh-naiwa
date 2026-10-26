// ===========================================================================
// 30 — the pet entity: rendering, animation, eyes, interaction
// ===========================================================================
// Ported from pet_app.PetApp. One Pet owns one absolutely-positioned canvas.
//
// Rendering pipeline per frame (same order as the reference `draw()`):
//   frame bitmap → eye layer → local jelly mesh → body affine → paint
//
// The reference chroma-keys to #ff00ff because Windows' `-transparentcolor`
// only keys exact colours. A browser canvas has real alpha, so the chroma step
// is dropped — but the ALPHA_CUTOFF=110 threshold is still applied to hit
// testing so a click can never land on a pixel the original would have passed
// through to the desktop.

var PET_SEQ = 0

/**
 * @param {object} deps
 *   deps.assets   asset cache (frames, eyes, audio)
 *   deps.config   live config object
 *   deps.world    PhysicsWorld
 *   deps.container overlay element
 *   deps.onBubble called with (pet, kind, vars) to show a bubble
 */
function Pet(deps, options) {
  options = options || {}
  PET_SEQ += 1
  this.id = 'pet-' + PET_SEQ
  this.deps = deps
  this.config = deps.config
  this.world = deps.world
  this.container = deps.container

  this.scale = snapScale(options.scale == null ? this.config.pet.scale : options.scale)
  this.emitted = !!options.emitted
  this.sourceId = options.sourceId || null

  // ---- geometry (pet_app: win_w / win_h / clip.fw / clip.fh / clip.fy) ----
  this.fw = Math.max(1, Math.round(BASE_W * this.scale))
  this.fh = Math.max(1, Math.round(BASE_H * this.scale))
  this.padY = Math.round(BODY_PAD * this.scale)
  // The drag body affine can scale/translate the sprite outside the source
  // bitmap. A canvas sized exactly to fw x fh would then crop the stretched
  // body (the "part of the model disappears" bug). Keep a transparent overscan
  // margin so the deformed sprite has room to move without clipping.
  this.overX = Math.round(this.fw * 0.3)
  this.overY = Math.round(this.fh * 0.3)
  this.winW = this.fw + 2 * this.overX
  this.winH = this.fh + 2 * this.overY + 2 * this.padY

  // ---- state ------------------------------------------------------------
  this.mode = 'idle' // idle | playing
  this.curIndex = 0
  this.actionStart = null
  this.loopStart = null
  this.actionSerial = 0
  this.actionAudible = false
  // Audible actions use the media element as their clock (see elapsedSec).
  this.audioEl = null
  this.audioSeek = 0
  this.audioStarted = false
  this.lastAudioElapsed = null
  this.deadline = 0
  this.idleRemaining = null

  this.dragging = false
  this.dragMoved = false
  this.pressValid = false
  this.pressTime = 0
  this.pressLocal = { x: 0, y: 0 }
  this.pressRoot = { x: 0, y: 0 }
  this.winAtPress = { x: 0, y: 0 }
  this.dragBodyEligible = false
  this.dragSamples = []

  this.splitClicks = []
  /** Timer that turns a lone click into the account bubble. */
  this.pendingClick = 0
  this.lastClickAt = 0

  this.jelly = null
  this.body = null
  this.jellyMesh = null
  this.eyes = null
  this.eyeNextFrame = 0

  this.destroyed = false
  this.sleeping = false

  // Physics position = the VISIBLE BOX centre, exactly like the reference.
  this.pos = { x: options.x == null ? 0 : options.x, y: options.y == null ? 0 : options.y }

  // ---- DOM --------------------------------------------------------------
  this.el = document.createElement('canvas')
  this.el.className = CLS + '-pet'
  this.el.width = this.winW
  this.el.height = this.winH
  this.el.style.width = this.winW + 'px'
  this.el.style.height = this.winH + 'px'
  this.el.setAttribute('data-naiwa-pet', this.id)
  this.ctx = this.el.getContext('2d')
  this.container.appendChild(this.el)

  this.frame = null
  this.alpha = null
  this.frameVersion = -1

  this.bindEvents()
  this.resetDeadline()
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Visible box in canvas space (pet_app.visible_box uses the IDLE frame). */
Pet.prototype.visibleBox = function () {
  var idle = this.deps.assets.idleAlpha(this.fw, this.fh)
  if (!idle) {
    return {
      x0: this.overX,
      y0: this.overY + this.padY,
      x1: this.overX + this.fw,
      y1: this.overY + this.padY + this.fh,
    }
  }
  var bb = alphaBBox(idle)
  return {
    x0: bb.x0 + this.overX,
    y0: bb.y0 + this.overY + this.padY,
    x1: bb.x1 + this.overX,
    y1: bb.y1 + this.overY + this.padY,
  }
}

/** Screen (container) position of the foot centre. */
Pet.prototype.footPosition = function () {
  var box = this.visibleBox()
  return {
    x: this.pos.x - box.x0 + (box.x0 + box.x1) / 2,
    y: this.pos.y - box.y0 + box.y1,
  }
}

Pet.prototype.setPosition = function (x, y) {
  this.pos.x = x
  this.pos.y = y
  this.el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)'
}

/** Canvas-space point → content-space point (inverse body + inverse mesh). */
Pet.prototype.contentPoint = function (x, y) {
  var px = x - this.overX
  var py = y - this.overY - this.padY
  if (this.body) {
    var inv = this.body.inverse(px, py)
    px = inv.x
    py = inv.y
  }
  if (this.jelly && this.jellyMesh) {
    var inv2 = this.jelly.inverse(px, py, this.jellyMesh)
    px = inv2.x
    py = inv2.y
  }
  return { x: px, y: py }
}

/**
 * Is the canvas point on an opaque pixel? (pet_app._is_opaque)
 *
 * Before the idle frame has decoded there is no alpha plane. Treating that as
 * "transparent" makes every click a no-op for as long as the first frame takes,
 * so fall back to the visible box instead of rejecting outright.
 */
Pet.prototype.isOpaque = function (x, y) {
  var px = Math.round(x) - this.overX
  var py = Math.round(y) - this.overY - this.padY
  if (!this.alpha) {
    var box = this.visibleBox()
    return (
      px + this.overX >= box.x0 && px + this.overX <= box.x1 &&
      py + this.overY + this.padY >= box.y0 &&
      py + this.overY + this.padY <= box.y1
    )
  }
  if (px < 0 || py < 0 || px >= this.alpha.width || py >= this.alpha.height) return false
  return this.alpha.data[py * this.alpha.width + px] !== 0
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

Pet.prototype.resetDeadline = function () {
  var min = Math.max(20, this.config.pet.randomActionMinSec)
  var max = Math.max(min, this.config.pet.randomActionMaxSec)
  this.deadline = nowSec() + randFloat(min, max)
}

Pet.prototype.animationActive = function () {
  return (this.jelly !== null && this.jelly.active()) || (this.body !== null && this.body.moving())
}

/**
 * Content seconds that should be on screen right now.
 *
 * While the laugh is audible the media element is the master clock: it starts
 * when the sound actually starts, not when `play()` was requested. Subtracting
 * AUDIO_LATENCY_MS makes frame N visible when sample N reaches the speaker.
 *
 * Without audio (sound off, autoplay blocked, clip ended) the wall clock takes
 * over, so a missing sound can never freeze the pet.
 */
Pet.prototype.elapsedSec = function () {
  if (this.mode !== 'playing' || this.actionStart === null) return 0
  var audio = this.audioEl
  if (audio) {
    var ready = audio.readyState >= 2 && !audio.paused && isFinite(audio.currentTime)
    if (ready) {
      this.audioStarted = true
      this.lastAudioElapsed = Math.max(
        0,
        audio.currentTime - this.audioSeek - AUDIO_LATENCY_MS / 1000,
      )
      return this.lastAudioElapsed
    }
    // Hold frame 0 while the element opens its decoder. Without this the wall
    // clock would advance a few frames and then jump back when the media clock
    // takes over.
    if (!this.audioStarted && nowSec() - this.actionStart < AUDIO_START_GRACE_SEC) return 0
    // A clone's element briefly pauses between loop iterations; hold the last
    // good value instead of letting the wall clock run away.
    if (this.loopStart !== null && this.lastAudioElapsed !== null) return this.lastAudioElapsed
  }
  return Math.max(0, nowSec() - this.actionStart)
}

Pet.prototype.animationSnapshot = function () {
  if (this.mode !== 'playing' || this.actionStart === null) return null
  if (this.loopStart === null && this.elapsedSec() * 1000 >= CLIP_FRAMES * FRAME_MS) return null
  return { audible: this.actionAudible }
}

Pet.prototype.play = function (withAudio) {
  if (this.destroyed) return
  // A deliberate audible laugh wins over a half-finished single click; an idle
  // animation (withAudio === false) must not swallow the bubble timer.
  if (withAudio) this.cancelPendingClick()
  this.deps.group.cancelEmission(this)
  this.splitClicks.length = 0
  this.actionSerial += 1
  this.actionAudible = false
  this.audioEl = null
  this.audioSeek = 0
  this.audioStarted = false
  this.lastAudioElapsed = null
  this.dropJelly()
  this.mode = 'playing'
  this.loopStart = this.emitted ? Math.min(LOOP_START, CLIP_FRAMES - 1) : null
  this.curIndex = this.loopStart === null ? 0 : this.loopStart
  this.actionStart = nowSec()
  if (withAudio && this.config.pet.sound) {
    // The track itself already contains the authored 1.577 s lead-in, so the
    // media clock can drive the picture from its very first sample.
    this.audioEl = this.deps.assets.playLaugh(this.id, this.loopStart !== null) || null
    this.audioSeek = this.loopStart === null ? 0 : AUDIO_LOOP_START
    this.actionAudible = true
  } else {
    this.deps.assets.stopLaugh(this.id)
  }
  this.draw()
}

Pet.prototype.inheritAnimation = function (source) {
  var snapshot = source.animationSnapshot()
  if (!snapshot) return
  this.emitted = true
  this.play(snapshot.audible)
}

Pet.prototype.toIdle = function () {
  if (this.destroyed) return
  this.deps.group.cancelEmission(this)
  this.splitClicks.length = 0
  this.actionStart = null
  this.actionAudible = false
  this.loopStart = null
  this.audioEl = null
  this.audioSeek = 0
  this.audioStarted = false
  this.lastAudioElapsed = null
  this.dropJelly()
  this.mode = 'idle'
  this.curIndex = 0
  this.deps.assets.stopLaugh(this.id)
  this.resetDeadline()
  this.draw()
}

Pet.prototype.stopLaugh = function () {
  if (this.mode === 'playing') this.toIdle()
}

/** Frame index for the current instant (media clock while audible). */
Pet.prototype.currentIndex = function () {
  if (this.mode !== 'playing' || this.actionStart === null) return 0
  var elapsedFrames = Math.max(0, Math.floor((this.elapsedSec() * 1000 + 1e-7) / FRAME_MS))
  if (this.loopStart === null) return elapsedFrames
  return this.loopStart + (elapsedFrames % (CLIP_FRAMES - this.loopStart))
}

// ---------------------------------------------------------------------------
// Jelly / body deformation
// ---------------------------------------------------------------------------

Pet.prototype.ensureJelly = function () {
  if (this.jelly === null && this.alpha) this.jelly = new LocalJelly(this.alpha)
  return this.jelly
}

Pet.prototype.ensureBody = function () {
  if (this.body === null && this.alpha) this.body = new BodyJelly(alphaBBox(this.alpha))
  return this.body
}

Pet.prototype.dropJelly = function () {
  var wasDrag = this.dragging && this.dragMoved
  this.jelly = null
  this.jellyMesh = null
  this.pressValid = false
  this.dragging = false
  this.dragBodyEligible = false
  this.finishBody()
  if (wasDrag && !this.destroyed) this.deps.group.setHover(this)
}

Pet.prototype.finishBody = function () {
  this.body = null
}

// ---------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------

Pet.prototype.updateEyes = function (now) {
  if (!this.config.pet.eyeFollow || this.mode !== 'idle') return false
  if (now < this.eyeNextFrame) return false
  this.eyeNextFrame = Math.max(this.eyeNextFrame + EYE_INTERVAL, now)
  var pointer = this.deps.pointer
  if (!pointer.inside) return false
  var rect = this.el.getBoundingClientRect()
  var point = this.contentPoint(pointer.x - rect.left, pointer.y - rect.top)
  return this.deps.assets.advanceEyes(this, point, now)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

Pet.prototype.draw = function () {
  if (this.destroyed) return
  var index = this.currentIndex()
  if (index !== this.curIndex || this.frame === null) {
    this.curIndex = index
  }
  // `frame()` starts the fetch and returns null until the bitmap is decoded.
  // Repaint is driven by Assets.onFrameReady; returning here only skips THIS
  // paint, it does not stop the loop.
  var frame = this.deps.assets.frame(this.fw, this.fh, Math.min(index, CLIP_FRAMES - 1))
  if (!frame) return
  if (frame.version !== this.frameVersion) {
    this.frameVersion = frame.version
    this.frame = frame.image
    this.alpha = frame.alpha
    if (this.jelly) this.jelly = new LocalJelly(this.alpha)
  }

  var ctx = this.ctx
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, this.winW, this.winH)

  var img = this.frame

  // 1) eye layer (idle only)
  if (this.config.pet.eyeFollow && this.mode === 'idle') {
    var eyeCanvas = this.deps.assets.eyeComposite(this)
    if (eyeCanvas) img = eyeCanvas
  }

  // 2) + 3) base image and jelly mesh in ONE coordinate space.
  //
  // The base is always painted in full (the reference pastes the complete
  // source, then the deformed patch runs on top). The mesh must share the
  // body affine: during a drag the body is stretched while a press-jelly field
  // is still decaying, and drawing the mesh untransformed left the deformed
  // patch detached from the stretched body — the "missing pieces" look.
  var body = this.body && this.body.phase !== 'done' ? this.body : null
  var mesh = null
  if (this.jelly && this.jelly.active()) {
    mesh = this.jelly.compile()
    this.jellyMesh = mesh
  } else {
    this.jellyMesh = null
  }

  ctx.save()
  ctx.translate(this.overX, this.overY + this.padY)
  if (body) {
    var p = body.pose
    ctx.transform(p.sx, 0, 0, p.sy, p.tx, p.ty)
  }
  ctx.drawImage(img, 0, 0, this.fw, this.fh)
  if (mesh) drawMesh(ctx, img, this.jelly, mesh)
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

Pet.prototype.bindEvents = function () {
  var self = this
  this.handlers = {
    pointerdown: function (ev) { self.onPointerDown(ev, 'pointer') },
    pointermove: function (ev) { self.onPointerMove(ev) },
    pointerup: function (ev) { self.onPointerUp(ev) },
    pointercancel: function (ev) { self.onPointerUp(ev) },
    // Mouse fallback: a real browser fires pointerdown first and the dedupe in
    // onPointerDown ignores the following mousedown. Environments that only
    // synthesise mouse events (automation, older WebViews) still work.
    mousedown: function (ev) { self.onPointerDown(ev, 'mouse') },
    // The old right-click menu is gone; only suppress the browser menu so the
    // pet remains draggable/clickable without a popup.
    contextmenu: function (ev) { ev.preventDefault() },
    lostpointercapture: function () {
      if (self.dragging) self.cancelDrag()
    },
  }
  this.el.addEventListener('pointerdown', this.handlers.pointerdown)
  this.el.addEventListener('mousedown', this.handlers.mousedown)
  this.el.addEventListener('contextmenu', this.handlers.contextmenu)
}

Pet.prototype.unbindEvents = function () {
  this.el.removeEventListener('pointerdown', this.handlers.pointerdown)
  this.el.removeEventListener('mousedown', this.handlers.mousedown)
  this.el.removeEventListener('contextmenu', this.handlers.contextmenu)
  window.removeEventListener('pointermove', this.handlers.pointermove)
  window.removeEventListener('pointerup', this.handlers.pointerup)
  window.removeEventListener('pointercancel', this.handlers.pointercancel)
  window.removeEventListener('mousemove', this.handlers.pointermove)
  window.removeEventListener('mouseup', this.handlers.pointerup)
  this.el.removeEventListener('lostpointercapture', this.handlers.lostpointercapture)
}

Pet.prototype.localPoint = function (ev) {
  var rect = this.el.getBoundingClientRect()
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
}

Pet.prototype.onPointerDown = function (ev, source) {
  // Dedupe: a real browser sends pointerdown then mousedown for the same press.
  var stamp = Date.now()
  if (source === 'mouse' && this.lastPointerDownAt && stamp - this.lastPointerDownAt < 400) return
  this.lastPointerDownAt = stamp

  if (this.deps.debug) {
    console.info('[dsh-naiwa] pointerdown', {
      source: source || 'pointer',
      button: ev.button,
      target: ev.target && ev.target.className,
      destroyed: this.destroyed,
      mode: this.mode,
    })
  }
  if (this.destroyed || ev.button !== 0) return
  if (this.deps.group.reunifying) return
  var local = this.localPoint(ev)
  this.pressValid = false
  this.pressIdle = this.mode === 'idle'
  this.dragBodyEligible = false
  this.pressTime = nowSec()

  if (!this.isOpaque(local.x, local.y)) {
    if (this.deps.debug) {
      console.info('[dsh-naiwa] press missed the silhouette', {
        local: [Math.round(local.x), Math.round(local.y)],
        padY: this.padY,
        alpha: this.alpha ? [this.alpha.width, this.alpha.height] : null,
        canvas: [this.winW, this.winH],
      })
    }
    this.dragging = false
    return
  }
  ev.preventDefault()
  ev.stopPropagation()
  try { this.el.setPointerCapture(ev.pointerId) } catch (err) { /* not fatal */ }

  this.dragging = true
  this.dragMoved = false
  this.pressRoot = { x: ev.clientX, y: ev.clientY }
  this.winAtPress = { x: this.pos.x, y: this.pos.y }
  this.pressLocal = local
  this.pressValid = true
  if (this.deps.debug) {
    console.info('[dsh-naiwa] press hit', {
      local: [Math.round(local.x), Math.round(local.y)],
      mode: this.mode,
      pendingClick: this.pendingClick !== 0,
    })
  }

  // Attach the drag/click listeners FIRST, unconditionally.
  // These used to come after the jelly + click-sound calls, so any exception in
  // that block (there was one: `assets.playClick` did not exist) left the pet
  // unable to drag, count clicks or pop a bubble.
  window.addEventListener('pointermove', this.handlers.pointermove, { passive: false })
  window.addEventListener('pointerup', this.handlers.pointerup)
  window.addEventListener('pointercancel', this.handlers.pointercancel)
  window.addEventListener('mousemove', this.handlers.pointermove, { passive: false })
  window.addEventListener('mouseup', this.handlers.pointerup)

  this.deps.group.setPrimary(this)

  if (this.pressIdle) {
    try {
      var point = this.contentPoint(local.x, local.y)
      var jelly = this.ensureJelly()
      if (jelly) jelly.beginPress(point, this.pressTime)
      this.pauseIdle()
    } catch (err) {
      if (this.deps.debug) console.warn('[dsh-naiwa] press setup failed', err)
    }
    this.deps.assets.playClick()
  }
}

Pet.prototype.onPointerMove = function (ev) {
  if (this.destroyed || !this.dragging) return
  if (this.deps.group.reunifying) return
  var dx = ev.clientX - this.pressRoot.x
  var dy = ev.clientY - this.pressRoot.y
  if (!this.dragMoved && Math.abs(dx) < DRAG_PX && Math.abs(dy) < DRAG_PX) return

  if (!this.dragMoved) {
    // An ordinary performance stops on drag; an emitted loop keeps its clock.
    if (this.mode === 'playing' && this.loopStart === null) {
      var saved = {
        pressRoot: this.pressRoot,
        pressLocal: this.pressLocal,
        winAtPress: this.winAtPress,
        pressTime: this.pressTime,
      }
      this.toIdle()
      this.pressRoot = saved.pressRoot
      this.pressLocal = saved.pressLocal
      this.winAtPress = saved.winAtPress
      this.pressTime = saved.pressTime
      this.dragging = true
      this.pressIdle = true
    }
    this.deps.group.beginDrag(this)
    this.splitClicks.length = 0
    this.cancelPendingClick()
    this.pressValid = false
    var now = nowSec()
    if (this.jelly) this.jelly.cancelPress(now)
    if (this.pressIdle && this.mode === 'idle') {
      var body = this.ensureBody()
      if (body) {
        body.pickup(this.pressLocal.x, this.pressLocal.y - this.padY, now)
        this.dragBodyEligible = true
        this.pauseIdle()
        this.dragSamples.length = 0
        this.dragSamples.push({ t: Math.max(this.pressTime, now - 0.12), x: this.pressRoot.x, y: this.pressRoot.y })
      }
    } else {
      this.resumeIdle()
    }
    this.draw()
  }
  this.dragMoved = true
  if (this.dragBodyEligible) {
    this.dragSamples.push({ t: nowSec(), x: ev.clientX, y: ev.clientY })
    if (this.dragSamples.length > 128) this.dragSamples.shift()
  }
  this.setPosition(this.winAtPress.x + dx, this.winAtPress.y + dy)
  ev.preventDefault()
}

Pet.prototype.releaseSpeed = function (ev, now) {
  this.dragSamples.push({ t: now, x: ev.clientX, y: ev.clientY })
  var cutoff = now - 0.12
  var distance = 0
  for (var i = 1; i < this.dragSamples.length; i += 1) {
    var a = this.dragSamples[i - 1]
    var b = this.dragSamples[i]
    if (b.t > cutoff && b.t > a.t) {
      var fraction = Math.min(1, (b.t - cutoff) / (b.t - a.t))
      distance += Math.hypot(b.x - a.x, b.y - a.y) * fraction
    }
  }
  var duration = Math.max(0.001, now - Math.max(cutoff, this.dragSamples[0].t))
  var height = this.body ? this.body.height : this.visibleBox().y1 - this.visibleBox().y0
  return distance / duration / Math.max(1, height)
}

Pet.prototype.onPointerUp = function (ev) {
  window.removeEventListener('pointermove', this.handlers.pointermove)
  window.removeEventListener('pointerup', this.handlers.pointerup)
  window.removeEventListener('pointercancel', this.handlers.pointercancel)
  window.removeEventListener('mousemove', this.handlers.pointermove)
  window.removeEventListener('mouseup', this.handlers.pointerup)
  if (this.destroyed || this.deps.group.reunifying) {
    this.dragging = false
    return
  }
  // A pointerup without motion still has to pass the drag threshold.
  if (this.dragging && !this.dragMoved) this.onPointerMove(ev)

  var wasClick =
    this.dragging &&
    !this.dragMoved &&
    Math.abs(ev.clientX - this.pressRoot.x) < DRAG_PX &&
    Math.abs(ev.clientY - this.pressRoot.y) < DRAG_PX
  var wasValid = this.pressValid
  this.pressValid = false

  if (this.dragging && this.dragMoved) {
    if (this.deps.group.tryMerge(this)) return
    this.deps.group.setHover(this)
    if (this.dragBodyEligible && this.body) {
      var now = nowSec()
      this.body.release(this.releaseSpeed(ev, now), now)
    }
  }
  this.dragging = false
  this.dragBodyEligible = false

  if (wasClick && wasValid && this.mode === 'playing') {
    this.completeSplitClick(nowSec())
  } else if (wasClick && wasValid && this.mode === 'idle') {
    this.completeClick(nowSec())
  }
}

Pet.prototype.cancelDrag = function () {
  this.dragging = false
  this.dragBodyEligible = false
  this.dropJelly()
  this.draw()
}

/**
 * Resolve one completed click.
 *
 * A lone click summons the account bubble; a second click inside
 * DOUBLE_CLICK_MS cancels that pending single and starts the laugh, so the
 * bubble never opens on the first half of a double click.
 */
Pet.prototype.completeClick = function (nowSec) {
  if (this.pendingClick && nowSec - this.lastClickAt <= DOUBLE_CLICK_MS / 1000) {
    this.cancelPendingClick()
    this.lastClickAt = 0
    this.deps.group.setPrimary(this)
    this.play(true)
    this.deps.group.onLaugh(this)
    return
  }

  // A late second click (outside the window) is just a new single click; drop
  // the stale timer so the panel opens once, not twice.
  this.cancelPendingClick()
  this.lastClickAt = nowSec

  if (this.body) {
    this.body.handoff(nowSec)
    this.resumeIdle()
  }
  if (this.jelly) this.jelly.release(nowSec)
  this.resumeIdle()

  var self = this
  this.pendingClick = setTimeout(function () {
    self.pendingClick = 0
    self.lastClickAt = 0
    if (self.destroyed) return
    self.deps.group.onSingleClick(self)
  }, DOUBLE_CLICK_MS)
}

Pet.prototype.cancelPendingClick = function () {
  if (!this.pendingClick) return
  clearTimeout(this.pendingClick)
  this.pendingClick = 0
  this.lastClickAt = 0
}

Pet.prototype.completeSplitClick = function (now) {
  while (this.splitClicks.length && now - this.splitClicks[0] > SPLIT_WIN) this.splitClicks.shift()
  this.splitClicks.push(now)
  if (this.splitClicks.length === SPLIT_N) {
    this.splitClicks.length = 0
    this.deps.group.requestSplit(this, now)
  }
}

Pet.prototype.pauseIdle = function () {
  if (this.idleRemaining === null) this.idleRemaining = Math.max(0, this.deadline - nowSec())
}

Pet.prototype.resumeIdle = function () {
  if (this.idleRemaining !== null) {
    this.deadline = nowSec() + this.idleRemaining
    this.idleRemaining = null
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

Pet.prototype.setScale = function (scale) {
  scale = snapScale(scale)
  if (Math.abs(scale - this.scale) < 1e-9) return
  var anchor = this.footPosition()
  this.dropJelly()
  this.deps.group.cancelEmission(this)
  this.splitClicks.length = 0
  this.scale = scale
  this.fw = Math.max(1, Math.round(BASE_W * scale))
  this.fh = Math.max(1, Math.round(BASE_H * scale))
  this.padY = Math.round(BODY_PAD * scale)
  this.overX = Math.round(this.fw * 0.3)
  this.overY = Math.round(this.fh * 0.3)
  this.winW = this.fw + 2 * this.overX
  this.winH = this.fh + 2 * this.overY + 2 * this.padY
  this.el.width = this.winW
  this.el.height = this.winH
  this.el.style.width = this.winW + 'px'
  this.el.style.height = this.winH + 'px'
  this.frameVersion = -1
  this.frame = null
  this.alpha = null
  var box = this.visibleBox()
  var nx = anchor.x - (box.x0 + box.x1) / 2
  var ny = anchor.y - box.y1
  this.setPosition(nx, ny)
  this.deps.group.resizePhysics(this)
  this.draw()
}

Pet.prototype.destroy = function () {
  if (this.destroyed) return
  this.destroyed = true
  this.cancelPendingClick()
  this.unbindEvents()
  this.deps.assets.stopLaugh(this.id)
  this.deps.world.remove(this.id)
  if (this.el.parentNode) this.el.parentNode.removeChild(this.el)
}

/** Wall-clock seconds, matching the reference's `time.monotonic()` usage. */
function nowSec() {
  return performance.now() / 1000
}
