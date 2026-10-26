/**
 * dsh-naiwa — 奶蛙桌宠 Host half.
 *
 * Responsibilities (Host side only — the pet itself renders in the browser):
 *   1. Serve the pet's static assets (432 animation frames, eye layers, audio).
 *   2. Serve the persisted pet configuration (own file, own namespace).
 *   3. Serve a read-only accounting snapshot derived from the ledger owned by
 *      `dsh-whale-widget` (see lib/accounting-adapter.mjs). Never writes it.
 *   4. Emit `dsh-naiwa/accounting` when the ledger gains a new record, so the pet
 *      can react to a *real* recorded spend instead of guessing.
 *
 * It registers no tool, no prompt section and no system-prompt context: the pet
 * must not cost tokens or change model behaviour.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAccountingSnapshot, accountingFingerprint } from './accounting-adapter.mjs'
import { beijingDay } from './accounting.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PLUGIN_ID = 'dsh-naiwa'
const ROUTE_PREFIX = '/dsh-naiwa'
const CONFIG_NAMESPACE = 'dsh-naiwa'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** MIME table for the assets this plugin ships. */
const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/** Assets that may be requested by name; everything else is refused. */
const FRAME_RE = /^f\d{4}\.webp$/
const SOUND_RE = /^[a-z0-9][a-z0-9_-]{0,31}\.(wav|mp3|ogg)$/
const EYE_RE = /^(backing|pupil)\.png$/
const MANIFEST_RE = /^manifest\.json$/

const MAX_BODY_BYTES = 256 * 1024

function contentTypeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': String(Buffer.byteLength(body)) })
  res.end(body)
}

function sendBytes(res, status, bytes, type, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(bytes.length),
    ...extraHeaders,
  })
  res.end(bytes)
}

/** Read a request body with a hard byte cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        finish(reject, new Error('body-too-large'))
        try { req.destroy() } catch (err) { /* already gone */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (err) => finish(reject, err))
  })
}

// ---------------------------------------------------------------------------
// Configuration
//
// The pet owns its OWN file, in its OWN namespace. It never touches the whale's
// `.dshw-*.json` files, and the whale never reads this one.
// ---------------------------------------------------------------------------

/**
 * Default configuration. Every field the Client reads has a default here, so a
 * missing/corrupt file degrades to a working pet instead of an empty one.
 */
export function defaultConfig() {
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
      lines: {
        idle: ['奶蛙在看着你…', '老大今天也要好好记账哦'],
        click: ['呱！', '别戳啦~', 'Q弹！'],
        hold: ['蓄力中…', '要弹起来啦！'],
        drag: ['飞起来啦~', '放我下来！'],
        land: ['安全着陆', '噗通~'],
        laugh: ['哈哈哈哈！', '捧腹大笑！'],
        split: ['分身出现了！', '呱呱呱！'],
        merge: ['合体成功！', '变大啦！'],
        reunify: ['归位！', '都回来啦~'],
        accountOk: ['记账成功：¥{amount}', '这一轮花了 ¥{amount}'],
        accountFail: ['记账没成功…', '账本读取失败，先不记账'],
        accountEmpty: ['今天还没花钱呢', '今日已用 ¥{today}'],
      },
    },
    accounting: {
      enabled: true,
      pollSec: 20,
      announce: true,
      // 桌宠只在真正拿到账本数据时才说话；读不到就保持沉默。
      showTodayOnClick: true,
    },
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice()
  const out = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.slice(0, 200))
    .slice(0, 40)
  return out.length ? out : fallback.slice()
}

/**
 * Coerce arbitrary stored JSON into a valid configuration.
 * Unknown keys are dropped; every invalid value falls back to its default.
 */
