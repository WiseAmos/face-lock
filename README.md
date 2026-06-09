# face-lock

Auto-lock your laptop when you walk away. Face-recognition powered.

```
  you walk away   ──►  screen dims   ──►  OS lock   ──►  password to come back
                    (within 15s)      (after 15s)
```

- **Tracks your face** (not just any face — 128-D face descriptor matched on enrollment).
- **Soft-block** for 15 s (display off), then **hard OS lock** if you haven't returned.
- **Returns cancel the lock** — if your face comes back inside the 15 s window, you're not locked out.
- **Cross-platform**: macOS, Linux, Windows.
- **Installable globally** via `npm install -g`.
- **Interactive wizard** (`face-lock setup`) with step-by-step arrow-key prompts (powered by `@inquirer/prompts` — same UX as claude-code / opencode / codex / create-next-app).
- **No telemetry, no network calls.** Your face descriptor never leaves the machine.

## Install

```bash
npm install -g face-lock
```

> No native build step. `face-lock` uses [`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) (Skia-backed, NAPI), which ships prebuilt binaries for Windows / macOS / Linux on Node 18, 20, 22, and 24.

> **First install:** the postinstall script auto-launches the `face-lock setup` wizard so you don't have to remember to run it. **Upgrades / re-installs:** if `~/.face-lock/profile.json` already exists, the wizard is skipped (and a `Run \`facecheck\` to reconfigure` hint is printed). This is what fixes the 0.1.4 "install hangs forever on Windows" issue.
>
> **CI / Docker:** the postinstall can't tell whether it's running on a TTY, so the wizard will still try to launch on a fresh install. Pass `npm install -g face-lock --ignore-scripts` to skip the wizard in scripted installs, then run `facecheck` from an interactive shell when you're ready.

### Upgrading from a previous version

`npm i face-lock` does NOT auto-upgrade an existing global install — npm considers the version "satisfied" and returns. To upgrade:

```bash
npm update -g face-lock          # upgrade to latest within the same major
# or
npm install -g face-lock@latest  # explicit latest
```

`face-lock` also self-checks the npm registry on every run and prints a yellow notice to stderr if a newer version is available. Disable with `FACE_LOCK_NO_UPDATE_CHECK=1`.

## Quick start (interactive)

```bash
face-lock setup
```

This walks you through:
1. Grace period (default 15 s).
2. Soft-block on/off.
3. Shoulder-surf dim (opt-in, see below).
4. Liveness check (default on — see Liveness section).
5. Face enrollment (~5 s — look at the camera).
6. Install as a service that auto-starts at login.

## Manual usage

```bash
# 1. Enroll your face (one-time)
face-lock init

# 2. Run in the foreground (Ctrl-C to stop)
face-lock start

# 3. Install as a service (auto-start at login)
face-lock install
face-lock uninstall  # remove the service
```

Flags on `start`:

| flag | default | meaning |
|---|---|---|
| `--grace <ms>` | 15000 | ms before hard lock |
| `--threshold <n>` | 0.55 | face-match distance (lower = stricter) |
| `--no-soft-block` | on | skip display-dim, go straight to OS lock |
| `--camera <n>` | -1 | camera index (-1 = default) |
| `--away-dim` | off | dim when you turn your head >20° for 2 s |
| `--multi-face-dim` | off | dim when 2+ faces are detected (someone behind you) |

Other commands:

```bash
face-lock status   # show config / profile / model state
face-lock reset    # delete profile + config (can't undo)
```

## How it works

1. **Enrollment (`init`)** — captures 3 frames of your face, averages the 128-D descriptors, writes them to `~/.face-lock/profile.json` (mode `0600`).
2. **Monitor (`start`)** — every 500 ms:
   - Grab a webcam frame.
   - Run face-api.js SSD MobileNet → 68-pt landmarks → descriptor.
   - Compare to enrolled descriptor (Euclidean distance).
   - If match < 0.55 → PRESENT. Otherwise → GRACE → 15 s → LOCKED (OS lock).
3. **Soft block** — display off (cross-platform: `pmset displaysleepnow`, `xset dpms force off`, `rundll32 user32.dll,LockWorkStation`-style monitor off).
4. **Hard lock** — OS lock: `pmset displaysleepnow` + `/System/Library/CoreServices/Menu\ Extras/User.menu/Contents/Resources/CGSession -suspend` (macOS), `loginctl lock-session` (Linux), `rundll32 user32.dll,LockWorkStation` (Windows).

### State machine

```
        face matches                   grace expires
PRESENT ─────────────►  GRACE  ───────────────►  LOCKED (terminal)
   ▲                      │
   └──────────────────────┘
        face matches within 15s
```

`LOCKED` is terminal: once the OS lock fires, only the OS password brings you back. The monitor deliberately does **not** auto-unlock after a hard lock — that would defeat the whole point.

### Shoulder-surfing dim (opt-in)

Two independent triggers, both off by default. Enable with `--away-dim` and/or `--multi-face-dim` on `start`, or via the `setup` wizard.

| flag | what it catches | how it works | false-positive risk |
|---|---|---|---|
| `--away-dim` | you turn your head to talk to someone | head-pose from 68-pt landmarks (yaw > 20° or pitch > 23° for 2 s) | low — you have to literally turn away |
| `--multi-face-dim` | **someone stands behind you** | face-api detects 2+ faces in frame for 2 s | medium — posters, screens, photos of people on your desk can trip it |

