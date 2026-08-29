import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isDatabaseConfigured, query } from "@/lib/db";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: "Database setup is waiting for your Supabase password." }, { status: 503 });

  const result = await query<{ id: string; name: string; email: string; password_hash: string; workspace_id: string }>(
    `select u.id,u.name,u.email,u.password_hash,wm.workspace_id from users u
     join workspace_members wm on wm.user_id=u.id where lower(u.email)=lower($1) limit 1`,
    [parsed.data.email],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  }
  const token = await createSessionToken({ userId: user.id, workspaceId: user.workspace_id, email: user.email, name: user.name });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7 });
  return response;
}
