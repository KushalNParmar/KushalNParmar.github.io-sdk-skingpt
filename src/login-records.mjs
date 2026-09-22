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
    // The supplied Kwikpass integration saved country-code numbers without +.
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

export function createLoginRecordStore({ recordsUrl, appId, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
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
      phone_number: identity.method === "phone" ? identity.value : null,
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
