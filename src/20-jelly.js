// ===========================================================================
// 20 — deformation: local poke jelly + whole-body squash/stretch
// ===========================================================================
// Ported from pet_app.py `_LocalJelly` and `_BodyJelly`.
//
// The Python original warps a Pillow image through a triangle mesh
// (Image.Transform.MESH). The browser equivalent is a per-triangle affine
// `drawImage` with a clip path, which is what `drawTriangle` below does. Only
// the cells actually affected by a poke are re-drawn, exactly like the
// reference's `_patch_runs` optimisation.
//
// Coordinate spaces (identical to the reference):
//   * "content" space — the frame bitmap, 0..width × 0..height
//   * "node" space    — content space; the jelly grid extends from -pad to
//                       height+pad so the transparent margin can stretch too
//   * "padded" space  — node space shifted down by `pad`, i.e. the canvas the
//                       pet is actually painted into (origin.y = -pad)

/** Volume-preserving anchored pose used by the body jelly. */
function anchoredPose(sy, sourceX, sourceY, targetX, targetY) {
  var sx = 1 / Math.sqrt(sy)
  return { sx: sx, sy: sy, tx: targetX - sx * sourceX, ty: targetY - sy * sourceY }
}

/** Analytic damped-oscillator peak (pet_app._LocalJelly._peak / _BodyJelly._peak). */
function springPeak(q, velocity, decay, freq) {
  var b = (velocity + decay * q) / freq
  var theta = Math.atan(freq / decay)
  var t = ((theta - Math.atan2(q, b)) % (2 * Math.PI)) / freq
  if (t < 0) t += (2 * Math.PI) / freq
  return Math.hypot(q, b) * Math.exp(-decay * t) * Math.sin(theta)
}

/** Bisection on the initial velocity so `springPeak` reaches `target`. */
function solveReleaseVelocity(q, target, decay, freq, hi) {
  var lo = 0
  var upper = hi || 100
  for (var i = 0; i < 28; i += 1) {
    var mid = (lo + upper) / 2
    if (springPeak(q, mid, decay, freq) < target) lo = mid
    else upper = mid
  }
  return (lo + upper) / 2
}

/** Bounding box of a binary alpha plane. */
function alphaBBox(alpha) {
  var w = alpha.width
  var h = alpha.height
  var data = alpha.data
  var x0 = w
  var y0 = h
  var x1 = -1
  var y1 = -1
  for (var y = 0; y < h; y += 1) {
    var row = y * w
    for (var x = 0; x < w; x += 1) {
      if (data[row + x]) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, x1: w, y1: h }
  return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 }
}

// ---------------------------------------------------------------------------
// Whole-body squash / stretch (_BodyJelly)
// ---------------------------------------------------------------------------

function BodyJelly(bbox) {
  this.foot = { x: (bbox.x0 + bbox.x1) / 2, y: bbox.y1 }
  this.height = Math.max(1, bbox.y1 - bbox.y0)
  this.pose = { sx: 1, sy: 1, tx: 0, ty: 0 }
  this.phase = 'done'
  this.compression = 0
  this.velocity = 0
  this.floor = { x: this.foot.x, y: this.foot.y }
  this.started = 0
  this.lastTime = 0
  this.grip = { x: 0, y: 0 }
  this.pin = { x: 0, y: 0 }
  this.startSy = 1
  this.strength = 0.1
}

BodyJelly.prototype.moving = function () {
  return this.phase === 'pickup' || this.phase === 'landing' || this.phase === 'handoff'
}

BodyJelly.prototype.forward = function (x, y) {
  var p = this.pose
  return { x: p.sx * x + p.tx, y: p.sy * y + p.ty }
}

BodyJelly.prototype.inverse = function (x, y) {
  var p = this.pose
  return { x: (x - p.tx) / p.sx, y: (y - p.ty) / p.sy }
}

BodyJelly.prototype.applyPose = function (sy, source, target) {
  this.pose = anchoredPose(sy, source.x, source.y, target.x, target.y)
}

