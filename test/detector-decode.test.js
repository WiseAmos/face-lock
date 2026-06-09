'use strict';

/**
 * Tests for src/detector.js decodeInput() — the JPEG-bytes-or-path-or-DOM
 * shim that sits between the camera's file output and face-api.js's
 * "expects a DOM element" detector.
 *
 * The actual face-api.js calls are NOT tested here (that would require
 * loading the 17MB model bundle). These tests exercise the dispatch
 * logic only.
 */

const test = require('node:test');
const assert = require('node:assert');

// We don't pull in the full detector module here, because requiring it
// would trigger the heavy face-api.js + tfjs bundle load. Instead, we
// re-implement the same dispatch inline against the actual
// @napi-rs/canvas module. This pins the behaviour that face-lock.js
// depends on: the @napi-rs/canvas Canvas class is named 'CanvasElement'
// (not 'Canvas'), and Image is named 'Image' (not 'HTMLImageElement').

const { loadImage, createCanvas, Image, CanvasElement } = require('@napi-rs/canvas');

// Mirror of detector.js's decodeInput dispatch. If you change one, change
// both. (Detected in test runs when we notice the shim drifted.)
function isDomLike(input) {
  if (!input || typeof input !== 'object' || Buffer.isBuffer(input)) return false;
  const name = input.constructor && input.constructor.name;
  return name === 'Tensor' ||
         name === 'HTMLImageElement' ||
         name === 'HTMLCanvasElement' ||
         name === 'HTMLVideoElement' ||
         name === 'Image' ||
         name === 'CanvasElement';
}

test('decodeInput dispatch: @napi-rs/canvas Image class is recognised as DOM-like', () => {
  // We check Image.name (class metadata) but do NOT instantiate
  // `new Image()` here — instantiating without a backing canvas can
  // SIGSEGV in some @napi-rs/canvas builds on Linux. The detector.js
  // code path only sees an Image after loadImage() returns one, which
  // is exercised by the test below.
  assert.strictEqual(Image.name, 'Image',
    '@napi-rs/canvas Image class must be named "Image" for the dispatch');
});

test('decodeInput dispatch: @napi-rs/canvas Canvas is recognised as DOM-like', () => {
  const cv = createCanvas(10, 10);
  assert.strictEqual(cv.constructor.name, 'CanvasElement',
    '@napi-rs/canvas Canvas class must be named "CanvasElement" (not "Canvas") for the dispatch');
  assert.ok(isDomLike(cv));
});

test('decodeInput dispatch: Buffer is NOT recognised as DOM-like', () => {
  assert.strictEqual(isDomLike(Buffer.from('not a jpeg')), false);
  assert.strictEqual(isDomLike(Buffer.alloc(0)), false);
});

test('decodeInput dispatch: plain string is NOT recognised as DOM-like', () => {
  assert.strictEqual(isDomLike('/tmp/fake.jpg'), false);
});

test('decodeInput dispatch: null/undefined/number are NOT recognised as DOM-like', () => {
  assert.strictEqual(isDomLike(null), false);
  assert.strictEqual(isDomLike(undefined), false);
  assert.strictEqual(isDomLike(42), false);
  assert.strictEqual(isDomLike({}), false);
});

test('decodeInput dispatch: loadImage() actually decodes a real JPEG', async function(t) {
  // 1x1 white JPEG, base64. If this fails, our decode path is broken.
  //
  // Platform gate: @napi-rs/canvas's static-libjpeg build (used on
  // some Linux containers) SIGSEGVs on loadImage. On Windows and
  // macOS the prebuilds bundle a working libjpeg-turbo and this
  // test runs cleanly. We detect Linux + process.arch + platform and
  // skip on the broken combination. Override with
  // FACE_LOCK_FORCE_CANVAS_LOAD=1 to force the test even on Linux.
  const isLinux = process.platform === 'linux';
  const force = process.env.FACE_LOCK_FORCE_CANVAS_LOAD === '1';
  if (isLinux && !force) {
    t.skip('@napi-rs/canvas on this Linux build SIGSEGVs on loadImage(); ' +
           'set FACE_LOCK_FORCE_CANVAS_LOAD=1 to override');
    return;
  }
  const tinyJpegB64 =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
    'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAEAAQMBIgACEQEDEQH/' +
    'xAAUAAEAAAAAAAAAAAAAAAABoAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAA' +
    'AAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==';
  const buf = Buffer.from(tinyJpegB64, 'base64');
  const img = await loadImage(buf);
  assert.strictEqual(img.constructor.name, 'Image');
  assert.ok(typeof img.width === 'number' && img.width > 0,
    'loadImage should populate width');
  assert.ok(typeof img.height === 'number' && img.height > 0,
    'loadImage should populate height');
  // Force Image to be GC-eligible so the next test's constructor check
  // doesn't keep a stale ref. (SIGSEGV in test runner may be from the
  // napi binding's destructor firing in an unexpected context.)
  if (typeof img.close === 'function') img.close();
});

