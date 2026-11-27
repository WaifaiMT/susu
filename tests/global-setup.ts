import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import type { TestProject } from "vitest/node";
import { migratePublic } from "../src/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Creates a throwaway database for the run, migrates it, and drops it at the
 * end. TEST_DATABASE_URL points at any database on a server where the user
 * can CREATE DATABASE (CI uses the postgres service container).
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL) to run the tests.");

  const dbName = `susu_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const databaseUrl = url.toString();

  const pool = new Pool({ connectionString: databaseUrl });
  await migratePublic(pool);
  await pool.end();

  project.provide("databaseUrl", databaseUrl);

  return async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await cleanup.end();
  };
}
