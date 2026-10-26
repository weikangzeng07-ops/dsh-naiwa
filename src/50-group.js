// ===========================================================================
// 50 — the group: physics loop, split, merge, reunify, bubbles, menu
// ===========================================================================
// Ported from pet_group.PetGroup.

function Group(deps) {
  this.deps = deps
  this.config = deps.config
  this.world = deps.world
  this.container = deps.container
  this.assets = deps.assets
  this.pets = []
  this.primary = null
  this.pendingBursts = []
  this.reunifying = false
  this.closed = false
  this.copyReady = false
  this.lastFrame = 0
  this.rafId = 0
  this.lastPhysicsAt = 0
  this.acc = 0
  this.paused = false
  this.bubbles = []
  this.accountBubble = null
  this.accountBubbleTimer = null
  this.accountTurn = null
  this.accountPrefs = loadAccountBubblePrefs(this.config)
  this.bubbleMenu = null
  this.bubbleEditor = null
  this.ledger = null
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

Group.prototype.refreshBounds = function () {
  // The layer is `position:fixed` to the viewport, so the viewport is the real
  // playfield. A rect of 0 (layout not settled yet, or a host that does not
  // give the overlay a box) would clamp the pet into a 1x1 world, so fall back
  // to the window's inner size.
  var rect = this.container.getBoundingClientRect()
  var w = rect.width
  var h = rect.height
  if (!(w > 0) || !(h > 0)) {
    w = window.innerWidth
    h = window.innerHeight
  }
  if (!(w > 0)) w = 800
  if (!(h > 0)) h = 600
  this.world.setBounds({
    left: 0,
    top: 0,
    right: Math.max(1, w),
    bottom: Math.max(1, h),
  })
}

Group.prototype.areaHeight = function () {
  return this.world.height()
}

// ---------------------------------------------------------------------------
// Pet management
// ---------------------------------------------------------------------------

Group.prototype.register = function (pet) {
  this.pets.push(pet)
  if (this.primary === null) this.primary = pet
  this.setHover(pet)
  this.startLoop()
}

Group.prototype.setPrimary = function (pet) {
  if (this.closed || this.reunifying) return
  this.primary = pet
}

Group.prototype.count = function () {
  return this.pets.length + this.pendingBursts.length
}

/** Register a pet as a STATIC obstacle (pet_group.set_hover). */
Group.prototype.setHover = function (pet) {
  if (this.closed) return
  var box = pet.visibleBox()
  var shape = capsuleShape({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 })
  var capsule = new Capsule({
    id: pet.id,
    x: pet.pos.x + shape.offsetX,
    y: pet.pos.y + shape.offsetY,
    radius: shape.radius,
    halfLine: shape.halfLine,
    mass: shape.mass,
    dynamic: false,
    owner: pet,
  })
  this.world.add(capsule)
  pet.sleeping = false
}

/** Rebuild the capsule after a resize, preserving dynamic state and velocity. */
Group.prototype.resizePhysics = function (pet) {
  var existing = this.world.get(pet.id)
  if (!existing) {
    this.setHover(pet)
    return
  }
  var dynamic = existing.dynamic
  var vx = existing.vx
  var vy = existing.vy
  var box = pet.visibleBox()
  var shape = capsuleShape({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 })
  this.world.remove(pet.id)
  var capsule = new Capsule({
    id: pet.id,
    x: pet.pos.x + shape.offsetX,
    y: pet.pos.y + shape.offsetY,
    radius: shape.radius,
    halfLine: shape.halfLine,
    mass: shape.mass,
    dynamic: dynamic,
    owner: pet,
  })
  if (dynamic) {
    capsule.vx = vx
    capsule.vy = vy
  }
  this.world.add(capsule)
}

Group.prototype.beginDrag = function (pet) {
  this.cancelEmission(pet)
  this.world.remove(pet.id)
}

// ---------------------------------------------------------------------------
// Split (分身)
// ---------------------------------------------------------------------------

Group.prototype.cancelEmission = function (pet) {
  var kept = []
  for (var i = 0; i < this.pendingBursts.length; i += 1) {
    if (this.pendingBursts[i].source !== pet) kept.push(this.pendingBursts[i])
  }
  this.pendingBursts = kept
}

/**
 * Queue one burst (pet_group.request_split).
 * @returns {number} how many clones were actually reserved
 */
Group.prototype.requestSplit = function (source, now) {
  if (this.closed || this.reunifying) return 0
  if (this.pets.indexOf(source) < 0) return 0
  if (source.animationSnapshot() === null) return 0
  var scales = burstScales(source.scale)
  var room = Math.max(0, this.config.pet.maxPets - this.pets.length - this.pendingBursts.length)
  scales = scales.slice(0, room)
  if (!scales.length) {
    this.bubble(source, 'limit')
    return 0
  }
  var direction = Math.random() < 0.5 ? -1 : 1
  var serial = source.actionSerial
  for (var i = 0; i < scales.length; i += 1) {
    this.pendingBursts.push({
      due: now + i * BURST_STAGGER,
      source: source,
      scale: scales[i],
      direction: direction,
      serial: serial,
    })
    direction *= -1
  }
  this.bubble(source, 'split')
  return scales.length
}

Group.prototype.emitDue = function (now) {
  this.pendingBursts.sort(function (a, b) { return a.due - b.due })
  while (this.pendingBursts.length && this.pendingBursts[0].due <= now) {
    var entry = this.pendingBursts.shift()
    var source = entry.source
    if (this.pets.indexOf(source) < 0) continue
    if (source.actionSerial !== entry.serial) continue
    if (source.animationSnapshot() === null) continue
    try {
      this.spawn({ source: source, scale: entry.scale, emitted: true, direction: entry.direction })
    } catch (err) {
      // Reservation is released because the entry already left the queue.
    }
  }
}

/**
 * Create a pet (pet_group.spawn).
 * @param {object} options { source, scale, emitted, direction, point }
 */
Group.prototype.spawn = function (options) {
  options = options || {}
  if (this.closed || this.reunifying) return null
  if (this.count() >= this.config.pet.maxPets) return null

  var pet = new Pet(this.deps, {
    scale: options.scale == null ? CLONE_SCALE : options.scale,
    emitted: !!options.emitted,
  })
  var box = pet.visibleBox()
  var x
  var y
  var source = options.source || null

  if (source) {
    var sb = source.visibleBox()
    if (options.emitted) {
      x = source.pos.x + (sb.x0 + sb.x1 - box.x0 - box.x1) / 2
      y = source.pos.y + (sb.y0 + sb.y1 - box.y0 - box.y1) / 2
    } else {
      x = source.pos.x + sb.x1 + DUPLICATE_GAP - box.x0
      y = source.pos.y + sb.y1 - box.y1
      if (x + box.x1 > this.world.bounds.right) {
        x = source.pos.x + sb.x0 - DUPLICATE_GAP - box.x1
      }
    }
  } else {
    var point = options.point || { x: this.world.bounds.right / 2, y: this.world.bounds.bottom / 2 }
    x = point.x - (box.x0 + box.x1) / 2
    y = point.y - (box.y0 + box.y1) / 2
  }
  var constrained = this.constrain(x, y, box)
  pet.setPosition(constrained.x, constrained.y)

  this.pets.push(pet)
  if (this.primary === null) this.primary = pet

  if (options.emitted && source) {
    pet.inheritAnimation(source)
    var shape = capsuleShape({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 })
    var velocity = launchVelocity(this.areaHeight(), options.direction || 1)
    var capsule = new Capsule({
      id: pet.id,
      x: pet.pos.x + shape.offsetX,
      y: pet.pos.y + shape.offsetY,
      radius: shape.radius,
      halfLine: shape.halfLine,
      mass: shape.mass,
      dynamic: true,
      owner: pet,
      sourceId: source.id,
    })
    capsule.vx = velocity.vx
    capsule.vy = velocity.vy
    this.world.add(capsule)
  } else {
    this.setHover(pet)
  }
  pet.draw()
  return pet
}

/** Keep the visible box inside the container (pet_group.constrain_origin). */
Group.prototype.constrain = function (x, y, box) {
  var b = this.world.bounds
  var nx = Math.min(Math.max(x, b.left - box.x0), Math.max(b.left - box.x0, b.right - box.x1))
  var ny = Math.min(Math.max(y, b.top - box.y0), Math.max(b.top - box.y0, b.bottom - box.y1))
  return { x: nx, y: ny }
}

Group.prototype.duplicate = function (source) {
  this.copyReady = true
  return this.spawn({ source: source, scale: CLONE_SCALE })
}

Group.prototype.paste = function (point) {
  if (!this.copyReady) return null
  return this.spawn({ point: point, scale: CLONE_SCALE })
}

// ---------------------------------------------------------------------------
// Merge (合体)
// ---------------------------------------------------------------------------

/**
 * Merge two same-tier pets whose visible pixels overlap (pet_group.try_merge).
 * Overlap is measured on the binary silhouettes, not the capsules.
 * @returns {boolean} whether a merge happened
 */
Group.prototype.tryMerge = function (source) {
  if (this.closed || this.reunifying) return false
  if (this.pets.indexOf(source) < 0) return false
  var tier = tierOf(source.scale)
  if (tier === 1) return false

  var best = null
  var bestArea = 0
  for (var i = 0; i < this.pets.length; i += 1) {
    var other = this.pets[i]
    if (other === source) continue
    if (tierOf(other.scale) !== tier) continue
    var area = this.overlap(source, other)
    if (area > bestArea) {
      bestArea = area
      best = other
    }
  }
  if (!best || bestArea <= 0) return false

  var nextScale = TIERS[tier - 2]
  var anchor = best.footPosition()
  var keepLoop = best.loopStart !== null
  if (!keepLoop) best.toIdle()
  best.setScale(nextScale)
  // Re-anchor on the merged pet's foot so the result does not jump.
  var box = best.visibleBox()
  var constrained = this.constrain(anchor.x - (box.x0 + box.x1) / 2, anchor.y - box.y1, box)
  best.setPosition(constrained.x, constrained.y)
  this.resizePhysics(best)
  if (this.primary === source) this.primary = best
  this.destroyPet(source)
  this.setHover(best)
  this.bubble(best, 'merge')
  return true
}

/** Count overlapping opaque pixels of two pets' visible silhouettes. */
Group.prototype.overlap = function (a, b) {
  var ab = a.visibleBox()
  var bb = b.visibleBox()
  var ax = a.pos.x + ab.x0
  var ay = a.pos.y + ab.y0
  var bx = b.pos.x + bb.x0
  var by = b.pos.y + bb.y0
  var left = Math.max(ax, bx)
  var top = Math.max(ay, by)
  var right = Math.min(a.pos.x + ab.x1, b.pos.x + bb.x1)
  var bottom = Math.min(a.pos.y + ab.y1, b.pos.y + bb.y1)
  if (right <= left || bottom <= top) return 0
  if (!a.alpha || !b.alpha) return 0

  // Sample on a coarse grid — the reference counts exact pixels, which is far
  // too slow in JS at 60 Hz. A 2 px stride keeps the comparison meaningful.
  var stride = 2
  var count = 0
  for (var y = top; y < bottom; y += stride) {
    for (var x = left; x < right; x += stride) {
      var ax0 = Math.round(x - ax)
      var ay0 = Math.round(y - ay)
      var bx0 = Math.round(x - bx)
      var by0 = Math.round(y - by)
      if (ax0 < 0 || ay0 < 0 || ax0 >= a.alpha.width || ay0 >= a.alpha.height) continue
      if (bx0 < 0 || by0 < 0 || bx0 >= b.alpha.width || by0 >= b.alpha.height) continue
      if (a.alpha.data[ay0 * a.alpha.width + ax0] && b.alpha.data[by0 * b.alpha.width + bx0]) count += 1
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Reunify (归一)
// ---------------------------------------------------------------------------

Group.prototype.reunify = function () {
  if (this.closed || this.reunifying || this.pets.length < 2) return
  this.reunifying = true
  this.pendingBursts.length = 0
  this.world.clear()
  var target = this.primary || this.pets[0]
  var keepLoop = target.loopStart !== null
  if (!keepLoop) target.toIdle()
  var destination = target.footPosition()
  var starts = []
  for (var i = 0; i < this.pets.length; i += 1) {
    var pet = this.pets[i]
    if (pet === target) continue
    pet.toIdle()
    starts.push({
      pet: pet,
      x: pet.pos.x,
      y: pet.pos.y,
      foot: pet.footPosition(),
    })
  }
  var began = nowSec()
  var self = this

  function advance() {
    if (self.closed) return
    var fraction = Math.min(1, Math.max(0, (nowSec() - began) / REUNIFY_SEC))
    var eased = 1 - Math.pow(1 - fraction, 3)
    for (var k = 0; k < starts.length; k += 1) {
      var s = starts[k]
      s.pet.setPosition(
        s.x + (destination.x - s.foot.x) * eased,
        s.y + (destination.y - s.foot.y) * eased,
      )
    }
    if (fraction >= 1) {
      for (var m = 0; m < starts.length; m += 1) self.destroyPet(starts[m].pet)
      self.reunifying = false
      self.setHover(target)
      self.bubble(target, 'reunify')
    } else {
      self.reunifyTimer = setTimeout(advance, 16)
    }
  }
  advance()
}

Group.prototype.destroyPet = function (pet) {
  this.cancelEmission(pet)
  this.world.remove(pet.id)
  var index = this.pets.indexOf(pet)
  if (index >= 0) this.pets.splice(index, 1)
  if (this.primary === pet) this.primary = this.pets[0] || null
  if (this.accountBubble && this.accountBubble.pet === pet) this.hideAccountBubble()
  pet.destroy()
  this.removeBubbleOf(pet)
}

// ---------------------------------------------------------------------------
// Bubbles (new feature — the original has none)
// ---------------------------------------------------------------------------

Group.prototype.bubble = function (pet, kind, vars) {
  if (!this.config.bubble.enabled) return
  // The whale account bubble already occupies the spot above the pet.
  // Reaction bubbles would overlap it; the account UI is the only report now.
  if (this.accountBubble) return
  var lines = this.config.bubble.lines[kind] || this.config.bubble.lines.idle || []
  if (!lines.length) return
  var text = lines[Math.floor(Math.random() * lines.length)]
  text = this.interpolate(text, vars || {})
  if (!text) return

  this.removeBubbleOf(pet)
  var el = document.createElement('div')
  el.className = CLS + '-bubble'
  el.style.maxWidth = this.config.bubble.maxWidthPx + 'px'
  el.textContent = text
  this.container.appendChild(el)

  var entry = { pet: pet, el: el, until: nowSec() + this.config.bubble.durationMs / 1000 }
  this.bubbles.push(entry)
  this.positionBubble(entry)
  // Trigger the entry transition on the next frame.
  requestAnimationFrame(function () { el.classList.add(CLS + '-bubble-in') })
}

Group.prototype.interpolate = function (text, vars) {
  return String(text).replace(/\{(\w+)\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  })
}

Group.prototype.positionBubble = function (entry) {
  if (entry.pet.destroyed) return
  var box = entry.pet.visibleBox()
  var rect = this.container.getBoundingClientRect()
  var cx = entry.pet.pos.x - box.x0 + (box.x0 + box.x1) / 2
  var top = entry.pet.pos.y - box.y0 + box.y0
  var w = entry.el.offsetWidth
  var h = entry.el.offsetHeight
  var x = clamp(cx - w / 2, 4, Math.max(4, rect.width - w - 4))
  var y = clamp(top - h - 6, 4, Math.max(4, rect.height - h - 4))
  entry.el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)'
}

Group.prototype.removeBubbleOf = function (pet) {
  var kept = []
  for (var i = 0; i < this.bubbles.length; i += 1) {
    var entry = this.bubbles[i]
    if (entry.pet === pet) {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el)
    } else {
      kept.push(entry)
    }
  }
  this.bubbles = kept
}

Group.prototype.tickBubbles = function (now) {
  var kept = []
  for (var i = 0; i < this.bubbles.length; i += 1) {
    var entry = this.bubbles[i]
    if (now >= entry.until || entry.pet.destroyed) {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el)
      continue
    }
    kept.push(entry)
  }
  this.bubbles = kept
}

Group.prototype.clearBubbles = function () {
  for (var i = 0; i < this.bubbles.length; i += 1) {
    var el = this.bubbles[i].el
    if (el.parentNode) el.parentNode.removeChild(el)
  }
  this.bubbles = []
}

// ---------------------------------------------------------------------------
// Ledger reactions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Events used by Pet
// ---------------------------------------------------------------------------

/**
 * A lone left click summons the whale-style account bubble for a few seconds.
 * A double click (resolved in `Pet.completeClick`) laughs and never reaches
 * this method.
 */
Group.prototype.onSingleClick = function (pet) {
  if (!pet || pet.destroyed) return
  this.setPrimary(pet)
  if (!this.config.accounting.enabled) {
    this.bubble(pet, 'click')
    return
  }
  if (!this.config.accounting.showTodayOnClick) return
  // A click is a normal balance view, not a turn report.
  this.accountTurn = null
  this.showAccountBubble(pet, this.config.bubble.durationMs)
  // Refresh on every click so the bubble is not stuck on a 20 s poll value.
  this.loadLedgerForBubble()
}

/**
 * Show/refresh the whale-style account bubble above one pet. When
 * `autoHideMs` is a positive number the bubble hides itself after that delay;
 * the menu/editor keep it alive while they are open.
 */
Group.prototype.showAccountBubble = function (pet, autoHideMs) {
  if (!pet || pet.destroyed) return
  if (!this.config.bubble.enabled) return
  var self = this
  this.cancelAccountBubbleHide()
  if (!this.accountBubble) {
    var built = buildAccountBubble()
    this.container.appendChild(built.el)
    this.accountBubble = { el: built.el, refs: built, pet: pet }
    built.menu.addEventListener('click', function (ev) {
      ev.preventDefault()
      ev.stopPropagation()
      if (self.accountBubble) self.openBubbleMenu(self.accountBubble.pet)
    })
  }
  this.accountBubble.pet = pet
  this.setPrimary(pet)

  var width = Math.round(clamp(220 * (pet.scale / 0.6), 215, 280))
  this.accountBubble.el.style.width = width + 'px'
  this.accountBubble.el.style.height = Math.round((width * 700) / 1026) + 'px'
  // Type scales with the bubble instead of staying at one fixed px size.
  this.accountBubble.el.style.setProperty('--naiwa-ab-fs', (width / 220).toFixed(4))
  this.renderAccountBubble()
  this.positionAccountBubble()
  requestAnimationFrame(function () {
    if (self.accountBubble) self.accountBubble.el.classList.add(CLS + '-abubble-in')
  })
  if (autoHideMs > 0) this.scheduleAccountBubbleHide(autoHideMs)
}

Group.prototype.cancelAccountBubbleHide = function () {
  if (this.accountBubbleTimer) clearTimeout(this.accountBubbleTimer)
  this.accountBubbleTimer = null
}

Group.prototype.scheduleAccountBubbleHide = function (ms) {
  var self = this
  this.cancelAccountBubbleHide()
  if (!this.accountBubble) return
  this.accountBubbleTimer = setTimeout(function () {
    self.accountBubbleTimer = null
    // Never yank the bubble away while the user is in its menu/editor.
    if (self.bubbleMenu || self.bubbleEditor) return
    self.hideAccountBubble()
  }, ms)
}

/**
 * Report one completed conversation turn in the account bubble. `turn.amount`
 * is the cost from dsh-whale-widget's last-turn feed; no number is invented.
 */
Group.prototype.announceTurn = function (turn) {
  if (!this.config.accounting.enabled || !this.config.accounting.announce) return
  if (!turn || !isFinite(Number(turn.amount))) return
  var pet = this.primary || this.pets[0]
  if (!pet || pet.destroyed) return
  this.accountTurn = {
    amount: Number(turn.amount),
    tokens: Number(turn.tokens) || 0,
    ts: Number(turn.ts) || Date.now(),
  }
  this.showAccountBubble(pet, this.config.bubble.durationMs)
  this.loadLedgerForBubble()
}

/** Fill the bubble from the last ledger snapshot; never invents a number. */
Group.prototype.renderAccountBubble = function () {
  var entry = this.accountBubble
  if (!entry) return
  var refs = entry.refs
  var account = this.accountPrefs || defaultAccountBubble()
  var snap = this.ledger
  var ok = !!(snap && snap.ok)
  var currency = snap && snap.currency
  var today = ok && snap.today ? snap.today.amount : null
  var balance = ok
    ? (snap.today && snap.today.currentBalance != null ? snap.today.currentBalance : snap.lastBalance)
    : null

  // A completed turn temporarily replaces the title with its cost. It is the
  // same whale bubble, not the old transient prompt box.
  if (this.accountTurn && isFinite(this.accountTurn.amount)) {
    refs.title.textContent = '本轮消耗 ' + uiMoney(this.accountTurn.amount, currency)
    refs.title.style.display = ''
    refs.title.classList.add(CLS + '-abubble-title-turn')
  } else {
    refs.title.textContent = account.title
    refs.title.style.display = account.showTitle ? '' : 'none'
    refs.title.classList.remove(CLS + '-abubble-title-turn')
  }
  refs.todayLabel.textContent = account.todayLabel
  refs.balanceLabel.textContent = account.balanceLabel
  refs.todayRow.style.display = account.showToday ? '' : 'none'
  refs.balanceRow.style.display = account.showBalance ? '' : 'none'
  refs.todayRow.style.order = account.order === 'balance-first' ? '2' : '1'
  refs.balanceRow.style.order = account.order === 'balance-first' ? '1' : '2'
  refs.todayValue.textContent = today == null ? '—' : uiMoney(today, currency)
  refs.balanceValue.textContent = balance == null ? '—' : uiMoney(balance, currency)
  entry.el.setAttribute(
    'title',
    ok
      ? (snap.liveAccount && snap.liveAccount.ok
        ? '余额来自 DSH 账号实时接口；今日已用按今日余额变化累计'
        : '账本由 dsh-whale-widget 写入，奶蛙只读')
      : '账本当前不可用',
  )
  if (entry.pet) this.positionAccountBubble()
}

Group.prototype.positionAccountBubble = function () {
  var entry = this.accountBubble
  if (!entry || !entry.pet || entry.pet.destroyed) return
  var el = entry.el
  var pet = entry.pet
  var crect = this.container.getBoundingClientRect()
  var prect = pet.el.getBoundingClientRect()
  var box = pet.visibleBox()
  var left = prect.left - crect.left + box.x0
  var right = prect.left - crect.left + box.x1
  var top = prect.top - crect.top + box.y0
  var w = el.offsetWidth || parseFloat(el.style.width) || 300
  var h = el.offsetHeight || parseFloat(el.style.height) || 205
  var vw = crect.width > 0 ? crect.width : window.innerWidth
  var vh = crect.height > 0 ? crect.height : window.innerHeight
  var bottom = prect.top - crect.top + box.y1
  var x = clamp((left + right) / 2 - w / 2, 4, Math.max(4, vw - w - 4))
  var y = top - h - 4
  // No room above (the pet was dragged near the top): put the bubble below and
  // flip only the SVG so its tail still points at the pet. The text layer stays
  // upright. When the bubble is above, the tail already points down.
  var below = y < 4 && (vh - bottom) >= top
  if (below) {
    y = bottom + 4
    el.classList.add(CLS + '-abubble-below')
  } else {
    el.classList.remove(CLS + '-abubble-below')
  }
  y = clamp(y, 4, Math.max(4, vh - h - 4))
  el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)'
}

