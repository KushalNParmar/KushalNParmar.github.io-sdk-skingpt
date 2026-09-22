// Boltic remains the source of truth; no contact details are cached in browser storage.
export class LoginRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = "LoginRecordError";
    this.code = code;
  }
}

export function normalizeLoginIdentity(method, value) {
  if (!["email", "phone"].includes(method) || typeof value !== "string" || !value.trim()) {
    throw new LoginRecordError("invalid_identity");
  }
  let normalized = value.trim();
  if (method === "email") normalized = normalized.toLowerCase();
  else {
    normalized = normalized.replace(/[\s()-]/g, "");
    // Boltic stores country-code digits; the SDK identity retains its leading +.
    if (/^[1-9][0-9]{6,14}$/.test(normalized)) normalized = "+" + normalized;
  }
  return { method, value: normalized };
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function storedMetadata(record) {
  let meta = record.meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); }
    catch { throw new LoginRecordError("invalid_history"); }
  }
  return meta;
}

function scanHistory(record) {
  const meta = storedMetadata(record);
  if (meta == null) return [];
  if (Array.isArray(meta)) {
    if (!meta.every(isObject)) throw new LoginRecordError("invalid_history");
    return meta;
  }
  if (!isObject(meta)) throw new LoginRecordError("invalid_history");
  // Previous POC logins stored these redundant identity fields in meta.
  // Keep any historical scan/result or unknown metadata when converting it.
  const { sessionId, glamAppId, ...legacy } = meta;
  return Object.keys(legacy).length ? [legacy] : [];
}

function recordId(record) {
  if (typeof record?.id !== "string" || !record.id.trim()) throw new LoginRecordError("invalid_response");
  return record.id;
}

const nonemptyString = value => typeof value === "string" && !!value.trim();
const sameScan = (a, b) => isObject(a) && isObject(b) &&
  nonemptyString(a.appId) && nonemptyString(a.scanId) && a.appId === b.appId && a.scanId === b.scanId;

function withoutCurrencySymbols(metadata) {
  const { currencySymbols, ...scan } = metadata;
  return scan;
}

const hasCurrencySymbols = entry => isObject(entry?.["scan-metadata"]) &&
  Object.hasOwn(entry["scan-metadata"], "currencySymbols");

export function validateScanMetadata(value, appId) {
  if (!isObject(value) || !nonemptyString(value.appId) || !nonemptyString(value.scanId) ||
      value.appId !== appId) throw new LoginRecordError("invalid_scan_metadata");
  try { return JSON.parse(JSON.stringify(withoutCurrencySymbols(value))); }
  catch { throw new LoginRecordError("invalid_scan_metadata"); }
}

export function mergeScanMetadata(previous, incoming) {
  const merged = withoutCurrencySymbols(previous);
  for (const [key, value] of Object.entries(withoutCurrencySymbols(incoming))) {
    // A repeated event must not erase a PDF/ID already saved by a richer event.
    if (value != null && value !== "" || merged[key] == null || merged[key] === "") merged[key] = value;
  }
  return merged;
}

function includesData(actual, expected) {
  if (expected === null) return actual !== undefined;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value, index) => includesData(actual[index], value));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(actual, key) && includesData(actual[key], value));
  return actual === expected;
}

function historySaved(record, expected) {
  const actual = storedMetadata(record);
  // Structural comparison also preserves older entries without modern scan IDs.
  // Confirm the stored column itself is now an array, not just convertible to one.
  return Array.isArray(actual) && !actual.some(hasCurrencySymbols) &&
    expected.every(entry => actual.some(saved => includesData(saved, entry)));
}

