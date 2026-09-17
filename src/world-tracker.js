import { finiteMatrix, rigidMatrix, multiply, inverseRigid, selectionRay, translationDistance, normalDot, placementMatrix, quaternionFromMatrix } from './world-math.js';

const DEFAULTS = Object.freeze({
  stableFrames: 6, stableMs: 180, positionTolerance: 0.04, normalToleranceDegrees: 12,
  minDistance: 0.25, maxDistance: 5, maxSurfaceTiltDegrees: 30,
  offsetRight: 0.30, offsetUp: 0.015, placementTimeoutMs: 10000
});

function cancelSource(source) { try { source?.cancel(); } catch { /* Session may already have ended. */ } }
function deleteAnchor(anchor) { try { anchor?.delete(); } catch { /* An ended session may already release it. */ } }
function trackedPose(pose) { return pose && !pose.emulatedPosition && rigidMatrix(pose.transform?.matrix); }

/**
 * Native WebXR world tracking. The owner creates/ends the immersive session and
 * invokes update synchronously from its XR animation callback. Only copied numeric
 * transforms survive a frame; XRFrame, XRPose and XRHitTestResult are never cached.
 */
export class WorldTracker {
  constructor({ onChange = () => {}, onError = () => {}, config = {} } = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.onChange = onChange;
    this.onError = onError;
    this.generation = 0;
    this.session = null;
    this.referenceSpace = null;
    this.viewerSpace = null;
    this.source = null;
    this.anchor = null;
    this.snapshot = { state: 'idle', reticleMatrix: null, worldMatrix: null, message: '' };
    this._onReferenceReset = () => this.reset('The room map changed. Select the object base again.');
    this._onSessionEnd = () => this.stop();
    this._onVisibilityChange = () => {
      if (this.session?.visibilityState !== 'visible') {
        this._clearStability();
        this.placementRequested = false;
        this._emit('limited', 'Tracking paused. Return to the camera to continue.');
      }
    };
  }

  get state() { return this.snapshot.state; }

