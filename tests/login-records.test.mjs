import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRecordStore, LoginRecordError, normalizeLoginIdentity } from '../src/login-records.mjs';

const clone = value => structuredClone(value);
const scan = (overrides = {}) => ({ appId, scanId: 'scan-1', predictionId: 'prediction-1', subjectId: 'subject-1', pdfURL: null, ...overrides });
const entry = metadata => ({ 'scan-metadata': metadata });
const response = (body, ok = true) => ({ ok, json: async () => clone(body) });

function database({ initial = record(), intercept, timeoutMs } = {}) {
  const db = { row: clone(initial), calls: [] };
  const fetchImpl = async (url, init) => {
    const call = { path: url.slice(recordsUrl.length), method: init.method, payload: init.body ? JSON.parse(init.body) : undefined, init };
    db.calls.push(call);
    const intercepted = intercept ? await intercept(call, db) : undefined;
    if (intercepted !== undefined) return intercepted;
    if (call.path === '/list' && call.method === 'POST') {
      const filter = call.payload.filters[0];
      return response(list(db.row && filter.values.includes(db.row[filter.field]) ? [db.row] : []));
    }
    if (call.path === '' && call.method === 'POST') {
      assert.equal(db.row, null, 'A create must not replace an existing row');
      db.row = { id: 'record-1', ...clone(call.payload) };
      return response({ data: db.row });
    }
    assert.equal(call.path, '/record-1');
    if (call.method === 'GET') return response({ data: db.row });
    assert.equal(call.method, 'PATCH');
    assert.deepEqual(Object.keys(call.payload), ['meta'], 'Updates only replace metadata');
    db.row.meta = clone(call.payload.meta);
    return response({ data: db.row });
  };
  db.store = createLoginRecordStore({ recordsUrl, appId, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  db.patches = () => db.calls.filter(call => call.method === 'PATCH');
  db.login = () => db.store.resolve('email', email);
  return db;
}

const recordsUrl = 'https://records.example.invalid/tables/poc/records';
const appId = 'test-app';
const email = 'person@example.invalid';
const phone = '+12025550123';
const record = (overrides = {}) => ({ id: 'record-1', email, phone_number: null, meta: [], ...overrides });
const list = rows => ({ data: rows, pagination: { total_count: rows.length, total_pages: rows.length ? 1 : 0, current_page: 1, per_page: 2, type: 'page' } });
const expectCode = code => error => error instanceof LoginRecordError && error.code === code;

function pairedLookups(emailRows, phoneRows) {
  return [
    { path: '/list', method: 'POST', body: list(emailRows), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'email', operator: '=', values: [email] }]);
    } },
    { path: '/list', method: 'POST', body: list(phoneRows), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'phone_number', operator: 'IN', values: [phone, phone.slice(1)] }]);
    } },
  ];
}

function harness(steps, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { path: url.slice(recordsUrl.length), method: init.method, payload: init.body ? JSON.parse(init.body) : undefined, init };
    calls.push(call);
    const next = steps.shift();
    assert.ok(next, `Unexpected ${call.method} ${call.path}`);
    assert.equal(call.path, next.path);
    assert.equal(call.method, next.method);
    next.check?.(call);
    if (next.error) throw next.error;
    if (next.handler) return next.handler(call);
    return { ok: next.ok !== false, json: async () => {
      if (next.jsonError) throw next.jsonError;
      return next.body;
    } };
  };
  return {
    store: createLoginRecordStore({ recordsUrl, appId, fetchImpl, ...options }),
    calls,
    done() { assert.equal(steps.length, 0, 'All expected requests were made'); },
  };
}

