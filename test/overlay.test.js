'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

// Tests for the cross-platform display-sleep module. The Windows path
// is the one that has historically been broken on external monitors
// (WmiSetBrightness only works on built-in laptop panels). The fix in
// v0.2.0-alpha.8 uses SendMessage(SC_MONITORPOWER) which works on all
// displays.
//
// We don't actually run PowerShell in CI — we monkey-patch child_process.spawn
// to capture the args the overlay module would invoke.

function loadOverlayWithSpawnCapture() {
  // Force a fresh require so the test sees a clean module state
  const overlayPath = require.resolve('../src/overlay');
  delete require.cache[overlayPath];
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  const calls = [];
  cp.spawn = function (cmd, args, opts) {
    calls.push({ cmd, args, opts });
    // Return a dummy child object so the overlay module's .on/.unref work
    return {
      on: () => {},
      unref: () => {},
    };
  };
  // Re-require the module with our patched spawn
  delete require.cache[overlayPath];
  const overlay = require('../src/overlay');
  // Restore
  cp.spawn = origSpawn;
  return { overlay, calls };
}

test('overlay: Windows dim uses SendMessage(SC_MONITORPOWER), not WmiSetBrightness', () => {
  // The WmiSetBrightness call only works on built-in laptop panels and is
  // a silent no-op on external monitors. SendMessage(SC_MONITORPOWER) is
  // the canonical "turn off any display" call. We assert the args do
  // NOT contain "WmiSetBrightness" and DO contain the SC_MONITORPOWER
  // constants.
  //
  // We force the Windows path by faking os.platform() via the module's
  // own platform switch. The simplest way: temporarily set process.platform
  // (Node doesn't allow reassigning, but we can use Object.defineProperty).
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const { overlay, calls } = loadOverlayWithSpawnCapture();
    overlay.sleep();
    assert.ok(calls.length >= 1, 'overlay.sleep() must call spawn at least once on win32');
    const psCall = calls.find(c => c.cmd === 'powershell.exe' || c.cmd === 'powershell');
    assert.ok(psCall, 'windows overlay must call powershell.exe');
    // The -Command argument contains the actual PS code
    const cmdIdx = psCall.args.indexOf('-Command');
    assert.ok(cmdIdx >= 0, 'powershell call must use -Command flag');
    const ps = psCall.args[cmdIdx + 1];
    assert.ok(typeof ps === 'string', '-Command must be followed by a string');
    assert.ok(!/WmiSetBrightness/i.test(ps),
      'Windows dim must NOT use WmiSetBrightness (built-in panel only). ' +
      'Got: ' + ps);
    assert.ok(/SendMessage/i.test(ps),
      'Windows dim must use SendMessage for SC_MONITORPOWER. Got: ' + ps);
    assert.ok(/SC_MONITORPOWER|0xf170/i.test(ps),
      'Windows dim must reference SC_MONITORPOWER (0xf170). Got: ' + ps);
    assert.ok(/HWND_BROADCAST|0xffff/i.test(ps),
      'Windows dim must broadcast to all top-level windows. Got: ' + ps);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('overlay: non-Windows paths unchanged (macOS, Linux)', () => {
  // The Linux/macOS paths already work (pmset, xset dpms). This test
  // guards against accidental regressions when we touch windowsSleep.
  const origPlatform = process.platform;
  const origD = { darwin: 'pmset', linux: 'xset' };

  for (const plat of Object.keys(origD)) {
    Object.defineProperty(process, 'platform', { value: plat, configurable: true });
    const { overlay, calls } = loadOverlayWithSpawnCapture();
    overlay.sleep();
    assert.ok(calls.length >= 1, `${plat} overlay.sleep() must call spawn`);
    const cmd = calls[0].cmd;
    assert.strictEqual(cmd, origD[plat],
      `${plat} overlay must call ${origD[plat]}, got ${cmd}`);
  }
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
});

test('overlay: windowsSleep call is non-blocking (detached + stdio: ignore)', () => {
  // The dim must be fire-and-forget — the monitor loop cannot wait for
  // PowerShell to exit (it might take 1-2s to start on Windows). We
  // assert the spawn options use detached: true and stdio: ignore.
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const { overlay, calls } = loadOverlayWithSpawnCapture();
    overlay.sleep();
    const psCall = calls.find(c => c.cmd === 'powershell.exe' || c.cmd === 'powershell');
    assert.ok(psCall.opts && psCall.opts.detached === true,
      'windowsSleep spawn must be detached');
    assert.ok(psCall.opts && psCall.opts.stdio === 'ignore',
      'windowsSleep spawn must have stdio: ignore');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});
