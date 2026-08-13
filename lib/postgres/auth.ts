import "server-only";

import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { query, isPostgresConfigured } from "@/lib/postgres/client";
import { env } from "@/lib/env";

const SESSION_COOKIE = "wheel_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type AppUser = {
  id: string;
  email: string;
};

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function timingSafeEqualText(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string) {
  const [scheme, salt, hash] = storedHash.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
  return timingSafeEqualText(key.toString("hex"), hash);
}

export async function createUser(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const result = await query<AppUser>(
    `insert into app_users (email, password_hash)
     values ($1, $2)
     returning id, email`,
    [normalizedEmail, passwordHash]
  );
  return result.rows[0];
}

export async function findUserByEmail(email: string) {
  const result = await query<AppUser & { password_hash: string }>(
    `select id, email, password_hash from app_users where email = $1 limit 1`,
    [email.trim().toLowerCase()]
  );
  return result.rows[0] ?? null;
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await query(
    `insert into app_sessions (user_id, token_hash, expires_at)
     values ($1, $2, $3)`,
    [userId, tokenHash, expiresAt.toISOString()]
  );
  return { token, expiresAt };
}

export function setSessionCookie(token: string, expiresAt: Date) {
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });
}

export async function clearSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    await query(`delete from app_sessions where token_hash = $1`, [hashToken(token)]).catch(() => undefined);
  }
  cookies().delete(SESSION_COOKIE);
}

function localHostFromRequest() {
  try {
    const host = headers().get("host") ?? "";
    return host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host.startsWith("[::1]:");
  } catch {
    return false;
  }
}

async function getLocalDevUser(): Promise<{ user: AppUser; isLocalDev: true } | null> {
  if (!env.LOCAL_DEV_AUTH_AUTO_LOGIN || !env.LOCAL_DEV_AUTH_EMAIL || process.env.NODE_ENV === "production" || !localHostFromRequest()) {
    return null;
  }
  const email = env.LOCAL_DEV_AUTH_EMAIL.trim().toLowerCase();
  const existing = await query<AppUser>(`select id, email from app_users where email = $1 limit 1`, [email]);
  if (existing.rows[0]) return { user: existing.rows[0], isLocalDev: true };

  const passwordHash = await hashPassword(crypto.randomBytes(24).toString("base64url"));
  const created = await query<AppUser>(
    `insert into app_users (email, password_hash)
     values ($1, $2)
     returning id, email`,
    [email, passwordHash]
  );
  return { user: created.rows[0], isLocalDev: true };
}

export async function getCurrentUser(): Promise<{ user: AppUser | null; isLocalDev: boolean }> {
  if (!isPostgresConfigured()) return { user: null, isLocalDev: false };

  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) {
    const result = await query<AppUser>(
      `select u.id, u.email
       from app_sessions s
       join app_users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()
       limit 1`,
      [hashToken(token)]
    );
    if (result.rows[0]) return { user: result.rows[0], isLocalDev: false };
  }

  const localDevUser = await getLocalDevUser();
  if (localDevUser) return localDevUser;
  return { user: null, isLocalDev: false };
}
