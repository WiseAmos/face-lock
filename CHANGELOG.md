# Changelog

All notable changes to `face-lock` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-alpha.5] - 2026-06-09

### Fixed
- **dshow device probe parser now handles the gyan.dev ffmpeg 6.0 output format.** The previous parser looked for `DirectShow video devices` / `DirectShow audio devices` header markers, but the ffmpeg 6.0 essentials build we vendor for win32-x64 (from gyan.dev) **omits those markers** and lists devices inline with `(video)` / `(audio)` tags. Result: the probe always returned null on Windows, face-lock fell through to the hardcoded `USB Camera` fallback, and ffmpeg correctly errored out with `Could not find video device with name [USB Camera]` even when a perfectly good webcam was connected.
  - New parser supports BOTH output formats: marker-header (most ffmpeg builds) and inline-tag (gyan.dev 6.0).
  - The inline-tag parser explicitly skips `Alternative name` lines (PnP GUIDs) and audio devices, picking the first quoted name followed by ` (video)`.
- Loosened the marker-header parser's dshow-prefix regex to accept both `[dshow]` and `[dshow @ 0x...]` forms (different ffmpeg builds vary).

### Tests
- 4 new tests for `_parseDshowListDevices`:
  - Real Acer laptop output from the alpha.4 E2E failure (gyan format with `ACER FHD User Facing`)
  - Audio-before-video edge case (must pick first video, not first device)
  - Audio-only input must return null, not pick an audio mic
  - When both formats are present, the marker-header parser wins
- Full suite: **70/70 pass** (was 66).

### Notes
- This is the actual fix for the alpha.3/alpha.4 Windows E2E failure. The previous release (alpha.4) only surfaced the underlying cause; this release addresses it.
- No code-path changes for the happy path; only the device-name discovery path changed.

## [0.2.0-alpha.4] - 2026-06-09

