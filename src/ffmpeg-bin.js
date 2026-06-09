'use strict';

/**
 * Resolves the path to the ffmpeg binary bundled with this package.
 *
 * The npm tarball ships one binary per supported platform under
 * `bin/ffmpeg/<platform>-<arch>/` (or `bin/ffmpeg/<platform>-<arch>/ffmpeg.exe`
 * on Windows). This module picks the right one for the current
 * `process.platform` + `process.arch` and returns its absolute path.
 *
 * Returns `null` if the current platform is not supported (so callers
 * can fall back to a system-installed ffmpeg or surface a clear error).
 *
 * Why this design:
 *   - Zero network at install time. ffmpeg-static's install script
 *     downloads binaries at install-time from GitHub releases, which
 *     fails for ~5% of users (rate limits, corporate firewalls,
 *     antivirus). Bundling directly in the tarball = no install-time
 *     network call = install Just Works.
 *   - Single source of truth for binary path. The camera fallback
 *     chain, smoke tests, and any future ffmpeg-invoking code all
 *     import this module instead of hard-coding paths.
 *
 * Supported platforms (kept in sync with the `files` shipped in
 * package.json):
 *   - linux   x64, arm64
 *   - darwin  x64, arm64
 *   - win32   x64
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Map of (platform, arch) → subdirectory under bin/ffmpeg/.
 * Order doesn't matter; first match wins.
 */
const PLATFORM_DIRS = {
  'linux-x64':    'linux-x64',
  'linux-arm64':  'linux-arm64',
  'darwin-x64':   'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64':    'win32-x64',
};

const BINARY_NAME = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

/**
 * Returns the absolute path to the bundled ffmpeg binary for the
 * current platform, or `null` if no binary ships for this
 * platform/arch combo.
 *
 * Callers should always have a fallback (system ffmpeg on PATH,
 * `imagesnap` on macOS, etc.) before they treat `null` as a hard
 * failure.
 */
function bundledFfmpegPath() {
  const key = `${process.platform}-${process.arch}`;
  const subdir = PLATFORM_DIRS[key];
  if (!subdir) return null;
  const candidate = path.join(__dirname, '..', 'bin', 'ffmpeg', subdir, BINARY_NAME);
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch (_) {
    // file doesn't exist (dev checkout without vendored binaries, or
    // platform we don't ship for)
  }
  return null;
}

/**
 * Returns the version string of the bundled ffmpeg binary
 * (`ffmpeg -version` first line), or `null` if the binary is not
 * available. Used by the smoke test and the wizard's "diagnostics"
 * step.
 *
 * NEVER throws — if anything goes wrong (binary missing, exec
 * failure, no PATH) we return `null` so the wizard can degrade
 * gracefully.
 */
function bundledFfmpegVersion() {
  const bin = bundledFfmpegPath();
  if (!bin) return null;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) return null;
    const stdout = (r.stdout || '').toString();
    const firstLine = stdout.split('\n')[0].trim();
    // ffmpeg prints "ffmpeg version 7.0.2-static ..." → keep the
    // human-readable line, don't parse it further.
    return firstLine || null;
  } catch (_) {
    return null;
  }
}

/**
 * List of platform-arch combos we ship binaries for. Useful for
 * the wizard's "supported platforms" message and the README.
 */
function supportedPlatforms() {
  return Object.keys(PLATFORM_DIRS).slice();
}

module.exports = {
  bundledFfmpegPath,
  bundledFfmpegVersion,
  supportedPlatforms,
  // Exported for tests:
  _PLATFORM_DIRS: PLATFORM_DIRS,
  _BINARY_NAME: BINARY_NAME,
};