Group.prototype.hideAccountBubble = function () {
  this.cancelAccountBubbleHide()
  this.accountTurn = null
  var entry = this.accountBubble
  this.accountBubble = null
  this.closeBubbleMenu()
  if (this.bubbleEditor) {
    try { this.bubbleEditor.close() } catch (err) { /* already closed */ }
    this.bubbleEditor = null
    this.accountPrefs = loadAccountBubblePrefs(this.config)
  }
  if (entry && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el)
}

Group.prototype.refreshAccountBubble = function () {
  if (this.accountBubble) this.renderAccountBubble()
}

Group.prototype.loadLedgerForBubble = function () {
  if (this.ledgerFetch) return
  var self = this
  this.ledgerFetch = fetch(API_BASE + '/ledger.json', { cache: 'no-store' })
    .then(function (res) { return res.json() })
    .then(function (snap) {
      self.ledger = snap
      self.refreshAccountBubble()
    })
    .catch(function () {
      self.ledger = { ok: false, reason: 'network' }
      self.refreshAccountBubble()
    })
    .then(function () { self.ledgerFetch = null })
}

/**
 * Compact menu opened by the bubble's ☰ button. It is anchored to the bubble's
 * left boundary (or its right boundary when there is no room on the left), not
 * to the pointer, which is what makes it read as part of the bubble.
 */
