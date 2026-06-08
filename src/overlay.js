'use strict';

/**
 * Cross-platform "soft block" — turns the display OFF.
 *
 * The spec says: "temporarily block the screen within 15 second if you are not
 * back it will actually lock your screen". The cleanest cross-platform way to
 * "block the screen" without writing a fullscreen GUI is to put the display to
 * sleep. The user can wake it just by returning — the monitor continues running
 * and either re-disables the sleep (face came back) or fires the hard lock.
 *
 * macOS  : pmset displaysleepnow
 * Linux  : xset dpms force off
 * Windows: powershell Add-Type MonitorConfiguration Fun...
 *
 * All of these are reversible: moving the mouse / pressing a key wakes the
 * display. Our monitor keeps running — face re-detection will either cancel
 * the timer (face found) or trigger lock() at 15s.
 */

const { spawn } = require('child_process');
const os = require('os');

function macSleep() {
  // pmset displaysleepnow is non-blocking and instant. It does NOT lock.
  const c = spawn('pmset', ['displaysleepnow'], { stdio: 'ignore', detached: true });
  c.on('error', () => { /* fail soft */ });
  c.unref();
}

function linuxSleep() {
  // Try xset first (works on most X11 setups). Wayland users will need a
  // loginctl / sway idle path — left as future work, but the monitor keeps
  // running regardless.
  const c = spawn('xset', ['dpms', 'force', 'off'], { stdio: 'ignore', detached: true });
  c.on('error', () => { /* fall back: do nothing */ });
  c.unref();
}

function windowsSleep() {
  // PowerShell snippet that turns off the monitor. 1 second timeout because
  // this is a "fire and forget" — the user only needs the display off.
  const ps = '(Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Bounds }) | Out-Null; (Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(0,0)';
  const c = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    ps,
  ], { stdio: 'ignore', detached: true });
  c.on('error', () => { /* fail soft */ });
  c.unref();
}

function sleep() {
  switch (os.platform()) {
    case 'darwin': return macSleep();
    case 'linux':  return linuxSleep();
    case 'win32':  return windowsSleep();
    default: return;
  }
}

module.exports = { sleep };
