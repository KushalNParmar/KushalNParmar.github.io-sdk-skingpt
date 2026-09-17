import { createAnnotation } from './annotations.js';

const THREE = window.THREE;
const DEFAULT_ANNOTATIONS = [
  { title: 'Toast slots', detail: 'Top opening', point: [0.5, 0.96, 0.5], offset: [-0.44, 0.26, 0.16] },
  { title: 'Control dial', detail: 'Front controls', point: [0.92, 0.33, 0.5], offset: [0.38, -0.02, 0.16] },
  { title: 'Toaster body', detail: 'Outer housing', point: [0.45, 0.5, 0.95], offset: [-0.5, -0.12, 0.16] },
];

// WebXR supplies the real camera and world poses. Content keeps a physical size
// and orientation; changing perspective comes only from moving the XR camera.
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
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 30);
    this.root = new THREE.Group();
    this.root.name = 'world-anchored-experience';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    this.content = new THREE.Group();
    this.content.name = 'toaster-and-annotations';
    this.annotationGroup = new THREE.Group();
    this.annotationGroup.name = 'annotations';
    this.content.add(this.annotationGroup);
    this.root.add(this.content);
    this.scene.add(this.root);
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.04, 0.055, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf1bc59, side: THREE.DoubleSide, toneMapped: false }),
    );
    this.reticle.name = 'surface-placement-reticle';
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
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
    this.disposed = false;
    this.labelLayer.classList.add('sr-only');
    this.labelLayer.hidden = true;
    // Three restores its default framebuffer before emitting this event. Clear
    // it here so ending AR cannot leave the last experience frame onscreen.
    this.onSessionEnd = () => {
      if (this.disposed) return;
      this.setAnimationLoop(null);
      this.hide();
      this.hideReticle();
      this.resize();
      this.renderer.clear();
    };
    this.renderer.xr.addEventListener('sessionend', this.onSessionEnd);
    this.resize();
  }

  get ready() { return this._ready; }
  get referenceSpace() { return this.renderer.xr.getReferenceSpace(); }

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
      const normalized = new THREE.Group();
      normalized.name = 'normalized-toaster';
      normalized.add(this.model);
      normalized.rotation.set(...(experience.modelRotation || [0, 0, 0]));
      this.content.add(normalized);
      this.content.updateMatrixWorld(true);
      const sourceBounds = new THREE.Box3().setFromObject(normalized);
      const size = sourceBounds.getSize(new THREE.Vector3());
      const width = experience.modelWidth ?? 0.9;
      const physicalWidth = experience.world?.modelWidthMeters ?? 0.30;
      const scale = width / Math.max(size.x, size.z);
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(physicalWidth) || physicalWidth <= 0) {
        throw new Error('The toaster model has invalid dimensions.');
      }
      // Imported node transforms stay intact. Normalize the oriented model,
      // put its bottom on Y=0, then size the entire experience in real meters.
      normalized.scale.setScalar(scale);
      this.content.updateMatrixWorld(true);
      const scaledBounds = new THREE.Box3().setFromObject(normalized);
      const center = scaledBounds.getCenter(new THREE.Vector3());
      normalized.position.set(-center.x, -scaledBounds.min.y, -center.z);
      this.content.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(normalized);
      const definitions = experience.annotations || DEFAULT_ANNOTATIONS;
      for (const [index, item] of definitions.entries()) {
        const fallback = DEFAULT_ANNOTATIONS[index % DEFAULT_ANNOTATIONS.length];
        const definition = {
          ...fallback,
          width: 0.65,
          ...item,
          offset: item.offset?.length === 3 ? item.offset : fallback.offset,
        };
        const annotation = createAnnotation(definition, bounds, this.renderer);
        this.annotationGroup.add(annotation.group);
        this.annotations.push(annotation);
      }
      this.content.scale.setScalar(physicalWidth / width);
      this.content.updateMatrixWorld(true);
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
      this.content.scale.setScalar(1);
      this.annotations = [];
      throw error;
    } finally {
      draco.dispose();
      this.loading = false;
    }
  }

  async startSession(session) {
    if (this.disposed) throw new Error('The experience renderer has been disposed.');
    if (!session) throw new Error('An immersive AR session is required.');
    let ended = false;
    const onEnd = () => { ended = true; };
    session.addEventListener('end', onEnd, { once: true });
    try {
      await this.renderer.xr.setSession(session);
      // The guarded XR manager deliberately ignores late setup continuations.
      // Its owner must not mistake that cancellation for a ready AR session.
      if (ended || this.disposed || this.renderer.xr.getSession() !== session || !this.renderer.xr.isPresenting) {
        throw new DOMException('The AR session ended while its graphics were starting.', 'AbortError');
      }
    } finally {
      session.removeEventListener('end', onEnd);
    }
  }

  setAnimationLoop(callback) {
    if (!this.disposed) this.renderer.setAnimationLoop(callback);
  }

  resize() {
    if (this.disposed) return;
    const bounds = this.stage.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    // XR owns the framebuffer and projection while presenting. Resizing that
    // framebuffer from CSS dimensions would overwrite the device's viewport.
    if (!this.renderer.xr.isPresenting) {
      this.renderer.setSize(this.width, this.height, false);
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    }
  }

  setWorldPose(matrix) {
    if (!this.ready || this.disposed || !isFiniteMatrix(matrix)) return false;
    this.root.matrix.fromArray(matrix);
    this.root.matrixWorldNeedsUpdate = true;
    this.root.visible = true;
    this.labelLayer.hidden = !this.labelsEnabled;
    return true;
  }

  showReticle(matrix, ready = true) {
    if (this.disposed || !isFiniteMatrix(matrix)) return false;
    this.reticle.matrix.fromArray(matrix);
    this.reticle.matrixWorldNeedsUpdate = true;
    this.reticle.material.color.setHex(ready ? 0xbcf478 : 0xf1bc59);
    this.reticle.visible = true;
    return true;
  }

  hideReticle() { this.reticle.visible = false; }

  hide() {
    this.root.visible = false;
    this.labelLayer.hidden = true;
  }

  setLabelsEnabled(enabled) {
    this.labelsEnabled = Boolean(enabled);
    this.annotationGroup.visible = this.labelsEnabled;
    this.labelLayer.hidden = !this.root.visible || !this.labelsEnabled;
  }

  render() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.renderer.setAnimationLoop(null);
    this.renderer.xr.removeEventListener('sessionend', this.onSessionEnd);
    this.hide();
    this.hideReticle();
    this.disposed = true;
    this._ready = false;
    disposeObject(this.scene);
    this.scene.clear();
    this.environment.dispose();
    this.renderer.dispose();
    this.labelLayer.replaceChildren();
  }
}

function isFiniteMatrix(matrix) {
  return matrix?.length === 16 && Array.from(matrix).every(Number.isFinite);
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
