import { CONFIG } from './config.js';
import { WorldTracker } from './world-tracker.js';
import { ToasterScene } from './scene.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), overlay = $('arOverlay'), selection = $('selectionCanvas');
const context = selection.getContext('2d');
const debug = new URLSearchParams(location.search).has('debug');
let scene, animation, xrSession, tracker, scenePreparation;
let state = 'loading', generation = 0, selectionGeneration = 0, supported = false;
let width = 1, height = 1, drag, draft, selectedPoint, hasPlacement = false;
let ending = false;
const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
function setState(value) { state = value; document.body.dataset.state = value; }
function status(text, kind = '') { setText('status', text); $('status').dataset.state = kind; }
function hint(title, detail) { setText('selectionTitle', title); setText('selectionDetail', detail); $('selectionHint').hidden = false; }
function sessionCopy(title, detail) { setText('sessionTitle', title); setText('sessionHint', detail); }
function loader(text, cancellable = false) {
  setText('loaderDetail', text); $('cancelLoadingButton').hidden = !cancellable;
  $('lottieLoader').hidden = false; animation?.play();
}
function hideLoader() { $('lottieLoader').hidden = true; animation?.pause(); }
function timed(promise, timeout, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })])
    .finally(() => clearTimeout(timer));
}
async function prepareScene() {
  if (scene?.ready) return;
  if (!scenePreparation) scenePreparation = (async () => {
    let instance;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CONFIG.startupTimeoutMs);
    try {
      instance = scene = new ToasterScene($('sceneCanvas'), $('annotations'), stage);
      const response = await fetch(CONFIG.experienceUrl, { signal: abort.signal });
      if (!response.ok) throw new Error('The experience configuration could not load.');
      await timed(instance.load(await response.json()), CONFIG.startupTimeoutMs, 'The toaster took too long to load. Please retry.');
      instance.setLabelsEnabled($('labelsButton').getAttribute('aria-pressed') === 'true');
    } catch (error) {
      instance?.dispose(); if (scene === instance) scene = null;
      throw error;
    } finally { clearTimeout(timer); }
  })().catch(error => {
    // Also clear synchronous renderer-construction failures, after the cached
    // promise has been assigned, so the visible Retry action can really retry.
    scenePreparation = null;
    throw error;
  });
  return scenePreparation;
}
function clearDrawing() {
  if (drag && selection.hasPointerCapture(drag.id)) selection.releasePointerCapture(drag.id);
  drag = null; draft = null;
  document.body.dataset.drawing = 'false';
  context.clearRect(0, 0, width, height);
}
function hideSessionUI() {
  clearDrawing(); selectedPoint = null;
  ['selectionCanvas', 'selectionHint', 'sessionBar', 'aimMarker', 'debug'].forEach(id => { $(id).hidden = true; });
  $('placeButton').hidden = true; $('placeButton').disabled = true;
  scene?.hide(); scene?.hideReticle();
}
function showIntro() {
  document.body.dataset.mode = 'ready';
  $('intro').hidden = false; $('errorCard').hidden = true;
  $('startButton').disabled = !supported || !scene?.ready;
  $('supportButton').hidden = supported;
  status(supported ? 'Ready for 3D AR' : '3D AR unavailable');
  setState(supported ? 'ready' : 'unsupported');
}
async function initialize() {
  const token = ++generation;
  hideSessionUI(); $('intro').hidden = true; $('errorCard').hidden = true;
  setState('loading'); loader('Checking 3D AR support');
  try {
    supported = Boolean(window.isSecureContext && navigator.xr && await navigator.xr.isSessionSupported('immersive-ar'));
    if (token !== generation) return;
    if (supported) {
      loader('Preparing the toaster');
      await prepareScene();
      if (token !== generation) return;
      setText('supportMessage', 'Keep the object fixed. Use good light and a textured table or floor. Camera and motion access are requested when AR starts.');
    } else {
      setText('supportMessage', window.isSecureContext
        ? 'This browser cannot start 3D AR. Open this HTTPS link in Chrome on an ARCore-supported Android phone or tablet. iPhone Safari and MacBook webcams do not support this mode.'
        : 'Camera AR requires HTTPS. Open the published HTTPS link on an ARCore-supported Android phone or tablet.');
    }
    hideLoader(); showIntro(); resize();
  } catch (error) { if (token === generation) void showError(error, 'initialize'); }
}
function providerChange(result) {
  if (!xrSession || !tracker || ending) return;
  if (debug) setText('debug', 'WebXR · native world anchor\nstate: ' + result.state);
  if (result.worldMatrix) {
    hasPlacement = true;
    scene.setWorldPose(result.worldMatrix); scene.hideReticle();
    selectedPoint = null; $('aimMarker').hidden = true;
    $('selectionHint').hidden = true; $('selectionCanvas').hidden = true;
    $('placeButton').hidden = true; $('placeButton').disabled = true;
    setState('anchored'); status('3D anchored', 'tracking');
    sessionCopy('Walk around your object', 'The toaster and labels stay in place. Keep the real object fixed.');
    return;
  }
  scene.hide();
  if (result.reticleMatrix) scene.showReticle(result.reticleMatrix, result.state === 'ready');
  else scene.hideReticle();
  if (result.state === 'idle') return;
  if (result.state === 'limited') {
    setState('limited'); status('Finding your position', 'lost');
    $('placeButton').disabled = true;
    hint('Move slowly to recover tracking', hasPlacement
      ? 'Point back at the surrounding surface. Your existing anchor will return when tracking recovers.'
      : 'Keep the table or floor in view so the camera can locate the surface.');
    return;
  }
  if (result.state === 'placing') {
    setState('placing'); $('placeButton').disabled = true;
    status('Creating 3D anchor'); hint('Placing your experience', 'Hold the camera steady for a moment.');
    return;
  }
  if (result.state === 'scanning') {
    const changed = hasPlacement || Boolean(selectedPoint);
    if (changed) {
      ++selectionGeneration;
      hasPlacement = false; selectedPoint = null; clearDrawing();
    }
    if (changed || state !== 'selecting') selectionUI(changed ? 'The placement was cleared. Select the object and its supporting surface again.' : '');
    return;
  }
  if (!selectedPoint) {
    if (state !== 'selecting') selectionUI();
    return;
  }
  setState('aiming');
  $('placeButton').hidden = false; $('placeButton').disabled = result.state !== 'ready';
  $('aimMarker').hidden = false;
  if (result.state === 'ready') {
    status('Surface ready', 'tracking');
    hint('Ready to place', 'The ring marks the measured surface. Tap Place here to anchor the toaster beside it.');
    sessionCopy('Confirm the surface', 'The toaster will stay at this location as you walk around.');
  } else {
    status('Finding a surface');
    hint('Find the table or floor', result.message || 'Move slowly and keep the surface point near your object’s base.');
    sessionCopy('Measuring your placement', 'Wait for a stable surface, or draw a new selection near the object’s base.');
  }
}
function selectionUI(message = '') {
  setState('selecting'); $('selectionCanvas').hidden = false;
  $('selectionHint').hidden = false; $('placeButton').hidden = true;
  $('aimMarker').hidden = true;
  hint('Draw around your object and its base', message || 'Include a little table or floor below it. Keep your camera steady while drawing.');
  sessionCopy('Choose a stationary object', 'First move your phone slowly over the surrounding surface, then draw a box.');
  status('Select a placement');
}
function beginSelection(message = '') {
  if (!tracker || !xrSession) return;
  ++selectionGeneration;
  hasPlacement = false; selectedPoint = null; clearDrawing();
  scene.hide(); scene.hideReticle();
  // Clear state before reset emits its scanning callback.
  setState('selecting'); tracker.reset(); selectionUI(message);
}
async function startAR() {
  if (!supported || !scene?.ready || xrSession || state === 'requesting') return;
  const token = ++generation;
  ++selectionGeneration; hasPlacement = false; ending = false;
  $('intro').hidden = true; $('errorCard').hidden = true;
  setState('requesting'); loader('Allow camera and motion access to enter AR.', true); status('Starting 3D AR');
  // Keep requestSession in the button's user-activation turn. No awaits precede it.
  let request;
  try {
    request = navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'hit-test', 'anchors', 'dom-overlay'],
      domOverlay: { root: overlay },
    });
  } catch (error) { void showError(error); return; }
  let next;
  try {
    next = await request;
    if (token !== generation) { await next.end(); return; }
    xrSession = next;
    next.addEventListener('end', () => {
      if (xrSession === next) finishSession();
    }, { once: true });
    next.addEventListener('visibilitychange', () => {
      if (xrSession === next && next.visibilityState !== 'visible') {
        scene.hide(); scene.hideReticle(); $('placeButton').disabled = true;
        if (hasPlacement) { setState('limited'); status('AR paused', 'lost'); }
      }
    });
    if (!next.domOverlayState) throw new Error('This browser cannot show the AR selection controls. Use Chrome on an ARCore-supported Android device.');
    loader('Starting world tracking…', true);
    await timed(scene.startSession(next), CONFIG.startupTimeoutMs, 'The graphics session took too long to start. Please retry.');
    if (token !== generation) { await next.end().catch(() => {}); return; }
    const currentTracker = new WorldTracker({ config: CONFIG.world,
      onChange: result => { if (token === generation) providerChange(result); },
      onError: (error, info) => {
        if (token !== generation) return;
        if (info?.recoverable) {
          status('Placement needs another try', 'lost');
          hint('Couldn’t place the anchor', error.message || 'Move slowly and try Place here again.');
        } else void showError(error);
      },
    });
    tracker = currentTracker;
    await currentTracker.start(next, scene.referenceSpace);
    if (token !== generation) { currentTracker.stop(); return; }
    document.body.dataset.mode = 'ar';
    $('sessionBar').hidden = false; $('debug').hidden = !debug;
    hideLoader(); resize(); beginSelection();
    scene.setAnimationLoop((time, frame) => {
      if (token !== generation || !frame || frame.session !== next) return;
      try {
        if (next.visibilityState && next.visibilityState !== 'visible') {
          scene.hide(); scene.hideReticle();
        } else currentTracker.update(frame, time);
        scene.render();
      } catch (error) { void showError(error); }
    });
  } catch (error) {
    if (token === generation) await showError(error);
    else if (next) await next.end().catch(() => {});
  }
}
function finishSession({ show = true } = {}) {
  ++generation; ++selectionGeneration; ending = true;
  tracker?.stop(); tracker = null; xrSession = null;
  scene?.setAnimationLoop(null); scene?.hide(); scene?.hideReticle();
  hasPlacement = false;
  hideSessionUI(); hideLoader();
  document.body.dataset.mode = 'ready'; ending = false;
  if (show) showIntro();
  resize();
}
async function closeSession() {
  const previous = xrSession;
  finishSession();
  await previous?.end().catch(() => {});
}
async function showError(error, retry = 'start') {
  if (state === 'error') return;
  const previous = xrSession;
  finishSession({ show: false });
  setState('error'); $('intro').hidden = true; $('errorCard').hidden = false;
  const message = {
    NotAllowedError: 'AR access was declined. Allow camera and motion access in your browser, then try again.',
    NotSupportedError: 'This browser does not support the world anchors, surface detection and AR controls required here. Use Chrome on an ARCore-supported Android phone or tablet.',
    SecurityError: 'AR access is blocked. Open this HTTPS page directly in your browser, outside an embedded preview.',
    InvalidStateError: 'Another AR session may still be active. Close it and try again.',
    AbortError: 'Loading was interrupted. Check your connection and try again.',
  };
  setText('errorMessage', message[error.name] || error.message || 'The experience could not start.');
  status('Needs attention');
  const reload = /WebGL context|graphics session was interrupted/i.test(error.message || '');
  $('retryButton').dataset.action = reload ? 'reload' : !scene?.ready ? 'initialize' : retry;
  $('retryButton').textContent = reload ? 'Reload page' : 'Try again';
  console.error('World AR:', error);
  await previous?.end().catch(() => {});
}
function point(event) {
  const bounds = selection.getBoundingClientRect();
  return { x: Math.max(0, Math.min(width, event.clientX - bounds.left)), y: Math.max(0, Math.min(height, event.clientY - bounds.top)) };
}
function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }
function drawSelection() {
  context.clearRect(0, 0, width, height);
  if (!draft) return;
  context.fillStyle = 'rgba(9,18,13,.25)'; context.fillRect(0, 0, width, height);
  context.clearRect(draft.x, draft.y, draft.width, draft.height);
  context.strokeStyle = '#d8f896'; context.lineWidth = 2; context.setLineDash([7, 5]);
  context.strokeRect(draft.x, draft.y, draft.width, draft.height); context.setLineDash([]);
  context.fillStyle = '#d8f896'; context.beginPath();
  context.arc(draft.x + draft.width / 2, draft.y + draft.height, 5, 0, Math.PI * 2); context.fill();
}
async function selectArea(rect) {
  clearDrawing();
  if (!tracker || rect.width < CONFIG.minSelectionPixels || rect.height < CONFIG.minSelectionPixels) {
    hint('Draw a larger box', 'Include your object and a little of the supporting surface below it.'); return;
  }
  const selected = ++selectionGeneration;
  const current = tracker;
  hasPlacement = false;
  // The lower middle points to the supporting surface rather than guessing
  // an arbitrary object's center, depth, dimensions or orientation from pixels.
  selectedPoint = { x: (rect.x + rect.width / 2) / width, y: (rect.y + rect.height) / height };
  $('aimMarker').style.left = selectedPoint.x * 100 + '%';
  $('aimMarker').style.top = selectedPoint.y * 100 + '%';
  $('aimMarker').hidden = false; $('selectionCanvas').hidden = true;
  setState('aiming'); $('placeButton').hidden = false; $('placeButton').disabled = true;
  try { await current.setSelection(selectedPoint); }
  catch (error) {
    if (selected === selectionGeneration && tracker === current) {
      beginSelection('Surface detection could not start. Draw again near a table or floor.');
      console.error('Surface selection:', error);
    }
  }
}
function resize() {
  const bounds = overlay.getBoundingClientRect();
  const nextWidth = Math.max(1, bounds.width), nextHeight = Math.max(1, bounds.height);
  const changed = width !== nextWidth || height !== nextHeight;
  width = nextWidth; height = nextHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  selection.width = Math.round(width * dpr); selection.height = Math.round(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene?.resize();
  if (changed && (drag || draft)) clearDrawing();
  if (changed && selectedPoint && tracker && !hasPlacement) beginSelection('The view changed. Draw the placement area again.');
}
function keyboard(event) {
  if (state !== 'selecting' || !['Enter',' ','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { clearDrawing(); return; }
  if (!draft) draft = { x: width * .3, y: height * .28, width: width * .4, height: height * .35 };
  else if (event.key === 'Enter' || event.key === ' ') { void selectArea({ ...draft }); return; }
  else {
    const dx = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
    const dy = event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0;
    if (event.shiftKey) { draft.width = Math.max(40, Math.min(width - draft.x, draft.width + dx)); draft.height = Math.max(40, Math.min(height - draft.y, draft.height + dy)); }
    else { draft.x = Math.max(0, Math.min(width - draft.width, draft.x + dx)); draft.y = Math.max(0, Math.min(height - draft.height, draft.y + dy)); }
  }
  document.body.dataset.drawing = 'true'; drawSelection();
}
function bind() {
  $('startButton').addEventListener('click', () => void startAR());
  $('supportButton').addEventListener('click', () => void initialize());
  $('stopButton').addEventListener('click', () => void closeSession());
  $('cancelLoadingButton').addEventListener('click', () => void closeSession());
  $('backButton').addEventListener('click', () => void closeSession());
  $('resetButton').addEventListener('click', () => beginSelection());
  $('placeButton').addEventListener('click', () => { if (tracker?.requestPlacement()) $('placeButton').disabled = true; });
  $('retryButton').addEventListener('click', () => {
    const action = $('retryButton').dataset.action;
    if (action === 'reload') location.reload();
    else if (action === 'initialize') void initialize();
    else void startAR();
  });
  $('labelsButton').addEventListener('click', () => {
    const enabled = $('labelsButton').getAttribute('aria-pressed') !== 'true';
    $('labelsButton').setAttribute('aria-pressed', String(enabled));
    setText('labelsButton', enabled ? 'Labels on' : 'Labels off'); scene?.setLabelsEnabled(enabled);
  });
  overlay.addEventListener('beforexrselect', event => event.preventDefault());
  selection.addEventListener('pointerdown', event => {
    if (state !== 'selecting' || drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); drag = { id: event.pointerId, start: point(event) };
    draft = rectangle(drag.start, drag.start); selection.setPointerCapture(event.pointerId);
    document.body.dataset.drawing = 'true'; drawSelection();
  });
  selection.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); draft = rectangle(drag.start, point(event)); drawSelection();
  });
  selection.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); const rect = rectangle(drag.start, point(event));
    clearDrawing(); void selectArea(rect);
  });
  selection.addEventListener('pointercancel', clearDrawing);
  selection.addEventListener('lostpointercapture', () => { if (drag) clearDrawing(); });
  selection.addEventListener('keydown', keyboard);
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.addEventListener('pagehide', () => void closeSession());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearDrawing(); scene?.hide(); scene?.hideReticle(); }
  });
  $('sceneCanvas').addEventListener('webglcontextlost', event => {
    event.preventDefault(); void showError(new Error('The graphics session was interrupted. Reload this page to continue.'));
  });
}
animation = window.lottie?.loadAnimation({ container: $('lottie'), renderer: 'svg', loop: true, autoplay: true, path: './assets/loader_light.json' });
bind(); resize(); void initialize();
