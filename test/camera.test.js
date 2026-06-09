'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Stub ffmpeg-static to point at a fake script we control. The fake script
// accepts a `-y <dest>` and either:
//   - creates an empty file (signals "success but no image")
//   - creates a 1-byte file (signals "real" success)
//   - exits non-zero
//   - sleeps (forces a timeout)
//
// We use this to verify the fallback chain tries each candidate in order.
//
// v0.2.0-alpha.3: the camera module no longer requires ffmpeg-static
// — it uses ./ffmpeg-bin to resolve a vendored binary. We stub THAT
// instead by overriding `bundledFfmpegPath` in the module exports.

function makeFakeFfmpeg(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-fake-ffmpeg-'));
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, bin };
}

function cleanupFake(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Stubs the ffmpeg-bin resolver to return `fakeBin` from
 * `bundledFfmpegPath()`. Also clears the camera module's
 * require.cache entry so the new export is picked up.
 *
 * Returns an unstub() function the caller should call in `finally`.
 *
 * Why we stub the module and not a binary file:
 *   The new ffmpeg-bin module returns null when the expected binary
 *   file doesn't exist (graceful dev-mode behavior). To force a
 *   specific binary path, we have to override the export.
 */
function stubBundledFfmpeg(fakeBin) {
  const ffmpegBinPath = require.resolve('../src/ffmpeg-bin');
  const origCacheEntry = require.cache[ffmpegBinPath];
  // The real module's exports object — we want to preserve
  // supportedPlatforms() etc., only override bundledFfmpegPath.
  const realMod = origCacheEntry && origCacheEntry.exports;
  const stubMod = realMod ? Object.create(realMod) : {};
  stubMod.bundledFfmpegPath = () => fakeBin;
  // Bundled version reporter shouldn't matter for the capture
  // chain, but make it consistent: return a fixed string when the
  // fake binary is provided.
  stubMod.bundledFfmpegVersion = () => 'ffmpeg version 99.0.0-fake';
  require.cache[ffmpegBinPath] = {
    id: ffmpegBinPath,
    filename: ffmpegBinPath,
    loaded: true,
    exports: stubMod,
    children: [],
    paths: [],
  };
  return () => {
    delete require.cache[ffmpegBinPath];
    delete require.cache[require.resolve('../src/camera')];
    if (origCacheEntry) require.cache[ffmpegBinPath] = origCacheEntry;
  };
}

test('camera: bundled ffmpeg succeeds → resolve with dest', async () => {
  // Linux v4l2 arg layout (10 args, dest is the 10th):
  //   -f v4l2 -video_size WxH -i /dev/video0 -frames:v 1 -y <dest>
  // In sh, $0 is the script name and the args are $1..$10, so $10 is the dest.
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  const unstub = stubBundledFfmpeg(f.bin);
  try {
    delete require.cache[require.resolve('../src/camera')];
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), 'dest should end in .jpg');
    assert.ok(fs.existsSync(dest), 'dest should exist');
    assert.ok(fs.statSync(dest).size > 0, 'dest should be non-empty');
    c.stop();
  } finally {
    unstub();
    cleanupFake(f.dir);
  }
});

test('camera: all candidates fail → reject with actionable error', async () => {
  const f = makeFakeFfmpeg('exit 1'); // bundled ffmpeg always fails
  const unstub = stubBundledFfmpeg(f.bin);
  try {
    delete require.cache[require.resolve('../src/camera')];
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    await assert.rejects(
      c.capture(),
      (err) => {
        assert.match(err.message, /could not capture from camera/);
        assert.match(err.message, /ffmpeg/);
        // Error message now includes per-candidate diagnostic detail
        // (e.g. "exited with code 1" + ffmpeg stderr). Verify *some*
        // diagnostic is present.
        assert.ok(
          /exited with code|binary not found|spawn failed/.test(err.message),
          'error should include per-candidate diagnostic detail'
        );
        // err.failures is exposed for programmatic access (tests,
        // higher-level wrappers). Verify the shape.
        assert.ok(Array.isArray(err.failures), 'err.failures should be an array');
        assert.ok(err.failures.length > 0, 'err.failures should record at least one attempt');
        return true;
      }
    );
    c.stop();
  } finally {
    unstub();
    cleanupFake(f.dir);
  }
});

