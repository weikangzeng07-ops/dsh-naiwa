// ===========================================================================
// 40 — assets: frames, eyes, audio
// ===========================================================================
// Frames are 432 individual WebP files (the original ships them that way).
// They are decoded lazily, cached per display size, and only the frames a pet
// is about to show are requested. Audio uses Web Audio with the exact PCM
// semantics of the reference (a looping sub-segment for emitted clones).

/**
 * @param {object} options
 *   options.frames      number of frames in the clip
 *   options.scaleOf     () => current pet scale (for preload sizing)
 */
function Assets(config) {
  this.config = config
  this.frameCache = new Map() // "w:h:index" -> { image, alpha, version }
  this.loading = new Set()
  this.failed = new Set()
  this.reported = new Set()
  this.idleAlphaCache = new Map() // "w:h" -> Uint8Array
  this.eyeCache = new Map() // "w:h" -> eye layer prototype
  this.eyeCanvas = new Map() // petId -> canvas
  this.version = 0
  this.audio = null
  this.eyeImage = null
  this.eyeReady = false
  this.eyeFailed = false
  this.onFrameReady = null
  this.onAssetError = null
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

Assets.prototype.frameKey = function (w, h, index) {
  return w + ':' + h + ':' + index
}

/**
 * Get a frame, or null while it is still loading.
 * The decoded bitmap is kept per display size, like the reference's LRU.
 */
Assets.prototype.frame = function (w, h, index) {
  var key = this.frameKey(w, h, index)
  var hit = this.frameCache.get(key)
  if (hit) return hit
  // A failed frame is remembered so a broken route cannot produce an endless
  // request storm (the first run logged 60+ identical 404s for one frame).
  if (this.failed.has(key)) return null
  if (!this.loading.has(key)) {
    this.loading.add(key)
    var self = this
    var url = ASSET_BASE + '/frames/' + frameFile(index) + AUDIO_QS
    var img = new Image()
    img.decoding = 'async'
    img.onload = function () {
      self.loading.delete(key)
      var alpha
      try {
        alpha = self.buildAlpha(img, w, h)
      } catch (err) {
        // A tainted or zero-sized image must not take the whole pet down.
        self.failed.add(key)
        self.reportError(url, err)
        return
      }
      var entry = { image: self.resized(img, w, h, index), alpha: alpha, version: ++self.version }
      self.frameCache.set(key, entry)
      if (self.onFrameReady) self.onFrameReady()
    }
    img.onerror = function () {
      self.loading.delete(key)
      self.failed.add(key)
      self.reportError(url, 'image-load-failed')
    }
    img.src = url
  }
  return null
}

/** Report a broken asset once per URL, never per frame. */
Assets.prototype.reportError = function (url, detail) {
  if (this.reported.has(url)) return
  this.reported.add(url)
  try {
    console.error('[dsh-naiwa] asset unavailable:', url, String((detail && detail.message) || detail))
  } catch (err) {
    /* no console is not fatal */
  }
  if (this.onAssetError) this.onAssetError(url, detail)
}

/** Keep the decoded image at its native size; drawImage scales on demand. */
Assets.prototype.resized = function (img, w, h, index) {
  if (img.naturalWidth === w && img.naturalHeight === h) return img
  var canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  var ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  return canvas
}

/** Binary alpha at display size, thresholded at ALPHA_CUTOFF (hit testing). */
Assets.prototype.buildAlpha = function (img, w, h) {
  var canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  var ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, w, h)
  var data = ctx.getImageData(0, 0, w, h).data
  var out = new Uint8Array(w * h)
  for (var i = 0; i < out.length; i += 1) {
    out[i] = data[i * 4 + 3] >= ALPHA_CUTOFF ? 1 : 0
  }
  return { width: w, height: h, data: out }
}

/** The idle frame's binary alpha, used for the visible box. */
Assets.prototype.idleAlpha = function (w, h) {
  var key = w + ':' + h
  var hit = this.idleAlphaCache.get(key)
  if (hit) return hit
  var frame = this.frame(w, h, 0)
  if (!frame) return null
  this.idleAlphaCache.set(key, frame.alpha)
  return frame.alpha
}

// ---------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------

