// ===========================================================================
// 10 — physics: Chipmunk-compatible sequential-impulse solver for upright
//      capsules. Ported from pet_physics.py + pymunk 7.3.1 semantics.
// ===========================================================================
//
// The original uses pymunk (Chipmunk2D). Shipping a JS physics engine would
// either be a large dependency or an inexact re-implementation, so this module
// reimplements exactly the subset the original relies on:
//
//   * one Space per container ("monitor work area"), each with 4 wall segments
//   * bodies are VERTICAL CAPSULES (segment + radius) with infinite moment of
//     inertia (fixedRotation), so orientation never changes
//   * only emitted split clones are dynamic; everything else is a STATIC body
//     teleported to follow its window (the original's "悬停" = parked obstacle)
//   * per-contact restitution/friction selected by collision type
//     (floor 3 / wall 2 / pet 1), zeroed below a 45 px/s relative speed
//   * sequential impulses with N iterations, positional correction with slop
//   * Chipmunk damping semantics: v *= damping^dt  (PER SECOND, not per step)
//   * terminal-velocity clamp applied before each substep
//
// Differences from the reference are listed in README.md ("物理差异").

var CONTACT_PET = 1
var CONTACT_WALL = 2
var CONTACT_FLOOR = 3

/** One dynamic/static capsule. */
function Capsule(opts) {
  this.id = opts.id
  this.x = opts.x
  this.y = opts.y
  this.vx = 0
  this.vy = 0
  this.radius = opts.radius
  this.halfLine = opts.halfLine
  this.mass = opts.mass
  this.invMass = opts.mass > 0 ? 1 / opts.mass : 0
  this.dynamic = !!opts.dynamic
  this.sleeping = false
  this.sleepTimer = 0
  this.owner = opts.owner || null
  this.sourceId = opts.sourceId || null
}

Capsule.prototype.speed = function () {
  return Math.hypot(this.vx, this.vy)
}

Capsule.prototype.wake = function () {
  this.sleeping = false
  this.sleepTimer = 0
}

/** A physics world bound to one container rectangle. */
function PhysicsWorld() {
  this.bodies = []
  this.accumulator = 0
  // Container rectangle in CSS px; (0,0) is the top-left.
  this.bounds = { left: 0, top: 0, right: 800, bottom: 600 }
}

PhysicsWorld.prototype.setBounds = function (bounds) {
  var changed =
    bounds.left !== this.bounds.left ||
    bounds.top !== this.bounds.top ||
    bounds.right !== this.bounds.right ||
    bounds.bottom !== this.bounds.bottom
  this.bounds = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
  if (changed) this.wakeAll()
}

PhysicsWorld.prototype.height = function () {
  return Math.max(1, this.bounds.bottom - this.bounds.top)
}

/** Gravity scales with container height exactly like the reference. */
PhysicsWorld.prototype.gravity = function () {
  return (1800 * this.height()) / 1080
}

PhysicsWorld.prototype.terminalSpeed = function () {
  return this.gravity()
}

PhysicsWorld.prototype.wakeAll = function () {
  for (var i = 0; i < this.bodies.length; i += 1) {
    if (this.bodies[i].dynamic) this.bodies[i].wake()
  }
}

PhysicsWorld.prototype.add = function (capsule) {
  this.remove(capsule.id)
  this.bodies.push(capsule)
  this.wakeAll()
  return capsule
}

PhysicsWorld.prototype.get = function (id) {
  for (var i = 0; i < this.bodies.length; i += 1) {
    if (this.bodies[i].id === id) return this.bodies[i]
  }
  return null
}

PhysicsWorld.prototype.remove = function (id) {
  for (var i = this.bodies.length - 1; i >= 0; i -= 1) {
    if (this.bodies[i].id === id) {
      this.bodies.splice(i, 1)
      this.wakeAll()
      return true
    }
  }
  return false
}

PhysicsWorld.prototype.clear = function () {
  this.bodies.length = 0
  this.accumulator = 0
}

PhysicsWorld.prototype.anyAwake = function () {
  for (var i = 0; i < this.bodies.length; i += 1) {
    var b = this.bodies[i]
    if (b.dynamic && !b.sleeping) return true
  }
  return false
}

/**
 * Advance the simulation.
 * @param {number} elapsed real seconds since the previous call
 */
PhysicsWorld.prototype.advance = function (elapsed) {
  this.accumulator = Math.min(
    this.accumulator + Math.max(0, elapsed) * MOTION_RATE,
    MAX_CATCHUP,
  )
  var steps = 0
  while (this.accumulator >= PHYS_STEP - 1e-12 && steps < 8) {
    this.preStep()
    this.step(PHYS_STEP)
    this.accumulator -= PHYS_STEP
    steps += 1
  }
  return steps
}

