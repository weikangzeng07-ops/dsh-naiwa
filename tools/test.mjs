/**
 * Unit tests for the pure parts of dsh-naiwa.
 *
 * Deliberately dependency-free (node:assert + node:test) so it runs anywhere
 * the plugin runs. It covers the pieces that can be wrong without a browser:
 * tier snapping, burst composition, the spring solver, config normalisation,
 * the ledger adapter and the capsule contact math.
 *
 * Run: node --test tools/test.mjs   (or: npm test)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// --- load the browser sources into a sandbox -------------------------------
// The numbered sources are plain scripts with no imports; concatenating them
// and evaluating in a Function scope mirrors what lib/client.js does, without
// needing a DOM.
const srcDir = path.join(ROOT, 'src')
const srcFiles = fs
  .readdirSync(srcDir)
  .filter((n) => /^\d+-[a-z0-9-]+\.js$/.test(n))
  .sort()

const PURE_SOURCES = srcFiles.filter(
  (n) => n.startsWith('00-') || n.startsWith('05-') || n.startsWith('10-') || n.startsWith('20-'),
)

function loadPure() {
  const code = PURE_SOURCES.map((n) => fs.readFileSync(path.join(srcDir, n), 'utf8')).join('\n')
  // Only the constants/helpers we test; no DOM is touched by these modules.
  return new Function(`${code}; return {
    TIERS, snapScale, tierOf, burstScales, clamp, smoothstep, frameFile,
    CLIP_FRAMES, LOOP_START, BODY_PAD, BASE_W, BASE_H, ALPHA_CUTOFF,
    PHYS_STEP, MOTION_RATE, MAX_CATCHUP, PHYS_DAMPING,
    springPeak, solveReleaseVelocity, anchoredPose, alphaBBox,
    Capsule, PhysicsWorld, capsuleShape, launchVelocity, capsulesOverlap,
    normalizeClientConfig, defaultClientConfig,
    defaultAccountBubble, normalizeAccountBubble,
    loadAccountBubblePrefs, saveAccountBubblePrefs, ACCOUNT_PREFS_KEY,
    AUDIO_LOOP_START, AUDIO_LOOP_END, AUDIO_LATENCY_MS, CLIP_DURATION_SEC,
    AUDIO_START_GRACE_SEC, LAUGH_URL,
  }`)()
}

const M = loadPure()

// ---------------------------------------------------------------------------
// tiers
// ---------------------------------------------------------------------------

test('snapScale picks the nearest tier and breaks ties toward the larger one', () => {
  assert.equal(M.snapScale(0.8), 0.8)
  assert.equal(M.snapScale(0.5), 0.5)
  // 0.65 is equidistant from 0.6 and 0.7 -> larger wins
  assert.equal(M.snapScale(0.65), 0.7)
  // the manifest's own globalScale collapses to the smallest tier
  assert.equal(M.snapScale(0.209111), 0.5)
  // out of range clamps by distance
  assert.equal(M.snapScale(1.2), 0.8)
  assert.equal(M.snapScale(0.1), 0.5)
})

test('tierOf is 1-based and matches the reference order', () => {
  assert.equal(M.tierOf(0.8), 1)
  assert.equal(M.tierOf(0.7), 2)
  assert.equal(M.tierOf(0.6), 3)
  assert.equal(M.tierOf(0.5), 4)
})

test('burstScales matches the reference tier table', () => {
  for (let i = 0; i < 200; i += 1) {
    const t1 = M.burstScales(0.8)
    assert.ok(t1.length >= 2 && t1.length <= 4, `tier1 count ${t1.length}`)
    for (const s of t1) assert.ok(s < 0.8, 'tier1 clones must be smaller')

    const t2 = M.burstScales(0.7)
    assert.ok(t2.length >= 2 && t2.length <= 3)
    for (const s of t2) assert.ok(s < 0.7)

    const t3 = M.burstScales(0.6)
    assert.equal(t3.length, 2)
    for (const s of t3) assert.equal(s, 0.5)

    assert.deepEqual(M.burstScales(0.5), [], 'tier4 never splits')
  }
})

test('frameFile zero-pads to four digits', () => {
  assert.equal(M.frameFile(0), 'f0001.webp')
  assert.equal(M.frameFile(431), 'f0432.webp')
  assert.equal(M.frameFile(53), 'f0054.webp')
})

test('loop segment constants match the reference audio window', () => {
  // 53 frames at 30 fps -> 1.7666… s ; 432 frames -> 14.4 s
  assert.ok(Math.abs(M.AUDIO_LOOP_START - 1.7666666667) < 1e-6, String(M.AUDIO_LOOP_START))
  assert.ok(Math.abs(M.AUDIO_LOOP_END - 14.4) < 1e-9, String(M.AUDIO_LOOP_END))
  assert.equal(M.CLIP_FRAMES - M.LOOP_START, 379)
})

test('the laugh track is authored-length and audio-clocked', () => {
  // The user's 10.21 s MP3 is an excerpt (lead-in + tail trimmed). Stretching
  // it to 14.4 s made the ends meet but left the laughs at the wrong frames;
  // the shipped file must instead have the authored 14.4196 s duration so
  // playbackRate stays 1.0.
  assert.ok(M.LAUGH_URL.includes('/audio/laugh-synced.wav'), M.LAUGH_URL)
  assert.ok(Math.abs(M.CLIP_DURATION_SEC - 14.4) < 1e-9, String(M.CLIP_DURATION_SEC))
  assert.ok(M.AUDIO_LATENCY_MS >= 0 && M.AUDIO_LATENCY_MS <= 120, String(M.AUDIO_LATENCY_MS))
  assert.ok(M.AUDIO_START_GRACE_SEC > 0 && M.AUDIO_START_GRACE_SEC < 1, String(M.AUDIO_START_GRACE_SEC))

  const file = path.join(ROOT, 'assets', 'audio', 'laugh-synced.wav')
  assert.ok(fs.existsSync(file), 'missing assets/audio/laugh-synced.wav')
  const info = readWavInfo(file)
  assert.equal(info.channels, 2)
  assert.equal(info.sampleRate, 48000)
  assert.equal(info.bits, 16)
  assert.ok(
    Math.abs(info.duration - 14.4196041667) < 0.01,
    `expected 14.4196 s of audio, got ${info.duration.toFixed(4)} s`,
  )
  assert.ok(Math.abs(info.duration - M.CLIP_DURATION_SEC) < 0.03, 'track must span the 432-frame clip')

  // The first 1.5 s must be the authored lead-in: the animation winds up before
  // the first laugh sample, and starting the old MP3 there was the visible bug.
  const buf = fs.readFileSync(file)
  const muteSamples = Math.round(1.5 * info.sampleRate) * info.channels
  let peak = 0
  for (let i = 0; i < muteSamples; i += 1) {
    peak = Math.max(peak, Math.abs(buf.readInt16LE(info.dataOffset + i * 2)))
  }
  assert.equal(peak, 0, 'lead-in must be digital silence')
  // …and there must be real audio after it.
  let after = 0
  for (let i = muteSamples; i < muteSamples + info.sampleRate * info.channels; i += 1) {
    after = Math.max(after, Math.abs(buf.readInt16LE(info.dataOffset + i * 2)))
  }
  assert.ok(after > 1000, 'the laugh must start after the lead-in')
})

/** Minimal PCM WAV chunk reader (the shipped track is canonical 16-bit PCM). */
function readWavInfo(file) {
  const buf = fs.readFileSync(file)
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', 'not a RIFF file')
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE', 'not a WAVE file')
  let off = 12
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOffset = 0
  let dataBytes = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      dataOffset = off + 8
      dataBytes = size
    }
    off += 8 + size + (size & 1)
  }
  assert.ok(channels && sampleRate && bits && dataBytes, 'incomplete WAV header')
  return {
    channels,
    sampleRate,
    bits,
    dataOffset,
    dataBytes,
    duration: dataBytes / (sampleRate * channels * (bits / 8)),
  }
}

