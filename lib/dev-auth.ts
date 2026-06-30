import type { SupabaseClient, User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function localHostFromRequest() {
  try {
    const host = headers().get("host") ?? "";
    return host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host.startsWith("[::1]:");
  } catch {
    return false;
  }
}

export function isLocalDevAuthEnabled() {
  return Boolean(env.LOCAL_DEV_AUTH_EMAIL) && process.env.NODE_ENV !== "production" && localHostFromRequest();
}

export async function getLocalDevUser() {
  if (!isLocalDevAuthEnabled() || !env.LOCAL_DEV_AUTH_EMAIL) return null;

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const email = env.LOCAL_DEV_AUTH_EMAIL;
  const { data: listed, error: listError } = await admin.auth.admin.listUsers();
  if (listError) throw listError;

  const existing = listed.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
  if (existing) return { user: existing, supabase: admin };

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { local_dev_auth: true }
  });
  if (createError) throw createError;
  return created.user ? { user: created.user, supabase: admin } : null;
}

export async function getEffectiveUser(supabase: SupabaseClient) {
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) return { user: user as User, supabase, isLocalDev: false };

  const local = await getLocalDevUser();
  if (!local) return { user: null, supabase, isLocalDev: false };

  return { user: local.user as User, supabase: local.supabase, isLocalDev: true };
}
