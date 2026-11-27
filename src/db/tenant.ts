import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { getPool } from "./client";
import { assertTenantSchema, quoteIdent } from "./tenant-schema";

export type TenantDb = NodePgDatabase;

/**
 * Runs `fn` in a transaction whose search_path is the organisation's schema.
 * Tenant tables are unqualified, so every query inside `fn` can only reach
 * this organisation's data. SET LOCAL ends with the transaction, so a pooled
 * connection never carries one tenant's search_path into another request.
 */
export async function withTenant<T>(schema: string, fn: (db: TenantDb) => Promise<T>): Promise<T> {
  assertTenantSchema(schema);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // `public` stays on the path so tenant queries can join shared tables like users;
    // no tenant table name exists in public, so nothing can resolve to the wrong place
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
    const result = await fn(drizzle(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
