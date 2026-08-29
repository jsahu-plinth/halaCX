import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  status: z.enum(["ready", "paused"]).optional(),
  voice: z.string().trim().min(2).max(40).optional(),
  languages: z.array(z.string().trim().min(2).max(40)).min(1).max(10).optional(),
  instructions: z.string().trim().min(10).max(12000).optional(),
}).refine((value) => Object.keys(value).length > 0);

export async function GET() {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await query("select id,name,status,voice,languages,instructions,created_at from agents where workspace_id=$1 order by created_at limit 1", [session.workspaceId]);
  return NextResponse.json({ agent: result.rows[0] || null });
}

export async function PATCH(request: Request) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter valid agent settings." }, { status: 400 });
  const current = await query<{ id: string; name: string; status: string; voice: string; languages: string[]; instructions: string }>("select id,name,status,voice,languages,instructions from agents where workspace_id=$1 order by created_at limit 1", [session.workspaceId]);
  if (!current.rows[0]) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  const value = { ...current.rows[0], ...parsed.data };
  const result = await query("update agents set name=$1,status=$2,voice=$3,languages=$4,instructions=$5 where id=$6 and workspace_id=$7 returning id,name,status,voice,languages,instructions", [value.name, value.status, value.voice, value.languages, value.instructions, current.rows[0].id, session.workspaceId]);
  return NextResponse.json({ agent: result.rows[0] });
}
