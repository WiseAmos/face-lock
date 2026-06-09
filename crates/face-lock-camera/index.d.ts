// Type definitions for face-lock-camera
// Hand-maintained to match src/lib.rs. napi-rs 2.x's dts auto-gen
// requires napi-derive 3.x (see https://github.com/napi-rs/napi-rs
// for migration). Phase 2+ bump: regenerate via napi-derive 3.x
// and diff against this file.

export interface DeviceInfo {
  index: number
  name: string
  /** "V4L2" / "MSMF" / "AVFoundation" */
  backend: string
}

/** A webcam handle. Constructed by `new Camera(index, width, height)` or `tryOpen(...)`. */
export declare class Camera {
  /**
   * Open the device at `index` (from `listDevices()`) at the given resolution.
   * Pass `index = -1` to use the default (first) device.
   *
   * ⚠️ napi-rs 2.x limitation: a failure here will panic the native thread
   * and abort the Node process. Verify the device is openable first (via
   * `listDevices()` returning a non-empty array) or use `tryOpen()`
   * which returns `null` on failure.
   */
  constructor(index: number, width: number, height: number)

  /**
   * Capture one frame and return it as JPEG bytes. Single-frame semantics:
   * each call blocks until the camera delivers a frame.
   */
  captureJpeg(): Buffer

  /** Release the device handle. Idempotent. */
  close(): void
}

/** Enumerate video devices on the system. Returns one entry per physical webcam. */
export declare function listDevices(): DeviceInfo[]

/**
 * Try to open a camera. Returns a `Camera` on success, `null` on failure.
 * Use this from `src/camera.js` for graceful fallback to the ffmpeg path
 * when the native capture path is unavailable (permission denied, busy,
 * driver not loaded, no such index, no devices).
 */
export declare function tryOpen(index: number, width: number, height: number): Camera | null
