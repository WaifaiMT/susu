import "dotenv/config";
import { closePool, getPool } from "../src/db/client";
import { migrateAll } from "../src/db/migrate";

async function main() {
  // Applies pending migrations to the public schema, then to every organisation's schema.
  const result = await migrateAll(getPool());
  const tenantChanges = Object.entries(result.tenants).filter(([, applied]) => applied.length > 0);

  console.log(`public: ${result.public.length ? result.public.join(", ") : "up to date"}`);
  console.log(
    `tenants: ${Object.keys(result.tenants).length} schema(s), ${tenantChanges.length} updated` +
      tenantChanges.map(([schema, applied]) => `\n  ${schema}: ${applied.join(", ")}`).join(""),
  );
  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
