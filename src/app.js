import { CONFIG } from './config.js';
import { CupTracker } from './tracker.js';
import { ToasterScene } from './scene.js';

const $ = id => document.getElementById(id);
let scene, tracker, stream, animation, network;
let mode = 'loading', frameId = 0, epoch = 0, lastDetectAt = 0, lastSeenAt = 0, hits = 0;
let preparing, stopping = Promise.resolve(), hasTracked = false, lastVideoTime = -1;
const debugEnabled = new URLSearchParams(location.search).has('debug');

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

function setStatus(text, state = '') {
  $('status').textContent = text;
  $('status').dataset.state = state;
}

function showLoader(message) {
  $('loaderDetail').textContent = message;
  $('lottieLoader').hidden = false;
  animation?.play();
}

function hideLoader() {
  $('lottieLoader').hidden = true;
  animation?.pause();
}

async function prepare() {
  if (!preparing) {
    preparing = (async () => {
      if (!scene) scene = new ToasterScene($('sceneCanvas'), $('annotations'), $('stage'));
      const results = await withTimeout(Promise.all([
        scene.ready ? Promise.resolve() : scene.load(),
        network ? Promise.resolve(network) : fetch(CONFIG.networkUrl).then(response => {
          if (!response.ok) throw new Error('The cup tracking model could not be loaded.');
          return response.json();
        }),
      ]), 45000, 'Loading timed out. Check your connection and reload the page.');
      network = results[1];
    })().catch(error => { preparing = null; throw error; });
  }
  return preparing;
}

function startRenderLoop() {
  if (frameId) return;
  const loop = now => {
    frameId = requestAnimationFrame(loop);
    if (document.hidden || !scene) return;
    if (mode === 'ar' && tracker && now - lastDetectAt >= CONFIG.detectIntervalMs && $('camera').currentTime !== lastVideoTime) {
      lastDetectAt = now;
      lastVideoTime = $('camera').currentTime;
      try {
        const state = tracker.step();
        if (state.label === 'CUP' && scene.updatePose(state, hits === 0)) {
          lastSeenAt = now;
          hits++;
          if (hits >= CONFIG.revealFrames) {
            scene.root.visible = true;
            hasTracked = true;
            setStatus('Cup tracked', 'tracking');
            $('sessionTitle').textContent = 'Your cup, augmented';
            $('sessionHint').textContent = 'Move slowly. Keep the whole cup in view.';
            $('scanGuide').hidden = true;
          }
        } else {
          hits = 0;
        }
        if (debugEnabled) $('debug').textContent = `label: ${state.label || 'none'}\nscore: ${state.score?.toFixed(3) ?? '—'}\nrender calls: ${scene.renderer.info.render.calls}`;
      } catch (error) {
        void showError(error);
      }
    }
    if (mode === 'ar' && now - lastSeenAt > CONFIG.lostAfterMs) {
      scene.root.visible = false;
      setStatus('Scanning for cup');
      $('scanGuide').hidden = false;
      $('sessionTitle').textContent = hasTracked ? 'Find your cup again' : 'Find your cup';
      $('sessionHint').textContent = 'Use an opaque coffee cup. Keep it fully visible.';
    }
    scene.render();
  };
  frameId = requestAnimationFrame(loop);
}

async function releaseCamera() {
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  $('camera').srcObject = null;
  const previous = tracker;
  tracker = null;
  if (previous) {
    stopping = stopping.then(() => previous.destroy()).catch(error => console.warn('Tracker cleanup:', error));
  }
  await stopping;
}

function resetUI() {
  $('intro').hidden = true;
  $('errorCard').hidden = true;
  $('sessionBar').hidden = true;
  $('scanGuide').hidden = true;
  $('debug').hidden = true;
  $('startButton').disabled = false;
  scene?.setMode('idle');
}

async function closeSession() {
  ++epoch;
  mode = 'ready';
  document.body.dataset.mode = 'ready';
  resetUI();
  hideLoader();
  setStatus('Ready to explore');
  $('intro').hidden = false;
  $('introMessage').textContent = 'Point your camera at a coffee cup. Explore a 3D toaster attached to it.';
  await releaseCamera();
}

async function preview() {
  const token = ++epoch;
  mode = 'loading';
  resetUI();
  showLoader('Preparing the toaster');
  await releaseCamera();
  try {
    await prepare();
    if (token !== epoch) return;
    mode = 'preview';
    document.body.dataset.mode = 'preview';
    scene.setMode('preview');
    $('sessionBar').hidden = false;
    $('resetButton').hidden = true;
    $('sessionTitle').textContent = 'Toaster preview';
    $('sessionHint').textContent = 'Drag to rotate · Camera tracking is off';
    setStatus('Preview · no tracking');
    hideLoader();
    startRenderLoop();
  } catch (error) { if (token === epoch) await showError(error); }
}