test('normalizes email case and phone formatting into stable identities', () => {
  assert.deepEqual(normalizeLoginIdentity('email', ' Person@Example.Invalid '), { method: 'email', value: email });
  assert.deepEqual(normalizeLoginIdentity('phone', ' +1 (202) 555-0123 '), { method: 'phone', value: phone });
  assert.deepEqual(normalizeLoginIdentity('phone', '12025550123'), { method: 'phone', value: phone });
  for (const [method, value] of [['other', email], ['email', '  '], ['phone', null], [null, email]]) {
    assert.throws(() => normalizeLoginIdentity(method, value), expectCode('invalid_identity'));
  }
});

test('new email login persists empty history and returns canonical userId after readback', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'email', operator: '=', values: [email] }]);
      assert.deepEqual(payload.page, { page_no: 1, page_size: 2 });
    } },
    { path: '', method: 'POST', body: { data: { id: 'record-1' } }, check({ payload, init }) {
      assert.deepEqual(payload, { email, phone_number: null, meta: [] });
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.mode, 'cors');
    } },
    { path: '/record-1', method: 'GET', body: { data: record({ meta: { sessionId: 'stored-session' } }) } },
  ]);
  assert.deepEqual(await h.store.resolve('email', ' Person@Example.Invalid '), { recordId: 'record-1', userId: email });
  h.done();
});

test('new phone login stores country-code digits and retains E.164 SDK userId', async () => {
  const saved = record({ email: null, phone_number: phone.slice(1), meta: [] });
  const h = harness([
    { path: '/list', method: 'POST', body: list([]), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'phone_number', operator: 'IN', values: [phone, phone.slice(1)] }]);
    } },
    { path: '', method: 'POST', body: { id: 'record-1' }, check({ payload }) {
      assert.deepEqual(payload, { email: null, phone_number: phone.slice(1), meta: [] });
    } },
    { path: '/record-1', method: 'GET', body: saved },
  ]);
  assert.deepEqual(await h.store.resolve('phone', '+1 (202) 555-0123'), { recordId: 'record-1', userId: phone });
  h.done();
});

test('returning users ignore legacy sessions and reuse the record with canonical userId without writes', async () => {
  const existing = record({ meta: { sessionId: 'historical-session', skinAnalysisResult: { score: 42 } } });
  for (const body of [list([existing]), { items: [existing], total: 1 }]) {
    const h = harness([{ path: '/list', method: 'POST', body }]);
    assert.deepEqual(await h.store.resolve('email', email), { recordId: existing.id, userId: email });
    assert.equal(h.calls.length, 1);
    h.done();
  }
});

test('stored phone with or without plus reuses its history and canonical userId', async () => {
  for (const storedPhone of [phone, phone.slice(1)]) {
    const existing = record({ email: null, phone_number: storedPhone, meta: [entry(scan())] });
    const h = harness([{ path: '/list', method: 'POST', body: list([existing]), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'phone_number', operator: 'IN', values: [phone, phone.slice(1)] }]);
    } }]);
    assert.deepEqual(await h.store.resolve('phone', '+1 (202) 555-0123'), { recordId: 'record-1', userId: phone });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(existing.meta, [entry(scan())]);
    h.done();
  }
});

test('separate canonical and digits-only phone records are an ambiguous identity', async () => {
  const first = record({ email: '', phone_number: phone, meta: { sessionId: phone } });
  const second = record({ id: 'record-2', email: '', phone_number: phone.slice(1), meta: { sessionId: 'legacy-phone-session' } });
  const h = harness([{ path: '/list', method: 'POST', body: list([first, second]) }]);
  await assert.rejects(h.store.resolve('phone', phone), expectCode('duplicate_identity'));
  assert.equal(h.calls.length, 1);
  h.done();
});

test('lookup HTTP and transport failures never become a missing record or create', async () => {
  for (const failure of [{ ok: false, body: { error: 'unavailable' } }, { error: new TypeError('network unavailable') }]) {
    const h = harness([{ path: '/list', method: 'POST', ...failure }]);
    await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
    assert.equal(h.calls.length, 1);
    h.done();
  }
});