Group.prototype.openBubbleMenu = function (pet) {
  if (this.bubbleMenu) {
    this.closeBubbleMenu()
    return
  }
  if (!this.accountBubble) return
  this.cancelAccountBubbleHide()
  this.setPrimary(pet)
  var self = this
  var menu = document.createElement('div')
  menu.className = CLS + '-amenupop'
  menu.setAttribute('role', 'menu')

  function item(label, onClick, disabled) {
    var row = document.createElement('button')
    row.type = 'button'
    row.className = CLS + '-amenuitem'
    row.setAttribute('role', 'menuitem')
    row.textContent = label
    if (disabled) row.disabled = true
    row.addEventListener('click', function (ev) {
      ev.stopPropagation()
      self.closeBubbleMenu()
      onClick()
    })
    menu.appendChild(row)
    return row
  }
  function sep() {
    menu.appendChild(uiEl('div', CLS + '-amenusep'))
  }

  item('捧腹大笑', function () { pet.play(true) })
  item('全部大笑', function () { self.playAll(true) })
  item('停止大笑', function () { pet.stopLaugh() })
  item('停止全部大笑', function () { self.stopAllLaughs() })
  sep()
  item('复制分身', function () { self.duplicate(pet) }, self.count() >= self.config.pet.maxPets)
  item('归一分身', function () { self.reunify() }, self.pets.length < 2)
  sep()
  item('编辑气泡', function () { self.openBubbleEditor(pet) })
  sep()
  menu.appendChild(uiEl('div', CLS + '-amenulabel', '大小'))
  for (var i = 0; i < TIERS.length; i += 1) {
    ;(function (tier) {
      var current = Math.abs(snapScale(pet.scale) - tier) < 1e-9
      item((current ? '● ' : '○ ') + tierOf(tier) + '档  ' + tier.toFixed(1), function () {
        pet.setScale(tier)
        self.showAccountBubble(pet, self.config.bubble.durationMs)
      })
    })(TIERS[i])
  }
  sep()
  item('隐藏气泡', function () { self.hideAccountBubble() })
  item('隐藏奶蛙', function () { self.hideAll() })

  menu.style.visibility = 'hidden'
  this.container.appendChild(menu)
  var brect = this.accountBubble.el.getBoundingClientRect()
  var crect = this.container.getBoundingClientRect()
  var w = menu.offsetWidth
  var h = menu.offsetHeight
  var vw = crect.width > 0 ? crect.width : window.innerWidth
  var vh = crect.height > 0 ? crect.height : window.innerHeight
  var left = brect.left - crect.left - w - 10
  if (left < 4) {
    var right = brect.right - crect.left + 10
    left = right + w <= vw - 4 ? right : left
  }
  left = clamp(left, 4, Math.max(4, vw - w - 4))
  var top = brect.top - crect.top + (brect.height - h) / 2
  top = clamp(top, 4, Math.max(4, vh - h - 4))
  menu.style.left = Math.round(left) + 'px'
  menu.style.top = Math.round(top) + 'px'
  menu.style.visibility = 'visible'
  menu.classList.add(CLS + '-amenupop-in')
  this.bubbleMenu = menu
  // `bubbleMenuDismiss` must run with the Group as `this`; a raw method
  // reference invoked by the document would bind `this` to the document.
  this.bubbleMenuDismissHandler = function (ev) { self.bubbleMenuDismiss(ev) }
  setTimeout(function () {
    if (self.bubbleMenu) {
      document.addEventListener('pointerdown', self.bubbleMenuDismissHandler, true)
    }
  }, 0)
}

