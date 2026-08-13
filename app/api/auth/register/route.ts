import { createUser } from "@/lib/postgres/auth";
import { isPostgresConfigured } from "@/lib/postgres/client";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (!isPostgresConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  try {
    await createUser(email, password);
    return NextResponse.json({ ok: true, message: "Account created. Sign in to continue." });
  } catch (error) {
    if (error && typeof error === "object" && (error as Record<string, unknown>).code === "23505") {
      return NextResponse.json({ error: "An account already exists for that email" }, { status: 409 });
    }
    throw error;
  }
}