test('malformed and error-shaped successful lookup bodies are rejected', async () => {
  for (const body of [null, [], {}, { error: 'failed', data: [] }, { success: false, data: [] },
    { data: 'not rows' }, { data: [], pagination: { total_count: -1 } }, { data: [], total: '0' },
    { data: [], total: 1 }, { data: [record()], total: 0 }, { data: [null] }]) {
    const h = harness([{ path: '/list', method: 'POST', body }]);
    await assert.rejects(h.store.resolve('email', email), expectCode('invalid_response'));
    assert.equal(h.calls.length, 1);
    h.done();
  }
});

test('non-JSON API success is rejected without creating a record', async () => {
  const h = harness([{ path: '/list', method: 'POST', jsonError: new SyntaxError('HTML response') }]);
  await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
  h.done();
});

test('server filter identity mismatch blocks linking another user', async () => {
  const h = harness([{ path: '/list', method: 'POST', body: list([record({ email: 'someone-else@example.invalid' })]) }]);
  await assert.rejects(h.store.resolve('email', email), expectCode('identity_mismatch'));
  h.done();
});

test('duplicate matching identities block selection rather than choosing arbitrarily', async () => {
  for (const body of [list([record(), record({ id: 'record-2' })]), { data: [record()], pagination: { total_count: 3 } }]) {
    const h = harness([{ path: '/list', method: 'POST', body }]);
    await assert.rejects(h.store.resolve('email', email), expectCode('duplicate_identity'));
    h.done();
  }
});

test('lost create response recovers committed record without a second create', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]) },
    { path: '', method: 'POST', error: new TypeError('response lost after commit') },
    { path: '/list', method: 'POST', body: list([record()]) },
  ]);
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', userId: email });
  assert.equal(h.calls.filter(call => call.path === '').length, 1);
  h.done();
});

test('failed readback after create recovers using a fresh filtered lookup', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]) },
    { path: '', method: 'POST', body: { id: 'record-1' } },
    { path: '/record-1', method: 'GET', error: new TypeError('read interrupted') },
    { path: '/list', method: 'POST', body: list([record()]) },
  ]);
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', userId: email });
  h.done();
});

test('failed create with no committed record surfaces failure without blind retry', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]) },
    { path: '', method: 'POST', ok: false, body: { error: 'write failed' } },
    { path: '/list', method: 'POST', body: list([]) },
  ]);
  await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
  assert.equal(h.calls.filter(call => call.path === '').length, 1);
  h.done();
});

test('record readback identity mismatch is not accepted as successful persistence', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]) },
    { path: '', method: 'POST', body: { id: 'record-1' } },
    { path: '/record-1', method: 'GET', body: record({ email: 'someone-else@example.invalid' }) },
    { path: '/list', method: 'POST', body: list([]) },
  ]);
  await assert.rejects(h.store.resolve('email', email), expectCode('identity_mismatch'));
  h.done();
});

test('lookup timeout aborts the request and does not initialize a create flow', async () => {
  let aborted = false;
  const h = harness([{ path: '/list', method: 'POST', handler: ({ init }) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Timed out', 'AbortError')); }, { once: true });
  }) }], { timeoutMs: 10 });
  await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
  assert.equal(aborted, true);
  assert.equal(h.calls.length, 1);
  h.done();
});

test('simultaneous same-page identity requests share one lookup and promise', async () => {
  let release;
  const h = harness([{ path: '/list', method: 'POST', handler: () => new Promise(resolve => {
    release = () => resolve({ ok: true, json: async () => list([record()]) });
  }) }]);
  const first = h.store.resolve('email', email);
  const second = h.store.resolve('email', 'PERSON@EXAMPLE.INVALID');
  assert.equal(first, second);
  assert.equal(h.calls.length, 1);
  release();
  assert.deepEqual(await first, { recordId: 'record-1', userId: email });
  h.done();
});