Assets.prototype.loadEyes = function () {
  if (this.eyeImage) return
  var self = this
  this.eyeImage = {}
  var pending = 2
  function done() {
    pending -= 1
    if (pending === 0) {
      // Both layers must exist; a half-loaded eye set would composite a
      // missing backing under a floating pupil.
      self.eyeReady = !!(self.eyeImage.backing && self.eyeImage.pupil)
      if (!self.eyeReady) {
        self.eyeFailed = true
        self.reportError(ASSET_BASE + '/eyes/', 'eye-layer-unavailable')
      }
      if (self.onEyeReady) self.onEyeReady(self.eyeReady)
    }
  }
  var backing = new Image()
  backing.onload = function () { self.eyeImage.backing = backing; done() }
  backing.onerror = function () { done() }
  backing.src = ASSET_BASE + '/eyes/backing.png' + AUDIO_QS
  var pupil = new Image()
  pupil.onload = function () { self.eyeImage.pupil = pupil; done() }
  pupil.onerror = function () { done() }
  pupil.src = ASSET_BASE + '/eyes/pupil.png' + AUDIO_QS
}

/**
 * Build (and cache) the eye layer prototype for one display size.
 * Mirrors pet_eyes.EyeFollow._prepare: the backing is stretched into the
 * calibrated ellipse, the pupil sprite is sized from geometry.json, and the
 * ROI is the hard-coded 17×18 reference-pixel window.
 */
Assets.prototype.eyePrototype = function (w, h) {
  if (!this.eyeReady) return null
  var key = w + ':' + h
  var hit = this.eyeCache.get(key)
  if (hit) return hit

  var sx = w / EYE_GEOMETRY.referenceSize[0]
  var sy = h / EYE_GEOMETRY.referenceSize[1]
  var roi = [
    Math.floor(EYE_ROI[0] * sx),
    Math.floor(EYE_ROI[1] * sy),
    Math.ceil(EYE_ROI[2] * sx),
    Math.ceil(EYE_ROI[3] * sy),
  ]
  // The eye box is expressed in CONTENT coordinates (the same space as the
  // frame bitmap). The reference subtracts the ROI origin because it draws into
  // a ROI-sized patch; this port composites onto a full-frame canvas, so the
  // ROI subtraction must NOT be applied here or the eye lands at the top-left
  // corner of the frame (which is exactly what "eyes do not follow" looked like).
  var box = [
    EYE_GEOMETRY.eyeBox[0] * sx,
    EYE_GEOMETRY.eyeBox[1] * sy,
    EYE_GEOMETRY.eyeBox[2] * sx,
    EYE_GEOMETRY.eyeBox[3] * sy,
  ]
  var proto = {
    w: w,
    h: h,
    sx: sx,
    sy: sy,
    roi: roi,
    box: box,
    width: Math.max(1, roi[2] - roi[0]),
    height: Math.max(1, roi[3] - roi[1]),
    pupilW: Math.max(1, EYE_GEOMETRY.pupilSize[0] * sx),
    pupilH: Math.max(1, EYE_GEOMETRY.pupilSize[1] * sy),
    center: EYE_GEOMETRY.pupilCenter,
    canvas: null,
  }
  proto.canvas = document.createElement('canvas')
  proto.canvas.width = proto.width
  proto.canvas.height = proto.height
  this.eyeCache.set(key, proto)
  return proto
}

/** Create (or reuse) the per-pet eye canvas and its pupil offset state. */
Assets.prototype.eyeState = function (pet) {
  var state = pet.eyeState
  if (!state) {
    state = pet.eyeState = { position: { x: 0, y: 0 }, lastUpdate: null, proto: null }
  }
  return state
}

/**
 * Advance the pupil toward the pointer (pet_eyes.EyeFollow.advance).
 * @returns {boolean} whether anything moved
 */
Assets.prototype.advanceEyes = function (pet, point, now) {
  var proto = this.eyePrototype(pet.fw, pet.fh)
  if (!proto) return false
  var state = this.eyeState(pet)
  state.proto = proto

  var dx = point.x / proto.sx - proto.center[0]
  var dy = point.y / proto.sy - proto.center[1]
  var distance = Math.hypot(dx, dy)
  var factor = distance > 1e-9 ? Math.tanh(distance / 200) / distance : 0
  var tx = EYE_LIMIT_X * dx * factor
  var ty = EYE_LIMIT_Y * dy * factor
  var dt = state.lastUpdate === null ? EYE_INTERVAL : Math.max(0, Math.min(0.25, now - state.lastUpdate))
  state.lastUpdate = now
  var blend = 1 - Math.exp(-dt / EYE_SMOOTH_SEC)
  var before = { x: state.position.x, y: state.position.y }
  state.position = {
    x: Math.abs(tx - before.x) < 0.005 ? tx : before.x + (tx - before.x) * blend,
    y: Math.abs(ty - before.y) < 0.005 ? ty : before.y + (ty - before.y) * blend,
  }
  return (
    Math.max(
      Math.abs(before.x - state.position.x),
      Math.abs(before.y - state.position.y),
    ) > 1e-6
  )
}

