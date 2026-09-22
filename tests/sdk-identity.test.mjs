import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inlineScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*import .*?;\s*$/gm, '');
const phone = '+12025550123';

// Exercise the actual page submit handler without live SDK/Boltic requests.
async function initialize(appId, identity = phone) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, style: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute() {}, removeAttribute() {}, focus() {},
    });
    return elements.get(id);
  };
  const contacts = { email: 'person@example.invalid', phone };
  const loginRecord = Object.freeze({ recordId: 'record-1', userId: identity });
  const calls = { init: [], resolved: [] };
  const sdk = {
    init(target, key, config) { calls.init.push({ target, config }); },
    addEventListener() {},
  };
  runInNewContext(inlineScript.replace(/const appId = "[^"]+";/, `const appId = ${JSON.stringify(appId)};`), {
    document: { getElementById: element, querySelector: element },
    window: { GlamAR: sdk, addEventListener() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    createContactForm: () => ({ validate: () => contacts, closeCountryPicker() {} }),
    createLoginRecordStore: options => {
      calls.storeOptions = options;
      return { async resolveContacts(value) { calls.resolved.push(value); return loginRecord; } };
    },
    createScanHistoryWriter: options => { calls.writerOptions = options; return {}; },
  });
  await element('loginForm').listeners.submit({ preventDefault() {} });
  assert.equal(calls.init.length, 1, 'SDK initializes successfully once');
  assert.equal(calls.storeOptions.userIdMethod, 'phone');
  assert.deepEqual(calls.resolved, [contacts], 'Contact lookup receives unchanged contact values');
  assert.equal(loginRecord.userId, identity, 'Stored identity is not modified');
  assert.equal(calls.writerOptions.recordId, loginRecord.recordId);
  assert.equal(calls.writerOptions.appId, appId, 'Scan history remains scoped to the configured app');
  return JSON.parse(JSON.stringify(calls.init[0].config));
}

test('SDK init scopes the normalized phone to the app without changing other options', async () => {
  assert.deepEqual(await initialize('app-a'), {
    platform: 'web', mode: 'private', category: 'skinanalysis',
    configuration: { skinAnalysis: { appId: 'app-a', userId: `app-a:${phone}` } },
    meta: { sdkVersion: '2.0.0' },
  });
});

test('the same phone produces different SDK identities for different apps', async () => {
  const a = await initialize('app-a');
  const b = await initialize('app-b');
  assert.equal(b.configuration.skinAnalysis.userId, `app-b:${phone}`);
  assert.notEqual(a.configuration.skinAnalysis.userId, b.configuration.skinAnalysis.userId);
});

test('returning users retain the same app-scoped SDK identity', async () => {
  assert.deepEqual(await initialize('app-a'), await initialize('app-a'));
});

test('namespacing preserves whatever canonical identity the contact store returns', async () => {
  const config = await initialize('app-a', 'person@example.invalid');
  assert.equal(config.configuration.skinAnalysis.userId, 'app-a:person@example.invalid');
});
