import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { PesewaError, detectNetwork, normalizeGhanaPhone, type Network, type Payout, type PayoutResult } from "pesewa";
import {
  cashDeposits,
  contributions,
  cycleMembers,
  cycles,
  paymentReferences,
  payoutAccounts,
  payouts,
  rounds,
  users,
  type PayoutRowStatus,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AppError } from "../errors";
import { parseId } from "../ids";
import { accountBalance, postTransaction } from "../ledger";
import { formatCedis, parseCedis } from "../money";
import { configuredProviderName, currencyFor, getPayoutProvider } from "../payments";
import { assertCan, can } from "../permissions";
import { recordAudit } from "./audit";
import { findOrganization, lockRound } from "./contributions";
import type { OrgContext } from "./orgs";

// How a payout moves (rounds and refunds alike):
//
//   start   → payout row saved as `pending` with a fresh UUID reference and COMMITTED,
//             then the provider is called. Retries reuse the same reference, and providers
//             refuse a reference they've seen, so a retry can't send the money twice.
//   settle  → confirmed with the provider (webhook or status check), then in one
//             transaction: status, ledger, and the round marked paid_out.
//
// A payout is only marked failed when the provider says so, or refused the request
// outright. A timeout or a server error leaves it pending: the money may have gone,
// and the status check or reconciliation will find out.
//
// The database has the last word: at most one live or successful payout per round,
// and a round can only be paid_out with a successful payout on record (0003_payouts.sql).

