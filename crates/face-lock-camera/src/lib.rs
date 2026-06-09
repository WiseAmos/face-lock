//! face-lock-camera — NAPI binding over nokhwa.
//!
//! Exposes a `Camera` class plus two free functions (`listDevices`,
//! `tryOpen`) to JS. The whole surface is ~150 lines of glue; the heavy
//! lifting is in nokhwa (V4L2 / MSMF / AVFoundation backends) and the
//! `image` crate (RGB → JPEG).
//!
//! Why nokhwa: it's the only actively-maintained cross-platform Rust
//! webcam capture library. It has wrappers for V4L2 (Linux), MSMF
//! (Windows), and AVFoundation (macOS), all native APIs, so we don't
//! have to write the per-platform bindings ourselves.
//!
//! Phase 1 spike (this commit): API surface + Linux build only. macOS
//! and Windows compile-verify is Phase 2 via GitHub Actions matrix.
//!
//! # API shape (Option Y)
//!
//! JS has two ways to construct a `Camera`:
//!
//! 1. `new Camera(index, width, height)` — throws on failure. Use this
//!    when you don't have a fallback and want a clean stack trace.
//!
//! 2. `Camera.tryOpen(index, width, height)` — returns `Camera | null`.
//!    Use this from `src/camera.js` so the JS layer can fall back to
//!    the ffmpeg pipeline if the native capture path is unavailable
//!    (permission denied, driver not loaded, etc.). This is the
//!    pattern face-lock actually wants in v0.2.0 — a single napi
//!    binding that gracefully degrades to ffmpeg.
//!
//! We expose both because napi-rs 2.x's `#[napi(constructor)]` and
//! `#[napi(factory)]` both require `Self`-returning signatures (no
//! `Result<Self>`), so the constructor has to either panic or rely on
//! the JS caller to catch a thrown error. `tryOpen` is a free function
//! that *can* return `Option`/nullable and therefore gives the JS
//! layer proper error-as-value semantics.

#![deny(clippy::all)]

use std::io::Cursor;

use image::ImageBuffer;
use napi::{
    bindgen_prelude::{Buffer, Result as NapiResult},
    Error, Status,
};
use napi_derive::napi;
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{ApiBackend, CameraFormat, RequestedFormat, RequestedFormatType, Resolution},
    Camera as NokhwaCamera,
};

/// Info about one webcam on the system. Returned by `listDevices()`.
#[napi(object)]
pub struct DeviceInfo {
    pub index: u32,
    pub name: String,
    /// "V4L2" / "MSMF" / "AVFoundation" — useful for diagnostics
    /// and for the `face-lock doctor` subcommand.
    pub backend: String,
}

fn err<E: std::fmt::Display>(msg: E) -> Error {
    Error::new(Status::GenericFailure, msg.to_string())
}

/// Enumerate video devices on the system. Returns one entry per physical
/// webcam, with the index that should be passed to `Camera.tryOpen()`
/// or `new Camera(index, ...)`. Returns 0..N.
#[napi]
pub fn list_devices() -> NapiResult<Vec<DeviceInfo>> {
    // macOS: nokhwa requires `nokhwa_initialize()` to be called once
    // before any other API. It's a no-op on other platforms.
    #[cfg(target_os = "macos")]
    {
        use nokhwa::nokhwa_initialize;
        nokhwa_initialize().map_err(err)?;
    }

    let infos = nokhwa::query(ApiBackend::Auto).map_err(err)?;
    let backend = current_backend_name();
    Ok(infos
        .into_iter()
        .map(|info| DeviceInfo {
            index: match info.index() {
                nokhwa::utils::CameraIndex::Index(i) => *i,
                nokhwa::utils::CameraIndex::String(_) => 0,
            },
            name: info.human_name(),
            backend: backend.clone(),
        })
        .collect())
}

fn current_backend_name() -> String {
    match nokhwa::native_api_backend() {
        None => "None".to_string(),
        Some(ApiBackend::Auto) => "Auto".to_string(),
        Some(ApiBackend::Video4Linux) => "V4L2".to_string(),
        Some(ApiBackend::AVFoundation) => "AVFoundation".to_string(),
        Some(ApiBackend::MediaFoundation) => "MSMF".to_string(),
        Some(other) => format!("{other}"),
    }
}

/// A webcam handle. Constructed by `new Camera(index, width, height)`
/// (throws on failure) or `Camera.tryOpen(index, width, height)`
/// (returns `null` on failure). Released by `close()`. The handle is
/// `&mut` on every method because nokhwa's API is not thread-safe and
/// the napi-rs runtime may invoke methods from any thread.
#[napi]
pub struct Camera {
    inner: Option<NokhwaCamera>,
    width: u32,
    height: u32,
}

