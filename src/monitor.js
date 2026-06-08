'use strict';

/**
 * Monitor: the heart of face-lock.
 *
 * State machine:
 *
 *   PRESENT ──no face──▶ GRACE  ──face back──▶ PRESENT
 *      │                  │                      ▲
 *      │                  │  grace expires       │
 *      │                  ▼                      │
 *      │               LOCKED ──face+match──────┘
 *      │                  │
 *      │                  └── face gone OR no match → STAY LOCKED (OS requires password)
 *      │
 *      └── if no profile enrolled, do not lock (run in "demo" / "any-face" mode if configured)
 *
 * The monitor does NOT touch the camera directly. It asks a "frame source" for
 * the current frame, calls `detector.detectOne(frame)`, and decides state.
 * The CLI provides a real camera source; tests provide a fake.
 */

const EventEmitter = require('events');
const config = require('./config');
const profile = require('./profile');
const { detectOne } = require('./detector');
const lock = require('./lock');
const overlay = require('./overlay');
const headpose = require('./headpose');

const STATE = Object.freeze({
  PRESENT: 'PRESENT',
  GRACE:   'GRACE',
  LOCKED:  'LOCKED',
});

class Monitor extends EventEmitter {
  constructor({
    config: cfg = config.load(),
    frameSource,                  // { async getFrame() } — canvas / image / video
    sleepFn = overlay.sleep,
    lockFn = lock.lock,
    detectFn = detectOne,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    this.cfg = cfg;
    this.frameSource = frameSource;
    this.sleep = sleepFn;
    this.doLock = lockFn;
    this.detect = detectFn;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.state = STATE.PRESENT;
    this.presentStreak = 0;
    this.graceTimer = null;
    this.softBlockTimer = null;
    this.awayDimTimer = null;
    this.awayStreak = 0;        // consecutive frames where face is present but off-screen
    this.awayDimActive = false;
    this.running = false;
    this.profile = null;

    if (profile.exists()) {
      this.profile = profile.load();
    }
  }

  log(level, msg) {
    if (this.cfg.logLevel >= level) {
      // eslint-disable-next-line no-console
      console.error(`[face-lock:${this.state}] ${msg}`);
    }
  }

  async tick() {
    if (!this.running) return;
    let frame;
    try {
      frame = await this.frameSource.getFrame();
    } catch (err) {
      this.log(1, `frame source error: ${err.message}`);
      return;
    }
    if (!frame) return;

    const result = await this.detect(frame);
    const isYou = this.isMatch(result);

    this.log(2, `face=${!!result} you=${isYou}`);

    if (isYou) {
      this.presentStreak++;
      if (this.presentStreak >= this.cfg.minPresentFrames && this.state === STATE.GRACE) {
        // Cancel grace — face returned within the window. LOCKED is terminal:
        // the OS lock is already fired and requires a password to come back.
        this.onReturned();
      } else if (this.state === STATE.PRESENT) {
        // stay present
      } else if (this.state === STATE.LOCKED) {
        // stay locked — face presence cannot override OS lock
      }
      // Shoulder-surfing dim: face is yours but head is turned away.
      this.checkAwayDim(result);
    } else {
      this.presentStreak = 0;
      this.clearAwayDim();
      if (this.state === STATE.PRESENT) {
        this.onLeft();
      } else if (this.state === STATE.GRACE) {
        // let the timer expire naturally
      }
    }
  }

  /**
   * "Away face" handling: a face is detected (and matches you) but the head
   * pose is off-screen. This could be a stranger leaning in, or you looking
   * away from the laptop. Default behaviour: dim the screen (fire soft-block
   * style sleep) but do NOT start the lock grace timer — we still see your
   * face, so we don't want to fully lock you out.
   *
   * Disabled by default — see `awayFaceDimEnabled` in config. The user
   * explicitly noted this is more prone to mistakes.
   */
  checkAwayDim(result) {
    if (!this.cfg.awayFaceDimEnabled) return;
    if (this.state === STATE.LOCKED) return;
    const landmarks = headpose.getLandmarks(result && result.detection);
    const looking = headpose.isLookingAtScreen(landmarks, {
      yawMax:   this.cfg.awayFaceDimYawMax,
      pitchMax: this.cfg.awayFaceDimPitchMax,
    });
    if (looking) {
      this.awayStreak = 0;
      this.clearAwayDim();
      return;
    }
    this.awayStreak++;
    if (this.awayStreak * this.cfg.detectionIntervalMs >= this.cfg.awayFaceDimDelayMs && !this.awayDimActive) {
      this.awayDimActive = true;
      this.log(1, 'face off-screen: dimming (awayFaceDim)');
      this.emit('away-dim');
      this.sleep();
    }
  }

  clearAwayDim() {
    if (this.awayDimActive) {
      this.awayDimActive = false;
      this.awayStreak = 0;
      this.log(1, 'face back on-screen: undim');
      this.emit('away-undim');
    }
  }

  isMatch(result) {
    if (!result) return false;
    if (!this.profile) {
      // No enrolled profile — fall back to "any face = you" so the tool is
      // still useful as a presence detector. CLI warns the user at init.
      return true;
    }
    const m = profile.match(this.profile, result.descriptor, this.cfg.matchThreshold);
    return m.match;
  }

  onLeft() {
    this.state = STATE.GRACE;
    this.log(1, `face lost — ${this.cfg.graceMs}ms grace started`);
    this.emit('left');
    this.scheduleGrace();
  }

  onReturned() {
    this.state = STATE.PRESENT;
    this.log(1, 'face back — grace cancelled');
    this.emit('returned');
    this.clearGrace();
  }

  scheduleGrace() {
    this.clearGrace();
    // soft block fires after a short delay (default 2s) so quick glances
    // don't flash the display off
    if (this.cfg.softBlockEnabled) {
      this.softBlockTimer = this.setTimer(() => {
        this.log(1, 'soft block: display off');
        this.emit('soft-block');
        this.sleep();
      }, this.cfg.softBlockDelayMs);
    }
    this.graceTimer = this.setTimer(() => {
      this.state = STATE.LOCKED;
      this.log(1, 'grace expired — locking OS session');
      this.emit('lock');
      this.doLock();
    }, this.cfg.graceMs);
  }

  clearGrace() {
    if (this.graceTimer) { this.clearTimer(this.graceTimer); this.graceTimer = null; }
    if (this.softBlockTimer) { this.clearTimer(this.softBlockTimer); this.softBlockTimer = null; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log(1, 'monitor started');
    this.emit('start');
  }

  stop() {
    this.running = false;
    this.clearGrace();
    this.awayDimActive = false;
    this.awayStreak = 0;
    this.log(1, 'monitor stopped');
    this.emit('stop');
  }
}

module.exports = { Monitor, STATE };
