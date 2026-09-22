import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEmail, validatePhone, phoneEditError } from '../src/contact-form.mjs';

// Evaluate the checked-in trusted UMD bundle in this realm. Passing options to a
// different VM realm would exercise the bundle's object detection incorrectly.
const api = {};
const source = readFileSync(new URL('../vendor/libphonenumber/libphonenumber-max.js', import.meta.url), 'utf8');
Function('exports', 'module', source)(api, { exports: api });

test('email is required and normalized consistently', () => {
  for (const input of ['', '   ', '\t\n']) assert.throws(() => validateEmail(input), Error, JSON.stringify(input));
  assert.equal(validateEmail(' Person@Example.COM '), 'person@example.com');
  assert.equal(validateEmail(' Some.One+Tag@Example.CO.UK '), 'some.one+tag@example.co.uk');
  assert.equal(validateEmail("O'Hara@example.com"), "o'hara@example.com");
});

test('email accepts corporate domains and unquoted local punctuation without rewriting identity', () => {
  for (const [input, canonical] of [
    ['First.Last+Campaign@SALES.Example.Technology', 'first.last+campaign@sales.example.technology'],
    ['Support_Team-2@North-West.Example.CO.UK', 'support_team-2@north-west.example.co.uk'],
    ["O'Hara+Sales@Example.COM", "o'hara+sales@example.com"],
    ["!#$%&'*+-/=?^_`{|}~.Tag@example.com", "!#$%&'*+-/=?^_`{|}~.tag@example.com"],
    ['a@b.cd', 'a@b.cd'],
  ]) assert.equal(validateEmail(input), canonical, input);
  assert.notEqual(validateEmail('person+tag@example.com'), validateEmail('person@example.com'));
  assert.notEqual(validateEmail('some.one@example.com'), validateEmail('someone@example.com'));
});

test('email canonicalizes IDN domains while retaining the normalized ASCII local identity', () => {
  for (const [input, canonical] of [
    ['Person+Tag@BÜCHER.DE', 'person+tag@xn--bcher-kva.de'],
    ['Person+Tag@BU\u0308CHER.DE', 'person+tag@xn--bcher-kva.de'],
    ['Person+Tag@XN--BCHER-KVA.DE', 'person+tag@xn--bcher-kva.de'],
    ['person@пример.рф', 'person@xn--e1afmkfd.xn--p1ai'],
    ['person@xn--e1afmkfd.xn--p1ai', 'person@xn--e1afmkfd.xn--p1ai'],
    ['person@例子.公司', 'person@xn--fsqu00a.xn--55qx5d'],
  ]) assert.equal(validateEmail(input), canonical, input);
});

test('email rejects malformed local and domain syntax', () => {
  for (const input of [
    'person', 'a@b', '@example.com', 'a@', 'a@@example.com', 'a b@example.com',
    '.person@example.com', 'person.@example.com', 'per..son@example.com',
    'person@-example.com', 'person@example-.com', 'person@example..com',
    'person@exam_ple.com', 'person@example.com.', 'person@.example.com',
    'person@example .com', 'person@exam ple.com',
    'Name <person@example.com>', 'person@example.com,other@example.com',
    'person@example.com;other@example.com', 'mailto:person@example.com',
    'person@example.com/path', 'person@example.com?query', 'person@example.com#fragment',
    'person@example.com:443', 'person@example%2ecom', 'person@example\\.com',
    '"person"@example.com', 'josé@example.com',
  ]) assert.throws(() => validateEmail(input), Error, JSON.stringify(input));
});

test('email rejects numeric, mixed, single-letter TLDs and IP address hosts', () => {
  for (const input of [
    'person@example.c', 'person@example.1', 'person@example.123',
    'person@example.c0m', 'person@example.co-m', 'person@example.123abc',
    'person@127.0.0.1', 'person@999.999.999.999',
    'person@[127.0.0.1]', 'person@[IPv6:2001:db8::1]',
  ]) assert.throws(() => validateEmail(input), Error, input);
});

