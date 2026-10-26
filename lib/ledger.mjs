/**
 * Read-only access to the ledger owned by `dsh-whale-widget`.
 *
 * Design constraints (from the real upstream source, v0.4.2):
 *   - The ledger lives at `$DSH_HOME/.dshw-usage.json` (first existing candidate wins).
 *   - Upstream writes it atomically (temp + renameSync), so a reader never sees a
 *     half-written file. We STILL retry EBUSY/EPERM/EACCES because Windows indexers
 *     can hold the handle.
 *   - Upstream treats an unreadable file as a fresh ledger and RENAMES a corrupt one
 *     away. We must never do that: we only read, and a parse failure is reported as
 *     "unavailable", never as "empty".
 *   - `pruneLedgerUsage` moves events older than 90 days / beyond 20 000 into
 *     `.dshw-usage-archive.json`; deep history needs both files.
 *   - There is no ledger-level generation counter; `mtimeMs` + `size` is the detector.
 *
 * dsh-naiwa NEVER writes any `.dshw-*` file. That is the whole point of this module.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Resolved DSH home, matching upstream's own resolution order. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Candidate ledger paths, in upstream's resolution order. */
export function ledgerCandidates() {
  const home = dshHome()
  return [
    path.join(home, '.dshw-usage.json'),
    path.join(home, 'profiles', 'web', '.dshw-usage.json'),
  ]
}

/** Candidate archive paths (same directory as the ledger that exists). */
export function archiveCandidates() {
  return ledgerCandidates().map((p) => path.join(path.dirname(p), '.dshw-usage-archive.json'))
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Synchronous read with a bounded retry on transient Windows sharing conflicts. */
function readTextResilient(file) {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch (err) {
      lastError = err
      if (!RETRY_CODES.has(err && err.code)) throw err
      // 20ms * (attempt+1) busy-wait, mirroring upstream's `ledgerIo` behaviour.
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastError
}

/**
 * Read and parse one JSON file.
 * @returns {{ ok: true, value: object, file: string, mtimeMs: number, size: number }
 *          | { ok: false, reason: 'missing' | 'unreadable' | 'malformed', file?: string, error?: string }}
 */
export function readJsonFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing', file }
    return { ok: false, reason: 'unreadable', file, error: String((err && err.code) || err) }
  }
  let raw
  try {
    raw = readTextResilient(file)
  } catch (err) {
    return { ok: false, reason: 'unreadable', file, error: String((err && err.code) || err) }
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'malformed', file, error: 'not-a-json-object' }
    }
    return { ok: true, value, file, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (err) {
    return { ok: false, reason: 'malformed', file, error: 'invalid-json' }
  }
}

/**
 * Read the whale ledger, read-only.
 *
 * A ledger is accepted when it carries a string `date`, which is the same
 * structural check upstream applies before trusting the file.
 */
export function readLedger() {
  const tried = []
  for (const file of ledgerCandidates()) {
    const result = readJsonFile(file)
    if (!result.ok) {
      tried.push(result)
      if (result.reason === 'missing') continue
      // An unreadable/malformed existing file is a hard stop: never fall through
      // to the next candidate and never pretend the ledger is empty.
      return {
        ok: false,
        reason: result.reason,
        file,
        error: result.error,
        tried,
      }
    }
    if (typeof result.value.date !== 'string') {
      return { ok: false, reason: 'malformed', file, error: 'missing-date-field', tried }
    }
    return {
      ok: true,
      ledger: result.value,
      file,
      mtimeMs: result.mtimeMs,
      size: result.size,
      tried,
    }
  }
  return { ok: false, reason: 'missing', tried }
}

/** Read the archive file (best effort — absent is normal, malformed is tolerated). */
export function readArchive() {
  for (const file of archiveCandidates()) {
    const result = readJsonFile(file)
    if (!result.ok) {
      if (result.reason === 'missing') continue
      return { ok: false, reason: result.reason, file }
    }
    return { ok: true, archive: result.value, file }
  }
  return { ok: false, reason: 'missing' }
}

/**
 * Build a cheap change token for the ledger so the host can avoid recomputing
 * summaries on every request. There is no ledger-level revision upstream.
 */
export function ledgerToken(read) {
  if (!read || !read.ok) return `absent:${read ? read.reason : 'unknown'}`
  return `${read.mtimeMs}:${read.size}:${read.file}`
}
