import Link from "next/link";
import { Waveform } from "@phosphor-icons/react/dist/ssr";
import { isDatabaseConfigured } from "@/lib/db";
import LoginForm from "./login-form";

const authErrors: Record<string, string> = {
  google_not_configured: "Google sign-in is ready for a Client ID and Client Secret.",
  google_state_failed: "The Google sign-in request expired. Please try again.",
  google_exchange_failed: "Google could not complete sign-in. Please try again.",
  google_profile_failed: "We could not read your Google profile.",
  google_email_unverified: "Use a Google account with a verified email address.",
  google_failed: "Google sign-in could not be completed.",
  database_not_configured: "The database is not configured.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string; authError?: string }> }) {
  const { mode, authError } = await searchParams;
  return <main id="content" className="auth-page">
    <section className="auth-story"><Link className="wordmark wordmark-light" href="/"><span className="wordmark-mark"><Waveform weight="bold" /></span><span>hala<strong>CX</strong></span></Link><div><p className="eyebrow"><span/> YOUR AI CONTACT CENTER</p><h1>Every conversation,<br/><em>within reach.</em></h1><p>Build, operate and improve your multilingual AI contact center from one workspace.</p></div><blockquote>“The best customer experience begins before anyone has to wait.”</blockquote></section>
    <section className="auth-panel"><LoginForm initialMode={mode === "signup" ? "signup" : "login"} databaseReady={isDatabaseConfigured} initialError={authError ? authErrors[authError] || "Sign-in could not be completed." : undefined}/></section>
  </main>;
}
