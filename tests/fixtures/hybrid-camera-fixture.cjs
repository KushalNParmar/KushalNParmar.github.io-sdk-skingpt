// Self-created test artwork. No third-party image or target tracking output.
// Installs only getUserMedia; inference and application code remain unmodified.
function installHybridCameraFixture({ denyFirst = false, fps = 15 } = {}) {
  const WIDTH = 960, HEIGHT = 720;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const object = document.createElement('canvas');
  object.width = 240; object.height = 360;
  const phone = object.getContext('2d');
  const rounded = (c, x, y, w, h, r) => {
    c.beginPath(); c.roundRect(x, y, w, h, r);
  };
  phone.shadowColor = '#000a'; phone.shadowBlur = 9;
  rounded(phone, 8, 6, 224, 348, 27);
  phone.fillStyle = '#11191f'; phone.fill();
  phone.shadowBlur = 0;
  phone.lineWidth = 4; phone.strokeStyle = '#8596a2'; phone.stroke();
  rounded(phone, 19, 17, 202, 324, 18); phone.clip();
  const screen = phone.createLinearGradient(20, 20, 210, 340);
  screen.addColorStop(0, '#22679b'); screen.addColorStop(0.4, '#74c3bc');
  screen.addColorStop(0.7, '#e5ab64'); screen.addColorStop(1, '#30396a');
  phone.fillStyle = screen; phone.fillRect(19, 17, 202, 324);
  // Mountain wallpaper, status icons and app tiles give varied image features.
  phone.fillStyle = '#d6e7ee'; phone.beginPath(); phone.moveTo(0, 190);
  phone.lineTo(86, 90); phone.lineTo(125, 147); phone.lineTo(170, 105);
  phone.lineTo(260, 205); phone.closePath(); phone.fill();
  phone.fillStyle = '#465781'; phone.beginPath(); phone.moveTo(0, 214);
  phone.lineTo(72, 138); phone.lineTo(110, 193); phone.lineTo(175, 154);
  phone.lineTo(260, 239); phone.closePath(); phone.fill();
  phone.fillStyle = '#fff'; phone.font = 'bold 14px sans-serif';
  phone.fillText('9:41', 32, 42); phone.fillRect(184, 30, 20, 8);
  phone.fillStyle = '#13232c'; rounded(phone, 89, 17, 62, 13, 7); phone.fill();
  const colors = ['#e96351', '#5ac683', '#3d90e5', '#a884d5', '#f4be54', '#f0f0e8', '#469ad1', '#cc678e'];
  colors.forEach((color, i) => {
    const x = 31 + (i % 4) * 46, y = 219 + Math.floor(i / 4) * 49;
    rounded(phone, x, y, 31, 31, 7); phone.fillStyle = color; phone.fill();
    phone.fillStyle = i === 5 ? '#54565f' : '#fffd';
    if (i % 3 === 0) { phone.beginPath(); phone.arc(x + 16, y + 15, 8, 0, Math.PI * 2); phone.fill(); }
    else if (i % 3 === 1) { phone.fillRect(x + 8, y + 8, 15, 15); }
    else { phone.font = 'bold 22px sans-serif'; phone.fillText('A', x + 8, y + 23); }
  });
  phone.fillStyle = '#fffd'; rounded(phone, 83, 328, 74, 4, 2); phone.fill();
  let box = { x: 390, y: 225, width: 180, height: 270 };
  let angle = 0;
  let visible = true, calls = 0, stopped = 0, frames = 0;
  const streams = [];
  function draw() {
    ctx.fillStyle = '#bac8c8'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // Stable table-like background deliberately differs from the target.
    ctx.strokeStyle = '#a7b8b8'; ctx.lineWidth = 1;
    for (let y = 0; y < HEIGHT; y += 37) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(280, y + 6, 640, y - 8, WIDTH, y + 2); ctx.stroke();
    }
    ctx.fillStyle = '#d7dfda'; ctx.fillRect(30, 50, 130, 90);
    ctx.fillStyle = '#80949b'; ctx.fillRect(780, 545, 115, 95);
    if (visible) {
      ctx.save();
      ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
      ctx.rotate(angle);
      ctx.drawImage(object, -box.width / 2, -box.height / 2, box.width, box.height);
      ctx.restore();
    }
    frames++;
  }
  setInterval(draw, 1000 / fps); draw();
  const mediaDevices = navigator.mediaDevices || {};
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
  Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    calls++;
    if (denyFirst && calls === 1) throw new DOMException('Permission denied by QA fixture', 'NotAllowedError');
    const stream = canvas.captureStream(fps);
    stream.getTracks().forEach(track => {
      const stop = track.stop.bind(track);
      track.stop = () => { stopped++; stop(); };
    });
    streams.push(stream);
    return stream;
  } });
  window.__cameraFixture = {
    setBox(next) { box = { ...box, ...next }; visible = true; draw(); },
    setAngle(next) { angle = next; visible = true; draw(); },
    setVisible(next) { visible = next; draw(); },
    reset() { box = { x: 390, y: 225, width: 180, height: 270 }; angle = 0; visible = true; draw(); },
    snapshot() {
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const quad = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => ({
        x: cx + Math.cos(angle) * x * box.width - Math.sin(angle) * y * box.height,
        y: cy + Math.sin(angle) * x * box.width + Math.cos(angle) * y * box.height,
      }));
      const x = Math.min(...quad.map(p => p.x)), y = Math.min(...quad.map(p => p.y));
      const bounds = { x, y, width: Math.max(...quad.map(p => p.x)) - x, height: Math.max(...quad.map(p => p.y)) - y };
      return { box: bounds, canonicalBox: { ...box }, quad, angle, width: WIDTH, height: HEIGHT, visible, calls, stopped, frames,
      liveTracks: streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length }; },
    image() { return canvas.toDataURL('image/png'); },
  };
}

