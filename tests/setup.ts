import { afterAll, inject } from "vitest";
import { closePool } from "../src/db/client";

process.env.DATABASE_URL = inject("databaseUrl");

afterAll(async () => {
  await closePool();
});
