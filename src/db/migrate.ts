import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { assertTenantSchema, quoteIdent } from "./tenant-schema";

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");

type Migration = { name: string; sql: string };

async function loadMigrations(kind: "public" | "tenant"): Promise<Migration[]> {
  const dir = path.join(MIGRATIONS_DIR, kind);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), "utf8") })));
}

/**
 * Applies pending migrations inside one schema. Each schema keeps its own
 * _migrations table, so a tenant created later catches up on its own.
 * Runs in one transaction with an advisory lock, so two processes can't
 * migrate the same schema at once.
 */
async function migrateSchema(client: PoolClient, schema: string, migrations: Migration[]): Promise<string[]> {
  const applied: string[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`migrate:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}, public`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}._migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>(`SELECT name FROM ${quoteIdent(schema)}._migrations`);
    const done = new Set(rows.map((r) => r.name));

    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${quoteIdent(schema)}._migrations (name) VALUES ($1)`, [migration.name]);
      applied.push(migration.name);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migratePublic(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    return await migrateSchema(client, "public", await loadMigrations("public"));
  } finally {
    client.release();
  }
}

export async function migrateTenant(pool: Pool, schema: string): Promise<string[]> {
  assertTenantSchema(schema);
  const client = await pool.connect();
  try {
    return await migrateSchema(client, schema, await loadMigrations("tenant"));
  } finally {
    client.release();
  }
}

/** Migrates the public schema, then every organisation's schema. */
export async function migrateAll(pool: Pool): Promise<{ public: string[]; tenants: Record<string, string[]> }> {
  const publicApplied = await migratePublic(pool);
  const { rows } = await pool.query<{ schema_name: string }>("SELECT schema_name FROM organizations ORDER BY created_at");
  const tenants: Record<string, string[]> = {};
  for (const { schema_name } of rows) {
    tenants[schema_name] = await migrateTenant(pool, schema_name);
  }
  return { public: publicApplied, tenants };
}