Group.prototype.closeBubbleMenu = function () {
  if (!this.bubbleMenu) return
  if (this.bubbleMenuDismissHandler) {
    document.removeEventListener('pointerdown', this.bubbleMenuDismissHandler, true)
    this.bubbleMenuDismissHandler = null
  }
  if (this.bubbleMenu.parentNode) this.bubbleMenu.parentNode.removeChild(this.bubbleMenu)
  this.bubbleMenu = null
  // The menu temporarily pinned the bubble; resume the 5 s dismissal only
  // after the menu (and any editor opened from it) is gone.
  if (this.accountBubble && !this.bubbleEditor) {
    this.scheduleAccountBubbleHide(this.config.bubble.durationMs)
  }
}

Group.prototype.bubbleMenuDismiss = function (ev) {
  var t = ev.target
  if (this.bubbleMenu && this.bubbleMenu.contains(t)) return
  if (t && t.closest && t.closest('.' + CLS + '-abubble-menu')) return
  this.closeBubbleMenu()
}

Group.prototype.openBubbleEditor = function (pet) {
  this.closeBubbleMenu()
  this.cancelAccountBubbleHide()
  if (this.bubbleEditor) {
    this.bubbleEditor.close()
    this.bubbleEditor = null
  }
  var self = this
  var previous = normalizeAccountBubble(this.accountPrefs, defaultAccountBubble())
  this.bubbleEditor = openAccountBubbleEditor(this.container, {
    account: previous,
    anchor: this.accountBubble ? this.accountBubble.el : null,
    onPreview: function (next) {
      self.accountPrefs = next
      self.renderAccountBubble()
    },
    onSave: function (next) {
      self.accountPrefs = normalizeAccountBubble(next, defaultAccountBubble())
      var saved = saveAccountBubblePrefs(self.accountPrefs)
      self.renderAccountBubble()
      return saved
    },
    onCancel: function () {
      self.accountPrefs = previous
      self.renderAccountBubble()
    },
    onClose: function () {
      self.bubbleEditor = null
      if (self.accountBubble) {
        self.scheduleAccountBubbleHide(self.config.bubble.durationMs)
      }
    },
  })
}

