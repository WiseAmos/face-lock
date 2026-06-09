'use strict';

/**
 * Post-install: auto-launches the setup wizard on FIRST install only.
 *
 * Rules (v0.2.0-alpha.3 — TTY-aware):
 *   - No `~/.face-lock/profile.json` exists  →  this is a fresh install.
 *   - `~/.face-lock/profile.json` exists     →  user has a profile already.
 *   - stdin is NOT a TTY (CI, piped install, `npm i` from a script)
 *     AND stdout is NOT a TTY                 →  non-interactive; skip
 *     the wizard and just print a hint. The
 *     user can run `facecheck` themselves
 *     from a real terminal.
 *
 * Why this rule:
 *   `npm i -g face-lock` on Windows runs the postinstall with the parent
 *   terminal as the npm installer's stdio. The setup wizard calls
 *   `inquirer.input()` which can hang waiting for keystrokes that don't make
 *   it through the npm → node → inquirer chain. The user reported
 *   "install hangs unless I use --ignore-scripts" in 0.1.4 — that hang is
 *   THIS script blocking on the first prompt. We solve it by:
 *     1) only running the wizard when there's no profile to migrate, AND
 *     2) only running the wizard when stdin AND stdout are TTYs.
 *   A non-interactive install (CI, Docker, scripted installs) gets a
 *   single-line hint and exits 0.
 *
 * CI / Docker: pass `--ignore-scripts` to skip postinstall entirely, or
 * let this script run and just observe the hint message. Either way,
 * `npm install` does not block.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const pkg = require('../package.json');

const profileDir = path.join(os.homedir(), '.face-lock');
const profilePath = path.join(profileDir, 'profile.json');
const hasExistingProfile = fs.existsSync(profilePath);

const isInteractive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

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

if (!isInteractive) {
  // Non-interactive install (CI, Docker, piped from a script). The
  // wizard would hang waiting for keystrokes that never arrive. Print
  // a hint and exit 0.
  process.stdout.write('  Non-interactive install detected (no TTY).\n');
  process.stdout.write('  Skipping setup wizard. Run `facecheck` from a real terminal to configure.\n\n');
  process.exit(0);
}

// Fresh install, interactive terminal. Hand off to the wizard.
process.stdout.write('  Launching setup wizard...\n');
process.stdout.write('  (Press Ctrl-C at any time to exit. You can re-run with `facecheck`.)\n\n');

const cli = path.join(__dirname, '..', 'bin', 'face-lock.js');
const r = spawnSync(process.execPath, [cli, 'setup'], { stdio: 'inherit' });
process.exit(r.status == null ? 0 : r.status);
