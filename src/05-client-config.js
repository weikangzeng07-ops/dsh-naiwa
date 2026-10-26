// ===========================================================================
// 05 — client-side config normaliser
// ===========================================================================
// The Host half already normalises, but the Client must not trust the network
// blindly: a failed fetch, an older Host, or a hand-edited file all have to
// degrade to a working pet rather than a blank screen.

/** Defaults for the whale-style account bubble (edited from the bubble menu). */
function defaultAccountBubble() {
  return {
    title: '奶蛙记账',
    todayLabel: '今日已用',
    balanceLabel: '全部余额',
    showTitle: true,
    showToday: true,
    showBalance: true,
    order: 'today-first',
  }
}

function cleanAccountText(value, fallback, max) {
  if (typeof value !== 'string') return fallback
  var text = value.trim().slice(0, max)
  return text || fallback
}

/** Coerce one account-bubble preference object; unknown keys are dropped. */
function normalizeAccountBubble(input, fallback) {
  var base = fallback || defaultAccountBubble()
  var src = input && typeof input === 'object' ? input : {}
  return {
    title: cleanAccountText(src.title, base.title, 24),
    todayLabel: cleanAccountText(src.todayLabel, base.todayLabel, 16),
    balanceLabel: cleanAccountText(src.balanceLabel, base.balanceLabel, 16),
    showTitle: src.showTitle === undefined ? base.showTitle : src.showTitle !== false,
    showToday: src.showToday === undefined ? base.showToday : src.showToday !== false,
    showBalance: src.showBalance === undefined ? base.showBalance : src.showBalance !== false,
    order: src.order === 'balance-first' ? 'balance-first' : (src.order === 'today-first' ? 'today-first' : base.order),
  }
}

/**
 * The account bubble is a client-side cosmetic preference: saving it through
 * the Host config would require a Host restart for the schema to accept the new
 * field, so the editor persists it in localStorage instead. It still works when
 * the Host is older than the Client.
 */
var ACCOUNT_PREFS_KEY = 'dsh-naiwa.accountBubble.v1'
var ACCOUNT_PREFS_VERSION = 2

function loadAccountBubblePrefs(config) {
  var fallback = config && config.bubble && config.bubble.account
    ? config.bubble.account
    : defaultAccountBubble()
  try {
    var raw = window.localStorage.getItem(ACCOUNT_PREFS_KEY)
    if (raw) {
      var saved = JSON.parse(raw)
      // v1 saved the title as hidden by default. Migration keeps old labels and
      // order, but turns the title back on so "奶蛙记账" is visible.
      if (saved && saved.v !== ACCOUNT_PREFS_VERSION) saved.showTitle = true
      return normalizeAccountBubble(saved, fallback)
    }
  } catch (err) { /* private mode or malformed value: use the config default */ }
  return normalizeAccountBubble(fallback, defaultAccountBubble())
}

function saveAccountBubblePrefs(account) {
  try {
    var saved = normalizeAccountBubble(account)
    saved.v = ACCOUNT_PREFS_VERSION
    window.localStorage.setItem(ACCOUNT_PREFS_KEY, JSON.stringify(saved))
    return true
  } catch (err) {
    return false
  }
}

function defaultClientConfig() {
  return {
    version: 1,
    enabled: true,
    pet: {
      visible: true,
      scale: 0.6,
      maxPets: 40,
      startPosition: 'bottom-right',
      eyeFollow: true,
      physics: true,
      sound: true,
      volume: 0.7,
      randomActionMinSec: 180,
      randomActionMaxSec: 240,
      pauseWhenHidden: true,
      maxFps: 30,
    },
    bubble: {
      enabled: true,
      durationMs: 5000,
      maxWidthPx: 260,
      account: defaultAccountBubble(),
      lines: {
        idle: ['奶蛙在看着你…'],
        click: ['呱！'],
        hold: ['蓄力中…'],
        drag: ['飞起来啦~'],
        land: ['安全着陆'],
        laugh: ['哈哈哈哈！'],
        split: ['分身出现了！'],
        merge: ['合体成功！'],
        reunify: ['归位！'],
        limit: ['已经到上限啦…'],
      },
    },
    accounting: { enabled: true, pollSec: 20, announce: true, showTodayOnClick: true },
  }
}

function normalizeClientConfig(input) {
  var base = defaultClientConfig()
  var src = input && typeof input === 'object' ? input : {}
  var pet = src.pet && typeof src.pet === 'object' ? src.pet : {}
  var bubble = src.bubble && typeof src.bubble === 'object' ? src.bubble : {}
  var lines = bubble.lines && typeof bubble.lines === 'object' ? bubble.lines : {}
  var accounting = src.accounting && typeof src.accounting === 'object' ? src.accounting : {}

  function num(value, min, max, fallback) {
    var n = Number(value)
    if (!isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  function bool(value, fallback) {
    return value === undefined ? fallback : value !== false
  }
  function list(value, fallback) {
    if (!Array.isArray(value)) return fallback.slice()
    var out = []
    for (var i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') out.push(value[i].slice(0, 200))
    }
    return out.length ? out : fallback.slice()
  }

  var normalizedLines = {}
  for (var key in base.bubble.lines) {
    if (Object.prototype.hasOwnProperty.call(base.bubble.lines, key)) {
      normalizedLines[key] = list(lines[key], base.bubble.lines[key])
    }
  }
  var positions = { 'bottom-right': 1, 'bottom-left': 1, 'bottom-center': 1, random: 1 }

  return {
    version: 1,
    enabled: bool(src.enabled, base.enabled),
    pet: {
      visible: bool(pet.visible, base.pet.visible),
      scale: num(pet.scale, 0.2, 2, base.pet.scale),
      maxPets: Math.round(num(pet.maxPets, 1, 40, base.pet.maxPets)),
      startPosition: positions[pet.startPosition] ? pet.startPosition : base.pet.startPosition,
      eyeFollow: bool(pet.eyeFollow, base.pet.eyeFollow),
      physics: bool(pet.physics, base.pet.physics),
      sound: bool(pet.sound, base.pet.sound),
      volume: num(pet.volume, 0, 1, base.pet.volume),
      randomActionMinSec: Math.round(num(pet.randomActionMinSec, 20, 3600, base.pet.randomActionMinSec)),
      randomActionMaxSec: Math.round(num(pet.randomActionMaxSec, 20, 7200, base.pet.randomActionMaxSec)),
      pauseWhenHidden: bool(pet.pauseWhenHidden, base.pet.pauseWhenHidden),
      maxFps: Math.round(num(pet.maxFps, 10, 60, base.pet.maxFps)),
    },
    bubble: {
      enabled: bool(bubble.enabled, base.bubble.enabled),
      durationMs: Math.round(num(bubble.durationMs, 800, 60000, base.bubble.durationMs)),
      maxWidthPx: Math.round(num(bubble.maxWidthPx, 120, 480, base.bubble.maxWidthPx)),
      account: normalizeAccountBubble(bubble.account, base.bubble.account),
      lines: normalizedLines,
    },
    accounting: {
      enabled: bool(accounting.enabled, base.accounting.enabled),
      pollSec: Math.round(num(accounting.pollSec, 5, 3600, base.accounting.pollSec)),
      announce: bool(accounting.announce, base.accounting.announce),
      showTodayOnClick: bool(accounting.showTodayOnClick, base.accounting.showTodayOnClick),
    },
  }
}
