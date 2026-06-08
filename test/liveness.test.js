'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const liveness = require('../src/liveness');

/**
 * Build a fake canvas-like frame that the texture sampler accepts.
 *  - `kind` drives the noise pattern
 *  - 'flat'  : solid color, no edges (printed photo)
 *  - 'grain' : high-frequency noise (real skin)
 *  - 'grid'  : moiré-like repeating pattern (phone screen)
 */
function makeFrame(kind = 'grain', W = 128, H = 128) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  if (kind === 'flat') {
    ctx.fillStyle = 'rgb(150,150,150)';
    ctx.fillRect(0, 0, W, H);
    return c;
  }
  if (kind === 'grid') {
    // Regular stripes → high-frequency but low entropy
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = ((x + y) % 4 < 2) ? 200 : 50;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return c;
  }
  // grain
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 100 + Math.floor(Math.random() * 80);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function fakeDetection(landmarks68) {
  return {
    detection: {
      alignedRect: { _box: { x: 32, y: 32, width: 64, height: 64 } },
      landmarks:   { positions: landmarks68 },
    },
  };
}

function buildLandmarks(positions = {}) {
  // 68-point array with defaults centered around (64,64). Override with positions.
  const arr = Array.from({ length: 68 }, (_, i) => ({
    x: positions[i] ? positions[i].x : 64,
    y: positions[i] ? positions[i].y : 64,
  }));
  return arr;
}

test('textureScore: flat (printed) image fails the texture check', () => {
  const frame = makeFrame('flat');
  const r = liveness.textureScore(frame, { x: 0, y: 0, width: 128, height: 128 });
  assert.equal(r.ok, false, `flat should fail, got ${JSON.stringify(r)}`);
  assert.ok(r.variance < liveness.THRESHOLDS.TEX_MIN_VARIANCE, 'variance below threshold');
});

test('textureScore: grainy (real skin) image passes the texture check', () => {
  const frame = makeFrame('grain');
  const r = liveness.textureScore(frame, { x: 0, y: 0, width: 128, height: 128 });
  assert.equal(r.ok, true, `grain should pass, got ${JSON.stringify(r)}`);
});

test('textureScore: missing/zero-size box returns ok=true (don\'t block on bad input)', () => {
  const frame = makeFrame('grain');
  const r = liveness.textureScore(frame, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(r.ok, true);
});

test('stableLandmarks: returns nose + eyes from a 68-pt array', () => {
  const arr = buildLandmarks({ 30: { x: 100, y: 110 }, 36: { x: 80, y: 90 }, 45: { x: 120, y: 90 } });
  const lm = liveness.stableLandmarks({ landmarks: { positions: arr } });
  assert.deepEqual(lm.nose, { x: 100, y: 110 });
  assert.deepEqual(lm.leftEye, { x: 80, y: 90 });
  assert.deepEqual(lm.rightEye, { x: 120, y: 90 });
});

test('stableLandmarks: null on short array', () => {
  assert.equal(liveness.stableLandmarks({ landmarks: { positions: [] } }), null);
  assert.equal(liveness.stableLandmarks({}), null);
});

test('TemporalLiveness: stationary nose is not alive', () => {
  const tl = new liveness.TemporalLiveness();
  const lm = { nose: { x: 100, y: 100 }, leftEye: { x: 80, y: 90 }, rightEye: { x: 120, y: 90 } };
  // 50 frames at the same exact position
  for (let i = 0; i < 50; i++) tl.update(1000 + i * 30, lm);
  assert.equal(tl.isAlive(3000), false, 'stationary = photo, not alive');
});

test('TemporalLiveness: jittery nose becomes alive', () => {
  const tl = new liveness.TemporalLiveness();
  const lm = { nose: { x: 100, y: 100 }, leftEye: { x: 80, y: 90 }, rightEye: { x: 120, y: 90 } };
  for (let i = 0; i < 30; i++) {
    const j = (i % 2) * 0.8; // 0.8px back-and-forth
    tl.update(1000 + i * 30, { ...lm, nose: { x: 100 + j, y: 100 + j } });
  }
  assert.equal(tl.isAlive(3000), true, 'jitter > threshold = alive');
});

test('TemporalLiveness: hadMotion expires after stillness', () => {
  const tl = new liveness.TemporalLiveness();
  const lm = { nose: { x: 100, y: 100 } };
  // jitter first
  for (let i = 0; i < 10; i++) tl.update(1000 + i * 30, { ...lm, nose: { x: 100 + (i % 2), y: 100 } });
  assert.equal(tl.isAlive(2000), true);
  // then sit perfectly still for a long time
  for (let i = 0; i < 200; i++) tl.update(3000 + i * 30, lm);
  // windowMs * 2 = 3000, so after 3s of stillness, trust expires
  assert.equal(tl.isAlive(8000), false, 'stillness after trust window expires liveness');
});

test('check: returns alive=false on no detection', () => {
  const tl = new liveness.TemporalLiveness();
  const r = liveness.check(null, null, tl, 1000);
  assert.equal(r.alive, false);
  assert.equal(r.reason, 'no-detection');
});

test('check: combined — real face (texture + motion) → alive', () => {
  const tl = new liveness.TemporalLiveness();
  const frame = makeFrame('grain');
  const lmArr = buildLandmarks();
  // build a "live" detection with jitter
  for (let i = 0; i < 10; i++) {
    const det = fakeDetection(lmArr);
    // jitter the nose (index 30)
    det.detection.landmarks.positions[30] = { x: 64 + (i % 2) * 0.9, y: 64 };
    liveness.check(det, frame, tl, 1000 + i * 100);
  }
  const final = liveness.check(fakeDetection(lmArr), frame, tl, 2200);
  assert.equal(final.alive, true, `expected alive, got ${JSON.stringify(final)}`);
});

test('check: combined — printed photo (good texture somehow, no motion) → not alive', () => {
  const tl = new liveness.TemporalLiveness();
  const frame = makeFrame('grain'); // pretend texture is fine
  const lmArr = buildLandmarks();
  // hold perfectly still (a printed photo on a stand)
  for (let i = 0; i < 10; i++) {
    liveness.check(fakeDetection(lmArr), frame, tl, 1000 + i * 100);
  }
  const r = liveness.check(fakeDetection(lmArr), frame, tl, 2200);
  assert.equal(r.alive, false);
  assert.equal(r.reason, 'no-temporal-motion');
});

test('check: combined — flat texture (printed photo) → not alive', () => {
  const tl = new liveness.TemporalLiveness();
  const frame = makeFrame('flat');
  const lmArr = buildLandmarks();
  // simulate "live" with jitter so we isolate the texture path
  for (let i = 0; i < 10; i++) {
    const det = fakeDetection(lmArr);
    det.detection.landmarks.positions[30] = { x: 64 + (i % 2) * 0.9, y: 64 };
    const r = liveness.check(det, frame, tl, 1000 + i * 100);
    // we don't need the full pass on each frame; the final one is what matters
    if (i === 9) {
      assert.equal(r.alive, false);
      assert.equal(r.reason, 'flat-texture');
    }
  }
});
