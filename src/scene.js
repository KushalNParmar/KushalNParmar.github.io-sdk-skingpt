import { createAnnotation } from './annotations.js';
import { measuredScreenRoll, rotatedExtent, unwrapAngle } from './pose-math.js';

const THREE = window.THREE;
const DEFAULT_ANNOTATIONS = [
  { title: 'Toast slots', detail: 'Top opening', point: [0.5, 0.96, 0.5], offset: [-0.44, 0.26, 0.16] },
  { title: 'Control dial', detail: 'Front controls', point: [0.92, 0.33, 0.5], offset: [0.38, -0.02, 0.16] },
  { title: 'Toaster body', detail: 'Outer housing', point: [0.45, 0.5, 0.95], offset: [-0.5, -0.12, 0.16] },
];
const clamp = THREE.MathUtils.clamp;

// Visual tracking supplies position, apparent size, and measured screen-plane
// roll. It does not supply metric depth or an arbitrary object's 6DoF pose.
export class ToasterScene {
  constructor(canvas, labelLayer, stage) {
    this.stage = stage;
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    this.camera.position.z = 1000;
    this.root = new THREE.Group();
    this.root.name = 'selected-object-overlay';
    this.root.visible = false;
    this.content = new THREE.Group();
    this.content.name = 'toaster-and-annotations';
    this.annotationGroup = new THREE.Group();
    this.annotationGroup.name = 'annotations';
    this.content.add(this.annotationGroup);
    this.root.add(this.content);
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xe6f4ff, 0x69796a, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 4, 3);
    this.scene.add(key);

    const room = new THREE.RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    disposeObject(room);
    pmrem.dispose();

