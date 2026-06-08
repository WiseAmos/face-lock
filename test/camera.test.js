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

function makeFakeFfmpeg(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-fake-ffmpeg-'));
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, bin };
}

function cleanupFake(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

test('camera: bundled ffmpeg succeeds → resolve with dest', async () => {
  // Linux v4l2 arg layout (10 args, dest is the 10th):
  //   -f v4l2 -video_size WxH -i /dev/video0 -frames:v 1 -y <dest>
  // In sh, $0 is the script name and the args are $1..$10, so $10 is the dest.
  const f = makeFakeFfmpeg('DEST="${10}"; echo "fake frame" > "$DEST"; exit 0');
  const ffmpegStaticPath = require.resolve('ffmpeg-static');
  const orig = require.cache[ffmpegStaticPath];
  require.cache[ffmpegStaticPath] = { exports: f.bin };
  try {
    delete require.cache[require.resolve('../src/camera')];
    delete require.cache[ffmpegStaticPath];
    require.cache[ffmpegStaticPath] = { exports: f.bin };
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    const dest = await c.capture();
    assert.ok(dest.endsWith('.jpg'), 'dest should end in .jpg');
    assert.ok(fs.existsSync(dest), 'dest should exist');
    assert.ok(fs.statSync(dest).size > 0, 'dest should be non-empty');
    c.stop();
  } finally {
    delete require.cache[ffmpegStaticPath];
    delete require.cache[require.resolve('../src/camera')];
    if (orig) require.cache[ffmpegStaticPath] = orig;
    cleanupFake(f.dir);
  }
});

test('camera: all candidates fail → reject with actionable error', async () => {
  const f = makeFakeFfmpeg('exit 1'); // bundled ffmpeg always fails
  const ffmpegStaticPath = require.resolve('ffmpeg-static');
  const orig = require.cache[ffmpegStaticPath];
  require.cache[ffmpegStaticPath] = { exports: f.bin };
  try {
    delete require.cache[require.resolve('../src/camera')];
    delete require.cache[ffmpegStaticPath];
    require.cache[ffmpegStaticPath] = { exports: f.bin };
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    await assert.rejects(
      c.capture(),
      (err) => {
        assert.match(err.message, /could not capture from camera/);
        assert.match(err.message, /ffmpeg/);
        // Error message includes platform-specific hints — verify *some*
        // hint is present (we don't hardcode which one because the test
        // platform varies).
        assert.ok(
          /Windows:|macOS:|Linux:/.test(err.message),
          'error should include at least one platform-specific hint'
        );
        return true;
      }
    );
    c.stop();
  } finally {
    delete require.cache[ffmpegStaticPath];
    delete require.cache[require.resolve('../src/camera')];
    if (orig) require.cache[ffmpegStaticPath] = orig;
    cleanupFake(f.dir);
  }
});

test('camera: bundled ffmpeg missing the binary path → fall through', async () => {
  const ffmpegStaticPath = require.resolve('ffmpeg-static');
  const orig = require.cache[ffmpegStaticPath];
  // Point at a path that does NOT exist
  require.cache[ffmpegStaticPath] = { exports: '/nonexistent/ffmpeg' };
  try {
    delete require.cache[require.resolve('../src/camera')];
    delete require.cache[ffmpegStaticPath];
    require.cache[ffmpegStaticPath] = { exports: '/nonexistent/ffmpeg' };
    const { Camera } = require('../src/camera');
    const c = new Camera({ index: 0 });
    // System ffmpeg likely doesn't exist in CI either; expect the final error.
    await assert.rejects(c.capture(), (err) => {
      assert.match(err.message, /could not capture from camera/);
      return true;
    });
    c.stop();
  } finally {
    delete require.cache[ffmpegStaticPath];
    delete require.cache[require.resolve('../src/camera')];
    if (orig) require.cache[ffmpegStaticPath] = orig;
  }
});
