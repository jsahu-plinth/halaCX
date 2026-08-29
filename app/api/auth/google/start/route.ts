import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

const STATE_COOKIE = "halacx_google_state";
const VERIFIER_COOKIE = "halacx_google_verifier";

function base64url(value: Buffer) {
  return value.toString("base64url");
}

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/login?authError=google_not_configured", request.url));
  }

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();

  const response = NextResponse.redirect(authorizationUrl);
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  response.cookies.set(STATE_COOKIE, state, cookieOptions);
  response.cookies.set(VERIFIER_COOKIE, verifier, cookieOptions);
  return response;
}
