#!/usr/bin/env node
// Phase 1 spike smoke test for face-lock-camera.
//
// What this verifies (on the dev box, no real webcam):
// 1. The .node binary loads in Node
// 2. All 3 exports (listDevices, tryOpen, Camera) are present
// 3. listDevices() returns a (possibly empty) array
// 4. tryOpen() returns null on failure (graceful, not a panic)
//
// What this CANNOT verify here (no /dev/video* on this dev box):
// - Real JPEG capture bytes
// - Frame timing
// - Per-device enumeration
// Those have to run on the user's machine or a CI runner with v4l2loopback.

'use strict'

const { listDevices, tryOpen, Camera } = require('./index.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); pass++ }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++ }
}

console.log('face-lock-camera Phase 1 smoke test')
console.log('====================================')

console.log('\n[1] Module load')
check('listDevices is a function', typeof listDevices === 'function')
check('tryOpen is a function', typeof tryOpen === 'function')
check('Camera is a function (class)', typeof Camera === 'function')

console.log('\n[2] Device enumeration (no webcam on this dev box)')
const devs = listDevices()
check('listDevices() returns an array', Array.isArray(devs))
check('listDevices() returns [] (no /dev/video* present)', devs.length === 0,
  `got ${devs.length} device(s)`)

console.log('\n[3] Graceful failure path (Option Y — returns null)')
const cam = tryOpen(0, 320, 240)
check('tryOpen(0, 320, 240) returns null on missing device', cam === null,
  `got ${cam}`)

console.log('\n[4] Constructor (Option Y — known to panic on failure in napi-rs 2.x)')
console.log('  ⊘ skipping — would abort Node. See lib.rs:170 doc comment.')

console.log('\n====================================')
console.log(`PASS: ${pass}    FAIL: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