// ---------------------------------------------------------------------------
// spring solver
// ---------------------------------------------------------------------------

test('springPeak is monotonic in the initial velocity', () => {
  // A unit initial velocity produces a small peak; the peak must grow with the
  // velocity, which is what makes the bisection in solveReleaseVelocity valid.
  const small = M.springPeak(0, 1, 8, 24)
  const large = M.springPeak(0, 50, 8, 24)
  assert.ok(small > 0 && small < 0.1, String(small))
  assert.ok(large > small, `${large} !> ${small}`)
  // With zero velocity the displacement IS the peak (t = 0 is the maximum), so
  // the function is the identity there. That is why release() calibrates a
  // VELOCITY from a target rather than scaling q directly.
  assert.ok(Math.abs(M.springPeak(1, 0, 8, 24) - 1) < 1e-9)
  assert.ok(Math.abs(M.springPeak(0.5, 0, 8, 24) - 0.5) < 1e-9)
})

test('solveReleaseVelocity hits the requested peak', () => {
  for (const target of [0.5, 1, 2]) {
    const v = M.solveReleaseVelocity(0, target, 8, 24, 100)
    const peak = M.springPeak(0, v, 8, 24)
    assert.ok(Math.abs(peak - target) < 1e-3, `target ${target} -> ${peak}`)
  }
})

