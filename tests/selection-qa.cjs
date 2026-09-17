#!/usr/bin/env node
/*
 * Real NanoTrack browser QA with a controlled camera, never injected poses.
 * Usage: node tests/selection-qa.cjs http://127.0.0.1:8770
 * Optional PLAYWRIGHT_MODULE_PATH, CHROME_PATH, QA_OUTPUT_DIR and QA_CASE env vars.
 * QA_SKIP_SCREENSHOTS=1 skips compositor captures; ROI pixel evidence is retained.
 * This validates controlled browser behavior, not physical mobile-camera quality.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { installCameraFixture } = require('./fixtures/camera-fixture.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'); }
catch (error) {
  console.error('Playwright is required. Install it with npm install --no-save playwright, or set PLAYWRIGHT_MODULE_PATH to its module directory.');
  process.exit(1);
}
const url = process.argv[2] || 'http://127.0.0.1:8770';
const output = process.env.QA_OUTPUT_DIR || path.resolve(__dirname, '../work/qa');
fs.mkdirSync(output, { recursive: true });
const report = { url, started: new Date().toISOString(), fixture: 'Self-created textured smartphone, canvas.captureStream(15)',
  limitation: 'Controlled camera frames on headless Chrome/SwiftShader; no physical-device or real-world tracking validation.', results: [] };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function state(page) { return page.locator('body').getAttribute('data-state'); }
async function waitState(page, expected, timeout = 60000) {
  try {
    await page.waitForFunction(value => {
      const current = document.body.dataset.state;
      return current === value || current === 'error'
        || (value === 'tracking' && ['selecting', 'lost'].includes(current));
    }, expected, { timeout });
  } catch (error) {
    throw new Error(`Waiting for ${expected}; current state=${await state(page)}; ${await page.locator('#selectionHint').textContent()}`, { cause: error });
  }
  if (expected !== 'error' && await state(page) === 'error') {
    throw new Error(`Expected ${expected}; application error: ${await page.locator('#errorMessage').innerText()}`);
  }
  if (await state(page) !== expected) {
    throw new Error(`Expected ${expected}; state=${await state(page)}; ${await page.locator('#selectionHint').textContent()}`);
  }
}
async function cameraBoxToScreen(page, box) {
  return page.evaluate(box => {
    const video = document.getElementById('camera');
    const rect = video.getBoundingClientRect();
    const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const dx = (rect.width - video.videoWidth * scale) / 2;
    const dy = (rect.height - video.videoHeight * scale) / 2;
    return { x: rect.x + dx + box.x * scale, y: rect.y + dy + box.y * scale,
      width: box.width * scale, height: box.height * scale };
  }, box);
}
async function fixtureScreenBox(page) {
  const fixture = await page.evaluate(() => window.__cameraFixture.snapshot());
  return cameraBoxToScreen(page, fixture.box);
}
async function settleCamera(page) {
  await page.waitForFunction(() => {
    const video = document.getElementById('camera');
    if (video.readyState < 2) return false;
    const fixture = window.__cameraFixture.snapshot();
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 96;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const box = fixture.box;
    context.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, 64, 96);
    const data = context.getImageData(0, 0, 64, 96).data;
    let sum = 0, squared = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += gray; squared += gray * gray;
    }
    const n = data.length / 4;
    // Callback delivery can drain buffered blank frames. Require the restored
    // target's actual video pixels before starting the selection gesture.
    return squared / n - (sum / n) ** 2 > 500;
  }, null, { polling: 50, timeout: 10000 });
}
async function selectFixture(page, { tiny = false } = {}) {
  const b = await fixtureScreenBox(page);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.mouse.move(b.x + (tiny ? 6 : b.width), b.y + (tiny ? 6 : b.height), { steps: 12 });
  const sample = await page.evaluate(() => {
    const frozen = document.getElementById('selectionFrame');
    const fixture = window.__cameraFixture.snapshot();
    const box = fixture.box;
    const live = document.createElement('canvas'); live.width = frozen.width; live.height = frozen.height;
    live.getContext('2d').drawImage(document.getElementById('camera'), 0, 0, live.width, live.height);
    const stats = canvas => {
      const pixels = canvas.getContext('2d').getImageData(Math.round(box.x * canvas.width / fixture.width),
        Math.round(box.y * canvas.height / fixture.height), Math.round(box.width * canvas.width / fixture.width),
        Math.round(box.height * canvas.height / fixture.height)).data;
      let sum = 0, sq = 0, count = 0, min = 255, max = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += value; sq += value * value; count++;
        min = Math.min(min, value); max = Math.max(max, value);
      }
      const variance = sq / count - (sum / count) ** 2;
      return { mean: sum / count, variance, standardDeviation: Math.sqrt(Math.max(0, variance)), min, max };
    };
    return { state: document.body.dataset.state, frozenHidden: frozen.hidden,
      videoTime: document.getElementById('camera').currentTime, fixture, frozenStats: stats(frozen), liveStats: stats(live),
      frozenImage: frozen.toDataURL('image/png'), liveImage: live.toDataURL('image/png') };
  });
  await page.mouse.up();
  return sample;
}
function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}
async function measureBox(page) {
  const expected = await fixtureScreenBox(page);
  const actual = await page.locator('#trackingBox').boundingBox();
  if (!actual) return { expected, actual: null, iou: 0, centerError: null, normalizedCenterError: 1 };
  const centerError = Math.hypot(actual.x + actual.width / 2 - expected.x - expected.width / 2,
    actual.y + actual.height / 2 - expected.y - expected.height / 2);
  return { expected, actual, iou: iou(actual, expected), centerError,
    normalizedCenterError: centerError / Math.hypot(expected.width, expected.height) };
}
async function waitAccurate(page, minimumIou = 0.45, timeout = 10000) {
  const until = Date.now() + timeout;
  let result;
  do {
    result = await measureBox(page);
    if (result.iou >= minimumIou && result.normalizedCenterError < 0.18) return result;
    await sleep(150);
  } while (Date.now() < until && await state(page) === 'tracking');
  assert.ok(result.iou >= minimumIou && result.normalizedCenterError < 0.18, `Tracking accuracy: ${JSON.stringify(result)}`);
  return result;
}
async function runCase(browser, name, viewport, body, cameraOptions = {}) {
  if (process.env.QA_CASE && !name.includes(process.env.QA_CASE)) return;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(installCameraFixture, cameraOptions);
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\.onnx(?:\?|$)|ort.*\.wasm(?:\?|$)/.test(response.url())) requests.push({ url: response.url(), status: response.status() });
  });
  const result = { name, viewport, errors, modelRequests: requests };
  console.log(`RUN ${name}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitState(page, 'ready');
    console.log('  ready');
    assert.equal(await page.getByRole('button', { name: /capture|preview|take photo/i }).count(), 0,
      'Selection POC should not expose photo capture or a separate preview');
    result.details = await body(page, result);
    assert.deepEqual(errors, [], 'No unhandled browser errors');
    result.pass = true;
  } catch (error) {
    result.pass = false; result.error = error.stack;
    result.state = await state(page).catch(() => null);
    result.bodyText = await page.locator('body').innerText().catch(() => '');
  } finally {
    await saveScreenshot(page, result, `${name}.png`);
    report.results.push(result);
    fs.writeFileSync(path.join(output, 'selection-qa-report.json'), JSON.stringify(report, null, 2));
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
    await context.close();
  }
}
async function saveScreenshot(page, result, name) {
  if (process.env.QA_SKIP_SCREENSHOTS === '1') return;
  try { await page.screenshot({ path: path.join(output, name), fullPage: true, timeout: 5000 }); }
  catch (error) { (result.screenshotWarnings ||= []).push(`${name}: ${error.message.split('\n')[0]}`); }
}

async function runTracking(page, result) {
  await page.locator('#startButton').click();
  await waitState(page, 'selecting');
  console.log('  camera selecting');
  await selectFixture(page, { tiny: true });
  await sleep(300);
  assert.equal(await state(page), 'selecting', 'A tiny selection must not initialize a tracker');
  const firstSelection = await selectFixture(page);
  await waitState(page, 'tracking', 20000);
  const initial = await waitAccurate(page, 0.65);
  result.details = { initial, firstSelection: { ...firstSelection, frozenImage: undefined, liveImage: undefined } };
  console.log(`  initial IoU ${initial.iou.toFixed(3)}`);
  // Change only source pixels, in small steps. The app continues to infer its own box.
  const movement = [];
  result.details.movement = movement;
  for (const box of [
    { x: 405, y: 235, width: 185, height: 277.5 },
    { x: 425, y: 244, width: 190, height: 285 },
    { x: 445, y: 258, width: 198, height: 297 },
  ]) {
    await page.evaluate(box => window.__cameraFixture.setBox(box), box);
    await sleep(600);
    movement.push(await waitAccurate(page));
  }
  const moved = movement.at(-1);
  console.log(`  movement IoU ${movement.map(item => item.iou.toFixed(3)).join(', ')}`);
  assert.ok(moved.actual.x > initial.actual.x + 15, 'Inferred target must translate with the source object');
  await saveScreenshot(page, result, `${result.name}-tracking.png`);
  const labelButton = page.locator('#labelsButton');
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), false);
  assert.match(await page.locator('#annotations').textContent(), /toaster/i);
  await labelButton.click();
  assert.equal(await labelButton.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), true);
  await labelButton.click();
  assert.equal(await labelButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), false);
  await page.evaluate(() => window.__cameraFixture.setVisible(false));
  await waitState(page, 'lost', 20000);
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), true,
    'Tracking loss must hide model annotations');
  await saveScreenshot(page, result, `${result.name}-lost.png`);
  await page.evaluate(() => window.__cameraFixture.reset());
  await settleCamera(page); // Wait for actual restored camera frames before drawing.
  await page.locator('#resetButton').click();
  await waitState(page, 'selecting');
  const reselection = await selectFixture(page);
  result.details.reselection = { ...reselection, frozenImage: undefined, liveImage: undefined };
  for (const kind of ['frozen', 'live']) {
    fs.writeFileSync(path.join(output, `${result.name}-reselect-${kind}.png`), Buffer.from(reselection[`${kind}Image`].split(',')[1], 'base64'));
  }
  console.log(`  reselect ROI variance frozen=${reselection.frozenStats.variance.toFixed(1)}, live=${reselection.liveStats.variance.toFixed(1)}`);
  await waitState(page, 'tracking', 20000);
  const reselected = await waitAccurate(page, 0.6);
  await page.locator('#stopButton').click();
  await waitState(page, 'ready');
  await sleep(300);
  const closed = await page.evaluate(() => window.__cameraFixture.snapshot());
  assert.equal(closed.liveTracks, 0, 'Close must stop every camera track');
  assert.ok(closed.stopped >= 1);
  assert.ok(result.modelRequests.some(r => /backbone\.onnx/.test(r.url) && r.status === 200), 'Actual backbone must load');
  assert.ok(result.modelRequests.some(r => /head\.onnx/.test(r.url) && r.status === 200), 'Actual head must load');
  return { initial, movement, reselected, cameraAfterClose: closed };
}

(async () => {
  const browser = await playwright.chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  try {
    await runCase(browser, 'landscape-inference', { width: 1200, height: 800 }, runTracking);
    await runCase(browser, 'portrait-inference', { width: 390, height: 844 }, runTracking);
    await runCase(browser, 'permission-retry-close', { width: 1200, height: 800 }, async page => {
      await page.locator('#startButton').click();
      await waitState(page, 'error');
      assert.match(await page.locator('#errorMessage').innerText(), /allow|denied|permission/i);
      await page.locator('#retryButton').click();
      await waitState(page, 'selecting');
      await page.locator('#stopButton').click();
      await waitState(page, 'ready');
      await page.locator('#startButton').click();
      await waitState(page, 'selecting');
      await page.locator('#stopButton').click();
      await waitState(page, 'ready');
      const camera = await page.evaluate(() => window.__cameraFixture.snapshot());
      assert.equal(camera.calls, 3);
      assert.equal(camera.liveTracks, 0);
      return camera;
    }, { denyFirst: true });
  } finally {
    await browser.close();
    report.finished = new Date().toISOString();
    report.pass = report.results.every(result => result.pass);
    fs.writeFileSync(path.join(output, 'selection-qa-report.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
