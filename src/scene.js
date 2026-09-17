import { CONFIG } from './config.js';

const THREE = window.THREE;
const svgNS = 'http://www.w3.org/2000/svg';

export class ToasterScene {
  constructor(canvas, labelLayer, stage) {
    this.stage = stage;
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, CONFIG.maxPixelRatio));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.root = new THREE.Group();
    this.root.name = 'cup-anchor';
    this.root.visible = false;
    this.content = new THREE.Group();
    this.content.name = 'toaster-and-annotations';
    this.root.add(this.content);
    this.scene.add(this.root);
    this.stabilizer = WebARRocksThreeStabilizer.instance({ obj3D: this.root, n: 2 });
    this.controls = new THREE.OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 5;
    this.controls.enabled = false;
    const hemisphere = new THREE.HemisphereLight(0xe6f4ff, 0x69796a, 0.8);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 4, 3);
    this.scene.add(hemisphere, key);
    const room = new THREE.RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    room.traverse(object => {
      object.geometry?.dispose();
      if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => m.dispose());
    });
    pmrem.dispose();
    this.lines = document.createElementNS(svgNS, 'svg');
    this.lines.classList.add('annotation-lines');
    this.lines.setAttribute('aria-hidden', 'true');
    labelLayer.append(this.lines);
    this.annotations = [];
    this.labelsEnabled = true;
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Euler(0, 0, 0, 'ZXY');
    this.quaternion = new THREE.Quaternion();
    this.projected = new THREE.Vector3();
    this.mode = 'idle';
    this.resize();
  }

  async load() {
    const draco = new THREE.DRACOLoader();
    draco.setDecoderPath('./vendor/three/draco/');
    draco.setWorkerLimit(1);
    const loader = new THREE.GLTFLoader();
    loader.setDRACOLoader(draco);
    let gltf;
    try {
      gltf = await loader.loadAsync(CONFIG.modelUrl);
    } finally {
      draco.dispose();
    }
    this.model = gltf.scene;
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = CONFIG.modelWidth / Math.max(size.x, size.z);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('The toaster model has invalid dimensions.');
    this.model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    this.model.scale.setScalar(scale);
    this.content.add(this.model);
    this.content.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.model);
    const dimensions = bounds.getSize(new THREE.Vector3());
    this.modelHeight = dimensions.y;
    CONFIG.annotations.forEach(definition => {
      const anchor = new THREE.Object3D();
      anchor.position.copy(bounds.min).add(new THREE.Vector3(...definition.point).multiply(dimensions));
      this.content.add(anchor);
      const element = document.createElement('div');
      element.className = 'annotation';
      const title = document.createElement('strong');
      title.textContent = definition.title;
      const detail = document.createElement('small');
      detail.textContent = definition.detail;
      element.append(title, detail);
      element.hidden = true;
      this.labelLayer.append(element);
      const line = document.createElementNS(svgNS, 'line');
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('r', '3');
      this.lines.append(line, dot);
      this.annotations.push({ anchor, element, line, dot, offset: definition.offset });
    });
    this.ready = true;
  }

  setMode(mode, video = null) {
    this.mode = mode;
    this.video = video;
    this.root.visible = mode === 'preview';
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.content.position.set(...(mode === 'ar' ? CONFIG.modelOffset : [0, 0, 0]));
    this.content.rotation.set(...CONFIG.modelRotation);
    this.controls.enabled = mode === 'preview';
    this.stabilizer.reset();
    if (mode === 'preview') {
      this.camera.position.set(1.35, 0.95, 1.8);
      this.controls.target.set(0, (this.modelHeight || .5) / 2, 0);
      this.controls.update();
    } else {
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.identity();
    }
    this.resize();
  }

  resize() {
    const { width, height } = this.stage.getBoundingClientRect();
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.clearViewOffset();
    if (this.mode === 'ar' && this.video?.videoWidth && this.video?.videoHeight) {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const aspect = vw / vh;
      // Match the centered object-fit:cover camera video exactly.
      const coverScale = Math.max(width / vw, height / vh);
      const fullWidth = vw * coverScale;
      const fullHeight = vh * coverScale;
      this.camera.fov = Math.min(60, CONFIG.cameraMinDimensionFov * (vh > vw ? 1 / aspect : 1));
      this.camera.aspect = aspect;
      this.camera.setViewOffset(fullWidth, fullHeight, (fullWidth - width) / 2, (fullHeight - height) / 2, width, height);
    } else {
      this.camera.fov = 35;
      this.camera.aspect = width / height;
      if (this.mode === 'preview' && width < height) this.camera.fov = 48;
    }
    this.camera.updateProjectionMatrix();
  }

  updatePose(state, reset = false) {
    const s = state.positionScale?.[2];
    if (!(s > 0) || ![...state.positionScale, state.pitch, state.yaw, state.roll].every(Number.isFinite)) return false;
    // Unit detection-window geometry; same camera-relative convention as upstream.
    const halfTanHorizontal = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect;
    const distance = 1 / (2 * s * halfTanHorizontal);
    this.position.set(
      (2 * state.positionScale[0] - 1) * distance * halfTanHorizontal,
      (2 * state.positionScale[1] - 1) * distance * halfTanHorizontal / this.camera.aspect,
      -distance - 0.5,
    );
    this.rotation.set(-(state.pitch - Math.PI / 2), state.yaw + Math.PI, -state.roll);
    this.quaternion.setFromEuler(this.rotation);
    if (reset) this.stabilizer.reset();
    this.stabilizer.update(this.position, this.quaternion);
    return true;
  }

  drawLabels() {
    const visible = this.root.visible && this.labelsEnabled;
    this.labelLayer.hidden = !visible;
    if (!visible) return;
    this.scene.updateMatrixWorld(true);
    const occupied = [];
    const bottom = this.height - (this.width < 600 ? 172 : 125);
    for (const item of this.annotations) {
      item.anchor.getWorldPosition(this.projected);
      this.projected.project(this.camera);
      const x = (this.projected.x * .5 + .5) * this.width;
      const y = (-this.projected.y * .5 + .5) * this.height;
      let show = this.projected.z >= -1 && this.projected.z <= 1 && x >= 0 && x <= this.width && y >= 65 && y <= bottom;
      item.element.hidden = !show;
      if (show) {
        const w = item.element.offsetWidth;
        const h = item.element.offsetHeight;
        let lx = Math.max(12, Math.min(this.width - w - 12, x + item.offset[0] * Math.min(1, this.width / 650)));
        let ly = Math.max(80, Math.min(bottom - h, y + item.offset[1]));
        for (let attempt = 0; attempt < 4; attempt++) {
          const overlap = occupied.find(r => lx < r.x + r.w + 10 && lx + w + 10 > r.x && ly < r.y + r.h + 8 && ly + h + 8 > r.y);
          if (!overlap) break;
          ly = overlap.y + overlap.h + 10;
        }
        show = ly + h <= bottom;
        if (show) {
          item.element.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
          occupied.push({ x: lx, y: ly, w, h });
          item.line.setAttribute('x1', x);
          item.line.setAttribute('y1', y);
          item.line.setAttribute('x2', Math.max(lx, Math.min(lx + w, x)));
          item.line.setAttribute('y2', Math.max(ly, Math.min(ly + h, y)));
          item.dot.setAttribute('cx', x);
          item.dot.setAttribute('cy', y);
        }
      }
      item.element.hidden = !show;
      item.line.style.display = show ? '' : 'none';
      item.dot.style.display = show ? '' : 'none';
    }
  }

  render() {
    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
  }
}
