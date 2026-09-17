import test from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, boxQuad, project, spatialCoverage, validateHomography, TrackingFusion } from '../src/tracking-math.js';
import { HybridTrackCore } from '../src/hybrid-core.js';
import { NanoTrackCore } from '../src/nanotrack-core.js';
import { FeatureTracker } from '../src/feature-tracker.js';

const box = { x: 100, y: 80, width: 100, height: 140 };
const shifted = { ...box, x: 115, y: 87 };
const feature = (target = shifted, referenceVerified = false) => ({ reliable: true, box: target, quad: boxQuad(target),
  homography: [1, 0, target.x - box.x, 0, 1, target.y - box.y, 0, 0, 1], featureCount: 35, inlierRatio: .91, referenceVerified });
const nano = (target = shifted, score = .95) => ({ reliable: true, box: target, score });

test('homography projects original corners and rejects folds, horizon crossings, implausible jumps', () => {
  const h = [1.05, -.12, 16, .12, 1.05, -14, .0001, .0002, 1];
  const geometry = validateHomography(h, box, 640, 480, box);
  assert(geometry);
  assert.deepEqual(geometry.quad[0], project(h, boxQuad(box)[0]));
  assert.equal(validateHomography([-1, 0, 300, 0, 1, 0, 0, 0, 1], box, 640, 480), null);
  assert.equal(validateHomography([1, 0, 0, 0, 1, 0, .01, 0, -1.5], box, 640, 480), null);
  assert.equal(validateHomography([1, 0, 300, 0, 1, 0, 0, 0, 1], box, 640, 480, box), null);
  assert.equal(validateHomography([1, 0, 0, 0, NaN, 0, 0, 0, 1], box, 640, 480), null);
});

test('perspective requires features distributed in two dimensions', () => {
  const edge = Array.from({ length: 24 }, (_, i) => ({ x: box.x + i * 3, y: box.y + i * 3 }));
  assert.equal(spatialCoverage(edge, box), 0);
  const grid = Array.from({ length: 25 }, (_, i) => ({ x: box.x + 10 + (i % 5) * 20, y: box.y + 10 + Math.floor(i / 5) * 30 }));
  assert(spatialCoverage(grid, box) > .6);
});

test('corroborated geometry is used without blending lag or separating quad from box', () => {
  const fusion = new TrackingFusion();
  fusion.select(box, true, 0);
  const measured = feature();
  const result = fusion.update(nano({ ...shifted, x: shifted.x + 8 }), measured, 50);
  assert.equal(result.trackingMode, 'hybrid');
  assert.deepEqual(result.box, shifted);
  assert.equal(result.quad, measured.quad);
  assert.equal(result.geometryConfidence, .91);
});

test('feature-only continuation is bounded and never accepts prolonged disagreement', () => {
  const fusion = new TrackingFusion({ maxFeatureOnlyMs: 350, maxFeatureOnlyFrames: 3 });
  fusion.select(box, true, 0);
  const doubtful = { reliable: false, score: .5 };
  assert.equal(fusion.update(doubtful, feature(), 100).trackingMode, 'features');
  assert.equal(fusion.update(doubtful, feature(), 200).reliable, true);
  assert.equal(fusion.update(doubtful, feature(), 300).reliable, true);
  assert.equal(fusion.update(doubtful, feature(), 400).reliable, false);
  assert.equal(fusion.update(nano(), feature(), 450).reliable, false, 'chained flow cannot restore a lost lock');
  assert.equal(fusion.update(nano(), feature(shifted, true), 500).reliable, true, 'original reference plus NanoTrack restores lock');
});

test('lost textured targets require original reference evidence and search expires', () => {
  const fusion = new TrackingFusion({ maxNanoOnlyMs: 100, recoveryWindowMs: 500 });
  fusion.select(box, true, 0);
  assert.equal(fusion.update(nano(), null, 50).reliable, true);
  assert.equal(fusion.update(nano(shifted, .83), null, 200).reason, 'visual-detail-lost');
  assert.equal(fusion.update(nano(), feature(), 250).reliable, false);
  assert.equal(fusion.update(nano(), feature(shifted, true), 800).reason, 'reselect-required');
});

test('low-texture NanoTrack fallback needs consecutive strong local candidates after a miss', () => {
  const fusion = new TrackingFusion();
  fusion.select(box, false, 0);
  assert.equal(fusion.update(nano(), null, 50).reliable, true);
  const bad = fusion.update(nano({ ...box, x: 510 }), null, 100);
  assert.equal(bad.reliable, false);
  assert.deepEqual(bad.box, shifted);
  assert.equal(fusion.update(nano(shifted, .83), null, 150).reliable, false);
  assert.equal(fusion.update(nano(shifted, .96), null, 200).reliable, false);
  assert.equal(fusion.update(nano(shifted, .97), null, 250).reliable, true);
});

