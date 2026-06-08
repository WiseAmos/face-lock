'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = Object.freeze({
  graceMs: 15000,           // 15 seconds — matches the spec exactly
  detectionIntervalMs: 500, // re-check face every 500ms
  matchThreshold: 0.55,     // face-api.js distance threshold (lower = stricter)
  minPresentFrames: 2,      // need 2 consecutive hits before "PRESENT"
  softBlockEnabled: true,   // dim/blur screen during grace
  softBlockDelayMs: 2000,   // wait 2s after face lost before showing overlay (for quick glances)
  cameraIndex: -1,          // -1 = auto / default
  logLevel: 0,              // 0 silent, 1 normal, 2 verbose

  // Shoulder-surfing dim (off by default — opt-in)
  awayFaceDimEnabled: false,    // dim screen when face detected but head turned away
  awayFaceDimDelayMs: 2000,     // must be off-screen this long before dim
  awayFaceDimYawMax: 0.35,      // ~20° — wider = stricter "off-screen" classification
  awayFaceDimPitchMax: 0.40,    // ~23°

  // Multi-face / "someone behind you" dim (off by default — opt-in)
  // Triggers when 2+ faces are detected while your face is matched.
  multiFaceDimEnabled: false,
  multiFaceDimDelayMs: 2000,    // must be multi-face this long before dim

  // Liveness (default ON, no flag exposed). Catches printed photos and
  // phone-on-screen attacks by combining two cheap signals:
  //   1) texture (variance + Laplacian energy) of the face crop
  //   2) temporal landmark jitter over a 1.5s rolling window
  // See src/liveness.js. Set to false in your config to disable.
  livenessEnabled: true,
});

function defaultConfigPath() {
  if (process.env.FACE_LOCK_CONFIG) {
    return process.env.FACE_LOCK_CONFIG;
  }
  // After `npm install -g`, this resolves to the global node_modules folder.
  // We deliberately keep a *local* copy in ~/.face-lock so config survives reinstalls.
  return path.join(os.homedir(), '.face-lock', 'config.json');
}

function defaultProfilePath() {
  return path.join(os.homedir(), '.face-lock', 'profile.json');
}

function load(configPath = defaultConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULTS, profilePath: defaultProfilePath() };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  // Merge with defaults so new fields populate automatically
  const merged = { ...DEFAULTS, ...parsed };
  if (!merged.profilePath) {
    merged.profilePath = defaultProfilePath();
  }
  return merged;
}

function save(config, configPath = defaultConfigPath()) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, json, { mode: 0o600 });
  return configPath;
}

function ensureDirs() {
  const base = path.dirname(defaultConfigPath());
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

module.exports = {
  DEFAULTS,
  defaultConfigPath,
  defaultProfilePath,
  load,
  save,
  ensureDirs,
};
