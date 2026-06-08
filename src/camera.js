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
 * If everything fails, throws an error that includes the OS, the platform
 * binary path, and the exact `ffmpeg` command that was tried, so the user
 * can debug without grepping source.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
  } = {}) {
    this.index = index;
    this.width = width;
    this.height = height;
    this.outputDir = outputDir;
    this.lastTried = null; // for error messages
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
   */
  ffmpegArgs(dest) {
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
          '-i', 'video=USB Camera',
          '-video_size', `${w}x${h}`,
          '-frames:v', '1',
          '-y', dest,
        ];
      default:
        throw new Error(`unsupported platform: ${os.platform()}`);
    }
  }

  ffmpegCapture() {
    const dest = path.join(this.outputDir, `frame-${Date.now()}.jpg`);
    const args = this.ffmpegArgs(dest);
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