BodyJelly.prototype.pickup = function (x, y, now) {
  this.grip = this.inverse(x, y)
  this.pin = { x: x, y: y }
  this.startSy = this.pose.sy
  this.phase = 'pickup'
  this.started = now
  this.lastTime = now
}

BodyJelly.prototype.release = function (speed, now) {
  this.floor = this.forward(this.foot.x, this.foot.y)
  this.compression = 1 - this.pose.sy
  // speed is normalised by visible height, so every tier feels the same.
  this.strength = 0.1 + 0.12 * Math.min(1, Math.max(0, speed) / 2.5)
  var target = Math.max(this.strength, this.compression)
  this.velocity = solveReleaseVelocity(this.compression, target, BODY_DECAY, BODY_FREQ, 20)
  this.phase = 'landing'
  this.started = now
  this.lastTime = now
}

BodyJelly.prototype.handoff = function (now) {
  this.floor = this.forward(this.foot.x, this.foot.y)
  this.startSy = this.pose.sy
  this.phase = 'handoff'
  this.started = now
  this.lastTime = now
}

BodyJelly.prototype.advance = function (now) {
  if (this.phase === 'pickup' || this.phase === 'handoff') {
    var duration = this.phase === 'pickup' ? BODY_PICKUP_SEC : BODY_HANDOFF_SEC
    var t = clamp((now - this.started) / duration, 0, 1)
    var targetSy = this.phase === 'pickup' ? BODY_STRETCH : 1
    var sy = this.startSy + (targetSy - this.startSy) * smoothstep(t)
    if (this.phase === 'pickup') {
      this.applyPose(sy, this.grip, this.pin)
      if (t >= 1) this.phase = 'held'
    } else {
      this.applyPose(sy, this.foot, this.floor)
      if (t >= 1) this.phase = 'done'
    }
  } else if (this.phase === 'landing') {
    if (now - this.started >= BODY_LAND_SEC) {
      this.compression = 0
      this.velocity = 0
      this.applyPose(1, this.foot, this.floor)
      this.phase = 'done'
    } else {
      var dt = Math.max(0, now - this.lastTime)
      var d = BODY_DECAY
      var w = BODY_FREQ
      var e = Math.exp(-d * dt)
      var c = Math.cos(w * dt)
      var s = Math.sin(w * dt)
      var q = this.compression
      var v = this.velocity
      this.compression = e * (q * c + ((v + d * q) / w) * s)
      this.velocity = e * (v * c - ((d * v + (d * d + w * w) * q) / w) * s)
      this.applyPose(1 - this.compression, this.foot, this.floor)
    }
  }
  this.lastTime = now
}

// ---------------------------------------------------------------------------
// Local poke jelly (_LocalJelly)
// ---------------------------------------------------------------------------

function LocalJelly(alpha) {
  this.alpha = alpha
  this.width = alpha.width
  this.height = alpha.height
  this.sx = this.width / BASE_W
  this.sy = this.height / BASE_H
  this.pad = Math.round(BODY_PAD * this.sy)
  this.bbox = alphaBBox(alpha)
  this.bodyWidth = this.bbox.x1 - this.bbox.x0
  this.fields = []
  this.held = null
  this.lastPoke = 0

  var step = Math.max(3, Math.round(8 * Math.min(this.sx, this.sy)))
  this.step = step

  // xs = 0, step, 2·step … width      (pet_app: range(0, width, step) + [width])
  this.xs = []
  for (var x = 0; x < this.width; x += step) this.xs.push(x)
  this.xs.push(this.width)
  // ys = -pad … height+pad            (pet_app: range(-pad, height+pad, step) + [height+pad])
  this.ys = []
  for (var y = -this.pad; y < this.height + this.pad; y += step) this.ys.push(y)
  this.ys.push(this.height + this.pad)

  this.referenceThickness = this.thickness(146 * this.sx, 180 * this.sy)
}

