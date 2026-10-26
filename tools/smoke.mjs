/**
 * End-to-end smoke check against a running DSH host.
 *
 * Verifies the four things that actually decide whether the pet can render:
 *   1. the Host registered its routes (not 404 / not the SPA fallback),
 *   2. the config endpoint returns valid JSON,
 *   3. the first animation frame is served as a real image,
 *   4. the ledger endpoint answers (ok:true, or a well-formed ok:false).
 *
 * Run: node tools/smoke.mjs [baseUrl]
 * Default baseUrl: http://127.0.0.1:3080
 *
 * The Host's browser trust fence may answer 401 to an unauthenticated client;
 * that is reported as "fence" rather than "broken", because it proves the route
 * exists (the fallback would be 404).
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const PREFIX = '/dsh-naiwa'

let failures = 0
let checks = 0

function ok(label, detail) {
  checks += 1
  console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`)
}

function fail(label, detail) {
  checks += 1
  failures += 1
  console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`)
}

async function probe(path) {
  const url = BASE + path
  try {
    const res = await fetch(url, { redirect: 'manual' })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type') || '', bytes: buf, url }
  } catch (err) {
    return { status: 0, type: '', bytes: Buffer.alloc(0), url, error: String(err && err.message) }
  }
}

function isHtmlFallback(probeResult) {
  return /text\/html/i.test(probeResult.type) && /<!doctype html|<html/i.test(probeResult.bytes.toString('utf8', 0, 200))
}

async function checkRoute(label, path, expected) {
  const r = await probe(path)
  if (r.status === 0) {
    fail(label, `no response: ${r.error}`)
    return r
  }
  if (r.status === 401 || r.status === 403) {
    ok(label, `${r.status} trust fence — route exists`)
    return r
  }
  if (r.status !== 200) {
    fail(label, `HTTP ${r.status}`)
    return r
  }
  if (isHtmlFallback(r)) {
    fail(label, 'served the SPA fallback instead of the plugin route')
    return r
  }
  if (expected) expected(r)
  else ok(label, `${r.status} ${r.type} ${r.bytes.length}B`)
  return r
}

function magic(bytes, sig) {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)
}

console.log(`dsh-naiwa smoke test against ${BASE}\n`)

console.log('1) config endpoint')
let configBody = null
await checkRoute('GET /api/config.json', `${PREFIX}/api/config.json`, (r) => {
  let parsed = null
  try {
    parsed = JSON.parse(r.bytes.toString('utf8'))
  } catch (err) {
    fail('config is valid JSON', 'parse error')
    return
  }
  configBody = parsed
  if (!parsed || parsed.ok !== true || !parsed.config) {
    fail('config payload shape', JSON.stringify(parsed).slice(0, 120))
    return
  }
  const pet = parsed.config.pet
  if (!pet || typeof pet.scale !== 'number' || typeof pet.maxPets !== 'number') {
    fail('config.pet shape', JSON.stringify(pet).slice(0, 120))
    return
  }
  ok('config payload shape', `scale=${pet.scale} maxPets=${pet.maxPets}`)
})

console.log('\n2) state endpoint')
await checkRoute('GET /api/state.json', `${PREFIX}/api/state.json`, (r) => {
  try {
    const parsed = JSON.parse(r.bytes.toString('utf8'))
    if (parsed.ok !== true) return fail('state payload', 'ok !== true')
    ok('state payload', `plugin=${parsed.plugin} ledger=${parsed.ledgerAvailable}`)
  } catch (err) {
    fail('state payload', 'parse error')
  }
})

console.log('\n3) ledger endpoint (read-only accounting)')
await checkRoute('GET /api/ledger.json', `${PREFIX}/api/ledger.json`, (r) => {
  let parsed = null
  try {
    parsed = JSON.parse(r.bytes.toString('utf8'))
  } catch (err) {
    fail('ledger payload', 'parse error')
    return
  }
  if (parsed.ok === true) {
    const today = parsed.today
    if (!today || typeof today.amount !== 'number') return fail('ledger today shape', 'no amount')
    ok('ledger payload', `today=¥${today.amount} source=${today.source} events=${parsed.eventCount}`)
    if (parsed.readOnly !== true) fail('ledger is declared read-only', 'readOnly !== true')
    else ok('ledger is declared read-only')
  } else {
    // A missing whale ledger is a legitimate state, not a failure.
    ok('ledger payload', `ok:false reason=${parsed.reason} (whale ledger absent — pet stays silent)`)
  }
})

console.log('\n4) assets')
await checkRoute('GET /assets/frames/f0001.webp', `${PREFIX}/assets/frames/f0001.webp`, (r) => {
  if (!magic(r.bytes, [0x52, 0x49, 0x46, 0x46])) return fail('f0001 is RIFF/WebP', 'bad magic')
  if (!magic(r.bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return fail('f0001 is RIFF/WebP', 'no WEBP tag')
  ok('f0001 is a real WebP', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/frames/f0432.webp', `${PREFIX}/assets/frames/f0432.webp`, (r) => {
  ok('last frame served', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/eyes/backing.png', `${PREFIX}/assets/eyes/backing.png`, (r) => {
  if (!magic(r.bytes, [0x89, 0x50, 0x4e, 0x47])) return fail('backing.png is PNG', 'bad magic')
  ok('backing.png is a real PNG', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/eyes/pupil.png', `${PREFIX}/assets/eyes/pupil.png`, (r) => {
  if (!magic(r.bytes, [0x89, 0x50, 0x4e, 0x47])) return fail('pupil.png is PNG', 'bad magic')
  ok('pupil.png is a real PNG', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/audio/click.wav', `${PREFIX}/assets/audio/click.wav`, (r) => {
  if (!magic(r.bytes, [0x52, 0x49, 0x46, 0x46])) return fail('click.wav is RIFF/WAVE', 'bad magic')
  ok('click.wav is a real WAV', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/audio/laugh.mp3', `${PREFIX}/assets/audio/laugh.mp3`, (r) => {
  ok('laugh.mp3 source served', `${r.bytes.length}B`)
})
await checkRoute('GET /assets/audio/laugh-synced.wav', `${PREFIX}/assets/audio/laugh-synced.wav`, (r) => {
  if (!magic(r.bytes, [0x52, 0x49, 0x46, 0x46])) return fail('laugh-synced.wav is RIFF/WAVE', 'bad magic')
  ok('laugh-synced.wav is a real WAV', `${r.bytes.length}B`)
})

console.log('\n5) route hardening')
{
  const r = await probe(`${PREFIX}/assets/frames/../../package.json`)
  if (r.status === 200 && !isHtmlFallback(r)) fail('path traversal refused', `served ${r.bytes.length}B`)
  else ok('path traversal refused', `HTTP ${r.status}`)
}
{
  const r = await probe(`${PREFIX}/assets/frames/not-a-frame.txt`)
  if (r.status === 200 && !isHtmlFallback(r)) fail('unknown asset refused', 'served content')
  else ok('unknown asset refused', `HTTP ${r.status}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) {
  console.log('\nFAILED — the pet cannot render until these are fixed.')
  process.exit(1)
}
console.log('\nOK — every route the browser needs is live.')
