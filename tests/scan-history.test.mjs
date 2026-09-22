import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanHistoryWriter } from '../src/scan-history.mjs';

const appId = 'test-app';
const recordId = 'record-1';
const metadata = (scanId = 'scan-1', extra = {}) => ({ appId, scanId, predictionId: 'prediction-1', ...extra });
const event = value => ({ options: 'scan-metadata', value });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(appendScan = async () => {}) {
  const statuses = [];
  const writer = createScanHistoryWriter({
    store: { appendScan }, recordId, appId,
    onStatus: status => statuses.push(status),
  });
  return { writer, statuses };
}

test('ignores result, failure-shaped result, capture, and unrelated callbacks', async () => {
  let writes = 0;
  const { writer, statuses } = harness(async () => { writes++; });
  for (const ignored of [
    undefined, null, {},
    { options: 'result', value: { skinData: { score: 90 } } },
    { options: 'result', value: { error: 'No face detected', status_code: 422 } },
    { options: 'capture', value: metadata() },
    { options: 'error', value: metadata() },
    { options: 'retouch', value: metadata() },
    { options: 'unrelated', value: metadata() },
  ]) {
    assert.equal(await writer.handleEvent(ignored), false);
  }
  assert.equal(writes, 0);
  assert.equal(writer.pendingCount, 0);
  assert.deepEqual(statuses, []);
});

test('requires a serializable metadata object with matching appId and a nonempty scanId', async () => {
  const calls = [];
  const { writer, statuses } = harness(async (...args) => { calls.push(args); });
  const circular = metadata();
  circular.self = circular;
  for (const invalid of [
    undefined, null, [], 'scan-1', {},
    { scanId: 'scan-1' }, { appId },
    metadata('', {}), metadata('  '), metadata(12),
    metadata('scan-1', { appId: '' }),
    metadata('scan-1', { appId: 'another-app' }), circular,
  ]) {
    assert.equal(await writer.handleEvent(event(invalid)), false);
    assert.equal(writer.pendingCount, 0);
    assert.equal(statuses.at(-1).state, 'invalid');
    assert.equal(statuses.at(-1).error.code, 'invalid_scan_metadata');
  }
  assert.equal(calls.length, 0);
  assert.equal(await writer.handleEvent(event(metadata())), true);
  assert.deepEqual(calls, [[recordId, metadata()]]);
  assert.deepEqual(statuses.slice(-2), [
    { state: 'saving', pending: 1 }, { state: 'saved', pending: 0 },
  ]);
});

test('queues distinct scans behind a slow write and saves each against the linked record', async () => {
  const started = deferred();
  const release = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const { writer, statuses } = harness(async (id, value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push([id, value]);
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
    active--;
  });

  const first = writer.handleEvent(event(metadata('scan-1')));
  await started.promise;
  const second = writer.handleEvent(event(metadata('scan-2')));
  const third = writer.handleEvent(event(metadata('scan-3')));
  assert.equal(writer.pendingCount, 3);
  assert.equal(calls.length, 1);
  assert.equal(writer.retry(), first, 'retry joins the running write');
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(([id, value]) => [id, value.scanId]), [
    [recordId, 'scan-1'], [recordId, 'scan-2'], [recordId, 'scan-3'],
  ]);
  assert.equal(writer.pendingCount, 0);
  assert.deepEqual(statuses.map(status => status.state), ['saving', 'saved']);
});

test('a richer duplicate received during a slow save remains queued for another save', async () => {
  const started = deferred();
  const release = deferred();
  const calls = [];
  const { writer } = harness(async (id, value) => {
    calls.push([id, value]);
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const first = writer.handleEvent(event(metadata('scan-1', { pdfURL: null })));
  await started.promise;
  const updated = metadata('scan-1', { pdfURL: 'https://reports.example.invalid/scan-1.pdf', retouchPredictionId: 'retouch-1' });
  const second = writer.handleEvent(event(updated));
  assert.equal(writer.pendingCount, 1);
  assert.equal(calls.length, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].pdfURL, null);
  assert.deepEqual(calls[1], [recordId, updated]);
  assert.equal(writer.pendingCount, 0);
});

test('snapshots callback metadata before asynchronous work so later mutations cannot change the save', async () => {
  const calls = [];
  const { writer } = harness(async (id, value) => { calls.push([id, value]); });
  const input = metadata('scan-1', { currencySymbols: { USD: '$' }, details: { retained: 'original' }, tags: ['original'] });
  const expected = structuredClone(input);
  delete expected.currencySymbols;
  const callback = event(input);
  const operation = writer.handleEvent(callback);
  input.scanId = 'changed-scan';
  input.appId = 'changed-app';
  input.details.retained = 'changed';
  input.tags.push('changed');
  callback.value = metadata('replacement');
  assert.equal(await operation, true);
  assert.deepEqual(calls, [[recordId, expected]]);
});

test('failed saves resolve false, retain all queued scans, and manual retry confirms success', async () => {
  const failure = new Error('temporary storage failure');
  let fail = true;
  const calls = [];
  const { writer, statuses } = harness(async (id, value) => {
    calls.push([id, value.scanId]);
    if (fail) throw failure;
  });
  const first = writer.handleEvent(event(metadata('scan-1')));
  const second = writer.handleEvent(event(metadata('scan-2')));
  // Await the returned promises directly: storage rejection must be handled by
  // the coordinator rather than becoming a rejected callback or unhandled task.
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(writer.pendingCount, 2);
  assert.deepEqual(calls, [[recordId, 'scan-1']]);
  assert.deepEqual(statuses, [
    { state: 'saving', pending: 2 },
    { state: 'error', pending: 2, error: failure },
  ]);

  fail = false;
  assert.equal(await writer.retry(), true);
  assert.equal(writer.pendingCount, 0);
  assert.deepEqual(calls, [[recordId, 'scan-1'], [recordId, 'scan-1'], [recordId, 'scan-2']]);
  assert.deepEqual(statuses.slice(-2), [
    { state: 'saving', pending: 2 }, { state: 'saved', pending: 0 },
  ]);
});

test('same-key callbacks pending behind another scan merge useful fields without null or empty downgrades', async () => {
  const started = deferred();
  const release = deferred();
  const calls = [];
  const { writer } = harness(async (id, value) => {
    calls.push([id, value]);
    if (calls.length === 1) {
      started.resolve();
      await release.promise;
    }
  });
  const blocker = writer.handleEvent(event(metadata('scan-blocker')));
  await started.promise;
  const rich = metadata('scan-1', {
    pdfURL: 'https://reports.example.invalid/scan-1.pdf',
    subjectId: 'subject-1', retouchPredictionId: null,
  });
  const first = writer.handleEvent(event(rich));
  const second = writer.handleEvent(event(metadata('scan-1', {
    pdfURL: null, subjectId: '', predictionId: null, retouchPredictionId: 'retouch-1',
  })));
  assert.equal(writer.pendingCount, 2);
  release.resolve();
  assert.deepEqual(await Promise.all([blocker, first, second]), [true, true, true]);
  assert.equal(calls.length, 2, 'pending callbacks for one scan produce one merged save');
  assert.deepEqual(calls[1], [recordId, { ...rich, retouchPredictionId: 'retouch-1' }]);
});

test('retry with no pending work resolves successfully without a write or a status transition', async () => {
  const { writer, statuses } = harness(async () => { assert.fail('unexpected write'); });
  assert.equal(await writer.retry(), true);
  assert.equal(writer.pendingCount, 0);
  assert.deepEqual(statuses, []);
});