test('anchoredPose preserves volume (sx^2 * sy == 1) and pins the target', () => {
  for (const sy of [1, 1.08, 0.9]) {
    const p = M.anchoredPose(sy, 10, 20, 100, 200)
    assert.ok(Math.abs(p.sx * p.sx * p.sy - 1) < 1e-9)
    // the source point must land exactly on the target point
    assert.ok(Math.abs(p.sx * 10 + p.tx - 100) < 1e-9)
    assert.ok(Math.abs(p.sy * 20 + p.ty - 200) < 1e-9)
  }
})

// ---------------------------------------------------------------------------
// physics
// ---------------------------------------------------------------------------

test('capsuleShape matches the reference formulas', () => {
  // tier 0.6 idle bbox measured from the real frame: 78 x 168
  const shape = M.capsuleShape({ x0: 57, y0: 10, x1: 135, y1: 178 })
  assert.equal(shape.radius, Math.min(78 * 0.55, 168 / 2))
  assert.equal(shape.halfLine, Math.max(0, 168 / 2 - shape.radius))
  assert.ok(Math.abs(shape.mass - (78 * 168) / 10000) < 1e-9)
})

test('gravity and terminal speed scale with container height', () => {
  const world = new M.PhysicsWorld()
  world.setBounds({ left: 0, top: 0, right: 800, bottom: 1080 })
  assert.equal(world.gravity(), 1800)
  assert.equal(world.terminalSpeed(), 1800)

  world.setBounds({ left: 0, top: 0, right: 800, bottom: 540 })
  assert.equal(world.gravity(), 900)
})

test('a dynamic body falls and settles on the floor', () => {
  const world = new M.PhysicsWorld()
  world.setBounds({ left: 0, top: 0, right: 800, bottom: 600 })
  const body = new M.Capsule({
    id: 'a', x: 400, y: 100, radius: 20, halfLine: 30, mass: 1, dynamic: true,
  })
  world.add(body)
  // ~2 simulated seconds
  for (let i = 0; i < 400; i += 1) world.advance(1 / 60)
  const floor = world.bounds.bottom
  const restY = body.y + body.halfLine + body.radius
  assert.ok(restY <= floor + 1, `body rested at ${restY}, floor ${floor}`)
  assert.ok(body.y > 100, 'body must have fallen')
})

test('a body never tunnels through the floor', () => {
  const world = new M.PhysicsWorld()
  world.setBounds({ left: 0, top: 0, right: 800, bottom: 600 })
  const body = new M.Capsule({
    id: 'fast', x: 400, y: 50, radius: 10, halfLine: 10, mass: 1, dynamic: true,
  })
  body.vy = 5000 // far beyond terminal speed on purpose
  world.add(body)
  for (let i = 0; i < 300; i += 1) world.advance(1 / 60)
  assert.ok(body.y < 700, 'body escaped the world')
})

