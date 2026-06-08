'use strict';

/**
 * Post-install: auto-launches the setup wizard.
 *
 * Per user direction: the wizard should start automatically after
 * `npm install -g face-lock`. This means non-interactive installs (CI,
 * Docker, piped stdin) will hang on the first prompt. That's accepted
 * as a trade-off — the alternative is making the user remember to type
 * `facecheck` after every install, which is the friction we are
 * explicitly choosing to remove.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const pkg = require('../package.json');

const lines = [
  '',
  `  ╭─────────────────────────────────────────────────────────╮`,
  `  │  face-lock ${pkg.version} installed                          │`,
  `  ╰─────────────────────────────────────────────────────────╯`,
  '',
  '  Launching setup wizard...',
  '  (If you have an older version, run `npm update -g face-lock` first.)',
  '',
];
for (const l of lines) process.stdout.write(l + '\n');

// Hand off to the wizard; pass through stdio so the user sees it.
const cli = path.join(__dirname, '..', 'bin', 'face-lock.js');
const r = spawnSync(process.execPath, [cli, 'setup'], { stdio: 'inherit' });
process.exit(r.status == null ? 0 : r.status);
