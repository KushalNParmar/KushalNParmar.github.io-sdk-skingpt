import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldTracker } from '../src/world-tracker.js';
import { identity, multiply, inverseRigid, selectionRay, placementMatrix, quaternionFromMatrix, rigidMatrix } from '../src/world-math.js';

// Explicit unit-test doubles. Production code only accepts the browser's XR session.
globalThis.XRRay = class { constructor(origin, direction) { this.origin = origin; this.direction = direction; } };
globalThis.XRRigidTransform = class { constructor(position, orientation) { this.position = position; this.orientation = orientation; } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function transform(x = 0, y = 0, z = 0, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1];
}
const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002002, -1, 0, 0, -0.2002002, 0];
function pose(matrix, emulatedPosition = false) { return { transform: { matrix }, emulatedPosition }; }
function approx(actual, expected, epsilon = 1e-7) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon, 'Component ' + index + ': ' + value + ' != ' + expected[index]));
}

async function harness(config = {}) {
  const referenceSpace = new EventTarget();
  const session = new EventTarget();
  const sources = [], anchors = [], requests = [], errors = [], snapshots = [];
  session.visibilityState = 'visible';
  session.requestReferenceSpace = async kind => { assert.equal(kind, 'viewer'); return { kind }; };
  session.requestHitTestSource = async options => {
    requests.push(options);
    const source = { cancelled: 0, cancel() { this.cancelled++; } };
    sources.push(source);
    return source;
  };
  const tracker = new WorldTracker({ config, onChange: state => snapshots.push(state), onError: error => errors.push(error) });
  await tracker.start(session, referenceSpace);
  let now = 0;
  const values = {
    viewer: transform(0, 1.4, 0), hit: transform(0, 0, -1.5), anchorMatrix: null,
    missingViewer: false, missingAnchor: false, emulatedViewer: false, emulatedHit: false, emulatedAnchor: false,
    noHit: false, viewRelative: identity(), create: null, fallback: false, invalidHit: null
  };
  function newAnchor() {
    const anchor = { anchorSpace: { id: anchors.length }, deleted: 0, delete() { this.deleted++; } };
    anchors.push(anchor);
    return anchor;
  }
  function update() {
    let active = true;
    function mustBeActive() { assert.equal(active, true, 'WebXR frame-bound API called after frame ended'); }
    const hit = {
      getPose() { mustBeActive(); return pose(values.invalidHit || values.hit, values.emulatedHit); }
    };
    const create = () => {
      mustBeActive();
      return values.create ? values.create() : Promise.resolve(newAnchor());
    };
    if (!values.fallback) hit.createAnchor = create;
    const frame = {
      session,
      getViewerPose(space) {
        mustBeActive(); assert.equal(space, referenceSpace);
        return values.missingViewer ? null : {
          ...pose(values.viewer, values.emulatedViewer),
          views: [{ eye: 'none', projectionMatrix: projection, transform: { matrix: multiply(values.viewer, values.viewRelative) } }]
        };
      },
      getHitTestResults(source) { mustBeActive(); assert.ok(sources.includes(source)); return values.noHit ? [] : [hit]; },
      getPose(space, base) {
        mustBeActive(); assert.equal(base, referenceSpace); assert.ok(anchors.some(a => a.anchorSpace === space));
        return values.missingAnchor ? null : pose(values.anchorMatrix || values.hit, values.emulatedAnchor);
      },
      createAnchor(rigid, space) {
        mustBeActive(); assert.equal(space, referenceSpace);
        approx(Object.values(rigid.position), values.hit.slice(12, 15));
        return create();
      }
    };
    try { tracker.update(frame, now += 40); } finally { active = false; }
    return tracker.snapshot;
  }
  async function select(point = { x: 0.5, y: 0.75 }) { update(); await tracker.setSelection(point); }
  function settle() { for (let i = 0; i < 7; i++) update(); assert.equal(tracker.state, 'ready'); }
  async function place() { settle(); assert.equal(tracker.requestPlacement(), true); update(); assert.equal(tracker.state, 'placing'); await tick(); update(); assert.equal(tracker.state, 'anchored'); }
  return { tracker, session, referenceSpace, values, sources, anchors, requests, errors, snapshots, update, select, settle, place, newAnchor };
}

