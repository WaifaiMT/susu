import "dotenv/config";
import { asc } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client";
import { organizations } from "../src/db/schema";
import { configuredProviderName } from "../src/lib/payments";
import { reconcileOrganization } from "../src/lib/services/reconciliation";

// Reconciles every group against the payment provider: `npm run reconcile`
// (optionally `-- --days 30`). Meant for a daily scheduled job. Exits 1 if
// any group has a problem, so the job shows up as failed.
//
// Note: the built-in test provider keeps its state in the app's memory, so
// from this separate process it knows nothing. Use the Ledger page's
// "Reconcile now" button with the test provider, and this script with
// Paystack test mode or the MTN sandbox.

async function main() {
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 7;
  if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a whole number of days");

  const provider = configuredProviderName();
  if (provider === "fake") {
    console.warn("PAYMENTS_PROVIDER is the in-memory test provider; this process can't see its payments. Use the Ledger page instead.");
  }

  const orgs = await getDb().select({ id: organizations.id, name: organizations.name, schemaName: organizations.schemaName }).from(organizations).orderBy(asc(organizations.name));
  let problems = 0;
  for (const org of orgs) {
    const summary = await reconcileOrganization(org, days);
    problems += summary.problems;
    console.log(`${org.name}: ${summary.checked} checked, ${summary.matched} matched, ${summary.fixed} fixed, ${summary.problems} problems`);
    for (const item of summary.items.filter((i) => i.result !== "matched")) {
      console.log(`  [${item.result}] ${item.kind} ${item.reference}: ours ${item.ours}, theirs ${item.theirs}${item.note ? ` (${item.note})` : ""}`);
    }
  }
  await closePool();
  if (problems > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
