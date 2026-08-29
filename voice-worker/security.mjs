import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TOKEN_BYTES = 4096;

function decodeJson(value) {
  if (!value || value.length > MAX_TOKEN_BYTES) throw new Error("invalid_token");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function verifyMediaToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error("media_secret_unavailable");
  const [encodedPayload, encodedSignature, extra] = String(token || "").split(".");
  if (!encodedPayload || !encodedSignature || extra) throw new Error("invalid_token");

  const supplied = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", secret).update(encodedPayload).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid_signature");

  const payload = decodeJson(encodedPayload);
  if (payload?.v !== 1 || typeof payload.jti !== "string" || payload.jti.length < 12 || payload.jti.length > 200) throw new Error("invalid_claims");
  if (!Number.isSafeInteger(payload.exp) || payload.exp < nowSeconds || payload.exp > nowSeconds + 1_200) throw new Error("expired_token");
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds + 15)) throw new Error("not_yet_valid");
  return payload;
}

export function assertMediaTokenBinding(payload, start) {
  const parameters = start?.customParameters || {};
  const pairs = [
    ["callSid", start?.callSid],
    ["contextId", parameters.contextId],
    ["internalCallId", parameters.internalCallId],
    ["scenario", parameters.scenario],
    ["voiceProvider", parameters.voiceProvider],
  ];
  for (const [claim, actual] of pairs) {
    if (payload[claim] !== undefined && String(payload[claim]) !== String(actual || "")) throw new Error(`token_${claim}_mismatch`);
  }
}

export class BoundedQueue {
  constructor({ maxItems, maxBytes }) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.items = [];
    this.bytes = 0;
  }

  push(value) {
    const bytes = Buffer.byteLength(value);
    if (this.items.length >= this.maxItems || this.bytes + bytes > this.maxBytes) return false;
    this.items.push(value);
    this.bytes += bytes;
    return true;
  }

  drain() {
    const values = this.items;
    this.items = [];
    this.bytes = 0;
    return values;
  }

  clear() {
    this.items = [];
    this.bytes = 0;
  }

  get length() {
    return this.items.length;
  }
}
