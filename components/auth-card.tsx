"use client";

import { useState } from "react";
import { LogIn } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function AuthCard({ configured }: { configured: boolean }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn() {
    setLoading(true);
    setMessage("");
    const supabase = createSupabaseBrowserClient();
    const origin = window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}/auth/callback` }
    });
    setLoading(false);
    setMessage(error ? error.message : "Check your email for the login link.");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="border-b border-line pb-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">The Wheel</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">Treasury dashboard</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Sign in with Supabase Auth to sync brokerage positions, run server-side Yahoo Finance scans, and keep the
          browser free of finance API secrets.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-4 shadow-soft">
        {!configured ? (
          <p className="text-sm text-danger">
            Supabase environment variables are missing. Add them to .env.local before signing in.
          </p>
        ) : (
          <>
            <label className="text-xs font-semibold uppercase text-muted" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="mt-2 w-full rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <button
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              onClick={signIn}
              disabled={loading || !email}
            >
              <LogIn size={16} />
              {loading ? "Sending link" : "Send magic link"}
            </button>
            {message ? <p className="mt-3 text-sm text-muted">{message}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
