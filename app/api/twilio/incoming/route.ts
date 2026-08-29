import { NextResponse } from "next/server";
import { createMediaStreamToken } from "@/lib/media-token";
import { validateTwilioWebhook } from "@/lib/twilio";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export async function POST(request: Request) {
  const form = await request.formData();
  const data = Object.fromEntries(form);
  if (!validateTwilioWebhook(request, data)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }
  const voiceUrl = process.env.VOICE_WS_URL;
  if (!voiceUrl || !process.env.MEDIA_STREAM_SECRET) return new NextResponse("<Response><Say>Voice service is unavailable.</Say></Response>", { headers: { "Content-Type": "text/xml" } });
  const requestedProvider = String(process.env.VOICE_PROVIDER || "openai");
  const voiceProvider = ["openai", "sarvam", "cartesia"].includes(requestedProvider) ? requestedProvider : "openai";
  const callSid = String(data.CallSid || "");
  const mediaToken = createMediaStreamToken({ callSid: callSid || undefined, scenario: "receptionist", voiceProvider });
  const twiml = `<Response><Connect><Stream url="${xml(voiceUrl)}"><Parameter name="scenario" value="receptionist"/><Parameter name="voiceProvider" value="${voiceProvider}"/><Parameter name="mediaToken" value="${mediaToken}"/></Stream></Connect></Response>`;
  return new NextResponse(twiml, { headers: { "Content-Type": "text/xml" } });
}