    this._ready = false;
    this.labelsEnabled = true;
    this.annotations = [];
    this.extent = new THREE.Vector3(1, 1, 1);
    this.desiredPosition = new THREE.Vector3();
    this.desiredScale = 1;
    this.desiredRoll = 0;
    this.placementSide = null;
    this.lastRenderTime = 0;
    this.target = null;
    this.disposed = false;
    this.needsClear = true;
    this.labelLayer.classList.add('sr-only');
    this.labelLayer.hidden = true;
    this.resize();
  }

  get ready() { return this._ready; }

  async load(experience) {
    if (this.disposed) throw new Error('The experience renderer has been disposed.');
    if (this.ready || this.loading) throw new Error('The experience is already loaded or loading.');
    if (!experience?.modelUrl) throw new Error('The experience has no model URL.');
    this.loading = true;
    const draco = new THREE.DRACOLoader();
    draco.setDecoderPath('./vendor/three/draco/');
    draco.setWorkerLimit(1);
    const loader = new THREE.GLTFLoader();
    loader.setDRACOLoader(draco);
    let gltf;
    try {
      gltf = await loader.loadAsync(experience.modelUrl);
      if (this.disposed) {
        disposeObject(gltf.scene);
        return;
      }
      this.model = gltf.scene;
      const sourceBounds = new THREE.Box3().setFromObject(this.model);
      const size = sourceBounds.getSize(new THREE.Vector3());
      const center = sourceBounds.getCenter(new THREE.Vector3());
      const width = experience.modelWidth || 0.9;
      const scale = width / Math.max(size.x, size.z);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('The toaster model has invalid dimensions.');

      // Normalize through wrappers so imported node transforms remain intact.
      const normalized = new THREE.Group();
      normalized.add(this.model);
      this.model.position.sub(center);
      normalized.scale.setScalar(scale);
      normalized.rotation.set(...(experience.modelRotation || [0, 0, 0]));
      this.content.add(normalized);
      this.content.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(normalized);
      const definitions = experience.annotations || DEFAULT_ANNOTATIONS;
      for (const [index, item] of definitions.entries()) {
        const fallback = DEFAULT_ANNOTATIONS[index % DEFAULT_ANNOTATIONS.length];
        const definition = {
          ...fallback,
          width: 0.65,
          ...item,
          // Guard old screen-pixel offsets when migrating the original demo.
          offset: item.offset?.length === 3 ? item.offset : fallback.offset,
        };
        const annotation = createAnnotation(definition, bounds, this.renderer);
        this.annotationGroup.add(annotation.group);
        this.annotations.push(annotation);
      }
      this.content.rotation.set(...(experience.placement?.rotation || [0.18, -0.45, 0]));
      this.content.updateMatrixWorld(true);
      const rotatedBounds = new THREE.Box3().setFromObject(this.content);
      this.content.position.sub(rotatedBounds.getCenter(new THREE.Vector3()));
      rotatedBounds.getSize(this.extent);
      this.placement = experience.placement || {};
      const description = document.createElement('p');
      description.textContent = `3D toaster. ${definitions.map(item => `${item.title}: ${item.detail}.`).join(' ')}`;
      this.labelLayer.replaceChildren(description);
      this._ready = true;
    } catch (error) {
      // A failed load remains retryable without leaking partial GPU resources.
      for (const child of [...this.content.children]) {
        if (child !== this.annotationGroup) {
          this.content.remove(child);
          disposeObject(child);
        }
      }
      disposeObject(this.annotationGroup);
      this.annotationGroup.clear();
      this.annotations = [];
      throw error;
    } finally {
      draco.dispose();
      this.loading = false;
    }
  }

  resize() {
    if (this.disposed) return;
    const bounds = this.stage.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.renderer.setSize(this.width, this.height, false);
    this.needsClear = true;
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    if (this.target && this.ready) this.updateTarget(this.target, { snap: true });
  }

  place(rect, trackingResult = {}) {
    return this.updateTarget(rect, { snap: Boolean(trackingResult?.snap), trackingResult });
  }

  resetTrackingPose() {
    this.desiredRoll = 0;
    this.root.rotation.z = 0;
    this.placementSide = null;
    this.root.userData.poseKind = 'screen-space';
    this.root.userData.measuredRoll = null;
  }

  updateTarget(rect, { snap = false, trackingResult = null } = {}) {
    if (!this.ready || this.disposed) return false;
    if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
    const measuredRoll = measuredScreenRoll(trackingResult);
    if (measuredRoll !== null) {
      this.desiredRoll = unwrapAngle(measuredRoll, this.desiredRoll);
      this.root.userData.poseKind = 'measured-screen-roll';
      this.root.userData.measuredRoll = measuredRoll;
    }
    // A NanoTrack-only frame carries no orientation information. Preserve the
    // last measured roll instead of inventing yaw from the box's x position.
    this.target = { ...rect };
    const padding = 16;
    const top = this.placement.topInset ?? 86;
    const bottom = Math.max(top + 40, this.height - (this.placement.bottomInset ?? (this.width < 600 ? 178 : 132)));
    const availableWidth = Math.max(40, this.width - padding * 2);
    const availableHeight = Math.max(40, bottom - top);
    // Leave enough room on a phone for the overlay to visibly follow the
    // selected object, instead of clamping a full-screen label group in place.
    const minimumWidth = this.width < 600 ? Math.min(210, this.width * 0.58) : 280;
    const desiredWidth = clamp(Math.max(rect.width, rect.height * 0.72) * 1.35, minimumWidth, this.width < 600 ? 310 : 440);
    const rotated = rotatedExtent(this.extent.x, this.extent.y, this.desiredRoll);
    const scale = Math.min(desiredWidth / this.extent.x, availableWidth / rotated.width, availableHeight / rotated.height);
    const displayWidth = rotated.width * scale;
    const displayHeight = rotated.height * scale;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const gap = 18;
    const leftSpace = rect.x - padding - gap;
    const rightSpace = this.width - padding - (rect.x + rect.width) - gap;
    let x = centerX;
    let y = centerY - rect.height / 2 - displayHeight / 2 - gap;
    // Choose once per selection: noisy boxes must not flip the model between
    // left/right or above/below. Edge clamping still keeps initial content visible.
    if (!this.placementSide) {
      if (Math.max(leftSpace, rightSpace) >= displayWidth) this.placementSide = rightSpace >= leftSpace ? 'right' : 'left';
      else if (y - displayHeight / 2 < top && rect.y + rect.height + gap + displayHeight <= bottom) this.placementSide = 'below';
      else this.placementSide = 'above';
    }
    if (this.placementSide === 'right' || this.placementSide === 'left') {
      x = this.placementSide === 'right' ? rect.x + rect.width + gap + displayWidth / 2 : rect.x - gap - displayWidth / 2;
      y = centerY;
    } else if (this.placementSide === 'below') {
      y = rect.y + rect.height + gap + displayHeight / 2;
    }
    x = clamp(x, padding + displayWidth / 2, this.width - padding - displayWidth / 2);
    y = clamp(y, top + displayHeight / 2, bottom - displayHeight / 2);
    this.desiredPosition.set(x - this.width / 2, this.height / 2 - y, 0);
    this.desiredScale = scale;
    if (snap || !this.root.visible) {
      this.root.position.copy(this.desiredPosition);
      this.root.scale.setScalar(scale);
      this.root.rotation.z = this.desiredRoll;
    }
    this.root.visible = true;
    this.labelLayer.hidden = !this.labelsEnabled;
    return true;
  }

  hide() {
    if (this.root.visible) this.needsClear = true;
    this.root.visible = false;
    this.target = null;
    this.labelLayer.hidden = true;
  }

  setLabelsEnabled(enabled) {
    this.labelsEnabled = Boolean(enabled);
    this.annotationGroup.visible = this.labelsEnabled;
    this.labelLayer.hidden = !this.root.visible || !this.labelsEnabled;
  }

  render(now = performance.now()) {
    if (this.disposed) return;
    const elapsed = this.lastRenderTime ? Math.min(100, Math.max(0, now - this.lastRenderTime)) : 16;
    this.lastRenderTime = now;
    if (!this.root.visible) {
      // Clear the last overlay once after loss/close. Idle camera/selection
      // frames do not need a WebGL draw and should not keep the GPU busy.
      if (this.needsClear) this.renderer.clear();
      this.needsClear = false;
      return;
    }
    const blend = 1 - Math.exp(-elapsed / 45);
    this.root.position.lerp(this.desiredPosition, blend);
    this.root.scale.setScalar(THREE.MathUtils.lerp(this.root.scale.x, this.desiredScale, blend));
    this.root.rotation.z += (this.desiredRoll - this.root.rotation.z) * (1 - Math.exp(-elapsed / 60));
    this.renderer.render(this.scene, this.camera);
    this.needsClear = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    this._ready = false;
    disposeObject(this.root);
    this.scene.clear();
    this.environment.dispose();
    this.renderer.clear();
    this.needsClear = false;
    this.renderer.dispose();
    this.labelLayer.replaceChildren();
  }
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}