export type PayoutOutcome = "succeeded" | "failed" | "reversed" | "still_pending" | "already_settled" | "needs_attention" | "unknown_reference";

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/** Serialises payouts within a group, so two can't both spend the same balance. */
async function lockPayouts(db: TenantDb) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':payouts'))`);
}

/** A clear message before the database's unique index would refuse it anyway. */
async function assertNoLivePayout(db: TenantDb, match: ReturnType<typeof eq>, message: string) {
  const [live] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(match, inArray(payouts.status, ["pending", "succeeded"])));
  if (live) throw new AppError("conflict", message);
}

/** Money at the provider that isn't already promised to a payout in flight. */
async function availableAtProvider(db: TenantDb, provider: string): Promise<number> {
  const balance = await accountBalance(db, `clearing:${provider}`);
  const [{ inFlight }] = await db
    .select({ inFlight: sql<string>`coalesce(sum(${payouts.amountPesewas}), 0)` })
    .from(payouts)
    .where(and(eq(payouts.provider, provider), eq(payouts.status, "pending")));
  return balance - Number(inFlight);
}

// ---- Payout numbers ------------------------------------------------------------

export async function getPayoutAccount(ctx: OrgContext, userIdInput = ctx.userId) {
  const userId = parseId(userIdInput);
  if (userId !== ctx.userId) assertCan(ctx.role, "payouts:send");
  const [row] = await withTenant(ctx.org.schemaName, (db) => db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, userId)));
  return row ?? null;
}

/** Sets where the signed-in member's payouts go. Only the member can change their own. */
export async function setPayoutAccount(ctx: OrgContext, input: { phone: string; network?: string }) {
  assertCan(ctx.role, "cycles:read");
  let local: string;
  try {
    local = normalizeGhanaPhone(input.phone).local;
  } catch {
    throw new AppError("validation", "Enter a Ghana mobile number, like 024 123 4567.");
  }
  const network = (input.network && ["mtn", "telecel", "at"].includes(input.network) ? input.network : detectNetwork(local)) as Network | null;
  if (!network) throw new AppError("validation", "We can't tell the network for that number. Pick MTN, Telecel, or AT.");

  await withTenant(ctx.org.schemaName, async (db) => {
    // Don't move the destination while money is on its way there
    const [inFlight] = await db
      .select({ id: payouts.id })
      .from(payouts)
      .where(and(eq(payouts.recipientUserId, ctx.userId), eq(payouts.status, "pending"), eq(payouts.method, "momo")));
    if (inFlight) throw new AppError("conflict", "A payout to you is on its way. You can change your number once it arrives.");

    const [before] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, ctx.userId));
    await db
      .insert(payoutAccounts)
      .values({ userId: ctx.userId, phone: local, network })
      .onConflictDoUpdate({ target: payoutAccounts.userId, set: { phone: local, network, updatedAt: new Date() } });
    await recordAudit(db, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "payout_account.set",
      // Last digits only: enough to notice a change, not enough to harvest numbers
      metadata: { from: before ? `…${before.phone.slice(-4)}` : null, to: `…${local.slice(-4)}`, network },
    });
  });
}

// ---- Reading -------------------------------------------------------------------

export async function listCyclePayouts(ctx: OrgContext, cycleIdInput: string) {
  assertCan(ctx.role, "cycles:read");
  const cycleId = parseId(cycleIdInput);
  const rows = await withTenant(ctx.org.schemaName, (db) =>
    db
      .select({
        id: payouts.id,
        roundId: payouts.roundId,
        recipientUserId: payouts.recipientUserId,
        amountPesewas: payouts.amountPesewas,
        method: payouts.method,
        status: payouts.status,
        phone: payouts.phone,
        failureReason: payouts.failureReason,
        createdAt: payouts.createdAt,
        settledAt: payouts.settledAt,
      })
      .from(payouts)
      .innerJoin(rounds, eq(rounds.id, payouts.roundId))
      .where(and(eq(payouts.kind, "round"), eq(rounds.cycleId, cycleId)))
      .orderBy(asc(payouts.createdAt)),
  );
  const seesPhones = can(ctx.role, "payouts:send");
  return rows.map((r) => (seesPhones || r.recipientUserId === ctx.userId ? r : { ...r, phone: null }));
}

/** Who has a payout number on file, with the last digits only. For the collector deciding how to pay a pot. */
export async function listPayoutAccountHints(ctx: OrgContext) {
  assertCan(ctx.role, "payouts:send");
  const rows = await withTenant(ctx.org.schemaName, (db) => db.select().from(payoutAccounts));
  return rows.map((r) => ({ userId: r.userId, hint: `…${r.phone.slice(-4)}`, network: r.network }));
}

/** Refunds owed (paid twice / wrong amount) with the latest refund attempt for each. */
export async function listRefunds(ctx: OrgContext) {
  assertCan(ctx.role, "ledger:read");
  return withTenant(ctx.org.schemaName, async (db) => {
    const owed = await db
      .select({
        contributionId: contributions.id,
        status: contributions.status,
        receivedPesewas: contributions.receivedPesewas,
        amountPesewas: contributions.amountPesewas,
        phone: contributions.phone,
        userName: users.name,
        roundNumber: rounds.number,
      })
      .from(contributions)
      .innerJoin(users, eq(users.id, contributions.userId))
      .innerJoin(rounds, eq(rounds.id, contributions.roundId))
      .where(inArray(contributions.status, ["duplicate", "mismatch"]))
      .orderBy(asc(contributions.settledAt));
    const attempts = owed.length
      ? await db
          .select()
          .from(payouts)
          .where(and(eq(payouts.kind, "refund"), inArray(payouts.contributionId, owed.map((o) => o.contributionId))))
          .orderBy(asc(payouts.createdAt))
      : [];
    return owed.map((o) => ({ ...o, refund: attempts.filter((a) => a.contributionId === o.contributionId).at(-1) ?? null }));
  });
}

// ---- Sending ---------------------------------------------------------------------

type Started = { payoutId: string; reference: string; amountPesewas: number; phone: string; network: Network; name: string; reason: string };

/** Pays a full round's pot to its recipient, by MoMo or in cash. Collectors only. */
export async function startRoundPayout(ctx: OrgContext, roundIdInput: string, method: "momo" | "cash") {
  assertCan(ctx.role, "payouts:send");
  const roundId = parseId(roundIdInput);
  const provider = method === "momo" ? getPayoutProvider() : null;
  if (method === "momo" && !provider) {
    throw new AppError("validation", "The payment provider isn't set up for payouts. Pay this pot out in cash, or add the payout keys.");
  }

  let started: Started | null;
  try {
    started = await withTenant(ctx.org.schemaName, async (db) => {
      const { round, cycle } = await lockRound(db, roundId);
      if (cycle.status !== "active") throw new AppError("conflict", "This cycle isn't running.");
      if (round.status === "paid_out") throw new AppError("conflict", `Round ${round.number} has already been paid out.`);
      if (round.status !== "full") throw new AppError("conflict", `Round ${round.number} isn't full yet: everyone has to pay in first.`);
      await lockPayouts(db);
      await assertNoLivePayout(db, eq(payouts.roundId, round.id), "A payout for this round is already on its way or done.");

      // The pot is whatever the ledger says is in it, and it must be exactly what the rules say
      const pot = -(await accountBalance(db, `round:${round.id}`));
      const [{ members }] = await db.select({ members: count() }).from(cycleMembers).where(eq(cycleMembers.cycleId, cycle.id));
      if (pot !== cycle.amountPesewas * members) {
        throw new AppError("conflict", `Round ${round.number}'s pot is ${formatCedis(pot)}, not the expected ${formatCedis(cycle.amountPesewas * members)}. Check the ledger.`);
      }
      const [recipient] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, round.recipientUserId));

      if (method === "cash") {
        const cash = await accountBalance(db, "cash");
        if (cash < pot) throw new AppError("validation", `Only ${formatCedis(cash)} of this pot was paid in cash. Pay it out by MoMo instead.`);
        const [row] = await db
          .insert(payouts)
          .values({
            kind: "round",
            roundId,
            recipientUserId: recipient.id,
            amountPesewas: pot,
            method: "cash",
            reference: randomUUID(),
            status: "succeeded",
            initiatedBy: ctx.userId,
            settledAt: new Date(),
          })
          .returning();
        await postTransaction(db, {
          kind: "payout",
          sourceId: row.id,
          memo: `Round ${round.number} paid out to ${recipient.name} (cash)`,
          entries: [
            { account: `round:${round.id}`, amountPesewas: pot, memberUserId: recipient.id },
            { account: "cash", amountPesewas: -pot, memberUserId: recipient.id },
          ],
        });
        await db.update(rounds).set({ status: "paid_out" }).where(eq(rounds.id, round.id));
        await recordAudit(db, {
          organizationId: ctx.org.id,
          actorId: ctx.userId,
          action: "payout.cash",
          target: `Round ${round.number}`,
          metadata: { recipient: recipient.id, amountPesewas: pot },
        });
        return null;
      }

      const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, recipient.id));
      if (!account) throw new AppError("validation", `${recipient.name} hasn't added a payout number yet. Ask them to add one on the Cycle page.`);
      const available = await availableAtProvider(db, provider!.name);
      if (available < pot) {
        throw new AppError(
          "validation",
          `Only ${formatCedis(Math.max(available, 0))} is available at the provider. Part of this pot was paid in cash: record a cash deposit on the Ledger page, or pay out in cash.`,
        );
      }
      const reference = randomUUID();
      const [row] = await db
        .insert(payouts)
        .values({
          kind: "round",
          roundId,
          recipientUserId: recipient.id,
          amountPesewas: pot,
          method: "momo",
          provider: provider!.name,
          reference,
          phone: account.phone,
          network: account.network,
          status: "pending",
          initiatedBy: ctx.userId,
        })
        .returning({ id: payouts.id });
      await db.insert(paymentReferences).values({ provider: provider!.name, reference, organizationId: ctx.org.id });
      await recordAudit(db, {
        organizationId: ctx.org.id,
        actorId: ctx.userId,
        action: "payout.started",
        target: `Round ${round.number}`,
        metadata: { reference, recipient: recipient.id, amountPesewas: pot, to: `…${account.phone.slice(-4)}` },
      });
      return {
        payoutId: row.id,
        reference,
        amountPesewas: pot,
        phone: account.phone,
        network: account.network,
        name: recipient.name,
        reason: `Susu: ${ctx.org.name}, round ${round.number}`,
      };
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new AppError("conflict", "A payout for this round is already on its way or done.");
    throw error;
  }

  if (!started) return { status: "succeeded" as PayoutRowStatus };
  return sendToProvider(ctx, started);
}