/// Open the camera with proper error propagation. Returns `Ok(Camera)`
/// on success. Used by both the throwing `new Camera(...)` constructor
/// (which panics with the error) and the JS-friendly `tryOpen()` free
/// function (which returns `null` on error).
fn try_open_internal(index: i32, width: u32, height: u32) -> NapiResult<Camera> {
    #[cfg(target_os = "macos")]
    {
        use nokhwa::nokhwa_initialize;
        nokhwa_initialize().map_err(err)?;
    }

    let resolved_index = if index < 0 { 0 } else { index as u32 };
    let camera_index = nokhwa::utils::CameraIndex::Index(resolved_index);

    // Ask the device for MJPG at the requested resolution and 30fps.
    // nokhwa picks the closest match it can negotiate; if the device
    // doesn't speak MJPG it falls back to YUYV or whatever is closest.
    let format =
        RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(CameraFormat::new(
            Resolution::new(width, height),
            nokhwa::utils::FrameFormat::MJPEG,
            30,
        )));

    let camera = NokhwaCamera::new(camera_index, format).map_err(err)?;
    Ok(Camera {
        inner: Some(camera),
        width,
        height,
    })
}

#[napi]
impl Camera {
    /// Construct a `Camera` for the device at `index` (from
    /// `listDevices()`) at the given resolution. Pass `index = -1` to
    /// use the default (first) device.
    ///
    /// **Caveat:** napi-rs 2.x's `#[napi(constructor)]` does not
    /// support `Result<Self>`. A failure here will **panic** the
    /// native thread and abort the Node process — do not call this
    /// without verifying the device is openable first. For
    /// "best-effort" opening that returns `null` on failure, use
    /// `Camera.tryOpen()` (the free function).
    ///
    /// The pattern face-lock uses in `src/camera.js` is:
    /// ```js
    /// const devs = listDevices();
    /// if (devs.length === 0) return null;  // skip native path
    /// return Camera.tryOpen(0, 320, 240);    // null on failure
    /// ```
    /// `new Camera(...)` is only used in tests and the `face-lock doctor`
    /// subcommand, where the user has explicitly asked for native
    /// capture and a hard failure is the right behavior.
    #[napi(constructor)]
    pub fn new(index: i32, width: u32, height: u32) -> Self {
        match try_open_internal(index, width, height) {
            Ok(c) => c,
            Err(e) => {
                panic!("face-lock-camera: failed to open camera {index} at {width}x{height}: {e}")
            }
        }
    }

    /// Capture one frame and return it as JPEG bytes. Single-frame
    /// semantics: each call blocks until the camera delivers a frame.
    /// On Linux V4L2 this is one `VIDIOC_DQBUF` cycle (~10-30ms on a
    /// USB webcam).
    ///
    /// Returns a Node `Buffer` (Uint8Array) — JS can write it directly
    /// to a file with `fs.writeFileSync`.
    #[napi]
    pub fn capture_jpeg(&mut self) -> NapiResult<Buffer> {
        let cam = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::new(Status::InvalidArg, "camera is closed"))?;
        let frame = cam.frame().map_err(err)?;
        let decoded = frame.decode_image::<RgbFormat>().map_err(err)?;
        let (w, h) = (decoded.width(), decoded.height());
        let raw = decoded.into_raw();

        // Wrap the raw RGB bytes into an image::RgbImage and encode to
        // JPEG. This is the slowest part of the spike (~5-15ms for
        // 320x240 on a modern CPU). For face-lock's use case (one
        // frame every 500ms), this is fine. Phase 2+ can swap to
        // `mozjpeg` for ~2× speedup.
        let img: ImageBuffer<image::Rgb<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, raw)
            .ok_or_else(|| {
                Error::new(
                    Status::GenericFailure,
                    format!(
                        "frame buffer has wrong size: {w}x{h} vs {}x{}",
                        self.width, self.height
                    ),
                )
            })?;
        let mut out = Cursor::new(Vec::with_capacity(32 * 1024));
        img.write_to(&mut out, image::ImageFormat::Jpeg)
            .map_err(err)?;
        Ok(Buffer::from(out.into_inner()))
    }

    /// Release the device handle. Idempotent.
    #[napi]
    pub fn close(&mut self) -> NapiResult<()> {
        if let Some(mut cam) = self.inner.take() {
            // nokhwa's Camera::stop_stream() is the close method. It's a
            // no-op for backends that don't need it (Linux V4L2) and
            // real cleanup for backends that do (macOS AVFoundation).
            cam.stop_stream().map_err(err)?;
        }
        Ok(())
    }
}

/// JS-friendly "try" pattern: returns `Camera` on success, `null` on
/// failure. This is the path `src/camera.js` will use in v0.2.0 to
/// fall back to the ffmpeg pipeline when the native path is
/// unavailable (permission denied, driver not loaded, no devices, etc.).
///
/// Internally calls the same `try_open_internal` as the constructor
/// and discards the error. Errors are not logged here on purpose —
/// the caller (src/camera.js) logs them with face-lock's own
/// diagnostic context.
#[napi]
pub fn try_open(index: i32, width: u32, height: u32) -> Option<Camera> {
    try_open_internal(index, width, height).ok()
}