test('camera: _parseDshowListDevices returns the first video device', () => {
  const { Camera } = require('../src/camera');
  const c = new Camera({});
  // Realistic ffmpeg -list_devices stderr (Windows)
  const sample = [
    'ffmpeg version 6.1.1 Copyright (c) 2000-2026 the FFmpeg developers',
    '[dshow @ 0x55ab] DirectShow video devices',
    '[dshow @ 0x55ab]  "HD Webcam"',
    '[dshow @ 0x55ab]  "USB2.0 HD UVC WebCam"',
    '[dshow @ 0x55ab] DirectShow audio devices',
    '[dshow @ 0x55ab]  "Microphone (Realtek Audio)"',
    'Something went wrong with device string',
  ].join('\n');
  const got = c._parseDshowListDevices(sample);
  assert.strictEqual(got, 'HD Webcam', 'should pick the first video device, not the audio mic');
  c.stop();
});

test('camera: _parseDshowListDevices handles single-device list', () => {
  const { Camera } = require('../src/camera');
  const c = new Camera({});
  const sample = [
    'DirectShow video devices',
    '[dshow]  "Integrated Camera"',
  ].join('\n');
  assert.strictEqual(c._parseDshowListDevices(sample), 'Integrated Camera');
  c.stop();
});

test('camera: _parseDshowListDevices returns null on no markers', () => {
  const { Camera } = require('../src/camera');
  const c = new Camera({});
  const sample = 'random stderr with no dshow list at all';
  assert.strictEqual(c._parseDshowListDevices(sample), null);
  c.stop();
});

test('camera: _resolveDshowDevice is a no-op on non-Windows', () => {
  const { Camera } = require('../src/camera');
  const c = new Camera({ _probeDshowDevices: true });
  // On Linux, must return null immediately without spawning anything.
  const got = c._resolveDshowDevice();
  assert.strictEqual(got, null);
  c.stop();
});

test('camera: bundled ffmpeg missing the binary path → fall through', async () => {
  // v0.2.0-alpha.3: stub ffmpeg-bin to return a nonexistent path.
  const unstub = stubBundledFfmpeg('/nonexistent/ffmpeg');
  try {
    delete require.cache[require.resolve('../src/camera')];
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    // System ffmpeg likely doesn't exist in CI either; expect the final error.
    await assert.rejects(c.capture(), (err) => {
      assert.match(err.message, /could not capture from camera/);
      return true;
    });
    c.stop();
  } finally {
    unstub();
  }
});

// =====================================================================
// Native path (face-lock-camera) tests.
//
// These tests stub both the `face-lock-camera` module AND the
// `ffmpeg-bin` resolver via require.cache to verify the native code
// path in src/camera.js handles all five outcomes:
//   1. FACE_LOCK_NO_NATIVE=1                   → skip native entirely
//   2. require('face-lock-camera') throws      → fall through to ffmpeg
//   3. tryOpen() returns null                  → fall through to ffmpeg
//   4. captureJpeg() returns 0 bytes           → close + fall through
//   5. captureJpeg() returns bytes             → use them, skip ffmpeg
// And the env-var opt-out is honored.
//
// Stubbing strategy: face-lock-camera is NOT installed in this test
// env, so `require('face-lock-camera')` would normally throw. We
// intercept Module._resolveFilename to redirect that bare specifier
// to a known absolute path, then register that path in require.cache
// with our stub exports. Cleanup restores the original
// _resolveFilename in `finally`.
// =====================================================================

