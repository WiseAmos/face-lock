#!/usr/bin/env node
'use strict';

/**
 * face-lock CLI
 *
 *   face-lock init    — enroll your face (captures a 128-D descriptor)
 *   face-lock start   — start the monitor (foreground; for testing)
 *   face-lock install — install as a service (launchd / systemd / Task Scheduler)
 *   face-lock uninstall
 *   face-lock status  — show config + profile presence
 *   face-lock reset   — delete profile + config
 *
 * All commands are local. No network calls (except the one-time model download).
 */

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const pkg = require('../package.json');
const cfg = require('../src/config');
const profile = require('../src/profile');
const detector = require('../src/detector');
const monitorLib = require('../src/monitor');
const camera = require('../src/camera');
const { load: loadCanvas } = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('canvas');
  } catch (_) {
    return { load: () => { throw new Error('canvas not available'); } };
  }
})();

const program = new Command();
program
  .name('face-lock')
  .description('Auto-lock your laptop when you walk away. Face-recognition powered.')
  .version(pkg.version);

function parseGrace(v) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 1000) {
    throw new Error('--grace must be an integer >= 1000ms');
  }
  return n;
}

program
  .command('init')
  .description('Enroll your face (one-time, ~5 seconds)')
  .option('--no-soft-block', 'do not dim display during grace')
  .option('--grace <ms>', 'lock grace period in ms', parseGrace, cfg.DEFAULTS.graceMs)
  .option('--threshold <n>', 'match distance threshold (lower = stricter)', (v) => parseFloat(v), cfg.DEFAULTS.matchThreshold)
  .option('--away-dim', 'dim screen if your face is present but head turned away (opt-in, more false positives)', false)
  .option('--multi-face-dim', 'dim screen if 2+ faces are detected while you are present (opt-in: catches someone behind you)', false)
  .action(async (opts) => {
    await runInit(opts);
  });

program
  .command('start')
  .description('Start the monitor (foreground)')
  .option('--no-soft-block', 'do not dim display during grace')
  .option('--grace <ms>', 'lock grace period in ms', parseGrace)
  .option('--threshold <n>', 'match distance threshold (lower = stricter)', (v) => parseFloat(v))
  .option('--camera <n>', 'camera index (-1 = default)', (v) => parseInt(v, 10), -1)
  .option('--away-dim', 'enable head-turned-away dim (off by default)', false)
  .option('--multi-face-dim', 'enable multi-face / shoulder-surf dim (off by default)', false)
  .action(async (opts) => {
    await runStart(opts);
  });

program
  .command('setup')
  .description('Interactive wizard: enroll + choose options, then install as a service')
  .action(async () => runSetup());

program
  .command('install')
  .description('Install as a service so face-lock runs at login')
  .action(async () => runService('install'));

program
  .command('uninstall')
  .description('Remove the service')
  .action(async () => runService('uninstall'));

program
  .command('status')
  .description('Show config, profile, and model status')
  .action(() => runStatus());

program
  .command('reset')
  .description('Delete profile and config (cannot be undone)')
  .action(async () => runReset());

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

async function prompt(question, { defaultValue, validator, password = false } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: password,
  });
  return new Promise((resolve) => {
    const hint = defaultValue != null ? ` [${defaultValue}]` : '';
    const ask = () => {
      rl.question(`${question}${hint}: `, (ans) => {
        const v = ans.trim() || (defaultValue != null ? String(defaultValue) : '');
        if (validator && !validator(v)) {
          process.stderr.write('  (invalid; try again)\n');
          return ask();
        }
        rl.close();
        resolve(v);
      });
    };
    ask();
  });
}

async function choose(question, choices, defaultIndex = 0) {
  console.error(`\n  ${question}`);
  choices.forEach((c, i) => {
    const marker = i === defaultIndex ? '●' : '○';
    process.stderr.write(`    ${marker} ${i + 1}) ${c}\n`);
  });
  const v = await prompt('  choose', { defaultValue: String(defaultIndex + 1), validator: (s) => {
    const n = parseInt(s, 10);
    return Number.isInteger(n) && n >= 1 && n <= choices.length;
  } });
  return choices[parseInt(v, 10) - 1];
}