/** Sends a refund (paid twice, or the wrong amount) back to the number that paid it. Collectors only. */
export async function startRefund(ctx: OrgContext, contributionIdInput: string) {
  assertCan(ctx.role, "payouts:send");
  const contributionId = parseId(contributionIdInput);
  const provider = getPayoutProvider();
  if (!provider) throw new AppError("validation", "The payment provider isn't set up for payouts, so refunds can't be sent yet.");

  let started: Started;
  try {
    started = await withTenant(ctx.org.schemaName, async (db) => {
      await lockPayouts(db);
      const [c] = await db.select().from(contributions).where(eq(contributions.id, contributionId)).for("update");
      if (!c || !["duplicate", "mismatch"].includes(c.status)) throw new AppError("not_found", "There's no refund owed for that payment.");
      await assertNoLivePayout(db, eq(payouts.contributionId, c.id), "A refund for this payment is already on its way or done.");
      if (c.provider !== provider.name || !c.phone || !c.network) throw new AppError("validation", "That payment came through another provider.");
      const amount = c.receivedPesewas!;
      const available = await availableAtProvider(db, provider.name);
      if (available < amount) throw new AppError("validation", `Only ${formatCedis(Math.max(available, 0))} is available at the provider.`);
      const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, c.userId));
      const [round] = await db.select({ number: rounds.number }).from(rounds).where(eq(rounds.id, c.roundId));

      const reference = randomUUID();
      const [row] = await db
        .insert(payouts)
        .values({
          kind: "refund",
          contributionId,
          recipientUserId: c.userId,
          amountPesewas: amount,
          method: "momo",
          provider: provider.name,
          reference,
          // Back to the number the money came from, never a number someone typed in
          phone: c.phone,
          network: c.network,
          status: "pending",
          initiatedBy: ctx.userId,
        })
        .returning({ id: payouts.id });
      await db.insert(paymentReferences).values({ provider: provider.name, reference, organizationId: ctx.org.id });
      await recordAudit(db, {
        organizationId: ctx.org.id,
        actorId: ctx.userId,
        action: "refund.started",
        target: `Round ${round.number}`,
        metadata: { reference, recipient: c.userId, amountPesewas: amount },
      });
      return {
        payoutId: row.id,
        reference,
        amountPesewas: amount,
        phone: c.phone,
        network: c.network,
        name: user.name,
        reason: `Susu refund: ${ctx.org.name}, round ${round.number}`,
      };
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new AppError("conflict", "A refund for this payment is already on its way or done.");
    throw error;
  }
  return sendToProvider(ctx, started);
}