const NATIVE_MODULE_ID = 'face-lock-camera';
const NATIVE_STUB_PATH = path.join(__dirname, '_native_stub.js');
// v0.2.0-alpha.3: the camera module resolves its bundled ffmpeg via
// ./ffmpeg-bin (a vendored binary), not ffmpeg-static. We stub the
// ffmpeg-bin module's bundledFfmpegPath() to return the fake script.
const FFMPEG_BIN_PATH = require.resolve('../src/ffmpeg-bin');
const CAMERA_PATH = require.resolve('../src/camera');

// Write a minimal stub file ONCE. Its contents are never actually
// executed (we pre-populate require.cache with `loaded: true`), but
// the file must exist on disk for Module._load to be happy if the
// cache entry is ever cleared.
let _stubWritten = false;
function ensureStubFile() {
  if (_stubWritten) return;
  fs.writeFileSync(
    NATIVE_STUB_PATH,
    '// Auto-generated stub for camera.test.js native-path tests.\n' +
    '// Overwritten via require.cache — this file is never actually\n' +
    '// executed at runtime.\n' +
    'module.exports = {};\n'
  );
  _stubWritten = true;
}

function stubNative(stubExports) {
  ensureStubFile();
  // Pre-populate the cache at the stub path (used when
  // Module._resolveFilename is called and returns our stub path)
  require.cache[NATIVE_STUB_PATH] = {
    id: NATIVE_STUB_PATH,
    filename: NATIVE_STUB_PATH,
    loaded: true,
    exports: stubExports,
    children: [],
    paths: [],
  };
  // Intercept bare specifier resolution
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function patched(request, ...rest) {
    if (request === NATIVE_MODULE_ID) return NATIVE_STUB_PATH;
    return origResolve.call(this, request, ...rest);
  };
  // ALSO override the cache entry at the REAL resolved path.
  // Why: Node 22 maintains a `relativeResolveCache` (internal,
  // not exposed) that caches `${parent.path}\0${request}` →
  // resolved filename. It's consulted BEFORE Module._resolveFilename
  // and returns the cached filename directly. So even with our
  // _resolveFilename patch, a stale entry from a prior require
  // short-circuits to the real path. By replacing _cache[realPath]
  // with our stub, we win regardless of which path the resolution
  // takes.
  //
  // We resolve from the perspective of the test file (so the
  // node_modules lookup walks up to /root/face-lock/node_modules).
  const testModule = require.cache[__filename] || { filename: __filename };
  const realPath = origResolve.call(Module, NATIVE_MODULE_ID, testModule, false);
  const savedReal = require.cache[realPath];
  require.cache[realPath] = {
    id: realPath,
    filename: realPath,
    loaded: true,
    exports: stubExports,
    children: [],
    paths: [],
  };
  return () => {
    Module._resolveFilename = origResolve;
    delete require.cache[NATIVE_STUB_PATH];
    if (savedReal !== undefined) {
      require.cache[realPath] = savedReal;
    } else {
      delete require.cache[realPath];
    }
  };
}

function stubFfmpegStatic(binPath) {
  // v0.2.0-alpha.3: stub the new ffmpeg-bin resolver. We keep the
  // function name `stubFfmpegStatic` so existing call sites don't
  // change, but the underlying mechanism is different.
  const origCacheEntry = require.cache[FFMPEG_BIN_PATH];
  const realMod = origCacheEntry && origCacheEntry.exports;
  const stubMod = realMod ? Object.create(realMod) : {};
  stubMod.bundledFfmpegPath = () => binPath;
  stubMod.bundledFfmpegVersion = () => 'ffmpeg version 99.0.0-fake';
  require.cache[FFMPEG_BIN_PATH] = {
    id: FFMPEG_BIN_PATH,
    filename: FFMPEG_BIN_PATH,
    loaded: true,
    exports: stubMod,
    children: [],
    paths: [],
  };
}

function resetFfmpegStatic() {
  delete require.cache[FFMPEG_BIN_PATH];
}

