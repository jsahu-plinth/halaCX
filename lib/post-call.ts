import OpenAI from "openai";
import { query } from "@/lib/db";

type DiarizedTranscript = {
  text?: string;
  segments?: Array<{ id?: string; start?: number; end?: number; text?: string; speaker?: string }>;
};

export async function processCallRecording(callId: string, recordingUrl: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!accountSid || !authToken || !apiKey) throw new Error("Post-call providers are not configured");

  const recordingResponse = await fetch(`${recordingUrl}.mp3`, {
    headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!recordingResponse.ok) throw new Error(`Recording download failed with ${recordingResponse.status}`);
  const contentLength = Number(recordingResponse.headers.get("content-length") || 0);
  if (contentLength > 50 * 1024 * 1024) throw new Error("Recording exceeds the 50 MB processing limit");
  const audio = await recordingResponse.blob();
  const form = new FormData();
  form.append("file", audio, "call.mp3");
  form.append("model", "gpt-4o-transcribe-diarize");
  form.append("response_format", "diarized_json");
  const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!transcriptionResponse.ok) throw new Error(`Transcription failed with ${transcriptionResponse.status}`);
  const transcription = await transcriptionResponse.json() as DiarizedTranscript;
  const transcript = (transcription.segments || []).map((segment) => ({
    id: segment.id,
    speaker: segment.speaker || "speaker",
    start: segment.start || 0,
    end: segment.end || 0,
    text: segment.text || "",
  }));

  const openai = new OpenAI({ apiKey });
  const analysis = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Analyse a contact-centre transcript. Return JSON with summary (maximum 60 words), outcome (maximum 6 words), and caller_name (string or null). Do not invent information." },
      { role: "user", content: transcription.text || transcript.map((item) => `${item.speaker}: ${item.text}`).join("\n") },
    ],
  }, { timeout: 60_000, maxRetries: 1 });
  const rawAnalysis = analysis.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(rawAnalysis) as { summary?: string; outcome?: string; caller_name?: string | null };
  await query(
    "update calls set transcript=$1::jsonb,summary=$2,outcome=$3,caller_name=coalesce($4,caller_name) where id=$5",
    [JSON.stringify(transcript), parsed.summary || null, parsed.outcome || "Completed", parsed.caller_name || null, callId],
  );
  await query(
    `insert into call_events(call_id,provider_event_id,event_type,payload)
     values($1,$2,'postcall.completed',$3::jsonb)
     on conflict(provider_event_id) where provider_event_id is not null do nothing`,
    [callId, `postcall-completed:${callId}`, JSON.stringify({ segments: transcript.length })],
  );
}
