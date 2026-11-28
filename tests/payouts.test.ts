import { sql } from "drizzle-orm";
import { PesewaError, type PayoutRequest, type PayoutResult } from "pesewa";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/db/tenant";
import type { FakeProvider } from "@/lib/payments/fake";
import { recordCashContribution, startContribution } from "@/lib/services/contributions";
import { createDraftCycle, getOpenCycle } from "@/lib/services/cycles";
import type { OrgContext } from "@/lib/services/orgs";
import {
  checkPayout,
  closeCycle,
  listRefunds,
  recordCashDeposit,
  setPayoutAccount,
  startRefund,
  startRoundPayout,
} from "@/lib/services/payouts";
import { reconcile } from "@/lib/services/reconciliation";
import { processWebhook } from "@/lib/services/webhooks";
import { addMember } from "./helpers";
import { AMOUNT, PAY_DAY, approve, balances, fake, pay, query, referenceOf, runningCycle } from "./payments-helpers";

type Group = Awaited<ReturnType<typeof runningCycle>>;

/** Everyone pays round `n` by MoMo, and the recipient has a payout number. */
async function fullRound(group: Group, n = 0, payoutPhone = "0551234567") {
  const round = group.view.rounds[n];
  for (const member of group.everyone) await pay(member, round.id);
  const recipient = group.everyone.find((m) => m.userId === round.recipientUserId)!;
  await setPayoutAccount(recipient, { phone: payoutPhone });
  return { round, recipient };
}

async function payoutRows(ctx: OrgContext) {
  return query<{ id: string; status: string; reference: string; amount_pesewas: string; kind: string }>(
    ctx,
    sql`SELECT id, status, reference, amount_pesewas, kind FROM payouts ORDER BY created_at`,
  );
}

async function roundStatus(ctx: OrgContext, n = 0) {
  return (await getOpenCycle(ctx))!.rounds[n].status;
}

/** The provider finishes the payout and sends its webhook. */
async function providerSettles(ctx: OrgContext, outcome: "success" | "failed" | "reversed") {
  const [latest] = (await payoutRows(ctx)).slice(-1);
  fake().settlePayout(latest.reference, outcome);
  return processWebhook("fake", fake().webhookFor(latest.reference, "payout"));
}

/** Swaps the fake provider's payout() for a test, then restores it. */
function overridePayout(fn: (original: FakeProvider["payout"], req: PayoutRequest) => Promise<PayoutResult>): () => void {
  const provider = fake();
  const original = provider.payout.bind(provider);
  provider.payout = (req) => fn(original, req);
  return () => {
    provider.payout = original;
  };
}

const POT = 3 * AMOUNT;