/** Continuous opaque chord through (x, y) — thin parts deform less. */
LocalJelly.prototype.thickness = function (x, y) {
  var cx = clamp(Math.round(x), 0, this.width - 1)
  var cy = clamp(Math.round(y), 0, this.height - 1)
  var data = this.alpha.data
  var w = this.width
  var h = this.height
  var minSpan = Infinity
  var dirs = [[1, 0, w], [0, 1, h]]
  for (var d = 0; d < 2; d += 1) {
    var dx = dirs[d][0]
    var dy = dirs[d][1]
    var limit = dirs[d][2]
    var span = 1
    for (var sign = -1; sign <= 1; sign += 2) {
      for (var n = 1; n < limit; n += 1) {
        var u = cx + sign * dx * n
        var v = cy + sign * dy * n
        if (u < 0 || v < 0 || u >= w || v >= h) break
        if (!data[v * w + u]) break
        span += 1
      }
    }
    if (span < minSpan) minSpan = span
  }
  return Math.max(1, minSpan)
}

LocalJelly.prototype.active = function () {
  return this.held !== null || this.fields.length > 0
}

/** Build one influence field centred on a content-space point. */
LocalJelly.prototype.field = function (point, now) {
  var x = point.x
  var y = point.y
  var factor = clamp(this.thickness(x, y) / Math.max(1, this.referenceThickness), 0.12, 1)
  var amplitude = 0.12 * this.bodyWidth * factor
  var rx = JELLY_RX * this.sx * factor
  var ry = JELLY_RY * this.sy * factor
  var gain = amplitude / (Math.max(rx, ry) * JELLY_RADIAL_PEAK)
  var nodes = []
  for (var j = 0; j < this.ys.length; j += 1) {
    var v = this.ys[j]
    for (var i = 0; i < this.xs.length; i += 1) {
      var u = this.xs[i]
      var r2 = Math.pow((u - x) / rx, 2) + Math.pow((v - y) / ry, 2)
      if (r2 < 1) {
        var weight = Math.pow(1 - r2, 3)
        nodes.push({
          i: i,
          j: j,
          dx: (u - x) * gain * weight,
          dy: (v - y) * gain * weight,
          weight: weight,
        })
      }
    }
  }
  return {
    center: { x: x, y: y },
    nodes: nodes,
    started: now,
    lastTime: now,
    released: now,
    q: 0,
    velocity: 0,
  }
}

LocalJelly.prototype.beginPress = function (point, now) {
  this.advance(now)
  this.cancelPress(now)
  this.held = this.field(point, now)
}

LocalJelly.prototype.cancelPress = function (now) {
  if (this.held !== null) {
    var f = this.held
    this.held = null
    f.released = now
    f.lastTime = now
    this.fields.push(f)
  }
}

LocalJelly.prototype.release = function (now) {
  if (this.held === null) return
  this.advance(now)
  var field = this.held
  this.held = null
  var charge = smoothstep((now - field.started) / CHARGE_SEC)

  var envelope = new Map()
  var samePoint = 0
  for (var k = 0; k < this.fields.length; k += 1) {
    var old = this.fields[k]
    var bound = Math.max(
      Math.abs(old.q),
      springPeak(old.q, old.velocity, JELLY_DECAY, JELLY_FREQ),
      springPeak(-old.q, -old.velocity, JELLY_DECAY, JELLY_FREQ),
    )
    if (old.center.x === field.center.x && old.center.y === field.center.y) samePoint += bound
    for (var n = 0; n < old.nodes.length; n += 1) {
      var node = old.nodes[n]
      var key = node.i + ':' + node.j
      envelope.set(key, (envelope.get(key) || 0) + node.weight * bound)
    }
  }
  var available = JELLY_LIMIT
  for (var m = 0; m < field.nodes.length; m += 1) {
    var fn = field.nodes[m]
    var used = envelope.get(fn.i + ':' + fn.j) || 0
    available = Math.min(available, (JELLY_LIMIT - used) / fn.weight)
  }
  available = Math.min(available, JELLY_LIMIT - samePoint)
  var target = Math.min(1 + charge, Math.max(field.q, available, 0))

  field.velocity = solveReleaseVelocity(field.q, target, JELLY_DECAY, JELLY_FREQ, 100)
  field.released = now
  field.lastTime = now
  this.lastPoke = now
  if (field.q > 1e-8 || field.velocity > 1e-8) this.fields.push(field)
}

