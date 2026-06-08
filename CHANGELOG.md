# Changelog

All notable changes to `face-lock` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-08

### Changed
- **Replaced `node-canvas` with `@napi-rs/canvas`** (Skia-backed, NAPI prebuilts).
  Fixes `npm install -g face-lock` failing on Windows + Node 24, where
  `node-canvas@2.11.2` has no prebuilt binary for the `node-v137` ABI and the
  source-compile fallback requires GTK / Cairo runtime headers at
  `C:\GTK\bin\` (no longer required). No build tools needed on any platform.
- **Postinstall message** no longer references `windows-build-tools` /
  `libcairo2-dev` / `xcode-select`. The README's `Install` section was
  updated to match.

### Fixed
- `bin/face-lock.js` had a leftover `const canvas = loadCanvas()` shadow
  inside `loadImageAsCanvas()` that was unreachable on the failure path
  (the prior `loadCanvas` threw before reassignment). Now guarded explicitly
  with `if (!canvas) throw new Error('canvas not available')`.
- Renamed two inner `const canvas = ...` locals to `imgCanvas` to avoid
  shadowing the module-level `canvas` import (cosmetic; no behavior change).

### Compatibility
- All public API surface (`createCanvas`, `loadImage`, `getContext('2d')`,
  `getImageData`, `putImageData`, `drawImage`) is identical between
  `node-canvas` and `@napi-rs/canvas`. The liveness sampler's 43-test suite
  passes unchanged.
- Tested on Linux + Node 22. Windows / macOS prebuilds are NAPI, so they
  install without compilation. **Not yet exercised on Windows** — please
  report any install-time issues at the GitHub repo.

## [0.1.0] - 2026-06-08

### Added
- Initial release.
- Face detection and enrollment via `face-lock init`.
- Live monitor via `face-lock start` with configurable grace period and OS lock.
- Cross-platform OS lock commands (macOS `pmset`, Linux `loginctl` / `xdg-screensaver`, Windows `rundll32`).
- Soft-block overlay during the grace window (optional, on by default).
- **Liveness check (default ON, no flag):** face-crop texture variance + 1.5s rolling
  landmark-jitter std-dev. Catches printed-photo and phone-on-screen attacks.
  No new model download (~17MB footprint unchanged). Configurable in the
  setup wizard, not on the `init`/`start` CLI by design.
- **Multi-face shoulder-surf dim (opt-in):** when more than one face is in frame
  the screen dims to deter onlookers. Setup wizard asks.
- **`facecheck` short alias:** bare `facecheck` runs setup if no profile, else
  starts the monitor. `facecheck status | stop | start | setup | init` all
  pass through. Works like `opencode`.
- **Setup wizard** for grace, soft-block, away-dim, multi-face-dim, liveness,
  enrollment, and autostart-at-login (in that order).
- **Autostart at login** (cross-platform: launchd plist on macOS, systemd user
  unit on Linux, Task Scheduler + startup folder on Windows).
- Local-only face profile storage with strict file permissions (0600).
- MIT license, GitHub Actions CI, unit tests with `node:test` (43 tests).
- `prepublishOnly` gate: tests + smoke must pass before `npm publish`.