test('failure clears in-flight state so a later explicit retry performs a fresh lookup', async () => {
  const h = harness([
    { path: '/list', method: 'POST', ok: false, body: {} },
    { path: '/list', method: 'POST', body: list([record()]) },
  ]);
  await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', userId: email });
  h.done();
});

test('returning login does not parse or rewrite old metadata', async () => {
  for (const meta of [null, [], { sessionId: 'old-session', glamAppId: 'old-app' }, '{malformed', 42]) {
    const h = harness([{ path: '/list', method: 'POST', body: { items: [record({ meta })], total: 1 } }]);
    assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', userId: email });
    assert.equal(h.calls.length, 1);
    h.done();
  }
});

test('append requires a resolved record and a valid scan for the configured app', async () => {
  const db = database();
  await assert.rejects(async () => db.store.appendScan('record-1', scan()), expectCode('unknown_record'));
  assert.equal(db.calls.length, 0);
  await db.login();
  for (const metadata of [null, [], {}, scan({ scanId: '' }), scan({ appId: '' }), scan({ appId: 'different-app' }), scan({ scanId: 42 })]) {
    await assert.rejects(async () => db.store.appendScan('record-1', metadata), expectCode('invalid_scan_metadata'));
  }
  assert.equal(db.calls.length, 1, 'Invalid events do not access the database');
});

test('first scan is persisted as a top-level array with readback confirmation', async () => {
  for (const meta of [null, 'null', []]) {
    const db = database({ initial: record({ meta }) });
    await db.login();
    assert.deepEqual(await db.store.appendScan('record-1', scan()), { recordId: 'record-1', scanId: 'scan-1' });
    assert.deepEqual(db.row.meta, [entry(scan())]);
    assert.deepEqual(db.calls.slice(1).map(call => call.method), ['GET', 'PATCH', 'GET']);
  }
});

test('append preserves older scans, other apps, and unknown wrapper metadata', async () => {
  const existing = [
    { ...entry(scan({ scanId: 'older' })), note: 'retain me' },
    entry(scan({ appId: 'other-app' })),
    { legacyReport: { score: 42 } },
  ];
  const db = database({ initial: record({ meta: existing }) });
  await db.login();
  await db.store.appendScan('record-1', scan());
  assert.deepEqual(db.row.meta, [...existing, entry(scan())]);
});

test('legacy migration removes obsolete identity fields but preserves scan and unknown data', async () => {
  const oldData = { ...entry(scan({ scanId: 'older' })), skinAnalysisResult: { score: 42 }, custom: 'retain' };
  for (const meta of [{ sessionId: 'obsolete', glamAppId: 'obsolete', ...oldData }, JSON.stringify({ sessionId: 'obsolete', glamAppId: 'obsolete', ...oldData })]) {
    const db = database({ initial: record({ meta }) });
    await db.login();
    await db.store.appendScan('record-1', scan());
    assert.deepEqual(db.row.meta, [oldData, entry(scan())]);
  }
});

test('legacy identity-only objects become clean scan arrays', async () => {
  const db = database({ initial: record({ meta: { sessionId: 'obsolete', glamAppId: appId } }) });
  await db.login();
  await db.store.appendScan('record-1', scan());
  assert.deepEqual(db.row.meta, [entry(scan())]);
});

test('legacy scan references without modern IDs are preserved and confirmed', async () => {
  const legacy = { 'scan-metadata': { olderScanReference: 'old-1' }, skinAnalysisResult: { score: 42 } };
  const db = database({ initial: record({ meta: legacy }) });
  await db.login();
  await db.store.appendScan('record-1', scan());
  assert.deepEqual(db.row.meta, [legacy, entry(scan())]);
});

test('readback must confirm the legacy metadata was stored as an array', async () => {
  const legacy = entry(scan());
  const db = database({ initial: record({ meta: legacy }), intercept(call) {
    if (call.method === 'GET') return response({ data: record({ meta: legacy }) });
  } });
  await db.login();
  await assert.rejects(db.store.appendScan('record-1', scan()), expectCode('persistence_unconfirmed'));
});