PhysicsWorld.prototype.preStep = function () {
  var limit = this.terminalSpeed()
  for (var i = 0; i < this.bodies.length; i += 1) {
    var b = this.bodies[i]
    if (!b.dynamic) continue
    // A clone must stop colliding with the pet that emitted it once they no
    // longer overlap (pet_physics.advance).
    if (b.sourceId != null) {
      var source = this.get(b.sourceId)
      if (!source || !capsulesOverlap(b, source)) b.sourceId = null
    }
    var speed = b.speed()
    if (speed > limit) {
      b.vx *= limit / speed
      b.vy *= limit / speed
    }
  }
}

/** Upright capsule–capsule overlap (pet_physics._capsules_overlap). */
function capsulesOverlap(a, b) {
  var dx = a.x - b.x
  var dy = a.y - b.y
  var gap = Math.max(0, Math.abs(dy) - a.halfLine - b.halfLine)
  var r = a.radius + b.radius
  return dx * dx + gap * gap < r * r
}

/** Closest-point distance between two upright capsules. */
function capsuleContact(a, b) {
  var dx = b.x - a.x
  var dy = b.y - a.y
  // Vertical segments: the closest approach is along y clipped by both halves.
  var overlapY = a.halfLine + b.halfLine - Math.abs(dy)
  var ny
  var nx
  var depth
  if (overlapY > 0) {
    // Segments overlap vertically: the contact normal is purely horizontal.
    var distX = Math.abs(dx)
    depth = a.radius + b.radius - distX
    if (depth <= 0) return null
    nx = dx >= 0 ? 1 : -1
    ny = 0
  } else {
    // Cap-to-cap contact.
    var dist = Math.hypot(dx, dy)
    depth = a.radius + b.radius - dist
    if (depth <= 0) return null
    if (dist < 1e-9) {
      nx = 1
      ny = 0
    } else {
      nx = dx / dist
      ny = dy / dist
    }
  }
  return { nx: nx, ny: ny, depth: depth }
}

