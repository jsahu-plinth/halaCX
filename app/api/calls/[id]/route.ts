import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const [call, events] = await Promise.all([
    query("select id,caller_name,from_number,to_number,direction,status,outcome,duration_seconds,summary,transcript,recording_url,started_at,ended_at,created_at from calls where id=$1 and workspace_id=$2", [id, session.workspaceId]),
    query("select event_type,payload,created_at from call_events where call_id=$1 and exists(select 1 from calls where id=$1 and workspace_id=$2) order by created_at", [id, session.workspaceId]),
  ]);
  if (!call.rows[0]) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  return NextResponse.json({ call: call.rows[0], events: events.rows });
}
