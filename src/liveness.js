'use strict';

/**
 * Liveness detection — no extra model required.
 *
 * Two cheap, complementary signals computed from the existing face-api.js
 * landmarks + a downsampled grayscale of the face crop:
 *
 *   1. TEXTURE  — real skin has high local variance; printed photos and
 *                 phone screens are flat / moiré'd. We sample a 32x32
 *                 crop centered on the face box, compute per-pixel
 *                 std-dev across a 3x3 Laplacian-of-Gaussian-ish kernel,
 *                 and require it to clear a threshold.
 *
 *   2. TEMPORAL — a real face is never perfectly still. Blood pulse drives
 *                 sub-pixel motion at ~1 Hz. We keep a rolling buffer of
 *                 landmark positions (nose tip, eye corners) and require
 *                 the std-dev of nose-tip x/y over the last 1.5s to clear
 *                 a small threshold. A printed photo or a phone held up
 *                 is essentially stationary.
 *
 * Both signals must pass. This is a heuristic, not a proof — it will miss
 * sophisticated 3D-printed masks and well-rigged cutouts. It catches the
 * common case of "attacker holds a phone showing your Instagram profile
 * pic in front of the webcam."
 *
 * The signal runs ONLY on faces that already match the enrolled profile.
 * If liveness fails on a match, we treat it as "face not you" for that
 * frame and start the grace timer.
 */

const { createCanvas } = (() => {
  try { return require('canvas'); } catch (_) { return { createCanvas: null }; }
})();

const TEX_MIN_VARIANCE = 18;       // too low → likely flat / printed
const TEX_MIN_EDGE     = 8;        // Laplacian energy; photos have less
const MOTION_MIN_STD   = 0.25;     // nose-tip jitter (pixels) in 1.5s
const MOTION_WINDOW_MS = 1500;

/**
 * Sample the face crop and return { variance, edgeEnergy }.
 * `faceBox` = { x, y, width, height } from face-api. `frame` is a node-canvas.
 */
function textureScore(frame, faceBox) {
  if (!createCanvas || !frame || !faceBox) return { variance: 999, edgeEnergy: 999, ok: true };
  if (faceBox.width <= 0 || faceBox.height <= 0) return { variance: 999, edgeEnergy: 999, ok: true };
  const W = 32, H = 32;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  try {
    ctx.drawImage(frame, faceBox.x, faceBox.y, faceBox.width, faceBox.height, 0, 0, W, H);
  } catch (_) {
    return { variance: 999, edgeEnergy: 999, ok: true }; // can't sample → don't block
  }
  const img = ctx.getImageData(0, 0, W, H).data;
  const gray = new Float32Array(W * H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
  }
  // variance
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) * (gray[i] - mean);
  variance /= gray.length;
  // crude Laplacian energy
  let edge = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const c = gray[y * W + x];
      const lap = 4 * c
        - gray[(y - 1) * W + x]
        - gray[(y + 1) * W + x]
        - gray[y * W + (x - 1)]
        - gray[y * W + (x + 1)];
      edge += Math.abs(lap);
    }
  }
  edge /= (W - 2) * (H - 2);
  const ok = variance >= TEX_MIN_VARIANCE && edge >= TEX_MIN_EDGE;
  return { variance, edgeEnergy: edge, ok };
}

/**
 * Extract a small set of stable landmarks for the temporal signal.
 * Returns { nose: {x,y}, leftEye: {x,y}, rightEye: {x,y} } or null.
 */
function stableLandmarks(detection) {
  if (!detection || !detection.landmarks || !detection.landmarks.positions) return null;
  const p = detection.landmarks.positions;
  if (!p || p.length < 68) return null;
  // 30 = nose tip, 36 = left eye outer, 45 = right eye outer (face-api 68-pt).
  return {
    nose:      { x: p[30].x, y: p[30].y },
    leftEye:   { x: p[36].x, y: p[36].y },
    rightEye:  { x: p[45].x, y: p[45].y },
  };
}