describe("paying out a round", () => {
  it("sends the pot by MoMo once it's full, and books it when the provider confirms", async () => {
    const group = await runningCycle(3);
    const { round } = await fullRound(group);
    expect(await roundStatus(group.collector)).toBe("full");

    expect((await startRoundPayout(group.collector, round.id, "momo")).status).toBe("pending");
    expect(await roundStatus(group.collector)).toBe("full"); // not paid out until confirmed

    expect((await providerSettles(group.collector, "success")).outcome).toBe("succeeded");
    expect(await roundStatus(group.collector)).toBe("paid_out");
    expect(await balances(group.collector)).toEqual({ "clearing:fake": 0, [`round:${round.id}`]: 0 });
  });

  it("only pays out full rounds, and only the collector can", async () => {
    const group = await runningCycle(3);
    const round = group.view.rounds[0];
    await pay(group.collector, round.id);
    await expect(startRoundPayout(group.collector, round.id, "momo")).rejects.toThrow(/isn't full yet/);

    for (const member of group.everyone.slice(1)) await pay(member, round.id);
    const treasurer = await addMember(group.collector, "Treasurer", "treasurer");
    await expect(startRoundPayout(treasurer, round.id, "momo")).rejects.toMatchObject({ code: "forbidden" });
    await expect(startRoundPayout(group.members[0], round.id, "momo")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("needs the recipient's own payout number", async () => {
    const group = await runningCycle(2);
    const round = group.view.rounds[0];
    for (const member of group.everyone) await pay(member, round.id);
    await expect(startRoundPayout(group.collector, round.id, "momo")).rejects.toThrow(/hasn't added a payout number/);
  });

  it("sends one payout when the button is pressed twice at once", async () => {
    const group = await runningCycle(3);
    const { round } = await fullRound(group);
    const results = await Promise.allSettled([startRoundPayout(group.collector, round.id, "momo"), startRoundPayout(group.collector, round.id, "momo")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(await payoutRows(group.collector)).toHaveLength(1);
    // And a third try while it's in flight
    await expect(startRoundPayout(group.collector, round.id, "momo")).rejects.toThrow(/already on its way/);
  });

  it("can retry after a wallet rejects it, and the recipient can fix their number", async () => {
    const group = await runningCycle(2);
    const { round, recipient } = await fullRound(group, 0, "0550000000"); // test number: rejected
    await expect(startRoundPayout(group.collector, round.id, "momo")).resolves.toHaveProperty("status", "failed");
    expect(await roundStatus(group.collector)).toBe("full");

    await setPayoutAccount(recipient, { phone: "0551234567" });
    await startRoundPayout(group.collector, round.id, "momo");
    await providerSettles(group.collector, "success");
    expect((await payoutRows(group.collector)).map((p) => p.status)).toEqual(["failed", "succeeded"]);
    expect(await balances(group.collector)).toMatchObject({ "clearing:fake": 0, [`round:${round.id}`]: 0 });
  });

  it("won't let the recipient move their number while a payout is on its way", async () => {
    const group = await runningCycle(2);
    const { round, recipient } = await fullRound(group);
    await startRoundPayout(group.collector, round.id, "momo");
    await expect(setPayoutAccount(recipient, { phone: "0249999999" })).rejects.toThrow(/on its way/);
  });

  it("never marks a timed-out payout failed: the money may have gone, and checking finds out", async () => {
    const group = await runningCycle(2);
    const { round } = await fullRound(group);
    // The provider accepts the transfer, but the reply never reaches us
    const restore = overridePayout(async (original, req) => {
      await original(req);
      throw new PesewaError("network", "fake request timed out", { provider: "fake" });
    });
    try {
      expect((await startRoundPayout(group.collector, round.id, "momo")).status).toBe("pending");
    } finally {
      restore();
    }
    // No retry is possible while it's pending, so nothing can be sent twice
    await expect(startRoundPayout(group.collector, round.id, "momo")).rejects.toThrow(/already on its way/);

    const [p] = await payoutRows(group.collector);
    fake().settlePayout(p.reference, "success");
    expect(await checkPayout(group.collector, p.id)).toBe("succeeded");
    expect(await roundStatus(group.collector)).toBe("paid_out");
  });

  it("processes a payout webhook delivered twice only once", async () => {
    const group = await runningCycle(2);
    const { round } = await fullRound(group);
    await startRoundPayout(group.collector, round.id, "momo");
    const [p] = await payoutRows(group.collector);
    fake().settlePayout(p.reference, "success");
    const webhook = fake().webhookFor(p.reference, "payout");
    expect((await processWebhook("fake", webhook)).outcome).toBe("succeeded");
    expect((await processWebhook("fake", webhook)).outcome).toBe("duplicate_event");
    expect(await checkPayout(group.collector, p.id)).toBe("already_settled");
    const [{ n }] = await query<{ n: string }>(group.collector, sql`SELECT count(*) AS n FROM ledger_transactions WHERE kind = 'payout'`);
    expect(n).toBe("1");
  });

  it("undoes a payout the wallet reversed, and the round can be paid again", async () => {
    const group = await runningCycle(2);
    const { round } = await fullRound(group);
    await startRoundPayout(group.collector, round.id, "momo");
    await providerSettles(group.collector, "success");
    expect((await providerSettles(group.collector, "reversed")).outcome).toBe("reversed");

    expect(await roundStatus(group.collector)).toBe("full");
    expect(await balances(group.collector)).toMatchObject({ "clearing:fake": 2 * AMOUNT, [`round:${round.id}`]: -2 * AMOUNT });
    await startRoundPayout(group.collector, round.id, "momo");
    await providerSettles(group.collector, "success");
    expect((await payoutRows(group.collector)).map((p) => p.status)).toEqual(["reversed", "succeeded"]);
  });
});

describe("pots paid partly in cash", () => {
  async function mixedRound() {
    const group = await runningCycle(2);
    const round = group.view.rounds[0];
    await pay(group.collector, round.id); // MoMo
    await recordCashContribution(group.collector, { roundId: round.id, userId: group.members[0].userId }, PAY_DAY); // cash
    const recipient = group.everyone.find((m) => m.userId === round.recipientUserId)!;
    await setPayoutAccount(recipient, { phone: "0551234567" });
    return { group, round };
  }

  it("won't send more by MoMo than the provider holds, until the cash is deposited", async () => {
    const { group, round } = await mixedRound();
    await expect(startRoundPayout(group.collector, round.id, "momo")).rejects.toThrow(/Only GH₵ 50.00 is available/);
    await expect(recordCashDeposit(group.collector, { amount: "60" })).rejects.toThrow(/only shows GH₵ 50.00 in cash/);

    await recordCashDeposit(group.collector, { amount: "50", note: "MoMo agent" });
    await startRoundPayout(group.collector, round.id, "momo");
    await providerSettles(group.collector, "success");
    expect(await balances(group.collector)).toEqual({ "clearing:fake": 0, cash: 0, [`round:${round.id}`]: 0 });
  });

  it("can be paid out in cash only if the cash is there", async () => {
    const { group, round } = await mixedRound();
    await expect(startRoundPayout(group.collector, round.id, "cash")).rejects.toThrow(/Only GH₵ 50.00 of this pot was paid in cash/);

    const cashGroup = await runningCycle(2);
    const r = cashGroup.view.rounds[0];
    for (const m of cashGroup.everyone) await recordCashContribution(cashGroup.collector, { roundId: r.id, userId: m.userId }, PAY_DAY);
    expect((await startRoundPayout(cashGroup.collector, r.id, "cash")).status).toBe("succeeded");
    expect(await roundStatus(cashGroup.collector)).toBe("paid_out");
    expect(await balances(cashGroup.collector)).toEqual({ cash: 0, [`round:${r.id}`]: 0 });
  });
});

describe("refunds", () => {
  it("sends money paid twice back to the number it came from", async () => {
    const group = await runningCycle(2);
    const round = group.view.rounds[0];
    const [member] = group.members;
    const started = await startContribution(member, { roundId: round.id, phone: "0241234567" }, PAY_DAY);
    await recordCashContribution(group.collector, { roundId: round.id, userId: member.userId }, PAY_DAY);
    await approve(member, started.contributionId); // → duplicate, owed back

    const [owed] = await listRefunds(group.collector);
    expect(owed).toMatchObject({ status: "duplicate", phone: "0241234567", refund: null });
    await expect(startRefund(group.members[0], owed.contributionId)).rejects.toMatchObject({ code: "forbidden" });

    await startRefund(group.collector, owed.contributionId);
    await expect(startRefund(group.collector, owed.contributionId)).rejects.toThrow(/already on its way/);
    await providerSettles(group.collector, "success");

    const [refund] = await payoutRows(group.collector);
    expect(refund).toMatchObject({ kind: "refund", status: "succeeded", amount_pesewas: String(AMOUNT) });
    expect(await balances(group.collector)).toMatchObject({ "clearing:fake": 0, refunds_due: 0 });
    expect((await listRefunds(group.collector))[0].refund?.status).toBe("succeeded");
  });
});

describe("closing a cycle", () => {
  it("needs every round paid out, then the next cycle can start", async () => {
    const group = await runningCycle(2);
    await expect(closeCycle(group.collector, group.view.cycle.id)).rejects.toThrow(/Round 1, 2 hasn't been paid out/);

    for (const n of [0, 1]) {
      const round = group.view.rounds[n];
      for (const m of group.everyone) await recordCashContribution(group.collector, { roundId: round.id, userId: m.userId }, PAY_DAY);
      await startRoundPayout(group.collector, round.id, "cash");
    }
    await closeCycle(group.collector, group.view.cycle.id);
    expect(await getOpenCycle(group.collector)).toBeNull();
    const next = await createDraftCycle(group.collector, { amount: "50", frequency: "weekly", startsOn: "2027-02-01", orderMethod: "random" }, PAY_DAY);
    expect(next.number).toBe(2);
  });
});

describe("the database enforces payouts, whatever the app does", () => {
  async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      return e.cause?.code ?? e.code;
    }
    return undefined;
  }
  const raw = (ctx: OrgContext, q: ReturnType<typeof sql>) => withTenant(ctx.org.schemaName, (db) => db.execute(q));

  it("won't mark a round paid out without a successful payout, or a second payout in flight", async () => {
    const group = await runningCycle(2);
    const { round } = await fullRound(group);
    expect(await pgError(raw(group.collector, sql`UPDATE rounds SET status = 'paid_out' WHERE id = ${round.id}`))).toBe("23514");

    await startRoundPayout(group.collector, round.id, "momo");
    expect(
      await pgError(
        raw(
          group.collector,
          sql`INSERT INTO payouts (kind, round_id, recipient_user_id, amount_pesewas, method, provider, reference, phone, status)
              SELECT 'round', id, recipient_user_id, ${POT}, 'momo', 'fake', gen_random_uuid(), '0551234567', 'pending' FROM rounds WHERE id = ${round.id}`,
        ),
      ),
    ).toBe("23505");
  });

  it("won't change a payout's amount or destination, revive a failed one, or delete one", async () => {
    const group = await runningCycle(2);
    const { round } = await fullRound(group, 0, "0550000000");
    await startRoundPayout(group.collector, round.id, "momo"); // rejected → failed
    for (const statement of [
      sql`UPDATE payouts SET amount_pesewas = 1`,
      sql`UPDATE payouts SET phone = '0249999999'`,
      sql`UPDATE payouts SET status = 'succeeded'`,
      sql`DELETE FROM payouts`,
    ]) {
      expect(await pgError(raw(group.collector, statement))).toBe("23514");
    }
  });

  it("won't close a cycle with rounds still to pay out", async () => {
    const group = await runningCycle(2);
    expect(await pgError(raw(group.collector, sql`UPDATE cycles SET status = 'closed'`))).toBe("23514");
  });
});

describe("reconciliation", () => {
  it("catches up a payment and a payout whose webhooks were lost, then everything matches", async () => {
    const group = await runningCycle(2);
    const round = group.view.rounds[0];
    await pay(group.collector, round.id);
    // The second member approves, but the webhook never arrives
    const lost = await startContribution(group.members[0], { roundId: round.id, phone: "0241234568" }, PAY_DAY);
    fake().settle(await referenceOf(group.members[0], lost.contributionId), "success");
    const recipient = group.everyone.find((m) => m.userId === round.recipientUserId)!;
    await setPayoutAccount(recipient, { phone: "0551234567" });

    const first = await reconcile(group.collector);
    expect(first.fixed).toBe(1);
    expect(first.problems).toBe(0);
    expect(await roundStatus(group.collector)).toBe("full");

    // Now the payout's webhook is lost too
    await startRoundPayout(group.collector, round.id, "momo");
    const [p] = await payoutRows(group.collector);
    fake().settlePayout(p.reference, "success");
    const second = await reconcile(group.collector);
    expect(second.items.find((i) => i.kind === "payout")).toMatchObject({ result: "fixed" });
    expect(await roundStatus(group.collector)).toBe("paid_out");

    const third = await reconcile(group.collector);
    expect(third.fixed).toBe(0);
    expect(third.problems).toBe(0);
    expect(third.items.filter((i) => i.kind === "ledger").map((i) => i.result)).toEqual(["matched", "matched"]);
  });

  it("flags money we counted that the provider says never arrived", async () => {
    const group = await runningCycle(2);
    const round = group.view.rounds[0];
    const id = await pay(group.collector, round.id);
    fake().settle(await referenceOf(group.collector, id), "failed"); // the provider changes its story

    const summary = await reconcile(group.collector);
    expect(summary.problems).toBe(1);
    expect(summary.items.find((i) => i.result === "problem")).toMatchObject({ kind: "contribution", ours: "succeeded", theirs: "failed" });
  });

  it("is for collectors and treasurers", async () => {
    const group = await runningCycle(2);
    await expect(reconcile(group.members[0])).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the books always balance with payouts too (randomised)", () => {
  function prng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
  }

  it("after any mix of contributions, cash, payouts, rejections, reversals and deposits", async () => {
    for (const seed of [7, 8]) {
      const random = prng(seed);
      const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
      const group = await runningCycle(3);
      for (const m of group.everyone) await setPayoutAccount(m, { phone: "0551234567" });

      for (let step = 0; step < 16; step++) {
        const round = pick(group.view.rounds.slice(0, 2));
        const action = pick(["momo", "momo", "cash", "payout", "payout_cash", "settle", "settle", "reverse", "deposit"] as const);
        try {
          if (action === "momo") await pay(pick(group.everyone), round.id);
          else if (action === "cash") await recordCashContribution(group.collector, { roundId: round.id, userId: pick(group.everyone).userId }, PAY_DAY);
          else if (action === "payout") await startRoundPayout(group.collector, round.id, "momo");
          else if (action === "payout_cash") await startRoundPayout(group.collector, round.id, "cash");
          else if (action === "deposit") await recordCashDeposit(group.collector, { amount: "50" });
          else {
            const pending = (await payoutRows(group.collector)).filter((p) => p.status === (action === "reverse" ? "succeeded" : "pending"));
            if (pending.length) {
              const p = pick(pending);
              fake().settlePayout(p.reference, action === "reverse" ? "reversed" : pick(["success", "success", "failed"] as const));
              await processWebhook("fake", fake().webhookFor(p.reference, "payout"));
            }
          }
        } catch (error) {
          if (!(error as { code?: string }).code) throw error; // only expected refusals
        }

        const b = await balances(group.collector);
        expect(Object.values(b).reduce((s, v) => s + v, 0), `seed ${seed}, step ${step}: sums to zero`).toBe(0);
        expect(b["clearing:fake"] ?? 0, `seed ${seed}, step ${step}: never overdrawn`).toBeGreaterThanOrEqual(0);
        expect(b.cash ?? 0, `seed ${seed}, step ${step}: cash never negative`).toBeGreaterThanOrEqual(0);
      }
      const summary = await reconcile(group.collector);
      expect(summary.items.filter((i) => i.kind === "ledger").map((i) => i.result), `seed ${seed}: ledger matches records`).toEqual(["matched", "matched"]);
      expect(summary.problems, `seed ${seed}: no problems`).toBe(0);
    }
  });
});