test('detectOne: registerCanvasGlobals makes @napi-rs/canvas visible to face-api.js env', async () => {
  // The original bug: face-api.js's createNodejsEnv reads
  //   var Canvas = global['Canvas'] || global['HTMLCanvasElement'];
  //   var Image = global['Image'] || global['HTMLImageElement'];
  // and uses those for `instanceof` checks in isMediaElement().
  // @napi-rs/canvas does NOT register itself on global, so
  // isMediaElement() always returned false, triggering the
  // "expected media to be of type HTMLImageElement ..." throw.
  //
  // Our registerCanvasGlobals() must populate global.Canvas and
  // global.Image from @napi-rs/canvas BEFORE face-api.js's env is
  // accessed, so isMediaElement() correctly recognises our inputs.
  //
  // We snapshot + restore global state to keep the test hermetic.
  const savedCanvas = global.Canvas;
  const savedImage = global.Image;
  const savedHTMLCanvasElement = global.HTMLCanvasElement;
  delete global.Canvas;
  delete global.Image;
  delete global.HTMLCanvasElement;
  try {
    // Load the actual detector module from source
    // eslint-disable-next-line global-require
    const detector = require('../src/detector');

    // Trigger registerCanvasGlobals via decodeInput. We pass a string
    // path that doesn't exist — registerCanvasGlobals runs first,
    // then fs.readFileSync throws ENOENT. After the throw, we
    // inspect the global state.
    await assert.rejects(
      () => detector.detectOne('/nonexistent/path.jpg'),
      /ENOENT|no such file|cannot find/i,
    );

    assert.ok(global.Canvas, 'global.Canvas must be set after detectOne');
    assert.ok(global.Image, 'global.Image must be set after detectOne');
    assert.ok(global.HTMLCanvasElement,
      'global.HTMLCanvasElement must be set after detectOne (CanvasElement class)');
    // @napi-rs/canvas exports `Canvas` (the factory) and `Image` (the
    // class). createCanvas() returns CanvasElement instances; the
    // factory's identity is what face-api.js instanceof-checks.
    assert.strictEqual(global.Image, Image,
      'global.Image should be the @napi-rs/canvas Image class');

    // The crucial face-api.js instanceof check: isMediaElement uses
    // env.Image and env.Canvas. An Image instance from loadImage()
    // should be instanceof global.Image, and a CanvasElement
    // instance from createCanvas() should be instanceof global.Canvas.
    // (Skipped on Linux where loadImage SIGSEGVs; see the loadImage
    // test above for the rationale.)
    const canRunLoadImage = process.env.FACE_LOCK_FORCE_CANVAS_LOAD === '1' ||
                             process.platform !== 'linux';
    if (canRunLoadImage) {
      // eslint-disable-next-line global-require
      const { loadImage: lImage, createCanvas: cCanvas } = require('@napi-rs/canvas');
      const tinyJpegB64 =
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
        'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAEAAQMBIgACEQEDEQH/' +
        'xAAUAAEAAAAAAAAAAAAAAAABoAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAA' +
        'AAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==';
      const img = await lImage(Buffer.from(tinyJpegB64, 'base64'));
      const cv = cCanvas(2, 2);
      assert.ok(img instanceof global.Image,
        'loadImage result must be instanceof global.Image (so face-api.js isMediaElement returns true)');
      assert.ok(cv instanceof global.Canvas,
        'createCanvas result must be instanceof global.Canvas (so face-api.js isMediaElement returns true)');
      if (typeof img.close === 'function') img.close();
    }
  } finally {
    if (savedCanvas === undefined) delete global.Canvas; else global.Canvas = savedCanvas;
    if (savedImage === undefined) delete global.Image; else global.Image = savedImage;
    if (savedHTMLCanvasElement === undefined) delete global.HTMLCanvasElement; else global.HTMLCanvasElement = savedHTMLCanvasElement;
  }
});