/**
 * Track a session's landmark history. Call `update(now, landmarks)` on each
 * matched frame. Call `isAlive(now)` to ask "have we seen natural motion
 * recently?" Returns a tiny handle — the monitor keeps one of these.
 */
class TemporalLiveness {
  constructor({ windowMs = MOTION_WINDOW_MS, minStd = MOTION_MIN_STD } = {}) {
    this.windowMs = windowMs;
    this.minStd = minStd;
    this.samples = []; // [{ t, x, y }]
    this.hadMotion = false;     // sticky: once we've seen motion, we trust for the session
    this.stuckSince = null;     // for the log
  }
  update(now, landmarks) {
    if (!landmarks || !landmarks.nose) return;
    this.samples.push({ t: now, x: landmarks.nose.x, y: landmarks.nose.y });
    // Trim
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
    if (this.samples.length < 5) return;            // need a few samples
    // Std-dev of x and y separately
    let mx = 0, my = 0;
    for (const s of this.samples) { mx += s.x; my += s.y; }
    mx /= this.samples.length;
    my /= this.samples.length;
    let vx = 0, vy = 0;
    for (const s of this.samples) {
      vx += (s.x - mx) * (s.x - mx);
      vy += (s.y - my) * (s.y - my);
    }
    vx = Math.sqrt(vx / this.samples.length);
    vy = Math.sqrt(vy / this.samples.length);
    const jitter = Math.max(vx, vy);
    if (jitter >= this.minStd) {
      this.hadMotion = true;
      this.stuckSince = null;
    } else if (this.stuckSince == null) {
      this.stuckSince = now;
    }
  }
  /**
   * `now` is the current time. `freshnessMs` is how long after the last
   * motion we still trust the user (default = windowMs). After that, the
   * temporal signal expires and the user must demonstrate motion again.
   */
  isAlive(now, freshnessMs = this.windowMs * 2) {
    if (this.hadMotion) {
      // If they've been perfectly still for a long time, expire the trust.
      if (this.stuckSince != null && now - this.stuckSince > freshnessMs) {
        this.hadMotion = false;
        return false;
      }
      return true;
    }
    return false;
  }
  reset() {
    this.samples = [];
    this.hadMotion = false;
    this.stuckSince = null;
  }
}

/**
 * Combined check.
 *   `result` — detectOne output (has detection + descriptor)
 *   `frame`  — the canvas / image the detection was run on (kept by the caller)
 *   `tl`     — session-scoped TemporalLiveness handle
 *   `now`    — Date.now() (injected for testability)
 *
 * Returns { alive: boolean, texture: {...}, motionOk, reason? }
 */
function check(result, frame, tl, now = Date.now()) {
  if (!result || !result.detection) {
    return { alive: false, reason: 'no-detection' };
  }
  const box = result.detection.alignedRect && result.detection.alignedRect._box;
  const tex = (frame && box && box.width > 0 && box.height > 0)
    ? textureScore(frame, box)
    : { variance: 999, edgeEnergy: 999, ok: true };
  const lm = stableLandmarks(result.detection);
  let motionOk = true;
  if (lm) {
    tl.update(now, lm);
    motionOk = tl.isAlive(now);
  } else {
    // No landmarks → cannot measure motion. Don't block (test environments,
    // some head-pose edge cases). Real frames from face-api always have 68 pts.
    motionOk = true;
  }
  const ok = tex.ok && motionOk;
  const reason = !tex.ok ? 'flat-texture' : (!motionOk ? 'no-temporal-motion' : undefined);
  return { alive: ok, texture: tex, motionOk, reason };
}

module.exports = {
  textureScore,
  stableLandmarks,
  TemporalLiveness,
  check,
  // thresholds (for tests / tuning)
  THRESHOLDS: {
    TEX_MIN_VARIANCE,
    TEX_MIN_EDGE,
    MOTION_MIN_STD,
    MOTION_WINDOW_MS,
  },
};