async function runSetup() {
  console.log('╭─────────────────────────────────────────────────────────╮');
  console.log('│  face-lock setup — interactive wizard                   │');
  console.log('╰─────────────────────────────────────────────────────────╯\n');
  console.log('  This will:');
  console.log('    1) pick your options');
  console.log('    2) enroll your face');
  console.log('    3) install as a service that runs at login\n');

  const graceStr = await prompt('  grace period in seconds before lock (default 15)', {
    defaultValue: '15',
    validator: (s) => {
      const n = parseInt(s, 10);
      return Number.isInteger(n) && n >= 1 && n <= 600;
    },
  });
  const graceMs = parseInt(graceStr, 10) * 1000;

  const soft = await choose('  dim the display during the grace window?', [
    'yes — recommended (turns off display for 2s, then locks at expiry)',
    'no — go straight to OS lock at expiry',
  ], 0);
  const softBlockEnabled = soft.startsWith('yes');

  const awayDim = await choose('  shoulder-surfing dim: dim screen if your face is present but turned away?', [
    'no — recommended (fewer false positives; you can enable later with --away-dim)',
    'yes — dim if head is turned >20° for 2s (note: more false positives)',
  ], 0);
  const awayFaceDimEnabled = awayDim.startsWith('yes');

  const multiDim = await choose('  multi-face / "someone behind you" dim: dim screen if 2+ faces are visible while you are present?', [
    'no — recommended (fewer false positives; you can enable later with --multi-face-dim)',
    'yes — dim for 2s when 2+ faces are seen (catches someone standing behind you; some false positives from posters/screens)',
  ], 0);
  const multiFaceDimEnabled = multiDim.startsWith('yes');

  console.log('\n  ── summary ──');
  console.log(`    grace            : ${graceMs}ms`);
  console.log(`    soft block       : ${softBlockEnabled ? 'on' : 'off'}`);
  console.log(`    away-face dim    : ${awayFaceDimEnabled ? 'on' : 'off'}`);
  console.log(`    multi-face dim   : ${multiFaceDimEnabled ? 'on' : 'off'}`);

  const proceed = await confirm('\n  proceed with enrollment?');
  if (!proceed) {
    console.log('  cancelled.');
    return;
  }

  // Step 1: enroll
  await runInit({ grace: graceMs, threshold: cfg.DEFAULTS.matchThreshold, softBlock: softBlockEnabled, awayDim: awayFaceDimEnabled, multiFaceDim: multiFaceDimEnabled });

  // Step 2: install as service
  const install = await confirm('\n  install face-lock as a service (auto-start at login)?');
  if (install) {
    runService('install');
  } else {
    console.log('  you can run `face-lock install` later.');
  }
}

async function loadImageAsCanvas(imgPath) {
  const canvas = loadCanvas();
  const img = await canvas.loadImage(imgPath);
  const c = canvas.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return c;
}

