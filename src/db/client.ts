import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// One pool per process. Next.js dev reloads modules often, so keep it on
// globalThis instead of opening a new pool on every reload.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
    }
    globalForDb.pgPool = new Pool({ connectionString, max: 10 });
  }
  return globalForDb.pgPool;
}

/** Drizzle instance for the shared public-schema tables. */
export function getDb() {
  return drizzle(getPool());
}

export type Db = ReturnType<typeof getDb>;

export async function closePool(): Promise<void> {
  await globalForDb.pgPool?.end();
  globalForDb.pgPool = undefined;
}
