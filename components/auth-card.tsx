"use client";

import { useMemo, useState } from "react";
import { KeyRound, Loader2, LogIn, Mail, UserPlus } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type AuthMode = "signin" | "signup" | "magic";

const modeCopy = {
  signin: {
    title: "Sign in",
    helper: "Use the email and password for your Wheel account.",
    button: "Sign in",
    icon: LogIn
  },
  signup: {
    title: "Create account",
    helper: "Create your Wheel web login. You may need to confirm your email before the dashboard opens.",
    button: "Create account",
    icon: UserPlus
  },
  magic: {
    title: "Magic link",
    helper: "Get a one-time sign-in link by email.",
    button: "Send magic link",
    icon: Mail
  }
};

export function AuthCard({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"neutral" | "danger" | "success">("neutral");
  const [loading, setLoading] = useState(false);

  const active = modeCopy[mode];
  const ActiveIcon = active.icon;
  const needsPassword = mode !== "magic";
  const canSubmit = configured && email.trim() && (!needsPassword || password.length >= 6);

  const messageClass = useMemo(() => {
    if (messageTone === "danger") return "text-danger";
    if (messageTone === "success") return "text-success";
    return "text-muted";
  }, [messageTone]);

  function setResult(text: string, tone: "neutral" | "danger" | "success" = "neutral") {
    setMessage(text);
    setMessageTone(tone);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setLoading(true);
    setResult("");

    const supabase = createSupabaseBrowserClient();
    const origin = window.location.origin;
    const cleanEmail = email.trim();

    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password
        });
        if (error) throw error;
        setResult("Signed in. Loading dashboard...", "success");
        window.location.assign("/");
        return;
      }

      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: { emailRedirectTo: `${origin}/auth/callback` }
        });
        if (error) throw error;
        setResult("Account created. Check your email if Supabase requires confirmation.", "success");
        return;
      }

      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: `${origin}/auth/callback` }
      });
      if (error) throw error;
      setResult("Check your email for the login link.", "success");
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Authentication failed.", "danger");
    } finally {
      setLoading(false);
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setResult("Enter your email first, then request a reset link.", "danger");
      return;
    }

    setLoading(true);
    setResult("");
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/`
    });
    setLoading(false);
    setResult(error ? error.message : "Password reset link sent.", error ? "danger" : "success");
  }

  return (
    <main className="min-h-screen bg-canvas">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <div className="border-b border-line pb-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">The Wheel</p>
          <h1 className="mt-2 text-3xl font-semibold text-ink">Treasury dashboard</h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            Sign in to sync brokerage positions, run yfinance-powered CSP scans, and keep credentials server-side.
          </p>
        </div>

        <div className="mt-6 rounded-lg border border-line bg-panel p-4 shadow-soft">
          {!configured ? (
            <p className="text-sm text-danger">
              Supabase environment variables are missing. Add them to `.env.local` locally or Vercel environment variables
              before signing in.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1">
                {(["signin", "signup", "magic"] as AuthMode[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => {
                      setMode(item);
                      setResult("");
                    }}
                    className={`h-9 rounded px-2 text-sm font-semibold ${
                      mode === item ? "bg-white text-ink shadow-sm" : "text-muted hover:text-ink"
                    }`}
                  >
                    {modeCopy[item].title}
                  </button>
                ))}
              </div>

              <div className="mt-5">
                <div className="flex items-center gap-2">
                  <ActiveIcon size={18} className="text-accent" />
                  <h2 className="font-semibold text-ink">{active.title}</h2>
                </div>
                <p className="mt-1 text-sm text-muted">{active.helper}</p>
              </div>

              <label className="mt-4 block text-xs font-semibold uppercase text-muted" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="mt-2 h-10 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-accent"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSubmit();
                }}
                placeholder="you@example.com"
              />

              {needsPassword ? (
                <>
                  <label className="mt-4 block text-xs font-semibold uppercase text-muted" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    className="mt-2 h-10 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-accent"
                    type="password"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleSubmit();
                    }}
                    placeholder="At least 6 characters"
                  />
                </>
              ) : null}

              <button
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
                onClick={handleSubmit}
                disabled={loading || !canSubmit}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <ActiveIcon size={16} />}
                {loading ? "Working" : active.button}
              </button>

              {mode === "signin" ? (
                <button
                  type="button"
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 text-sm font-semibold text-accent"
                  onClick={resetPassword}
                  disabled={loading}
                >
                  <KeyRound size={15} />
                  Send password reset
                </button>
              ) : null}

              {message ? <p className={`mt-3 text-sm ${messageClass}`}>{message}</p> : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
