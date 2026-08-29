import { NextResponse } from "next/server";
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
  if (!voiceUrl) return new NextResponse("<Response><Say>Voice service is unavailable.</Say></Response>", { headers: { "Content-Type": "text/xml" } });
  const twiml = `<Response><Connect><Stream url="${xml(voiceUrl)}"><Parameter name="scenario" value="receptionist"/></Stream></Connect></Response>`;
  return new NextResponse(twiml, { headers: { "Content-Type": "text/xml" } });
}
