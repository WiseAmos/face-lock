#!/usr/bin/env node
/**
 * scripts/build-native.js
 *
 * Local-dev build of the face-lock-camera NAPI module.
 *
 * Production users do NOT need to run this — CI publishes prebuilt
 * `.node` binaries per platform via the napi-rs release workflow,
 * which uploads them as GitHub release assets and (optionally) to
 * npm under per-platform package names. This script is for
 * contributors hacking on the Rust source on their own machine.
 *
 * What it does:
 *   1. Locates the @napi-rs/cli (`napi` binary) and `cargo`.
 *   2. Runs `napi build --platform --release --strip` inside
 *      `crates/face-lock-camera/`.
 *   3. Verifies the resulting `.node` file exists at the
 *      expected per-platform path (the `index.<platform>.node`
 *      naming convention used by napi-rs's auto-generated loader).
 *   4. Mirrors the binary into `node_modules/face-lock-camera/`
 *      so `require('face-lock-camera')` resolves it immediately
 *      from the workspace root.
 *
 * Usage:
 *   npm run build:native
 *
 * Or directly:
 *   node scripts/build-native.js           # release build, stripped
 *   node scripts/build-native.js --debug   # debug build (no strip)
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CRATE_DIR = path.join(__dirname, '..', 'crates', 'face-lock-camera');
const PKG_JSON = path.join(CRATE_DIR, 'package.json');

function die(msg, code = 1) {
  process.stderr.write(`build-native: ${msg}\n`);
  process.exit(code);
}

function info(msg) {
  process.stdout.write(`build-native: ${msg}\n`);
}

function findNapiCli() {
  // The CLI ships as a devDependency of the crate, not the root.
  // In a fresh checkout that hasn't been npm-install'd inside the
  // crate, we fall back to `npx @napi-rs/cli`.
  const local = path.join(CRATE_DIR, 'node_modules', '.bin', 'napi');
  if (fs.existsSync(local)) return local;
  return null; // → fall back to npx
}

function findCargo() {
  const r = spawnSync('cargo', ['--version'], { stdio: 'pipe' });
  if (r.status === 0) return 'cargo';
  die(
    'cargo not found on PATH. Install Rust from https://rustup.rs first.'
  );
}

// Mirrors the platform-detection switch in
// crates/face-lock-camera/index.js. Returns the file basename
// the auto-generated loader will try first (the "local file"
// path, which is what `napi build --js index.js` emits).
function expectedBinaryName() {
  const { platform, arch } = process;
  // glibc vs musl on Linux: napi-rs distinguishes by inspecting
  // process.report.glibcVersionRuntime (Node 12+).
  let abi = 'gnu';
  try {
    if (
      process.report &&
      typeof process.report.getReport === 'function' &&
      !process.report.getReport().header.glibcVersionRuntime
    ) {
      abi = 'musl';
    }
  } catch (_) {
    // older Node without process.report — assume glibc
  }
  if (platform === 'linux') {
    if (arch === 'x64') return `index.linux-x64-${abi}.node`;
    if (arch === 'arm64') return `index.linux-arm64-${abi}.node`;
  } else if (platform === 'darwin') {
    if (arch === 'x64') return 'index.darwin-x64.node';
    if (arch === 'arm64') return 'index.darwin-arm64.node';
  } else if (platform === 'win32') {
    if (arch === 'x64') return 'index.win32-x64-msvc.node';
    if (arch === 'arm64') return 'index.win32-arm64-msvc.node';
  }
  return null;
}

function main() {
  const debug = process.argv.includes('--debug');

  if (!fs.existsSync(PKG_JSON)) {
    die(
      `crate package.json not found at ${PKG_JSON}. ` +
        'Did you delete crates/face-lock-camera/?'
    );
  }

  const cargo = findCargo();
  const napiCli = findNapiCli();
  const targetBinary = expectedBinaryName();

  if (!targetBinary) {
    die(
      `unsupported platform/arch: ${process.platform}-${process.arch}. ` +
        'Add it to crates/face-lock-camera/index.js and this script.'
    );
  }

  info(`crate:    ${CRATE_DIR}`);
  info(`platform: ${process.platform}-${process.arch}`);
  info(`target:   ${targetBinary}`);
  info(`mode:     ${debug ? 'debug' : 'release (stripped)'}`);

  // napi-rs's `napi build` compiles Rust → .node and (with --js / --dts)
  // regenerates the loader. `--platform` matches the `napi.targets`
  // list in the crate's package.json, which is what CI also uses.
  const args = [
    'build',
    '--platform',
    '--js',
    'index.js',
    '--dts',
    'index.d.ts',
  ];
  if (!debug) {
    args.push('--release', '--strip');
  }

  // We need the devDep `@napi-rs/cli` available. If it isn't in
  // crates/face-lock-camera/node_modules yet, fall back to npx
  // (which will fetch it on demand — slow first time, cached after).
  let cmd, cmdArgs;
  if (napiCli) {
    cmd = napiCli;
    cmdArgs = args;
  } else {
    info('@napi-rs/cli not found in crate, falling back to npx (first run downloads it)');
    cmd = 'npx';
    cmdArgs = ['--yes', '@napi-rs/cli@^2.18.0', ...args];
  }

  info(`running: ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: CRATE_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    die(`napi build failed with exit code ${r.status}`, r.status ?? 1);
  }

  // The crate's build.rs places the binary in CRATE_DIR root.
  const builtPath = path.join(CRATE_DIR, targetBinary);
  if (!fs.existsSync(builtPath)) {
    die(
      `expected binary not found at ${builtPath}. ` +
        'The napi build may have produced a different filename — ' +
        'check crates/face-lock-camera/index.js platform list.'
    );
  }
  const stat = fs.statSync(builtPath);
  info(`built:    ${builtPath} (${(stat.size / 1024).toFixed(1)} KB)`);

  // Mirror into node_modules/face-lock-camera/ so `require('face-lock-camera')`
  // works immediately when running from the workspace root. The loader
  // (index.js) looks for the file at __dirname, which is
  // node_modules/face-lock-camera/ for a published install.
  const installedDir = path.join(
    __dirname,
    '..',
    'node_modules',
    'face-lock-camera'
  );
  if (fs.existsSync(installedDir)) {
    const installedPath = path.join(installedDir, targetBinary);
    fs.copyFileSync(builtPath, installedPath);
    info(`installed: ${installedPath}`);
  } else {
    info(
      'note: node_modules/face-lock-camera/ not present; skipping install copy. ' +
        'Run `npm install` (or `npm install file:./crates/face-lock-camera`) to link it.'
    );
  }

  info('done.');
}

main();
