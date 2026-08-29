import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { previewCalls, previewKnowledge } from "@/lib/preview-data";

export async function GET() {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.preview) return NextResponse.json({ preview: true, user: session, calls: previewCalls, knowledge: previewKnowledge, agent: { name: "Maya", status: "ready", languages: ["English", "Arabic", "Hindi"] } });

  const [calls, knowledge, agents, workspaces] = await Promise.all([
    query("select id,caller_name,from_number,to_number,direction,status,outcome,duration_seconds,summary,created_at from calls where workspace_id=$1 order by created_at desc limit 20", [session.workspaceId]),
    query("select id,title,source_type,status,updated_at from knowledge_sources where workspace_id=$1 order by updated_at desc", [session.workspaceId]),
    query("select id,name,status,languages from agents where workspace_id=$1 order by created_at limit 1", [session.workspaceId]),
    query("select id,name,slug from workspaces where id=$1", [session.workspaceId]),
  ]);
  if (!workspaces.rows[0]) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ preview: false, user: session, workspace: workspaces.rows[0], calls: calls.rows, knowledge: knowledge.rows, agent: agents.rows[0] });
}
