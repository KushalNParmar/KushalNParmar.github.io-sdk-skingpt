import test from 'node:test';
import assert from 'node:assert/strict';
import { coverTransform, frameRectToView, viewRectToFrame, processingSize, rectFromPoints, isValidBox } from '../src/geometry.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, a + ' != ' + b);

test('portrait cover crop maps the camera center and a known ROI accurately', () => {
  const t = coverTransform(640, 480, 390, 844);
  const r = frameRectToView({ x: 260, y: 150, width: 120, height: 180 }, t);
  near(r.x, 89.5);
  near(r.y, 263.75);
  near(r.width, 211);
  near(r.height, 316.5);
  const center = frameRectToView({ x: 320, y: 240, width: 0, height: 0 }, t);
  near(center.x, 195);
  near(center.y, 422);
  const selected = viewRectToFrame(r, t, 640, 480);
  near(selected.x, 260); near(selected.y, 150);
  near(selected.width, 120); near(selected.height, 180);
});

test('landscape cover crop accounts for the vertically hidden video edges', () => {
  const t = coverTransform(640, 480, 1200, 800);
  near(t.scale, 1.875);
  near(t.offsetX, 0);
  near(t.offsetY, -50);
  const selected = viewRectToFrame({ x: 0, y: 0, width: 1200, height: 800 }, t, 640, 480);
  near(selected.x, 0);
  near(selected.y, 80 / 3);
  near(selected.width, 640);
  near(selected.height, 1280 / 3);
});

test('reverse-direction drag and processing dimensions preserve geometry', () => {
  assert.deepEqual(rectFromPoints({ x: 240, y: 330 }, { x: 60, y: 90 }), { x: 60, y: 90, width: 180, height: 240 });
  assert.deepEqual(processingSize(1920, 1080, 640), { width: 640, height: 360 });
  assert.deepEqual(processingSize(720, 1280, 640), { width: 360, height: 640 });
  assert.deepEqual(processingSize(320, 240, 640), { width: 320, height: 240 });
});

test('invalid or entirely offscreen estimates are never rendered', () => {
  assert.equal(isValidBox({ x: NaN, y: 0, width: 20, height: 20 }, 640, 480), false);
  assert.equal(isValidBox({ x: 800, y: 0, width: 20, height: 20 }, 640, 480), false);
  assert.equal(isValidBox({ x: 0, y: 0, width: 0, height: 20 }, 640, 480), false);
  assert.equal(isValidBox({ x: 0, y: 0, width: 9000, height: 20 }, 640, 480), false);
  assert.equal(isValidBox({ x: -10, y: 20, width: 60, height: 80 }, 640, 480), true);
});
