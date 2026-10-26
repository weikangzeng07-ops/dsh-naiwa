// ===========================================================================
// 00 — constants ported 1:1 from the naiwa Python source
// ===========================================================================
// Every number here is copied from the original project so the port can be
// audited against the reference. See analysis/naiwa-analysis.md.

/** Size tiers, ordered largest → smallest (pet_physics.TIERS). */
var TIERS = [0.8, 0.7, 0.6, 0.5]

/** Fixed physics substep (pet_physics.STEP). */
var PHYS_STEP = 1 / 120
/** Whole-trajectory slowdown (pet_physics.MOTION_RATE). */
var MOTION_RATE = 0.75
/** Max catch-up per frame (pet_physics: STEP * 8). */
var MAX_CATCHUP = PHYS_STEP * 8

/** Frame rate of the laugh clip (manifest.fps). */
var CLIP_FPS = 30
var FRAME_MS = 1000 / CLIP_FPS
/** Total frames in the clip. */
var CLIP_FRAMES = 432
/** Emitted clones loop from here to the end (EMITTED_LOOP_FIRST_FRAME - 1). */
var LOOP_START = 53

/** Transparent padding above and below the frame, in reference px (BODY_PAD). */
var BODY_PAD = 32
/** Reference frame size (manifest clips[0].window.store). */
var BASE_W = 320
var BASE_H = 305
/** Alpha threshold used by the original for display AND hit testing. */
var ALPHA_CUTOFF = 110

/**
 * Two clicks inside this window are a double click (laugh); a lone click summons
 * the whale-style account bubble for five seconds instead.
 */
var DOUBLE_CLICK_MS = 300
/** Clicks needed inside SPLIT_WIN (while laughing) for a burst. */
var SPLIT_N = 8
var SPLIT_WIN = 2.0
/** Movement below this is a click, not a drag. */
var DRAG_PX = 4
/** Hold time to fully charge a poke. */
var CHARGE_SEC = 1.5

/** Hard cap on characters, reservations included. */
var MAX_PETS = 40
/** Scale used by menu duplicate / paste. */
var CLONE_SCALE = 0.5
/** Reunify glide duration. */
var REUNIFY_SEC = 0.45
/** Horizontal gap for a duplicated clone. */
var DUPLICATE_GAP = 12
/** Burst stagger between clones. */
var BURST_STAGGER = 0.1

/** Eye tracking (pet_eyes.EyeFollow). */
var EYE_INTERVAL = 1 / 30
var EYE_SMOOTH_SEC = 0.12
var EYE_LIMIT_X = 2.0
var EYE_LIMIT_Y = 1.5
/** Hard-coded eye ROI in reference px — NOT in geometry.json. */
var EYE_ROI = [135, 24, 152, 42]
var EYE_GEOMETRY = {
  referenceSize: [320, 305],
  eyeBox: [137.4, 27.3, 148.5, 39.2],
  pupilCenter: [141.5, 33.6],
  pupilSize: [6.2, 8.0],
}

/** Local jelly (_LocalJelly). */
var JELLY_DECAY = 8.0
var JELLY_FREQ = 24.0
var JELLY_LIMIT = 3.0
var JELLY_DURATION = 0.70
var JELLY_FRAME_SEC = 1 / 60
var JELLY_RX = 110
var JELLY_RY = 72
var JELLY_RADIAL_PEAK = Math.pow(6 / 7, 3) / Math.sqrt(7)

/** Body jelly (_BodyJelly). */
var BODY_DECAY = 7.0
var BODY_FREQ = 20.0
var BODY_PICKUP_SEC = 0.12
var BODY_HANDOFF_SEC = 0.08
var BODY_LAND_SEC = 0.90
var BODY_STRETCH = 1.08

/** Physics tuning (pet_physics._space). */
var PHYS_ITERATIONS = 10 // source: 30; lowered for browser cost, see README
var PHYS_DAMPING = 0.985 // per SECOND (Chipmunk semantics)
var PHYS_SLEEP_SEC = 0.6
var PHYS_IDLE_SPEED = 10
var PHYS_SLOP = 0.3
var WALL_RADIUS = 2

/** Restitution / friction per contact kind. */
var REST_FLOOR = 0.55
var REST_WALL = 0.65
var REST_PET = 0.3
var FRIC_FLOOR = 0.7
var FRIC_WALL = 0
var FRIC_PET = 0.15
var REST_SPEED_CUTOFF = 45

/** Launch velocity. */
var LAUNCH_SPEED_MIN = 900
var LAUNCH_SPEED_MAX = 1250
var LAUNCH_ANGLE_MIN = 60
var LAUNCH_ANGLE_MAX = 80

