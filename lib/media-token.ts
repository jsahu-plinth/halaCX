import { createHmac, randomUUID } from "node:crypto";

type MediaTokenClaims = {
  callSid?: string;
  contextId?: string;
  internalCallId?: string;
  workspaceId?: string;
  scenario?: string;
  voiceProvider?: string;
};

export function createMediaStreamToken(claims: MediaTokenClaims, ttlSeconds = 15 * 60) {
  const secret = process.env.MEDIA_STREAM_SECRET;
  if (!secret || secret.length < 32) throw new Error("MEDIA_STREAM_SECRET must contain at least 32 characters");

  const payload = {
    v: 1,
    exp: Math.floor(Date.now() / 1_000) + ttlSeconds,
    jti: randomUUID(),
    ...claims,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}
