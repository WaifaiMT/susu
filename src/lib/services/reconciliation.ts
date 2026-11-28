import { and, desc, eq, gt, sql } from "drizzle-orm";
import { PesewaError, type Payment, type Payout } from "pesewa";
import { cashDeposits, contributions, payouts, reconciliationRuns, type ReconciliationItem } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { accountBalance } from "../ledger";
import { formatCedis } from "../money";
import { configuredProviderName, getPayoutProvider, getProvider } from "../payments";
import { assertCan } from "../permissions";
import { recordAudit } from "./audit";
import { settleIn } from "./contributions";
import type { OrgContext } from "./orgs";
import { settlePayoutIn } from "./payouts";

// Reconciliation: does what we recorded match what the provider says happened?
//
// 1. Every MoMo payment and payout from the last `days` days is checked with the
//    provider's status API. Ours behind theirs (a lost webhook) → caught up and
//    reported as fixed. Ours ahead of, or against, theirs → a problem for a person.
// 2. The ledger is checked against the records it was posted from: the money at
//    the provider and in cash must equal what the contributions, payouts and
//    deposits add up to.
//
// Provider calls happen outside any database transaction; each catch-up is its
// own short transaction through the same settle functions webhooks use.
//
// This checks our records against the provider. MTN has no "list transactions"
// API, so finding money the provider holds that we have no record of at all
// would need Paystack's transaction list: a later step.

type Org = { id: string; schemaName: string };
export type ReconciliationSummary = { checked: number; matched: number; fixed: number; problems: number; items: ReconciliationItem[] };

const PAID = ["succeeded", "duplicate", "mismatch"];

function describePayment(p: Payment) {
  return p.amount !== undefined ? `${p.status} ${formatCedis(p.amount)}` : p.status;
}

async function checkContributions(org: Org, providerName: string, since: Date, items: ReconciliationItem[]) {
  const provider = getProvider(providerName);
  const rows = await withTenant(org.schemaName, (db) =>
    db
      .select()
      .from(contributions)
      .where(and(eq(contributions.method, "momo"), eq(contributions.provider, providerName), gt(contributions.createdAt, since))),
  );

  for (const c of rows) {
    const item = { kind: "contribution" as const, reference: c.reference };
    let theirs: Payment;
    try {
      theirs = await provider.verify(c.reference);
    } catch (error) {
      if (error instanceof PesewaError && error.code === "not_found") {
        // Never reached the provider: fine if we never counted it, a problem if we did
        items.push({ ...item, ours: c.status, theirs: "not found", result: PAID.includes(c.status) ? "problem" : "matched" });
      } else {
        items.push({ ...item, ours: c.status, theirs: "unreachable", result: "problem", note: "Couldn't reach the provider" });
      }
      continue;
    }

    const paid = PAID.includes(c.status);
    if (theirs.status === "success" && paid) {
      const ok = theirs.amount === undefined || theirs.amount === c.receivedPesewas;
      items.push({ ...item, ours: `${c.status} ${formatCedis(c.receivedPesewas ?? 0)}`, theirs: describePayment(theirs), result: ok ? "matched" : "problem" });
    } else if ((theirs.status === "success" && !paid) || (theirs.status === "failed" && ["pending", "otp_required"].includes(c.status))) {
      // We're behind (a lost or late webhook): catch up through the normal path
      const outcome = await withTenant(org.schemaName, (db) => settleIn(db, org.id, providerName, theirs));
      items.push({ ...item, ours: c.status, theirs: describePayment(theirs), result: "fixed", note: `Caught up: ${outcome}` });
    } else if (theirs.status !== "success" && paid) {
      items.push({ ...item, ours: c.status, theirs: theirs.status, result: "problem", note: "We counted money the provider doesn't show as paid" });
    } else {
      items.push({ ...item, ours: c.status, theirs: theirs.status, result: "matched" });
    }
  }
}

async function checkPayouts(org: Org, providerName: string, since: Date, items: ReconciliationItem[]) {
  const provider = getPayoutProvider(providerName);
  if (!provider) return;
  const rows = await withTenant(org.schemaName, (db) =>
    db.select().from(payouts).where(and(eq(payouts.method, "momo"), eq(payouts.provider, providerName), gt(payouts.createdAt, since))),
  );

  for (const p of rows) {
    const item = { kind: "payout" as const, reference: p.reference };
    let theirs: Payout;
    try {
      theirs = await provider.verifyPayout(p.reference);
    } catch (error) {
      const notFound = error instanceof PesewaError && error.code === "not_found";
      items.push({
        ...item,
        ours: p.status,
        theirs: notFound ? "not found" : "unreachable",
        result: notFound && p.status === "failed" ? "matched" : "problem",
        note: notFound && p.status === "pending" ? "Pending here, but the provider has no record: check it, then retry" : undefined,
      });
      continue;
    }

    const same =
      (p.status === "succeeded" && theirs.status === "success") ||
      (p.status === theirs.status && ["failed", "reversed", "pending"].includes(p.status));
    if (same) {
      const ok = theirs.amount === undefined || theirs.amount === p.amountPesewas;
      items.push({ ...item, ours: p.status, theirs: theirs.status, result: ok ? "matched" : "problem" });
    } else if (p.status === "pending" || (p.status === "succeeded" && theirs.status !== "pending")) {
      // Behind the provider (pending → final, or paid → reversed): catch up
      const outcome = await withTenant(org.schemaName, (db) => settlePayoutIn(db, org.id, providerName, theirs));
      const fixed = outcome !== "needs_attention" && outcome !== "unknown_reference";
      items.push({ ...item, ours: p.status, theirs: theirs.status, result: fixed ? "fixed" : "problem", note: `Caught up: ${outcome}` });
    } else {
      items.push({ ...item, ours: p.status, theirs: theirs.status, result: "problem", note: "Our record and the provider's disagree" });
    }
  }
}

