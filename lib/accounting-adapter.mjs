/**
 * Accounting adapter for dsh-naiwa.
 *
 * This is the ONLY place dsh-naiwa touches accounting. It:
 *   1. reads the ledger owned by `dsh-whale-widget` (read-only, never writes),
 *   2. computes summaries with the vendored MIT kernel (byte-identical numbers),
 *   3. exposes a small, stable view model to the pet UI,
 *   4. detects "a new turn was recorded" so the pet can react truthfully.
 *
 * It deliberately does NOT write a second ledger. The whale plugin remains the
 * history writer and pricer; when it is not mounted, `lib/index.js` overlays the
 * DSH account service's live balance and its own daily balance observations so
 * the bubble still shows the real account instead of a frozen ledger value.
 *
 * Call chain:
 *   ledger file (written by dsh-whale-widget)
 *     -> readLedger()                     (lib/ledger.mjs)
 *     -> daySummary / balanceSummary      (vendored lib/accounting.mjs, MIT)
 *     -> snapshot()                       (this module)
 *     -> GET /dsh-naiwa/api/ledger.json   (lib/index.js route)
 *     -> pet bubble / ledger panel        (lib/client.js)
 */
import {
  beijingDay,
  dayOffset,
  daySummary,
  balanceSummary,
  accountingDays,
  bookBreakdown,
  preciseMoney,
  sumMoney,
} from './accounting.mjs'
import { readLedger, readArchive, ledgerToken } from './ledger.mjs'

/** Source labels the upstream kernel can produce; mapped to Chinese UI text. */
const SOURCE_LABELS = {
  'balance-observed': '已观测消费',
  'balance-corrected': '已校正消费',
  'balance-needs-review': '已观测消费 · 待核对',
  'balance-observed-other-account': '历史账户',
  legacy: '旧版记录 · 未校正',
  events: '本地估算',
}

/** How much each source should be trusted for a "this is real money" statement. */
const SOURCE_TRUST = {
  'balance-observed': 'observed',
  'balance-corrected': 'observed',
  'balance-needs-review': 'observed-needs-review',
  'balance-observed-other-account': 'observed-other-account',
  legacy: 'legacy',
  events: 'estimate',
}

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function dayView(ledger, day) {
  const summary = daySummary(ledger, day)
  const balance = balanceSummary(ledger, day)
  const source = String(summary.source || 'events')
  return {
    day,
    amount: preciseMoney(finite(summary.amount)),
    currency: String(summary.currency || 'CNY'),
    source,
    label: SOURCE_LABELS[source] || String(summary.label || '未知来源'),
    trust: SOURCE_TRUST[source] || 'unknown',
    partialDay: summary.partialDay === true,
    needsReview: summary.needsReview === true,
    eventEstimate: preciseMoney(finite(summary.eventEstimate)),
    books: (Array.isArray(summary.bookBreakdown) ? summary.bookBreakdown : []).map((b) => ({
      scope: String(b.scope || ''),
      currency: String(b.currency || 'CNY'),
      active: b.active === true,
      amount: preciseMoney(finite(b.amount)),
    })),
    hasBalanceObservation: balance !== null,
    openingBalance: balance ? preciseMoney(finite(balance.openingBalance)) : null,
    currentBalance: balance ? preciseMoney(finite(balance.currentBalance)) : null,
    observedDecrease: balance ? preciseMoney(finite(balance.observedDecrease)) : null,
    observedIncrease: balance ? preciseMoney(finite(balance.observedIncrease)) : null,
    firstObservedAt: balance && Number.isFinite(Number(balance.firstObservedAt)) ? Number(balance.firstObservedAt) : null,
    lastObservedAt: balance && Number.isFinite(Number(balance.lastObservedAt)) ? Number(balance.lastObservedAt) : null,
  }
}

function modelsFor(events, day) {
  const map = new Map()
  for (const event of events) {
    if (!event || event.day !== day) continue
    const model = String(event.model || '未知')
    map.set(model, (map.get(model) || 0) + finite(event.cost))
  }
  return Array.from(map, ([model, cost]) => ({
    model,
    cost: preciseMoney(cost),
    tokens: 0,
  })).sort((a, b) => b.cost - a.cost)
}

