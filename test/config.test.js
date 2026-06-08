'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../src/config');

test('DEFAULTS contains 15s grace', () => {
  assert.equal(cfg.DEFAULTS.graceMs, 15000);
});

test('load returns defaults when file missing', () => {
  const tmp = path.join(os.tmpdir(), `face-lock-test-${Date.now()}-missing.json`);
  const c = cfg.load(tmp);
  assert.equal(c.graceMs, 15000);
  assert.equal(c.matchThreshold, 0.55);
  assert.equal(c.profilePath.length > 0, true);
});

test('save then load round-trip', () => {
  const tmp = path.join(os.tmpdir(), `face-lock-test-${Date.now()}-rt.json`);
  const original = { ...cfg.DEFAULTS, graceMs: 20000, profilePath: '/tmp/x' };
  cfg.save(original, tmp);
  const loaded = cfg.load(tmp);
  assert.equal(loaded.graceMs, 20000);
  assert.equal(loaded.profilePath, '/tmp/x');
  // other defaults are merged in
  assert.equal(loaded.matchThreshold, 0.55);
  fs.unlinkSync(tmp);
});

test('save sets 0600 perms on the file', () => {
  const tmp = path.join(os.tmpdir(), `face-lock-test-${Date.now()}-perms.json`);
  cfg.save({ ...cfg.DEFAULTS }, tmp);
  const s = fs.statSync(tmp);
  // mask to permission bits, ignore file-type bits
  assert.equal((s.mode & 0o777), 0o600);
  fs.unlinkSync(tmp);
});
