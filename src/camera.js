'use strict';

/**
 * Camera frame source — wraps node-webcam (or its lightweight equivalent).
 *
 * We need a periodic snapshot of the camera. We deliberately avoid bundling a
 * heavy native module. The approach:
 *
 *   1. Use `navigator` (browser-like)? No — we're in Node.
 *   2. Use OpenCV's VideoCapture? Requires opencv4nodejs — heavy.
 *   3. Use the OS camera CLI? macOS: `imagesnap`, Linux: `ffmpeg -f v4l2`,
 *      Windows: native DirectShow. Adds dep + OS package.
 *   4. Use `node-webcam` — cross-platform, pure JS, optional native grab.
 *
 * Decision: use `node-webcam` (cross-platform wrapper). If it's not available
 * in the env, `Camera.start()` throws a clear, actionable error.
 *
 * Returns ImageData (raw RGBA) to keep the detector input format predictable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let nodeWebcam = null;
try {
  // eslint-disable-next-line global-require
  nodeWebcam = require('node-webcam');
} catch (_) {
  // not installed — we'll fall back to a shell call to imagesnap / ffmpeg
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
  }

  /**
   * Capture a single frame, return the path to a saved JPEG.
   * The caller (CLI monitor loop) feeds that path to the detector.
   */
  async capture() {
    if (nodeWebcam) {
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
        const filename = `frame-${Date.now()}.jpg`;
        const dest = path.join(this.outputDir, filename);
        nodeWebcam.capture(filename, opts, (err) => {
          if (err) return reject(err);
          // node-webcam sometimes writes to cwd; also try dest
          const tried = fs.existsSync(dest) ? dest : path.join(process.cwd(), filename);
          if (!fs.existsSync(tried)) {
            return reject(new Error(`capture: file not found at ${tried}`));
          }
          resolve(tried);
        });
      });
    }
    return this.shellCapture();
  }

  /**
   * Fallback: shell out to the OS camera tool.
   * macOS  : imagesnap -w 320 -h 240 dest
   * Linux  : ffmpeg -f v4l2 -video_size 320x240 -i /dev/video0 -frames:v 1 -y dest
   * Windows: ffmpeg -f dshow -i video="..." -frames:v 1 -y dest
   */
  async shellCapture() {
    const dest = path.join(this.outputDir, `frame-${Date.now()}.jpg`);
    let cmd, args;
    switch (os.platform()) {
      case 'darwin':
        cmd = 'imagesnap';
        args = ['-w', String(this.width), '-h', String(this.height), dest];
        break;
      case 'linux':
        cmd = 'ffmpeg';
        args = [
          '-f', 'v4l2',
          '-video_size', `${this.width}x${this.height}`,
          '-i', `/dev/video${this.index >= 0 ? this.index : 0}`,
          '-frames:v', '1', '-y', dest,
        ];
        break;
      case 'win32':
        cmd = 'ffmpeg';
        args = [
          '-f', 'dshow',
          '-i', `video=USB Camera`,
          '-video_size', `${this.width}x${this.height}`,
          '-frames:v', '1', '-y', dest,
        ];
        break;
      default:
        throw new Error(`unsupported platform: ${os.platform()}`);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', (err) => reject(new Error(`camera cmd failed (${cmd}): ${err.message}. Install node-webcam or imagesnap/ffmpeg.`)));
      child.on('exit', (code) => {
        if (code === 0 && fs.existsSync(dest)) return resolve(dest);
        reject(new Error(`camera exit ${code}, no file at ${dest}`));
      });
    });
  }

  stop() {
    // best-effort cleanup of temp frames
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