function tokensFor(events, day) {
  let tokens = 0
  for (const event of events) {
    if (!event || event.day !== day) continue
    tokens += finite(event.tokens)
  }
  return Math.round(tokens)
}

/**
 * Build the complete, client-facing accounting view.
 *
 * @returns {object} a JSON-safe snapshot; `ok: false` with a `reason` when the
 *   whale ledger is absent or unreadable (the pet then stays silent instead of
 *   inventing numbers).
 */
export function buildAccountingSnapshot(options = {}) {
  const days = Math.max(1, Math.min(60, Number(options.days) || 7))
  const read = readLedger()
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reason,
      error: read.error || null,
      file: read.file || null,
      token: ledgerToken(read),
      readOnly: true,
      generatedAt: Date.now(),
      owner: 'dsh-whale-widget',
    }
  }
  const ledger = read.ledger
  const accountingVersion = ledger.accounting && Number(ledger.accounting.version)
  const today = beijingDay()
  const events = Array.isArray(ledger.events) ? ledger.events : []
  const knownDays = new Set([today])
  for (const day of Object.keys(ledger.history || {})) knownDays.add(day)
  for (const day of accountingDays(ledger)) knownDays.add(day)
  for (const event of events) if (/^\d{4}-\d{2}-\d{2}$/.test(String(event && event.day))) knownDays.add(event.day)

  const recentDays = []
  for (let i = 0; i < days; i += 1) recentDays.push(dayView(ledger, dayOffset(today, -i)))

  const todayView = recentDays[0]
  const todayModels = modelsFor(events, today)
  const lastEvent = events.reduce((acc, event) => {
    const ts = finite(event && event.ts)
    return ts > acc.ts ? { ts, day: String(event.day || ''), model: String(event.model || '未知'), cost: preciseMoney(finite(event.cost)) } : acc
  }, { ts: 0, day: '', model: '', cost: 0 })

  let total7 = 0
  try {
    total7 = sumMoney(recentDays.map((d) => d.amount))
  } catch (err) {
    total7 = preciseMoney(recentDays.reduce((acc, d) => acc + d.amount, 0))
  }

  const archive = readArchive()

  return {
    ok: true,
    readOnly: true,
    owner: 'dsh-whale-widget',
    accountingVersion: Number.isFinite(accountingVersion) ? accountingVersion : null,
    generatedAt: Date.now(),
    token: ledgerToken(read),
    file: read.file,
    currency: todayView.currency,
    today: {
      ...todayView,
      models: todayModels,
      tokens: tokensFor(events, today),
      modelTotal: preciseMoney(todayModels.reduce((acc, m) => acc + m.cost, 0)),
    },
    recentDays,
    total7: preciseMoney(total7),
    lastEvent,
    lastBalance: ledger.lastBalance == null ? null : preciseMoney(finite(ledger.lastBalance)),
    eventCount: events.length,
    dayCount: knownDays.size,
    books: bookBreakdown(ledger, today).map((b) => ({
      scope: String(b.scope || ''),
      currency: String(b.currency || 'CNY'),
      active: b.active === true,
      amount: preciseMoney(finite(b.amount)),
    })),
    archive: archive.ok
      ? { ok: true, events: Array.isArray(archive.archive.events) ? archive.archive.events.length : 0 }
      : { ok: false, reason: archive.reason },
  }
}

/**
 * A stable fingerprint of "what the pet should react to".
 *
 * The pet must never announce a spend that did not really get recorded, so this
 * only changes when the ledger itself gains a new event or a new balance
 * observation — never on a plain re-read.
 */
export function accountingFingerprint(snapshot) {
  if (!snapshot || !snapshot.ok) return `unavailable:${snapshot ? snapshot.reason : 'unknown'}`
  const today = snapshot.today
  return [
    snapshot.token,
    snapshot.eventCount,
    snapshot.lastEvent.ts,
    today.amount,
    today.source,
    today.hasBalanceObservation ? today.lastObservedAt : 'none',
  ].join('|')
}
