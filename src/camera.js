'use strict';

/**
 * Camera frame source.
 *
 * Returns a path to a saved JPEG. The detector then loads that JPEG.
 *
 * Strategy (in order of preference):
 *   0. `face-lock-camera` — native NAPI binding. v0.3.x+ only. Rust +
 *      nokhwa over V4L2 (Linux) / MSMF (Windows) / AVFoundation (macOS).
 *      The fastest and most reliable path on real hardware — no
 *      shell-spawn overhead, no friendly-name guessing. Loaded lazily
 *      via `require('face-lock-camera')`; if the native binary is
 *      missing we silently fall through. v0.2.0-alpha.3 forces this
 *      path OFF (see `nativeEnabled` below) because we don't ship
 *      prebuilt binaries yet.
 *   1. Bundled ffmpeg binary in `bin/ffmpeg/<platform>-<arch>/`. This
 *      is the PRIMARY capture path for v0.2.0-alpha.3. Vendored
 *      directly in the npm tarball (no install-time download) so
 *      `npm i -g face-lock` Just Works on Win/Mac/Linux without
 *      users having to install ffmpeg themselves. See
 *      `src/ffmpeg-bin.js` for the resolver.
 *   2. A system `ffmpeg` on PATH (Linux distros where the user
 *      installed it via apt/brew, or via the postinstall wizard's
 *      "install ffmpeg" prompt — though we don't do that yet).
 *   3. On macOS, `imagesnap` (legacy fallback — usually absent on
 *      modern Macs, hence the priority order).
 *   4. `node-webcam` (legacy) — kept in the fallback chain for
 *      completeness.
 *
 * Why we vendor ffmpeg instead of depending on ffmpeg-static:
 *   ffmpeg-static's postinstall downloads a binary from GitHub
 *   releases. That download fails for ~5% of users (rate limits,
 *   corporate firewalls, antivirus blocking the .gz, the GitHub
 *   release asset 404s, etc.). When it fails, the user sees a
 *   cryptic ENOENT on `ffmpeg` and we can't help them. Vendoring
 *   the binary in the tarball trades ~80MB of tarball size for
 *   zero install-time network = reliable install on every
 *   supported platform.
 *
 * Windows dshow device name:
 *   ffmpeg's dshow backend requires the *exact* friendly name of the
 *   camera (e.g. "HD Webcam", "Integrated Camera", "USB2.0 HD UVC
 *   WebCam"). The "USB Camera" default that 0.1.4 hardcoded rarely
 *   matches real devices, which caused "ffmpeg ran but produced 0-byte
 *   output → fallback exhausted" errors. On Windows we now probe
 *   `ffmpeg -list_devices true -f dshow -i dummy` at first capture and
 *   use the first video device we find. Cached on the Camera instance.
 *
 * If everything fails, throws an error that includes the OS, the
 * platform binary path, and the exact `ffmpeg` command that was tried,
 * so the user can debug without grepping source.
 *
 * Native module opt-out (v0.2.x):
 *   v0.2.0-alpha.3 does NOT ship the native module. `nativeEnabled`
 *   hard-returns `false` for this release. The constructor option
 *   `_useNative: false|true` and the env var `FACE_LOCK_NO_NATIVE=1`
 *   are preserved so v0.3.x is a one-line change away.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Bundled ffmpeg binary. We vendor the binary directly in the npm
// tarball (bin/ffmpeg/<platform>-<arch>/) instead of depending on
// ffmpeg-static — ffmpeg-static's install-time download from GitHub
// releases fails for ~5% of users (rate limits, corporate firewalls,
// antivirus), and we don't want install-hangs. See
// src/ffmpeg-bin.js for the resolver.
const ffmpegBin = require('./ffmpeg-bin');
const bundledFfmpeg = ffmpegBin.bundledFfmpegPath();

let nodeWebcam = null;
try {
  // eslint-disable-next-line global-require
  nodeWebcam = require('node-webcam');
} catch (_) {
  // not installed
}

// Native module: loaded lazily. The require itself is wrapped in
// try/catch so a missing binary (unsupported platform) degrades to
// ffmpeg rather than crashing the whole app.
let native = null;
let nativeLoadError = null;
function loadNative() {
  if (native !== null || nativeLoadError !== null) return native;
  try {
    // eslint-disable-next-line global-require
    native = require('face-lock-camera');
  } catch (e) {
    nativeLoadError = e;
  }
  return native;
}

const NATIVE_OPT_OUT_ENV = 'FACE_LOCK_NO_NATIVE';
/**
 * Returns true if the native code path should be tried.
 *
 * v0.2.0-alpha.3 does NOT ship the `face-lock-camera` binary in the
 * npm tarball (the per-platform prebuilds land in v0.3.x). We detect
 * that the binary is "actually usable" by trying to `require.resolve`
 * the package:
 *
 *   - resolve succeeds (package is on disk)         → use the real logic:
 *       constructor opt-out, env var escape hatch
 *   - resolve throws (package not installed)        → return false
 *       (the v0.2.x production install case)
 *
 * This means:
 *   - npm-published v0.2.0-alpha.3 (no native dep)
 *     → nativeEnabled always returns false → bundled ffmpeg is used.
 *   - Dev / test checkout with the `file:./crates/face-lock-camera`
 *     dep → nativeEnabled respects the original logic, so the
 *     existing native-path tests still exercise the code.
 *
 * Constructor option is `_useNative`:
 *   - `_useNative: true`  → use native (default behavior when
 *                            the module is installed)
 *   - `_useNative: false` → skip native, go straight to ffmpeg
 *   - `_useNative: undefined` → use native unless env var opts out
 *
 * The env var `FACE_LOCK_NO_NATIVE=1` is a global escape hatch that
 * forces ffmpeg-only mode regardless of the constructor option.
 */
