'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Monitor, STATE } = require('../src/monitor');
const profile = require('../src/profile');

// Stub: a profile that "matches" descriptors containing the string 'me',
// rejects everything else. Lets us drive the state machine without a camera.
function matchProfile(res) {
  if (!res) return false;
  return res.descriptor && res.descriptor.label === 'me';
}
const realProfile = {
  descriptor: { label: 'me' },
  threshold: 0.55,
};

function makeMonitor({ detect, graceMs = 1000, softBlock = false, softBlockDelayMs = 100, minPresentFrames = 1 } = {}) {
  const events = { left: 0, returned: 0, lock: 0, softBlock: 0 };
  // We override isMatch on the instance so we can test by string label
  // (real profile.match() uses Euclidean distance, which is verified in profile.test.js).
  // The monitor BOTH emits events AND invokes the action callback (sleepFn/lockFn).
  // Tests must listen to events only — counting inside the callbacks double-counts.
  const m = new Monitor({
    config: {
      graceMs, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames, softBlockEnabled: softBlock, softBlockDelayMs,
      cameraIndex: -1, logLevel: 0,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {},
    lockFn: () => {},
    detectFn: async () => detect(),
  });
  m.profile = realProfile;
  m.isMatch = (res) => matchProfile(res);
  m.on('left',       () => events.left++);
  m.on('returned',   () => events.returned++);
  m.on('lock',       () => events.lock++);
  m.on('soft-block', () => events.softBlock++);
  return { m, events };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('present → left → returned within grace cancels lock', async () => {
  let you = true;
  const { m, events } = makeMonitor({
    detect: () => (you ? { descriptor: { label: 'me' } } : null),
    graceMs: 300,
  });
  m.start();
  await m.tick();           // present
  assert.equal(m.state, STATE.PRESENT);
  you = false;
  await m.tick();           // left
  assert.equal(m.state, STATE.GRACE);
  assert.equal(events.left, 1);
  await wait(50);
  you = true;
  await m.tick();           // returned
  assert.equal(m.state, STATE.PRESENT);
  assert.equal(events.returned, 1);
  await wait(400);          // wait past grace — should NOT lock
  assert.equal(m.state, STATE.PRESENT);
  assert.equal(events.lock, 0);
  m.stop();
});

test('present → left → grace expires → lock fires once', async () => {
  let you = true;
  const { m, events } = makeMonitor({
    detect: () => (you ? { descriptor: { label: 'me' } } : null),
    graceMs: 100,
  });
  m.start();
  await m.tick();
  you = false;
  await m.tick();
  assert.equal(m.state, STATE.GRACE);
  await wait(200);          // past grace
  assert.equal(m.state, STATE.LOCKED);
  assert.equal(events.lock, 1);
  // any-face detection must NOT unlock — even when "you" is true,
  // state stays LOCKED (we already locked, OS requires password)
  you = true;
  await m.tick();
  assert.equal(m.state, STATE.LOCKED);
  m.stop();
});

test('soft block fires after delay when face lost', async () => {
  let you = true;
  const { m, events } = makeMonitor({
    detect: () => (you ? { descriptor: { label: 'me' } } : null),
    graceMs: 500,
    softBlock: true,
    softBlockDelayMs: 50,
  });
  m.start();
  await m.tick();
  you = false;
  await m.tick();
  await wait(100);
  assert.equal(events.softBlock, 1, 'soft block should fire once');
  // face returns — no second soft block
  you = true;
  await m.tick();
  await wait(100);
  assert.equal(events.softBlock, 1);
  m.stop();
});

test('not-your-face: detected but not matched → behaves as absent', async () => {
  let label = 'stranger';
  const { m, events } = makeMonitor({
    detect: () => ({ descriptor: { label } }),
    graceMs: 100,
  });
  m.start();
  // first frame: stranger — initial state is PRESENT, so stranger kicks
  // us straight into GRACE (no face match = "you left")
  await m.tick();
  assert.equal(m.state, STATE.GRACE);
  assert.equal(events.left, 1);
  m.stop();
});

test('stop() clears pending grace timer', async () => {
  let you = true;
  const { m, events } = makeMonitor({
    detect: () => (you ? { descriptor: { label: 'me' } } : null),
    graceMs: 200,
  });
  m.start();
  await m.tick();
  you = false;
  await m.tick();
  m.stop();
  await wait(300);
  assert.equal(events.lock, 0, 'stopped monitor must not fire lock');
});

test('away-dim: opt-in dim when face present but head turned', async () => {
  // build a 68-point landmark array; nose pulled far off-center => off-screen
  const fakeLandmarks = Array.from({ length: 68 }, (_, i) => {
    if (i === 36) return { x: 110, y: 100 };
    if (i === 45) return { x: 210, y: 100 };
    if (i === 30) return { x: 90,  y: 100 };  // off-screen
    return { x: 160, y: 120 };
  });
  const events = { left: 0, returned: 0, lock: 0, awayDim: 0, awayUndim: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000,
      detectionIntervalMs: 100,
      matchThreshold: 0.55,
      minPresentFrames: 1,
      softBlockEnabled: false,
      cameraIndex: -1,
      logLevel: 0,
      awayFaceDimEnabled: true,
      awayFaceDimDelayMs: 200,
      awayFaceDimYawMax: 0.35,
      awayFaceDimPitchMax: 0.40,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {},
    lockFn: () => {},
    detectFn: async () => ({
      detection: { landmarks: { positions: fakeLandmarks } },
      descriptor: { label: 'me' },
    }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m.on('away-dim',   () => events.awayDim++);
  m.on('away-undim', () => events.awayUndim++);
  m.start();
  await m.tick();           // first hit, streak=1
  await m.tick();           // streak=2 (>= delay 200ms / 100ms)
  await wait(50);
  assert.equal(events.awayDim, 1, 'away-dim should fire when off-screen long enough');
  // state must still be PRESENT (we don't lock for off-screen faces)
  assert.equal(m.state, STATE.PRESENT);
  m.stop();
});

test('away-dim: off by default (opt-in)', async () => {
  const fakeLandmarks = Array.from({ length: 68 }, (_, i) => {
    if (i === 36) return { x: 110, y: 100 };
    if (i === 45) return { x: 210, y: 100 };
    if (i === 30) return { x: 90,  y: 100 };
    return { x: 160, y: 120 };
  });
  const events = { awayDim: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      awayFaceDimEnabled: false,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({ detection: { landmarks: { positions: fakeLandmarks } }, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m.on('away-dim', () => events.awayDim++);
  m.start();
  await m.tick(); await m.tick();
  await wait(50);
  assert.equal(events.awayDim, 0, 'away-dim must be disabled by default');
  m.stop();
});

test('multi-face dim: 2+ faces in frame while you are present → dim', async () => {
  // single-face pass returns YOU; the multi-face pass sees 2 faces.
  const events = { awayDim: 0, awayDimReason: null, awayDimCount: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      awayFaceDimEnabled: false,
      multiFaceDimEnabled: true,
      multiFaceDimDelayMs: 200,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {},
    lockFn: () => {},
    detectFn: async () => ({ detection: {}, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  // Override the internal detectAll path:
  m._detectAllSafe = async () => ({
    detections: [
      { detection: { alignedRect: { _box: { x: 0, y: 0, width: 100, height: 100 } } }, descriptor: [] },
      { detection: { alignedRect: { _box: { x: 200, y: 0, width: 80, height: 80 } } }, descriptor: [] },
    ],
    count: 2,
    best: { detection: {}, descriptor: { label: 'me' } },
  });
  m.on('away-dim', (payload) => {
    events.awayDim++;
    if (payload) {
      events.awayDimReason = payload.reason;
      events.awayDimCount = payload.count;
    }
  });
  m.start();
  await m.tick();
  await m.tick();
  await wait(50);
  assert.equal(events.awayDim, 1, 'multi-face dim should fire when 2+ faces for >= delay');
  assert.equal(events.awayDimReason, 'multi-face');
  assert.equal(events.awayDimCount, 2);
  assert.equal(m.state, STATE.PRESENT, 'multi-face dim does NOT lock you out');
  m.stop();
});

test('multi-face dim: single face → no dim', async () => {
  const events = { awayDim: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      multiFaceDimEnabled: true,
      multiFaceDimDelayMs: 200,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({ detection: {}, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m._detectAllSafe = async () => ({
    detections: [{ detection: {}, descriptor: [] }],
    count: 1,
    best: { detection: {}, descriptor: { label: 'me' } },
  });
  m.on('away-dim', () => events.awayDim++);
  m.start();
  await m.tick(); await m.tick();
  await wait(50);
  assert.equal(events.awayDim, 0);
  m.stop();
});

test('multi-face dim: off by default (opt-in)', async () => {
  const events = { awayDim: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      multiFaceDimEnabled: false,  // <-- off
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({ detection: {}, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m._detectAllSafe = async () => ({
    detections: [
      { detection: {}, descriptor: [] },
      { detection: {}, descriptor: [] },
    ],
    count: 2,
    best: { detection: {}, descriptor: { label: 'me' } },
  });
  m.on('away-dim', () => events.awayDim++);
  m.start();
  await m.tick(); await m.tick();
  await wait(50);
  assert.equal(events.awayDim, 0, 'multi-face dim must be disabled by default');
  m.stop();
});

test('multi-face dim: dim clears when back to 1 face', async () => {
  const events = { awayDim: 0, awayUndim: 0 };
  let count = 2;
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      multiFaceDimEnabled: true,
      multiFaceDimDelayMs: 200,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({ detection: {}, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m._detectAllSafe = async () => ({
    detections: Array.from({ length: count }, () => ({ detection: {}, descriptor: [] })),
    count,
    best: { detection: {}, descriptor: { label: 'me' } },
  });
  m.on('away-dim',   () => events.awayDim++);
  m.on('away-undim', () => events.awayUndim++);
  m.start();
  await m.tick(); await m.tick();   // streak → dim fires
  await wait(20);
  assert.equal(events.awayDim, 1);
  count = 1;                         // stranger leaves
  await m.tick();
  await wait(20);
  assert.equal(events.awayUndim, 1, 'should undim when back to one face');
  m.stop();
});

// ── Liveness tests ────────────────────────────────────────────────────────
//
// These exercise the monitor's liveness integration. The texture signal
// needs a real node-canvas to be meaningful, so we drive the liveness
// decision via the temporal landmark-jitter path (a 1.5s window of the
// nose-tip's std-dev).

function jitterLandmarks(seed = 0) {
  // Stable points for indices 30 (nose), 36 (left eye), 45 (right eye).
  // nose x oscillates between 64.0 and 64.8 (jitter ~0.4px, below threshold)
  // or 64.0 and 65.0 (jitter ~0.5px, ABOVE threshold when scaled by 0.25
  // std-dev). Tests drive the streak by feeding many frames.
  return Array.from({ length: 68 }, (_, i) => {
    if (i === 30) return { x: 64 + (seed % 2 === 0 ? 0 : 0.6), y: 64 };
    if (i === 36) return { x: 56, y: 60 };
    if (i === 45) return { x: 72, y: 60 };
    return { x: 64, y: 64 };
  });
}

test('liveness: enabled by default (no opt-in flag)', () => {
  // Just confirm the default config has livenessEnabled on.
  const cfg = require('../src/config');
  assert.equal(cfg.DEFAULTS.livenessEnabled, true, 'liveness should be default ON');
});

test('liveness: matched face with jittering nose is treated as you', async () => {
  let n = 0;
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      livenessEnabled: true,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({ detection: { landmarks: { positions: jitterLandmarks(n++) } }, descriptor: { label: 'me' } }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m.start();
  // ~10 ticks of jittering nose → liveness should accept
  for (let i = 0; i < 10; i++) await m.tick();
  await wait(50);
  // No liveness-fail event expected
  const fails = [];
  m.on('liveness-fail', (p) => fails.push(p));
  await m.tick();
  assert.deepEqual(fails, [], 'jittering nose should pass liveness');
  assert.equal(m.state, STATE.PRESENT);
  m.stop();
});

test('liveness: matched face held perfectly still is treated as NOT you', async () => {
  const events = { left: 0, lock: 0, livenessFail: 0, livenessReasons: [] };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      livenessEnabled: true,
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    // 68-pt landmark array where the nose DOES NOT move — simulates a printed
    // photo on a stand.
    detectFn: async () => ({
      detection: { landmarks: { positions: jitterLandmarks(0) } },
      descriptor: { label: 'me' },
    }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m.on('left',          () => events.left++);
  m.on('lock',          () => events.lock++);
  m.on('liveness-fail', (p) => { events.livenessFail++; events.livenessReasons.push(p.reason); });
  m.start();
  // first few frames build the buffer (no fail yet — temporal needs samples)
  await m.tick(); await m.tick(); await m.tick(); await m.tick();
  // now the buffer is full and never sees motion → fail
  for (let i = 0; i < 8; i++) await m.tick();
  await wait(20);
  assert.ok(events.livenessFail > 0, `expected liveness-fail events, got ${events.livenessFail}`);
  assert.ok(events.livenessReasons.includes('no-temporal-motion'),
    `expected reason 'no-temporal-motion', got ${JSON.stringify(events.livenessReasons)}`);
  // Because the monitor treats the photo as "not you", the first failed
  // frame triggers onLeft() and the state machine enters GRACE.
  assert.equal(m.state, STATE.GRACE, 'still photo should be treated as face left');
  m.stop();
});

test('liveness: disabled in config → no liveness rejection even with still nose', async () => {
  const events = { livenessFail: 0, left: 0 };
  const m = new Monitor({
    config: {
      graceMs: 15000, detectionIntervalMs: 100, matchThreshold: 0.55,
      minPresentFrames: 1, softBlockEnabled: false, cameraIndex: -1, logLevel: 0,
      livenessEnabled: false,  // <-- opt-out path
    },
    frameSource: { getFrame: async () => ({ __frame: true }) },
    sleepFn: () => {}, lockFn: () => {},
    detectFn: async () => ({
      detection: { landmarks: { positions: jitterLandmarks(0) } },
      descriptor: { label: 'me' },
    }),
  });
  m.profile = realProfile;
  m.isMatch = () => true;
  m.on('liveness-fail', () => events.livenessFail++);
  m.on('left',          () => events.left++);
  m.start();
  for (let i = 0; i < 10; i++) await m.tick();
  await wait(20);
  assert.equal(events.livenessFail, 0, 'liveness off → no liveness-fail events');
  assert.equal(events.left, 0, 'liveness off → still nose does not trigger grace');
  assert.equal(m.state, STATE.PRESENT);
  m.stop();
});