test('two capsules separate instead of overlapping forever', () => {
  const world = new M.PhysicsWorld()
  world.setBounds({ left: 0, top: 0, right: 800, bottom: 600 })
  const a = new M.Capsule({ id: 'a', x: 400, y: 500, radius: 20, halfLine: 20, mass: 1, dynamic: true })
  const b = new M.Capsule({ id: 'b', x: 400, y: 500, radius: 20, halfLine: 20, mass: 1, dynamic: true })
  world.add(a)
  world.add(b)
  for (let i = 0; i < 300; i += 1) world.advance(1 / 60)
  const gap = Math.hypot(a.x - b.x, a.y - b.y)
  assert.ok(gap > 1, `capsules still coincide (gap ${gap})`)
})

test('a source id stops blocking once the pair no longer overlaps', () => {
  const world = new M.PhysicsWorld()
  world.setBounds({ left: 0, top: 0, right: 800, bottom: 600 })
  const parent = new M.Capsule({ id: 'p', x: 100, y: 500, radius: 20, halfLine: 20, mass: 1, dynamic: false })
  const child = new M.Capsule({
    id: 'c', x: 100, y: 500, radius: 20, halfLine: 20, mass: 1, dynamic: true, sourceId: 'p',
  })
  world.add(parent)
  world.add(child)
  assert.equal(child.sourceId, 'p')
  child.x = 600 // move far away, then step once
  world.advance(1 / 60)
  assert.equal(child.sourceId, null, 'source exemption must be released')
})

test('launchVelocity always goes up and sideways within the reference envelope', () => {
  for (let i = 0; i < 200; i += 1) {
    const v = M.launchVelocity(1080, 1)
    assert.ok(v.vy < 0, 'must launch upward (negative y)')
    const speed = Math.hypot(v.vx, v.vy)
    assert.ok(speed >= 899 && speed <= 1251, `speed ${speed}`)
    assert.ok(v.vx > 0, 'direction 1 must go right')
    const angle = (Math.atan2(-v.vy, Math.abs(v.vx)) * 180) / Math.PI
    assert.ok(angle >= 59.9 && angle <= 80.1, `angle ${angle}`)
  }
  const left = M.launchVelocity(1080, -1)
  assert.ok(left.vx < 0, 'direction -1 must go left')
})

