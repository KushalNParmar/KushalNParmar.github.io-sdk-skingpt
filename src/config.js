export const CONFIG = Object.freeze({
  experienceUrl: './assets/experience.json',
  minSelectionPixels: 36,
  startupTimeoutMs: 30000,
  world: Object.freeze({
    stableFrames: 6,
    stableMs: 180,
    positionTolerance: 0.04,
    normalToleranceDegrees: 12,
    minDistance: 0.25,
    maxDistance: 5,
    maxSurfaceTiltDegrees: 30,
    offsetRight: 0.30,
    offsetUp: 0.015,
  }),
});