test('malformed or primitive history blocks append instead of discarding data', async () => {
  for (const meta of ['{broken', '42', 42, true, [null], ['not an entry']]) {
    const db = database({ initial: record({ meta }) });
    await db.login();
    await assert.rejects(db.store.appendScan('record-1', scan()), expectCode('invalid_history'));
    assert.equal(db.patches().length, 0);
    assert.deepEqual(db.row.meta, meta);
  }
});

test('duplicate is a no-op or enriches the same entry without null downgrade', async () => {
  const prior = scan({ pdfURL: 'https://reports.example.invalid/scan-1.pdf', predictionId: 'stored-prediction' });
  const wrapper = { ...entry(prior), retained: { raw: true } };
  const db = database({ initial: record({ meta: [wrapper] }) });
  await db.login();
  await db.store.appendScan('record-1', clone(prior));
  assert.equal(db.patches().length, 0);
  const older = scan({ scanId: 'older-scan' });
  db.row.meta.push(entry({ ...older, currencySymbols: { USD: '$' } }));
  await db.store.appendScan('record-1', { ...prior, currencySymbols: null });
  assert.deepEqual(db.row.meta, [wrapper, entry(older)]);
  assert.equal(db.patches().length, 1, 'Duplicate callback still cleans other scan entries');
  await db.store.appendScan('record-1', scan({ predictionId: null, pdfURL: '', retouchPredictionId: 'retouch-1' }));
  assert.deepEqual(db.row.meta, [{ ...wrapper, 'scan-metadata': { ...prior, retouchPredictionId: 'retouch-1' } }, entry(older)]);
  assert.equal(db.patches().length, 2);
});

test('simultaneous appends are serialized and read fresh history', async () => {
  const db = database();
  await db.login();
  const first = scan();
  const second = scan({ scanId: 'scan-2', predictionId: 'prediction-2' });
  await Promise.all([db.store.appendScan('record-1', first), db.store.appendScan('record-1', second)]);
  assert.deepEqual(db.row.meta, [entry(first), entry(second)]);
  assert.deepEqual(db.calls.slice(1).map(call => call.method), ['GET', 'PATCH', 'GET', 'GET', 'PATCH', 'GET']);
});

test('queued event is deep-cloned before caller mutations', async () => {
  let release;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let held = false;
  const db = database({ intercept(call) {
    if (call.method === 'GET' && !held) {
      held = true;
      signalStarted();
      return new Promise(resolve => { release = () => resolve(response({ data: record() })); });
    }
  } });
  await db.login();
  const first = db.store.appendScan('record-1', scan());
  await started;
  const metadata = scan({ scanId: 'scan-2', details: { retained: 'original' }, currencySymbols: { USD: '$' } });
  const queued = db.store.appendScan('record-1', metadata);
  metadata.scanId = 'mutated';
  metadata.details.retained = 'mutated';
  release();
  await Promise.all([first, queued]);
  assert.equal(db.row.meta[1]['scan-metadata'].scanId, 'scan-2');
  assert.deepEqual(db.row.meta[1]['scan-metadata'].details, { retained: 'original' });
  assert.equal(Object.hasOwn(db.row.meta[1]['scan-metadata'], 'currencySymbols'), false);
});

test('append GET must match resolved id and contact before a write', async () => {
  for (const changed of [record({ email: 'someone-else@example.invalid' }), record({ id: 'record-other' })]) {
    const db = database({ intercept: call => call.method === 'GET' ? response({ data: changed }) : undefined });
    await db.login();
    await assert.rejects(db.store.appendScan('record-1', scan()), expectCode('identity_mismatch'));
    assert.equal(db.patches().length, 0);
  }
});