/** Audio (media_map.json). */
var AUDIO_VOLUME = 0.7
/**
 * Compensation for the browser's audio output latency, in ms.
 *
 * The reference used 170 ms because pygame/SDL buffered heavily. This port runs
 * on an HTMLAudioElement, whose pipeline is much shorter: a live measurement in
 * the target Chromium profile reports `baseLatency=10 ms`,
 * `outputLatency=40 ms`, i.e. 50 ms from submitting samples to hearing them.
 *
 * The animation clock subtracts this value only while the media clock is
 * running, so frame N is shown when sample N reaches the speaker. 50 ms is the
 * default; `AUDIO_START_GRACE_SEC` covers the first frames while the element is
 * still opening its decoder.
 */
var AUDIO_LATENCY_MS = 50
/** Seconds to hold frame 0 while the media element is still becoming playable. */
var AUDIO_START_GRACE_SEC = 0.4
/** Audio loop segment for emitted clones, in seconds. */
var AUDIO_LOOP_START = (LOOP_START * FRAME_MS) / 1000 // 1.7666…
var AUDIO_LOOP_END = (CLIP_FRAMES * FRAME_MS) / 1000 // 14.4

/**
 * Wall-clock length of the laugh clip, in seconds.
 *
 * 432 frames at 30 fps = 14.4 s. The authored `laugh.wav` is 14.4196 s, i.e.
 * exactly this window plus the encoder tail. The animation is authored at this
 * rate; the port must never time-stretch it.
 */
var CLIP_DURATION_SEC = (CLIP_FRAMES * FRAME_MS) / 1000 // 14.4

/** Asset route. */
var ASSET_BASE = '/dsh-naiwa/assets'
var API_BASE = '/dsh-naiwa/api'

/**
 * Cache-busting suffix for the audio URLs.
 *
 * The very first install requested these before the Host routes existed, so the
 * browser cached a negative (404) entry for them. A versioned query string is a
 * different cache key, which clears that stale entry without asking the user to
 * wipe their cache. Bump it whenever the audio files themselves change.
 */
var AUDIO_QS = '?v=3'

/**
 * The laugh track is the user-supplied recording, completed so it spans the
 * whole animation.
 *
 * `assets/audio/laugh.mp3` (the user's file) is NOT a different take: it is the
 * authored 14.4196 s recording with the 1.577 s lead-in trimmed and the final
 * 2.63 s cut off. Cross-correlating its waveform with the reference gives 0.98
 * at a 1.577 s offset. Playing it at t=0 therefore puts the laughs 1.58 s ahead
 * of the picture, and stretching it to 14.4 s only hides the symptom while
 * warping every laugh inside the track.
 *
 * `assets/audio/laugh-synced.wav` is the same performance at its authored speed
 * (playbackRate 1.0, no pitch shift):
 *
 *     1.577 s of silence
 *   + the user's 10.210 s MP3
 *   + the recording's final 2.632 s (the part the MP3 had cut)
 *   = 14.4196 s, sample-aligned with the 432-frame animation.
 *
 * See `assets/audio/README.md` for the exact splice points and provenance.
 */
var LAUGH_URL = ASSET_BASE + '/audio/laugh-synced.wav?v=1'
var CLICK_URL = ASSET_BASE + '/audio/click.wav' + AUDIO_QS

/** CSS prefix — deliberately NOT `dshw-` / `dshwv-` (owned by dsh-whale-widget). */
var CLS = 'naiwa'

/**
 * Snap an arbitrary scale onto the four tiers.
 * Mirrors pet_physics.snap_scale: nearest tier, ties go to the LARGER one.
 */
function snapScale(value) {
  var v = Number(value)
  if (!isFinite(v)) return TIERS[3]
  var best = TIERS[0]
  var bestD = Infinity
  for (var i = 0; i < TIERS.length; i += 1) {
    var d = Math.round(Math.abs(v - TIERS[i]) * 1e9) / 1e9
    if (d < bestD || (d === bestD && TIERS[i] > best)) {
      best = TIERS[i]
      bestD = d
    }
  }
  return best
}

/** 1-based tier index (1 = 0.8 … 4 = 0.5). */
function tierOf(value) {
  return TIERS.indexOf(snapScale(value)) + 1
}

/** Clone scales for one burst (pet_physics.burst_scales). */
function burstScales(value) {
  var tier = tierOf(value)
  if (tier === 4) return []
  var pool = TIERS.slice(tier)
  var count = randInt(2, 5 - tier)
  var out = []
  for (var i = 0; i < count; i += 1) out.push(pool[Math.floor(Math.random() * pool.length)])
  return out
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function randFloat(min, max) {
  return min + Math.random() * (max - min)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(t) {
  t = clamp(t, 0, 1)
  return t * t * (3 - 2 * t)
}

/** Frame index → file name (f0001.webp …). */
function frameFile(index) {
  var n = String(index + 1)
  while (n.length < 4) n = '0' + n
  return 'f' + n + '.webp'
}
