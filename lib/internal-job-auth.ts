import { timingSafeEqual } from "node:crypto";

export function authorizeInternalJobRequest(request: Request) {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}