test('selection rays follow the XR projection, image Y direction, and eye offset', () => {
  const centre = selectionRay({ x: 0.5, y: 0.5 }, projection);
  approx(Object.values(centre.direction), [0, 0, -1, 0]);
  const bottomRight = selectionRay({ x: 1, y: 1 }, projection, transform(.03, 0, 0));
  assert.ok(bottomRight.direction.x > 0 && bottomRight.direction.y < 0 && bottomRight.direction.z < 0);
  approx(Object.values(bottomRight.origin), [.03, 0, 0, 1]);
  assert.equal(selectionRay({ x: 2, y: .5 }, projection), null);
  assert.equal(selectionRay({ x: .5, y: .5 }, new Array(16).fill(0)), null);
});

test('rigid inverse, upright initial placement, and quaternion preserve a rotated hit', () => {
  const hit = transform(2, .5, -3, .7);
  approx(multiply(inverseRigid(hit), hit), identity());
  const world = placementMatrix(hit, transform(2, 1.4, 0));
  approx(world.slice(12, 15), [2.3, .515, -3]);
  approx(world.slice(4, 7), [0, 1, 0]);
  approx(multiply(hit, multiply(inverseRigid(hit), world)), world);
  const q = quaternionFromMatrix(hit);
  approx(Object.values(q), [0, Math.sin(.35), 0, Math.cos(.35)]);
  assert.equal(rigidMatrix(new Array(16).fill(0)), false);
});

test('surface stability gates placement and a queued tap is cancelled when the hit jumps', async () => {
  const h = await harness();
  await h.select();
  assert.equal(h.tracker.requestPlacement(), false);
  h.update();
  h.update();
  assert.equal(h.tracker.state, 'aiming');
  h.settle();
  assert.equal(h.tracker.requestPlacement(), true);
  h.values.hit = transform(.1, 0, -1.5);
  h.update();
  await tick();
  assert.equal(h.anchors.length, 0);
  assert.equal(h.tracker.state, 'aiming');
  await h.place();
  assert.equal(h.anchors.length, 1);
});

test('world pose stays fixed during camera orbit and applies anchor refinements', async () => {
  const h = await harness();
  h.values.hit = transform(.2, 0, -1.5, .45);
  await h.select();
  await h.place();
  const originalWorld = h.tracker.snapshot.worldMatrix;
  const originalAnchor = Array.from(h.values.hit);
  h.values.viewer = transform(1.5, 1.4, -1.5, Math.PI / 2);
  const orbited = h.update();
  approx(orbited.worldMatrix, originalWorld);
  h.values.anchorMatrix = transform(.23, .01, -1.49, .48);
  const refined = h.update();
  approx(refined.worldMatrix, multiply(h.values.anchorMatrix, multiply(inverseRigid(originalAnchor), originalWorld)));
  assert.equal(h.sources[0].cancelled, 1);
});

test('missing or emulated viewer and anchor poses hide content and recover the same anchor', async () => {
  const h = await harness();
  await h.select();
  await h.place();
  const world = h.tracker.snapshot.worldMatrix;
  for (const flag of ['missingViewer', 'emulatedViewer', 'missingAnchor', 'emulatedAnchor']) {
    h.values[flag] = true;
    assert.equal(h.update().state, 'limited');
    assert.equal(h.tracker.snapshot.worldMatrix, null);
    assert.equal(h.anchors[0].deleted, 0);
    h.values[flag] = false;
    assert.equal(h.update().state, 'anchored');
    approx(h.tracker.snapshot.worldMatrix, world);
  }
  assert.equal(h.anchors.length, 1);
});

