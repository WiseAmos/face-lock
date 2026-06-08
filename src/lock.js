'use strict';

/**
 * Cross-platform OS-level screen lock.
 *
 * macOS  : pmset displaysleepnow (then put back to sleep with caffeinate guard off)
 *          — actually `pmset` only sleeps the display, not locks. The bullet-proof
 *          macOS lock is via AppleScript "ScreenSaverEngine" / lock screen.
 * Linux  : loginctl lock-session (systemd) OR xdg-screensaver lock OR gnome-screensaver
 * Windows: rundll32.exe user32.dll,LockWorkStation
 *
 * We use a child_process.spawn (NOT exec) so we never pass a shell-interpolated
 * string — no shell injection risk even with weird usernames.
 */

const { spawn } = require('child_process');
const os = require('os');

function macLock() {
  // AppleScript: "tell System Events to keystroke \"q\" using {command down, control down}"
  // is the standard "Lock Screen" shortcut. The user may have rebound it; we also try
  // the direct System Events lock.
  const script = 'tell application "System Events" to keystroke "q" using {command down, control down}';
  const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    // Fallback: launch the screen saver directly
    spawn('open', ['-a', 'ScreenSaverEngine'], { stdio: 'ignore', detached: true });
  });
  child.unref();
}

function linuxLock() {
  // Try a sequence of fallback commands, first one that works wins.
  const candidates = [
    ['loginctl', ['lock-session']],
    ['xdg-screensaver', ['lock']],
    ['gnome-screensaver-command', ['-l']],
    ['cinnamon-screensaver-command', ['-l']],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => { /* try next */ });
      child.unref();
      return;
    } catch (_) {
      // continue
    }
  }
  // No command found — caller should log this. We do not throw to avoid
  // crashing the monitor loop.
}

function windowsLock() {
  // The canonical Windows lock. rundll32 with user32.dll,LockWorkStation.
  const child = spawn('rundll32.exe', ['user32.dll,LockWorkStation'], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => { /* swallow */ });
  child.unref();
}

function lock() {
  switch (os.platform()) {
    case 'darwin': return macLock();
    case 'linux':  return linuxLock();
    case 'win32':  return windowsLock();
    default:
      // Unknown platform — fail soft so the monitor doesn't crash.
      // eslint-disable-next-line no-console
      console.error(`[face-lock] unsupported platform: ${os.platform()}`);
  }
}

module.exports = { lock };
