import { createHmac, timingSafeEqual } from "node:crypto";

export function validateTwilioWebhook(request: Request, values: Record<string, FormDataEntryValue>) {
  const signature = request.headers.get("x-twilio-signature");
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!signature || !authToken) return false;
  const incoming = new URL(request.url);
  const publicUrl = process.env.APP_URL ? new URL(`${incoming.pathname}${incoming.search}`, process.env.APP_URL).toString() : incoming.toString();
  const payload = Object.keys(values).sort().reduce((result, key) => `${result}${key}${String(values[key])}`, publicUrl);
  const expected = createHmac("sha1", authToken).update(payload).digest("base64");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