test('invalid, too distant, emulated, and vertical surface hits never permit placement', async () => {
  const h = await harness();
  await h.select();
  const vertical = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -1.5, 1];
  for (const invalid of [transform(0, 0, -10), new Array(16).fill(0), vertical]) {
    h.values.invalidHit = invalid;
    for (let i = 0; i < 10; i++) h.update();
    assert.equal(h.tracker.state, 'aiming');
    assert.equal(h.tracker.requestPlacement(), false);
  }
  h.values.invalidHit = null;
  h.values.emulatedHit = true;
  for (let i = 0; i < 10; i++) h.update();
  assert.equal(h.tracker.requestPlacement(), false);
  h.values.emulatedHit = false;
  await h.place();
});

test('late hit-test sources are cancelled after a new selection and after stop', async () => {
  const h = await harness();
  h.update();
  const first = deferred(), second = deferred();
  let requests = 0;
  h.session.requestHitTestSource = () => (++requests === 1 ? first.promise : second.promise);
  const p1 = h.tracker.setSelection({ x: .2, y: .7 });
  const p2 = h.tracker.setSelection({ x: .7, y: .7 });
  const firstSource = { cancelled: 0, cancel() { this.cancelled++; } };
  first.resolve(firstSource);
  assert.equal(await p1, false);
  assert.equal(firstSource.cancelled, 1);
  h.tracker.stop();
  const secondSource = { cancelled: 0, cancel() { this.cancelled++; } };
  second.resolve(secondSource);
  assert.equal(await p2, false);
  assert.equal(secondSource.cancelled, 1);
  assert.equal(h.tracker.state, 'idle');
});

test('pending anchors are deleted if reset, reference reset, or session end invalidates placement', async () => {
  for (const invalidate of ['reset', 'referenceReset', 'sessionEnd']) {
    const h = await harness();
    await h.select();
    h.settle();
    const pending = deferred();
    h.values.create = () => pending.promise;
    h.tracker.requestPlacement();
    h.update();
    if (invalidate === 'reset') h.tracker.reset();
    else if (invalidate === 'referenceReset') h.referenceSpace.dispatchEvent(new Event('reset'));
    else h.session.dispatchEvent(new Event('end'));
    const anchor = h.newAnchor();
    pending.resolve(anchor);
    await tick();
    assert.equal(anchor.deleted, 1);
    assert.equal(h.tracker.snapshot.worldMatrix, null);
    assert.equal(h.tracker.anchor, null);
    assert.equal(h.sources[0].cancelled, 1);
  }
});

test('failed anchor creation permits a fresh stable placement and frame API fallback stays synchronous', async () => {
  const h = await harness();
  await h.select();
  h.values.create = () => Promise.reject(new Error('native placement failed'));
  h.settle();
  h.tracker.requestPlacement();
  h.update();
  await tick();
  assert.equal(h.tracker.state, 'aiming');
  assert.equal(h.errors.length, 1);
  h.values.create = null;
  h.values.fallback = true;
  await h.place();
  assert.equal(h.anchors.length, 1);
});

test('placement timeout allows retry and deletes a later successful anchor', async () => {
  const h = await harness({ placementTimeoutMs: 100 });
  await h.select();
  h.settle();
  const pending = deferred();
  h.values.create = () => pending.promise;
  h.tracker.requestPlacement(); h.update();
  for (let i = 0; i < 4; i++) h.update();
  assert.equal(h.tracker.state, 'aiming');
  const stale = h.newAnchor();
  pending.resolve(stale);
  await tick();
  assert.equal(stale.deleted, 1);
  h.values.create = null;
  await h.place();
});

test('reference reset deletes an active anchor and visibility loss recovers without rebasing', async () => {
  const h = await harness();
  await h.select();
  await h.place();
  const world = h.tracker.snapshot.worldMatrix;
  h.session.visibilityState = 'hidden';
  h.session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.tracker.state, 'limited');
  assert.equal(h.update().worldMatrix, null);
  h.session.visibilityState = 'visible';
  h.session.dispatchEvent(new Event('visibilitychange'));
  approx(h.update().worldMatrix, world);
  h.referenceSpace.dispatchEvent(new Event('reset'));
  assert.equal(h.tracker.state, 'scanning');
  assert.equal(h.anchors[0].deleted, 1);
  assert.equal(h.tracker.snapshot.worldMatrix, null);
  h.update();
  assert.equal(h.tracker.state, 'scanning');
});