### Fixed
- **Camera capture errors now show what ffmpeg actually said.** Previously, when the bundled `ffmpeg.exe` ran but failed (dshow couldn't find the device, wrong device name, COM permission block, etc.), the final error message just listed the candidate paths and a generic "check your webcam" hint — making it impossible to tell whether the binary was missing, the device name was wrong, or the OS denied access. The error now attaches the last 8 lines of ffmpeg's stderr per candidate, differentiates `enoent` (binary missing) from `exit` (binary ran, failed) from `spawn-error`, and exposes `err.failures` programmatically.
- New `FACE_LOCK_CAMERA_DEBUG=1` environment variable prints ffmpeg's full stderr live to the terminal as the capture is attempted — useful when the truncated error message in the final report isn't enough.
- Windows-specific hint in the final error now points to the Camera permission setting in `Settings → Privacy & Security → Camera` (the most common cause on Win 10/11 since the 2020 privacy change).

### Notes
- No code-path changes for the **happy path** (camera works on first try). The fix only affects error reporting.
- This is a diagnostic release — paired with the alpha.3 Windows E2E failure where bundled ffmpeg was reached but the underlying cause was hidden.

## [0.2.0-alpha.3] - 2026-06-09

### Added
- **Vendored ffmpeg binaries.** Five platform-specific static ffmpeg builds are now bundled directly in the npm tarball under `bin/ffmpeg/<platform>-<arch>/`:
  - `linux-x64`   — ffmpeg 7.0.2 (johnvansickle.com static), has v4l2
  - `linux-arm64` — ffmpeg 7.0.2, has v4l2
  - `darwin-x64`  — ffmpeg 6.0, has avfoundation
  - `darwin-arm64`— ffmpeg 6.0, has avfoundation
  - `win32-x64`   — ffmpeg 6.0, has dshow
  Total unpacked: ~321 MB, total gzipped: ~129 MB (well under npm's 250 MB limit).
- **`src/ffmpeg-bin.js` resolver.** A new internal module that returns the absolute path to the vendored binary for the current `process.platform` + `process.arch` combo, or `null` on unsupported platforms or if the file is missing. Exposes `bundledFfmpegPath()`, `bundledFfmpegVersion()`, and `supportedPlatforms()`.
- **9 new unit tests** for the resolver (see `test/ffmpeg-bin.test.js`): path on supported platforms, null on unsupported, null when binary missing, graceful version reporter, platform list shape, internal `_PLATFORM_DIRS` consistency, `_BINARY_NAME` is platform-correct, end-to-end path shape.
- **TTY-aware postinstall.** `scripts/postinstall.js` now only runs the setup wizard when **both** `process.stdin.isTTY` and `process.stdout.isTTY` are true. Non-interactive installs (CI, Docker, scripted `npm install -g face-lock`) get a single-line hint and exit 0 — no more hangs at "loading" when the postinstall hits a non-TTY npm install.

### Changed
- **`ffmpeg-static` dependency removed.** We vendor ffmpeg directly in the tarball instead. The old dep downloads a binary from GitHub releases at install time, which fails for ~5% of users (rate limits, corporate firewalls, antivirus blocking the `.gz`, GitHub 404s). With vendored binaries, `npm i -g face-lock` Just Works on every supported platform with zero install-time network.
- **Native camera module deferred to v0.3.x.** The `face-lock-camera` Rust+napi-rs module that 0.2.0-alpha.2 introduced is **not shipped** in 0.2.0-alpha.3. The dep, the `crates/` source tree, and the `build:native` script are all removed from the npm tarball (kept on disk for v0.3.x work). `nativeEnabled()` in `src/camera.js` detects whether the package is installed via `require.resolve('face-lock-camera')` — if not (the npm-install case), it returns `false` and the bundled ffmpeg path is used. If the package IS on disk (dev/test checkout with the `file:` dep), the original opt-out logic still works, so the existing 7 native-path tests continue to pass.

### Fixed
- **Postinstall hang in non-TTY installs.** 0.1.4 and 0.2.0-alpha.2 would block forever at "loading" when run from `npm i -g` in a non-TTY environment (e.g. a fresh Windows cmd.exe from a package manager, or a CI run). The fix is a single `isInteractive` check that turns the wizard off and prints a hint instead. Users can still run `facecheck` manually from a real terminal.

### Notes
- This is still an **alpha**. The vendored ffmpeg binaries are verified to exist + be the right platform combo, but they haven't been exercised on real webcam hardware in CI yet. The first install on a fresh Windows/Mac/Linux box should just work — but if you see a ffmpeg-related error, please open an issue with the output of `node -e "console.log(require('face-lock/src/ffmpeg-bin').bundledFfmpegVersion())"`.
- The native camera module lands in v0.3.x with prebuilt `.node` binaries per platform (the CI workflow from 0.2.0-alpha.2 is preserved on disk and will be re-attached to the repo when we add a `workflow`-scoped token).
- Tarball size: ~132 MB packed, ~337 MB unpacked. The unpacked size shows up in `npm install` output as a warning at >250 MB; this is fine, but if we add more platform variants we should consider a smaller fallback (e.g. only shipping the binary for the user's current `process.platform` via an `optionalDependencies` postinstall download).

## [0.2.0-alpha.2] - 2026-06-09

### Added
- **Optional native camera module (`face-lock-camera`).** A Rust + [napi-rs 2.x](https://napi.rs/) binding over [nokhwa](https://crates.io/crates/nokhwa) that talks directly to V4L2 (Linux) / MSMF (Windows) / AVFoundation (macOS). It is tried first in the camera capture chain — the existing ffmpeg/ffmpeg-static/node-webcam fallbacks remain as a safety net. The native path is **optional**: if the binary is missing (unsupported platform, or the user has a pre-v0.2.0 install), the camera silently falls through to ffmpeg. Disable with `FACE_LOCK_NO_NATIVE=1` for debugging.
- **`scripts/build-native.js`** — local-dev build for the Rust module. CI ships prebuilt `.node` binaries per platform, so end users never need Rust installed. The script is for contributors hacking on the Rust source.
- **`.github/workflows/build-native.yml`** — CI matrix that builds the native module on Linux x64+arm64, macOS x64+arm64, and Windows x64+arm64, runs the JS test suite against the built binary, and (on `v*` tag pushes) attaches the binaries to the GitHub release.
- **7 new unit tests** for the native code path: `FACE_LOCK_NO_NATIVE=1` opt-out, native require failure → ffmpeg fallback, `tryOpen` returning null → ffmpeg fallback, `tryOpen` + `captureJpeg` success path, handle reuse across captures (no per-frame reopen), empty `captureJpeg` → close handle and fall through, `_useNative: false` constructor opt-out.

### Changed
- **`face-lock-camera` is now a local file dependency** in `package.json` (`"file:./crates/face-lock-camera"`). The root tarball includes the crate source so contributors can rebuild the native module with one `npm run build:native`.
- The `crates/face-lock-camera/.gitignore` was tightened: both `index.*.node` (napi-rs's actual output name) and `face-lock-camera.*.node` are excluded; only the source, the loader (`index.js` / `index.d.ts`), and the `Cargo.toml` get committed.
- nokhwa pinned to exact `=0.10.11` (the version that built clean on the spike). 0.10 has moved fast between minors; floating versions have already broken the `Camera::new` signature in 0.10.7.

### Notes
- This is an **alpha** because the CI-built binaries for macOS/Windows haven't been exercised on real hardware yet. The Linux x64 build is verified locally (`listDevices`, `tryOpen` on no-device → null). End users who `npm install face-lock@0.2.0-alpha.2` on macOS/Windows will get the ffmpeg fallback (working as designed) until the GH release ships v0.2.0 stable with attached binaries.
- The native module is a **latency win**, not a functional one — both paths write the same JPEG to a temp file and the downstream detector is identical. Where the native path wins: no `spawn()` overhead, no friendly-name guessing on Windows, and the `tryOpen` null-return distinguishes "no device" from "permission denied" (we can't actually surface this distinction to the user today, but the code is ready for it).

## [0.1.5] - 2026-06-09

### Fixed
- **Install hung on `npm i -g face-lock` for existing users.** The postinstall script auto-launched the setup wizard unconditionally, which blocks the install on the wizard's first prompt. The wizard can't read keystrokes through the npm → node → inquirer chain on Windows, so the install wedged forever (users reported having to pass `--ignore-scripts` to work around it). The postinstall now checks for an existing `~/.face-lock/profile.json` and skips the wizard if found — fresh installs still get the wizard, upgrades and re-installs don't. The CI/Docker hang on fresh installs is documented in the README; pass `--ignore-scripts` if you're scripting the install.
- **Camera couldn't find the webcam on Windows with `could not capture from camera. Tried: ffmpeg.exe.`** The Windows dshow invocation hardcoded `video=USB Camera` as the device name, but real Windows webcams are almost never named that — they're `HD Webcam`, `Integrated Camera`, `USB2.0 HD UVC WebCam`, etc. ffmpeg ran with a wrong device name, produced 0-byte output, and the fallback chain exhausted. The camera now probes `ffmpeg -list_devices true -f dshow -i dummy` on first capture (Windows only, cached on the instance) and uses the first video device it finds. If the probe fails, falls back to the `USB Camera` default. If the user passes `index` explicitly, that device is used directly (no probe).

### Added
- 4 new unit tests for the dshow device-name parser (`_parseDshowListDevices`) and the platform guard (`_resolveDshowDevice` is a no-op on non-Windows).

## [0.1.4] - 2026-06-08

### Fixed
- **Camera crashed on first run with `spawn ffmpeg ENOENT` on Windows** (and on Linux/macOS without a system ffmpeg). The package now bundles its own ffmpeg via [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) — the binary ships inside `node_modules/ffmpeg-static/` and the camera prefers it over a system install. No more `brew install ffmpeg` / `choco install ffmpeg` for users.
- **Setup wizard's arrow-key menu resolved itself on the first keystroke** (you'd see the menu, then it would exit before you could navigate). The 0.1.3 homegrown raw-mode keypress handler had a race with `readline.createInterface` calls earlier in the wizard — a stray Enter from a prior readline call would leak into the keypress stream. Replaced the entire prompt layer with [`@inquirer/prompts`](https://www.npmjs.com/package/@inquirer/prompts) (the same family claude-code / opencode / codex / create-next-app use). Single readline interface, single state machine, no leak.
- **Camera fallback chain is now an ordered list with retry.** Previously a single failed ffmpeg invocation rejected the capture. Now tries: bundled ffmpeg → system ffmpeg → imagesnap (macOS), each with its own error message. The final error includes the actual command that was tried and platform-specific troubleshooting hints (camera permission on macOS, `/dev/videoN` on Linux, "close Zoom/Skype" on Windows).

### Changed
- **`face-lock` now self-checks for upgrades on stderr.** If you have 0.1.3 installed and 0.1.4 is on the registry, you'll see a yellow notice: `face-lock 0.1.3 installed; 0.1.4 is available. Run npm update -g face-lock.` This addresses the recurring confusion from `npm i face-lock` not auto-upgrading existing global installs (npm considers them "satisfied"). Disable with `FACE_LOCK_NO_UPDATE_CHECK=1`. No-op in CI / non-TTY contexts.

### Added
- New dependency: `ffmpeg-static` (~78 MB binary, ships inside the npm tarball for the user's OS).
- New dependency: `@inquirer/prompts` (battle-tested arrow-key prompts).

## [0.1.3] - 2026-06-08

### Fixed
- **Setup wizard crashed at the model-download step** with
  `HTTP 404 for face_landmark_68_model-shard2`. The landmark model is a
  single shard upstream (`face_landmark_68_model-shard1`, 349 KB) — there
  is no `shard2`. The bogus entry in `MODEL_FILES` killed the entire
  download loop. Dropped.

### Changed
- **Postinstall auto-launches the setup wizard** (`face-lock setup`).
  Per user direction: the user should not have to remember to type
  `facecheck` after installing. Trade-off: non-interactive installs
  (CI, Docker) will hang on the first prompt and must be aborted with
  Ctrl-C. Accepted.
- **Setup wizard now uses arrow-key navigation** for the yes/no choices
  (↑/↓ to move, Enter to confirm). Same UX as `opencode` / `claude` /
  `codex`. The wizard also accepts Ctrl-C for a clean exit, and Ctrl-K /
  Ctrl-J as alternatives to the arrow keys. Falls back to typed-number
  input when stdin is not a TTY (preserves the smoke test).

## [0.1.2] - 2026-06-08

### Fixed
- **CRITICAL: published tarball was missing `scripts/` directory.**
  `package.json` listed `bin, src, assets, models, README, LICENSE, CHANGELOG`
  in the `files` allowlist, but omitted `scripts/`. So `scripts/postinstall.js`
  and `scripts/smoke.js` were silently excluded from every published
  tarball. The `postinstall` npm hook then failed with
  `Cannot find module 'scripts/postinstall.js'` on every clean install.
  This bug existed in **0.1.0 and 0.1.1** — both versions have been
  unrunnable from npm.
- **0.1.0 and 0.1.1 have been unpublished.** `npm install -g face-lock`
  will now resolve to 0.1.2.

## [0.1.1] - 2026-06-08 [YANKED — broken at install]

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

## [0.1.0] - 2026-06-08 [YANKED — broken at install]

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
