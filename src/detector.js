'use strict';

/**
 * face-api.js wrapper.
 *
 * Why face-api.js and not @vladmandic/face-api? face-api.js is the canonical
 * MIT implementation. It needs:
 *   1. TF.js (loaded by face-api.js itself)
 *   2. node-canvas (npm dep)
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
  'face_landmark_68_model-shard2',
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
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
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
 * Detect a single face in an HTMLCanvasElement / HTMLImageElement.
 * Returns { detection, descriptor } or null.
 */
async function detectOne(input) {
  const faceApi = await loadModels();
  const detection = await faceApi.detectSingleFace(input).withFaceLandmarks().withFaceDescriptor();
  if (!detection) return null;
  return {
    detection,
    descriptor: Array.from(detection.descriptor),
  };
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
  faceapi,
};
