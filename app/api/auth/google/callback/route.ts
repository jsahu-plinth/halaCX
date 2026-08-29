import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { isDatabaseConfigured, withTransaction } from "@/lib/db";

const STATE_COOKIE = "halacx_google_state";
const VERIFIER_COOKIE = "halacx_google_verifier";

type GoogleUser = { sub: string; email: string; email_verified: boolean; name?: string; given_name?: string };

function slugify(value: string) {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
}

function loginError(request: Request, code: string) {
  return NextResponse.redirect(new URL(`/login?authError=${code}`, request.url));
}

export async function GET(request: Request) {
  if (!isDatabaseConfigured) return loginError(request, "database_not_configured");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return loginError(request, "google_not_configured");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  const verifier = cookieStore.get(VERIFIER_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState || !verifier) return loginError(request, "google_state_failed");

  try {
    const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
      cache: "no-store",
    });
    if (!tokenResponse.ok) return loginError(request, "google_exchange_failed");
    const tokenData = await tokenResponse.json() as { access_token?: string };
    if (!tokenData.access_token) return loginError(request, "google_exchange_failed");

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` }, cache: "no-store" });
    if (!profileResponse.ok) return loginError(request, "google_profile_failed");
    const profile = await profileResponse.json() as GoogleUser;
    if (!profile.sub || !profile.email || !profile.email_verified) return loginError(request, "google_email_unverified");

    const email = profile.email.toLowerCase();
    const name = profile.name?.trim() || profile.given_name?.trim() || email.split("@")[0];
    const result = await withTransaction(async (client) => {
      const linked = await client.query<{ id: string; name: string; workspace_id: string }>(
        `select u.id,u.name,wm.workspace_id from oauth_accounts oa join users u on u.id=oa.user_id join workspace_members wm on wm.user_id=u.id where oa.provider='google' and oa.provider_account_id=$1 limit 1`,
        [profile.sub],
      );
      if (linked.rows[0]) return { userId: linked.rows[0].id, workspaceId: linked.rows[0].workspace_id, name: linked.rows[0].name };

      const existing = await client.query<{ id: string; name: string; workspace_id: string }>(
        `select u.id,u.name,wm.workspace_id from users u join workspace_members wm on wm.user_id=u.id where lower(u.email)=lower($1) limit 1`,
        [email],
      );
      if (existing.rows[0]) {
        await client.query("insert into oauth_accounts(provider,provider_account_id,user_id) values('google',$1,$2) on conflict do nothing", [profile.sub, existing.rows[0].id]);
        return { userId: existing.rows[0].id, workspaceId: existing.rows[0].workspace_id, name: existing.rows[0].name };
      }

      const unusablePassword = await bcrypt.hash(randomUUID(), 12);
      const user = await client.query<{ id: string }>("insert into users(name,email,password_hash) values($1,$2,$3) returning id", [name, email, unusablePassword]);
      const workspaceName = `${profile.given_name?.trim() || name.split(" ")[0]}'s workspace`;
      const workspace = await client.query<{ id: string }>("insert into workspaces(name,slug) values($1,$2) returning id", [workspaceName, slugify(workspaceName)]);
      await client.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'owner')", [workspace.rows[0].id, user.rows[0].id]);
      await client.query("insert into oauth_accounts(provider,provider_account_id,user_id) values('google',$1,$2)", [profile.sub, user.rows[0].id]);
      await client.query("insert into agents(workspace_id,name,instructions) values($1,'Maya',$2)", [workspace.rows[0].id, "Welcome every caller, understand their intent, answer from approved knowledge, and transfer when needed."]);
      return { userId: user.rows[0].id, workspaceId: workspace.rows[0].id, name };
    });

    const token = await createSessionToken({ userId: result.userId, workspaceId: result.workspaceId, email, name: result.name });
    const response = NextResponse.redirect(new URL("/dashboard", request.url));
    response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7 });
    response.cookies.delete(STATE_COOKIE);
    response.cookies.delete(VERIFIER_COOKIE);
    return response;
  } catch {
    return loginError(request, "google_failed");
  }
}
