import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginRecordStore, LoginRecordError, normalizeLoginIdentity } from '../src/login-records.mjs';

const recordsUrl = 'https://records.example.invalid/tables/poc/records';
const appId = 'test-app';
const email = 'person@example.invalid';
const phone = '+12025550123';
const record = (overrides = {}) => ({ id: 'record-1', email, phone_number: '', user_name: '', meta: { sessionId: email, glamAppId: appId }, ...overrides });
const list = rows => ({ data: rows, pagination: { total_count: rows.length, total_pages: rows.length ? 1 : 0, current_page: 1, per_page: 2, type: 'page' } });
const expectCode = code => error => error instanceof LoginRecordError && error.code === code;

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

test('new email login filters first, creates once, then reads persisted session back', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'email', operator: '=', values: [email] }]);
      assert.deepEqual(payload.page, { page_no: 1, page_size: 2 });
    } },
    { path: '', method: 'POST', body: { data: { id: 'record-1' } }, check({ payload, init }) {
      assert.deepEqual(payload, { email, phone_number: '', user_name: '', meta: { sessionId: email, glamAppId: appId } });
      assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.mode, 'cors');
    } },
    { path: '/record-1', method: 'GET', body: { data: record({ meta: { sessionId: 'stored-session' } }) } },
  ]);
  assert.deepEqual(await h.store.resolve('email', ' Person@Example.Invalid '), { recordId: 'record-1', sessionId: 'stored-session' });
  h.done();
});

test('new phone login stores canonical phone and uses phone_number filter', async () => {
  const saved = record({ email: '', phone_number: phone, meta: { sessionId: phone } });
  const h = harness([
    { path: '/list', method: 'POST', body: list([]), check({ payload }) {
      assert.deepEqual(payload.filters, [{ field: 'phone_number', operator: 'IN', values: [phone, phone.slice(1)] }]);
    } },
    { path: '', method: 'POST', body: { id: 'record-1' }, check({ payload }) {
      assert.equal(payload.phone_number, phone);
      assert.equal(payload.email, '');
      assert.equal(payload.meta.sessionId, phone);
    } },
    { path: '/record-1', method: 'GET', body: saved },
  ]);
  assert.deepEqual(await h.store.resolve('phone', '+1 (202) 555-0123'), { recordId: 'record-1', sessionId: phone });
  h.done();
});

test('returning users across independent stores reuse persisted session without writes', async () => {
  const existing = record({ meta: { sessionId: 'historical-session', skinAnalysisResult: { score: 42 } } });
  for (const body of [list([existing]), { items: [existing], total: 1 }]) {
    const h = harness([{ path: '/list', method: 'POST', body }]);
    assert.deepEqual(await h.store.resolve('email', email), { recordId: existing.id, sessionId: 'historical-session' });
    assert.equal(h.calls.length, 1);
    h.done();
  }
});

test('legacy country-code phone without plus reuses its stored record and session', async () => {
  const existing = record({ email: '', phone_number: phone.slice(1), meta: { sessionId: 'legacy-phone-session' } });
  const h = harness([{ path: '/list', method: 'POST', body: list([existing]), check({ payload }) {
    assert.deepEqual(payload.filters, [{ field: 'phone_number', operator: 'IN', values: [phone, phone.slice(1)] }]);
  } }]);
  assert.deepEqual(await h.store.resolve('phone', '+1 (202) 555-0123'), { recordId: 'record-1', sessionId: 'legacy-phone-session' });
  assert.equal(h.calls.length, 1);
  h.done();
});

test('legacy digits-only phone lacking a session receives canonical session without changing contact', async () => {
  const oldMeta = { skinAnalysisResult: { score: 42 } };
  const legacy = record({ email: '', phone_number: phone.slice(1), meta: oldMeta });
  const h = harness([
    { path: '/list', method: 'POST', body: list([legacy]) },
    { path: '/record-1', method: 'PATCH', body: { id: 'record-1' }, check({ payload }) {
      assert.deepEqual(payload, { meta: { ...oldMeta, sessionId: phone, glamAppId: appId } });
    } },
    { path: '/record-1', method: 'GET', body: { ...legacy, meta: { ...oldMeta, sessionId: phone, glamAppId: appId } } },
  ]);
  assert.deepEqual(await h.store.resolve('phone', phone), { recordId: 'record-1', sessionId: phone });
  h.done();
});

test('separate canonical and digits-only phone records are an ambiguous identity', async () => {
  const first = record({ email: '', phone_number: phone, meta: { sessionId: phone } });
  const second = record({ id: 'record-2', email: '', phone_number: phone.slice(1), meta: { sessionId: 'legacy-phone-session' } });
  const h = harness([{ path: '/list', method: 'POST', body: list([first, second]) }]);
  await assert.rejects(h.store.resolve('phone', phone), expectCode('duplicate_identity'));
  assert.equal(h.calls.length, 1);
  h.done();
});

test('legacy record gains session while preserving all prior metadata and app association', async () => {
  const legacyMeta = { glamAppId: 'original-app', skinAnalysisResult: { score: 42 }, 'scan-metadata': { scan: 'old-scan' } };
  const existing = record({ meta: JSON.stringify(legacyMeta) });
  const h = harness([
    { path: '/list', method: 'POST', body: list([existing]) },
    { path: '/record-1', method: 'PATCH', body: { id: 'record-1' }, check({ payload }) {
      assert.deepEqual(payload, { meta: { ...legacyMeta, sessionId: email } });
    } },
    { path: '/record-1', method: 'GET', body: record({ meta: { ...legacyMeta, sessionId: email } }) },
  ]);
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', sessionId: email });
  h.done();
});

test('legacy metadata absence is initialized and update must be confirmed by readback', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([record({ meta: null })]) },
    { path: '/record-1', method: 'PATCH', body: { id: 'record-1' }, check({ payload }) {
      assert.deepEqual(payload, { meta: { sessionId: email, glamAppId: appId } });
    } },
    { path: '/record-1', method: 'GET', body: record({ meta: {} }) },
  ]);
  await assert.rejects(h.store.resolve('email', email), expectCode('invalid_response'));
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

test('invalid metadata or stored session never leaks an unusable session to SDK', async () => {
  for (const meta of ['{broken', [], '[]', { sessionId: 42 }, { sessionId: '   ' }, { sessionId: 'x'.repeat(255) }]) {
    const h = harness([{ path: '/list', method: 'POST', body: list([record({ meta })]) }]);
    await assert.rejects(h.store.resolve('email', email), expectCode('invalid_response'));
    h.done();
  }
});

test('lost create response recovers committed record without a second create', async () => {
  const h = harness([
    { path: '/list', method: 'POST', body: list([]) },
    { path: '', method: 'POST', error: new TypeError('response lost after commit') },
    { path: '/list', method: 'POST', body: list([record()]) },
  ]);
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', sessionId: email });
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
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', sessionId: email });
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
  assert.deepEqual(await first, { recordId: 'record-1', sessionId: email });
  h.done();
});

test('failure clears in-flight state so a later explicit retry performs a fresh lookup', async () => {
  const h = harness([
    { path: '/list', method: 'POST', ok: false, body: {} },
    { path: '/list', method: 'POST', body: list([record()]) },
  ]);
  await assert.rejects(h.store.resolve('email', email), expectCode('request_failed'));
  assert.deepEqual(await h.store.resolve('email', email), { recordId: 'record-1', sessionId: email });
  h.done();
});
