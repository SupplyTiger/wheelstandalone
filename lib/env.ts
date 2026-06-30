import { z } from "zod";

const optionalSecret = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("your_")) return undefined;
  return trimmed;
}, z.string().optional());

const optionalUrl = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("your_")) return undefined;
  return trimmed;
}, z.string().url().optional());

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optionalSecret,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  SNAPTRADE_CLIENT_ID: optionalSecret,
  SNAPTRADE_CONSUMER_KEY: optionalSecret,
  SNAPTRADE_USER_ID: optionalSecret,
  SNAPTRADE_USER_SECRET: optionalSecret,
  SNAPTRADE_PRIMARY_ACCOUNT_NUMBER: optionalSecret,
  SNAPTRADE_SECONDARY_ACCOUNT_NUMBER: optionalSecret,
  LOCAL_DEV_AUTH_EMAIL: optionalSecret
});

export const env = serverSchema.parse(process.env);

export function requireEnv(name: keyof typeof env): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}