// Observe genuine renderer matrices. This hook never supplies a tracker box,
// homography, orientation, or scene transform to production code.
function observeHybridScene() {
  let three;
  window.__sceneObservation = { renders: 0 };
  Object.defineProperty(window, 'THREE', { configurable: true, get: () => three,
    set: T => {
      three = T;
      let renderer;
      Object.defineProperty(T, 'WebGLRenderer', { configurable: true, enumerable: true, get: () => renderer,
        set: Original => {
          renderer = new Proxy(Original, { construct(Target, args) {
            const instance = Reflect.construct(Target, args);
            const render = instance.render.bind(instance);
            instance.render = (scene, camera) => {
              render(scene, camera);
              const root = scene.getObjectByName('selected-object-overlay');
              const content = scene.getObjectByName('toaster-and-annotations');
              if (!root || !content) return;
              const annotations = scene.getObjectByName('annotations');
              const label = scene.getObjectByName('annotation-card');
              const inverse = new T.Matrix4().copy(root.matrixWorld).invert();
              const relativeLabel = label ? new T.Matrix4().multiplyMatrices(inverse, label.matrixWorld) : null;
              const bounds = new T.Box3().setFromObject(content);
              window.__sceneObservation = {
                renders: window.__sceneObservation.renders + 1,
                visible: root.visible, roll: root.rotation.z, userData: { ...root.userData },
                rootMatrix: [...root.matrixWorld.elements], contentMatrix: [...content.matrixWorld.elements],
                labelRelativeMatrix: relativeLabel ? [...relativeLabel.elements] : null,
                labelWorldMatrix: label ? [...label.matrixWorld.elements] : null,
                labelsShareContent: annotations?.parent === content,
                labelCount: annotations?.children.length || 0,
                triangles: instance.info.render.triangles, drawCalls: instance.info.render.calls,
                bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
                rendererSize: [instance.domElement.width, instance.domElement.height],
              };
            };
            return instance;
          } });
        } });
    } });
}

module.exports = { installHybridCameraFixture, observeHybridScene };
