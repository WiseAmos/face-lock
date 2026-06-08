'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const profile = require('../src/profile');

test('distance: identical descriptors → 0', () => {
  const d = [0.1, 0.2, 0.3];
  assert.equal(profile.distance(d, d), 0);
});

test('distance: commutative', () => {
  const a = [0.1, 0.2, 0.3, 0.4];
  const b = [0.4, 0.3, 0.2, 0.1];
  assert.equal(profile.distance(a, b), profile.distance(b, a));
});

test('distance: length mismatch throws', () => {
  assert.throws(() => profile.distance([1, 2], [1, 2, 3]));
});

test('match: same descriptor → match=true', () => {
  const p = { descriptor: new Array(128).fill(0).map((_, i) => i * 0.01) };
  const same = new Array(128).fill(0).map((_, i) => i * 0.01);
  const m = profile.match(p, same, 0.55);
  assert.equal(m.match, true);
  assert.equal(m.distance, 0);
});

test('match: random descriptor → match=false', () => {
  const p = { descriptor: new Array(128).fill(0).map((_, i) => i * 0.01) };
  const different = new Array(128).fill(0).map(() => Math.random() * 0.5);
  const m = profile.match(p, different, 0.55);
  assert.equal(m.match, false);
  assert.ok(m.distance > 0.55);
});

test('match: threshold tunable', () => {
  const a = new Array(128).fill(0).map((_, i) => i * 0.01);
  const b = a.map((v) => v + 0.001);
  // very small perturbation — should match at strict threshold
  assert.equal(profile.match({ descriptor: a }, b, 0.5).match, true);
});
