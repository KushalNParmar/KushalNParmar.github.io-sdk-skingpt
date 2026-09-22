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

function metadata(record) {
  if (record.meta == null) return {};
  let meta = record.meta;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); }
    catch { throw new LoginRecordError("invalid_response"); }
  }
  if (!isObject(meta)) throw new LoginRecordError("invalid_response");
  return meta;
}

function recordId(record) {
  if (typeof record?.id !== "string" || !record.id.trim()) throw new LoginRecordError("invalid_response");
  return record.id;
}

function sessionFor(record) {
  const sessionId = metadata(record).sessionId;
  if (sessionId == null || sessionId === "") return null;
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 254) {
    throw new LoginRecordError("invalid_response");
  }
  return sessionId;
}

export function createLoginRecordStore({ recordsUrl, appId, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const baseUrl = recordsUrl.replace(/\/$/, "");
  const inFlight = new Map();

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

  async function linkExisting(record, identity) {
    let sessionId = sessionFor(record);
    if (!sessionId) {
      sessionId = identity.value;
      // PATCH can replace a JSON column, so retain all existing scan metadata.
      const meta = { ...metadata(record), sessionId };
      if (!meta.glamAppId) meta.glamAppId = appId;
      await request("/" + encodeURIComponent(recordId(record)), "PATCH", { meta });
      const saved = assertIdentity(unpackRecord(await request("/" + encodeURIComponent(recordId(record)), "GET")), identity);
      sessionId = sessionFor(saved);
      if (!sessionId) throw new LoginRecordError("invalid_response");
    }
    return { recordId: recordId(record), sessionId };
  }

  async function resolveIdentity(identity) {
    const existing = await lookup(identity);
    if (existing) return linkExisting(existing, identity);

    const payload = {
      email: identity.method === "email" ? identity.value : "",
      phone_number: identity.method === "phone" ? identity.value : "",
      user_name: "",
      meta: { sessionId: identity.value, glamAppId: appId },
    };
    try {
      const created = unpackRecord(await request("", "POST", payload));
      // Read back the saved row before passing its session to the SDK.
      const saved = assertIdentity(unpackRecord(await request("/" + encodeURIComponent(recordId(created)), "GET")), identity);
      return await linkExisting(saved, identity);
    } catch (error) {
      // A write may have committed even if the response was lost. Re-query;
      // never issue a second create blindly within the same login attempt.
      const recovered = await lookup(identity);
      if (recovered) return linkExisting(recovered, identity);
      throw error;
    }
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
  };
}
