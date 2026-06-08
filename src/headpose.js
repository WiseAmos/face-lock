'use strict';

/**
 * Head-pose estimator from face-api.js's 68-point landmarks.
 *
 * We use a simple, fast, and intentionally conservative heuristic — this is
 * "shoulder-surfing dim" and we want to AVOID false positives. The user
 * specifically said this is harder and more prone to mistakes, so the
 * thresholds are wide.
 *
 *   yaw   = horizontal head turn (negative = looking left, positive = right)
 *   pitch = vertical head tilt  (negative = looking up,   positive = down)
 *
 * Method (no extra model required, uses 5 landmarks only):
 *   - left eye outer corner  (index 36)
 *   - right eye outer corner (index 45)
 *   - nose tip               (index 30)
 *
 * Yaw  ≈ atan2( (nose.x - eyeMid.x), eyeDistance ) — sign tells left/right
 * Pitch ≈ atan2( (nose.y - eyeMid.y), eyeDistance )
 *
 * The eyeDistance normalizes for distance from camera. A person 50cm and 100cm
 * away look the same on yaw, which is the property we want.
 */

function getLandmarks(detection) {
  if (!detection) return null;
  if (detection.landmarks) {
    // face-api.js returns positions as arrays of {x, y}
    return detection.landmarks.positions;
  }
  // Plain array of {x, y}
  if (Array.isArray(detection)) return detection;
  if (detection._positions) return detection._positions;
  return null;
}

function estimateYawPitch(landmarks) {
  if (!landmarks || landmarks.length < 47) return null;
  const leftEye  = landmarks[36];
  const rightEye = landmarks[45];
  const nose     = landmarks[30];
  if (!leftEye || !rightEye || !nose) return null;

  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeMidY = (leftEye.y + rightEye.y) / 2;
  const eyeDist = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (eyeDist < 1) return null;

  const yaw   = Math.atan2(nose.x - eyeMidX, eyeDist);
  const pitch = Math.atan2(nose.y - eyeMidY, eyeDist);
  return { yaw, pitch };
}

/**
 * Decide whether a detected face is "looking at the screen".
 * yaw/pitch are in radians. The thresholds are intentionally wide.
 *   0.35 rad ≈ 20° — anything beyond that and they're clearly not facing the screen.
 */
function isLookingAtScreen(landmarks, { yawMax = 0.35, pitchMax = 0.40 } = {}) {
  const yp = estimateYawPitch(landmarks);
  if (!yp) return true; // cannot tell — be permissive
  return Math.abs(yp.yaw) <= yawMax && Math.abs(yp.pitch) <= pitchMax;
}

module.exports = {
  getLandmarks,
  estimateYawPitch,
  isLookingAtScreen,
};