function nativeEnabled(useNative) {
  let installed = false;
  try {
    // eslint-disable-next-line global-require
    require.resolve('face-lock-camera');
    installed = true;
  } catch (_) {
    installed = false;
  }
  if (!installed) return false; // v0.2.x production: always fall through
  if (useNative === false) return false; // explicit opt-out
  // any other value (true or undefined) → default on, but env var
  // can still disable it
  return !process.env[NATIVE_OPT_OUT_ENV];
}

class Camera {
  constructor({
    index = -1,
    width = 320,
    height = 240,
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-lock-')),
    // Inject for tests: skip the device probe
    _probeDshowDevices = true,
    // Inject for tests: skip the native path entirely
    _useNative = undefined,
  } = {}) {
    this.index = index;
    this.width = width;
    this.height = height;
    this.outputDir = outputDir;
    this.lastTried = null; // for error messages
    this._probeDshowDevices = _probeDshowDevices;
    this._dshowDevice = null; // cached after first probe
    this._useNative = _useNative;
    this._nativeHandle = null; // the native Camera instance, opened lazily
  }

  async capture() {
    // Try the native path first. The cost of probing is a `require()` +
    // a `tryOpen()` (synchronous, ~1ms on success, ~0ms on null). If
    // either fails we fall through to the existing async paths.
    if (nativeEnabled(this._useNative)) {
      this._nativeAttempted = true;
      try {
        return await this.nativeCapture();
      } catch (e) {
        // Native path failed. Record both the message (for debug) and
        // mark this attempt for telemetry. We do NOT overwrite
        // `lastTried` here — that field is meant to record the last
        // command we actually ran, and the ffmpeg path may overwrite
        // it on success. The native failure is preserved in
        // `nativeFailureMessage` for the test/error path.
        this.nativeFailureMessage = e.message;
      }
    } else {
      this._nativeAttempted = false;
    }

    if (nodeWebcam) {
      try {
        return await this.nodeWebcamCapture();
      } catch (e) {
        // fall through to ffmpeg — node-webcam is unreliable cross-platform
      }
    }
    return this.ffmpegCapture();
  }