Group.prototype.onLaugh = function (pet) {
  // The account bubble is deliberately kept: its ☰ menu is where "停止大笑"
  // lives. `bubble()` suppresses the transient laugh text while it is visible.
  this.bubble(pet, 'laugh')
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

Group.prototype.startLoop = function () {
  if (this.rafId) return
  var self = this
  this.lastPhysicsAt = nowSec()
  function frame() {
    if (self.closed) return
    self.rafId = requestAnimationFrame(frame)
    self.tick()
  }
  this.rafId = requestAnimationFrame(frame)
}

Group.prototype.tick = function () {
  var now = nowSec()
  var elapsed = Math.max(0, now - this.lastPhysicsAt)
  this.lastPhysicsAt = now

  if (this.paused) {
    this.positionAccountBubble()
    this.tickBubbles(now)
    return
  }

  if (!this.reunifying) {
    this.emitDue(now)

    // Park every static body on its window (pet_physics.sync_hover).
    for (var i = 0; i < this.pets.length; i += 1) {
      var pet = this.pets[i]
      if (pet.dragging) continue
      var capsule = this.world.get(pet.id)
      if (!capsule || capsule.dynamic) continue
      var box = pet.visibleBox()
      var shape = capsuleShape({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 })
      var px = pet.pos.x + shape.offsetX
      var py = pet.pos.y + shape.offsetY
      if (Math.hypot(capsule.x - px, capsule.y - py) > 0.5) {
        capsule.x = px
        capsule.y = py
        this.world.wakeAll()
      }
    }

    this.world.advance(elapsed)

    // Apply dynamic positions back to the windows.
    for (var j = 0; j < this.pets.length; j += 1) {
      var p = this.pets[j]
      var c = this.world.get(p.id)
      if (!c || !c.dynamic || c.sleeping) continue
      var b2 = p.visibleBox()
      var s2 = capsuleShape({ x0: b2.x0, y0: b2.y0, x1: b2.x1, y1: b2.y1 })
      p.setPosition(c.x - s2.offsetX, c.y - s2.offsetY)
    }
  }

  // Per-pet animation + deformation + eyes.
  var frameSec = 1 / 60
  for (var k = 0; k < this.pets.length; k += 1) {
    var pp = this.pets[k]
    if (pp.destroyed) continue
    if (pp.mode === 'playing' && pp.currentIndex() >= CLIP_FRAMES) pp.toIdle()
    if (pp.mode === 'idle' && pp.idleRemaining === null && !pp.dragging && now >= pp.deadline) {
      pp.play(false)
      pp.bubbleIdle = true
    }
    var changed = false
    if (pp.jelly && pp.jelly.active()) {
      pp.jelly.advance(now)
      changed = true
    }
    if (pp.body && pp.body.moving()) {
      pp.body.advance(now)
      changed = true
    }
    var eyeChanged = pp.updateEyes(now)
    if (changed || eyeChanged || pp.mode === 'playing') pp.draw()
  }

  this.positionAccountBubble()
  this.tickBubbles(now)
}

Group.prototype.playAll = function (withAudio) {
  if (this.reunifying) return
  for (var i = 0; i < this.pets.length; i += 1) this.pets[i].play(withAudio)
}

Group.prototype.stopAllLaughs = function () {
  for (var i = 0; i < this.pets.length; i += 1) this.pets[i].stopLaugh()
  // Also silence anything the media bank still holds. This keeps the menu's
  // "停止大笑" a hard stop even if a pet was already mid-teardown.
  if (this.assets && this.assets.audio) this.assets.audio.stopAll()
}

Group.prototype.hideAll = function () {
  this.visible = false
  this.hideAccountBubble()
  this.container.classList.add(CLS + '-hidden')
  if (this.onVisibilityChange) this.onVisibilityChange(false)
}

Group.prototype.showAll = function () {
  this.visible = true
  this.container.classList.remove(CLS + '-hidden')
  if (this.onVisibilityChange) this.onVisibilityChange(true)
}

Group.prototype.dispose = function () {
  if (this.closed) return
  this.closed = true
  if (this.rafId) cancelAnimationFrame(this.rafId)
  this.rafId = 0
  if (this.reunifyTimer) clearTimeout(this.reunifyTimer)
  this.hideAccountBubble()
  this.clearBubbles()
  this.pendingBursts.length = 0
  for (var i = this.pets.length - 1; i >= 0; i -= 1) this.pets[i].destroy()
  this.pets.length = 0
  this.world.clear()
  this.assets.audio.stopAll()
}
