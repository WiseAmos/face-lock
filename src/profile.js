'use strict';

/**
 * Profile = the enrolled "you". A 128-D face descriptor captured at `init` time.
 *
 * The profile is stored locally at ~/.face-lock/profile.json with 0600 perms.
 * We never upload it, we never log it, and the CLI never echoes the raw vector.
 * Distance metric is Euclidean (face-api.js default).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultProfilePath() {
  return path.join(os.homedir(), '.face-lock', 'profile.json');
}

function exists(p = defaultProfilePath()) {
  return fs.existsSync(p);
}

function load(p = defaultProfilePath()) {
  const raw = fs.readFileSync(p, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj.descriptor || !Array.isArray(obj.descriptor) || obj.descriptor.length !== 128) {
    throw new Error(`profile at ${p} is corrupt (expected 128-D descriptor)`);
  }
  return obj;
}

function save(profile, p = defaultProfilePath()) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(profile, null, 2);
  // 0600 = owner read/write only. Face descriptor is biometric data — keep it
  // off the network and locked to the user account that enrolled it.
  fs.writeFileSync(p, json, { mode: 0o600 });
  return p;
}

/**
 * Euclidean distance between two 128-D descriptors. Lower = more similar.
 * face-api.js publishes 0.6 as the "same person" threshold; 0.55 is stricter
 * and is our default.
 */
function distance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error('descriptor length mismatch');
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Decide whether a freshly-seen descriptor matches the enrolled profile.
 * Returns { match: boolean, distance: number, threshold: number }.
 */
function match(profile, descriptor, threshold = 0.55) {
  const d = distance(profile.descriptor, descriptor);
  return { match: d < threshold, distance: d, threshold };
}

module.exports = {
  defaultProfilePath,
  exists,
  load,
  save,
  distance,
  match,
};
