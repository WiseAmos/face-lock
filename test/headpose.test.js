'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const headpose = require('../src/headpose');

function fakeLandmarks(landmarks) {
  // Pad to 68 entries with zeros (so length check passes)
  const padded = Array.from({ length: 68 }, (_, i) => landmarks[i] || { x: 0, y: 0 });
  return padded;
}

test('estimateYawPitch: head-on → yaw ≈ 0, pitch ≈ 0', () => {
  // 320x240 canvas, face center
  const lm = fakeLandmarks({
    36: { x: 110, y: 100 },   // left eye outer
    45: { x: 210, y: 100 },   // right eye outer
    30: { x: 160, y: 100 },   // nose tip
  });
  const yp = headpose.estimateYawPitch(lm);
  assert.ok(Math.abs(yp.yaw) < 0.05);
  assert.ok(Math.abs(yp.pitch) < 0.05);
});

test('estimateYawPitch: turned left (nose closer to left eye)', () => {
  const lm = fakeLandmarks({
    36: { x: 110, y: 100 },
    45: { x: 210, y: 100 },
    30: { x: 130, y: 100 },  // nose pulled left
  });
  const yp = headpose.estimateYawPitch(lm);
  assert.ok(yp.yaw < 0, 'yaw should be negative when nose is left of eye midpoint');
});

test('estimateYawPitch: looking up (nose above eyes)', () => {
  const lm = fakeLandmarks({
    36: { x: 110, y: 100 },
    45: { x: 210, y: 100 },
    30: { x: 160, y: 70 },   // nose above eye line
  });
  const yp = headpose.estimateYawPitch(lm);
  assert.ok(yp.pitch < 0, 'pitch should be negative when nose is above eyes');
});

test('isLookingAtScreen: head-on → true', () => {
  const lm = fakeLandmarks({
    36: { x: 110, y: 100 },
    45: { x: 210, y: 100 },
    30: { x: 160, y: 100 },
  });
  assert.equal(headpose.isLookingAtScreen(lm), true);
});

test('isLookingAtScreen: turned 45° → false', () => {
  // yaw ≈ atan2(noseOffset, eyeDist). eyeDist=100. To get yaw > 0.35 we need
  // |noseOffset| > 35.
  const lm = fakeLandmarks({
    36: { x: 110, y: 100 },
    45: { x: 210, y: 100 },
    30: { x: 130, y: 100 },  // 30px left of center — atan2(-30, 100) = -0.29, still in range
  });
  // Push it further:
  lm[30] = { x: 90, y: 100 };  // 70px left
  assert.equal(headpose.isLookingAtScreen(lm), false);
});

test('isLookingAtScreen: missing landmarks → true (be permissive)', () => {
  assert.equal(headpose.isLookingAtScreen(null), true);
  assert.equal(headpose.isLookingAtScreen([]), true);
  assert.equal(headpose.isLookingAtScreen(Array.from({ length: 30 }, () => ({ x: 0, y: 0 }))), true);
});
