/*
 * TEST ONLY. A controllable XR device simulator installed through Playwright.
 * It exercises the actual Three.js renderer, application and WebXR provider.
 * It cannot validate real-world SLAM, depth, drift or physical-device support.
 */
function installWebXRFixture({ denyFirst = false, supported = true, noHit = false, holdFirstLocal = false, failRendererFirst = false } = {}) {
  const state = {
    requests: [], sources: [], sessions: [], anchors: [], frames: 0,
    angle: 0, radius: 1.8, height: 1.05, viewerVisible: true, anchorVisible: true,
    hitVisible: !noHit, hitPosition: [0, 0, -1], ended: 0, anchorDeletes: 0,
    anchorCreates: 0, invalidAnchorCreates: 0, render: null, renderCount: 0, rendererConstructions: 0,
  };
  let nextAnchor = 1;
  const pendingLocal = [];
  function transform(matrix) {
    const T = window.THREE;
    const position = new T.Vector3(), orientation = new T.Quaternion(), scale = new T.Vector3();
    matrix.decompose(position, orientation, scale);
    return {
      matrix: new Float32Array(matrix.elements),
      position: { x: position.x, y: position.y, z: position.z, w: 1 },
      orientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
      inverse: { matrix: new Float32Array(matrix.clone().invert().elements) },
    };
  }
  function hitTransform() {
    const T = window.THREE;
    return transform(new T.Matrix4().makeTranslation(...state.hitPosition));
  }
  function viewerPose() {
    if (!state.viewerVisible) return null;
    const T = window.THREE;
    const target = new T.Vector3(...state.hitPosition).add(new T.Vector3(0, 0.12, 0));
    const eye = new T.Vector3(state.hitPosition[0] + Math.sin(state.angle) * state.radius,
      state.height, state.hitPosition[2] + Math.cos(state.angle) * state.radius);
    const matrix = new T.Matrix4().lookAt(eye, target, new T.Vector3(0, 1, 0)).setPosition(eye);
    const viewTransform = transform(matrix);
    const camera = new T.PerspectiveCamera(64, innerWidth / innerHeight, 0.01, 30);
    return { transform: viewTransform, emulatedPosition: false,
      views: [{ eye: 'none', transform: viewTransform, projectionMatrix: new Float32Array(camera.projectionMatrix.elements) }] };
  }
  class ReferenceSpace extends EventTarget {
    constructor(type) { super(); this.type = type; }
    getOffsetReferenceSpace() { return this; }
  }
  class FixtureSession extends EventTarget {
    constructor() {
      super();
      this.renderState = { depthNear: 0.01, depthFar: 30 };
      this.inputSources = [];
      this.environmentBlendMode = 'alpha-blend';
      this.interactionMode = 'screen-space';
      this.visibilityState = 'visible';
      this.domOverlayState = { type: 'screen' };
      this.enabledFeatures = ['local', 'hit-test', 'anchors', 'dom-overlay'];
      this.ended = false;
      this.callbacks = new Map();
      this.spaces = [];
    }
    updateRenderState(values) { Object.assign(this.renderState, values); }
    async requestReferenceSpace(type) {
      const space = new ReferenceSpace(type); this.spaces.push(space);
      if (holdFirstLocal && type === 'local' && state.sessions[0] === this) {
        return new Promise(resolve => pendingLocal.push(() => resolve(space)));
      }
      return space;
    }
    async requestHitTestSource(options) {
      const source = { ...options, cancelled: false, cancel() { this.cancelled = true; } };
      state.sources.push(source);
      return source;
    }
    requestAnimationFrame(callback) {
      const id = window.requestAnimationFrame(time => {
        this.callbacks.delete(id);
        if (this.ended) return;
        state.frames++;
        let active = true;
        const frame = {
          session: this,
          predictedDisplayTime: time,
          getViewerPose: () => viewerPose(),
          getPose: space => {
            if (space?.anchor && (space.anchor.deleted || !state.anchorVisible || !state.viewerVisible)) return null;
            return { transform: hitTransform(), emulatedPosition: false };
          },
          get trackedAnchors() { return new Set(state.anchors.filter(a => !a.deleted && state.anchorVisible)); },
          getHitTestResults: source => {
            if (!state.hitVisible || !state.viewerVisible || source.cancelled) return [];
            const matrix = hitTransform();
            return [{ getPose: () => ({ transform: matrix, emulatedPosition: false }), createAnchor: createAnchor }];
          },
          createAnchor,
        };
        function createAnchor() {
          if (!active) {
            state.invalidAnchorCreates++;
            return Promise.reject(new DOMException('Anchor requested outside live XR frame', 'InvalidStateError'));
          }
          state.anchorCreates++;
          const anchor = { id: nextAnchor++, deleted: false,
            delete() { if (!this.deleted) state.anchorDeletes++; this.deleted = true; } };
          anchor.anchorSpace = { anchor };
          state.anchors.push(anchor);
          return Promise.resolve(anchor);
        }
        try { callback(time, frame); } finally { active = false; }
      });
      this.callbacks.set(id, true);
      return id;
    }
    cancelAnimationFrame(id) { window.cancelAnimationFrame(id); this.callbacks.delete(id); }
    async end() {
      if (this.ended) return;
      this.ended = true; state.ended++;
      for (const id of this.callbacks.keys()) window.cancelAnimationFrame(id);
      this.callbacks.clear(); this.dispatchEvent(new Event('end'));
    }
  }
  const xr = new EventTarget();
  xr.isSessionSupported = async mode => supported && mode === 'immersive-ar';
  xr.requestSession = async (mode, options = {}) => {
    state.requests.push({ mode, requiredFeatures: [...(options.requiredFeatures || [])],
      optionalFeatures: [...(options.optionalFeatures || [])], overlayId: options.domOverlay?.root?.id,
      userActivation: navigator.userActivation?.isActive });
    if (denyFirst && state.requests.length === 1) throw new DOMException('Permission denied by XR fixture', 'NotAllowedError');
    if (!supported) throw new DOMException('XR unavailable', 'NotSupportedError');
    const session = new FixtureSession(); state.sessions.push(session); return session;
  };
  Object.defineProperty(navigator, 'xr', { configurable: true, value: xr });
  class FixtureRay {
    constructor(origin = { x: 0, y: 0, z: 0, w: 1 }, direction = { x: 0, y: 0, z: -1, w: 0 }) {
      this.origin = { x: 0, y: 0, z: 0, w: 1, ...origin };
      this.direction = { x: 0, y: 0, z: -1, w: 0, ...direction };
    }
  }
  Object.defineProperty(window, 'XRRay', { configurable: true, value: FixtureRay });
  Object.defineProperty(window, 'XRRigidTransform', { configurable: true, value: class {
    constructor(position = {}, orientation = {}) {
      const T = window.THREE;
      Object.assign(this, transform(new T.Matrix4().compose(new T.Vector3(position.x || 0, position.y || 0, position.z || 0),
        new T.Quaternion(orientation.x || 0, orientation.y || 0, orientation.z || 0, orientation.w ?? 1), new T.Vector3(1, 1, 1))));
    }
  } });
  Object.defineProperty(window, 'XRWebGLLayer', { configurable: true, value: class {
    constructor(session, context) {
      this.context = context; this.framebuffer = null; this.fixedFoveation = 0;
      this.framebufferWidth = context.drawingBufferWidth; this.framebufferHeight = context.drawingBufferHeight;
    }
    getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
  } });
  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    if (window[name]) Object.defineProperty(window[name].prototype, 'makeXRCompatible', { configurable: true, value: async () => {} });
  }

  // Observe production matrices after a genuine Three render without exporting
  // production internals or altering placements/camera transforms.
  function instrumentThree(T) {
    let renderer;
    Object.defineProperty(T, 'WebGLRenderer', { configurable: true, enumerable: true,
      get: () => renderer,
      set: Original => {
        renderer = new Proxy(Original, { construct(Target, args) {
          state.rendererConstructions++;
          if (failRendererFirst && state.rendererConstructions === 1) throw new Error('Renderer initialization failed in test fixture');
          const instance = Reflect.construct(Target, args);
          const render = instance.render.bind(instance);
          instance.render = (scene, camera) => {
            render(scene, camera);
            const root = scene.getObjectByName('world-anchored-experience') || scene.getObjectByName('world-anchor') || scene.getObjectByName('anchored-experience')
              || scene.getObjectByName('world-anchored-content') || scene.getObjectByName('selected-object-overlay');
            const content = scene.getObjectByName('toaster-and-annotations');
            if (!content) return;
            const anchorRoot = root || content.parent;
            const effectiveCamera = instance.xr.isPresenting ? instance.xr.getCamera(camera) : camera;
            const annotationGroup = scene.getObjectByName('annotations');
            const label = scene.getObjectByName('annotation-card');
            const normalized = scene.getObjectByName('normalized-toaster');
            const modelBounds = normalized ? new T.Box3().setFromObject(normalized) : null;
            const modelSize = modelBounds?.getSize(new T.Vector3());
            const point = new T.Vector3(0.1, 0.1, 0.1).applyMatrix4(content.matrixWorld).project(effectiveCamera);
            state.renderCount++;
            state.render = {
              count: state.renderCount, rootName: anchorRoot?.name, cameraIsPerspective: camera.isPerspectiveCamera,
              rootMatrixAutoUpdate: anchorRoot?.matrixAutoUpdate, modelSize: modelSize?.toArray(),
              modelBottom: modelBounds?.min.y, labelsShareContent: annotationGroup?.parent === content,
              rootVisible: anchorRoot?.visible, contentVisible: content.visible,
              rootMatrix: anchorRoot ? [...anchorRoot.matrixWorld.elements] : null,
              contentMatrix: [...content.matrixWorld.elements], cameraMatrix: [...effectiveCamera.matrixWorld.elements],
              projection: [...effectiveCamera.projectionMatrix.elements], projectedPoint: point.toArray(),
              labelMatrix: label ? [...label.matrixWorld.elements] : null,
              labelsVisible: annotationGroup?.visible, labelCount: annotationGroup?.children.length || 0,
              drawCalls: instance.info.render.calls, triangles: instance.info.render.triangles,
            };
          };
          return instance;
        } });
      },
    });
  }
  let three;
  Object.defineProperty(window, 'THREE', { configurable: true, get: () => three,
    set: value => { three = value; instrumentThree(value); } });
  window.__webXRFixture = {
    orbit(radians) { state.angle = radians; },
    viewerVisible(value) { state.viewerVisible = value; },
    anchorVisible(value) { state.anchorVisible = value; },
    hitVisible(value) { state.hitVisible = value; },
    hitPosition(value) { state.hitPosition = [...value]; },
    visibility(value) {
      const session = state.sessions.at(-1); session.visibilityState = value;
      session.dispatchEvent(new Event('visibilitychange'));
    },
    async end() { await state.sessions.at(-1)?.end(); },
    releaseLocal() { for (const resolve of pendingLocal.splice(0)) resolve(); },
    resetReferenceSpace() {
      for (const space of state.sessions.at(-1)?.spaces || []) if (space.type === 'local') space.dispatchEvent(new Event('reset'));
    },
    snapshot() {
      return { requests: state.requests, frames: state.frames, angle: state.angle, render: state.render,
        ended: state.ended, anchorCreates: state.anchorCreates, anchorDeletes: state.anchorDeletes,
        rendererConstructions: state.rendererConstructions,
        invalidAnchorCreates: state.invalidAnchorCreates, liveAnchors: state.anchors.filter(a => !a.deleted).map(a => a.id),
        sources: state.sources.map(s => ({ cancelled: s.cancelled, referenceSpace: s.space?.type,
          ray: s.offsetRay ? { origin: s.offsetRay.origin, direction: s.offsetRay.direction } : null })),
        pendingLocal: pendingLocal.length, activeSessions: state.sessions.filter(s => !s.ended).length };
    },
  };
}
module.exports = { installWebXRFixture };
