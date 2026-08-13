import { createSession, findUserByEmail, setSessionCookie, verifyPassword } from "@/lib/postgres/auth";
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

  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const session = await createSession(user.id);
  setSessionCookie(session.token, session.expiresAt);
  return NextResponse.json({ ok: true });
}