/**
 * Render the frame with the eye layer composited on top.
 * Returns the source bitmap to feed the mesh warp.
 */
Assets.prototype.eyeComposite = function (pet) {
  var proto = this.eyePrototype(pet.fw, pet.fh)
  if (!proto || !pet.frame) return null
  // The eye layer is optional: without both bitmaps the plain frame is used.
  if (!this.eyeImage || !this.eyeImage.backing || !this.eyeImage.pupil) return null
  var state = this.eyeState(pet)
  state.proto = proto

  var canvas = pet.eyeCanvas
  if (!canvas) canvas = pet.eyeCanvas = document.createElement('canvas')
  if (canvas.width !== pet.fw || canvas.height !== pet.fh) {
    canvas.width = pet.fw
    canvas.height = pet.fh
  }
  var ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(pet.frame, 0, 0, pet.fw, pet.fh)

  // `proto.box` is [x0,y0,x1,y1] in CONTENT coordinates (the ROI origin is
  // already subtracted in eyePrototype), and this canvas IS the content-sized
  // frame, so the same numbers are the correct destination rect here. The old
  // code added proto.width/2 on top of that and offset the pupil by roi again,
  // which put both layers outside the eye.
  var bx0 = proto.box[0]
  var by0 = proto.box[1]
  var bx1 = proto.box[2]
  var by1 = proto.box[3]
  var cx = (bx0 + bx1) / 2
  var cy = (by0 + by1) / 2
  var rx = Math.max(0.5, (bx1 - bx0) / 2)
  var ry = Math.max(0.5, (by1 - by0) / 2)

  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  // Green backing, stretched into the calibrated ellipse.
  ctx.drawImage(this.eyeImage.backing, bx0, by0, bx1 - bx0, by1 - by0)
  // Pupil at its smoothed offset, in content coordinates.
  var px = (proto.center[0] + state.position.x) * proto.sx - proto.pupilW / 2
  var py = (proto.center[1] + state.position.y) * proto.sy - proto.pupilH / 2
  ctx.drawImage(this.eyeImage.pupil, px, py, proto.pupilW, proto.pupilH)
  ctx.restore()
  return canvas
}