  /**
   * Native capture path (v0.2.0+).
   *
   * Opens the device via `tryOpen()` (which returns null on failure
   * rather than throwing — that's the whole point of the Option Y
   * design). If we got a handle, we call `captureJpeg()` and write
   * the resulting Buffer to a temp file. The downstream detector
   * expects a file path, not a buffer, so we always go through disk.
   *
   * Re-uses the same handle across calls — opening the device is the
   * expensive part (~30-100ms on real hardware). Close is deferred to
   * `stop()` or the first capture error (so a transient device error
   * retries the open next call).
   */
  async nativeCapture() {
    const mod = loadNative();
    if (!mod) throw new Error('face-lock-camera: native module not available');

    if (!this._nativeHandle) {
      this._nativeHandle = mod.tryOpen(this.index, this.width, this.height);
      if (!this._nativeHandle) {
        // No device, or permission denied, or busy. The ffmpeg path
        // can still work in the first two cases (different process,
        // different permission model), so we surface this as a normal
        // "try next" signal — the outer `capture()` swallows the throw.
        throw new Error('tryOpen returned null');
      }
    }

    const jpeg = this._nativeHandle.captureJpeg();
    if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) {
      // Bad frame — close the handle so the next capture re-opens,
      // and bail out to the fallback.
      try { this._nativeHandle.close(); } catch (_) { /* */ }
      this._nativeHandle = null;
      throw new Error('captureJpeg returned empty buffer');
    }