test('email rejects malformed IDN encodings and nonletter international domain symbols', () => {
  for (const input of [
    'person@xn--a.com', 'person@xn--0.com', 'person@xn--.com',
    'person@example.xn--a', 'person@example.xn--0', 'person@example.xn--',
    'person@😀.com', 'person@example.😀',
  ]) assert.throws(() => validateEmail(input), Error, input);
});

test('email rejects embedded control and invisible characters instead of changing the identity', () => {
  for (const character of ['\r', '\n', '\t', '\u0000', '\u007f', '\u034f', '\u180b', '\u200b', '\u200d', '\u202e', '\u2060', '\ufe0f', '\ufeff']) {
    for (const input of [`per${character}son@example.com`, `person@exam${character}ple.com`]) {
      assert.throws(() => validateEmail(input), Error, JSON.stringify(input));
    }
  }
  assert.throws(() => validateEmail('per\r\nson@example.com'), Error);
});

test('email local-part limit accepts exactly 64 characters and rejects 65', () => {
  const valid = `${'a'.repeat(64)}@example.com`;
  assert.equal(validateEmail(valid), valid);
  assert.throws(() => validateEmail(`${'a'.repeat(65)}@example.com`), Error);
});

test('email domain-label limit accepts exactly 63 ASCII characters and rejects 64', () => {
  const valid = `a@${'b'.repeat(63)}.com`;
  assert.equal(validateEmail(valid), valid);
  assert.throws(() => validateEmail(`a@${'b'.repeat(64)}.com`), Error);
});

test('email applies domain-label length limits after IDN conversion', () => {
  const unicodeLabel = 'ü'.repeat(57);
  const asciiLabel = `xn--td${'a'.repeat(57)}`;
  assert.equal(asciiLabel.length, 63);
  assert.equal(validateEmail(`a@${unicodeLabel}.com`), `a@${asciiLabel}.com`);
  assert.throws(() => validateEmail(`a@${'ü'.repeat(58)}.com`), Error);
});

