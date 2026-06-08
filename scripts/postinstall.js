'use strict';

/**
 * Post-install message. We do NOT auto-build native modules (canvas) because
 * that takes minutes and many users will only use the CLI. The detector only
 * needs canvas + face-api.js at `init`/`start` time, not at install time.
 */

const pkg = require('../package.json');

const lines = [
  '',
  `  ╭─────────────────────────────────────────────────────────╮`,
  `  │  face-lock ${pkg.version} installed                          │`,
  `  ╰─────────────────────────────────────────────────────────╯`,
  '',
  '  Quick start (the short way):',
  '    1) facecheck          # runs setup the first time, then starts the monitor',
  '    2) facecheck status   # see if it\'s running',
  '    3) facecheck stop     # stop the running monitor',
  '',
  '  Long form (every flag exposed):',
  '    1) face-lock init     # enroll your face (one-time)',
  '    2) face-lock start    # monitor (foreground, for testing)',
  '    3) face-lock install  # run at login as a service',
  '',
  '  First-run notes:',
  '    - Camera permissions may be required on macOS / Windows.',
  '    - The `init` step downloads ~17MB of face detection models',
  '      to ~/.face-lock/models (one-time, then cached).',
  '    - If `node-canvas` fails to build, install build tools:',
  '         macOS : xcode-select --install',
  '         Linux: sudo apt install -y build-essential libcairo2-dev',
  '         Win  : npm install -g windows-build-tools',
  '',
];
for (const l of lines) process.stdout.write(l + '\n');