    const dest = path.join(this.outputDir, `frame-native-${Date.now()}.jpg`);
    fs.writeFileSync(dest, jpeg);
    return dest;
  }

  nodeWebcamCapture() {
    const filename = `frame-${Date.now()}.jpg`;
    const dest = path.join(this.outputDir, filename);
    return new Promise((resolve, reject) => {
      const opts = {
        width: this.width,
        height: this.height,
        quality: 70,
        output: 'jpeg',
        device: this.index >= 0 ? this.index : false,
        callbackReturn: 'location',
        verbose: false,
      };
      nodeWebcam.capture(filename, opts, (err) => {
        if (err) return reject(err);
        const tried = fs.existsSync(dest) ? dest : path.join(process.cwd(), filename);
        if (!fs.existsSync(tried)) {
          return reject(new Error(`capture: file not found at ${tried}`));
        }
        resolve(tried);
      });
    });
  }

  /**
   * Build the ffmpeg command for the current platform.
   * Windows: DirectShow. macOS/Linux: avfoundation / v4l2.
   * On macOS we also accept the legacy "USB Camera" device name.
   *
   * `win32DeviceName` (used only on win32) is the friendly name of the
   * dshow device — we default to "USB Camera" but the caller should
   * normally have resolved it via `_resolveDshowDevice()` first.
   */
  ffmpegArgs(dest, win32DeviceName) {
    const w = this.width;
    const h = this.height;
    const idx = this.index >= 0 ? this.index : 0;
    switch (os.platform()) {
      case 'darwin':
        // macOS 14+ uses "FaceTime HD Camera" or "USB Camera" etc.
        return [
          '-f', 'avfoundation',
          '-framerate', '30',
          '-video_size', `${w}x${h}`,
          '-i', 'default',
          '-frames:v', '1',
          '-y', dest,
        ];
      case 'linux':
        return [
          '-f', 'v4l2',
          '-video_size', `${w}x${h}`,
          '-i', `/dev/video${idx}`,
          '-frames:v', '1',
          '-y', dest,
        ];
      case 'win32':
        return [
          '-f', 'dshow',
          '-i', `video=${win32DeviceName || 'USB Camera'}`,
          '-video_size', `${w}x${h}`,
          '-frames:v', '1',
          '-y', dest,
        ];
      default:
        throw new Error(`unsupported platform: ${os.platform()}`);
    }
  }

  /**
   * ffmpeg args for continuous MJPEG-to-stdout streaming. Used by
   * startStream()/readFrame() so we open the device ONCE per monitor
   * session instead of every 500ms (which causes the camera LED +
   * "your camera is in use" toast to flash 2x/second on Windows).
   *
   * Strategy: `-f image2pipe -vcodec mjpeg -` writes a stream of JPEG
   * frames concatenated together, each frame starting with SOI (0xFF 0xD8)
   * and ending with EOI (0xFF 0xD9). The consumer splits on those markers.
   *
   * `-r 2` sets a low output frame rate (2 fps) because the monitor only
   * needs ~2 frames/sec to react. Lowering fps reduces CPU + camera
   * bandwidth + noise.
   */
  ffmpegStreamArgs(win32DeviceName) {
    const w = this.width;
    const h = this.height;
    const idx = this.index >= 0 ? this.index : 0;
    switch (os.platform()) {
      case 'darwin':
        return [
          '-f', 'avfoundation',
          '-framerate', '30',
          '-video_size', `${w}x${h}`,
          '-i', 'default',
          '-r', '2',
          '-vcodec', 'mjpeg',
          '-f', 'image2pipe',
          '-',
        ];
      case 'linux':
        return [
          '-f', 'v4l2',
          '-video_size', `${w}x${h}`,
          '-i', `/dev/video${idx}`,
          '-r', '2',
          '-vcodec', 'mjpeg',
          '-f', 'image2pipe',
          '-',
        ];
      case 'win32':
        return [
          '-f', 'dshow',
          '-i', `video=${win32DeviceName || 'USB Camera'}`,
          '-video_size', `${w}x${h}`,
          '-r', '2',
          '-vcodec', 'mjpeg',
          '-f', 'image2pipe',
          '-',
        ];
      default:
        throw new Error(`unsupported platform: ${os.platform()}`);
    }
  }

  /**
   * On Windows, ask ffmpeg to list available dshow devices and return
   * the friendly name of the first VIDEO device. Cached on the instance.
   *
   * Returns null on non-Windows, when probing is disabled (tests), or
   * when the probe fails (we fall through to the hardcoded "USB
   * Camera" default).
   *
   * ffmpeg's stderr output for
   * `ffmpeg -list_devices true -f dshow -i dummy` looks like:
   *
   *   [dshow @ 0x...] DirectShow video devices
   *   [dshow @ 0x...]  "HD Webcam"
   *   [dshow @ 0x...]  "USB2.0 HD UVC WebCam"
   *   [dshow @ 0x...] DirectShow audio devices
   *   [dshow @ 0x...]  "Microphone (Realtek Audio)"
   *
   * We grab every quoted string that appears AFTER "DirectShow video
   * devices" and BEFORE "DirectShow audio devices" (or end of output).
   */
  _resolveDshowDevice() {
    if (os.platform() !== 'win32') return null;
    if (!this._probeDshowDevices) return null;
    if (this._dshowDevice !== null) return this._dshowDevice; // cached (even if empty string)

    this._dshowDevice = ''; // sentinel: we tried

    const tryCmds = [];
    if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) tryCmds.push(bundledFfmpeg);
    tryCmds.push('ffmpeg.exe');

    for (const cmd of tryCmds) {
      let bin = cmd;
      let args;
      if (cmd === 'ffmpeg.exe') {
        args = ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
      } else {
        // Bundled ffmpeg on Windows is ffmpeg.exe with the same args
        args = ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
      }
      let r;
      try {
        r = spawnSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {
        continue;
      }
      if (r.error) continue;
      const out = (r.stderr || '') + (r.stdout || '');
      const device = this._parseDshowListDevices(out);
      if (device) {
        this._dshowDevice = device;
        return device;
      }
    }
    return '';
  }

  /**
   * Parse ffmpeg's `-list_devices` stderr output. Returns the first
   * video device name, or null if none found. Pure function — exposed
   * for tests.
   *
   * Two output formats are supported:
   *
   * 1. ffmpeg 4.x / most builds — prints marker headers:
   *
   *      [dshow @ 0x...] DirectShow video devices
   *      [dshow @ 0x...]  "HD Webcam"
   *      [dshow @ 0x...]  "USB2.0 HD UVC WebCam"
   *      [dshow @ 0x...] DirectShow audio devices
   *      [dshow @ 0x...]  "Microphone (Realtek Audio)"
   *
   * 2. ffmpeg 6.0 from gyan.dev (the build we vendor for win32-x64) —
   *    omits the markers, lists devices inline with `(video)` / `(audio)` tags:
   *
   *      [dshow @ 0x...] "ACER FHD User Facing" (video)
   *      [dshow @ 0x...]   Alternative name "@device_pnp_..."
   *      [dshow @ 0x...] "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)" (audio)
   *      dummy: Immediate exit requested
   *
   * Strategy: split into lines, walk the lines, and find the first
   * quoted string on a line that has `(video)` AFTER the closing
   * quote. The "Alternative name" lines have the same structure but
   * precede the device name; we skip past them by requiring `(video)`
   * on the same line.
   */
  _parseDshowListDevices(output) {
    // 1) Marker-header format (most ffmpeg builds). Look for the
    //    "DirectShow video devices" / "DirectShow audio devices"
    //    block boundaries and grab the first quoted name inside.
    const VIDEO_START = 'DirectShow video devices';
    const VIDEO_END = 'DirectShow audio devices';
    const vi = output.indexOf(VIDEO_START);
    if (vi >= 0) {
      let block = output.slice(vi + VIDEO_START.length);
      const ai = block.indexOf(VIDEO_END);
      if (ai >= 0) block = block.slice(0, ai);
      // Lines look like:  [dshow @ 0x...]  "Device Name"   (optional: (video))
      // Match the FIRST quoted string in the video block. Strip
      // "Alternative name" lines by requiring the device-name form
      // (no leading "Alternative name" token before the quote).
      // We use a non-greedy match for the quoted content and require
      // the line to start with a [dshow @ ...] prefix.
      const lines = block.split(/\r?\n/);
      for (const line of lines) {
        // Skip "Alternative name" lines and lines that don't have a
        // dshow prefix (the header marker lines themselves, blank
        // lines, etc.). We accept "[dshow]" or "[dshow @ 0x...]" —
        // the exact contents after [dshow vary by ffmpeg build.
        if (/Alternative name/.test(line)) continue;
        if (!/^\[dshow(\s+@[\s\S]*)?\]/i.test(line.trim())) continue;
        // Grab the first quoted string on this line.
        const m = line.match(/"([^"]+)"/);
        if (m) return m[1].trim();
      }
      // Fall through to the inline-tag parser below.
    }

    // 2) Inline-tag format (gyan.dev ffmpeg 6.0 build). No markers;
    //    devices are listed with `(video)` / `(audio)` tags appended.
    //    Find the first quoted name that is followed by ` (video)`.
    //    We scan line-by-line to avoid matching the "Alternative name"
    //    pattern (which is a quoted GUID/pnp-path, NOT a friendly name).
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (/Alternative name/i.test(line)) continue;
      // Match:  ... "Some Device Name" (video)
      // The closing quote must be immediately followed by ` (video)`
      // (with optional whitespace). The non-greedy `+?` inside the
      // quotes prevents matching across multiple quoted segments.
      const m = line.match(/"([^"]+?)"\s*\(video\)/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  ffmpegCapture() {
    // On Windows, resolve the dshow device name (probes once, then
    // cached).
    let win32DeviceName;
    if (os.platform() === 'win32') {
      win32DeviceName = this._resolveDshowDevice() || 'USB Camera';
    }

    const dest = path.join(this.outputDir, `frame-${Date.now()}.jpg`);
    const args = this.ffmpegArgs(dest, win32DeviceName);
    const tryOrder = [];
    if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) tryOrder.push(bundledFfmpeg);
    // System ffmpeg last — PATH lookup. We don't know if it exists
    // until spawn.
    tryOrder.push(os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (os.platform() === 'darwin') tryOrder.push('imagesnap');

    // Per-candidate failure log so the final error can show *what
    // ffmpeg actually said*, not just "we tried these binaries".
    // Each entry: { cmd, reason: 'enoent'|'exit'|'spawn-error',
    //                code?: number, stderr?: string }
    const failures = [];
    const debug = !!process.env.FACE_LOCK_CAMERA_DEBUG;

    return new Promise((resolve, reject) => {
      const tryNext = (i) => {
        if (i >= tryOrder.length) {
          // All candidates exhausted. Build a diagnostic error that
          // shows what each one actually did — not just the path list.
          // This is the single biggest UX bug in 0.2.0-alpha.3: when
          // bundled ffmpeg ran but failed (dshow can't find device,
          // permission denied, etc.), the user used to see a generic
          // "check your webcam" hint with no idea which camera backend
          // actually failed. Now they see the real ffmpeg stderr.
          let detail = '';
          for (const f of failures) {
            const tag = `[${f.cmd}]`;
            if (f.reason === 'enoent') {
              detail += `\n  ${tag} binary not found (ENOENT)`;
            } else if (f.reason === 'spawn-error') {
              detail += `\n  ${tag} spawn failed: ${f.stderr || '(no stderr)'}`;
            } else {
              // exit with non-zero (or zero but no file)
              const tail = (f.stderr || '').trim().split('\n').slice(-8).join('\n      ');
              detail += `\n  ${tag} exited with code ${f.code}${tail ? '\n      ' + tail : ''}`;
            }
          }
          const err = new Error(
            `could not capture from camera. Tried ${failures.length} candidate(s):${detail}\n` +
            `On Windows: check that a webcam is connected and not in use (close Zoom, Skype, Discord, etc.), ` +
            `and that your terminal app has Camera permission in Windows Settings → Privacy & Security → Camera.\n` +
            `On macOS:  the system may need camera permission for the terminal app. System Settings → Privacy & Security → Camera.\n` +
            `On Linux:  verify /dev/video${this.index >= 0 ? this.index : 0} exists and is readable.\n` +
            `Run with FACE_LOCK_CAMERA_DEBUG=1 to see the full ffmpeg stderr for each candidate.`
          );
          err.code = 'CAMERA_NOT_AVAILABLE';
          err.failures = failures; // programmatic access for tests
          return reject(err);
        }
        const cmd = tryOrder[i];
        this.lastTried = cmd;
        const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (b) => {
          const s = b.toString();
          stderr += s;
          if (debug) process.stderr.write(`[${cmd}] ${s}`);
        });
        child.on('error', (err) => {
          if (err.code === 'ENOENT') {
            failures.push({ cmd, reason: 'enoent' });
            return tryNext(i + 1);
          }
          // Real error from the binary — don't fall through
          failures.push({ cmd, reason: 'spawn-error', stderr: err.message + (stderr ? '\n' + stderr : '') });
          reject(new Error(`camera cmd failed (${cmd}): ${err.message}\nstderr:\n${stderr.slice(0, 500)}`));
        });
        child.on('exit', (code) => {
          if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            return resolve(dest);
          }
          // ffmpeg ran but produced nothing — record the failure
          // with the actual stderr so the final error can show it.
          // Then try the next candidate (system ffmpeg or imagesnap).
          failures.push({ cmd, reason: 'exit', code, stderr });
          tryNext(i + 1);
        });
      };
      tryNext(0);
    });
  }

  stop() {
    // Close the native handle if we have one. Idempotent — close() is
    // a no-op when called twice.
    if (this._nativeHandle) {
      try { this._nativeHandle.close(); } catch (_) { /* */ }
      this._nativeHandle = null;
    }
    // Also stop any active stream — the parent should call stopStream()
    // explicitly, but defensive cleanup avoids a leaked ffmpeg process.
    if (this._streamChild) {
      try { this._streamChild.kill('SIGKILL'); } catch (_) { /* */ }
      this._streamChild = null;
    }
    try {
      const files = fs.readdirSync(this.outputDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.outputDir, f)); } catch (_) { /* */ }
      }
      fs.rmdirSync(this.outputDir);
    } catch (_) { /* */ }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Continuous stream API (v0.2.0-alpha.8+)
  //
  // The single-shot capture() path opens the camera device, takes one
  // frame, and closes — every 500ms. On Windows that produces a visible
  // LED flash and a "your camera is in use" toast that flickers 2x/second.
  // The stream path keeps ffmpeg alive for the entire monitor session and
  // pulls frames from its stdout instead.
  //
  // Lifecycle: startStream() → readFrame()* → stopStream(). The stream
  // emits MJPEG frames to stdout; we split them on SOI/EOI markers and
  // surface the most recent complete frame to readFrame().
  // ─────────────────────────────────────────────────────────────────────

  async startStream() {
    if (this._streamChild) {
      throw new Error('stream already running — call stopStream() first');
    }

    // Resolve dshow device name on Windows (cached after first call).
    let win32DeviceName;
    if (os.platform() === 'win32') {
      win32DeviceName = this._resolveDshowDevice() || 'USB Camera';
    }

    const args = this.ffmpegStreamArgs(win32DeviceName);

    // Same try-order as ffmpegCapture(): bundled first, system ffmpeg
    // second. We pick the first one that spawns successfully (does NOT
    // mean "produces frames" — ffmpeg could still error on dshow later,
    // but at least the binary exists). If bundled spawn errors with
    // ENOENT we fall through to system ffmpeg.
    const tryOrder = [];
    if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) tryOrder.push(bundledFfmpeg);
    tryOrder.push(os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

    const debug = !!process.env.FACE_LOCK_CAMERA_DEBUG;
    const failures = [];
    let lastErr = null;

    for (const cmd of tryOrder) {
      try {
        const child = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
        // If spawn succeeded synchronously (no ENOENT), wire up parsers
        // and return. The caller (startStream's awaiter) waits for the
        // first frame via `_streamReady`.
        this._streamChild = child;
        this._streamCmd = cmd;
        this.lastTried = cmd;
        this._streamBuf = Buffer.alloc(0);
        this._latestFrame = null;
        this._streamEnded = false;
        this._streamReady = null;
        this._streamReadyResolve = null;
        this._streamReadyReject = null;

        // Re-emit stderr for debugging (same shape as ffmpegCapture).
        let stderr = '';
        child.stderr.on('data', (b) => {
          const s = b.toString();
          stderr += s;
          if (debug) process.stderr.write(`[${cmd}] ${s}`);
        });
        child.on('error', (err) => {
          // Spawn-time error after we already attached. Most common:
          // ffmpeg exists but cannot open the device (dshow EIO, etc.).
          this._streamEnded = true;
          if (this._streamReadyReject) {
            this._streamReadyReject(err);
            this._streamReadyResolve = null;
            this._streamReadyReject = null;
          }
        });
        child.on('exit', (code) => {
          this._streamEnded = true;
          // If we were still waiting for the first frame, this counts
          // as a startup failure. Use stderr tail as the message.
          if (this._streamReadyReject) {
            const e = new Error(
              `stream ffmpeg exited with code ${code} before first frame: ` +
              (stderr.trim().split('\n').slice(-3).join('\n') || '(no stderr)')
            );
            e.code = 'STREAM_STARTUP_FAILED';
            this._streamReadyReject(e);
            this._streamReadyResolve = null;
            this._streamReadyReject = null;
          }
        });

        // Parse stdout: split on JPEG SOI/EOI markers. The MJPEG
        // stream is a concatenation of complete JPEGs.
        child.stdout.on('data', (chunk) => {
          this._streamBuf = Buffer.concat([this._streamBuf, chunk]);
          // Walk the buffer looking for SOI...EOI pairs.
          while (this._streamBuf.length >= 4) {
            const soi = this._streamBuf.indexOf(Buffer.from([0xff, 0xd8]));
            if (soi < 0) {
              // No SOI in current buffer. If buffer is large, it's
              // garbage — drop everything up to the last plausible
              // JPEG start. (We don't have a last-JPEG-start here
              // because we just missed it.) Drop the entire buffer
              // and reset.
              this._streamBuf = Buffer.alloc(0);
              break;
            }
            // Discard any bytes before SOI (partial frame from prev
            // buffer).
            if (soi > 0) this._streamBuf = this._streamBuf.subarray(soi);
            // Find the EOI marker AFTER the SOI.
            const eoi = this._streamBuf.indexOf(Buffer.from([0xff, 0xd9]), 2);
            if (eoi < 0) {
              // No complete frame yet. Wait for more data.
              break;
            }
            // Slice out [SOI .. EOI+2] (inclusive EOI).
            const frame = Buffer.from(this._streamBuf.subarray(0, eoi + 2));
            this._streamBuf = this._streamBuf.subarray(eoi + 2);
            this._latestFrame = frame;
            // Resolve startStream's first-frame wait, if pending.
            if (this._streamReadyResolve) {
              this._streamReadyResolve(frame);
              this._streamReadyResolve = null;
              this._streamReadyReject = null;
            }
          }
        });

        // Wait for first frame (or spawn-time error).
        return await new Promise((resolve, reject) => {
          this._streamReadyResolve = resolve;
          this._streamReadyReject = reject;
        });
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          failures.push({ cmd, reason: 'enoent' });
          continue;
        }
        lastErr = err;
        failures.push({ cmd, reason: 'spawn-error', stderr: err && err.message });
        // Non-ENOENT spawn errors are usually fatal (no point trying
        // the next candidate with the same broken args).
        throw this._buildStreamError(failures, lastErr);
      }
    }
    // All candidates failed.
    throw this._buildStreamError(failures, lastErr);
  }

  _buildStreamError(failures, lastErr) {
    let detail = '';
    for (const f of failures) {
      const tag = `[${f.cmd}]`;
      if (f.reason === 'enoent') {
        detail += `\n  ${tag} binary not found (ENOENT)`;
      } else {
        detail += `\n  ${tag} ${f.reason}: ${f.stderr || '(no detail)'}`;
      }
    }
    const err = new Error(
      `could not start camera stream. Tried ${failures.length} candidate(s):${detail}`
    );
    err.code = 'CAMERA_NOT_AVAILABLE';
    err.failures = failures;
    return err;
  }

  /**
   * Returns the most recent complete JPEG frame as a Buffer, waiting
   * up to `timeoutMs` (default 1000) for a fresh frame if none is
   * available. Resolves with the latest frame on success; rejects
   * with the same shape as ffmpegCapture errors if the stream dies
   * mid-wait.
   */
  async readFrame({ timeoutMs = 1000 } = {}) {
    if (!this._streamChild) {
      throw new Error('readFrame() called before startStream()');
    }
    if (this._streamEnded) {
      throw new Error('camera stream has ended');
    }
    // If a frame is already buffered, return it immediately.
    if (this._latestFrame) {
      const f = this._latestFrame;
      this._latestFrame = null;  // consume
      return f;
    }
    // Otherwise wait for the next frame.
    return await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._streamReadyResolve = null;
        this._streamReadyReject = null;
      };
      this._streamReadyResolve = (frame) => {
        cleanup();
        this._latestFrame = null;
        resolve(frame);
      };
      this._streamReadyReject = (err) => {
        cleanup();
        reject(err);
      };
      timer = setTimeout(() => {
        this._streamReadyResolve = null;
        this._streamReadyReject = null;
        reject(new Error(`readFrame timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  async stopStream() {
    if (!this._streamChild) return;
    const child = this._streamChild;
    this._streamChild = null;
    this._streamEnded = true;
    // Resolve any pending readFrame() wait so it doesn't hang. We
    // resolve with null — callers should check for null and skip the
    // frame. (readFrame() also throws if it sees _streamEnded set,
    // so this is just a fallback.)
    if (this._streamReadyResolve) {
      this._streamReadyResolve(null);
      this._streamReadyResolve = null;
      this._streamReadyReject = null;
    }
    try { child.kill('SIGKILL'); } catch (_) { /* */ }
    // Don't await exit — ffmpeg may not exit cleanly on SIGKILL on
    // Windows, and we don't need to. The OS will reap the zombie.
  }
}

module.exports = { Camera, nativeEnabled };