test('strong continuous NanoTrack can keep working when a viewpoint no longer supports geometry', () => {
  const fusion = new TrackingFusion({ maxNanoOnlyMs: 250 });
  fusion.select(box, true, 0);
  assert.equal(fusion.update(nano(), null, 50).reliable, true);
  assert.equal(fusion.update(nano(), null, 150).reliable, true);
  const continued = fusion.update(nano(), { reliable: false, referenceEvidence: 8 }, 350);
  assert.equal(continued.reliable, true);
  assert.equal(continued.trackingMode, 'nanotrack');
  assert.equal(continued.homography, null, 'no unmeasured rotation is published');
  assert.equal(fusion.update(nano(), { reliable: false, referenceEvidence: 0 }, 900).reliable, false, 'score alone cannot sustain an occluded target');
});

test('a rejected appearance search is rolled back without reinitializing the selected template', async () => {
  const core = Object.create(HybridTrackCore.prototype);
  let searchBox, selections = 0;
  Object.assign(core, { destroyed: false, referenceBox: box, frameWidth: 640, frameHeight: 480,
    fusion: new TrackingFusion(), features: null,
    nano: { readFrame: frame => frame, update: async () => nano({ ...box, x: 500 }), setSearchBox: b => { searchBox = b; }, select: () => ++selections } });
  core.fusion.select(box, false, 0);
  const result = await core.update({ width: 640, height: 480 });
  assert.equal(result.reliable, false);
  assert.deepEqual(searchBox, box);
  assert.equal(selections, 0);
});

test('optional feature runtime failures preserve NanoTrack operation and clean up once', async () => {
  const core = Object.create(HybridTrackCore.prototype);
  let featureCleanups = 0;
  Object.assign(core, { destroyed: false, referenceBox: box, frameWidth: 640, frameHeight: 480, fusion: new TrackingFusion(),
    features: { update() { throw new Error('Unsupported optical flow'); }, destroy() { ++featureCleanups; } },
    nano: { readFrame: frame => frame, update: async () => nano(), setSearchBox() {}, destroy: async () => {} } });
  core.fusion.select(box, true, performance.now());
  const result = await core.update({ width: 640, height: 480 });
  assert.equal(result.reliable, true);
  assert.equal(result.featuresAvailable, false);
  assert.match(result.featuresWarning, /Unsupported optical flow/);
  await core.destroy();
  await core.destroy();
  assert.equal(featureCleanups, 1);
});

test('search correction never modifies NanoTrack reference tensor or invalidates frame dimensions', () => {
  const core = new NanoTrackCore({ env: {} }, {});
  const template = {};
  core.template = template;
  core.state = { cx: 150, cy: 150, width: 100, height: 140, frameWidth: 640, frameHeight: 480 };
  core.setSearchBox(shifted);
  assert.equal(core.template, template);
  assert.equal(core.state.cx, 165);
  core.setSearchBox({ x: NaN, y: 3, width: 20, height: 20 });
  assert.equal(core.state.cx, 165);
  assert.equal(core.state.frameWidth, 640);
});

test('rejected feature geometry cannot poison the next original-reference recovery seed', () => {
  const tracker = Object.create(FeatureTracker.prototype);
  let deleted = 0;
  Object.assign(tracker, { trustedHomography: [...IDENTITY], trustedBox: box, lastHomography: [1, 0, 60, 0, 1, 30, 0, 0, 1],
    lastBox: shifted, previousGray: { delete() { ++deleted; } }, currentPoints: [{ x: 8, y: 9 }], referencePoints: [{ x: 1, y: 2 }],
    originalPoints: [{ x: 100, y: 80 }], referenceGray: {}, referenceEvidence: 18, lastReferenceEvidenceAt: 900 });
  const original = tracker.referenceGray;
  tracker.rejectGeometry();
  assert.equal(deleted, 1);
  assert.deepEqual(tracker.lastHomography, IDENTITY);
  assert.deepEqual(tracker.lastBox, box);
  assert.equal(tracker.currentPoints.length, 0);
  assert.equal(tracker.referenceGray, original, 'the original reference is retained');
  assert.equal(tracker.referenceEvidence, 0);
});

test('OpenCV loader does not assimilate an Emscripten self-thenable', async () => {
  const prior = globalThis.cv;
  let assimilations = 0;
  const module = { Mat() {}, goodFeaturesToTrack() {}, calcOpticalFlowPyrLK() {}, findHomography() {}, then(callback) { ++assimilations; callback(module); } };
  globalThis.cv = module;
  try {
    const { loadOpenCV } = await import('../src/opencv-runtime.js');
    const result = await loadOpenCV();
    assert.equal(result.cv, module);
    assert.equal(assimilations, 0);
  } finally { globalThis.cv = prior; }
});
