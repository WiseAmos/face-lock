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
  // Canonical "turn off any monitor" call. Works on BOTH built-in laptop
  // panels AND external monitors connected via HDMI/DP/DVI.
  //
  // The old approach (WmiSetBrightness 0,0) only worked on built-in panels
  // because it relies on the WmiMonitorBrightnessMethods WMI class, which
  // is implemented by the panel driver and not exposed by external monitor
  // drivers. On a desktop or laptop-with-external-display, the call returned
  // 0 (success) but did nothing visible.
  //
  // SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2) goes
  // through the user32.dll display driver path and works on all display
  // types. Constants: HWND_BROADCAST=0xffff, WM_SYSCOMMAND=0x0112,
  // SC_MONITORPOWER=0xf170, POWER_OFF=0x0002.
  //
  // We compile the P/Invoke type once per call (PowerShell sessions are
  // short-lived for this fire-and-forget spawn). 1-second spawn timeout
  // because this is fire-and-forget — the user only needs the display off.
  const ps = [
    "Add-Type -TypeDefinition '",
    "using System;",
    "using System.Runtime.InteropServices;",
    "namespace FL { public static class D {",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Auto)]",
    "  private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);",
    "  public static void Off() {",
    "    SendMessage((IntPtr)0xffff, 0x0112, (IntPtr)0xf170, (IntPtr)0x0002);",
    "  }",
    "} }'",
    ";[FL.D]::Off()",
  ].join('\n');
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
