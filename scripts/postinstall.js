'use strict';

/**
 * Post-install: auto-launches the setup wizard on FIRST install only.
 *
 * Rules:
 *   - No `~/.face-lock/` exists  → this is a fresh install; launch the wizard.
 *   - `~/.face-lock/` exists     → user has a profile already; just print a
 *                                   banner + a "run `facecheck` to reconfigure"
 *                                   hint, then exit. Do NOT block the install
 *                                   on a prompt they can't see anyway.
 *
 * Why this rule:
 *   `npm i -g face-lock` on Windows runs the postinstall with the parent
 *   terminal as the npm installer's stdio. The setup wizard calls
 *   `inquirer.input()` which can hang waiting for keystrokes that don't make
 *   it through the npm → node → inquirer chain. The user reported
 *   "install hangs unless I use --ignore-scripts" in 0.1.4 — that hang is
 *   THIS script blocking on the first prompt. We solve it by only running
 *   the wizard when there's no profile to migrate.
 *
 * CI / Docker: `~/.face-lock/` does not exist there either, so the wizard
 * WILL try to launch and will hang. That's the trade-off the user accepted
 * in 0.1.3. CI users must pass `--ignore-scripts` (documented in README).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const pkg = require('../package.json');

const profileDir = path.join(os.homedir(), '.face-lock');
const profilePath = path.join(profileDir, 'profile.json');
const hasExistingProfile = fs.existsSync(profilePath);

const banner = [
  '',
  `  ╭─────────────────────────────────────────────────────────╮`,
  `  │  face-lock ${pkg.version} installed                          │`,
  `  ╰─────────────────────────────────────────────────────────╯`,
  '',
];

for (const l of banner) process.stdout.write(l + '\n');

if (hasExistingProfile) {
  // Upgrade / re-install path. Don't block. Don't prompt.
  process.stdout.write('  Existing profile detected at ~/.face-lock/\n');
  process.stdout.write('  Skipping setup wizard (run `facecheck` to reconfigure).\n');
  process.stdout.write('  Run `npm update -g face-lock` if you wanted the latest version.\n\n');
  process.exit(0);
}

// Fresh install — hand off to the wizard.
process.stdout.write('  Launching setup wizard...\n');
process.stdout.write('  (Press Ctrl-C at any time to exit. You can re-run with `facecheck`.)\n\n');

const cli = path.join(__dirname, '..', 'bin', 'face-lock.js');
const r = spawnSync(process.execPath, [cli, 'setup'], { stdio: 'inherit' });
process.exit(r.status == null ? 0 : r.status);