function freshCamera() {
  // The proper cache-override dance: ensure both stubs are in place,
  // then delete the camera cache so it re-requires both modules on
  // its next load.
  delete require.cache[CAMERA_PATH];
  return require(CAMERA_PATH);
}

test('camera: FACE_LOCK_NO_NATIVE=1 → native path skipped, ffmpeg used', async () => {
  const origEnv = process.env.FACE_LOCK_NO_NATIVE;
  process.env.FACE_LOCK_NO_NATIVE = '1';
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  stubFfmpegStatic(f.bin);
  try {
    // nativeEnabled() must return false
    const { nativeEnabled } = freshCamera();
    assert.strictEqual(nativeEnabled(undefined), false,
      'nativeEnabled should return false when env var is set');

    // Re-stub after freshCamera (which deletes camera cache but
    // leaves the ffmpeg stub alone, so it should still be there)
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0 });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), `dest should end in .jpg, got ${dest}`);
    assert.ok(fs.existsSync(dest), `dest should exist, got ${dest}`);
    c.stop();
  } finally {
    resetFfmpegStatic();
    if (origEnv === undefined) delete process.env.FACE_LOCK_NO_NATIVE;
    else process.env.FACE_LOCK_NO_NATIVE = origEnv;
    cleanupFake(f.dir);
  }
});

test('camera: native module require fails at load → fall through to ffmpeg', async () => {
  // The real `face-lock-camera` is installed in this test env (via
  // the `file:./crates/face-lock-camera` dep in package.json), so
  // we must stub it to make `loadNative()` return null. We stub a
  // broken module (tryOpen returns null) to force the fall-through
  // path, then assert the native path was attempted.
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  stubFfmpegStatic(f.bin);
  const unstub = stubNative({
    listDevices: () => { throw new Error('simulated load failure'); },
    tryOpen: () => null,
    Camera: function () { throw new Error('not used'); },
  });
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: true });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), `dest should end in .jpg, got ${dest}`);
    assert.ok(fs.existsSync(dest), `dest should exist, got ${dest}`);
    // The native path was attempted (because _useNative=true and
    // env var is unset). loadNative returned null (or listDevices
    // threw), nativeCapture threw, capture() fell through to ffmpeg.
    assert.strictEqual(c._nativeAttempted, true,
      'native path should have been attempted');
    assert.ok(c.nativeFailureMessage && c.nativeFailureMessage.length > 0,
      `nativeFailureMessage should be set, got: ${c.nativeFailureMessage}`);
    c.stop();
  } finally {
    unstub();
    resetFfmpegStatic();
    cleanupFake(f.dir);
  }
});

test('camera: native tryOpen returns null → fall through to ffmpeg', async () => {
  const unstub = stubNative({
    listDevices: () => [],
    tryOpen: () => null,
    Camera: function () { throw new Error('Camera not used in this test'); },
  });
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  stubFfmpegStatic(f.bin);
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: true });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), `dest should end in .jpg, got ${dest}`);
    assert.strictEqual(c._nativeAttempted, true,
      'native path should have been attempted');
    assert.match(c.nativeFailureMessage, /tryOpen returned null/,
      `nativeFailureMessage should be 'tryOpen returned null', got: ${c.nativeFailureMessage}`);
    c.stop();
  } finally {
    unstub();
    resetFfmpegStatic();
    cleanupFake(f.dir);
  }
});