LocalJelly.prototype.advance = function (now) {
  var d = JELLY_DECAY
  var w = JELLY_FREQ
  var kept = []
  for (var i = 0; i < this.fields.length; i += 1) {
    var f = this.fields[i]
    if (now - f.released >= JELLY_DURATION) continue
    var dt = Math.max(0, now - f.lastTime)
    var e = Math.exp(-d * dt)
    var c = Math.cos(w * dt)
    var s = Math.sin(w * dt)
    var q = f.q
    var v = f.velocity
    f.q = e * (q * c + ((v + d * q) / w) * s)
    f.velocity = e * (v * c - ((d * v + (d * d + w * w) * q) / w) * s)
    f.lastTime = now
    kept.push(f)
  }
  this.fields = kept
  if (this.held !== null) {
    var progress = smoothstep((now - this.held.started) / CHARGE_SEC)
    // Only half the retraction while held; release() calibrates its own peak.
    this.held.q = 0.5 * progress * (1 + progress)
  }
}

/**
 * Per-node displacement for the current instant, plus the affected cell range.
 * @returns {{ points: Float64Array|null, i0:number, i1:number, j0:number, j1:number }}
 *   `points` is a flat [x0,y0,x1,y1,…] grid in NODE space, or null when idle.
 */
LocalJelly.prototype.compile = function () {
  var fields = this.fields.slice()
  if (this.held !== null) fields.push(this.held)
  if (!fields.length) return null

  var cols = this.xs.length
  var rows = this.ys.length
  var ox = new Float64Array(cols * rows)
  var oy = new Float64Array(cols * rows)
  var i0 = cols
  var i1 = -1
  var j0 = rows
  var j1 = -1

  for (var f = 0; f < fields.length; f += 1) {
    var field = fields[f]
    if (Math.abs(field.q) < 1e-9) continue
    var bound = Math.max(
      Math.abs(field.q),
      springPeak(field.q, field.velocity, JELLY_DECAY, JELLY_FREQ),
      springPeak(-field.q, -field.velocity, JELLY_DECAY, JELLY_FREQ),
    )
    var norm = bound > 1e-9 ? Math.min(1, JELLY_LIMIT / bound) : 1
    var q = field.q * norm
    for (var n = 0; n < field.nodes.length; n += 1) {
      var node = field.nodes[n]
      var idx = node.j * cols + node.i
      ox[idx] += node.dx * q
      oy[idx] += node.dy * q
      if (node.i < i0) i0 = node.i
      if (node.i > i1) i1 = node.i
      if (node.j < j0) j0 = node.j
      if (node.j > j1) j1 = node.j
    }
  }
  if (i1 < 0) return null

  var points = new Float64Array(cols * rows * 2)
  for (var j = 0; j < rows; j += 1) {
    for (var i = 0; i < cols; i += 1) {
      var p = j * cols + i
      points[p * 2] = this.xs[i] + ox[p]
      points[p * 2 + 1] = this.ys[j] + oy[p]
    }
  }
  return {
    points: points,
    i0: Math.max(0, i0 - 1),
    i1: Math.min(cols - 2, i1 + 1),
    j0: Math.max(0, j0 - 1),
    j1: Math.min(rows - 2, j1 + 1),
  }
}