test('readback confirms new scan and retained old history', async () => {
  const older = entry(scan({ scanId: 'older' }));
  for (const readbackHistory of [[older], [entry(scan())]]) {
    const db = database({ initial: record({ meta: [older] }), intercept(call, state) {
      if (call.method === 'GET' && state.patches().length) return response({ data: record({ meta: readbackHistory }) });
    } });
    await db.login();
    await assert.rejects(db.store.appendScan('record-1', scan()), expectCode('persistence_unconfirmed'));
  }
});

test('lost PATCH response recovers the committed scan and retries stay idempotent', async () => {
  let lost = false;
  const db = database({ intercept(call, state) {
    if (call.method === 'PATCH' && !lost) {
      lost = true;
      state.row.meta = clone(call.payload.meta);
      throw new TypeError('response lost after commit');
    }
  } });
  await db.login();
  assert.deepEqual(await db.store.appendScan('record-1', scan()), { recordId: 'record-1', scanId: 'scan-1' });
  await db.store.appendScan('record-1', scan());
  assert.deepEqual(db.row.meta, [entry(scan())]);
  assert.equal(db.patches().length, 1);
});

test('failed PATCH recovery preserves original error and does not poison the queue', async () => {
  let failPatch = true;
  let failRecovery = false;
  const db = database({ intercept(call) {
    if (call.method === 'PATCH' && failPatch) {
      failPatch = false;
      failRecovery = true;
      return response({ error: 'write failed' }, false);
    }
    if (call.method === 'GET' && failRecovery) {
      failRecovery = false;
      return response({ unexpected: 'malformed recovery result' });
    }
  } });
  await db.login();
  await assert.rejects(db.store.appendScan('record-1', scan()), expectCode('request_failed'));
  assert.deepEqual(db.row.meta, []);
  await db.store.appendScan('record-1', scan({ scanId: 'scan-2' }));
  assert.deepEqual(db.row.meta, [entry(scan({ scanId: 'scan-2' }))]);
  await db.store.appendScan('record-1', scan());
  assert.deepEqual(db.row.meta, [entry(scan({ scanId: 'scan-2' })), entry(scan())]);
});

test('paired login validates both contacts before any network access', async () => {
  const h = harness([]);
  for (const contacts of [null, {}, { email }, { phone }, { email: '', phone }, { email, phone: '' },
    { email: 'invalid-email', phone }, { email: 'user@local', phone }, { email: '.user@example.invalid', phone },
    { email: 'user..name@example.invalid', phone }, { email, phone: 'not-a-phone' },
    { email, phone: '+0123456789' }, { email, phone: '+123' }]) {
    await assert.rejects(async () => h.store.resolveContacts(contacts), expectCode('invalid_identity'));
  }
  assert.equal(h.calls.length, 0);
});

test('paired new login creates both contacts once and uses E.164 phone as SDK identity', async () => {
  const saved = record({ phone_number: phone.slice(1) });
  const h = harness([
    ...pairedLookups([], []),
    { path: '', method: 'POST', body: { data: { id: saved.id } }, check({ payload }) {
      assert.deepEqual(payload, { email, phone_number: phone.slice(1), meta: [] });
    } },
    { path: '/record-1', method: 'GET', body: { data: saved } },
  ]);
  assert.deepEqual(await h.store.resolveContacts({ email: ' Person@Example.Invalid ', phone: '+1 (202) 555-0123' }),
    { recordId: saved.id, userId: phone });
  assert.equal(h.calls.filter(call => call.path === '').length, 1);
  h.done();
});

test('paired SDK identity can explicitly use normalized email instead', async () => {
  const saved = record({ phone_number: phone.slice(1) });
  const h = harness([
    ...pairedLookups([], []),
    { path: '', method: 'POST', body: { id: saved.id } },
    { path: '/record-1', method: 'GET', body: saved },
  ], { userIdMethod: 'email' });
  assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: saved.id, userId: email });
  h.done();
});

