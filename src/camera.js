'use strict';

/**
 * Camera frame source.
 *
 * Returns a path to a saved JPEG. The detector then loads that JPEG.
 *
 * Strategy (in order of preference):
 *   1. `ffmpeg-static`'s bundled ffmpeg binary (works on Win/Mac/Linux out of
 *      the box, no system install required). This is the whole point of the
 *      dep — without it, fresh users hit "spawn ffmpeg ENOENT" and the
 *      wizard dies before they can do anything useful.
 *   2. A system `ffmpeg` on PATH (Linux distros where the user installed it
 *      via apt/brew).
 *   3. On macOS, `imagesnap` (legacy fallback — usually absent on modern
 *      Macs, hence the priority order).
 *   4. `node-webcam` (legacy) — kept in the fallback chain for completeness.
 *
 * Windows dshow device name:
 *   ffmpeg's dshow backend requires the *exact* friendly name of the camera
 *   (e.g. "HD Webcam", "Integrated Camera", "USB2.0 HD UVC WebCam"). The
 *   "USB Camera" default that 0.1.4 hardcoded rarely matches real devices,
 *   which caused "ffmpeg ran but produced 0-byte output → fallback exhausted"
 *   errors. On Windows we now probe `ffmpeg -list_devices true -f dshow -i
 *   dummy` at first capture and use the first video device we find. Cached
 *   on the Camera instance.
 *
 * If everything fails, throws an error that includes the OS, the platform
 * binary path, and the exact `ffmpeg` command that was tried, so the user
 * can debug without grepping source.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let bundledFfmpeg = null;
try {
  // eslint-disable-next-line global-require
  bundledFfmpeg = require('ffmpeg-static');
} catch (_) {
  // ffmpeg-static not installed (dev-time only)
}

let nodeWebcam = null;
try {
  // eslint-disable-next-line global-require
  nodeWebcam = require('node-webcam');
} catch (_) {
  // not installed
}

class Camera {
  constructor({
    index = -1,
    width = 320,
    height = 240,
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-lock-')),
    // Inject for tests: skip the device probe
    _probeDshowDevices = true,
  } = {}) {
    this.index = index;
    this.width = width;
    this.height = height;
    this.outputDir = outputDir;
    this.lastTried = null; // for error messages
    this._probeDshowDevices = _probeDshowDevices;
    this._dshowDevice = null; // cached after first probe
  }

  async capture() {
    if (nodeWebcam) {
      try {
        return await this.nodeWebcamCapture();
      } catch (e) {
        // fall through to ffmpeg — node-webcam is unreliable cross-platform
      }
    }
    return this.ffmpegCapture();
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
   * `win32DeviceName` (used only on win32) is the friendly name of the dshow
   * device — we default to "USB Camera" but the caller should normally have
   * resolved it via `_resolveDshowDevice()` first.
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
   * On Windows, ask ffmpeg to list available dshow devices and return the
   * friendly name of the first VIDEO device. Cached on the instance.
   *
   * Returns null on non-Windows, when probing is disabled (tests), or when
   * the probe fails (we fall through to the hardcoded "USB Camera" default).
   *
   * ffmpeg's stderr output for `ffmpeg -list_devices true -f dshow -i dummy`
   * looks like:
   *
   *   [dshow @ 0x...] DirectShow video devices
   *   [dshow @ 0x...]  "HD Webcam"
   *   [dshow @ 0x...]  "USB2.0 HD UVC WebCam"
   *   [dshow @ 0x...] DirectShow audio devices
   *   [dshow @ 0x...]  "Microphone (Realtek Audio)"
   *
   * We grab every quoted string that appears AFTER "DirectShow video devices"
   * and BEFORE "DirectShow audio devices" (or end of output).
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
   * Parse ffmpeg's `-list_devices` stderr output. Returns the first video
   * device name, or null if none found. Pure function — exposed for tests.
   */
  _parseDshowListDevices(output) {
    // ffmpeg prints the video list block before the audio list block.
    // We split on the markers (when present) and only look at the video half.
    const VIDEO_START = 'DirectShow video devices';
    const VIDEO_END = 'DirectShow audio devices';
    const vi = output.indexOf(VIDEO_START);
    if (vi < 0) return null;
    let block = output.slice(vi + VIDEO_START.length);
    const ai = block.indexOf(VIDEO_END);
    if (ai >= 0) block = block.slice(0, ai);
    // Lines look like:  [dshow @ 0x...]  "Device Name"
    // Match the FIRST quoted string in the video block.
    const m = block.match(/^[^"]*"\s*([^"]+?)\s*"/m) || block.match(/"\s*([^"]+?)\s*"/);
    if (!m) return null;
    return m[1].trim();
  }

  ffmpegCapture() {
    // On Windows, resolve the dshow device name (probes once, then cached).
    let win32DeviceName;
    if (os.platform() === 'win32') {
      win32DeviceName = this._resolveDshowDevice() || 'USB Camera';
    }

    const dest = path.join(this.outputDir, `frame-${Date.now()}.jpg`);
    const args = this.ffmpegArgs(dest, win32DeviceName);
    const tryOrder = [];
    if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) tryOrder.push(bundledFfmpeg);
    // System ffmpeg last — PATH lookup. We don't know if it exists until spawn.
    tryOrder.push(os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (os.platform() === 'darwin') tryOrder.push('imagesnap');

    return new Promise((resolve, reject) => {
      const tryNext = (i) => {
        if (i >= tryOrder.length) {
          const err = new Error(
            `could not capture from camera. Tried: ${tryOrder.join(', ')}.\n` +
            `On Windows: check that a webcam is connected and not in use (close Zoom, Skype, Discord, etc.).\n` +
            `On macOS:  the system may need camera permission for the terminal app. System Settings → Privacy & Security → Camera.\n` +
            `On Linux:  verify /dev/video${this.index >= 0 ? this.index : 0} exists and is readable.`
          );
          err.code = 'CAMERA_NOT_AVAILABLE';
          return reject(err);
        }
        const cmd = tryOrder[i];
        this.lastTried = cmd;
        const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (b) => { stderr += b.toString(); });
        child.on('error', (err) => {
          if (err.code === 'ENOENT') { tryNext(i + 1); return; }
          // Real error from the binary — don't fall through
          reject(new Error(`camera cmd failed (${cmd}): ${err.message}\nstderr:\n${stderr.slice(0, 500)}`));
        });
        child.on('exit', (code) => {
          if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            return resolve(dest);
          }
          // ffmpeg ran but produced nothing — usually wrong device name.
          // Try the next candidate (system ffmpeg or imagesnap).
          tryNext(i + 1);
        });
      };
      tryNext(0);
    });
  }

  stop() {
    try {
      const files = fs.readdirSync(this.outputDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.outputDir, f)); } catch (_) { /* */ }
      }
      fs.rmdirSync(this.outputDir);
    } catch (_) { /* */ }
  }
}

module.exports = { Camera };
