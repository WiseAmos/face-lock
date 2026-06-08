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
- **Interactive wizard** (`face-lock setup`) with step-by-step prompts.
- **No telemetry, no network calls.** Your face descriptor never leaves the machine.

## Install

```bash
npm install -g face-lock
```

> First-time install compiles `node-canvas` — make sure you have build tools:
> - **macOS**: `xcode-select --install`
> - **Linux**: `sudo apt install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
> - **Windows**: `npm install -g windows-build-tools`

## Quick start (interactive)

```bash
face-lock setup
```

This walks you through:
1. Grace period (default 15 s).
2. Soft-block on/off.
3. Shoulder-surf dim (opt-in, see below).
4. Face enrollment (~5 s — look at the camera).
5. Install as a service that auto-starts at login.

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
| `--away-dim` | off | shoulder-surfing dim (see below) |

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

If `awayFaceDimEnabled` is on, the monitor also checks **head pose** using the 68-pt landmarks. If your face is present and matched, but your head is turned > ~20° away from the screen for 2+ seconds, the display dims. This catches the case of someone leaning in to read your screen, or you turning to talk to someone next to you.

**Why opt-in?** It's a 5-landmark heuristic, not a real gaze model. It's prone to false positives (you glance at a second monitor and the screen dims). Try it; if it annoys you, turn it off.

```bash
face-lock start --away-dim
# or in your config:
echo '{ "awayFaceDimEnabled": true }' > ~/.face-lock/config.json
```

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
- **Doesn't recognise you through a photo** (the 3-frame enrollment requires natural movement + the 68-pt landmarks detect blink / micro-expressions poorly but a flat photo on a phone won't pass the 0.55 threshold for high-quality enrollments).

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