test('paired returning login reuses one row without rewriting contacts or scans', async () => {
  for (const storedPhone of [phone, phone.slice(1)]) {
    const saved = record({ phone_number: storedPhone, meta: [entry(scan())] });
    const h = harness([
      ...pairedLookups([saved], [saved]),
      { path: '/record-1', method: 'GET', body: saved },
    ]);
    assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: saved.id, userId: phone });
    assert.equal(h.calls.filter(call => call.method === 'PATCH' || call.path === '').length, 0);
    h.done();
  }
});

test('paired login fills only missing email on a phone-only row and preserves all history', async () => {
  const history = [entry(scan()), { custom: 'retain' }];
  const original = record({ email: null, phone_number: phone.slice(1), meta: history });
  const linked = { ...original, email };
  const h = harness([
    ...pairedLookups([], [original]),
    { path: '/record-1', method: 'GET', body: original },
    { path: '/record-1', method: 'PATCH', body: { id: original.id }, check({ payload }) {
      assert.deepEqual(payload, { email });
    } },
    { path: '/record-1', method: 'GET', body: linked },
  ]);
  assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: original.id, userId: phone });
  assert.deepEqual(linked.meta, history);
  h.done();
});

test('paired login fills only missing phone on an email-only row using country-code digits', async () => {
  const original = record({ phone_number: '', meta: { old: 'keep', sessionId: email } });
  const h = harness([
    ...pairedLookups([original], []),
    { path: '/record-1', method: 'GET', body: original },
    { path: '/record-1', method: 'PATCH', body: { id: original.id }, check({ payload }) {
      assert.deepEqual(payload, { phone_number: phone.slice(1) });
    } },
    { path: '/record-1', method: 'GET', body: { ...original, phone_number: phone.slice(1) } },
  ]);
  assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: original.id, userId: phone });
  h.done();
});

test('paired contact match on separate rows is refused without merging or mutation', async () => {
  const byEmail = record();
  const byPhone = record({ id: 'record-2', email: null, phone_number: phone.slice(1) });
  const h = harness(pairedLookups([byEmail], [byPhone]));
  await assert.rejects(h.store.resolveContacts({ email, phone }), expectCode('contact_conflict'));
  assert.equal(h.calls.length, 2);
  h.done();
});

test('paired login cannot overwrite an existing different email or phone', async () => {
  for (const [emailRows, phoneRows, current] of [
    [[], [record({ email: 'someone-else@example.invalid', phone_number: phone.slice(1) })], record({ email: 'someone-else@example.invalid', phone_number: phone.slice(1) })],
    [[record({ phone_number: '12025550999' })], [], record({ phone_number: '12025550999' })],
  ]) {
    const h = harness([
      ...pairedLookups(emailRows, phoneRows),
      { path: '/record-1', method: 'GET', body: current },
    ]);
    await assert.rejects(h.store.resolveContacts({ email, phone }), expectCode('contact_conflict'));
    assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 0);
    h.done();
  }
});

test('fresh read catches a conflicting contact added after lookup', async () => {
  const original = record({ email: null, phone_number: phone.slice(1) });
  const h = harness([
    ...pairedLookups([], [original]),
    { path: '/record-1', method: 'GET', body: { ...original, email: 'concurrent@example.invalid' } },
  ]);
  await assert.rejects(h.store.resolveContacts({ email, phone }), expectCode('contact_conflict'));
  h.done();
});

test('paired lookup errors or duplicates cannot be interpreted as no matching user', async () => {
  for (const duplicate of [false, true]) {
    const steps = pairedLookups([], []);
    steps[1] = duplicate
      ? { path: '/list', method: 'POST', body: list([record({ phone_number: phone }), record({ id: 'record-2', phone_number: phone.slice(1) })]) }
      : { path: '/list', method: 'POST', ok: false, body: { error: 'unavailable' } };
    const h = harness(steps);
    await assert.rejects(h.store.resolveContacts({ email, phone }), expectCode(duplicate ? 'duplicate_identity' : 'request_failed'));
    assert.equal(h.calls.length, 2);
    h.done();
  }
});

