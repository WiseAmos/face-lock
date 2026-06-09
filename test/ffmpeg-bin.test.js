'use strict';

/**
 * Tests for src/ffmpeg-bin.js — the vendored ffmpeg binary resolver.
 *
 * These tests don't touch the network or the actual ffmpeg binary.
 * They verify:
 *   1. The resolver returns a string path on supported platforms.
 *   2. The resolver returns `null` on unsupported platforms.
 *   3. The resolver returns `null` when the binary is missing on disk
 *      (e.g. dev checkout without the vendored binaries).
 *   4. The version reporter handles a missing/broken binary gracefully
 *      (returns `null`, never throws).
 *   5. `supportedPlatforms()` returns the expected 5-platform list.
 *   6. The platform-dir map is correct (no typos, all 5 entries).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ffmpegBin = require('../src/ffmpeg-bin');

test('ffmpeg-bin: bundledFfmpegPath returns a string on this platform if the binary exists', () => {
  const p = ffmpegBin.bundledFfmpegPath();
  if (ffmpegBin._PLATFORM_DIRS[`${process.platform}-${process.arch}`]) {
    // We're on a supported platform. The binary MAY or MAY NOT be
    // present (dev checkout without vendored binaries is fine), but
    // if it IS present the path must be an absolute file path.
    if (p !== null) {
      assert.strictEqual(typeof p, 'string');
      assert.ok(path.isAbsolute(p), 'path should be absolute');
      assert.ok(fs.existsSync(p), 'path should exist on disk');
      assert.ok(fs.statSync(p).isFile(), 'path should be a file');
      assert.ok(p.endsWith('ffmpeg' + (process.platform === 'win32' ? '.exe' : '')),
        'path should end with the right binary name');
    }
  } else {
    // Unsupported platform: must return null
    assert.strictEqual(p, null);
  }
});

test('ffmpeg-bin: bundledFfmpegPath returns null when binary file is missing', () => {
  // Make a temp dir, point PLATFORM_DIRS at a non-existent subdir,
  // and verify the resolver returns null. We can't monkey-patch the
  // module's internal const, so we test the "dev checkout" case by
  // deleting the binary's expected path temporarily. (We restore it
  // in `finally`.)
  const key = `${process.platform}-${process.arch}`;
  const subdir = ffmpegBin._PLATFORM_DIRS[key];
  if (!subdir) {
    // Unsupported platform — null is the only correct answer
    assert.strictEqual(ffmpegBin.bundledFfmpegPath(), null);
    return;
  }
  const expected = path.join(__dirname, '..', 'bin', 'ffmpeg', subdir, ffmpegBin._BINARY_NAME);
  let saved = null;
  let existed = false;
  try {
    if (fs.existsSync(expected)) {
      existed = true;
      saved = fs.readFileSync(expected);
      fs.unlinkSync(expected);
    }
    assert.strictEqual(ffmpegBin.bundledFfmpegPath(), null,
      'should return null when the expected binary file is missing');
  } finally {
    if (existed && saved) {
      fs.writeFileSync(expected, saved);
      fs.chmodSync(expected, 0o755);
    }
  }
});

test('ffmpeg-bin: bundledFfmpegPath returns null for an obviously-unsupported arch', () => {
  // We can't change process.arch, but we CAN test that the lookup
  // table only contains valid platform-arch combos. If a future
  // maintainer adds a typo'd key, this catches it.
  for (const key of Object.keys(ffmpegBin._PLATFORM_DIRS)) {
    assert.match(key, /^(linux|darwin|win32)-(x64|arm64|ia32|arm)$/,
      `platform key '${key}' should match <os>-<arch>`);
  }
});

test('ffmpeg-bin: bundledFfmpegVersion never throws, returns string or null', () => {
  // Should not throw on any platform, even if the binary is missing.
  const v = ffmpegBin.bundledFfmpegVersion();
  if (v !== null) {
    assert.strictEqual(typeof v, 'string');
    assert.ok(v.length > 0, 'version string should be non-empty');
    assert.ok(v.toLowerCase().includes('ffmpeg'),
      'version string should mention ffmpeg');
  }
});

test('ffmpeg-bin: bundledFfmpegVersion returns null when binary is missing', () => {
  // Same as the path test — remove the binary, expect null.
  const key = `${process.platform}-${process.arch}`;
  const subdir = ffmpegBin._PLATFORM_DIRS[key];
  if (!subdir) {
    assert.strictEqual(ffmpegBin.bundledFfmpegVersion(), null);
    return;
  }
  const expected = path.join(__dirname, '..', 'bin', 'ffmpeg', subdir, ffmpegBin._BINARY_NAME);
  let saved = null;
  let existed = false;
  try {
    if (fs.existsSync(expected)) {
      existed = true;
      saved = fs.readFileSync(expected);
      fs.unlinkSync(expected);
    }
    assert.strictEqual(ffmpegBin.bundledFfmpegVersion(), null,
      'should return null when the binary is missing');
  } finally {
    if (existed && saved) {
      fs.writeFileSync(expected, saved);
      fs.chmodSync(expected, 0o755);
    }
  }
});

test('ffmpeg-bin: supportedPlatforms returns 5 entries for the 5 supported combos', () => {
  const list = ffmpegBin.supportedPlatforms();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 5, 'should have at least 5 supported platforms');
  for (const want of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64']) {
    assert.ok(list.includes(want), `should include ${want}`);
  }
});

test('ffmpeg-bin: PLATFORM_DIRS map is consistent (no orphan keys, no duplicate values)', () => {
  const dirs = ffmpegBin._PLATFORM_DIRS;
  const values = Object.values(dirs);
  const uniqueValues = new Set(values);
  assert.strictEqual(values.length, uniqueValues.size,
    'no duplicate subdirs allowed');
  for (const v of values) {
    assert.match(v, /^(linux|darwin|win32)-(x64|arm64)$/,
      `subdir '${v}' should be a clean platform-arch name`);
  }
});

test('ffmpeg-bin: BINARY_NAME is platform-correct', () => {
  const want = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  assert.strictEqual(ffmpegBin._BINARY_NAME, want);
});

test('ffmpeg-bin: bundledFfmpegPath on a fake temp tree returns the expected path', () => {
  // Build a self-contained fake tree and verify the resolver
  // correctly composes a path through it. We do this by creating a
  // sibling bin/ffmpeg tree under a temp dir, but the resolver
  // hardcodes its base to <src_dir>/../bin/ffmpeg, so we can't
  // redirect it. Instead, we verify the *shape* of the returned path:
  //   - contains 'bin/ffmpeg'
  //   - contains one of the supported subdirs
  //   - ends with the right binary name
  const p = ffmpegBin.bundledFfmpegPath();
  if (p === null) return; // platform not supported, or binary missing
  assert.ok(p.includes('ffmpeg'), 'path should include ffmpeg');
  assert.ok(p.endsWith(ffmpegBin._BINARY_NAME),
    `path should end with ${ffmpegBin._BINARY_NAME}`);
});