test('capsulesOverlap agrees with the geometry', () => {
  const a = { x: 0, y: 0, halfLine: 10, radius: 5 }
  const b = { x: 0, y: 5, halfLine: 10, radius: 5 } // vertical overlap -> touching
  assert.ok(M.capsulesOverlap(a, b))
  const far = { x: 100, y: 0, halfLine: 10, radius: 5 }
  assert.ok(!M.capsulesOverlap(a, far))
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test('normalizeClientConfig repairs broken input', () => {
  const c = M.normalizeClientConfig({ pet: { scale: 'nonsense', maxPets: 9999, volume: 5 } })
  assert.equal(c.pet.scale, 0.6, 'bad scale falls back')
  assert.equal(c.pet.maxPets, 40, 'maxPets clamps to 40')
  assert.equal(c.pet.volume, 1, 'volume clamps to 1')

  const empty = M.normalizeClientConfig(null)
  assert.equal(empty.enabled, true)
  assert.equal(empty.pet.visible, true)
  assert.ok(Array.isArray(empty.bubble.lines.idle))
})

test('normalizeClientConfig keeps every bubble line key', () => {
  const base = M.defaultClientConfig()
  const c = M.normalizeClientConfig({ bubble: { lines: { click: ['x'] } } })
  for (const key of Object.keys(base.bubble.lines)) {
    assert.ok(Array.isArray(c.bubble.lines[key]), `missing line set: ${key}`)
  }
  assert.deepEqual(c.bubble.lines.click, ['x'])
})

test('normalizeClientConfig rejects an unknown start position', () => {
  const c = M.normalizeClientConfig({ pet: { startPosition: 'middle-of-nowhere' } })
  assert.equal(c.pet.startPosition, 'bottom-right')
})

test('account bubble prefs are trimmed, clamped and defaulted', () => {
  const c = M.normalizeClientConfig({
    bubble: {
      account: {
        title: '  小鲸鱼余额  ',
        todayLabel: '  今日  ',
        balanceLabel: '  总额  ',
        showTitle: false,
        showToday: false,
        showBalance: true,
        order: 'balance-first',
      },
    },
  })
  assert.equal(c.bubble.account.title, '小鲸鱼余额')
  assert.equal(c.bubble.account.todayLabel, '今日')
  assert.equal(c.bubble.account.balanceLabel, '总额')
  assert.equal(c.bubble.account.showTitle, false)
  assert.equal(c.bubble.account.showToday, false)
  assert.equal(c.bubble.account.showBalance, true)
  assert.equal(c.bubble.account.order, 'balance-first')

  const bad = M.normalizeClientConfig({
    bubble: { account: { title: 42, todayLabel: '', order: 'sideways', showTitle: 'yes' } },
  })
  assert.equal(bad.bubble.account.title, '奶蛙记账')
  assert.equal(bad.bubble.account.todayLabel, '今日已用')
  assert.equal(bad.bubble.account.order, 'today-first')
  assert.equal(bad.bubble.account.showTitle, true)
  assert.equal(M.defaultAccountBubble().balanceLabel, '全部余额')
  assert.equal(M.defaultAccountBubble().showTitle, true)
})

test('v1 account prefs migrate to a visible title, then v2 can hide it', () => {
  const store = new Map()
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
  }
  try {
    store.set(M.ACCOUNT_PREFS_KEY, JSON.stringify({ title: '旧标题', showTitle: false }))
    const migrated = M.loadAccountBubblePrefs(M.defaultClientConfig())
    assert.equal(migrated.showTitle, true)
    assert.equal(migrated.title, '旧标题')

    assert.equal(M.saveAccountBubblePrefs({ ...migrated, showTitle: false }), true)
    const saved = M.loadAccountBubblePrefs(M.defaultClientConfig())
    assert.equal(saved.showTitle, false)
  } finally {
    delete globalThis.window
  }
})

// ---------------------------------------------------------------------------
// assets present on disk
// ---------------------------------------------------------------------------

test('the plugin ships every asset the client requests', () => {
  const frames = path.join(ROOT, 'assets', 'frames')
  const files = fs.readdirSync(frames).filter((n) => n.endsWith('.webp'))
  assert.equal(files.length, 432, `expected 432 frames, found ${files.length}`)
  assert.ok(files.includes('f0001.webp'))
  assert.ok(files.includes('f0432.webp'))

  for (const rel of ['assets/eyes/backing.png', 'assets/eyes/pupil.png', 'assets/audio/laugh.mp3', 'assets/audio/laugh-synced.wav', 'assets/audio/click.wav', 'assets/eyes/geometry.json']) {
    const p = path.join(ROOT, rel)
    assert.ok(fs.existsSync(p), `missing asset: ${rel}`)
    assert.ok(fs.statSync(p).size > 0, `empty asset: ${rel}`)
  }
})

test('the generated client is in sync with src/', () => {
  const out = path.join(ROOT, 'lib', 'client.js')
  assert.ok(fs.existsSync(out), 'lib/client.js is missing — run node tools/build.mjs')
  const text = fs.readFileSync(out, 'utf8')
  assert.ok(text.includes("id: 'dsh-naiwa'"), 'client must register under the plugin id')
  assert.ok(text.includes('window.__ModuleLoader__.load'), 'client must use the module loader')
  // every source file must be represented
  for (const name of srcFiles) {
    assert.ok(text.includes(`src/${name}`), `lib/client.js is stale: ${name} missing — rebuild`)
  }
})

test('the host half declares the webServer inject', () => {
  const text = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.ok(
    /export const inject\s*=\s*\[[^\]]*'webServer'/.test(text),
    'lib/index.js must export inject: ["webServer"] — without it cordis throws on ctx.webServer and no route is registered',
  )
})