async function runInit(opts) {
  console.log('face-lock: enrollment\n');
  console.log('  Look at the camera. We capture ONE frame and store a 128-D');
  console.log('  descriptor locally at ~/.face-lock/profile.json (0600 perms).');
  console.log('  The raw image is NOT saved.\n');

  // Save config
  const configPath = cfg.save({
    graceMs: opts.grace,
    detectionIntervalMs: cfg.DEFAULTS.detectionIntervalMs,
    matchThreshold: opts.threshold,
    minPresentFrames: cfg.DEFAULTS.minPresentFrames,
    softBlockEnabled: opts.softBlock,
    softBlockDelayMs: cfg.DEFAULTS.softBlockDelayMs,
    cameraIndex: -1,
    logLevel: 1,
    awayFaceDimEnabled: !!opts.awayDim,
    awayFaceDimDelayMs: cfg.DEFAULTS.awayFaceDimDelayMs,
    awayFaceDimYawMax: cfg.DEFAULTS.awayFaceDimYawMax,
    awayFaceDimPitchMax: cfg.DEFAULTS.awayFaceDimPitchMax,
    multiFaceDimEnabled: !!opts.multiFaceDim,
    multiFaceDimDelayMs: cfg.DEFAULTS.multiFaceDimDelayMs,
  });
  console.log(`  config saved: ${configPath}`);

  // Download models on demand
  console.log('  loading face detection models (one-time, ~17MB)...');
  await detector.downloadModels({
    onProgress: (i, n, name) => {
      process.stderr.write(`\r  [${i}/${n}] ${name}    `);
    },
  });
  process.stderr.write('\n');

  const cam = new camera.Camera({ index: -1, width: 320, height: 240 });
  console.log('  capturing frame in 2s — get ready...');
  await new Promise(r => setTimeout(r, 2000));
  const imgPath = await cam.capture();
  console.log('  captured. extracting descriptor...');

  try {
    const canvas = await loadImageAsCanvas(imgPath);
    const result = await detector.detectOne(canvas);
    if (!result) {
      console.error('\n  ✗ No face detected. Tips:');
      console.error('     - face the camera, well-lit');
      console.error('     - move closer (>= 40cm)');
      console.error('     - try `face-lock init` again');
      cam.stop();
      try { fs.unlinkSync(imgPath); } catch (_) { /* */ }
      process.exit(1);
    }
    profile.save({
      createdAt: new Date().toISOString(),
      threshold: opts.threshold,
      descriptor: result.descriptor,
    });
    console.log(`\n  ✓ enrolled at ${profile.defaultProfilePath()}`);
    console.log('  run `face-lock start` to begin monitoring.');
  } finally {
    try { fs.unlinkSync(imgPath); } catch (_) { /* */ }
    cam.stop();
  }
}

async function runStart(opts) {
  if (!profile.exists()) {
    console.error('  ✗ no profile enrolled. Run `face-lock init` first.');
    process.exit(1);
  }
  if (!detector.modelsPresent()) {
    console.log('  downloading face detection models (one-time, ~17MB)...');
    await detector.downloadModels({
      onProgress: (i, n, name) => {
        process.stderr.write(`\r  [${i}/${n}] ${name}    `);
      },
    });
    process.stderr.write('\n');
  }

  const loaded = cfg.load();
  if (opts.grace) loaded.graceMs = opts.grace;
  if (opts.threshold) loaded.matchThreshold = opts.threshold;
  if (opts.softBlock === false) loaded.softBlockEnabled = false;
  if (opts.camera && opts.camera >= 0) loaded.cameraIndex = opts.camera;
  if (opts.awayDim) loaded.awayFaceDimEnabled = true;
  if (opts.multiFaceDim) loaded.multiFaceDimEnabled = true;

  const cam = new camera.Camera({ index: loaded.cameraIndex });
  let timer = null;
  const mon = new monitorLib.Monitor({
    config: loaded,
    frameSource: {
      getFrame: async () => {
        const p = await cam.capture();
        const canvas = await loadImageAsCanvas(p);
        try { fs.unlinkSync(p); } catch (_) { /* */ }
        return canvas;
      },
    },
  });

  mon.on('start', () => {
    console.error('  face-lock monitoring started. Ctrl-C to stop.');
    timer = setInterval(() => { mon.tick().catch(() => { /* */ }); }, loaded.detectionIntervalMs);
  });
  mon.on('left',     () => { console.error(`  → face lost, ${loaded.graceMs}ms grace`); });
  mon.on('returned', () => { console.error('  → face back, grace cancelled'); });
  mon.on('soft-block', () => { console.error('  → soft-block: display off'); });
  mon.on('lock',     () => { console.error('  → OS lock fired'); });
  mon.on('stop',     () => { if (timer) clearInterval(timer); cam.stop(); });

  process.on('SIGINT', () => { mon.stop(); process.exit(0); });
  process.on('SIGTERM', () => { mon.stop(); process.exit(0); });

  mon.start();
}

