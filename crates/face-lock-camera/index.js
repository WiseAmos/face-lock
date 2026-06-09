// Native module loader for face-lock-camera.
//
// Standard napi-rs shape: load the .node binary by its platform-specific
// filename, re-export everything as the public API.

'use strict'

const { existsSync } = require('fs')
const { join } = require('path')

const PLATFORM = (() => {
  switch (process.platform) {
    case 'linux':
      return process.arch === 'arm64' ? 'linux-arm64-gnu' : 'linux-x64-gnu'
    case 'darwin':
      return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
    case 'win32':
      return process.arch === 'arm64' ? 'win32-arm64-msvc' : 'win32-x64-msvc'
    default:
      throw new Error(`face-lock-camera: unsupported platform ${process.platform}/${process.arch}`)
  }
})()

const ADDON = `face-lock-camera.${PLATFORM}.node`
const addonPath = join(__dirname, ADDON)

if (!existsSync(addonPath)) {
  throw new Error(
    `face-lock-camera: native addon not found at ${addonPath}. ` +
    `Run 'npm rebuild' or rebuild from source via 'napi build --release --strip'.`
  )
}

const native = require(addonPath)

module.exports = {
  /** Enumerate video devices. Returns `DeviceInfo[]` (sync). */
  listDevices: native.listDevices,
  /**
   * Try to open a camera. Returns a `Camera` on success, `null` on failure.
   * Use this from `src/camera.js` for graceful fallback to the ffmpeg path.
   */
  tryOpen: native.tryOpen,
  /** The Camera class. Throws on construction failure. */
  Camera: native.Camera,
}
