import { sql } from "drizzle-orm";
import type { CollectRequest, CollectResult, MobileMoneyProvider } from "pesewa";
import { withTenant } from "@/db/tenant";
import { getFakeProvider } from "@/lib/payments";
import { FakeProvider } from "@/lib/payments/fake";
import { processWebhook, startContribution } from "@/lib/services/contributions";
import { createDraftCycle, getOpenCycle, startCycle } from "@/lib/services/cycles";
import type { OrgContext } from "@/lib/services/orgs";
import { makeGroup } from "./helpers";

export const DRAFT_DAY = "2027-01-04";
export const PAY_DAY = "2027-01-11";
/** GH₵ 50 */
export const AMOUNT = 5000;

/** A group with a running weekly cycle of GH₵ 50, first round due on PAY_DAY. */
export async function runningCycle(size = 3) {
  const group = await makeGroup(size);
  const cycle = await createDraftCycle(
    group.collector,
    { amount: "50", frequency: "weekly", startsOn: PAY_DAY, orderMethod: "join_order" },
    DRAFT_DAY,
  );
  await startCycle(group.collector, cycle.id, DRAFT_DAY);
  const view = (await getOpenCycle(group.collector))!;
  return { ...group, everyone: [group.collector, ...group.members], view, round1: view.rounds[0] };
}

export function fake(): FakeProvider {
  const provider = getFakeProvider();
  if (!provider) throw new Error("Tests run with PAYMENTS_PROVIDER=fake");
  return provider;
}

/** What the provider stored for this contribution: its reference. */
export async function referenceOf(ctx: OrgContext, contributionId: string): Promise<string> {
  const { rows } = await withTenant(ctx.org.schemaName, (db) =>
    db.execute<{ reference: string }>(sql`SELECT reference FROM contributions WHERE id = ${contributionId}`),
  );
  return rows[0].reference;
}

/** The member approves the prompt and the provider's webhook arrives. */
export async function approve(ctx: OrgContext, contributionId: string, paidAmount?: number) {
  const reference = await referenceOf(ctx, contributionId);
  fake().settle(reference, "success", paidAmount);
  return processWebhook("fake", fake().webhookFor(reference));
}

export async function decline(ctx: OrgContext, contributionId: string) {
  const reference = await referenceOf(ctx, contributionId);
  fake().settle(reference, "failed");
  return processWebhook("fake", fake().webhookFor(reference));
}

/** Pays and approves in one go. */
export async function pay(ctx: OrgContext, roundId: string, phone = "0241234567") {
  const started = await startContribution(ctx, { roundId, phone }, PAY_DAY);
  await approve(ctx, started.contributionId);
  return started.contributionId;
}

export async function query<T extends Record<string, unknown>>(ctx: OrgContext, query: ReturnType<typeof sql>): Promise<T[]> {
  const { rows } = await withTenant(ctx.org.schemaName, (db) => db.execute(query));
  return rows as T[];
}

export async function balances(ctx: OrgContext): Promise<Record<string, number>> {
  const rows = await query<{ code: string; balance: string }>(
    ctx,
    sql`SELECT a.code, coalesce(sum(e.amount_pesewas), 0) AS balance
        FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.code`,
  );
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.balance)]));
}

/**
 * Swaps the cached fake provider for one whose collect() lets `beforeReturn`
 * run first: a webhook that arrives before the provider's own reply.
 */
export function withSlowCollect(beforeReturn: (reference: string) => Promise<void>): () => void {
  const cache = (globalThis as unknown as { paymentProviders: Map<string, MobileMoneyProvider> }).paymentProviders;
  const original = cache.get("fake")!;
  const slow = Object.create(original) as FakeProvider;
  slow.collect = async (req: CollectRequest): Promise<CollectResult> => {
    const result = await original.collect(req);
    await beforeReturn(req.reference);
    return result;
  };
  cache.set("fake", slow);
  return () => cache.set("fake", original);
}