  async start(session, referenceSpace) {
    this.stop();
    if (!session?.requestHitTestSource || !session.requestReferenceSpace || !referenceSpace) throw new Error('This device does not provide WebXR surface tracking.');
    if (typeof globalThis.XRRay !== 'function') throw new Error('This browser does not provide WebXR hit-test rays.');
    this.session = session;
    this.referenceSpace = referenceSpace;
    session.addEventListener?.('end', this._onSessionEnd);
    session.addEventListener?.('visibilitychange', this._onVisibilityChange);
    referenceSpace.addEventListener?.('reset', this._onReferenceReset);
    const generation = this.generation;
    try {
      const viewerSpace = await session.requestReferenceSpace('viewer');
      if (this.session !== session || generation !== this.generation) return false;
      this.viewerSpace = viewerSpace;
      this._emit('scanning', 'Move slowly to find a surface, then select the object base.');
      return true;
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  async setSelection(point) {
    if (!this.session || !this.viewerSpace) throw new Error('Start the AR session before selecting an object.');
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error('Select a point inside the camera view.');
    this._clearPlacement();
    this.selection = { x: point.x, y: point.y };
    this._emit('aiming', 'Hold the selection over the object base or its supporting surface.');
    if (!this.lastView) return false;
    return this._requestSource();
  }

  async _requestSource() {
    const generation = this.generation;
    const session = this.session;
    const ray = selectionRay(this.selection, this.lastView.projection, this.lastView.viewToViewer);
    if (!ray) throw new Error('The camera view is not ready. Select the object again.');
    this.sourcePending = true;
    try {
      const source = await session.requestHitTestSource({
        space: this.viewerSpace, entityTypes: ['plane'],
        offsetRay: new globalThis.XRRay(ray.origin, ray.direction)
      });
      if (generation !== this.generation || this.session !== session) { cancelSource(source); return false; }
      this.source = source;
      return true;
    } catch (error) {
      if (generation !== this.generation || this.session !== session) return false;
      this.selection = null;
      this._emit('scanning', 'Surface tracking could not start. Select the object again.');
      throw error;
    } finally {
      if (generation === this.generation) this.sourcePending = false;
    }
  }

  requestPlacement() {
    if (this.state !== 'ready' || !this.source || this.anchor || this.pendingAnchor) return false;
    this.placementRequested = true;
    return true;
  }

  update(frame, time = performance.now()) {
    if (!this.session || !this.referenceSpace || !frame || (frame.session && frame.session !== this.session)) return;
    if (this.session.visibilityState && this.session.visibilityState !== 'visible') {
      this._clearStability();
      this.placementRequested = false;
      this._emit('limited', 'Tracking paused. Return to the camera to continue.');
      return;
    }
    let viewer;
    try { viewer = frame.getViewerPose(this.referenceSpace); } catch { viewer = null; }
    if (!trackedPose(viewer)) {
      this._clearStability();
      this.placementRequested = false;
      this.lastView = null;
      this._emit('limited', 'Move slowly and point back toward the surrounding surfaces.');
      return;
    }
    const viewerMatrix = Array.from(viewer.transform.matrix);
    const view = viewer.views?.find(item => item.eye === 'none') || viewer.views?.[0];
    if (view && finiteMatrix(view.projectionMatrix) && rigidMatrix(view.transform?.matrix)) {
      this.lastView = { projection: Array.from(view.projectionMatrix), viewToViewer: multiply(inverseRigid(viewerMatrix), view.transform.matrix) };
    }

    if (this.anchor) {
      let pose;
      try { pose = frame.getPose(this.anchor.anchorSpace, this.referenceSpace); } catch { pose = null; }
      if (!trackedPose(pose)) {
        this._emit('limited', 'Keep the original area in view to recover the placement.');
        return;
      }
      this._emit('anchored', 'Walk around the object to explore the toaster.', null, multiply(pose.transform.matrix, this.localOffset));
      return;
    }
    if (this.pendingAnchor) {
      if (time - this.pendingAnchor.startedAt > this.config.placementTimeoutMs) {
        this.pendingAnchor = null;
        this._clearStability();
        this._emit('aiming', 'Placement took too long. Hold still, then try placing again.');
        this.onError(new Error('The AR engine did not finish creating the anchor.'), { recoverable: true });
      } else this._emit('placing', 'Saving this position in the room.');
      return;
    }
    if (this.selection && !this.source && !this.sourcePending && this.lastView && this.viewerSpace) {
      void this._requestSource().catch(error => this.onError(error, { recoverable: true }));
    }
    if (!this.source) {
      this._emit(this.selection ? 'aiming' : 'scanning', this.selection ? 'Looking for the selected supporting surface.' : 'Move slowly to find a surface, then select the object base.');
      return;
    }

    let hits;
    try { hits = frame.getHitTestResults(this.source); } catch { hits = []; }
    let hit = null, matrix = null;
    for (const result of hits) {
      let pose;
      try { pose = result.getPose(this.referenceSpace); } catch { continue; }
      if (!trackedPose(pose)) continue;
      const candidate = pose.transform.matrix;
      const distance = translationDistance(candidate, viewerMatrix);
      if (distance < this.config.minDistance || distance > this.config.maxDistance) continue;
      if (candidate[5] < Math.cos(this.config.maxSurfaceTiltDegrees * Math.PI / 180)) continue;
      hit = result;
      matrix = Array.from(candidate);
      break;
    }
    if (!hit) {
      this._clearStability();
      this.placementRequested = false;
      this._emit('aiming', 'Aim at the table or floor near the object base. Move slowly to find it.');
      return;
    }
    const stable = this._observeHit(matrix, time);
    if (this.placementRequested && stable) {
      this.placementRequested = false;
      this._place(frame, hit, matrix, viewerMatrix, time);
      return;
    }
    this.placementRequested = false;
    this._emit(stable ? 'ready' : 'aiming', stable ? 'Surface found. Place the experience here.' : 'Hold still while the surface settles.', matrix);
  }

  _observeHit(matrix, time) {
    const previous = this.stableHit;
    if (!previous || time < previous.startedAt || translationDistance(matrix, previous.matrix) > this.config.positionTolerance || normalDot(matrix, previous.matrix) < Math.cos(this.config.normalToleranceDegrees * Math.PI / 180)) {
      this.stableHit = { matrix: Array.from(matrix), startedAt: time, frames: 1 };
    } else previous.frames++;
    return this.stableHit.frames >= this.config.stableFrames && time - this.stableHit.startedAt >= this.config.stableMs;
  }

  _place(frame, hit, matrix, viewerMatrix, time) {
    const pending = { generation: this.generation, startedAt: time };
    const offset = multiply(inverseRigid(matrix), placementMatrix(matrix, viewerMatrix, this.config));
    this.pendingAnchor = pending;
    this._emit('placing', 'Saving this position in the room.');
    let creation;
    try {
      // This call must happen here, while the XR frame that owns the hit is active.
      if (typeof hit.createAnchor === 'function') creation = hit.createAnchor();
      else if (typeof frame.createAnchor === 'function' && typeof globalThis.XRRigidTransform === 'function') {
        const transform = new globalThis.XRRigidTransform({ x: matrix[12], y: matrix[13], z: matrix[14] }, quaternionFromMatrix(matrix));
        creation = frame.createAnchor(transform, this.referenceSpace);
      } else throw new Error('This browser does not provide WebXR anchors. Open the demo on a supported AR device.');
    } catch (error) { this._placementFailed(pending, error); return; }
    Promise.resolve(creation).then(anchor => {
      if (pending !== this.pendingAnchor || pending.generation !== this.generation || !this.session) { deleteAnchor(anchor); return; }
      if (!anchor?.anchorSpace || typeof anchor.delete !== 'function') {
        deleteAnchor(anchor);
        throw new Error('The AR engine returned an invalid anchor.');
      }
      this.anchor = anchor;
      this.localOffset = offset;
      this.pendingAnchor = null;
      cancelSource(this.source);
      this.source = null;
      // The next XR frame obtains the anchor pose before showing any content.
    }).catch(error => this._placementFailed(pending, error));
  }

  _placementFailed(pending, error) {
    if (pending !== this.pendingAnchor || pending.generation !== this.generation) return;
    this.pendingAnchor = null;
    this._clearStability();
    this._emit('aiming', 'Placement failed. Hold still and try placing again.');
    this.onError(error, { recoverable: true });
  }

  _clearStability() { this.stableHit = null; }

  _clearPlacement() {
    this.generation++;
    cancelSource(this.source);
    deleteAnchor(this.anchor);
    this.source = null;
    this.anchor = null;
    this.sourcePending = false;
    this.pendingAnchor = null;
    this.placementRequested = false;
    this.localOffset = null;
    this.selection = null;
    this._clearStability();
  }

  reset(message = 'Select the object base to place the experience again.') {
    this._clearPlacement();
    this._emit(this.session ? 'scanning' : 'idle', message);
  }

  stop() {
    this.session?.removeEventListener?.('end', this._onSessionEnd);
    this.session?.removeEventListener?.('visibilitychange', this._onVisibilityChange);
    this.referenceSpace?.removeEventListener?.('reset', this._onReferenceReset);
    this._clearPlacement();
    this.session = null;
    this.referenceSpace = null;
    this.viewerSpace = null;
    this.lastView = null;
    this._emit('idle', '');
  }

  _emit(state, message, reticleMatrix = null, worldMatrix = null) {
    this.snapshot = { state, message, reticleMatrix, worldMatrix };
    this.onChange(this.snapshot);
  }
}