test('paired concurrent submissions for the normalized pair share one operation', async () => {
  let release;
  const saved = record({ phone_number: phone.slice(1) });
  const steps = pairedLookups([saved], [saved]);
  steps[0].handler = () => new Promise(resolve => { release = () => resolve(response(list([saved]))); });
  const h = harness([...steps, { path: '/record-1', method: 'GET', body: saved }]);
  const first = h.store.resolveContacts({ email, phone });
  const second = h.store.resolveContacts({ email: ' PERSON@EXAMPLE.INVALID ', phone: '+1 (202) 555-0123' });
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { recordId: saved.id, userId: phone });
  h.done();
});

test('lost paired create response recovers the existing row without another create', async () => {
  const saved = record({ phone_number: phone.slice(1) });
  const h = harness([
    ...pairedLookups([], []),
    { path: '', method: 'POST', error: new TypeError('response lost') },
    ...pairedLookups([saved], [saved]),
    { path: '/record-1', method: 'GET', body: saved },
  ]);
  assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: saved.id, userId: phone });
  assert.equal(h.calls.filter(call => call.path === '').length, 1);
  h.done();
});

test('lost contact-link PATCH response reads back both contacts without repeating the write', async () => {
  const original = record({ email: null, phone_number: phone.slice(1), meta: [entry(scan())] });
  const h = harness([
    ...pairedLookups([], [original]),
    { path: '/record-1', method: 'GET', body: original },
    { path: '/record-1', method: 'PATCH', error: new TypeError('response lost'), check({ payload }) {
      assert.deepEqual(payload, { email });
    } },
    { path: '/record-1', method: 'GET', body: { ...original, email } },
  ]);
  assert.deepEqual(await h.store.resolveContacts({ email, phone }), { recordId: original.id, userId: phone });
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
  h.done();
});

test('unconfirmed contact link does not bind a row for scan writes', async () => {
  const original = record({ email: null, phone_number: phone.slice(1) });
  const h = harness([
    ...pairedLookups([], [original]),
    { path: '/record-1', method: 'GET', body: original },
    { path: '/record-1', method: 'PATCH', body: { id: original.id } },
    { path: '/record-1', method: 'GET', body: original },
    { path: '/record-1', method: 'GET', body: original },
  ]);
  await assert.rejects(h.store.resolveContacts({ email, phone }), expectCode('identity_mismatch'));
  await assert.rejects(h.store.appendScan(original.id, scan()), expectCode('unknown_record'));
  h.done();
});

test('paired binding checks both contacts on every later scan save', async () => {
  for (const changed of [{ email: 'someone-else@example.invalid' }, { phone_number: '12025550999' }]) {
    const saved = record({ phone_number: phone.slice(1), meta: [entry(scan())] });
    const h = harness([
      ...pairedLookups([saved], [saved]),
      { path: '/record-1', method: 'GET', body: saved },
      { path: '/record-1', method: 'GET', body: { ...saved, ...changed } },
    ]);
    await h.store.resolveContacts({ email, phone });
    await assert.rejects(h.store.appendScan(saved.id, scan({ scanId: 'new-scan' })), expectCode('identity_mismatch'));
    h.done();
  }
});

test('paired user scan append retains previous history and keeps both contact columns untouched', async () => {
  const prior = entry(scan({ scanId: 'older' }));
  const saved = record({ phone_number: phone.slice(1), meta: [prior] });
  const db = database({ initial: saved });
  assert.deepEqual(await db.store.resolveContacts({ email, phone }), { recordId: saved.id, userId: phone });
  await db.store.appendScan(saved.id, scan());
  assert.deepEqual(db.row.meta, [prior, entry(scan())]);
  assert.equal(db.row.email, email);
  assert.equal(db.row.phone_number, phone.slice(1));
  assert.deepEqual(Object.keys(db.patches()[0].payload), ['meta']);
});
