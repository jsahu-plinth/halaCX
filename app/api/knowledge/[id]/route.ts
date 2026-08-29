import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await query("delete from knowledge_sources where id=$1 and workspace_id=$2 returning id", [id, session.workspaceId]);
  if (!result.rows[0]) return NextResponse.json({ error: "Knowledge source not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
