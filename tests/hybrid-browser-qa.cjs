#!/usr/bin/env node
// Real OpenCV/NanoTrack inference over self-created camera pixels. No fake boxes
// or poses are injected. Viewport tests are not physical iOS/Android validation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { installHybridCameraFixture, observeHybridScene } = require('./fixtures/hybrid-camera-fixture.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const url = process.argv[2] || 'http://127.0.0.1:8771';
const output = process.env.QA_OUTPUT_DIR || path.resolve(__dirname, '../work/qa');
fs.mkdirSync(output, { recursive: true });
function sourceHashes() {
  const directory = path.resolve(__dirname, '../src');
  return Object.fromEntries(fs.readdirSync(directory).filter(file => file.endsWith('.js')).sort()
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')]));
}
const report = { url, started: new Date().toISOString(),
  fixture: 'Self-created textured phone, canvas.captureStream, real tracker inference; read-only Three render observation',
  limitation: 'Headless Chromium with SwiftShader and synthetic camera frames. No physical mobile camera, iOS Safari, or real-world accuracy validation.',
  sourceHashes: sourceHashes(), results: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = page => page.locator('body').getAttribute('data-state');
async function waitState(page, value, timeout = 30000) {
  await page.waitForFunction(value => document.body.dataset.state === value || document.body.dataset.state === 'error', value, { timeout });
  assert.equal(await state(page), value, `Expected ${value}: ${await page.locator('body').innerText()}`);
}
async function screenBox(page) {
  return page.evaluate(() => {
    const f = window.__cameraFixture.snapshot(), v = document.getElementById('camera'), b = v.getBoundingClientRect();
    const scale = Math.max(b.width / v.videoWidth, b.height / v.videoHeight);
    return { x: b.x + (b.width - v.videoWidth * scale) / 2 + f.box.x * scale,
      y: b.y + (b.height - v.videoHeight * scale) / 2 + f.box.y * scale,
      width: f.box.width * scale, height: f.box.height * scale };
  });
}
async function select(page) {
  const b = await screenBox(page);
  if (page.viewportSize().width < 900) {
    const session = await page.context().newCDPSession(page);
    const touch = (type, x, y) => session.send('Input.dispatchTouchEvent', { type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 }] });
    await touch('touchStart', b.x, b.y);
    for (let step = 1; step <= 10; step++) await touch('touchMove', b.x + b.width * step / 10, b.y + b.height * step / 10);
    await touch('touchEnd'); await session.detach();
  } else {
    await page.mouse.move(b.x, b.y); await page.mouse.down();
    await page.mouse.move(b.x + b.width, b.y + b.height, { steps: 10 });
    await page.mouse.up();
  }
  await waitState(page, 'tracking');
}
async function observation(page) { return page.evaluate(() => window.__sceneObservation); }
async function measure(page) {
  const expected = await screenBox(page), actual = await page.locator('#trackingBox').boundingBox();
  const render = await observation(page);
  if (!actual) return { expected, actual, iou: 0, normalizedCenterError: Infinity, render };
  const intersection = Math.max(0, Math.min(expected.x + expected.width, actual.x + actual.width) - Math.max(expected.x, actual.x))
    * Math.max(0, Math.min(expected.y + expected.height, actual.y + actual.height) - Math.max(expected.y, actual.y));
  const centerError = Math.hypot(actual.x + actual.width / 2 - expected.x - expected.width / 2,
    actual.y + actual.height / 2 - expected.y - expected.height / 2);
  return { expected, actual, iou: intersection / (expected.width * expected.height + actual.width * actual.height - intersection),
    centerError, normalizedCenterError: centerError / Math.hypot(expected.width, expected.height), render };
}
async function waitAccurate(page, { minimumIou = 0.55, targetRoll = null, timeout = 12000 } = {}) {
  const until = Date.now() + timeout;
  let value;
  do {
    value = await measure(page);
    const poseOK = targetRoll === null || (value.render.userData?.measuredRoll !== null
      && Math.abs(Math.atan2(Math.sin(value.render.roll - targetRoll), Math.cos(value.render.roll - targetRoll))) < 0.05);
    if (value.iou >= minimumIou && value.normalizedCenterError < 0.13 && poseOK) return value;
    await delay(180);
  } while (Date.now() < until && !['lost', 'error'].includes(await state(page)));
  assert.ok(value.iou >= minimumIou && value.normalizedCenterError < 0.13, `Inferred box alignment: ${JSON.stringify(value)}`);
  assert.ok(targetRoll === null || Math.abs(value.render.roll - targetRoll) < 0.05,
    `Measured roll did not follow camera pixels: ${JSON.stringify({ targetRoll, measured: value.render.roll, data: value.render.userData })}`);
  return value;
}
async function screenshot(page, result, suffix) {
  if (process.env.QA_SKIP_SCREENSHOTS === '1') return;
  try { await page.screenshot({ path: path.join(output, `${result.name}-${suffix}.png`), fullPage: true, timeout: 7000 }); }
  catch (error) { (result.screenshotWarnings ||= []).push(error.message.split('\n')[0]); }
}
async function settleCamera(page) {
  await page.waitForFunction(() => {
    const video = document.getElementById('camera'), f = window.__cameraFixture.snapshot();
    if (video.readyState < 2) return false;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 96;
    const context = canvas.getContext('2d');
    context.drawImage(video, f.box.x, f.box.y, f.box.width, f.box.height, 0, 0, 64, 96);
    const p = context.getImageData(0, 0, 64, 96).data;
    let sum = 0, squared = 0;
    for (let i = 0; i < p.length; i += 4) { const g = (p[i] + p[i + 1] + p[i + 2]) / 3; sum += g; squared += g * g; }
    const n = p.length / 4;
    return squared / n - (sum / n) ** 2 > 500;
  }, null, { timeout: 10000, polling: 80 });
}
function matrixNear(a, b, tolerance = 1e-7) {
  assert.equal(a?.length, 16); assert.equal(b?.length, 16);
  assert.ok(a.every((value, i) => Math.abs(value - b[i]) < tolerance), 'Label transform relative to toaster root must stay rigid');
}
async function runTracking(page, result) {
  await page.locator('#startButton').click();
  await waitState(page, 'selecting');
  await settleCamera(page);
  await select(page);
  const initial = await waitAccurate(page, { minimumIou: 0.65, targetRoll: 0 });
  assert.equal(initial.render.visible, true);
  assert.ok(initial.render.triangles > 1000, 'The actual GLB must draw, not only labels or a placeholder');
  assert.equal(initial.render.labelsShareContent, true);
  assert.equal(initial.render.labelCount, 3);
  const details = result.details = { initial, movement: [], rotation: [] };
  console.log(`  initial IoU=${initial.iou.toFixed(3)}, features=${initial.render.userData.poseKind}`);
  await screenshot(page, result, 'initial');
  for (const box of [{ x: 403, y: 233, width: 184, height: 276 }, { x: 413, y: 243, width: 190, height: 285 }]) {
    await page.evaluate(box => window.__cameraFixture.setBox(box), box);
    await delay(450);
    details.movement.push(await waitAccurate(page, { minimumIou: 0.90 }));
  }
  assert.ok(details.movement.at(-1).actual.x > initial.actual.x + 10, 'The tracker must follow translated pixels');
  assert.ok(details.movement.at(-1).render.rootMatrix[12] > initial.render.rootMatrix[12] + 8,
    'The rendered toaster must follow measured object movement');
  await page.evaluate(() => window.__cameraFixture.setBox({ x: 393, y: 211, width: 198, height: 297 }));
  await waitAccurate(page, { minimumIou: 0.9 });
  for (const degrees of [6, 12, 18, 24]) {
    const radians = degrees * Math.PI / 180;
    await page.evaluate(angle => window.__cameraFixture.setAngle(angle), radians);
    await delay(450);
    const sample = await waitAccurate(page, { targetRoll: -radians });
    details.rotation.push({ degrees, ...sample, rollErrorDegrees: Math.abs(sample.render.roll + radians) * 180 / Math.PI });
    console.log(`  rotation ${degrees}deg: IoU=${sample.iou.toFixed(3)}, rollError=${details.rotation.at(-1).rollErrorDegrees.toFixed(2)}deg`);
    matrixNear(sample.render.labelRelativeMatrix, initial.render.labelRelativeMatrix);
  }
  await screenshot(page, result, 'rotated');
  const labelButton = page.locator('#labelsButton');
  await labelButton.click(); assert.equal(await labelButton.getAttribute('aria-pressed'), 'false');
  await labelButton.click(); assert.equal(await labelButton.getAttribute('aria-pressed'), 'true');

  const recoveryStarted = Date.now();
  await page.evaluate(() => window.__cameraFixture.setVisible(false));
  await waitState(page, 'recovering', 10000);
  details.lossDetectedAfterMs = Date.now() - recoveryStarted;
  await delay(250);
  await page.evaluate(() => window.__cameraFixture.setVisible(true));
  const returnRequestedAt = Date.now();
  await waitState(page, 'tracking', 10000);
  details.recovered = await waitAccurate(page, { targetRoll: -24 * Math.PI / 180 });
  details.recoveryElapsedMs = Date.now() - recoveryStarted;
  details.recoveryAfterReturnRequestedMs = Date.now() - returnRequestedAt;
  console.log(`  recovered after ${details.recoveryElapsedMs}ms`);
  matrixNear(details.recovered.render.labelRelativeMatrix, initial.render.labelRelativeMatrix);

  await page.evaluate(() => window.__cameraFixture.setVisible(false));
  await waitState(page, 'lost', 12000);
  assert.equal(await page.locator('#annotations').evaluate(node => node.hidden), true);
  await screenshot(page, result, 'lost');
  await page.evaluate(() => window.__cameraFixture.reset());
  await settleCamera(page);
  await page.locator('#resetButton').click();
  await waitState(page, 'selecting');
  await select(page);
  details.reselected = await waitAccurate(page, { targetRoll: 0, minimumIou: 0.6 });
  assert.ok(Math.abs(details.reselected.render.roll) < 0.04, 'New selection must reset previous measured rotation');
  await page.locator('#stopButton').click();
  await waitState(page, 'ready');
  details.closedCamera = await page.evaluate(() => window.__cameraFixture.snapshot());
  assert.equal(details.closedCamera.liveTracks, 0);
  assert.ok(details.closedCamera.stopped >= 1);
  assert.ok(result.requests.some(item => /backbone\.onnx/.test(item.url) && item.status === 200));
  assert.ok(result.requests.some(item => /head\.onnx/.test(item.url) && item.status === 200));
  assert.ok(result.requests.some(item => /opencv\.js/.test(item.url) && item.status === 200));
  return details;
}
async function runCase(browser, name, viewport, run, { blockCV = false, denyFirst = false, workerUnavailable = false } = {}) {
  if (process.env.QA_CASE && !name.includes(process.env.QA_CASE)) return;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 900, isMobile: viewport.width < 900 });
  await context.addInitScript(installHybridCameraFixture, { denyFirst });
  await context.addInitScript(observeHybridScene);
  if (workerUnavailable) await context.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, { construct(Target, args) {
      if (String(args[0]).includes('nanotrack.worker.js')) throw new DOMException('Tracking workers disabled by QA fixture', 'NotSupportedError');
      return Reflect.construct(Target, args);
    } });
  });
  if (blockCV) await context.route('**/vendor/opencv/**', route => route.abort('failed'));
  const page = await context.newPage();
  const result = { name, viewport, selectionInput: viewport.width < 900 ? 'touch-drag' : 'mouse-drag',
    started: new Date().toISOString(), errors: [], requests: [] };
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => {
    if (/\.onnx(?:\?|$)|ort.*\.wasm(?:\?|$)|opencv\.js/.test(response.url())) result.requests.push({ url: response.url(), status: response.status() });
  });
  console.log(`RUN ${name}`);
  try {
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}debug`, { waitUntil: 'domcontentloaded' });
    await waitState(page, 'ready', 60000);
    assert.equal(await page.getByRole('button', { name: /capture|preview|take photo/i }).count(), 0);
    result.details = await run(page, result);
    assert.deepEqual(result.errors, [], 'No unhandled browser exceptions');
    result.pass = true;
  } catch (error) {
    result.pass = false; result.error = error.stack;
    result.state = await state(page).catch(() => null);
    result.bodyText = await page.locator('body').innerText().catch(() => '');
    result.observation = await observation(page).catch(() => null);
  } finally {
    await screenshot(page, result, 'final');
    result.finished = new Date().toISOString();
    report.results.push(result);
    fs.writeFileSync(path.join(output, 'hybrid-qa-report.json'), JSON.stringify(report, null, 2));
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
    await context.close();
  }
}
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  try {
    await runCase(browser, 'portrait-hybrid', { width: 390, height: 844 }, runTracking);
    await runCase(browser, 'tablet-hybrid', { width: 820, height: 1180 }, runTracking);
    await runCase(browser, 'desktop-hybrid', { width: 1200, height: 800 }, runTracking);
    await runCase(browser, 'opencv-unavailable-fallback', { width: 390, height: 844 }, async (page, result) => {
      await page.locator('#startButton').click(); await waitState(page, 'selecting'); await settleCamera(page); await select(page);
      const initial = await waitAccurate(page, { minimumIou: 0.55 });
      assert.equal(initial.render.visible, true); assert.ok(initial.render.triangles > 1000);
      assert.equal(initial.render.userData.measuredRoll, null, 'Fallback must not fabricate rotation');
      await screenshot(page, result, 'fallback');
      await page.locator('#stopButton').click(); await waitState(page, 'ready');
      return { initial, closed: await page.evaluate(() => window.__cameraFixture.snapshot()) };
    }, { blockCV: true });
    await runCase(browser, 'worker-unavailable-main-thread', { width: 390, height: 844 }, async (page, result) => {
      await page.locator('#startButton').click(); await waitState(page, 'selecting'); await settleCamera(page); await select(page);
      const initial = await waitAccurate(page, { minimumIou: 0.65, targetRoll: 0 });
      assert.match(await page.locator('#debug').innerText(), /main/);
      await page.evaluate(() => window.__cameraFixture.setAngle(0.15));
      const rotated = await waitAccurate(page, { targetRoll: -0.15 });
      assert.ok(Math.abs(rotated.render.roll) > 0.05, 'Main-thread OpenCV must produce measured rotation');
      await screenshot(page, result, 'main');
      await page.locator('#stopButton').click(); await waitState(page, 'ready');
      return { initial, rotated, closed: await page.evaluate(() => window.__cameraFixture.snapshot()) };
    }, { workerUnavailable: true });
    await runCase(browser, 'permission-retry', { width: 390, height: 844 }, async page => {
      await page.locator('#startButton').click(); await waitState(page, 'error');
      assert.match(await page.locator('#errorMessage').innerText(), /permission|allow|denied/i);
      await page.locator('#retryButton').click(); await waitState(page, 'selecting');
      await page.locator('#stopButton').click(); await waitState(page, 'ready');
      const camera = await page.evaluate(() => window.__cameraFixture.snapshot()); assert.equal(camera.liveTracks, 0);
      return camera;
    }, { denyFirst: true });
  } finally {
    await browser.close();
    report.finished = new Date().toISOString();
    report.sourceHashesAfter = sourceHashes();
    report.sourcesUnchangedDuringRun = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter);
    report.pass = report.sourcesUnchangedDuringRun && report.results.length > 0 && report.results.every(item => item.pass);
    fs.writeFileSync(path.join(output, 'hybrid-qa-report.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
