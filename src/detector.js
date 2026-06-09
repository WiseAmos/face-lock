'use strict';

/**
 * face-api.js wrapper.
 *
 * Why face-api.js and not @vladmandic/face-api? face-api.js is the canonical
 * MIT implementation. It needs:
 *   1. TF.js (loaded by face-api.js itself)
 *   2. node-canvas (npm dep) — we use @napi-rs/canvas (prebuilt, no compile)
 *   3. Pre-trained model files in a local directory
 *
 * Model files (ssdMobilenetv1 + faceLandmark68Net + faceRecognitionNet) come
 * from https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 * and total ~17MB. We download on demand to ~/.face-lock/models.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { URL } = require('url');

const MODEL_BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
];

function modelDir() {
  return path.join(os.homedir(), '.face-lock', 'models');
}

function modelsPresent(dir = modelDir()) {
  return MODEL_FILES.every(f => fs.existsSync(path.join(dir, f)));
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest, { mode: 0o600 });
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => reject(new Error(`HTTP ${res.statusCode} for ${url}`)));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function downloadModels({ dir = modelDir(), onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < MODEL_FILES.length; i++) {
    const name = MODEL_FILES[i];
    const dest = path.join(dir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      if (onProgress) onProgress(i + 1, MODEL_FILES.length, name);
      continue;
    }
    const url = `${MODEL_BASE}/${name}`;
    await downloadFile(url, dest);
    if (onProgress) onProgress(i + 1, MODEL_FILES.length, name);
  }
  return dir;
}

let _faceApi = null;
let _detector = null;

async function loadModels({ dir = modelDir() } = {}) {
  if (!modelsPresent(dir)) {
    await downloadModels({ dir });
  }
  // Lazy-require so the heavy TF.js bundle is not pulled in until needed
  if (!_faceApi) {
    // eslint-disable-next-line global-require
    _faceApi = require('face-api.js');
  }
  await _faceApi.nets.ssdMobilenetv1.loadFromDisk(dir);
  await _faceApi.nets.faceLandmark68Net.loadFromDisk(dir);
  await _faceApi.nets.faceRecognitionNet.loadFromDisk(dir);
  return _faceApi;
}

async function getDetector(opts = {}) {
  if (_detector) return _detector;
  const faceApi = await loadModels(opts);
  _detector = new faceApi.SsdMobilenetv1Detector({ minConfidence: 0.5 });
  return _detector;
}

/**
 * Decode a JPEG file (path or Buffer) into something face-api.js can
 * accept: an HTMLImageElement-compatible object. face-api.js's
 * internal toNetInput() throws if the input is "a file path or
 * raw buffer" — it wants a DOM element or a tf.Tensor3D.
 *
 * face-api.js's Node env (createNodejsEnv.js) checks
 * `global.Canvas` and `global.Image` to figure out what classes
 * to `instanceof`-check against in isMediaElement(). @napi-rs/canvas
 * does NOT register itself on global — you have to import it. So we
 * import the classes here and assign them to `global` on first use;
 * face-api.js's isMediaElement() will then return true for our
 * Image/CanvasElement instances.
 *
 * Accepts:
 *   - string (file path)
 *   - Buffer (raw JPEG bytes)
 *   - HTMLImageElement-compatible object (passed through, no-op)
 */
let _canvasRegistered = false;
function registerCanvasGlobals() {
  if (_canvasRegistered) return;
  // eslint-disable-next-line global-require
  const c = require('@napi-rs/canvas');
  // face-api.js createNodejsEnv.js looks at global.Canvas / global.Image
  if (!global.Canvas && c.Canvas) global.Canvas = c.Canvas;
  if (!global.Image && c.Image) global.Image = c.Image;
  // Also expose the concrete class returned by createCanvas, since
  // @napi-rs/canvas wraps it: the public Canvas is the factory, but
  // createCanvas() returns a CanvasElement (different class).
  if (!global.HTMLCanvasElement) {
    const probe = c.createCanvas(1, 1);
    global.HTMLCanvasElement = probe.constructor;
  }
  _canvasRegistered = true;
}

async function decodeInput(input) {
  registerCanvasGlobals();

  // Already a DOM-like element (e.g. tf.Tensor3D, HTMLCanvasElement)?
  if (input && typeof input === 'object' && !(Buffer.isBuffer(input)) &&
      typeof input === 'object' && (input.constructor && (
        input.constructor.name === 'Tensor' ||
        input.constructor.name === 'HTMLImageElement' ||
        input.constructor.name === 'HTMLCanvasElement' ||
        input.constructor.name === 'HTMLVideoElement' ||
        // @napi-rs/canvas: Image class is named 'Image', Canvas is 'CanvasElement'
        input.constructor.name === 'Image' ||
        input.constructor.name === 'CanvasElement'
      ))) {
    return input;
  }

  // eslint-disable-next-line global-require
  const { loadImage } = require('@napi-rs/canvas');

  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string') {
    buf = fs.readFileSync(input);
  } else if (input && input.buffer && Buffer.isBuffer(input.buffer)) {
    // Uint8Array / typed array
    buf = Buffer.from(input.buffer, input.byteOffset || 0, input.byteLength || input.buffer.byteLength);
  } else {
    throw new Error(
      `decodeInput: unsupported input type ${input && input.constructor ? input.constructor.name : typeof(input)} — ` +
      'expected a file path string, Buffer, or DOM element'
    );
  }

  const img = await loadImage(buf);
  return img;
}

/**
 * Detect a single face in a JPEG file path / Buffer / DOM element.
 * Returns { detection, descriptor } or null.
 */
async function detectOne(input) {
  const faceApi = await loadModels();
  const decoded = await decodeInput(input);
  const detection = await faceApi.detectSingleFace(decoded).withFaceLandmarks().withFaceDescriptor();
  if (!detection) return null;
  return {
    detection,
    descriptor: Array.from(detection.descriptor),
  };
}

/**
 * Detect ALL faces in a frame. Used by the "second-person" / shoulder-surfing
 * detection path. Returns either `null` (no faces at all) or an object:
 *
 *   {
 *     detections: [{ detection, descriptor }, ...],  // every face found
 *     count:       N,                                 // === detections.length
 *     best:        { detection, descriptor },         // the largest / most-confident one
 *   }
 *
 * `best` is convenient for the existing single-face match path so callers
 * can do "is the primary face the enrolled user?" without scanning manually.
 */
async function detectAll(input) {
  const faceApi = await loadModels();
  const decoded = await decodeInput(input);
  const results = await faceApi
    .detectAllFaces(decoded)
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (!results || results.length === 0) return null;
  const detections = results.map((d) => ({
    detection: d,
    descriptor: Array.from(d.descriptor),
  }));
  // "Best" = largest box area. face-api returns `alignedRect.box` with x,y,width,height.
  let best = detections[0];
  let bestArea = 0;
  for (const f of detections) {
    const b = f.detection && f.detection.alignedRect && f.detection.alignedRect._box;
    if (!b) continue;
    const area = b.width * b.height;
    if (area > bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return { detections, count: detections.length, best };
}

function faceapi() {
  if (!_faceApi) {
    // eslint-disable-next-line global-require
    _faceApi = require('face-api.js');
  }
  return _faceApi;
}

module.exports = {
  modelDir,
  modelsPresent,
  downloadModels,
  loadModels,
  getDetector,
  detectOne,
  detectAll,
  faceapi,
};
