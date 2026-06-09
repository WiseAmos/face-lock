# Phase 1 NAPI Spike — Results

**Status:** ✅ Green on Linux x64-gnu. Real-hardware verification pending
on a machine with `/dev/video*` (or a CI runner with `v4l2loopback`).

## What was built

`crates/face-lock-camera/` — a ~250-line Rust crate that compiles to a
Node.js native addon. The full public surface is:

| Symbol | Kind | Returns | Purpose |
|---|---|---|---|
| `listDevices()` | free function | `DeviceInfo[]` | enumerate webcams |
| `tryOpen(idx, w, h)` | free function | `Camera \| null` | graceful open (returns `null` on failure) |
| `new Camera(idx, w, h)` | class constructor | `Camera` | strict open (panics on failure in napi-rs 2.x) |
| `camera.captureJpeg()` | method | `Buffer` (JPEG bytes) | one frame |
| `camera.close()` | method | `void` | release device |

## API design (Option Y)

The user asked for **Option Y**: a class factory for "I just want a
Camera" callers, plus a `tryOpen` free function for graceful-fallback
callers (the path `src/camera.js` will use in v0.2.0 to fall back to
the ffmpeg pipeline).

The napi-rs 2.x macro has a real limitation here:
- `#[napi(constructor)]` and `#[napi(factory)]` both must return `Self`,
  not `Result<Self>`. The macro codegen I read in
  `napi-derive-backend-1.0.75/src/codegen/fn.rs` shows an `is_ret_result`
  branch for `Factory`, but it generates the wrong call site for
  `Result<Self>` in `Camera` (the compiler error confirms: `expected
  Camera, found Result<Camera, Error>`). For the `Constructor` path,
  the macro only supports `Self` directly.

**Practical implication:** the constructor path panics on failure. That
panic will abort the Node process if the caller doesn't check device
availability first. I documented this loudly in `lib.rs:170` and the
`index.d.ts` for the `Camera` class.

**The `tryOpen` path is the one face-lock actually uses in production.**
`src/camera.js` will:
```js
const devs = listDevices();
if (devs.length === 0) return null;        // skip native path
return tryOpen(0, 320, 240);                // null on permission/busy/etc.
```

`new Camera(...)` is reserved for tests and the `face-lock doctor`
subcommand, where a hard failure is the right user experience.

## Build results (Linux x64-gnu)

| Step | Time | Notes |
|---|---|---|
| Cold `cargo build --release` | 2m 03s | 60+ transitive crates including nokhwa 0.10, image 0.24, napi 2.16 |
| Incremental `napi build` | ~2s | Rust code unchanged, only the napi-rs CLI re-runs |
| `node smoke-test.js` | <100ms | 6/6 pass |

Final artifacts:
```
crates/face-lock-camera/
├── Cargo.toml              (33 lines)
├── Cargo.lock              (33 KB, locked transitive deps)
├── build.rs                (3 lines: napi_build::setup())
├── package.json            (npm metadata + napi build config)
├── src/lib.rs              (246 lines: 3 free fns + Camera class)
├── index.js                (46 lines: platform-specific .node loader)
├── index.d.ts              (46 lines: hand-maintained, see note below)
├── face-lock-camera.linux-x64-gnu.node   (984 KB ELF, stripped, dynamically linked)
└── smoke-test.js           (verification script)
```

## Why is `index.d.ts` hand-maintained?

napi-rs 2.x's dts auto-generation requires napi-derive 3.x. We pinned
napi-derive 2.16.13 because 3.x is a major version bump with breaking
macro changes (we'd need to re-validate every `#[napi]` attr in
`lib.rs`). The hand-written `index.d.ts` is small (46 lines) and
mirrors the public API. When we bump to 3.x in Phase 2, we can delete
this file and let `napi build --dts index.d.ts` regenerate it; the
diff against this version becomes the API review.

## What I could not verify here

- `/dev/video*` does not exist on this dev box. The empty
  `listDevices()` result is correct, but I cannot prove that:
  - `captureJpeg()` returns a valid JPEG
  - Resolution negotiation works (the `MJPEG` ask is a request, not
    a guarantee)
  - Frame timing on real hardware matches the predicted 10-30ms

These must be verified on:
- The user's actual machine (Windows or macOS, where they have a webcam)
- A CI runner with `v4l2loopback` configured to feed a fake MJPEG stream

## Decision gate

The spike has answered the **core design question** (can nokhwa + napi-rs
deliver a usable, cross-platform webcam capture layer for face-lock
v0.2.0?). The answer is **yes, with the Option Y caveat above**.

Recommend proceeding to **Phase 2**:
- Set up the CI matrix (Linux + macOS + Windows) on GitHub Actions
  using the napi-rs workflow
- Build `src/camera.js` to use `tryOpen` as the primary path, with
  ffmpeg as the documented fallback
- Once CI is green, cut v0.2.0-alpha.2 (or v0.2.0-rc.1) for the user
  to install and run end-to-end on real hardware

## Open questions for the user

1. **Should we keep both `new Camera(...)` (panics on failure) and
   `tryOpen(...)` (returns null) in the public API?** I recommend yes
   (the doctor subcommand wants the strict version), but if you
   want a single API surface, drop the constructor and use only
   `tryOpen`.
2. **CI matrix: GitHub Actions on your `WiseAmos/face-lock` repo?**
   I have the `GITHUB_TOKEN` you provided so I can add workflows.
3. **Should the `Cargo.toml` dependency on `nokhwa = "0.10"` be
   pinned to a specific patch version?** `0.10.11` is what built
   cleanly here; 0.10.x is a fast-moving minor and breaking API
   changes happen between minors.

## Files added
- `crates/face-lock-camera/Cargo.toml`
- `crates/face-lock-camera/Cargo.lock`
- `crates/face-lock-camera/build.rs`
- `crates/face-lock-camera/package.json`
- `crates/face-lock-camera/src/lib.rs`
- `crates/face-lock-camera/index.js`
- `crates/face-lock-camera/index.d.ts`
- `crates/face-lock-camera/face-lock-camera.linux-x64-gnu.node`
  (binary; will be replaced by per-platform builds in CI)
- `crates/face-lock-camera/smoke-test.js`
