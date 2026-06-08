# Changelog

All notable changes to `face-lock` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