Assets.prototype.resetEyes = function (pet) {
  if (pet.eyeState) {
    pet.eyeState.position = { x: 0, y: 0 }
    pet.eyeState.lastUpdate = null
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Audio facade on Assets.
 *
 * `Pet` calls `this.deps.assets.playLaugh/stopLaugh/playClick`. Those live on
 * `AudioBank`, reachable as `assets.audio`. Without these forwarders every
 * click threw `TypeError: ... is not a function`, and because that call ran
 * before the drag listeners were attached it also killed dragging, click
 * counting, the laugh and the bubble in one go.
 *
 * Each forwarder is guarded, so audio can never break interaction again.
 */
Assets.prototype.playLaugh = function (petId, loop) {
  try {
    if (this.audio) return this.audio.playLaugh(petId, loop) || null
  } catch (err) {
    this.reportError('audio:laugh', err)
  }
  return null
}

Assets.prototype.stopLaugh = function (petId) {
  try {
    if (this.audio) this.audio.stopLaugh(petId)
  } catch (err) {
    /* stopping is never fatal */
  }
}

Assets.prototype.playClick = function () {
  try {
    if (this.audio) this.audio.playClick()
  } catch (err) {
    this.reportError('audio:click', err)
  }
}

/**
 * Audio for the pet.
 *
 * Playback uses HTMLAudioElement, NOT Web Audio.
 *
 * Web Audio was the first choice (sample-accurate loop points, one voice per
 * pet). It stayed silent in this deployment for three reasons that are all
 * invisible from the plugin side:
 *
 *   1. a browser creates an AudioContext in `suspended` state until a TRUSTED
 *      gesture, and `source.start()` on a suspended context produces nothing;
 *   2. `decodeAudioData` is asynchronous, so the first click always found
 *      `buffers.laugh === undefined`;
 *   3. `resume()` is async too, so starting a source in the same tick as the
 *      gesture often scheduled against a still-frozen clock.
 *
 * HTMLAudio has exactly one failure mode — the autoplay policy — and that is
 * satisfied by the very click that asks for the sound. Each play creates a
 * fresh element from the HTTP-cached file, so overlapping voices work.
 *
 * Emitted clones start at frame 53 and loop over the tail of the clip. They
 * seek to AUDIO_LOOP_START and restart there on `ended`, so the loop window is
 * the authored 1.767 s → end of track, not the whole file.
 */
function AudioBank(config) {
  this.config = config
  this.voices = new Map() // petId -> HTMLAudioElement
  this.clicks = [] // recently started click elements (kept for cleanup)
  this.clickAt = 0
  this.preloaded = {}
  this.reported = {}
  this.unlockBound = false
  this.disposed = false
  /** Natural duration per clip, once metadata has been read (diagnostics). */
  this.naturalDuration = {}
  /** Playback rate per clip. Always 1: the track is authored at animation speed. */
  this.rate = {}
}

AudioBank.prototype.volume = function () {
  var v = Number(this.config.pet && this.config.pet.volume)
  return isFinite(v) ? clamp(v, 0, 1) : AUDIO_VOLUME
}

AudioBank.prototype.enabled = function () {
  return !this.disposed && this.config.pet && this.config.pet.sound === true
}

/** Report a playback failure ONCE per key, at warn level so the default console shows it. */
AudioBank.prototype.report = function (key, err) {
  this.lastError = { key: key, error: String((err && (err.name || err.message)) || err), at: Date.now() }
  if (this.reported[key]) return
  this.reported[key] = true
  try {
    console.warn(
      '[dsh-naiwa] audio ' + key + ' failed: ' + String((err && (err.name || err.message)) || err) +
      ' — the file is served (HTTP 200), so this is most likely the autoplay policy: ' +
      'the first click must land on the pet itself.',
    )
  } catch (e) { /* no console */ }
}

/** Build an element for one clip. */
AudioBank.prototype.element = function (name, url) {
  var el = new Audio()
  el.preload = 'auto'
  el.src = url
  el.loop = false
  el.volume = this.volume()
  el.playbackRate = 1
  // The source track is authored at exactly the animation speed, so pitch
  // preservation is only a safety net if a future track is ever retimed.
  el.preservesPitch = true
  if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true
  // Some Safari versions only start a detached media element if it is in the
  // document. Appending a hidden element is harmless everywhere else.
  if (this.host && this.host.appendChild) {
    el.style.display = 'none'
    try { this.host.appendChild(el) } catch (err) { /* detached is fine */ }
    el.addEventListener('ended', function () {
      // A looping clone keeps its element alive to restart itself.
      if (!el.__naiwaKeepAlive && el.parentNode) el.parentNode.removeChild(el)
    })
  }
  return el
}

/**
 * Read a clip's natural duration and report whether it matches the authored
 * animation window.
 *
 * The track is NOT stretched. Stretching the user's 10.21 s MP3 to 14.4 s made
 * the total length match but left every laugh inside the clip at the wrong
 * frame, which is why the desync survived the previous fix. `playbackRate`
 * stays at 1; a real mismatch is logged loudly instead of being hidden.
 */
AudioBank.prototype.probe = function (name, url, expectedSec) {
  var self = this
  try {
    var probe = new Audio()
    probe.preload = 'metadata'
    probe.src = url
    probe.addEventListener('loadedmetadata', function () {
      var d = Number(probe.duration)
      if (!isFinite(d) || d < 0.3) return
      self.naturalDuration[name] = d
      self.rate[name] = 1
      if (!expectedSec) return
      var drift = d - expectedSec
      try {
        console.info(
          '[dsh-naiwa] audio ' + name + ': ' + d.toFixed(3) + 's track vs ' +
          expectedSec.toFixed(3) + 's animation (' + (drift >= 0 ? '+' : '') +
          (drift * 1000).toFixed(0) + ' ms) -> playbackRate 1.0000, audio-clocked',
        )
        if (Math.abs(drift) > 0.25) {
          console.warn(
            '[dsh-naiwa] audio ' + name + ': track and animation differ by more than 250 ms; ' +
            'replace assets/audio/laugh-synced.wav with a 14.4196 s authored-length track',
          )
        }
      } catch (e) { /* no console */ }
    })
    probe.addEventListener('error', function () { self.report(name + '-probe', 'media-error') })
  } catch (err) {
    this.report(name + '-probe', err)
  }
}

/**
 * Warm the HTTP cache for both clips.
 * A short silent `play()` is NOT attempted here: an untrusted play() would burn
 * the one-time allowance some browsers grant and make the first real click fail.
 */
AudioBank.prototype.prewarm = function () {
  if (this.unlockBound) return this
  this.unlockBound = true
  var self = this
  // Fetch through the normal cache so the first click does not wait on I/O.
  try {
    ;['laugh', 'click'].forEach(function (name) {
      var url = name === 'laugh' ? LAUGH_URL : CLICK_URL
      fetch(url, { cache: 'force-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error('http-' + res.status)
          self.preloaded[name] = true
        })
        .catch(function (err) { self.report(name + '-fetch', err) })
    })
  } catch (err) {
    this.report('prewarm', err)
  }
  // Read both durations up front (metadata only — no playback, no gesture).
  this.probe('laugh', LAUGH_URL, CLIP_DURATION_SEC)
  this.probe('click', CLICK_URL, 0)
  return this
}

/**
 * Play the laugh for one pet; `loop` is used by emitted clones.
 *
 * Returns the media element so `Pet` can use its `currentTime` as the master
 * clock. Returns null when sound is disabled or playback failed.
 */
AudioBank.prototype.playLaugh = function (petId, loop) {
  if (!this.enabled()) return null
  this.stopLaugh(petId)
  var self = this
  var el
  try {
    el = this.element('laugh', LAUGH_URL)
  } catch (err) {
    this.report('laugh-create', err)
    return null
  }
  // `rate` is 1 for the shipped track; keep the assignment explicit so a future
  // retimed asset cannot silently inherit a stale rate.
  el.playbackRate = 1
  el.preservesPitch = true
  if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true

  if (loop) {
    // Emitted clones start their animation at frame 53, so the audio starts at
    // the matching authored sample (1.767 s) and restarts there on every loop.
    // The whole-file loop would replay the 1.577 s lead-in and drift.
    el.__naiwaKeepAlive = true
    var seekSec = AUDIO_LOOP_START
    var applySeek = function () {
      try { el.currentTime = seekSec } catch (err) { /* not seekable yet */ }
    }
    if (el.readyState >= 1) applySeek()
    else el.addEventListener('loadedmetadata', applySeek, { once: true })
    el.addEventListener('ended', function () {
      if (self.voices.get(petId) !== el || !el.__naiwaKeepAlive) return
      try {
        el.currentTime = seekSec
        var restarted = el.play()
        if (restarted && typeof restarted.then === 'function') {
          restarted.catch(function (err) { self.report('laugh-loop', err) })
        }
      } catch (err) {
        self.report('laugh-loop', err)
      }
    })
  }

  this.voices.set(petId, el)
  var started = el.play()
  if (started && typeof started.then === 'function') {
    started.catch(function (err) {
      if (self.voices.get(petId) === el) self.voices.delete(petId)
      self.report('laugh-play', err)
    })
  }
  return el
}

AudioBank.prototype.stopLaugh = function (petId) {
  var el = this.voices.get(petId)
  if (!el) return
  this.voices.delete(petId)
  el.__naiwaKeepAlive = false
  try {
    el.pause()
    el.removeAttribute('src')
    el.load()
  } catch (err) { /* already detached */ }
  if (el.parentNode) el.parentNode.removeChild(el)
}

AudioBank.prototype.stopAll = function () {
  var ids = Array.from(this.voices.keys())
  for (var i = 0; i < ids.length; i += 1) this.stopLaugh(ids[i])
}

/**
 * Play the click sound.
 * New sound (the reference has none), throttled to one per 60 ms so the
 * ten-click laugh counter cannot stack into noise.
 */
AudioBank.prototype.playClick = function () {
  if (!this.enabled()) return
  var now = nowSec()
  if (now - this.clickAt < 0.06) return
  this.clickAt = now
  var self = this
  var el
  try {
    el = this.element('click', CLICK_URL)
    el.volume = Math.min(1, this.volume() * 0.9)
  } catch (err) {
    this.report('click-create', err)
    return
  }
  this.clicks.push(el)
  if (this.clicks.length > 8) this.clicks.shift()
  var started = el.play()
  if (started && typeof started.then === 'function') {
    started.catch(function (err) { self.report('click-play', err) })
  }
  el.addEventListener('ended', function () {
    var i = self.clicks.indexOf(el)
    if (i >= 0) self.clicks.splice(i, 1)
  })
}

AudioBank.prototype.dispose = function () {
  this.disposed = true
  this.stopAll()
  for (var i = 0; i < this.clicks.length; i += 1) {
    try {
      this.clicks[i].pause()
      this.clicks[i].removeAttribute('src')
    } catch (err) { /* already detached */ }
  }
  this.clicks.length = 0
  this.preloaded = {}
}