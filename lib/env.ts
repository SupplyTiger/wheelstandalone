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
  DATABASE_URL: optionalSecret,
  DATABASE_SSL: z.preprocess((value) => value === "true" || value === true, z.boolean().optional()),
  SNAPTRADE_CLIENT_ID: optionalSecret,
  SNAPTRADE_CONSUMER_KEY: optionalSecret,
  SNAPTRADE_USER_ID: optionalSecret,
  SNAPTRADE_USER_SECRET: optionalSecret,
  SNAPTRADE_PRIMARY_ACCOUNT_NUMBER: optionalSecret,
  SNAPTRADE_SECONDARY_ACCOUNT_NUMBER: optionalSecret,
  LOCAL_DEV_AUTH_AUTO_LOGIN: z.preprocess((value) => value === "true" || value === true, z.boolean().optional()),
  LOCAL_DEV_AUTH_EMAIL: optionalSecret
});

export const env = serverSchema.parse(process.env);

type StringEnvKey = keyof {
  [Key in keyof typeof env as NonNullable<(typeof env)[Key]> extends string ? Key : never]: true;
};

export function requireEnv(name: StringEnvKey): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}
