/**
 * Inspect an MP3/Mpeg audio file without any external decoder.
 *
 * Reports the ID3v2 tag size, the first valid MPEG frame header (version,
 * layer, bitrate, sample rate, channels), the number of frames found, and an
 * estimated duration. Used to prove the user-supplied laugh track is real,
 * non-empty audio before blaming the browser.
 *
 * Usage: node tools/inspect-mp3.mjs <file>
 */
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/inspect-mp3.mjs <file.mp3>')
  process.exit(2)
}
const buf = fs.readFileSync(file)

function syncsafe(b, off) {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
}

let audioStart = 0
if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
  const size = syncsafe(buf, 6)
  audioStart = 10 + size
  console.log(`ID3v2.${buf[3]} tag: ${size} bytes, audio starts at ${audioStart}`)
} else {
  console.log('no ID3v2 tag')
}

// MPEG audio frame header tables (MPEG1 & MPEG2/2.5, layer III).
const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
}

function parseFrame(offset) {
  if (offset + 4 > buf.length) return null
  if (buf[offset] !== 0xff) return null
  const b1 = buf[offset + 1]
  if ((b1 & 0xe0) !== 0xe0) return null
  const versionBits = (b1 >> 3) & 0x03
  const layerBits = (b1 >> 1) & 0x03
  const b2 = buf[offset + 2]
  const bitrateIdx = (b2 >> 4) & 0x0f
  const srIdx = (b2 >> 2) & 0x03
  const b3 = buf[offset + 3]
  const channelMode = (b3 >> 6) & 0x03
  if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null
  const table = versionBits === 3 ? BITRATES_V1L3 : BITRATES_V2L3
  const bitrate = table[bitrateIdx] * 1000
  const sampleRate = SAMPLE_RATES[versionBits][srIdx]
  const padding = (b2 >> 1) & 0x01
  const samplesPerFrame = versionBits === 3 ? 1152 : 576
  const frameLen = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding
  if (frameLen < 24) return null
  return {
    version: versionBits === 3 ? 'MPEG1' : versionBits === 2 ? 'MPEG2' : 'MPEG2.5',
    layer: 4 - layerBits,
    bitrate,
    sampleRate,
    channelMode: channelMode === 3 ? 'mono' : channelMode === 1 ? 'joint-stereo' : 'stereo',
    frameLen,
    samplesPerFrame,
  }
}

// Find the first frame sync.
let first = null
let firstAt = -1
for (let i = audioStart; i < Math.min(buf.length - 4, audioStart + 65536); i += 1) {
  const f = parseFrame(i)
  if (f) {
    first = f
    firstAt = i
    break
  }
}
if (!first) {
  console.error('FAIL: no valid MPEG frame header found — this is not decodable MPEG audio')
  process.exit(1)
}
console.log(`first frame at ${firstAt}: ${first.version} layer ${first.layer}, ${first.bitrate / 1000} kbps, ${first.sampleRate} Hz, ${first.channelMode}, frame=${first.frameLen}B`)

// Walk frames to the end.
let offset = firstAt
let frames = 0
let samples = 0
let lastGood = offset
while (true) {
  const f = parseFrame(offset)
  if (!f) break
  frames += 1
  samples += f.samplesPerFrame
  lastGood = offset
  offset += f.frameLen
  if (frames > 2_000_000) break
}
const duration = samples / first.sampleRate
const audioBytes = buf.length - audioStart
const covered = lastGood + parseFrame(lastGood).frameLen - audioStart
console.log(`frames=${frames}  samples=${samples}  duration=${duration.toFixed(3)}s`)
console.log(`audio bytes=${audioBytes}  parsed=${covered}  unparsed tail=${audioBytes - covered}`)

// Non-zero content check: look for any byte that is not 0x00/0xFF in the audio region.
let nonZero = 0
for (let i = audioStart; i < buf.length; i += 1) {
  const v = buf[i]
  if (v !== 0 && v !== 0xff) nonZero += 1
}
console.log(`non-trivial bytes: ${nonZero} / ${audioBytes} (${((nonZero / Math.max(1, audioBytes)) * 100).toFixed(1)}%)`)

if (duration < 0.2) {
  console.error('FAIL: track is essentially empty')
  process.exit(1)
}
console.log(`OK: ${duration.toFixed(2)}s of ${first.version} layer ${first.layer} audio at ${first.sampleRate} Hz`)