async function sendToProvider(ctx: OrgContext, s: Started): Promise<{ status: PayoutRowStatus; message?: string }> {
  const provider = getPayoutProvider()!;
  let result: PayoutResult;
  try {
    result = await provider.payout({
      amount: s.amountPesewas,
      currency: currencyFor(provider.name),
      phone: s.phone,
      network: s.network,
      reference: s.reference,
      name: s.name,
      reason: s.reason,
    });
  } catch (error) {
    if (error instanceof PesewaError) {
      const status = error.details.httpStatus;
      // Refused before anything was sent: safe to call it failed and let the collector retry
      const refused =
        error.code === "invalid_request" || error.code === "unsupported" || error.code === "authentication" || (error.code === "provider_error" && status !== undefined && status < 500);
      if (refused) {
        await markPendingFailed(ctx, s.payoutId, error.message);
        throw new AppError("validation", error.message.replace(/^[A-Za-z ]+: /, ""));
      }
      // duplicate_reference, network, 5xx: it may exist at the provider. Stay pending and ask.
      if (error.code === "duplicate_reference") {
        await checkPayout(ctx, s.payoutId);
        return { status: await payoutStatus(ctx, s.payoutId) };
      }
    }
    return { status: "pending", message: "We couldn't confirm the payout with the provider. It may still go through: check its status in a minute." };
  }

  if (result.status === "failed") {
    // Confirm before writing it off
    await checkPayout(ctx, s.payoutId);
  } else if (result.status !== "pending") {
    await checkPayout(ctx, s.payoutId);
  }
  return { status: await payoutStatus(ctx, s.payoutId), message: result.message };
}

async function payoutStatus(ctx: OrgContext, payoutId: string): Promise<PayoutRowStatus> {
  const [row] = await withTenant(ctx.org.schemaName, (db) => db.select({ status: payouts.status }).from(payouts).where(eq(payouts.id, payoutId)));
  return row.status;
}

async function markPendingFailed(ctx: OrgContext, payoutId: string, reason: string) {
  await withTenant(ctx.org.schemaName, async (db) => {
    await db
      .update(payouts)
      .set({ status: "failed", failureReason: reason, settledAt: new Date() })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")));
  });
}