export function normalizeConfig(input) {
  const base = defaultConfig()
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const pet = src.pet && typeof src.pet === 'object' ? src.pet : {}
  const bubble = src.bubble && typeof src.bubble === 'object' ? src.bubble : {}
  const lines = bubble.lines && typeof bubble.lines === 'object' ? bubble.lines : {}
  const accounting = src.accounting && typeof src.accounting === 'object' ? src.accounting : {}
  const positions = new Set(['bottom-right', 'bottom-left', 'bottom-center', 'random'])

  const normalizedLines = {}
  for (const key of Object.keys(base.bubble.lines)) {
    normalizedLines[key] = stringList(lines[key], base.bubble.lines[key])
  }

  return {
    version: 1,
    enabled: src.enabled === undefined ? base.enabled : src.enabled !== false,
    pet: {
      visible: pet.visible === undefined ? base.pet.visible : pet.visible !== false,
      scale: clampNumber(pet.scale, 0.2, 2, base.pet.scale),
      maxPets: Math.round(clampNumber(pet.maxPets, 1, 40, base.pet.maxPets)),
      startPosition: positions.has(pet.startPosition) ? pet.startPosition : base.pet.startPosition,
      eyeFollow: pet.eyeFollow === undefined ? base.pet.eyeFollow : pet.eyeFollow !== false,
      physics: pet.physics === undefined ? base.pet.physics : pet.physics !== false,
      sound: pet.sound === undefined ? base.pet.sound : pet.sound !== false,
      volume: clampNumber(pet.volume, 0, 1, base.pet.volume),
      randomActionMinSec: Math.round(clampNumber(pet.randomActionMinSec, 20, 3600, base.pet.randomActionMinSec)),
      randomActionMaxSec: Math.round(clampNumber(pet.randomActionMaxSec, 20, 7200, base.pet.randomActionMaxSec)),
      pauseWhenHidden: pet.pauseWhenHidden === undefined ? base.pet.pauseWhenHidden : pet.pauseWhenHidden !== false,
      maxFps: Math.round(clampNumber(pet.maxFps, 10, 60, base.pet.maxFps)),
    },
    bubble: {
      enabled: bubble.enabled === undefined ? base.bubble.enabled : bubble.enabled !== false,
      durationMs: Math.round(clampNumber(bubble.durationMs, 800, 60000, base.bubble.durationMs)),
      maxWidthPx: Math.round(clampNumber(bubble.maxWidthPx, 120, 480, base.bubble.maxWidthPx)),
      lines: normalizedLines,
    },
    accounting: {
      enabled: accounting.enabled === undefined ? base.accounting.enabled : accounting.enabled !== false,
      pollSec: Math.round(clampNumber(accounting.pollSec, 5, 3600, base.accounting.pollSec)),
      announce: accounting.announce === undefined ? base.accounting.announce : accounting.announce !== false,
      showTodayOnClick:
        accounting.showTodayOnClick === undefined
          ? base.accounting.showTodayOnClick
          : accounting.showTodayOnClick !== false,
    },
  }
}

/**
 * Hard service dependency.
 *
 * Without this the cordis context proxy throws
 * `cannot get property "webServer" without inject` the first time `apply`
 * touches `ctx.webServer`, which aborts `apply` before ANY route is
 * registered — every `/dsh-naiwa/*` request then falls through to the SPA
 * fallback and the browser sees 404 for the frames and the config.
 *
 * `webServer` is the only service this plugin needs. The ledger reader talks
 * to the filesystem directly (read-only) and never needs `credentials`,
 * `connection`, or `deepseekAccount`.
 */
export const inject = ['webServer']

