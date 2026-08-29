import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { assertMediaTokenBinding, BoundedQueue, verifyMediaToken } from "./security.mjs";

const secret = "a-production-length-secret-that-is-at-least-32-bytes";
function token(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

test("verifies a bound, short-lived media token", () => {
  const payload = verifyMediaToken(token({ v: 1, jti: "abcdefghijkl", exp: 1_000, contextId: "ctx", scenario: "support" }), secret, 900);
  assert.doesNotThrow(() => assertMediaTokenBinding(payload, { customParameters: { contextId: "ctx", scenario: "support" } }));
});

test("rejects expired, modified, and mismatched tokens", () => {
  assert.throws(() => verifyMediaToken(token({ v: 1, jti: "abcdefghijkl", exp: 899 }), secret, 900), /expired/);
  const modified = token({ v: 1, jti: "abcdefghijkl", exp: 1_000 }).replace(/^./, "x");
  assert.throws(() => verifyMediaToken(modified, secret, 900));
  const payload = verifyMediaToken(token({ v: 1, jti: "abcdefghijkl", exp: 1_000, scenario: "support" }), secret, 900);
  assert.throws(() => assertMediaTokenBinding(payload, { customParameters: { scenario: "lead" } }), /mismatch/);
});

test("bounded queue rejects data beyond item or byte limits", () => {
  const queue = new BoundedQueue({ maxItems: 2, maxBytes: 5 });
  assert.equal(queue.push("aa"), true);
  assert.equal(queue.push("bbb"), true);
  assert.equal(queue.push("c"), false);
  assert.deepEqual(queue.drain(), ["aa", "bbb"]);
  assert.equal(queue.length, 0);
});
