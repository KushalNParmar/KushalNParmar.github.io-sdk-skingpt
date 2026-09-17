#!/usr/bin/env node
/* Integration simulator; never a measurement of real-world WebXR tracking. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { installWebXRFixture } = require('./fixtures/webxr-fixture.cjs');
let playwright;
try { playwright = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'); }
catch { console.error('Install Playwright or set PLAYWRIGHT_MODULE_PATH to its module directory.'); process.exit(1); }
const url = process.argv[2] || 'http://127.0.0.1:8770';
const output = process.env.QA_OUTPUT_DIR || path.resolve(__dirname, '../work/world-qa');
fs.mkdirSync(output, { recursive: true });
const report = { started: new Date().toISOString(), url,
  limitation: 'Simulated XR device with genuine Three.js/GLB rendering; does not validate physical camera SLAM, drift, surface accuracy or mobile performance.', results: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const difference = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
const snapshot = page => page.evaluate(() => window.__webXRFixture.snapshot());
async function waitState(page, state, timeout = 15000) {
  await page.waitForFunction(expected => document.body.dataset.state === expected || document.body.dataset.state === 'error', state, { timeout });
  const current = await page.locator('body').getAttribute('data-state');
  assert.equal(current, state, `Expected ${state}: ${await page.locator('body').innerText()}`);
}
async function capture(page, name, result) {
  if (process.env.QA_SKIP_SCREENSHOTS === '1') return;
  try { await page.screenshot({ path: path.join(output, `${name}.png`), timeout: 8000 }); }
  catch (error) { (result.screenshotWarnings ||= []).push(error.message.split('\n')[0]); }
}
async function drawSelection(page) {
  const box = await page.locator('#selectionCanvas').boundingBox();
  assert.ok(box?.width > 10 && box?.height > 10);
  const from = { x: box.x + box.width * 0.31, y: box.y + box.height * 0.34 };
  const to = { x: box.x + box.width * 0.63, y: box.y + box.height * 0.67 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  return { x: 0.47, y: 0.67 };
}
async function place(page) {
  const selectedPoint = await drawSelection(page);
  await page.waitForFunction(() => !document.getElementById('placeButton').disabled, null, { timeout: 10000 });
  const before = await snapshot(page);
  const source = before.sources.at(-1);
  assert.equal(source.referenceSpace, 'viewer');
  assert.ok(source.ray.direction.x < 0 && source.ray.direction.y < 0 && source.ray.direction.z < 0,
    'A rectangle below/left of center must cast its bottom-center ray below/left, into the scene');
  const p = before.render.projection;
  const unnormalized = [(selectedPoint.x * 2 - 1) / p[0], (1 - 2 * selectedPoint.y) / p[5], -1];
  const length = Math.hypot(...unnormalized);
  const expected = unnormalized.map(n => n / length);
  assert.ok(difference(expected, [source.ray.direction.x, source.ray.direction.y, source.ray.direction.z]) < 0.002,
    'Hit-test ray must correspond to the selected rectangle base, accounting for XR projection');
  await page.locator('#placeButton').click();
  await waitState(page, 'anchored');
  await page.waitForFunction(() => window.__webXRFixture.snapshot().render?.rootVisible);
  return snapshot(page);
}
async function runCase(browser, name, viewport, fixtureOptions, body) {
  if (process.env.QA_CASE && !name.includes(process.env.QA_CASE)) return;
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (fixtureOptions !== null) await context.addInitScript(installWebXRFixture, fixtureOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const result = { name, viewport, errors: [], requests: [] };
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('response', response => {
    if (/Toaster\.glb|draco_decoder\.wasm|onnx|nanotrack/i.test(response.url())) result.requests.push({ url: response.url(), status: response.status() });
  });
  console.log(`RUN ${name}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    result.details = await body(page, result);
    assert.deepEqual(result.errors, [], 'No unhandled browser errors');
    assert.ok(!result.requests.some(item => /onnx|nanotrack/i.test(item.url)), 'World tracking must not load the old 2D tracker');
    result.pass = true;
  } catch (error) {
    result.pass = false; result.error = error.stack;
    result.state = await page.locator('body').getAttribute('data-state').catch(() => null);
    result.text = await page.locator('body').innerText().catch(() => '');
    result.fixture = await snapshot(page).catch(() => null);
  } finally {
    await capture(page, name, result);
    report.results.push(result);
    fs.writeFileSync(path.join(output, 'world-qa-report.json'), JSON.stringify(report, null, 2));
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}${result.error ? ': ' + result.error.split('\n')[0] : ''}`);
    await context.close();
  }
}
async function worldFlow(page, result) {
  await waitState(page, 'ready');
  await page.locator('#startButton').click();
  await waitState(page, 'selecting');
  const first = await place(page);
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].mode, 'immersive-ar');
  for (const feature of ['local', 'hit-test', 'anchors', 'dom-overlay']) assert.ok(first.requests[0].requiredFeatures.includes(feature));
  assert.equal(first.requests[0].overlayId, 'arOverlay');
  assert.equal(first.requests[0].userActivation, true, 'AR session permission must be requested from the user gesture');
  assert.equal(first.anchorCreates, 1);
  assert.equal(first.invalidAnchorCreates, 0, 'Native anchor creation must occur during an active XR frame');
  assert.equal(first.liveAnchors.length, 1);
  assert.equal(first.render.labelCount, 3);
  assert.equal(first.render.cameraIsPerspective, true);
  assert.equal(first.render.rootMatrixAutoUpdate, false);
  assert.equal(first.render.labelsShareContent, true);
  assert.ok(Math.abs(Math.max(first.render.modelSize[0], first.render.modelSize[2]) - 0.30) < 0.001);
  assert.ok(Math.abs(first.render.modelBottom - first.render.rootMatrix[13]) < 0.001, 'Model bottom must lie on the anchor-relative plane');
  assert.ok(first.render.triangles > 100 && first.render.drawCalls > 3, 'Real GLB geometry and annotations must be rendered');
  assert.ok(result.requests.some(r => /Toaster\.glb/.test(r.url) && r.status === 200));
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), false);
  await capture(page, `${result.name}-front`, result);
  const original = first.render;
  const beforeOrbit = await page.evaluate(() => {
    const count = window.__webXRFixture.snapshot().render.count;
    window.__webXRFixture.orbit(Math.PI / 2);
    return count;
  });
  await page.waitForFunction(before => window.__webXRFixture.snapshot().render?.count > before + 2, beforeOrbit);
  const side = (await snapshot(page)).render;
  assert.ok(difference(original.cameraMatrix, side.cameraMatrix) > 0.8, 'Camera pose must change when the user walks around');
  assert.ok(difference(original.rootMatrix, side.rootMatrix) < 1e-6, 'The anchored experience must keep its world position/rotation');
  assert.ok(difference(original.contentMatrix, side.contentMatrix) < 1e-6, 'Toaster scale and orientation must remain fixed in the room');
  assert.ok(difference(original.labelMatrix, side.labelMatrix) < 1e-6, 'Labels must stay attached rather than billboard toward the camera');
  assert.ok(difference(original.projectedPoint, side.projectedPoint) > 0.04, 'A fixed model point must project differently from the new viewpoint');
  await capture(page, `${result.name}-side`, result);
  await page.locator('#labelsButton').click();
  await page.waitForFunction(() => window.__webXRFixture.snapshot().render?.labelsVisible === false);
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), true);
  await page.locator('#labelsButton').click();
  await page.waitForFunction(() => window.__webXRFixture.snapshot().render?.labelsVisible === true);
  // Losing pose must hide the model, preserve the native anchor, and recover at
  // the same world transform without creating a replacement at the current view.
  await page.evaluate(() => window.__webXRFixture.anchorVisible(false));
  await waitState(page, 'limited');
  assert.equal(await page.locator('#annotations').evaluate(element => element.hidden), true);
  const lost = await snapshot(page);
  assert.equal(lost.anchorDeletes, 0);
  assert.deepEqual(lost.liveAnchors, first.liveAnchors);
  await page.evaluate(() => window.__webXRFixture.anchorVisible(true));
  await waitState(page, 'anchored');
  const recovered = await snapshot(page);
  assert.equal(recovered.anchorCreates, 1);
  assert.ok(difference(recovered.render.rootMatrix, original.rootMatrix) < 1e-6);
  await page.evaluate(() => window.__webXRFixture.viewerVisible(false));
  await waitState(page, 'limited');
  await page.evaluate(() => window.__webXRFixture.viewerVisible(true));
  await waitState(page, 'anchored');
  await page.locator('#resetButton').click();
  await waitState(page, 'selecting');
  const reset = await snapshot(page);
  assert.equal(reset.anchorDeletes, 1);
  assert.equal(reset.liveAnchors.length, 0);
  await place(page);
  await page.evaluate(() => window.__webXRFixture.resetReferenceSpace());
  await waitState(page, 'selecting');
  const referenceReset = await snapshot(page);
  assert.equal(referenceReset.anchorDeletes, 2);
  assert.equal(referenceReset.liveAnchors.length, 0);
  assert.ok(await page.locator('#aimMarker').isHidden(), 'Reference-space reset must clear the old selected screen point');
  await place(page);
  await page.locator('#stopButton').click();
  await waitState(page, 'ready');
  const stopped = await snapshot(page);
  assert.equal(stopped.activeSessions, 0);
  assert.equal(stopped.liveAnchors.length, 0);
  assert.equal(stopped.anchorDeletes, 3);
  assert.ok(stopped.sources.every(source => source.cancelled));
  return { initial: original, orbit: side, recovered: recovered.render, afterClose: stopped };
}
(async () => {
  const browser = await playwright.chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  try {
    await runCase(browser, 'unsupported-real-desktop', { width: 1200, height: 800 }, null, async page => {
      await waitState(page, 'unsupported');
      assert.ok(await page.locator('#startButton').isDisabled());
      assert.match(await page.locator('#supportMessage').innerText(), /android|webxr|supported/i);
      assert.equal(await page.locator('video').count(), 0, 'Unsupported desktop must not silently fall back to 2D webcam tracking');
      return { browserReportsImmersiveAR: await page.evaluate(() => navigator.xr?.isSessionSupported('immersive-ar') ?? false) };
    });
    await runCase(browser, 'world-landscape', { width: 1200, height: 800 }, {}, worldFlow);
    await runCase(browser, 'world-portrait', { width: 390, height: 844 }, {}, worldFlow);
    await runCase(browser, 'renderer-construction-retry', { width: 390, height: 844 }, { failRendererFirst: true }, async page => {
      await waitState(page, 'error');
      assert.match(await page.locator('#errorMessage').innerText(), /renderer initialization failed/i);
      assert.equal((await snapshot(page)).rendererConstructions, 1);
      await page.locator('#retryButton').click();
      await waitState(page, 'ready');
      assert.equal((await snapshot(page)).rendererConstructions, 2, 'Retry must construct a fresh renderer instead of reusing a rejected preparation promise');
      await page.locator('#startButton').click();
      await waitState(page, 'selecting');
      const placed = await place(page);
      assert.ok(placed.render.rootVisible);
      await page.locator('#stopButton').click();
      await waitState(page, 'ready');
      return snapshot(page);
    });
    await runCase(browser, 'cancel-delayed-graphics-restart', { width: 390, height: 844 }, { holdFirstLocal: true }, async page => {
      await waitState(page, 'ready');
      await page.locator('#startButton').click();
      await page.waitForFunction(() => window.__webXRFixture.snapshot().pendingLocal === 1);
      await page.locator('#cancelLoadingButton').click();
      await waitState(page, 'ready');
      await page.locator('#startButton').click();
      await waitState(page, 'selecting');
      await page.evaluate(() => window.__webXRFixture.releaseLocal());
      await sleep(300);
      assert.equal(await page.locator('body').getAttribute('data-state'), 'selecting');
      assert.equal((await snapshot(page)).activeSessions, 1, 'Late old graphics setup must not replace/end the new session');
      const placed = await place(page);
      assert.equal(placed.requests.length, 2);
      assert.equal(placed.ended, 1);
      assert.ok(placed.render.rootVisible);
      await page.locator('#stopButton').click();
      await waitState(page, 'ready');
      const closed = await snapshot(page);
      assert.equal(closed.activeSessions, 0);
      assert.equal(closed.liveAnchors.length, 0);
      return closed;
    });
    await runCase(browser, 'no-surface-denied-retry', { width: 390, height: 844 }, { denyFirst: true, noHit: true }, async page => {
      await waitState(page, 'ready');
      await page.locator('#startButton').click();
      await waitState(page, 'error');
      assert.match(await page.locator('#errorMessage').innerText(), /permission|allow|denied/i);
      await page.locator('#retryButton').click();
      await waitState(page, 'selecting');
      await drawSelection(page);
      await sleep(500);
      assert.ok(await page.locator('#placeButton').isDisabled(), 'No surface/depth must never allow fabricated placement');
      const missing = await snapshot(page);
      assert.equal(missing.anchorCreates, 0);
      assert.ok(!missing.render.rootVisible);
      await page.evaluate(() => window.__webXRFixture.hitVisible(true));
      await page.waitForFunction(() => !document.getElementById('placeButton').disabled);
      await page.locator('#placeButton').click();
      await waitState(page, 'anchored');
      await page.evaluate(() => window.__webXRFixture.end());
      await waitState(page, 'ready');
      const afterEnd = await snapshot(page);
      assert.equal(afterEnd.activeSessions, 0);
      assert.equal(afterEnd.liveAnchors.length, 0);
      assert.equal(afterEnd.requests.length, 2);
      await page.locator('#startButton').click();
      await waitState(page, 'selecting');
      await page.locator('#stopButton').click();
      await waitState(page, 'ready');
      return snapshot(page);
    });
  } finally {
    await browser.close();
    report.finished = new Date().toISOString();
    report.pass = report.results.length > 0 && report.results.every(result => result.pass);
    fs.writeFileSync(path.join(output, 'world-qa-report.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