test('camera: native tryOpen returns a handle, captureJpeg returns bytes → use them, skip ffmpeg', async () => {
  const validJpeg = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
  ]);
  let closed = 0;
  let openCount = 0;
  let captureCount = 0;
  const fakeHandle = {
    captureJpeg() { captureCount++; return validJpeg; },
    close() { closed++; },
  };
  const unstub = stubNative({
    listDevices: () => [{ index: 0, name: 'fake', backend: 'fake' }],
    tryOpen: () => { openCount++; return fakeHandle; },
    Camera: function () { return fakeHandle; },
  });
  // ffmpeg stub that EXITS NON-ZERO so we can tell the difference
  // between native and ffmpeg path
  const f = makeFakeFfmpeg('echo "FFMPEG WAS CALLED — should not be" >&2; exit 99');
  stubFfmpegStatic(f.bin);
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: true });
    const dest = await c.capture();
    assert.ok(dest.includes('frame-native-'),
      `dest should be the native-prefixed path, got ${dest}`);
    assert.ok(fs.existsSync(dest), 'native frame file should exist');
    const onDisk = fs.readFileSync(dest);
    assert.deepStrictEqual(onDisk, validJpeg,
      'file contents should equal the bytes captureJpeg returned');
    assert.strictEqual(openCount, 1, 'tryOpen should be called exactly once');
    assert.strictEqual(captureCount, 1, 'captureJpeg should be called once');
    c.stop();
    assert.strictEqual(closed, 1, 'close() should be called exactly once on stop()');
  } finally {
    unstub();
    resetFfmpegStatic();
    cleanupFake(f.dir);
  }
});

test('camera: native handle re-used across calls (no re-open per frame)', async () => {
  const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  let openCount = 0;
  let captureCount = 0;
  const fakeHandle = {
    captureJpeg() { captureCount++; return validJpeg; },
    close: () => {},
  };
  const unstub = stubNative({
    listDevices: () => [],
    tryOpen: () => { openCount++; return fakeHandle; },
    Camera: function () { return fakeHandle; },
  });
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: true });
    const a = await c.capture();
    const b = await c.capture();
    const d = await c.capture();
    // The dest path uses Date.now() with 1ms resolution — three
    // back-to-back calls may collide on fast hardware. The
    // meaningful signal is that tryOpen was called exactly once
    // (handle re-use) and captureJpeg was called 3 times.
    assert.ok(typeof a === 'string' && a.includes('frame-native-'),
      `a should be a native frame path, got ${a}`);
    assert.ok(typeof b === 'string' && b.includes('frame-native-'),
      `b should be a native frame path, got ${b}`);
    assert.ok(typeof d === 'string' && d.includes('frame-native-'),
      `d should be a native frame path, got ${d}`);
    assert.strictEqual(openCount, 1, 'tryOpen should be called exactly once across 3 captures');
    assert.strictEqual(captureCount, 3, 'captureJpeg should be called 3 times');
    c.stop();
  } finally {
    unstub();
  }
});

test('camera: native captureJpeg returns empty → close, fall through to ffmpeg', async () => {
  const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  let closed = 0;
  const badHandle = {
    captureJpeg: () => Buffer.alloc(0),
    close: () => { closed++; },
  };
  let handleIdx = 0;
  const handles = [badHandle, badHandle, badHandle];
  const unstub = stubNative({
    listDevices: () => [],
    tryOpen: () => handles[handleIdx++],
    Camera: function () { return handles[handleIdx - 1]; },
  });
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  stubFfmpegStatic(f.bin);
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: true });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), `dest should end in .jpg, got ${dest}`);
    assert.ok(!dest.includes('frame-native-'),
      'dest should be the ffmpeg path, not the native path');
    assert.strictEqual(closed, 1, 'bad handle should be closed after empty frame');
    c.stop();
  } finally {
    unstub();
    resetFfmpegStatic();
    cleanupFake(f.dir);
  }
});

test('camera: _useNative=false skips native path even with stub loaded', async () => {
  let openCount = 0;
  const unstub = stubNative({
    listDevices: () => [],
    tryOpen: () => { openCount++; return null; },
    Camera: function () {},
  });
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  stubFfmpegStatic(f.bin);
  try {
    const { Camera } = freshCamera();
    const c = new Camera({ index: 0, _useNative: false });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'));
    assert.strictEqual(openCount, 0,
      'tryOpen must NOT be called when _useNative=false');
    c.stop();
  } finally {
    unstub();
    resetFfmpegStatic();
    cleanupFake(f.dir);
  }
});
