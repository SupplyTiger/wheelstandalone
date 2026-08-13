"use client";

import { useState } from "react";
import { LogIn } from "lucide-react";

export function AuthCard({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitAuth() {
    setLoading(true);
    setMessage("");
    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json().catch(() => ({}));
    setLoading(false);
    if (!response.ok) {
      setMessage(data.error ?? "Sign in failed");
      return;
    }
    if (mode === "register") {
      setMode("login");
      setPassword("");
      setMessage(data.message ?? "Account created. Sign in to continue.");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="border-b border-line pb-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">The Wheel</p>
        <h1 className="mt-2 text-3xl font-semibold text-ink">Treasury dashboard</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Sign in with the Postgres-backed app login to sync brokerage positions, run server-side Yahoo Finance scans, and keep the
          browser free of finance API secrets.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-line bg-panel p-4 shadow-soft">
        {!configured ? (
          <p className="text-sm text-danger">
            Postgres DATABASE_URL is missing. Add it to .env.local and run the database migration before signing in.
          </p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 rounded-full border border-line bg-white p-1">
              <button
                type="button"
                onClick={() => setMode("login")}
                className={`h-9 rounded-full text-sm font-semibold ${mode === "login" ? "bg-ink text-white" : "text-muted"}`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => setMode("register")}
                className={`h-9 rounded-full text-sm font-semibold ${mode === "register" ? "bg-ink text-white" : "text-muted"}`}
              >
                Create account
              </button>
            </div>
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
            <label className="mt-4 block text-xs font-semibold uppercase text-muted" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="mt-2 w-full rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
            />
            <button
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              onClick={submitAuth}
              disabled={loading || !email || !password}
            >
              <LogIn size={16} />
              {loading ? "Working" : mode === "login" ? "Sign in" : "Create account"}
            </button>
            {message ? <p className="mt-3 text-sm text-muted">{message}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
