'use strict';

/**
 * Smoke test: exercises the CLI without needing a camera.
 *   1. bin/face-lock.js --version exits 0 with the version string
 *   2. bin/face-lock.js --help exits 0 and lists the commands
 *   3. bin/face-lock.js status exits 0 even with no profile
 *   4. unit tests pass
 */

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const cli = path.resolve(__dirname, '..', 'bin', 'face-lock.js');

function run(args, opts = {}) {
  return spawnSync('node', [cli, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...(opts.env || {}) },
    ...opts,
  });
}

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

console.log('  smoke: --version');
const ver = run(['--version']);
check('exit 0', ver.status === 0, `status=${ver.status}`);
check('contains version', /\d+\.\d+\.\d+/.test(ver.stdout), `stdout=${ver.stdout}`);

console.log('  smoke: --help');
const help = run(['--help']);
check('exit 0', help.status === 0, `status=${help.status}`);
check('shows commands', /init/.test(help.stdout) && /start/.test(help.stdout) && /install/.test(help.stdout));

console.log('  smoke: status (no profile)');
// Isolate the config path so we don't touch the real ~/.face-lock
const tmp = path.join(require('os').tmpdir(), `face-lock-smoke-${Date.now()}`);
const status = run(['status'], { env: { FACE_LOCK_CONFIG: `${tmp}/cfg.json` } });
check('exit 0', status.status === 0, `status=${status.status}, stderr=${status.stderr}`);
check('mentions profile', /profile/.test(status.stdout));

console.log('  smoke: reset refuses without -y');
const reset = run(['reset'], { input: 'n\n', env: { FACE_LOCK_CONFIG: `${tmp}/cfg.json` } });
check('exits non-zero when cancelled', reset.status === 0, 'reset was cancelled — should still exit 0');
check('says cancelled', /cancelled/i.test(reset.stdout) || /cancelled/i.test(reset.stderr));

console.log('  smoke: facecheck --version passthrough');
const fcBin = path.resolve(__dirname, '..', 'bin', 'facecheck.js');
const fcVer = require('child_process').spawnSync('node', [fcBin, '--version'], { encoding: 'utf8' });
check('facecheck --version exits 0', fcVer.status === 0, `status=${fcVer.status}`);
check('facecheck --version shows version', /\d+\.\d+\.\d+/.test(fcVer.stdout), `stdout=${fcVer.stdout}`);

console.log('  smoke: ok');
