import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isDatabaseConfigured } from "@/lib/db";

export async function POST() {
  if (isDatabaseConfigured) return NextResponse.json({ error: "Preview mode is disabled when the database is connected." }, { status: 403 });
  const token = await createSessionToken({ userId: "preview", workspaceId: "preview", email: "preview@halacx.ai", name: "Jinu", preview: true });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 8 });
  return response;
}