/** Inverse-map a padded-space point through the last displayed mesh. */
LocalJelly.prototype.inverse = function (x, y, mesh) {
  if (!mesh) return { x: x, y: y }
  var cols = this.xs.length
  var i = this.cellIndex(this.xs, x)
  var j = this.cellIndex(this.ys, y)
  if (i < 0 || j < 0 || i >= cols - 1 || j >= this.ys.length - 1) return { x: x, y: y }
  var tx = (x - this.xs[i]) / (this.xs[i + 1] - this.xs[i])
  var ty = (y - this.ys[j]) / (this.ys[j + 1] - this.ys[j])
  var pts = mesh.points
  var a = (j * cols + i) * 2
  var b = ((j + 1) * cols + i) * 2
  var c = ((j + 1) * cols + i + 1) * 2
  var d = (j * cols + i + 1) * 2
  return {
    x:
      (1 - tx) * ((1 - ty) * pts[a] + ty * pts[b]) +
      tx * ((1 - ty) * pts[d] + ty * pts[c]),
    y:
      (1 - tx) * ((1 - ty) * pts[a + 1] + ty * pts[b + 1]) +
      tx * ((1 - ty) * pts[d + 1] + ty * pts[c + 1]),
  }
}

LocalJelly.prototype.cellIndex = function (list, value) {
  if (value < list[0] || value >= list[list.length - 1]) return -1
  var lo = 0
  var hi = list.length - 1
  while (lo < hi - 1) {
    var mid = (lo + hi) >> 1
    if (list[mid] <= value) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Draw the deformed pet into `ctx`.
 *
 * @param {CanvasRenderingContext2D} ctx destination context
 * @param {CanvasImageSource} img the frame bitmap (content-sized)
 * @param {LocalJelly|null} jelly
 * @param {object|null} mesh result of `compile()`
 */
function drawMesh(ctx, img, jelly, mesh) {
  var cols = jelly.xs.length
  var pts = mesh.points
  ctx.save()
  for (var j = mesh.j0; j <= mesh.j1; j += 1) {
    for (var i = mesh.i0; i <= mesh.i1; i += 1) {
      var p = j * cols + i
      var a = p * 2
      var b = (p + cols) * 2
      var c = (p + cols + 1) * 2
      var d = (p + 1) * 2
      // Source quad in content space (node space == content space).
      var sx0 = jelly.xs[i]
      var sy0 = jelly.ys[j]
      var sx1 = jelly.xs[i + 1]
      var sy1 = jelly.ys[j + 1]
      // Destination is ALSO content space: the caller has already applied the
      // padded origin (ctx.translate(0, padY)) and, when the body is being
      // dragged, the body affine. Adding `pad` again here used to push the whole
      // deformed patch ~19 px below the body — which looked like a ghost image
      // trailing the pet while dragging.
      drawTriangle(
        ctx, img,
        sx0, sy0, sx0, sy1, sx1, sy1,
        pts[a], pts[a + 1], pts[b], pts[b + 1], pts[c], pts[c + 1],
      )
      // Triangle 2: (a, c, d)  → source (0,0),(1,1),(1,0)
      drawTriangle(
        ctx, img,
        sx0, sy0, sx1, sy1, sx1, sy0,
        pts[a], pts[a + 1], pts[c], pts[c + 1], pts[d], pts[d + 1],
      )
    }
  }
  ctx.restore()
}

/**
 * Draw one triangle of `img` mapped onto `dst` (three destination points).
 * Standard per-triangle affine + clip, the JS equivalent of Pillow's MESH.
 */
function drawTriangle(ctx, img, sx0, sy0, sx1, sy1, sx2, sy2, dx0, dy0, dx1, dy1, dx2, dy2) {
  var denom = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0)
  if (Math.abs(denom) < 1e-9) return
  var a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / denom
  var b = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / denom
  var c = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / denom
  var d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / denom
  var e = dx0 - a * sx0 - b * sy0
  var f = dy0 - c * sx0 - d * sy0

  // Expand the clip slightly so adjacent triangles do not leave seams.
  var cx = (dx0 + dx1 + dx2) / 3
  var cy = (dy0 + dy1 + dy2) / 3
  var grow = 1.08
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(cx + (dx0 - cx) * grow, cy + (dy0 - cy) * grow)
  ctx.lineTo(cx + (dx1 - cx) * grow, cy + (dy1 - cy) * grow)
  ctx.lineTo(cx + (dx2 - cx) * grow, cy + (dy2 - cy) * grow)
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, c, b, d, e, f)
  ctx.drawImage(img, 0, 0)
  ctx.restore()
}