/** The ledger's money accounts must equal what the records they were posted from add up to. */
async function checkLedger(org: Org, providerName: string, items: ReconciliationItem[]) {
  const checks = await withTenant(org.schemaName, async (db) => {
    const sum = async (query: ReturnType<typeof sql>) => Number(((await db.execute(query)).rows[0] as { total: string | null }).total ?? 0);
    const momoIn = await sum(
      sql`SELECT sum(received_pesewas) AS total FROM ${contributions}
          WHERE method = 'momo' AND provider = ${providerName} AND status IN ('succeeded', 'duplicate', 'mismatch')`,
    );
    const momoOut = await sum(sql`SELECT sum(amount_pesewas) AS total FROM ${payouts} WHERE method = 'momo' AND provider = ${providerName} AND status = 'succeeded'`);
    const deposits = await sum(sql`SELECT sum(amount_pesewas) AS total FROM ${cashDeposits} WHERE provider = ${providerName}`);
    const allDeposits = await sum(sql`SELECT sum(amount_pesewas) AS total FROM ${cashDeposits}`);
    const cashIn = await sum(sql`SELECT sum(received_pesewas) AS total FROM ${contributions} WHERE method = 'cash'`);
    const cashOut = await sum(sql`SELECT sum(amount_pesewas) AS total FROM ${payouts} WHERE method = 'cash' AND status = 'succeeded'`);
    return [
      [`clearing:${providerName}`, await accountBalance(db, `clearing:${providerName}`), momoIn - momoOut + deposits],
      ["cash", await accountBalance(db, "cash"), cashIn - cashOut - allDeposits],
    ] as const;
  });
  for (const [account, ledger, records] of checks) {
    items.push({
      kind: "ledger",
      reference: account,
      ours: `ledger ${formatCedis(ledger)}`,
      theirs: `records ${formatCedis(records)}`,
      result: ledger === records ? "matched" : "problem",
      note: ledger === records ? undefined : `Out by ${formatCedis(ledger - records)}`,
    });
  }
}

async function run(org: Org, days: number, ranBy: string | null): Promise<ReconciliationSummary> {
  const providerName = configuredProviderName();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const items: ReconciliationItem[] = [];
  await checkContributions(org, providerName, since, items);
  await checkPayouts(org, providerName, since, items);
  await checkLedger(org, providerName, items);

  const summary = {
    checked: items.length,
    matched: items.filter((i) => i.result === "matched").length,
    fixed: items.filter((i) => i.result === "fixed").length,
    problems: items.filter((i) => i.result === "problem").length,
    items,
  };
  await withTenant(org.schemaName, async (db) => {
    await db.insert(reconciliationRuns).values({
      provider: providerName,
      ranBy,
      checked: summary.checked,
      matched: summary.matched,
      fixed: summary.fixed,
      problems: summary.problems,
      report: items,
    });
    await recordAudit(db, {
      organizationId: org.id,
      actorId: ranBy,
      action: "reconciliation.ran",
      metadata: { provider: providerName, checked: summary.checked, fixed: summary.fixed, problems: summary.problems },
    });
  });
  return summary;
}

/** Runs reconciliation for one group, from the Ledger page. */
export async function reconcile(ctx: OrgContext, days = 7): Promise<ReconciliationSummary> {
  assertCan(ctx.role, "reconcile:run");
  return run({ id: ctx.org.id, schemaName: ctx.org.schemaName }, days, ctx.userId);
}

/** Runs reconciliation for a group without a signed-in user: the scheduled job (`npm run reconcile`). */
export function reconcileOrganization(org: Org, days = 7): Promise<ReconciliationSummary> {
  return run(org, days, null);
}

export async function listReconciliationRuns(ctx: OrgContext, limit = 10) {
  assertCan(ctx.role, "reconcile:run");
  return withTenant(ctx.org.schemaName, (db) => db.select().from(reconciliationRuns).orderBy(desc(reconciliationRuns.ranAt)).limit(limit));
}