export function apply(ctx, config) {
  const log = (...parts) => {
    try {
      ctx.logger?.info?.(...parts)
    } catch (err) {
      /* logging is best effort */
    }
    try {
      console.log('[dsh-naiwa]', ...parts)
    } catch (err) {
      /* no console is not fatal */
    }
  }

  // ---- Configuration persistence -----------------------------------------
  // Resolved through the Host `storage` hub when present (so it lives where the
  // Harness keeps plugin data), otherwise a JSON file beside DSH home.
  let storageHandle = null
  let fileFallbackPath = null

  const dshHome = () => process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  const configPath = () => path.join(dshHome(), '.dsh-naiwa-config.json')

  function readConfigFile() {
    if (!fileFallbackPath) fileFallbackPath = configPath()
    try {
      const raw = fs.readFileSync(fileFallbackPath, 'utf8')
      return normalizeConfig(JSON.parse(raw))
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log('[dsh-naiwa] config unreadable, using defaults:', String((err && err.message) || err))
      }
      return defaultConfig()
    }
  }

  function writeConfigFile(next) {
    if (!fileFallbackPath) fileFallbackPath = configPath()
    const body = JSON.stringify(next, null, 2)
    const temp = `${fileFallbackPath}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(fileFallbackPath), { recursive: true })
      fs.writeFileSync(temp, body, 'utf8')
      fs.renameSync(temp, fileFallbackPath)
      return true
    } catch (err) {
      try { fs.unlinkSync(temp) } catch (cleanupErr) { /* nothing to clean */ }
      log('[dsh-naiwa] config write failed:', String((err && err.message) || err))
      return false
    }
  }

  let currentConfig = normalizeConfig(config)
  // The file is the source of truth when it exists (the panel writes it); the
  // patch row's `config` only seeds a fresh installation.
  const fromDisk = readConfigFile()
  if (fromDisk) currentConfig = fromDisk

  // ---- Asset helpers ------------------------------------------------------
  function assetPath(...segments) {
    return path.join(PACKAGE_ROOT, 'assets', ...segments)
  }

  function serveFile(res, file, extraHeaders) {
    let bytes
    try {
      bytes = fs.readFileSync(file)
    } catch (err) {
      sendJson(res, 404, { ok: false, error: 'asset-missing', file: path.basename(file) })
      return
    }
    sendBytes(res, 200, bytes, contentTypeOf(file), {
      'Cache-Control': 'public, max-age=3600',
      ...extraHeaders,
    })
  }

  // ---- Accounting ---------------------------------------------------------
  let lastFingerprint = null
  let lastSnapshot = null
  let lastSnapshotAt = 0
  const SNAPSHOT_TTL_MS = 1500

  function snapshot(force = false) {
    const now = Date.now()
    if (!force && lastSnapshot && now - lastSnapshotAt < SNAPSHOT_TTL_MS) return lastSnapshot
    lastSnapshot = buildAccountingSnapshot({ days: 7 })
    lastSnapshotAt = now
    return lastSnapshot
  }

  function checkAccounting() {
    let snap
    try {
      snap = snapshot(true)
    } catch (err) {
      log('[dsh-naiwa] accounting snapshot failed:', String((err && err.message) || err))
      return
    }
    const fingerprint = accountingFingerprint(snap)
    const previous = lastFingerprint
    lastFingerprint = fingerprint
    if (previous === null || previous === fingerprint) return
    // Only announce when a *new* recorded record appeared — never on a mere
    // re-read, and never when the ledger is unavailable.
    if (!snap.ok) return
    try {
      ctx.emit('dsh-naiwa/accounting', {
        fingerprint,
        previous,
        snapshot: snap,
      })
    } catch (err) { /* no listeners is normal */ }
  }

  // Prime the fingerprint so the first poll does not announce history.
  try { lastFingerprint = accountingFingerprint(snapshot(true)) } catch (err) { lastFingerprint = null }

  // ---- Live account balance ----------------------------------------------
  // The whale ledger only moves while dsh-whale-widget is mounted. When it is
  // not, show the account's real balance and derive today's spend from the
  // balance observations this plugin makes (persisted across restarts).
  const LIVE_ACCOUNT_TTL_MS = 15000
  let liveAccountCache = null
  let liveAccountCacheAt = 0
  let lastGoodLiveAccount = null
  let liveAccountState = null
  let liveAccountWriting = false

  const accountStatePath = () => path.join(dshHome(), '.dsh-naiwa-account.json')

  function readAccountState() {
    try {
      const raw = fs.readFileSync(accountStatePath(), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (err) {
      return null
    }
  }

  function writeAccountState(state) {
    if (liveAccountWriting) return
    liveAccountWriting = true
    const file = accountStatePath()
    const temp = `${file}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(temp, JSON.stringify(state), 'utf8')
      fs.renameSync(temp, file)
    } catch (err) {
      try { fs.unlinkSync(temp) } catch (cleanupErr) { /* nothing to clean */ }
    } finally {
      liveAccountWriting = false
    }
  }

  function msToNextBeijingMidnight(now) {
    const beijing = new Date(now + 8 * 60 * 60 * 1000)
    const next = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + 1)
    return Math.max(1000, next - 8 * 60 * 60 * 1000 - now + 5000)
  }

  let balanceRolloverTimer = null
  function scheduleBalanceRollover() {
    if (balanceRolloverTimer) clearTimeout(balanceRolloverTimer)
    balanceRolloverTimer = setTimeout(async () => {
      try {
        liveAccountCacheAt = 0
        await fetchLiveAccount(snapshot(true))
      } catch (err) { /* best effort */ }
      scheduleBalanceRollover()
    }, msToNextBeijingMidnight(Date.now()))
    if (typeof balanceRolloverTimer.unref === 'function') balanceRolloverTimer.unref()
  }

  function accountClientMetadata() {
    return {
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
      locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  /** Sum recharge + bonus wallets with the same rules as dsh-whale-widget. */
  function walletTotal(result) {
    const num = (value) => {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    const curOf = (wallet) => String((wallet && wallet.currency) || 'CNY').toUpperCase()
    const pick = (list) => (Array.isArray(list) ? list.filter((w) => w && num(w.balance) !== null) : [])
    const recharge = pick(result.value)
    const bonus = pick(result.bonusWallets)
    const all = recharge.concat(bonus)
    if (!all.length) return null
    const nonZero = all.filter((w) => Number(w.balance) > 0)
    const curPick = nonZero.find((w) => curOf(w) === 'CNY') || nonZero[0]
      || all.find((w) => curOf(w) === 'CNY') || all[0]
    const currency = curOf(curPick)
    const sum = (list) => list
      .filter((w) => curOf(w) === currency && num(w.balance) !== null)
      .reduce((total, w) => total + Number(w.balance), 0)
    const rechargeTotal = sum(recharge)
    const bonusTotal = sum(bonus)
    return {
      balance: Number((rechargeTotal + bonusTotal).toFixed(6)),
      recharge: Number(rechargeTotal.toFixed(6)),
      bonus: Number(bonusTotal.toFixed(6)),
      currency,
    }
  }

  async function fetchLiveAccount(snapshotNow) {
    const now = Date.now()
    if (liveAccountCache && now - liveAccountCacheAt < LIVE_ACCOUNT_TTL_MS) return liveAccountCache
    liveAccountCacheAt = now
    let account = null
    try {
      account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
    } catch (err) {
      account = null
    }
    const fallback = (reason) => {
      // Never fall back to the stale whale balance after a successful live
      // read: keep showing the last real account value (marked stale).
      liveAccountCache = lastGoodLiveAccount
        ? { ...lastGoodLiveAccount, stale: true, reason }
        : { ok: false, reason }
      return liveAccountCache
    }
    if (!account || typeof account.getBalance !== 'function') {
      return fallback('no-account-service')
    }
    let result
    let timeout = null
    try {
      result = await Promise.race([
        account.getBalance(accountClientMetadata()),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 8000) }),
      ])
    } catch (err) {
      return fallback('account-request-failed')
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (!result) return fallback('account-timeout')
    if (result.status !== 'ready') return fallback('account-not-ready')
    const wallets = walletTotal(result)
    if (!wallets) return fallback('account-no-wallets')

    const day = beijingDay(now)
    if (!liveAccountState) liveAccountState = readAccountState()
    let state = liveAccountState
    if (!state || state.day !== day || !Number.isFinite(Number(state.openingBalance))) {
      // First observation of this Beijing day. If the whale ledger already
      // observed the same day, keep its opening balance so the figures agree.
      let opening = wallets.balance
      const prior = snapshotNow && snapshotNow.ok ? snapshotNow.today : null
      if (prior && prior.hasBalanceObservation && Number.isFinite(Number(prior.openingBalance))) {
        opening = Number(prior.openingBalance)
      }
      state = { day, openingBalance: opening, lastBalance: wallets.balance, lastAt: now }
    } else if (Number(state.lastBalance) !== wallets.balance) {
      // A top-up raises the baseline; it is not spending. A decrease raises
      // today's used amount against the unchanged opening baseline.
      if (wallets.balance > Number(state.lastBalance)) {
        state.openingBalance = Number(state.openingBalance) + (wallets.balance - Number(state.lastBalance))
      }
      state.lastBalance = wallets.balance
      state.lastAt = now
    } else {
      state.lastAt = now
    }
    liveAccountState = state
    writeAccountState(state)

    const todayUsed = Math.max(0, Number(state.openingBalance) - wallets.balance)
    liveAccountCache = {
      ok: true,
      balance: wallets.balance,
      recharge: wallets.recharge,
      bonus: wallets.bonus,
      currency: wallets.currency,
      todayUsed: Number(todayUsed.toFixed(6)),
      day,
      at: now,
      source: 'account',
    }
    lastGoodLiveAccount = liveAccountCache
    return liveAccountCache
  }

  /** Replace the stale ledger balance/today with the live account observation. */
  function mergeLiveSnapshot(snap, live) {
    if (!snap || !snap.ok || !live || !live.ok) return snap
    const ledgerToday = Math.max(0, Number(snap.today && snap.today.amount) || 0)
    const amount = Number(Math.max(ledgerToday, live.todayUsed || 0).toFixed(6))
    const today = {
      ...(snap.today || {}),
      amount,
      currentBalance: live.balance,
      source: 'account-live',
      label: '账号实时',
      trust: 'observed',
      partialDay: true,
      needsReview: false,
      hasBalanceObservation: true,
      lastObservedAt: live.at,
    }
    const recentDays = Array.isArray(snap.recentDays) ? snap.recentDays.slice() : []
    if (recentDays[0]) {
      recentDays[0] = {
        ...recentDays[0],
        amount,
        currentBalance: live.balance,
        source: 'account-live',
        label: '账号实时',
        trust: 'observed',
        partialDay: true,
        needsReview: false,
        hasBalanceObservation: true,
        lastObservedAt: live.at,
      }
    }
    const total7 = Number(((Number(snap.total7) || 0) - ledgerToday + amount).toFixed(6))
    return {
      ...snap,
      currency: live.currency || snap.currency,
      today,
      recentDays,
      total7,
      lastBalance: live.balance,
      liveAccount: {
        ok: true,
        balance: live.balance,
        recharge: live.recharge,
        bonus: live.bonus,
        currency: live.currency,
        todayUsed: live.todayUsed,
        at: live.at,
        stale: live.stale === true,
      },
    }
  }

  /** A ledger-free snapshot when only the live account is available. */
  function liveOnlySnapshot(live) {
    const day = live.day || beijingDay(live.at)
    const amount = Number(Math.max(0, live.todayUsed || 0).toFixed(6))
    const today = {
      day,
      amount,
      currency: live.currency,
      source: 'account-live',
      label: '账号实时',
      trust: 'observed',
      partialDay: true,
      needsReview: false,
      eventEstimate: 0,
      books: [],
      hasBalanceObservation: true,
      openingBalance: null,
      currentBalance: live.balance,
      observedDecrease: amount,
      observedIncrease: null,
      firstObservedAt: live.at,
      lastObservedAt: live.at,
      models: [],
      tokens: 0,
      modelTotal: 0,
    }
    return {
      ok: true,
      readOnly: true,
      owner: PLUGIN_ID,
      accountingVersion: null,
      generatedAt: Date.now(),
      token: 'live-account',
      file: null,
      currency: live.currency,
      today,
      recentDays: [today],
      total7: amount,
      lastEvent: { ts: 0, day: '', model: '', cost: 0 },
      lastBalance: live.balance,
      eventCount: 0,
      dayCount: 1,
      books: [],
      archive: { ok: false, reason: 'missing' },
      liveAccount: {
        ok: true,
        balance: live.balance,
        recharge: live.recharge,
        bonus: live.bonus,
        currency: live.currency,
        todayUsed: live.todayUsed,
        at: live.at,
        stale: live.stale === true,
      },
    }
  }

  scheduleBalanceRollover()

  // ---- Per-turn cost ------------------------------------------------------
  // Naiwa does not depend on dsh-whale-widget being mounted. It aggregates the
  // same assistant usage stream and prices it with the official CNY table, so
  // every completed turn can be reported in the whale-style account bubble.
  const TURN_PEAK_HOURS = [[9, 12], [14, 18]]
  const TURN_BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
  const TURN_PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
  function turnPriceFor(model) {
    const m = String(model || '').toLowerCase()
    if (m.indexOf('deepseek-v4-pro') !== -1) return TURN_PRO_PRICE
    return TURN_BASE_PRICE
  }
  function turnPeakOffset(timeSec) {
    const n = Number(timeSec)
    if (!isFinite(n)) return 0
    const bj = new Date(n * 1000 + 8 * 3600 * 1000)
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return 0
    const hour = bj.getUTCHours()
    for (const span of TURN_PEAK_HOURS) {
      if (hour >= span[0] && hour < span[1]) return 1
    }
    return 0
  }
  const turnAggs = new Map()
  const subagentSessions = new Set()
  function rememberSubagent(info) {
    try {
      const id = info && info.id ? String(info.id) : ''
      if (!id) return
      if (subagentSessions.size > 500) subagentSessions.clear()
      subagentSessions.add(id)
    } catch (err) { /* ignore */ }
  }
  const turnStatePath = () => path.join(dshHome(), '.dsh-naiwa-turn.json')
  function readTurnSeq() {
    try {
      const parsed = JSON.parse(fs.readFileSync(turnStatePath(), 'utf8'))
      return parsed && Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : 0
    } catch (err) { return 0 }
  }
  let lastTurn = { seq: readTurnSeq(), turn: null, amount: null, tokens: null, ts: null }
  function writeTurnSeq(seq) {
    try {
      fs.mkdirSync(path.dirname(turnStatePath()), { recursive: true })
      fs.writeFileSync(turnStatePath(), JSON.stringify({ seq, updatedAt: new Date().toISOString() }), 'utf8')
    } catch (err) { /* sequence persistence is best effort */ }
  }
  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    turnAggs.delete(sessionId)
    // Subagent completions should not pop the pet over the user's main chat.
    if (subagentSessions.has(String(sessionId || ''))) return
    if (!agg || !(agg.cost > 0)) return
    lastTurn = {
      seq: lastTurn.seq + 1,
      turn: agg.turn,
      amount: Number(agg.cost.toFixed(6)),
      tokens: agg.tokens,
      ts: agg.lastTs,
    }
    writeTurnSeq(lastTurn.seq)
  }
  function handleTurnEvent(session, event) {
    try {
      const sid = session && session.id ? session.id : 'default'
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      if (type === 'turn/end') {
        finalizeTurn(sid)
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
      let agg = turnAggs.get(sid)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sid)
        agg = { turn, cost: 0, tokens: 0, lastTs: Date.now() }
        turnAggs.set(sid, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const model = d.message && d.message.source ? d.message.source.model : ''
      const price = turnPriceFor(model)
      const off = turnPeakOffset(Math.floor(Date.now() / 1000))
      agg.cost += (cache / 1e6) * price.hit[off] +
        (input / 1e6) * price.miss[off] +
        (output / 1e6) * price.out[off]
      agg.tokens += input + cache + output
      agg.lastTs = Date.now()
    } catch (err) { /* a malformed event must never break the pet */ }
  }

  // ---- Routes -------------------------------------------------------------
  const disposers = []
  for (const name of ['subagent/start', 'subagent/end']) {
    try {
      const dispose = ctx.on(name, (info) => rememberSubagent(info))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (err) { /* event unavailable on older hosts */ }
  }
  try {
    const dispose = ctx.on('session/event', (session, event) => handleTurnEvent(session, event))
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (err) {
    log('[dsh-naiwa] session/event unavailable:', String((err && err.message) || err))
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/config.json`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === undefined) {
          sendJson(res, 200, { ok: true, config: currentConfig, storage: storageHandle ? 'storage' : 'file' })
          return
        }
        if (req.method !== 'PUT' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        let parsed
        try {
          const body = await readBody(req)
          parsed = JSON.parse(body || '{}')
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          return
        }
        const next = normalizeConfig(parsed && parsed.config ? parsed.config : parsed)
        if (!writeConfigFile(next)) {
          sendJson(res, 500, { ok: false, error: 'config-write-failed' })
          return
        }
        currentConfig = next
        sendJson(res, 200, { ok: true, config: currentConfig })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/ledger.json`,
      handler: async (req, res) => {
        let snap
        try {
          snap = snapshot(true)
        } catch (err) {
          sendJson(res, 200, { ok: false, reason: 'error', error: String((err && err.message) || err) })
          return
        }
        try {
          const live = await fetchLiveAccount(snap)
          if (snap && snap.ok) snap = mergeLiveSnapshot(snap, live)
          else if (live && live.ok) snap = liveOnlySnapshot(live)
        } catch (err) {
          log('[dsh-naiwa] live balance merge failed:', String((err && err.message) || err))
        }
        sendJson(res, 200, snap)
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/turn.json`,
      handler: (req, res) => {
        sendJson(res, 200, {
          ok: true,
          seq: lastTurn.seq,
          turn: lastTurn.turn,
          amount: lastTurn.amount,
          tokens: lastTurn.tokens,
          ts: lastTurn.ts,
        })
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/api/state.json`,
      handler: async (req, res) => {
        sendJson(res, 200, {
          ok: true,
          plugin: PLUGIN_ID,
          version: '0.1.0',
          config: currentConfig,
          ledgerAvailable: (() => {
            try { return snapshot().ok === true } catch (err) { return false }
          })(),
          storage: storageHandle ? 'storage' : 'file',
        })
      },
    },
    {
      kind: 'prefix',
      path: `${ROUTE_PREFIX}/assets`,
      handler: async (req, res) => {
        let pathname
        try {
          pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: 'bad-url' })
          return
        }
        const relative = pathname.slice(`${ROUTE_PREFIX}/assets`.length).replace(/^\/+/, '')
        const parts = relative.split('/')
        if (parts.length !== 2) {
          sendJson(res, 404, { ok: false, error: 'not-found' })
          return
        }
        const [folder, name] = parts
        let file = null
        if (folder === 'frames' && FRAME_RE.test(name)) file = assetPath('frames', name)
        else if (folder === 'eyes' && EYE_RE.test(name)) file = assetPath('eyes', name)
        else if (folder === 'audio' && SOUND_RE.test(name)) file = assetPath('audio', name)
        else if (folder === 'meta' && MANIFEST_RE.test(name)) file = assetPath(name)
        if (!file) {
          sendJson(res, 404, { ok: false, error: 'not-found' })
          return
        }
        // Defence in depth: the regexes above already forbid separators, but
        // confirm the resolved path stays inside assets/.
        const resolved = path.resolve(file)
        if (!resolved.startsWith(path.resolve(PACKAGE_ROOT, 'assets') + path.sep)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        serveFile(res, resolved, { 'Cache-Control': 'public, max-age=86400' })
      },
    },
  ]

  // Fail loudly and specifically if the service is missing, instead of dying
  // with an opaque cordis proxy error that leaves every route unregistered.
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') {
    log('[dsh-naiwa] FATAL: webServer service unavailable — no route registered, the pet cannot load')
    return
  }

  let registered = 0
  for (const route of routes) {
    try {
      disposers.push(server.register(route))
      registered += 1
    } catch (err) {
      log(`[dsh-naiwa] route ${route.path} failed:`, String((err && err.message) || err))
    }
  }

  // ---- Accounting poll ----------------------------------------------------
  // A Host-side timer keeps the fingerprint fresh even when no browser polls;
  // it only READS the ledger, so it can never race the whale's writer.
  const pollMs = Math.max(5000, Number(currentConfig.accounting && currentConfig.accounting.pollSec) * 1000 || 20000)
  const timer = setInterval(() => {
    try { checkAccounting() } catch (err) { /* handled inside */ }
  }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.effect(() => () => {
    clearInterval(timer)
    if (balanceRolloverTimer) clearTimeout(balanceRolloverTimer)
    for (const dispose of disposers) {
      try { dispose() } catch (err) { /* already gone */ }
    }
  }, 'dsh-naiwa: routes and poll timer')

  log(`[dsh-naiwa] ready: ${registered}/${routes.length} routes under ${ROUTE_PREFIX}, ledger poll ${pollMs}ms`)
}