test('email total limit accepts 254 characters and rejects 255 without truncation', () => {
  const prefix = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.`;
  const valid = prefix + 'd'.repeat(61);
  const tooLong = prefix + 'd'.repeat(62);
  assert.equal(valid.length, 254);
  assert.equal(tooLong.length, 255);
  assert.equal(validateEmail(valid), valid);
  assert.throws(() => validateEmail(tooLong), Error);
  assert.throws(() => validateEmail('a'.repeat(10000) + '@example.com'), Error);
});

test('email total length is checked again after IDN expansion', () => {
  const local = 'a'.repeat(64);
  const unicodeDomainPrefix = `${'ü'.repeat(57)}.${'b'.repeat(63)}.`;
  const asciiDomainPrefix = `xn--td${'a'.repeat(57)}.${'b'.repeat(63)}.`;
  const valid = `${local}@${unicodeDomainPrefix}${'c'.repeat(61)}`;
  const canonical = `${local}@${asciiDomainPrefix}${'c'.repeat(61)}`;
  const tooLong = `${local}@${unicodeDomainPrefix}${'c'.repeat(62)}`;
  assert.equal(canonical.length, 254);
  assert.ok(tooLong.length < 254, 'raw Unicode input alone does not expose the encoded length limit');
  assert.equal(validateEmail(valid), canonical);
  assert.throws(() => validateEmail(tooLong), Error);
});

test('normalizes supported national, trunk, and international phone formats', () => {
  const cases = [
    ['GB', '020 7946 0018', '+442079460018'],
    ['GB', '+44 (0)20 7946 0018', '+442079460018'],
    ['GB', '00442079460018', '+442079460018'],
    ['IN', '98765 43210', '+919876543210'],
    ['IN', '09876543210', '+919876543210'],
    ['IN', '+91 98765 43210', '+919876543210'],
    ['US', '(202) 555-0123', '+12025550123'],
    ['US', '1 (202) 555-0123', '+12025550123'],
    ['US', '+1 202 555 0123', '+12025550123'],
    ['DE', '030 123456', '+4930123456'],
    ['DE', '+49 (0) 30 123456', '+4930123456'],
    ['BR', '(11) 98765-4321', '+5511987654321'],
    ['BR', '02111987654321', '+5511987654321'],
  ];
  for (const [country, input, canonical] of cases) {
    assert.equal(phoneEditError(input, country, api), '', `${country}: ${input}`);
    assert.equal(validatePhone(input, country, api), canonical, `${country}: ${input}`);
  }
});

test('accepts Brazil carrier/international prefixes exceeding fifteen raw digits without truncation', () => {
  const input = '00215511987654321';
  const parsed = api.parsePhoneNumberFromString(input, { defaultCountry: 'BR', extract: false });
  assert.equal(parsed.isValid(), true, 'the actual pinned metadata supports this representation');
  assert.equal(parsed.number, '+5511987654321');
  assert.equal(api.validatePhoneNumberLength(input, 'BR'), undefined);
  assert.equal(phoneEditError(input, 'BR', api), '');
  assert.equal(validatePhone(input, 'BR', api), '+5511987654321');
});

test('edit guard prevents overlong numbers according to country and prefix rules', () => {
  for (const [country, input] of [
    ['US', '20255501239'], ['US', '120255501239'],
    ['GB', '020794600189'], ['GB', '+44 (0)20 7946 00189'],
    ['IN', '98765432109999'], ['IN', '+9198765432109999'],
    ['DE', '987654321098765432109'],
  ]) {
    assert.match(phoneEditError(input, country, api), /too long/, `${country}: ${input}`);
    assert.throws(() => validatePhone(input, country, api), /too long/, `${country}: ${input}`);
  }
});

test('country-aware length checks allow partial input without declaring it valid', () => {
  for (const input of ['', '+', '2', '20', '202']) assert.equal(phoneEditError(input, 'US', api), '');
  assert.throws(() => validatePhone('', 'US', api), /Enter your phone number/);
  assert.throws(() => validatePhone('202', 'US', api), /too short/);
  // Indian metadata includes phone types longer than a ten-digit mobile number.
  // Length acceptance must not be mistaken for full number validation.
  assert.equal(api.validatePhoneNumberLength('98765432109', 'IN'), undefined);
  assert.equal(phoneEditError('98765432109', 'IN', api), '');
  assert.throws(() => validatePhone('98765432109', 'IN', api), /Enter a valid phone number/);
});

test('selected country must match pasted international numbers including shared calling codes', () => {
  for (const [country, input] of [
    ['IN', '+1 202 555 0123'], ['US', '+91 98765 43210'],
    ['GB', '+49 30 123456'], ['US', '+1 416 555 0123'],
  ]) assert.throws(() => validatePhone(input, country, api), /Choose the country that matches/, `${country}: ${input}`);
  assert.equal(validatePhone('+1 416 555 0123', 'CA', api), '+14165550123');
});

test('rejects invalid characters and extensions instead of extracting a different valid phone', () => {
  for (const input of [
    'Call 2025550123', '2025550123 ext 9', '2025550123x9',
    '2025550123;ext=9', '++12025550123', '202+5550123', '202/555/0123',
  ]) {
    assert.match(phoneEditError(input, 'US', api), /Use numbers only/, input);
    assert.throws(() => validatePhone(input, 'US', api), /Use numbers only/, input);
  }
});

test('oversized input is rejected without returning a shortened valid number', () => {
  for (const input of ['202555012399999999999999999', '9'.repeat(10000), '+' + '9'.repeat(10000)]) {
    assert.match(phoneEditError(input, 'US', api), /too long/);
    assert.throws(() => validatePhone(input, 'US', api), /too long/);
  }
});

test('missing phone library and unknown country fail closed', () => {
  for (const unavailableApi of [undefined, null, {}, { getCountries: () => ['US'] }]) {
    assert.throws(() => validatePhone('2025550123', 'US', unavailableApi), /Phone validation could not load/);
  }
  assert.throws(() => validatePhone('2025550123', 'XX', api), /Choose your country code/);
});


test('international domain labels cannot start or end in hyphens', () => {
  for (const value of ['person@-bücher.de', 'person@bücher-.de']) {
    assert.throws(() => validateEmail(value), Error);
  }
});
