import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "@/lib/env";

declare global {
  // eslint-disable-next-line no-var
  var wheelPgPool: Pool | undefined;
}

export function isPostgresConfigured() {
  return Boolean(env.DATABASE_URL);
}

export function getPool() {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }

  globalThis.wheelPgPool ??= new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined
  });

  return globalThis.wheelPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