function runStatus() {
  const configPath = cfg.defaultConfigPath();
  const profilePath = profile.defaultProfilePath();
  const modelDir = detector.modelDir();

  console.log('face-lock status\n');
  console.log(`  config : ${configPath} ${fs.existsSync(configPath) ? '✓' : '— (not created; run `face-lock init`)'}`);
  if (fs.existsSync(configPath)) {
    try { console.log('           ', JSON.stringify(cfg.load(), null, 2).replace(/\n/g, '\n            ')); } catch (e) { /* */ }
  }
  console.log(`  profile: ${profilePath} ${fs.existsSync(profilePath) ? '✓' : '— (not enrolled)'}`);
  console.log(`  models : ${modelDir} ${detector.modelsPresent() ? '✓' : '— (will download on next start)'}`);

  const perms = (p) => {
    try {
      const s = fs.statSync(p);
      return `(0${(s.mode & 0o777).toString(8)})`;
    } catch (_) { return '(missing)'; }
  };
  if (fs.existsSync(configPath))  console.log(`           config perms: ${perms(configPath)}`);
  if (fs.existsSync(profilePath)) console.log(`           profile perms: ${perms(profilePath)}`);
}

async function runReset() {
  if (!await confirm('  delete profile + config? (cannot be undone)')) {
    console.log('  cancelled.');
    return;
  }
  const paths = [cfg.defaultConfigPath(), profile.defaultProfilePath()];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  removed ${p}`);
    }
  }
  console.log('  done. run `face-lock init` to re-enroll.');
}

function runService(action) {
  // Cross-platform service install.
  // macOS  : ~/Library/LaunchAgents/com.face-lock.plist  (launchctl load)
  // Linux  : ~/.config/systemd/user/face-lock.service    (systemctl --user)
  // Windows: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\face-lock.bat
  //          (the simplest "service" that auto-runs; full NSSM is heavier)

  const node = process.execPath;
  const cli = path.resolve(__dirname, 'face-lock.js');
  switch (os.platform()) {
    case 'darwin': return macService(action, node, cli);
    case 'linux':  return linuxService(action, node, cli);
    case 'win32':  return winService(action, node, cli);
    default:
      console.error(`unsupported platform: ${os.platform()}`);
      process.exit(1);
  }
}

function macService(action, node, cli) {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.face-lock.plist');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.face-lock</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${cli}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.face-lock', 'face-lock.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.face-lock', 'face-lock.err.log')}</string>
</dict>
</plist>
`;
  if (action === 'install') {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, body, { mode: 0o644 });
    spawn('launchctl', ['load', plist], { stdio: 'inherit' });
    console.log(`  installed: ${plist}`);
  } else {
    if (fs.existsSync(plist)) {
      spawn('launchctl', ['unload', plist], { stdio: 'inherit' });
      fs.unlinkSync(plist);
      console.log(`  removed: ${plist}`);
    } else {
      console.log('  not installed.');
    }
  }
}

function linuxService(action, node, cli) {
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'face-lock.service');
  const body = `[Unit]
Description=face-lock monitor
After=graphical-session.target

[Service]
ExecStart=${node} ${cli} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  if (action === 'install') {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, body, { mode: 0o644 });
    spawn('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    spawn('systemctl', ['--user', 'enable', '--now', 'face-lock.service'], { stdio: 'inherit' });
    console.log(`  installed: ${unit}`);
  } else {
    if (fs.existsSync(unit)) {
      spawn('systemctl', ['--user', 'disable', '--now', 'face-lock.service'], { stdio: 'inherit' });
      fs.unlinkSync(unit);
      console.log(`  removed: ${unit}`);
    } else {
      console.log('  not installed.');
    }
  }
}

function winService(action, node, cli) {
  const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const bat = path.join(startup, 'face-lock.bat');
  if (action === 'install') {
    fs.mkdirSync(startup, { recursive: true });
    fs.writeFileSync(bat, `@echo off\r\n"${node}" "${cli}" start\r\n`, { mode: 0o644 });
    console.log(`  installed: ${bat}`);
  } else {
    if (fs.existsSync(bat)) { fs.unlinkSync(bat); console.log(`  removed: ${bat}`); }
    else console.log('  not installed.');
  }
}

program.parseAsync(process.argv);