/** Solve one substep. */
PhysicsWorld.prototype.step = function (dt) {
  var bodies = this.bodies
  var g = this.gravity()
  var dampingFactor = Math.pow(PHYS_DAMPING, dt)
  var i
  var b

  // --- integrate velocity -------------------------------------------------
  for (i = 0; i < bodies.length; i += 1) {
    b = bodies[i]
    if (!b.dynamic || b.sleeping) continue
    b.vy += g * dt
    b.vx *= dampingFactor
    b.vy *= dampingFactor
  }

  // --- collect contacts ---------------------------------------------------
  var contacts = []
  for (i = 0; i < bodies.length; i += 1) {
    for (var j = i + 1; j < bodies.length; j += 1) {
      var a = bodies[i]
      var c = bodies[j]
      if (!a.dynamic && !c.dynamic) continue
      if (a.dynamic && a.sleeping && c.dynamic && c.sleeping) continue
      if (a.sourceId === c.id || c.sourceId === a.id) continue
      var hit = capsuleContact(a, c)
      if (hit) contacts.push({ a: a, b: c, nx: hit.nx, ny: hit.ny, depth: hit.depth, kind: CONTACT_PET })
    }
  }

  // --- walls --------------------------------------------------------------
  var bounds = this.bounds
  for (i = 0; i < bodies.length; i += 1) {
    b = bodies[i]
    if (!b.dynamic || b.sleeping) continue
    var bottom = b.y + b.halfLine + b.radius
    var top = b.y - b.halfLine - b.radius
    var left = b.x - b.radius
    var right = b.x + b.radius
    if (bottom > bounds.bottom) {
      contacts.push({ a: null, b: b, nx: 0, ny: -1, depth: bottom - bounds.bottom, kind: CONTACT_FLOOR })
    }
    if (top < bounds.top) {
      contacts.push({ a: null, b: b, nx: 0, ny: 1, depth: bounds.top - top, kind: CONTACT_WALL })
    }
    if (left < bounds.left) {
      contacts.push({ a: null, b: b, nx: 1, ny: 0, depth: bounds.left - left, kind: CONTACT_WALL })
    }
    if (right > bounds.right) {
      contacts.push({ a: null, b: b, nx: -1, ny: 0, depth: right - bounds.right, kind: CONTACT_WALL })
    }
  }

  // --- integrate position (ALWAYS, even with zero contacts) ----------------
  // This must run before any contact early-return: a free-falling body has no
  // contacts at all, so skipping it here would leave every body frozen at its
  // spawn point while its velocity kept growing.
  for (i = 0; i < bodies.length; i += 1) {
    b = bodies[i]
    if (!b.dynamic || b.sleeping) continue
    b.x += b.vx * dt
    b.y += b.vy * dt
  }

  if (!contacts.length) {
    this.updateSleep(dt)
    return
  }

  // --- restitution / friction per contact ---------------------------------
  for (i = 0; i < contacts.length; i += 1) {
    var ct = contacts[i]
    var avx = ct.a ? ct.a.vx : 0
    var avy = ct.a ? ct.a.vy : 0
    var rvx = ct.b.vx - avx
    var rvy = ct.b.vy - avy
    var relSpeed = Math.hypot(rvx, rvy)
    if (ct.kind === CONTACT_FLOOR) {
      ct.rest = REST_FLOOR
      ct.fric = FRIC_FLOOR
    } else if (ct.kind === CONTACT_WALL) {
      ct.rest = REST_WALL
      ct.fric = FRIC_WALL
    } else {
      ct.rest = REST_PET
      ct.fric = FRIC_PET
    }
    // "Avoid an endless sequence of subpixel hops at resting contacts."
    if (relSpeed < REST_SPEED_CUTOFF) ct.rest = 0
    ct.jn = 0
    ct.jt = 0
  }

  // --- sequential impulses ------------------------------------------------
  for (var iter = 0; iter < PHYS_ITERATIONS; iter += 1) {
    for (i = 0; i < contacts.length; i += 1) {
      ct = contacts[i]
      var A = ct.a
      var B = ct.b
      var invA = A ? (A.sleeping ? 0 : A.invMass) : 0
      var invB = B.sleeping ? 0 : B.invMass
      var invSum = invA + invB
      if (invSum <= 0) continue

      var vAx = A ? A.vx : 0
      var vAy = A ? A.vy : 0
      var relx = B.vx - vAx
      var rely = B.vy - vAy

      // Normal impulse.
      var vn = relx * ct.nx + rely * ct.ny
      var lambda = (-(1 + ct.rest) * vn) / invSum
      var oldJn = ct.jn
      ct.jn = Math.max(0, ct.jn + lambda)
      var dJn = ct.jn - oldJn
      if (A) {
        A.vx -= dJn * ct.nx * invA
        A.vy -= dJn * ct.ny * invA
      }
      B.vx += dJn * ct.nx * invB
      B.vy += dJn * ct.ny * invB

      // Friction impulse along the tangent.
      var tx = -ct.ny
      var ty = ct.nx
      relx = B.vx - (A ? A.vx : 0)
      rely = B.vy - (A ? A.vy : 0)
      var vt = relx * tx + rely * ty
      var maxF = ct.fric * ct.jn
      var lambdaT = -vt / invSum
      var oldJt = ct.jt
      ct.jt = clamp(ct.jt + lambdaT, -maxF, maxF)
      var dJt = ct.jt - oldJt
      if (A) {
        A.vx -= dJt * tx * invA
        A.vy -= dJt * ty * invA
      }
      B.vx += dJt * tx * invB
      B.vy += dJt * ty * invB
    }
  }

  // --- positional correction ----------------------------------------------
  // Push overlapping bodies apart, allowing `PHYS_SLOP` penetration.
  for (i = 0; i < contacts.length; i += 1) {
    ct = contacts[i]
    var excess = ct.depth - PHYS_SLOP
    if (excess <= 0) continue
    var iA = ct.a ? (ct.a.sleeping ? 0 : ct.a.invMass) : 0
    var iB = ct.b.sleeping ? 0 : ct.b.invMass
    var sum = iA + iB
    if (sum <= 0) continue
    var corr = (excess * 0.8) / sum
    if (ct.a) {
      ct.a.x -= corr * ct.nx * iA
      ct.a.y -= corr * ct.ny * iA
    }
    ct.b.x += corr * ct.nx * iB
    ct.b.y += corr * ct.ny * iB
  }

  this.updateSleep(dt)
}

/** Sleep bookkeeping, shared by both the contact and no-contact paths. */
PhysicsWorld.prototype.updateSleep = function (dt) {
  var bodies = this.bodies
  for (var i = 0; i < bodies.length; i += 1) {
    var b = bodies[i]
    if (!b.dynamic) continue
    if (b.speed() >= PHYS_IDLE_SPEED) {
      b.sleepTimer = 0
      b.sleeping = false
    } else {
      b.sleepTimer += dt
      if (b.sleepTimer >= PHYS_SLEEP_SEC) {
        b.sleeping = true
        b.vx = 0
        b.vy = 0
      }
    }
  }
}

/** Launch velocity for an emitted clone (pet_physics.launch_velocity). */
function launchVelocity(areaHeight, direction) {
  var factor = areaHeight / 1080
  var speed = randFloat(LAUNCH_SPEED_MIN, LAUNCH_SPEED_MAX) * factor
  var angle = (randFloat(LAUNCH_ANGLE_MIN, LAUNCH_ANGLE_MAX) * Math.PI) / 180
  return {
    vx: direction * speed * Math.cos(angle),
    vy: -speed * Math.sin(angle),
  }
}

/** Capsule geometry from a visible box (pet_physics.add). */
function capsuleShape(box) {
  var width = box.x1 - box.x0
  var height = box.y1 - box.y0
  return {
    radius: Math.max(2, Math.min(width * 0.55, height / 2)),
    offsetX: (box.x0 + box.x1) / 2,
    offsetY: (box.y0 + box.y1) / 2,
    mass: Math.max(0.1, (width * height) / 10000),
    halfLine: Math.max(0, height / 2 - Math.max(2, Math.min(width * 0.55, height / 2))),
  }
}
