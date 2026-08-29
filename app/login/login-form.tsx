"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";

export default function LoginForm({ initialMode, databaseReady, initialError }: { initialMode: "login" | "signup"; databaseReady: boolean; initialError?: string }) {
  const [mode, setMode] = useState(initialMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initialError || "");
  const router = useRouter();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setLoading(true);
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form);
    const response = await fetch(`/api/auth/${mode === "signup" ? "register" : "login"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json(); setLoading(false);
    if (!response.ok) return setError(data.error || "We couldn't continue.");
    router.push("/dashboard"); router.refresh();
  }

  async function preview() {
    setLoading(true); setError("");
    const response = await fetch("/api/auth/preview", { method: "POST" });
    const data = await response.json(); setLoading(false);
    if (!response.ok) return setError(data.error);
    router.push("/dashboard"); router.refresh();
  }

  return <div className="auth-form-wrap"><Link href="/" className="back-link"><ArrowLeft/> Back to HalaCX</Link><div className="auth-heading"><p>{mode === "login" ? "WELCOME BACK" : "CREATE YOUR WORKSPACE"}</p><h2>{mode === "login" ? "Log in to HalaCX" : "Build your first agent"}</h2><span>{mode === "login" ? "Continue managing your calls and agents." : "Start with your team and business details."}</span></div>
    <a className="google-auth-button" href="/api/auth/google/start"><span>G</span>Continue with Google</a>
    <div className="auth-divider"><span>or continue with email</span></div>
    <form onSubmit={submit}>
      {mode === "signup" && <div className="form-row"><label>Full name<input name="name" autoComplete="name" placeholder="Your full name" required/></label><label>Company<input name="company" autoComplete="organization" placeholder="Your company name" required/></label></div>}
      <label>Work email<input name="email" type="email" autoComplete="email" placeholder="you@company.com" required/></label>
      <label>Password<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="At least 8 characters" minLength={mode === "signup" ? 8 : 1} required/></label>
      {error && <p className="form-error">{error}</p>}
      <button className="button button-dark auth-submit" disabled={loading}>{loading ? "Please wait…" : mode === "login" ? "Log in" : "Create workspace"}<ArrowRight/></button>
    </form>
    <p className="switch-auth">{mode === "login" ? "New to HalaCX?" : "Already have a workspace?"} <button onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Log in"}</button></p>
    {!databaseReady && <div className="preview-box"><span>DATABASE SETUP PENDING</span><p>The app is ready for Supabase. Add your database password to enable real accounts and saved calls.</p><button onClick={preview} disabled={loading}>Open the product preview <ArrowRight/></button></div>}
  </div>;
}