/** A pending payout's reference and amount (for the test provider's simulator). */
export async function getPendingPayoutReference(ctx: OrgContext, payoutIdInput: string) {
  assertCan(ctx.role, "payouts:send");
  const payoutId = parseId(payoutIdInput);
  const [row] = await withTenant(ctx.org.schemaName, (db) => db.select().from(payouts).where(eq(payouts.id, payoutId)));
  if (!row || row.status !== "pending" || row.method !== "momo") throw new AppError("conflict", "This payout isn't waiting on the provider.");
  return { reference: row.reference, amountPesewas: row.amountPesewas };
}

/** Asks the provider for a payout's real status and applies it. */
export async function checkPayout(ctx: OrgContext, payoutIdInput: string): Promise<PayoutOutcome> {
  assertCan(ctx.role, "payouts:send");
  const payoutId = parseId(payoutIdInput);
  const [row] = await withTenant(ctx.org.schemaName, (db) => db.select().from(payouts).where(eq(payouts.id, payoutId)));
  if (!row) throw new AppError("not_found", "That payout doesn't exist.");
  if (row.method !== "momo") return "already_settled";
  const provider = getPayoutProvider(row.provider!);
  if (!provider) throw new AppError("validation", "That provider isn't set up for payouts any more.");
  let payout: Payout;
  try {
    payout = await provider.verifyPayout(row.reference);
  } catch (error) {
    if (error instanceof PesewaError && error.code === "not_found") {
      // The provider never received it: nothing went out, so it's safe to retry
      await markPendingFailed(ctx, row.id, "The provider has no record of this payout.");
      return "failed";
    }
    throw new AppError("conflict", "We couldn't reach the payment provider. Check the status again in a minute.");
  }
  return withTenant(ctx.org.schemaName, (db) => settlePayoutIn(db, ctx.org.id, provider.name, payout));
}

/** Applies a payout status that was confirmed with the provider. Safe to call any number of times. */
export async function settlePayout(providerName: string, payout: Payout): Promise<PayoutOutcome> {
  const org = await findOrganization(providerName, payout.reference);
  if (!org) return "unknown_reference";
  return withTenant(org.schemaName, (db) => settlePayoutIn(db, org.id, providerName, payout));
}

export async function settlePayoutIn(db: TenantDb, organizationId: string, providerName: string, payout: Payout): Promise<PayoutOutcome> {
  const [found] = await db.select().from(payouts).where(and(eq(payouts.reference, payout.reference), eq(payouts.provider, providerName)));
  if (!found) return "unknown_reference";
  if (payout.status === "pending") return "still_pending";

  // Same lock order as everywhere else: the round, then the row
  const round = found.roundId ? (await lockRound(db, found.roundId)).round : null;
  const [p] = await db.select().from(payouts).where(eq(payouts.id, found.id)).for("update");
  const label = round ? `Round ${round.number}` : "Refund";
  const audit = (action: string, metadata: Record<string, unknown> = {}) =>
    recordAudit(db, { organizationId, actorId: null, action, target: label, metadata: { reference: p.reference, ...metadata } });
  const clearing = `clearing:${providerName}`;
  const pot = p.kind === "round" ? `round:${p.roundId}` : "refunds_due";

  if (payout.status === "success") {
    if (p.status === "succeeded") return "already_settled";
    if (p.status !== "pending") {
      // We'd written it off, and the provider now says it went: a person needs to look
      await audit("payout.inconsistent", { ours: p.status, theirs: payout.status });
      return "needs_attention";
    }
    if (payout.amount !== undefined && payout.amount !== p.amountPesewas) {
      await audit("payout.amount_mismatch", { expected: p.amountPesewas, reported: payout.amount });
      return "needs_attention";
    }
    await db.update(payouts).set({ status: "succeeded", settledAt: new Date(), failureReason: null }).where(eq(payouts.id, p.id));
    await postTransaction(db, {
      kind: p.kind === "round" ? "payout" : "refund",
      sourceId: p.id,
      memo: p.kind === "round" ? `${label} paid out by MoMo` : `Refund of ${formatCedis(p.amountPesewas)} sent by MoMo`,
      entries: [
        { account: pot, amountPesewas: p.amountPesewas, memberUserId: p.recipientUserId },
        { account: clearing, amountPesewas: -p.amountPesewas, memberUserId: p.recipientUserId },
      ],
    });
    if (round) await db.update(rounds).set({ status: "paid_out" }).where(eq(rounds.id, round.id));
    await audit(p.kind === "round" ? "payout.succeeded" : "refund.succeeded", { amountPesewas: p.amountPesewas });
    return "succeeded";
  }

  // failed or reversed
  if (p.status === "pending") {
    await db
      .update(payouts)
      .set({ status: "failed", failureReason: payout.failureReason ?? "The provider couldn't send it", settledAt: new Date() })
      .where(eq(payouts.id, p.id));
    await audit(p.kind === "round" ? "payout.failed" : "refund.failed", { reason: payout.failureReason ?? null });
    return "failed";
  }
  if (p.status === "succeeded") {
    // It went out and came back: undo the posting, and the round is owed again
    await db.update(payouts).set({ status: "reversed", failureReason: payout.failureReason ?? "Reversed" }).where(eq(payouts.id, p.id));
    await postTransaction(db, {
      kind: p.kind === "round" ? "payout_reversal" : "refund_reversal",
      sourceId: p.id,
      memo: `${label}: payout of ${formatCedis(p.amountPesewas)} reversed`,
      entries: [
        { account: clearing, amountPesewas: p.amountPesewas, memberUserId: p.recipientUserId },
        { account: pot, amountPesewas: -p.amountPesewas, memberUserId: p.recipientUserId },
      ],
    });
    if (round) await db.update(rounds).set({ status: "full" }).where(eq(rounds.id, round.id));
    await audit(p.kind === "round" ? "payout.reversed" : "refund.reversed", { amountPesewas: p.amountPesewas });
    return "reversed";
  }
  return "already_settled";
}

