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
