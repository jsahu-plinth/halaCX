import { NextResponse } from "next/server";
import { z } from "zod";
import { readSession } from "@/lib/auth";
import { query } from "@/lib/db";

const schema = z.object({ name: z.string().trim().min(2).max(100) });

export async function GET() {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const result = await query("select id,name,slug,created_at from workspaces where id=$1", [session.workspaceId]);
  return NextResponse.json({ workspace: result.rows[0] || null });
}

export async function PATCH(request: Request) {
  const session = await readSession();
  if (!session || session.preview) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid workspace name." }, { status: 400 });
  const result = await query("update workspaces set name=$1 where id=$2 returning id,name,slug", [parsed.data.name, session.workspaceId]);
  return NextResponse.json({ workspace: result.rows[0] });
}