export function createLoginRecordStore({ recordsUrl, appId, fetchImpl = globalThis.fetch, timeoutMs = 15000, userIdMethod = "phone" }) {
  if (!["email", "phone"].includes(userIdMethod)) throw new LoginRecordError("invalid_identity");
  const baseUrl = recordsUrl.replace(/\/$/, "");
  const inFlight = new Map();
  const linkedRecords = new Map();
  const writes = new Map();

  async function request(path, method, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(baseUrl + path, {
        method,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!response.ok) throw new LoginRecordError("request_failed");
      const body = await response.json();
      if (!isObject(body) || body.error || body.success === false) throw new LoginRecordError("invalid_response");
      return body;
    } catch (error) {
      if (error instanceof LoginRecordError) throw error;
      throw new LoginRecordError("request_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  function assertIdentity(record, identity) {
    if (Array.isArray(identity)) {
      for (const contact of identity) assertIdentity(record, contact);
      return record;
    }
    recordId(record);
    const field = identity.method === "email" ? "email" : "phone_number";
    if (typeof record[field] !== "string" || normalizeLoginIdentity(identity.method, record[field]).value !== identity.value) {
      throw new LoginRecordError("identity_mismatch");
    }
    return record;
  }

  function unpackRecord(body) {
    const record = isObject(body.data) ? body.data : body;
    recordId(record);
    return record;
  }

  async function lookup(identity) {
    const field = identity.method === "email" ? "email" : "phone_number";
    const body = await request("/list", "POST", {
      page: { page_no: 1, page_size: 2 },
      sort: [{ field: "created_at", direction: "asc" }],
      filters: [{
        field,
        operator: identity.method === "phone" ? "IN" : "=",
        values: identity.method === "phone" ? [identity.value, identity.value.slice(1)] : [identity.value],
      }],
      fields: ["id", "email", "phone_number", "meta"],
    });
    // Live API returns data; the proxy's checked-in contract also allows items.
    const rows = Array.isArray(body.data) ? body.data : body.items;
    if (!Array.isArray(rows)) throw new LoginRecordError("invalid_response");
    const total = body.pagination?.total_count ?? body.total ?? rows.length;
    if (!Number.isInteger(total) || total < rows.length) throw new LoginRecordError("invalid_response");
    if (total > 1 || rows.length > 1) throw new LoginRecordError("duplicate_identity");
    if (total !== rows.length) throw new LoginRecordError("invalid_response");
    return rows.length ? assertIdentity(rows[0], identity) : null;
  }

  function linkExisting(record, identity) {
    const id = recordId(record);
    linkedRecords.set(id, identity);
    return { recordId: id, userId: identity.value };
  }

  async function resolveIdentity(identity) {
    const existing = await lookup(identity);
    if (existing) return linkExisting(existing, identity);

    const payload = {
      // Boltic requires both contact keys; nullable fields use explicit null.
      email: identity.method === "email" ? identity.value : null,
      // Boltic's Phone Number display adds +; store country-code digits only.
      phone_number: identity.method === "phone" ? identity.value.slice(1) : null,
      meta: [],
    };
    try {
      const created = unpackRecord(await request("", "POST", payload));
      // Confirm the saved identity before initializing the SDK.
      const saved = await readRecord(recordId(created), identity);
      return await linkExisting(saved, identity);
    } catch (error) {
      // A write may have committed even if the response was lost. Re-query;
      // never issue a second create blindly within the same login attempt.
      let recovered;
      try { recovered = await lookup(identity); }
      catch { throw error; }
      if (recovered) return linkExisting(recovered, identity);
      throw error;
    }
  }

  function normalizeContacts(contacts) {
    if (!isObject(contacts)) throw new LoginRecordError("invalid_identity");
    const email = normalizeLoginIdentity("email", contacts.email);
    const phone = normalizeLoginIdentity("phone", contacts.phone);
    const [local, domain, extra] = email.value.split("@");
    const validDomain = domain && domain.includes(".") && domain.split(".").every(
      label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    if (email.value.length > 254 || !local || local.length > 64 || extra !== undefined ||
        /\s/.test(email.value) || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
        !validDomain || !/^\+[1-9][0-9]{6,14}$/.test(phone.value)) {
      throw new LoginRecordError("invalid_identity");
    }
    return [email, phone];
  }

  async function lookupContacts(contacts) {
    const matches = await Promise.all(contacts.map(lookup));
    if (matches[0] && matches[1] && recordId(matches[0]) !== recordId(matches[1])) {
      throw new LoginRecordError("contact_conflict");
    }
    return matches;
  }

  function bindContacts(record, contacts) {
    assertIdentity(record, contacts);
    const id = recordId(record);
    linkedRecords.set(id, contacts);
    return { recordId: id, userId: contacts.find(contact => contact.method === userIdMethod).value };
  }

  async function linkContacts(matches, contacts) {
    const matchedIndex = matches[0] ? 0 : 1;
    const id = recordId(matches[matchedIndex]);
    // Read fresh data before linking: never replace an existing different contact.
    const current = await readRecord(id, contacts[matchedIndex]);
    const patch = {};
    for (const contact of contacts) {
      const field = contact.method === "email" ? "email" : "phone_number";
      const value = current[field];
      if (value == null || typeof value === "string" && !value.trim()) {
        patch[field] = contact.method === "phone" ? contact.value.slice(1) : contact.value;
      } else if (typeof value !== "string" || normalizeLoginIdentity(contact.method, value).value !== contact.value) {
        throw new LoginRecordError("contact_conflict");
      }
    }
    if (!Object.keys(patch).length) return bindContacts(current, contacts);
    try {
      // Contact linking must not replace scan history or any other record fields.
      await request("/" + encodeURIComponent(id), "PATCH", patch);
      return bindContacts(await readRecord(id, contacts), contacts);
    } catch (error) {
      // A committed PATCH can lose its response. Read back, never blindly repeat it.
      try { return bindContacts(await readRecord(id, contacts), contacts); }
      catch { throw error; }
    }
  }

  async function resolveContacts(contacts) {
    const matches = await lookupContacts(contacts);
    if (matches.some(Boolean)) return linkContacts(matches, contacts);
    const payload = { email: contacts[0].value, phone_number: contacts[1].value.slice(1), meta: [] };
    try {
      const created = unpackRecord(await request("", "POST", payload));
      return bindContacts(await readRecord(recordId(created), contacts), contacts);
    } catch (error) {
      let recovered;
      try { recovered = await lookupContacts(contacts); }
      catch (recoveryError) {
        if (recoveryError.code === "contact_conflict" || recoveryError.code === "duplicate_identity") throw recoveryError;
        throw error;
      }
      if (recovered.some(Boolean)) return linkContacts(recovered, contacts);
      throw error;
    }
  }

  async function readRecord(id, identity) {
    const saved = assertIdentity(unpackRecord(await request("/" + encodeURIComponent(id), "GET")), identity);
    if (recordId(saved) !== id) throw new LoginRecordError("identity_mismatch");
    return saved;
  }

  async function appendScan(id, identity, incoming) {
    const saved = await readRecord(id, identity);
    const storedHistory = scanHistory(saved);
    const needsCleanup = storedHistory.some(hasCurrencySymbols);
    const history = storedHistory.map(entry => isObject(entry["scan-metadata"])
      ? { ...entry, "scan-metadata": withoutCurrencySymbols(entry["scan-metadata"]) }
      : entry);
    const index = history.findIndex(entry => sameScan(entry["scan-metadata"], incoming));
    const meta = history.slice();
    if (index === -1) meta.push({ "scan-metadata": incoming });
    else {
      const merged = mergeScanMetadata(history[index]["scan-metadata"], incoming);
      if (!needsCleanup && Array.isArray(saved.meta) && includesData(history[index]["scan-metadata"], merged)) {
        return { recordId: id, scanId: incoming.scanId };
      }
      meta[index] = { ...history[index], "scan-metadata": merged };
    }
    try {
      await request("/" + encodeURIComponent(id), "PATCH", { meta });
    } catch (error) {
      // The write can succeed while its response is lost; confirm before retrying.
      try {
        const recovered = await readRecord(id, identity);
        if (historySaved(recovered, meta)) return { recordId: id, scanId: incoming.scanId };
      } catch { /* Preserve the original write error. */ }
      throw error;
    }
    const confirmed = await readRecord(id, identity);
    if (!historySaved(confirmed, meta)) throw new LoginRecordError("persistence_unconfirmed");
    return { recordId: id, scanId: incoming.scanId };
  }

  return {
    resolveContacts(contacts) {
      const identities = normalizeContacts(contacts);
      const key = "contacts:" + JSON.stringify(identities.map(identity => identity.value));
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = resolveContacts(identities).finally(() => inFlight.delete(key));
      inFlight.set(key, operation);
      return operation;
    },
    resolve(method, value) {
      const identity = normalizeLoginIdentity(method, value);
      const key = identity.method + ":" + identity.value;
      if (inFlight.has(key)) return inFlight.get(key);
      const operation = resolveIdentity(identity).finally(() => inFlight.delete(key));
      inFlight.set(key, operation);
      return operation;
    },
    async appendScan(id, value) {
      const identity = linkedRecords.get(id);
      if (!identity) throw new LoginRecordError("unknown_record");
      // Capture the event now, before waiting for another scan's write to finish.
      const incoming = validateScanMetadata(value, appId);
      const operation = (writes.get(id) || Promise.resolve()).catch(() => {}).then(
        () => appendScan(id, identity, incoming));
      writes.set(id, operation);
      try { return await operation; }
      finally { if (writes.get(id) === operation) writes.delete(id); }
    },
  };
}
