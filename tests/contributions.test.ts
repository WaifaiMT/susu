import { processWebhook } from "@/lib/services/webhooks";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/webhooks/[provider]/route";
import { getProvider } from "@/lib/payments";
import { FAKE_OTP } from "@/lib/payments/fake";
import { checkContribution, listCycleContributions, recordCashContribution, startContribution, submitContributionOtp } from "@/lib/services/contributions";
import { getOpenCycle } from "@/lib/services/cycles";
import { getLedgerOverview } from "@/lib/services/ledger";
import { addMember } from "./helpers";
import { AMOUNT, PAY_DAY, approve, balances, decline, fake, pay, query, referenceOf, runningCycle, withSlowCollect } from "./payments-helpers";

const statusOf = async (ctx: Parameters<typeof query>[0], id: string) =>
  (await query<{ status: string }>(ctx, sql`SELECT status FROM contributions WHERE id = ${id}`))[0].status;
const ledgerTransactions = async (ctx: Parameters<typeof query>[0]) =>
  (await query<{ n: string }>(ctx, sql`SELECT count(*) AS n FROM ledger_transactions`))[0].n;

describe("paying a contribution with Mobile Money", () => {
  it("goes pending → paid, posts to the ledger, and fills the round when everyone has paid", async () => {
    const { everyone, round1 } = await runningCycle(3);
    const [ama] = everyone;

    const started = await startContribution(ama, { roundId: round1.id, phone: "024 123 4567" }, PAY_DAY);
    expect(started.status).toBe("pending");
    expect(await approve(ama, started.contributionId)).toEqual({ status: 200, outcome: "succeeded" });
    expect(await statusOf(ama, started.contributionId)).toBe("succeeded");
    expect(await balances(ama)).toEqual({ "clearing:fake": AMOUNT, [`round:${round1.id}`]: -AMOUNT });
    expect((await getOpenCycle(ama))!.rounds[0].status).toBe("open");

    await pay(everyone[1], round1.id);
    await pay(everyone[2], round1.id);
    expect((await getOpenCycle(ama))!.rounds[0].status).toBe("full");
    expect(await balances(ama)).toEqual({ "clearing:fake": 3 * AMOUNT, [`round:${round1.id}`]: -3 * AMOUNT });
  });

  it("processes a webhook delivered twice only once", async () => {
    const { collector, round1 } = await runningCycle(2);
    const started = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    const reference = await referenceOf(collector, started.contributionId);
    fake().settle(reference, "success");
    const webhook = fake().webhookFor(reference);

    expect((await processWebhook("fake", webhook)).outcome).toBe("succeeded");
    expect((await processWebhook("fake", webhook)).outcome).toBe("duplicate_event");
    expect((await checkContribution(collector, started.contributionId))).toBe("already_settled");
    expect(await ledgerTransactions(collector)).toBe("1");
  });

  it("keeps a payment that a webhook settled before the provider's reply arrived", async () => {
    const { collector, round1 } = await runningCycle(2);
    const restore = withSlowCollect(async (reference) => {
      fake().settle(reference, "success");
      await processWebhook("fake", fake().webhookFor(reference));
    });
    try {
      const started = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
      // collect() replied "pending", but the webhook had already settled it: pending must not win
      expect(started.status).toBe("succeeded");
    } finally {
      restore();
    }
  });

  it("lets a member try again after a declined payment", async () => {
    const { collector, round1 } = await runningCycle(2);
    const declined = await startContribution(collector, { roundId: round1.id, phone: "0240000000" }, PAY_DAY);
    expect(declined.status).toBe("failed");

    const second = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    expect((await decline(collector, second.contributionId)).outcome).toBe("failed");

    const third = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    expect((await approve(collector, third.contributionId)).outcome).toBe("succeeded");
    expect(await ledgerTransactions(collector)).toBe("1");
  });

  it("sends only one prompt when the member pays from two tabs at once", async () => {
    const { collector, round1 } = await runningCycle(2);
    const results = await Promise.allSettled([
      startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY),
      startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
  });

  it("handles the OTP step, and a wrong OTP can be retried", async () => {
    const { collector, round1 } = await runningCycle(2);
    const started = await startContribution(collector, { roundId: round1.id, phone: "0241111111" }, PAY_DAY);
    expect(started.status).toBe("otp_required");

    await expect(submitContributionOtp(collector, started.contributionId, "000000")).rejects.toMatchObject({ code: "validation" });
    expect(await statusOf(collector, started.contributionId)).toBe("otp_required");

    expect((await submitContributionOtp(collector, started.contributionId, FAKE_OTP)).status).toBe("pending");
    expect((await approve(collector, started.contributionId)).outcome).toBe("succeeded");
  });

  it("books a wrong amount as owed back, without counting it towards the round", async () => {
    const { collector, round1 } = await runningCycle(2);
    const started = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    expect((await approve(collector, started.contributionId, 4000)).outcome).toBe("mismatch");
    expect(await balances(collector)).toEqual({ "clearing:fake": 4000, refunds_due: -4000 });

    // They still owe the round, and can pay it properly
    await pay(collector, round1.id);
    expect(await balances(collector)).toMatchObject({ [`round:${round1.id}`]: -AMOUNT, refunds_due: -4000 });
  });

  it("books a second payment for the same round as owed back", async () => {
    const { collector, members, round1 } = await runningCycle(2);
    const [member] = members;
    const started = await startContribution(member, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    // While the prompt waits, the treasurer records that they paid cash instead
    await recordCashContribution(collector, { roundId: round1.id, userId: member.userId }, PAY_DAY);
    // Then the member approves the prompt anyway
    expect((await approve(member, started.contributionId)).outcome).toBe("duplicate");

    expect(await balances(collector)).toEqual({
      cash: AMOUNT,
      [`round:${round1.id}`]: -AMOUNT,
      "clearing:fake": AMOUNT,
      refunds_due: -AMOUNT,
    });
  });

  it("marks the round full exactly once when the last two payments land together", async () => {
    const { everyone, round1 } = await runningCycle(3);
    await pay(everyone[0], round1.id);
    const a = await startContribution(everyone[1], { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    const b = await startContribution(everyone[2], { roundId: round1.id, phone: "0241234568" }, PAY_DAY);
    await Promise.all([approve(everyone[1], a.contributionId), approve(everyone[2], b.contributionId)]);
    expect((await getOpenCycle(everyone[0]))!.rounds[0].status).toBe("full");
  });

  it("refuses rounds that aren't open yet, are already full, or are already paid", async () => {
    const { everyone, view, round1 } = await runningCycle(2);
    const [ama, kofi] = everyone;
    await pay(ama, round1.id);
    await expect(startContribution(ama, { roundId: round1.id, phone: "0241234567" }, PAY_DAY)).rejects.toThrow(/already paid/);
    await pay(kofi, round1.id);
    await expect(startContribution(kofi, { roundId: round1.id, phone: "0241234567" }, PAY_DAY)).rejects.toThrow(/already full/);
    // Round 2 is due a week later; it's the next one, so it's payable early
    await expect(startContribution(ama, { roundId: view.rounds[1].id, phone: "0241234567" }, PAY_DAY)).resolves.toHaveProperty("status", "pending");
  });

  it("only takes rounds up to the next one due", async () => {
    const { collector, view } = await runningCycle(3);
    await expect(startContribution(collector, { roundId: view.rounds[2].id, phone: "0241234567" }, PAY_DAY)).rejects.toThrow(/isn't open for payments yet/);
  });

  it("checks the phone number and network", async () => {
    const { collector, round1 } = await runningCycle(2);
    await expect(startContribution(collector, { roundId: round1.id, phone: "12345" }, PAY_DAY)).rejects.toThrow(/Ghana mobile number/);
    await expect(startContribution(collector, { roundId: round1.id, phone: "0221234567" }, PAY_DAY)).rejects.toThrow(/Pick MTN, Telecel, or AT/);
    await expect(startContribution(collector, { roundId: round1.id, phone: "0221234567", network: "telecel" }, PAY_DAY)).resolves.toHaveProperty(
      "status",
      "pending",
    );
  });

  it("is only for people in the cycle", async () => {
    const { collector, round1 } = await runningCycle(2);
    const latecomer = await addMember(collector, "Latecomer");
    await expect(startContribution(latecomer, { roundId: round1.id, phone: "0241234567" }, PAY_DAY)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("cash contributions", () => {
  it("can be recorded by collectors and treasurers, once, and count towards the round", async () => {
    const { collector, members, round1 } = await runningCycle(3);
    const treasurer = await addMember(collector, "Treasurer", "treasurer");
    const [member, other] = members;

    await expect(recordCashContribution(member, { roundId: round1.id, userId: other.userId }, PAY_DAY)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(recordCashContribution(treasurer, { roundId: round1.id, userId: treasurer.userId }, PAY_DAY)).rejects.toMatchObject({
      code: "forbidden", // joined after the cycle started, so not in it
    });

    await recordCashContribution(treasurer, { roundId: round1.id, userId: member.userId }, PAY_DAY);
    await expect(recordCashContribution(collector, { roundId: round1.id, userId: member.userId }, PAY_DAY)).rejects.toThrow(/already paid/);
    await recordCashContribution(collector, { roundId: round1.id, userId: collector.userId }, PAY_DAY);
    await recordCashContribution(collector, { roundId: round1.id, userId: other.userId }, PAY_DAY);

    expect((await getOpenCycle(collector))!.rounds[0].status).toBe("full");
    expect(await balances(collector)).toEqual({ cash: 3 * AMOUNT, [`round:${round1.id}`]: -3 * AMOUNT });
  });
});

describe("webhooks", () => {
  const request = (body: string, headers: Record<string, string>) =>
    new Request("http://localhost/api/webhooks/fake", { method: "POST", body, headers });
  const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

  it("rejects a forged signature and records nothing", async () => {
    const { collector, round1 } = await runningCycle(2);
    const started = await startContribution(collector, { roundId: round1.id, phone: "0241234567" }, PAY_DAY);
    const reference = await referenceOf(collector, started.contributionId);
    fake().settle(reference, "success");
    const genuine = fake().webhookFor(reference);

    const forged = await POST(request(genuine.body, { "x-fake-signature": "0".repeat(64) }), params("fake"));
    expect(forged.status).toBe(401);
    const tampered = await POST(request(genuine.body.replace("payment.updated", "payment.updatex"), genuine.headers as Record<string, string>), params("fake"));
    expect(tampered.status).toBe(401);
    expect(await statusOf(collector, started.contributionId)).toBe("pending");

    const real = await POST(request(genuine.body, genuine.headers as Record<string, string>), params("fake"));
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual({ outcome: "succeeded" });
  });

  it("answers 404 for providers that aren't enabled", async () => {
    const response = await POST(request("{}", {}), params("paystack"));
    expect(response.status).toBe(404);
  });

  it("acknowledges payments it doesn't know, so the provider stops retrying", async () => {
    const reference = crypto.randomUUID();
    await fake().collect({ amount: 100, phone: "0241234567", reference });
    fake().settle(reference, "success");
    expect(await processWebhook("fake", fake().webhookFor(reference))).toEqual({ status: 200, outcome: "unknown_reference" });
  });

  it("never touches another group's payments", async () => {
    const a = await runningCycle(2);
    const b = await runningCycle(2);
    const started = await startContribution(a.collector, { roundId: a.round1.id, phone: "0241234567" }, PAY_DAY);
    await approve(a.collector, started.contributionId);
    expect(await balances(a.collector)).toMatchObject({ "clearing:fake": AMOUNT });
    expect(await balances(b.collector)).toEqual({});
  });
});

describe("privacy and access", () => {
  it("shows everyone who has paid, but phone numbers only to the payer and the people who run the group", async () => {
    const { collector, members, view, round1 } = await runningCycle(3);
    await pay(members[0], round1.id, "0241234567");

    const asOther = await listCycleContributions(members[1], view.cycle.id);
    expect(asOther).toHaveLength(1);
    expect(asOther[0]).toMatchObject({ status: "succeeded", phone: null });
    expect((await listCycleContributions(members[0], view.cycle.id))[0].phone).toBe("0241234567");
    expect((await listCycleContributions(collector, view.cycle.id))[0].phone).toBe("0241234567");
  });

  it("keeps the ledger to collectors and treasurers", async () => {
    const { members } = await runningCycle(2);
    await expect(getLedgerOverview(members[0])).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("payment configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses live Paystack keys and a non-sandbox MTN environment", () => {
    process.env.PAYMENTS_PROVIDER = "paystack";
    process.env.PAYSTACK_SECRET_KEY = "sk_live_abc";
    expect(() => getProvider()).toThrow(/TEST keys/);

    process.env.PAYMENTS_PROVIDER = "mtn_momo";
    process.env.MTN_MOMO_ENVIRONMENT = "mtnghana";
    expect(() => getProvider()).toThrow(/sandbox/);
  });
});
