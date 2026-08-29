import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

const schema = z.object({ title: z.string().trim().min(2).max(120), content: z.string().trim().min(10).max(50000) });

export async function GET() {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await query("select id,title,content,source_type,status,updated_at from knowledge_sources where workspace_id=$1 order by updated_at desc", [session.workspaceId]);
  return NextResponse.json({ sources: result.rows });
}

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Connect the database to save knowledge." }, { status: session ? 503 : 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Add a title and at least 10 characters of approved knowledge." }, { status: 400 });
  const result = await query("insert into knowledge_sources(workspace_id,title,content) values($1,$2,$3) returning id,title,source_type,status,updated_at", [session.workspaceId, parsed.data.title, parsed.data.content]);
  return NextResponse.json({ source: result.rows[0] }, { status: 201 });
}
