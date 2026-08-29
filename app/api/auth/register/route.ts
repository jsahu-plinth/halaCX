import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isDatabaseConfigured, withTransaction } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  company: z.string().trim().min(2).max(100),
});

function slugify(value: string) {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid name, work email, company and 8-character password." }, { status: 400 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: "Database setup is waiting for your Supabase password." }, { status: 503 });

  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const result = await withTransaction(async (client) => {
      const user = await client.query<{ id: string }>(
        "insert into users(name,email,password_hash) values($1,$2,$3) returning id",
        [parsed.data.name, parsed.data.email, passwordHash],
      );
      const workspace = await client.query<{ id: string }>(
        "insert into workspaces(name,slug) values($1,$2) returning id",
        [parsed.data.company, slugify(parsed.data.company)],
      );
      await client.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'owner')", [workspace.rows[0].id, user.rows[0].id]);
      await client.query("insert into agents(workspace_id,name,instructions) values($1,'Maya',$2)", [workspace.rows[0].id, "Welcome every caller, understand their intent, answer from approved knowledge, and transfer when needed."]);
      return { userId: user.rows[0].id, workspaceId: workspace.rows[0].id };
    });
    const token = await createSessionToken({ ...result, email: parsed.data.email, name: parsed.data.name });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7 });
    return response;
  } catch (error) {
    const message = error instanceof Error && error.message.includes("users_email_key") ? "An account with this email already exists." : "We couldn't create the workspace.";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
