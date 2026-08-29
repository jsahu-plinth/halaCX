import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInternalJobRequest } from "../lib/internal-job-auth.ts";

test("internal job endpoints require an exact constant-time bearer secret", () => {
  const previous = process.env.INTERNAL_JOB_SECRET;
  process.env.INTERNAL_JOB_SECRET = "12345678901234567890123456789012";
  try {
    assert.equal(authorizeInternalJobRequest(new Request("https://example.test", { headers: { authorization: "Bearer 12345678901234567890123456789012" } })), true);
    assert.equal(authorizeInternalJobRequest(new Request("https://example.test", { headers: { authorization: "Bearer wrong" } })), false);
    assert.equal(authorizeInternalJobRequest(new Request("https://example.test")), false);
  } finally {
    if (previous === undefined) delete process.env.INTERNAL_JOB_SECRET;
    else process.env.INTERNAL_JOB_SECRET = previous;
  }
});
