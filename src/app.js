import { CONFIG } from './config.js';
import { ObjectTracker } from './tracker.js';
import { ToasterScene } from './scene.js';
import { coverTransform, frameRectToView, viewRectToFrame, rectFromPoints, processingSize, isValidBox } from './geometry.js';

const $ = id => document.getElementById(id);
const video = $('camera');
const frame = $('trackingCanvas');
const frozen = $('selectionFrame');
const selection = $('selectionCanvas');
const stage = $('stage');
const drawContext = selection.getContext('2d');
const frameContext = frame.getContext('2d', { willReadFrequently: true });
const debugEnabled = new URLSearchParams(location.search).has('debug');
let scene, tracker, stream, animation, scenePreparation;
let state = 'loading', session = 0, selectionId = 0, raf = 0;
let trackerWork = Promise.resolve(), inFlight = null, targetReady = false;
let lastVideoTime = -1, lastInferAt = 0, lastResultAt = 0, hits = 0, misses = 0;
let targetBox = null, drag = null, draft = null, sourceWidth = 0, sourceHeight = 0;
let lastTrackingResult = null, firstMissAt = 0;
let viewWidth = 1, viewHeight = 1;

function status(text, kind = '') {
  if ($('status').textContent !== text) $('status').textContent = text;
  if ($('status').dataset.state !== kind) $('status').dataset.state = kind;
}
function setState(value) {
  state = value;
  document.body.dataset.state = value;
}
function loader(message, cancellable = false) {
  $('loaderDetail').textContent = message;
  $('cancelLoadingButton').hidden = !cancellable;
  $('lottieLoader').hidden = false;
  animation?.play();
}
function hideLoader() {
  $('lottieLoader').hidden = true;
  animation?.pause();
}
function hint(title, detail) {
  $('selectionTitle').textContent = title;
  $('selectionDetail').textContent = detail;
}
function sessionCopy(title, detail) {
  if ($('sessionTitle').textContent !== title) $('sessionTitle').textContent = title;
  if ($('sessionHint').textContent !== detail) $('sessionHint').textContent = detail;
}
function transform() {
  return coverTransform(frame.width, frame.height, viewWidth, viewHeight);
}
function isCurrent(token, selected = selectionId) {
  return token === session && selected === selectionId;
}
function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function prepareScene() {
  if (scene?.ready) return;
  if (!scenePreparation) {
    scenePreparation = (async () => {
      if (!scene) scene = new ToasterScene($('sceneCanvas'), $('annotations'), stage);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 45000);
      let experience;
      try {
        const response = await fetch(CONFIG.experienceUrl, { signal: abort.signal });
        if (!response.ok) throw new Error('The experience configuration could not load.');
        experience = await response.json();
      } finally { clearTimeout(timeout); }
      await withTimeout(scene.load(experience), 45000, 'The toaster took too long to load. Check your connection and retry.');
      scene.setLabelsEnabled($('labelsButton').getAttribute('aria-pressed') === 'true');
    })().catch(error => {
      // A timed-out GLTF fetch may still finish later. Disposing this instance
      // makes its late load release itself instead of breaking every retry.
      scene?.dispose();
      scene = null;
      scenePreparation = null;
      throw error;
    });
  }
  return scenePreparation;
}
function clearDrawing() {
  if (drag && selection.hasPointerCapture(drag.id)) selection.releasePointerCapture(drag.id);
  drag = null;
  draft = null;
  document.body.dataset.drawing = 'false';
  drawContext.clearRect(0, 0, viewWidth, viewHeight);
  frozen.hidden = true;
}
function hideTarget() {
  scene?.hide();
  $('trackingBox').hidden = true;
}
function clearSessionUI() {
  clearDrawing();
  hideTarget();
  ['intro', 'sessionBar', 'selectionHint', 'selectionCanvas', 'errorCard', 'debug'].forEach(id => { $(id).hidden = true; });
  $('startButton').disabled = false;
}
async function releaseCamera() {
  const previous = tracker;
  tracker = null;
  targetReady = false;
  inFlight = null;
  trackerWork = Promise.resolve();
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.pause();
  video.srcObject = null;
  await previous?.destroy();
}
async function closeSession() {
  ++session;
  ++selectionId;
  setState('ready');
  clearSessionUI();
  scene?.resetTrackingPose();
  hideLoader();
  document.body.dataset.mode = 'ready';
  $('intro').hidden = false;
  $('introMessage').textContent = 'Draw a box around an object. Watch a 3D toaster and its labels follow your selection.';
  status('Ready to explore');
  await releaseCamera();
}
async function startCamera() {
  const token = ++session;
  ++selectionId;
  setState('requesting');
  clearSessionUI();
  loader('Allow camera access in your browser to begin.', true);
  status('Opening camera');
  await releaseCamera();
  try {
    await prepareScene();
    if (token !== session) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Open this page over HTTPS (or localhost) to use the camera.');
    }
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (token !== session) { nextStream.getTracks().forEach(track => track.stop()); return; }
    stream = nextStream;
    video.srcObject = stream;
    await withTimeout(video.play(), 12000, 'The camera did not start. Please try again.');
    if (token !== session) return;
    if (!video.videoWidth || !video.videoHeight) throw new Error('The camera has not provided a video frame. Please retry.');
    configureFrame();
    document.body.dataset.mode = 'ar';
    loader('Preparing on-device tracking. The first load may take a moment.', true);
    const nextTracker = new ObjectTracker({ minScore: CONFIG.minScore, onFatal: error => {
      if (token === session) void showError(error);
    } });
    tracker = nextTracker;
    await nextTracker.init();
    if (token !== session) { await nextTracker.destroy(); return; }
    $('sessionBar').hidden = false;
    $('debug').hidden = !debugEnabled;
    hideLoader();
    await beginSelection();
    resize();
    nextStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (token === session) void showError(new Error('The camera stopped. Please start it again.'));
    });
    startLoop();
  } catch (error) {
    if (token === session) await showError(error);
  }
}
function configureFrame() {
  sourceWidth = video.videoWidth;
  sourceHeight = video.videoHeight;
  const size = processingSize(sourceWidth, sourceHeight, CONFIG.maxTrackingDimension);
  frame.width = size.width;
  frame.height = size.height;
}
function snapshotSelection() {
  if (video.readyState < 2 || !sourceWidth) return false;
  frozen.width = frame.width;
  frozen.height = frame.height;
  frozen.getContext('2d').drawImage(video, 0, 0, frozen.width, frozen.height);
  frozen.hidden = false;
  return true;
}
async function beginSelection(message = '') {
  if (!tracker?.ready || !stream) return;
  const token = session;
  const selected = ++selectionId;
  const currentTracker = tracker;
  targetReady = false;
  targetBox = null;
  lastTrackingResult = null;
  firstMissAt = 0;
  hits = 0; misses = 0;
  lastVideoTime = -1;
  clearDrawing();
  hideTarget();
  scene?.resetTrackingPose();
  setState('selecting');
  $('selectionCanvas').hidden = false;
  $('selectionHint').hidden = false;
  $('resetButton').textContent = 'New selection';
  hint('Draw a box around an object', message || 'Drag with your finger or mouse. Release to start tracking.');
  sessionCopy('Choose your object', 'Frame one object closely, with as little background as possible.');
  status('Select an object');
  // Serialize reset with any frame already being inferred. Stale results are discarded.
  trackerWork = trackerWork.catch(() => {}).then(async () => {
    if (isCurrent(token, selected) && tracker === currentTracker) await currentTracker.reset();
  });
  try { await trackerWork; }
  catch (error) { if (isCurrent(token, selected)) await showError(error); }
}
function paintSelection() {
  drawContext.clearRect(0, 0, viewWidth, viewHeight);
  if (!draft) return;
  const { x, y, width, height } = draft;
  drawContext.fillStyle = 'rgba(9, 18, 13, .36)';
  drawContext.fillRect(0, 0, viewWidth, viewHeight);
  drawContext.clearRect(x, y, width, height);
  drawContext.strokeStyle = '#d8f896';
  drawContext.lineWidth = 2;
  drawContext.setLineDash([7, 5]);
  drawContext.strokeRect(x, y, width, height);
  drawContext.setLineDash([]);
  const r = 4;
  drawContext.fillStyle = '#d8f896';
  for (const [cx, cy] of [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]) {
    drawContext.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
}
function pointerPoint(event) {
  const bounds = selection.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(viewWidth, event.clientX - bounds.left)),
    y: Math.max(0, Math.min(viewHeight, event.clientY - bounds.top)),
  };
}
function pointerDown(event) {
  if (!['selecting', 'lost'].includes(state) || drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  if (state === 'lost') void beginSelection();
  if (!snapshotSelection()) return;
  const point = pointerPoint(event);
  drag = { id: event.pointerId, start: point };
  draft = rectFromPoints(point, point);
  selection.setPointerCapture(event.pointerId);
  document.body.dataset.drawing = 'true';
  paintSelection();
}
function pointerMove(event) {
  if (!drag || event.pointerId !== drag.id) return;
  event.preventDefault();
  draft = rectFromPoints(drag.start, pointerPoint(event));
  paintSelection();
}
function pointerUp(event) {
  if (!drag || event.pointerId !== drag.id) return;
  event.preventDefault();
  draft = rectFromPoints(drag.start, pointerPoint(event));
  const box = { ...draft };
  const id = drag.id;
  drag = null;
  if (selection.hasPointerCapture(id)) selection.releasePointerCapture(id);
  document.body.dataset.drawing = 'false';
  void selectObject(box);
}
async function selectObject(rect) {
  if (!tracker?.ready || !['selecting', 'lost'].includes(state)) return;
  const box = viewRectToFrame(rect, transform(), frame.width, frame.height);
  if (rect.width < CONFIG.minSelectionPixels || rect.height < CONFIG.minSelectionPixels
      || box.width < CONFIG.minTargetPixels || box.height < CONFIG.minTargetPixels) {
    clearDrawing();
    hint('Draw a larger box', 'Include the whole object so there is enough detail to follow.');
    return;
  }
  const token = session;
  const selected = ++selectionId;
  const currentTracker = tracker;
  targetReady = false;
  setState('initializing');
  $('selectionCanvas').hidden = true;
  $('selectionHint').hidden = false;
  hint('Starting tracking', 'Hold your camera and object steady for a moment.');
  status('Starting tracking');
  sessionCopy('Locking onto your selection', 'The toaster will appear when tracking is stable.');
  trackerWork = trackerWork.catch(() => {}).then(async () => {
    if (!isCurrent(token, selected) || tracker !== currentTracker) return;
    await currentTracker.reset();
    if (!isCurrent(token, selected)) return;
    await currentTracker.select(frozen, box);
    if (!isCurrent(token, selected)) return;
    frozen.hidden = true;
    draft = null;
    drawContext.clearRect(0, 0, viewWidth, viewHeight);
    targetBox = box;
    targetReady = true;
    hits = 0; misses = 0;
    lastVideoTime = -1;
    lastInferAt = 0;
    lastResultAt = performance.now();
  });
  try { await trackerWork; }
  catch (error) {
    if (!isCurrent(token, selected)) return;
    if (error.name === 'SelectionError' || /visual detail|texture|blank|selection.*small/i.test(error.message)) {
      await beginSelection('Choose an object with clearer visual detail and try again.');
    } else await showError(error);
  }
}
function placeTrackedContent(box, snap, result = lastTrackingResult) {
  const rect = frameRectToView(box, transform());
  const visibleWidth = Math.min(viewWidth, rect.x + rect.width) - Math.max(0, rect.x);
  const visibleHeight = Math.min(viewHeight, rect.y + rect.height) - Math.max(0, rect.y);
  if (visibleWidth < Math.min(rect.width * 0.5, 32) || visibleHeight < Math.min(rect.height * 0.5, 32)) {
    loseTracking('Your object moved out of view. Draw a new box when it is visible.');
    return;
  }
  $('trackingBox').style.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px)';
  $('trackingBox').style.width = rect.width + 'px';
  $('trackingBox').style.height = rect.height + 'px';
  $('trackingBox').hidden = false;
  scene.place(rect, { ...result, snap });
}
function loseTracking(message = 'Draw a new box around your object to continue.') {
  if (!['tracking', 'initializing', 'recovering'].includes(state)) return;
  ++selectionId;
  targetReady = false;
  targetBox = null;
  hideTarget();
  clearDrawing();
  setState('lost');
  status('Tracking lost', 'lost');
  $('selectionCanvas').hidden = false;
  $('selectionHint').hidden = false;
  hint('Select your object again', message);
  sessionCopy('Let’s find your object again', 'Keep it visible, move slowly, and draw a close-fitting box.');
  $('resetButton').textContent = 'Select again';
}
function recoverTracking() {
  const now = performance.now();
  if (!firstMissAt) firstMissAt = now;
  hits = 0;
  ++misses;
  setState('recovering');
  status('Finding your selection', 'recovering');
  sessionCopy('Keep your object in view', 'Hold steady for a moment, or choose New selection.');
  if (now - firstMissAt >= CONFIG.holdLastPoseMs) {
    hideTarget();
    $('selectionHint').hidden = false;
    hint('Looking for your object', 'Move back toward your last view and hold steady.');
  }
  if (now - firstMissAt >= CONFIG.recoveryWindowMs) {
    loseTracking('We could not find your selection confidently. Draw a new box to continue.');
  }
}
function inferFrame(now) {
  if (!targetReady || inFlight || !tracker || !['tracking', 'initializing', 'recovering'].includes(state)) return;
  if (now - lastInferAt < CONFIG.detectIntervalMs || video.currentTime === lastVideoTime || video.readyState < 2) return;
  const token = session;
  const selected = selectionId;
  const currentTracker = tracker;
  const job = {};
  inFlight = job;
  lastVideoTime = video.currentTime;
  lastInferAt = now;
  frameContext.drawImage(video, 0, 0, frame.width, frame.height);
  trackerWork = trackerWork.catch(() => {}).then(() => {
    if (!isCurrent(token, selected)) return null;
    return currentTracker.update(frame);
  });
  trackerWork.then(result => {
    if (!result || !isCurrent(token, selected)) return;
    lastResultAt = performance.now();
    if (debugEnabled) $('debug').textContent = 'engine: ' + (result.trackingMode || 'nanotrack') + ' / ' + currentTracker.mode
      + '\nscore: ' + Number(result.score).toFixed(3)
      + '\nfeatures: ' + (result.featureCount || 0) + ' / inliers: ' + Number(result.inlierRatio || 0).toFixed(2)
      + '\ninference: ' + Number(result.inferenceMs).toFixed(0) + ' ms'
      + '\nrotation: ' + (result.homography ? 'measured in image plane' : 'holding last orientation')
      + '\nstate: ' + (result.reliable ? 'reliable' : result.reason || 'uncertain');
    if (!result.reliable || !isValidBox(result.box, frame.width, frame.height)) {
      recoverTracking();
      return;
    }
    misses = 0;
    ++hits;
    targetBox = result.box;
    lastTrackingResult = result;
    if (hits >= CONFIG.revealFrames) {
      const first = state !== 'tracking' || hits === CONFIG.revealFrames;
      firstMissAt = 0;
      setState('tracking');
      $('selectionHint').hidden = true;
      status('Object tracked', 'tracking');
      sessionCopy('Your object, augmented', result.homography
        ? 'Following position, size and visible rotation. Keep the same side in view.'
        : 'Following your selection. Clear visual detail helps with rotation.');
      placeTrackedContent(targetBox, first, result);
    }
  }).catch(error => {
    if (isCurrent(token, selected)) void showError(error);
  }).finally(() => { if (inFlight === job) inFlight = null; });
}
function startLoop() {
  if (raf) return;
  const loop = now => {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (stream && video.readyState >= 2 && (video.videoWidth !== sourceWidth || video.videoHeight !== sourceHeight)) {
      configureFrame();
      void beginSelection('The camera view changed. Please select your object again.');
    }
    if (targetReady && now - lastResultAt > CONFIG.staleAfterMs) {
      loseTracking('Tracking paused. Keep your object visible and select it again.');
    }
    if (state === 'recovering' && firstMissAt) {
      if (now - firstMissAt >= CONFIG.holdLastPoseMs) hideTarget();
      if (now - firstMissAt >= CONFIG.recoveryWindowMs) loseTracking('We could not find your selection confidently. Draw a new box to continue.');
    }
    inferFrame(now);
    scene?.render(now);
  };
  raf = requestAnimationFrame(loop);
}
function resize() {
  const bounds = stage.getBoundingClientRect();
  viewWidth = Math.max(1, bounds.width);
  viewHeight = Math.max(1, bounds.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  selection.width = Math.round(viewWidth * dpr);
  selection.height = Math.round(viewHeight * dpr);
  drawContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene?.resize();
  if (drag || draft) clearDrawing();
  if (state === 'tracking' && targetBox) placeTrackedContent(targetBox, true);
}
function keyboardSelection(event) {
  if (!['selecting', 'lost'].includes(state)) return;
  if (!['Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { clearDrawing(); return; }
  if (state === 'lost') void beginSelection();
  if (!draft) {
    if (!snapshotSelection()) return;
    draft = { x: viewWidth * 0.32, y: viewHeight * 0.32, width: viewWidth * 0.36, height: viewHeight * 0.32 };
    hint('Adjust the selection', 'Arrow keys move. Shift + arrows resize. Enter starts tracking.');
  } else if (event.key === 'Enter' || event.key === ' ') {
    void selectObject({ ...draft });
    return;
  } else {
    const dx = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
    const dy = event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0;
    if (event.shiftKey) {
      draft.width = Math.max(40, Math.min(viewWidth - draft.x, draft.width + dx));
      draft.height = Math.max(40, Math.min(viewHeight - draft.y, draft.height + dy));
    } else {
      draft.x = Math.max(0, Math.min(viewWidth - draft.width, draft.x + dx));
      draft.y = Math.max(0, Math.min(viewHeight - draft.height, draft.y + dy));
    }
  }
  paintSelection();
}
async function showError(error) {
  if (state === 'error') return;
  ++session;
  ++selectionId;
  setState('error');
  clearSessionUI();
  hideLoader();
  document.body.dataset.mode = 'error';
  status('Needs attention');
  const messages = {
    NotAllowedError: 'Camera access was denied. Allow camera access in your browser’s site settings, then try again.',
    NotFoundError: 'No camera was found. Connect one or open this page on your phone.',
    NotReadableError: 'The camera is busy or unavailable. Close other camera apps, then try again.',
    AbortError: 'Loading was interrupted. Check your connection and try again.',
  };
  $('errorMessage').textContent = messages[error.name] || error.message || 'The experience could not start. Please try again.';
  const reload = /graphics session|WebGL context/i.test(error.message || '');
  $('retryButton').textContent = reload ? 'Reload page' : 'Try again';
  $('retryButton').dataset.reload = String(reload);
  $('errorCard').hidden = false;
  console.error('Object AR:', error);
  await releaseCamera();
}
async function boot() {
  try {
    animation = window.lottie?.loadAnimation({ container: $('lottie'), renderer: 'svg', loop: true, autoplay: true, path: './assets/loader_light.json' });
    $('startButton').addEventListener('click', () => void startCamera());
    $('stopButton').addEventListener('click', () => void closeSession());
    $('cancelLoadingButton').addEventListener('click', () => void closeSession());
    $('backButton').addEventListener('click', () => void closeSession());
    $('retryButton').addEventListener('click', () => {
      if ($('retryButton').dataset.reload === 'true') location.reload();
      else void startCamera();
    });
    $('resetButton').addEventListener('click', () => void beginSelection());
    $('labelsButton').addEventListener('click', () => {
      const enabled = $('labelsButton').getAttribute('aria-pressed') !== 'true';
      $('labelsButton').setAttribute('aria-pressed', String(enabled));
      $('labelsButton').textContent = enabled ? 'Labels on' : 'Labels off';
      scene?.setLabelsEnabled(enabled);
    });
    selection.addEventListener('pointerdown', pointerDown);
    selection.addEventListener('pointermove', pointerMove);
    selection.addEventListener('pointerup', pointerUp);
    selection.addEventListener('pointercancel', clearDrawing);
    selection.addEventListener('lostpointercapture', () => { if (drag) clearDrawing(); });
    selection.addEventListener('keydown', keyboardSelection);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      clearDrawing();
      if (['tracking', 'initializing', 'recovering'].includes(state)) loseTracking('You returned to the camera. Select your object again.');
    });
    window.addEventListener('pagehide', () => {
      void closeSession();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    });
    $('sceneCanvas').addEventListener('webglcontextlost', event => {
      event.preventDefault();
      void showError(new Error('The graphics session was interrupted. Reload this page to continue.'));
    });
    resize();
    const token = session;
    await prepareScene();
    if (token !== session) return;
    setState('ready');
    status('Ready to explore');
    $('intro').hidden = false;
    hideLoader();
    startLoop();
  } catch (error) { await showError(error); }
}
void boot();
