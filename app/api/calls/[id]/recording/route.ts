import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await query<{ recording_url: string | null }>("select recording_url from calls where id=$1 and workspace_id=$2", [id, session.workspaceId]);
  const recordingUrl = result.rows[0]?.recording_url;
  if (!recordingUrl) return NextResponse.json({ error: "Recording not available" }, { status: 404 });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return NextResponse.json({ error: "Recording provider is not configured" }, { status: 503 });
  const audio = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` }, cache: "no-store" });
  if (!audio.ok || !audio.body) return NextResponse.json({ error: "Recording could not be loaded" }, { status: 502 });
  return new NextResponse(audio.body, { headers: { "Content-Type": audio.headers.get("content-type") || "audio/mpeg", "Cache-Control": "private, max-age=300" } });
}
