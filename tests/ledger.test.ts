import { processWebhook } from "@/lib/services/webhooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/db/tenant";
import { postTransaction } from "@/lib/ledger";
import { recordCashContribution, startContribution } from "@/lib/services/contributions";
import type { OrgContext } from "@/lib/services/orgs";
import { AMOUNT, PAY_DAY, approve, balances, decline, fake, query, referenceOf, runningCycle } from "./payments-helpers";

async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

const raw = (ctx: OrgContext, statements: ReturnType<typeof sql>[]) =>
  withTenant(ctx.org.schemaName, async (db) => {
    for (const s of statements) await db.execute(s);
  });

describe("the ledger, enforced by the database", () => {
  it("refuses a transaction that doesn't balance", async () => {
    const { collector } = await runningCycle(2);
    const tx = randomUUID();
    expect(
      await pgError(
        raw(collector, [
          sql`INSERT INTO ledger_accounts (code, name) VALUES ('a', 'A'), ('b', 'B')`,
          sql`INSERT INTO ledger_transactions (id, kind, source_id, memo) VALUES (${tx}, 'contribution', ${randomUUID()}, 'bad')`,
          sql`INSERT INTO ledger_entries (transaction_id, account_id, amount_pesewas) SELECT ${tx}, id, 100 FROM ledger_accounts WHERE code = 'a'`,
          sql`INSERT INTO ledger_entries (transaction_id, account_id, amount_pesewas) SELECT ${tx}, id, -99 FROM ledger_accounts WHERE code = 'b'`,
        ]),
      ),
    ).toBe("23514");
  });

  it("refuses a transaction with fewer than two entries", async () => {
    const { collector } = await runningCycle(2);
    expect(
      await pgError(raw(collector, [sql`INSERT INTO ledger_transactions (kind, source_id, memo) VALUES ('contribution', ${randomUUID()}, 'empty')`])),
    ).toBe("23514");
  });

  it("is append-only: entries, transactions and paid contributions can't be edited or deleted", async () => {
    const { collector, round1 } = await runningCycle(2);
    const started = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    await approve(collector, started.contributionId);

    for (const statement of [
      sql`UPDATE ledger_entries SET amount_pesewas = amount_pesewas * 2`,
      sql`DELETE FROM ledger_entries`,
      sql`UPDATE ledger_transactions SET memo = 'edited'`,
      sql`DELETE FROM ledger_transactions`,
      sql`UPDATE contributions SET amount_pesewas = 1`,
      sql`UPDATE contributions SET status = 'failed'`,
      sql`DELETE FROM contributions`,
    ]) {
      expect(await pgError(raw(collector, [statement])), String(statement.queryChunks[0])).toBe("23514");
    }
  });

  it("won't count two successful payments from one member for one round", async () => {
    const { collector, round1 } = await runningCycle(2);
    await recordCashContribution(collector, { roundId: round1.id, userId: collector.userId }, PAY_DAY);
    expect(
      await pgError(
        raw(collector, [
          sql`INSERT INTO contributions (round_id, user_id, amount_pesewas, method, reference, status)
              VALUES (${round1.id}, ${collector.userId}, ${AMOUNT}, 'cash', ${randomUUID()}, 'succeeded')`,
        ]),
      ),
    ).toBe("23505");
  });

  it("posts each source once, however often it's processed", async () => {
    const { collector } = await runningCycle(2);
    const sourceId = randomUUID();
    const entries = [
      { account: "cash", amountPesewas: 100 },
      { account: "refunds_due", amountPesewas: -100 },
    ];
    const results = await withTenant(collector.org.schemaName, async (db) => [
      await postTransaction(db, { kind: "refund_due", sourceId, memo: "x", entries }),
      await postTransaction(db, { kind: "refund_due", sourceId, memo: "x", entries }),
    ]);
    expect(results).toEqual([true, false]);
    expect(await balances(collector)).toEqual({ cash: 100, refunds_due: -100 });
  });
});

describe("the books always balance (randomised)", () => {
  // A small seeded PRNG, so a failure can be replayed exactly
  function prng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
  }

  it("after any mix of payments, declines, duplicate webhooks, wrong amounts and cash", async () => {
    for (const seed of [1, 2, 3]) {
      const random = prng(seed);
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
      const { collector, everyone, view } = await runningCycle(4);
      const round = view.rounds[0];

      for (let step = 0; step < 14; step++) {
        const member = pick(everyone);
        const action = pick(["pay", "pay", "decline", "wrong_amount", "duplicate_webhook", "cash"] as const);
        try {
          if (action === "cash") {
            await recordCashContribution(collector, { roundId: round.id, userId: member.userId }, PAY_DAY);
            continue;
          }
          const started = await startContribution(member, { roundId: round.id, phone: "0241234567" }, PAY_DAY);
          if (action === "decline") await decline(member, started.contributionId);
          else if (action === "wrong_amount") await approve(member, started.contributionId, AMOUNT - 100);
          else {
            await approve(member, started.contributionId);
            if (action === "duplicate_webhook") {
              const reference = await referenceOf(member, started.contributionId);
              await processWebhook("fake", fake().webhookFor(reference));
            }
          }
        } catch (error) {
          // Expected refusals: already paid, round full, a prompt still waiting
          if (!(error as { code?: string }).code) throw error;
        }

        // Invariants, checked after every step
        const b = await balances(collector);
        const total = Object.values(b).reduce((s, v) => s + v, 0);
        expect(total, `seed ${seed}, step ${step}: ledger sums to zero`).toBe(0);

        const [counts] = await query<{ succeeded: string; momo_in: string; cash_in: string; owed: string }>(
          collector,
          sql`SELECT
                count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
                coalesce(sum(received_pesewas) FILTER (WHERE method = 'momo' AND status IN ('succeeded', 'duplicate', 'mismatch')), 0) AS momo_in,
                coalesce(sum(received_pesewas) FILTER (WHERE method = 'cash'), 0) AS cash_in,
                coalesce(sum(received_pesewas) FILTER (WHERE status IN ('duplicate', 'mismatch')), 0) AS owed
              FROM contributions`,
        );
        expect(b[`round:${round.id}`] ?? 0, `seed ${seed}, step ${step}: pot`).toBe(0 - Number(counts.succeeded) * AMOUNT);
        expect(b["clearing:fake"] ?? 0, `seed ${seed}, step ${step}: held at provider`).toBe(Number(counts.momo_in));
        expect(b.cash ?? 0, `seed ${seed}, step ${step}: cash`).toBe(Number(counts.cash_in));
        expect(b.refunds_due ?? 0, `seed ${seed}, step ${step}: refunds`).toBe(0 - Number(counts.owed));
        expect(Number(counts.succeeded)).toBeLessThanOrEqual(everyone.length);
      }
    }
  });
});
