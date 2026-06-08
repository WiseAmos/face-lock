#!/usr/bin/env node
'use strict';

/**
 * facecheck — the short alias for `face-lock`.
 *
 *   $ facecheck         → if no profile enrolled, runs `setup`; otherwise starts the monitor
 *   $ facecheck setup   → run the setup wizard
 *   $ facecheck status  → show current state
 *   $ facecheck stop    → stop the running monitor
 *   $ facecheck start   → force-start the monitor (skip the profile check)
 *
 * Lives at bin/facecheck.js and is installed by npm as the `facecheck` bin
 * (see package.json). Like `opencode`: once installed, you just type
 * `facecheck` in your terminal.
 */

const path = require('path');
const fs = require('fs');

const profilePath = path.join(require('os').homedir(), '.face-lock', 'profile.json');
const sub = (process.argv[2] || '').toLowerCase();

const child = path.join(__dirname, 'face-lock.js');
const { spawnSync } = require('child_process');

function run(args) {
  const r = spawnSync(process.execPath, [child, ...args], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

if (sub === 'setup' || sub === 'status' || sub === 'stop' || sub === 'start' || sub === 'init' || sub === 'install' || sub === 'uninstall' || sub === 'reset') {
  // Pass through
  run([sub, ...process.argv.slice(3)]);
} else {
  // No subcommand: smart default.
  if (fs.existsSync(profilePath)) {
    run(['start']);
  } else {
    console.log('  no enrolled profile yet — running setup wizard.');
    console.log('  (run `facecheck` again after setup to start the monitor.)\n');
    run(['setup']);
  }
}