async function startCamera() {
  const token = ++epoch;
  mode = 'requesting';
  resetUI();
  $('intro').hidden = false;
  $('introMessage').textContent = 'Allow camera access in your browser to begin.';
  $('startButton').disabled = true;
  setStatus('Waiting for camera');
  await releaseCamera();
  try {
    await prepare();
    if (token !== epoch) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Open this page over HTTPS (or localhost) to use the camera.');
    }
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (token !== epoch) { newStream.getTracks().forEach(track => track.stop()); return; }
    stream = newStream;
    const video = $('camera');
    video.srcObject = stream;
    await video.play();
    if (token !== epoch) return;
    $('intro').hidden = true;
    showLoader('Starting cup tracking');
    tracker = new CupTracker({ video, canvas: $('trackingCanvas'), onFatal: error => { if (token === epoch) void showError(error); } });
    await tracker.init(network);
    if (token !== epoch) return;
    mode = 'ar';
    document.body.dataset.mode = 'ar';
    scene.setMode('ar', video);
    lastSeenAt = 0; lastDetectAt = 0; lastVideoTime = -1; hits = 0; hasTracked = false;
    $('sessionBar').hidden = false;
    $('resetButton').hidden = false;
    $('scanGuide').hidden = false;
    $('debug').hidden = !debugEnabled;
    setStatus('Scanning for cup');
    hideLoader();
    startRenderLoop();
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (token === epoch) void showError(new Error('The camera stopped. Try starting it again.'));
    });
  } catch (error) { if (token === epoch) await showError(error); }
}

async function showError(error) {
  if (mode === 'error') return;
  ++epoch;
  mode = 'error';
  resetUI();
  hideLoader();
  document.body.dataset.mode = 'error';
  setStatus('Needs attention');
  const messages = {
    NotAllowedError: 'Camera access was denied. Allow camera access in your browser’s site settings, then try again.',
    NotFoundError: 'No camera was found. Connect a camera or open this page on your phone.',
    NotReadableError: 'The camera is busy or unavailable. Close other camera apps, then try again.',
  };
  $('errorMessage').textContent = messages[error.name] || error.message || 'The experience could not load. Please reload and try again.';
  const hardFailure = /timeout|timed out|context|WebGL|ALREADY_INITIALIZED/i.test(error.message || '');
  $('retryButton').textContent = hardFailure ? 'Reload page' : 'Try again';
  $('retryButton').dataset.reload = String(hardFailure);
  $('errorPreviewButton').hidden = !scene?.ready || hardFailure;
  $('errorCard').hidden = false;
  console.error(error);
  await releaseCamera();
}

async function boot() {
  try {
    animation = window.lottie?.loadAnimation({ container: $('lottie'), renderer: 'svg', loop: true, autoplay: true, path: './assets/loader_light.json' });
    $('startButton').addEventListener('click', startCamera);
    $('previewButton').addEventListener('click', preview);
    $('errorPreviewButton').addEventListener('click', preview);
    $('stopButton').addEventListener('click', closeSession);
    $('retryButton').addEventListener('click', () => $('retryButton').dataset.reload === 'true' ? location.reload() : (scene?.ready ? startCamera() : location.reload()));
    $('labelsButton').addEventListener('click', () => {
      scene.labelsEnabled = !scene.labelsEnabled;
      $('labelsButton').setAttribute('aria-pressed', String(scene.labelsEnabled));
      $('labelsButton').textContent = scene.labelsEnabled ? 'Labels on' : 'Labels off';
      scene.drawLabels();
    });
    $('resetButton').addEventListener('click', () => {
      tracker?.reset(); hits = 0; lastSeenAt = 0; scene.root.visible = false;
    });
    new ResizeObserver(() => scene?.resize()).observe($('stage'));
    $('camera').addEventListener('resize', () => scene?.resize());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && mode === 'ar') {
        tracker?.reset(); hits = 0; lastSeenAt = 0; lastVideoTime = -1; scene.root.visible = false;
        scene.stabilizer.reset();
      }
    });
    window.addEventListener('pagehide', () => {
      ++epoch; mode = 'closed'; cancelAnimationFrame(frameId); frameId = 0;
      void releaseCamera();
    });
    window.addEventListener('pageshow', event => { if (event.persisted) { void closeSession(); startRenderLoop(); } });
    $('sceneCanvas').addEventListener('webglcontextlost', event => { event.preventDefault(); void showError(new Error('The graphics context was lost. Reload the page to restart.')); });
    await prepare();
    mode = 'ready';
    hideLoader();
    $('intro').hidden = false;
    setStatus('Ready to explore');
    startRenderLoop();
  } catch (error) { await showError(error); }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else void boot();