Both are **opt-in for a reason** — they're heuristics. The first one is fairly reliable. The second one is coarser: a poster of a celebrity behind you, a video call with another person on screen, or a 2-person selfie on your phone held in the frame can all fire it. The default is "off" so the tool never annoys you. Try it; if it trips too often, leave it off — the OS lock at 15 s is still your backstop.

**What multi-face dim does NOT do** — it does **not** lock the screen, just dims it. Your session keeps running, the dim prevents the onlooker from reading what's there, and when the second face leaves the screen comes back. This is intentional: an attacker standing close enough to be on your webcam is probably also close enough to hear you typing a password, so we don't kick you out of your own session.

**What neither does** — detect a *photo* of your face being held up. That's what liveness (below) is for.

```bash
face-lock start --multi-face-dim
# or in your config:
echo '{ "multiFaceDimEnabled": true }' > ~/.face-lock/config.json
```

### Liveness check (default ON)

A photo of your face held up to the camera, or your face on a phone screen, will fool pure 2D face recognition. `face-lock` ships a lightweight liveness detector that combines two cheap signals — no extra model download, no extra ~5 MB.

1. **Texture signal** — the variance and Laplacian energy of a 32×32 face crop. A printed photo or a phone screen has abnormally low texture (smooth / moiré). Real skin does not.
2. **Temporal landmark jitter** — the std-dev of the 68-pt nose / eye landmarks over a 1.5 s rolling window. A real face has involuntary micro-motion (~0.3 px std-dev even when sitting still). A photo does not.

If both signals say "not alive", the monitor treats that frame as "face not present" → grace → lock. Liveness is **on by default**; you do not need to pass any flag to enable it. Disable it by editing `~/.face-lock/config.json`:

```json
{ "livenessEnabled": false }
```

> Liveness is not perfect. In low light, real faces can fail the texture signal (the noise floor of a noisy webcam resembles flat). If you find yourself being locked out at night, either turn on a lamp or disable liveness. There is no flag to tune the thresholds in v0.1 — it's a single "on / off" switch. A future version may expose thresholds.

### Autostart (login service)

`face-lock install` registers a service that runs the monitor in the background, every login:

- **macOS** — LaunchAgent at `~/Library/LaunchAgents/com.amosgoh.face-lock.plist` with `KeepAlive=true`.
- **Linux** — systemd user unit at `~/.config/systemd/user/face-lock.service`.
- **Windows** — both a Startup-folder `.bat` and a Scheduled Task with "Run whether user is logged on or not" set.

When you log in, the monitor starts automatically; when you walk away, the OS lock fires within 15 s; you don't need to think about it. `face-lock uninstall` removes the service. `face-lock status` shows whether the service is registered and active.

## Short alias: `facecheck`

`face-lock` is long to type. The package also installs a short alias — `facecheck` — that does what you'd expect:

```bash
facecheck         # if no profile yet, runs setup. otherwise starts the monitor.
facecheck status  # show if the service is running
facecheck stop    # stop the monitor
facecheck setup   # run the setup wizard
```

It works the same way `opencode` does: once `npm install -g face-lock` is done, `facecheck` is on your PATH. Use whichever name you prefer.

## File layout

| path | purpose | perms |
|---|---|---|
| `~/.face-lock/profile.json` | your 128-D face descriptor | `0600` |
| `~/.face-lock/config.json` | grace/threshold/etc | `0600` |
| `~/.face-lock/models/` | face-api.js models (~17 MB, downloaded once) | — |
| `~/.face-lock/logs/` | runtime logs | — |

You can override the home dir with `FACE_LOCK_HOME=/some/path`.

## Security & privacy

- **No network calls after model download.** Run `strace -e network -f face-lock start` to verify.
- **Face descriptor only**, never the raw photo. Descriptor is a 128-D float vector — *not* reverse-engineerable to a face image.
- **Profile is `0600`** and never logged, uploaded, or sent anywhere.
- **Source is MIT-licensed and auditable.** Read `src/detector.js`, `src/monitor.js`, `src/lock.js` to confirm.

### Things this does *not* do

- **Doesn't replace your OS password.** When the OS lock fires, you still need your password. This is a feature.
- **Doesn't run silently.** `face-lock init` requires camera access permission. macOS will prompt. Windows will prompt. Linux uses V4L2.
- **Doesn't recognise you through a photo, by default.** The liveness check (on by default) catches printed photos and phone-on-screen attacks. Disable via `~/.face-lock/config.json` (`livenessEnabled: false`) only if you know what you're doing.

## Troubleshooting

**`Error: Cannot find module 'commander'`** — `npm install -g face-lock` again. If using a global install, check your PATH includes `$(npm prefix -g)/bin`.

**No webcam found** — `face-lock start` will tell you the OS error. On Linux, check `ls /dev/video*` and your user is in the `video` group. On macOS, give the terminal camera permission in System Settings → Privacy & Security → Camera.

**`face-lock init` keeps failing** — lighting matters. Sit facing a window, not back-lit. The wizard will tell you if the descriptor is too low-quality.

**Lock fires even when you're at your laptop** — lower the threshold:
```bash
face-lock start --threshold 0.45
```
0.55 is the default; 0.40 is strict; 0.65 is lenient.

**Service won't auto-start** — see `face-lock install` output. It registers a launchd plist (macOS), systemd user unit (Linux), or a startup shortcut + scheduled task (Windows). One of those may be denied by MDM.

## Development

```bash
git clone https://github.com/<you>/face-lock
cd face-lock
npm install
npm test                # node --test test/*.test.js
node scripts/smoke.js   # CLI sanity check
```

## License

MIT © 2026 Amos Goh
