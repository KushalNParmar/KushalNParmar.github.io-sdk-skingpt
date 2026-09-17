import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredScreenRoll, unwrapAngle, rotatedExtent } from '../src/pose-math.js';

const referenceBox = { x: 120, y: 70, width: 140, height: 180 };
const accepted = homography => ({ reliable: true, homography, referenceBox, featureCount: 24, inlierRatio: 0.85 });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('measured screen roll follows image rotation and removes symmetric stretch', () => {
  const angle = 0.6, c = Math.cos(angle), s = Math.sin(angle);
  // R times a symmetric stretch, with image translation independent of roll.
  close(measuredScreenRoll(accepted([c * 1.3 - s * 0.1, c * 0.1 - s * 0.8, 190,
    s * 1.3 + c * 0.1, s * 0.1 + c * 0.8, -20, 0, 0, 1])), -angle);
  close(measuredScreenRoll(accepted([1.5, 0, -200, 0, 1.5, 400, 0, 0, 1])), 0);
});

test('pose rejects weak, reflected, collapsed, and non-finite feature geometry', () => {
  const identity = accepted([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (const override of [{ reliable: false }, { featureCount: 7 }, { inlierRatio: 0.5 },
    { homography: null }, { homography: [1, 0, 0, 0, -1, 0, 0, 0, 1] },
    { homography: [0.001, 0, 0, 0, 1, 0, 0, 0, 1] },
    { homography: [1, 0, NaN, 0, 1, 0, 0, 0, 1] },
    { referenceBox: { ...referenceBox, width: 0 } }]) {
    assert.equal(measuredScreenRoll({ ...identity, ...override }), null);
  }
});

test('homography scale is immaterial and the local Jacobian handles perspective', () => {
  const h = [1.1, -0.15, 10, 0.18, 0.9, -5, 0.0004, -0.0002, 1];
  close(measuredScreenRoll(accepted(h)), measuredScreenRoll(accepted(h.map(value => value * 7))));
  const x = referenceBox.x + referenceBox.width / 2;
  const y = referenceBox.y + referenceBox.height / 2;
  const at = (x, y) => [(h[0] * x + h[1] * y + h[2]) / (h[6] * x + h[7] * y + h[8]),
    (h[3] * x + h[4] * y + h[5]) / (h[6] * x + h[7] * y + h[8])];
  const e = 0.0001, center = at(x, y), right = at(x + e, y), down = at(x, y + e);
  const a = (right[0] - center[0]) / e, b = (down[0] - center[0]) / e;
  const c = (right[1] - center[1]) / e, d = (down[1] - center[1]) / e;
  assert.ok(Math.abs(measuredScreenRoll(accepted(h)) + Math.atan2(c - b, a + d)) < 1e-7);
});

test('rotation unwraps at the branch cut and bounds include rotated labels', () => {
  const degrees = Math.PI / 180;
  close(unwrapAngle(-179 * degrees, 179 * degrees), 181 * degrees);
  const extent = rotatedExtent(300, 180, Math.PI / 2);
  close(extent.width, 180);
  close(extent.height, 300);
});