// ---- Cash deposits and closing ----------------------------------------------

/** Records cash moved into the provider balance, so pots that were partly paid in cash can go out by MoMo. */
export async function recordCashDeposit(ctx: OrgContext, input: { amount: string; note?: string }) {
  assertCan(ctx.role, "cash:deposit");
  const amount = parseCedis(input.amount);
  if (amount <= 0) throw new AppError("validation", "Enter an amount.");
  const provider = configuredProviderName();
  await withTenant(ctx.org.schemaName, async (db) => {
    await lockPayouts(db);
    const cash = await accountBalance(db, "cash");
    if (cash < amount) throw new AppError("validation", `The ledger only shows ${formatCedis(cash)} in cash.`);
    const [deposit] = await db
      .insert(cashDeposits)
      .values({ provider, amountPesewas: amount, note: (input.note ?? "").trim().slice(0, 200), recordedBy: ctx.userId })
      .returning();
    await postTransaction(db, {
      kind: "cash_deposit",
      sourceId: deposit.id,
      memo: `Cash deposited to the provider balance${deposit.note ? `: ${deposit.note}` : ""}`,
      entries: [
        { account: `clearing:${provider}`, amountPesewas: amount },
        { account: "cash", amountPesewas: -amount },
      ],
    });
    await recordAudit(db, { organizationId: ctx.org.id, actorId: ctx.userId, action: "cash.deposited", metadata: { amountPesewas: amount, provider } });
  });
}

/** Closes a cycle once every round has been paid out. Then the next cycle can be drafted. */
export async function closeCycle(ctx: OrgContext, cycleIdInput: string) {
  assertCan(ctx.role, "cycles:manage");
  const cycleId = parseId(cycleIdInput);
  await withTenant(ctx.org.schemaName, async (db) => {
    const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId)).for("update");
    if (!cycle || cycle.status !== "active") throw new AppError("conflict", "This cycle isn't running.");
    const unpaid = await db
      .select({ number: rounds.number })
      .from(rounds)
      .where(and(eq(rounds.cycleId, cycleId), sql`${rounds.status} <> 'paid_out'`));
    if (unpaid.length) throw new AppError("conflict", `Round ${unpaid.map((r) => r.number).join(", ")} hasn't been paid out yet.`);
    await db.update(cycles).set({ status: "closed", closedAt: new Date() }).where(eq(cycles.id, cycleId));
    await recordAudit(db, { organizationId: ctx.org.id, actorId: ctx.userId, action: "cycle.closed", target: `Cycle ${cycle.number}` });
  });
}
