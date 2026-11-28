import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { PesewaError, detectNetwork, normalizeGhanaPhone, type CollectRequest, type CollectResult, type Network, type Payment } from "pesewa";
import { getDb } from "@/db/client";
import {
  contributions,
  cycleMembers,
  cycles,
  organizations,
  paymentReferences,
  rounds,
  users,
  type ContributionStatus,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AppError } from "../errors";
import { parseId } from "../ids";
import { postTransaction } from "../ledger";
import { formatCedis } from "../money";
import { currencyFor, getProvider } from "../payments";
import { assertCan, can } from "../permissions";
import { todayIso } from "../schedule";
import { recordAudit } from "./audit";
import type { OrgContext } from "./orgs";

// How a contribution moves:
//
//   startContribution()  → row saved as `pending` and COMMITTED, then the provider is called.
//                          Saving first means a webhook that beats the provider's reply
//                          always finds the row.
//   webhook / verify()   → settle(): confirmed with the provider, then in one transaction
//                          the contribution is marked paid, the ledger is posted, and the
//                          round is marked full when everyone has paid.
//
// Three things stop a payment being counted twice: webhook_events (the same event is
// processed once), the contribution row lock + status check, and the ledger's
// UNIQUE (kind, source_id). The round row is locked while counting, so two
// last-minute payments can't both miss that the round is now full.

const WAITING: ContributionStatus[] = ["pending", "otp_required"];
const PAID: ContributionStatus[] = ["succeeded", "duplicate", "mismatch"];
/** A waiting attempt older than this can be replaced by a new one. */
const STALE_MINUTES = 15;

export type SettleOutcome =
  | "succeeded"
  | "duplicate"
  | "mismatch"
  | "failed"
  | "still_pending"
  | "already_settled"
  | "reported_failed_after_payment"
  | "unknown_reference";

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/** Rounds a member can pay into today: every unfilled round that's due, plus the next one. */
export function payableRoundIds(schedule: { id: string; dueOn: string; status: string }[], today = todayIso()): string[] {
  const open = schedule.filter((r) => r.status === "open");
  const due = open.filter((r) => r.dueOn <= today).map((r) => r.id);
  const next = open.find((r) => r.dueOn > today);
  return next ? [...due, next.id] : due;
}

// ---- Reading -----------------------------------------------------------------

/** Every contribution attempt in a cycle, oldest first. Phone numbers only for the payer and the people who run the group. */
export async function listCycleContributions(ctx: OrgContext, cycleIdInput: string) {
  assertCan(ctx.role, "cycles:read");
  const cycleId = parseId(cycleIdInput);
  const rows = await withTenant(ctx.org.schemaName, (db) =>
    db
      .select({
        id: contributions.id,
        roundId: contributions.roundId,
        userId: contributions.userId,
        method: contributions.method,
        provider: contributions.provider,
        status: contributions.status,
        phone: contributions.phone,
        network: contributions.network,
        amountPesewas: contributions.amountPesewas,
        receivedPesewas: contributions.receivedPesewas,
        failureReason: contributions.failureReason,
        createdAt: contributions.createdAt,
        settledAt: contributions.settledAt,
        recordedByName: sql<string | null>`(SELECT name FROM users WHERE id = ${contributions.recordedBy})`,
      })
      .from(contributions)
      .innerJoin(rounds, eq(rounds.id, contributions.roundId))
      .where(eq(rounds.cycleId, cycleId))
      .orderBy(asc(contributions.createdAt)),
  );
  const seesPhones = can(ctx.role, "contributions:record_cash");
  return rows.map((r) => (seesPhones || r.userId === ctx.userId ? r : { ...r, phone: null }));
}

// ---- Paying with Mobile Money ---------------------------------------------

function parsePhone(phone: string, network: string | undefined): { local: string; network: Network } {
  let local: string;
  try {
    local = normalizeGhanaPhone(phone).local;
  } catch {
    throw new AppError("validation", "Enter a Ghana mobile number, like 024 123 4567.");
  }
  const chosen = network && ["mtn", "telecel", "at"].includes(network) ? (network as Network) : detectNetwork(local);
  if (!chosen) throw new AppError("validation", "We can't tell the network for that number. Pick MTN, Telecel, or AT.");
  return { local, network: chosen };
}

/** Loads a round of the running cycle and locks it, so payments into it are counted one at a time. */
export async function lockRound(db: TenantDb, roundId: string) {
  const [row] = await db
    .select({ round: rounds, cycle: cycles })
    .from(rounds)
    .innerJoin(cycles, eq(cycles.id, rounds.cycleId))
    .where(eq(rounds.id, roundId))
    .for("update", { of: rounds });
  if (!row) throw new AppError("not_found", "That round doesn't exist.");
  return row;
}

async function assertCanPayInto(db: TenantDb, roundId: string, userId: string, today: string) {
  const { round, cycle } = await lockRound(db, roundId);
  if (cycle.status !== "active") throw new AppError("conflict", "This cycle isn't running.");
  const [member] = await db
    .select()
    .from(cycleMembers)
    .where(and(eq(cycleMembers.cycleId, cycle.id), eq(cycleMembers.userId, userId)));
  if (!member) throw new AppError("forbidden", "That person isn't in this cycle.");

  const schedule = await db.select({ id: rounds.id, dueOn: rounds.dueOn, status: rounds.status }).from(rounds).where(eq(rounds.cycleId, cycle.id));
  if (round.status !== "open") throw new AppError("conflict", `Round ${round.number} is already full.`);
  if (!payableRoundIds(schedule, today).includes(round.id)) {
    throw new AppError("validation", `Round ${round.number} isn't open for payments yet.`);
  }
  const [paid] = await db
    .select({ id: contributions.id })
    .from(contributions)
    .where(and(eq(contributions.roundId, roundId), eq(contributions.userId, userId), eq(contributions.status, "succeeded")));
  if (paid) throw new AppError("conflict", `Round ${round.number} is already paid.`);
  return { round, cycle };
}

/**
 * Starts a Mobile Money payment for the signed-in member's contribution to a
 * round. Returns what the member has to do next.
 */
export async function startContribution(
  ctx: OrgContext,
  input: { roundId: string; phone: string; network?: string },
  today = todayIso(),
): Promise<{ contributionId: string; status: ContributionStatus; message?: string }> {
  assertCan(ctx.role, "cycles:read");
  const roundId = parseId(input.roundId);
  const phone = parsePhone(input.phone, input.network);
  const provider = getProvider();
  const reference = randomUUID(); // UUID v4: MTN uses it as its own request id too

  let created: { id: string; amountPesewas: number; email: string; roundNumber: number };
  try {
    created = await withTenant(ctx.org.schemaName, async (db) => {
      const { round, cycle } = await assertCanPayInto(db, roundId, ctx.userId, today);

      // An attempt the member abandoned (closed the tab, ignored the prompt) stops blocking a new one
      await db
        .update(contributions)
        .set({ status: "expired" })
        .where(
          and(
            eq(contributions.roundId, roundId),
            eq(contributions.userId, ctx.userId),
            inArray(contributions.status, WAITING),
            sql`${contributions.createdAt} < now() - make_interval(mins => ${STALE_MINUTES})`,
          ),
        );

      const [row] = await db
        .insert(contributions)
        .values({
          roundId,
          userId: ctx.userId,
          amountPesewas: cycle.amountPesewas,
          method: "momo",
          provider: provider.name,
          reference,
          phone: phone.local,
          network: phone.network,
          status: "pending",
        })
        .returning({ id: contributions.id });
      await db.insert(paymentReferences).values({ provider: provider.name, reference, organizationId: ctx.org.id });
      await recordAudit(db, {
        organizationId: ctx.org.id,
        actorId: ctx.userId,
        action: "contribution.started",
        target: `Round ${round.number}`,
        metadata: { reference, provider: provider.name, amountPesewas: cycle.amountPesewas },
      });
      const [{ email }] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
      return { id: row.id, amountPesewas: cycle.amountPesewas, email, roundNumber: round.number };
    });
  } catch (error) {
    if (pgCode(error) === "23505") {
      throw new AppError("conflict", "You already have a payment waiting. Approve the prompt on your phone, or check its status.");
    }
    throw error;
  }

  // Committed. Now ask the provider, outside any transaction (it can take seconds).
  const request: CollectRequest = {
    amount: created.amountPesewas,
    currency: currencyFor(provider.name),
    phone: phone.local,
    network: phone.network,
    reference,
    email: created.email,
    description: `Susu: ${ctx.org.name}, round ${created.roundNumber}`,
  };
  return applyCollectResult(ctx, created.id, reference, () => provider.collect(request));
}

/** Finishes a payment that asked for an OTP. */
export async function submitContributionOtp(ctx: OrgContext, contributionIdInput: string, otp: string) {
  const contribution = await getOwnContribution(ctx, contributionIdInput);
  if (contribution.status !== "otp_required") throw new AppError("conflict", "This payment isn't waiting for an OTP.");
  if (!/^\d{4,8}$/.test(otp.trim())) throw new AppError("validation", "Enter the code you received, digits only.");
  const provider = getProvider(contribution.provider!);
  const request: CollectRequest = {
    amount: contribution.amountPesewas,
    currency: currencyFor(provider.name),
    phone: contribution.phone!,
    network: contribution.network ?? undefined,
    reference: contribution.reference,
  };
  return applyCollectResult(ctx, contribution.id, contribution.reference, () => provider.submitOtp(request, otp.trim()), {
    keepOnInvalid: true,
  });
}

/** Asks the provider for the payment's real status: the fallback when a webhook is late or lost. */
export async function checkContribution(ctx: OrgContext, contributionIdInput: string): Promise<SettleOutcome> {
  const contribution = await getOwnContribution(ctx, contributionIdInput, { allowManagers: true });
  if (contribution.method !== "momo") return "already_settled";
  const provider = getProvider(contribution.provider!);
  let payment: Payment;
  try {
    payment = await provider.verify(contribution.reference);
  } catch (error) {
    throw providerError(error);
  }
  return settle(provider.name, payment);
}

async function getOwnContribution(ctx: OrgContext, idInput: string, opts: { allowManagers?: boolean } = {}) {
  const id = parseId(idInput);
  const [row] = await withTenant(ctx.org.schemaName, (db) => db.select().from(contributions).where(eq(contributions.id, id)));
  const mayView = row && (row.userId === ctx.userId || (opts.allowManagers && can(ctx.role, "contributions:record_cash")));
  if (!mayView) throw new AppError("not_found", "That payment doesn't exist.");
  return row;
}

/** The provider reference of the signed-in member's own waiting payment (for the test provider's simulator). */
export async function getContributionReference(ctx: OrgContext, contributionIdInput: string): Promise<{ reference: string; amountPesewas: number }> {
  const contribution = await getOwnContribution(ctx, contributionIdInput);
  if (!WAITING.includes(contribution.status)) throw new AppError("conflict", "This payment isn't waiting for approval.");
  return { reference: contribution.reference, amountPesewas: contribution.amountPesewas };
}

function providerError(error: unknown): AppError {
  if (error instanceof PesewaError) {
    if (error.code === "network") return new AppError("conflict", "We couldn't reach the payment provider. Check the status again in a minute.");
    if (error.code === "invalid_request") return new AppError("validation", error.message.replace(/^[A-Za-z ]+: /, ""));
    return new AppError("conflict", "The payment provider couldn't process this payment. Try again, or use another number.");
  }
  return error instanceof AppError ? error : new AppError("conflict", "Something went wrong with the payment. Check its status before trying again.");
}

/** Records what the provider said, without ever overwriting a later, settled state. */
async function applyCollectResult(
  ctx: OrgContext,
  contributionId: string,
  reference: string,
  call: () => Promise<CollectResult>,
  opts: { keepOnInvalid?: boolean } = {},
): Promise<{ contributionId: string; status: ContributionStatus; message?: string }> {
  const provider = getProvider();
  let result: CollectResult;
  try {
    result = await call();
  } catch (error) {
    const appError = providerError(error);
    const transient = error instanceof PesewaError && error.code === "network";
    const wrongOtp = opts.keepOnInvalid && error instanceof PesewaError && error.code === "invalid_request";
    if (!transient && !wrongOtp) {
      await markIfWaiting(ctx, contributionId, "failed", appError.message);
    }
    throw appError;
  }

  if (result.status === "success" || result.status === "failed") {
    // Final already: settle through the same path a webhook takes, confirmed with verify()
    const payment = result.status === "success" ? await provider.verify(reference) : null;
    if (payment) await settle(provider.name, payment);
    else await markIfWaiting(ctx, contributionId, "failed", result.message ?? "Declined");
  } else {
    await markIfWaiting(ctx, contributionId, result.status === "otp_required" ? "otp_required" : "pending");
  }
  const [row] = await withTenant(ctx.org.schemaName, (db) =>
    db.select({ status: contributions.status }).from(contributions).where(eq(contributions.id, contributionId)),
  );
  return { contributionId, status: row.status, message: result.message };
}

/** Changes a contribution that's still waiting. If a webhook settled it in the meantime, does nothing. */
async function markIfWaiting(ctx: OrgContext, contributionId: string, status: ContributionStatus, reason?: string) {
  await withTenant(ctx.org.schemaName, async (db) => {
    await db
      .update(contributions)
      .set({ status, failureReason: reason ?? null, settledAt: status === "failed" ? new Date() : null })
      .where(and(eq(contributions.id, contributionId), inArray(contributions.status, WAITING)));
  });
}

// ---- Settling: webhooks and status checks ------------------------------------

export async function findOrganization(provider: string, reference: string) {
  const [row] = await getDb()
    .select({ id: organizations.id, schemaName: organizations.schemaName })
    .from(paymentReferences)
    .innerJoin(organizations, eq(organizations.id, paymentReferences.organizationId))
    .where(and(eq(paymentReferences.provider, provider), eq(paymentReferences.reference, reference)));
  return row ?? null;
}

/** Applies a payment status that was confirmed with the provider. Safe to call any number of times. */
export async function settle(providerName: string, payment: Payment): Promise<SettleOutcome> {
  const org = await findOrganization(providerName, payment.reference);
  if (!org) return "unknown_reference";
  return withTenant(org.schemaName, (db) => settleIn(db, org.id, providerName, payment));
}

export async function settleIn(db: TenantDb, organizationId: string, providerName: string, payment: Payment): Promise<SettleOutcome> {
  const [found] = await db
    .select()
    .from(contributions)
    .where(and(eq(contributions.reference, payment.reference), eq(contributions.provider, providerName)));
  if (!found) return "unknown_reference";
  if (payment.status === "pending") return "still_pending";

  // Lock the round first, then the contribution: every payment path takes them in this order
  const { round, cycle } = await lockRound(db, found.roundId);
  const [c] = await db.select().from(contributions).where(eq(contributions.id, found.id)).for("update");
  const audit = (action: string, metadata: Record<string, unknown> = {}) =>
    recordAudit(db, { organizationId, actorId: null, action, target: `Round ${round.number}`, metadata: { reference: c.reference, ...metadata } });

  if (payment.status === "failed") {
    if (PAID.includes(c.status)) {
      // Money already counted, and now the provider says failed: a reversal. Handled with payouts (week 3).
      await audit("contribution.reported_failed_after_payment", { status: c.status });
      return "reported_failed_after_payment";
    }
    if (c.status === "failed") return "already_settled";
    await db
      .update(contributions)
      .set({ status: "failed", failureReason: payment.failureReason ?? "Declined", settledAt: new Date() })
      .where(eq(contributions.id, c.id));
    await audit("contribution.failed", { reason: payment.failureReason ?? null });
    return "failed";
  }

  // payment.status === "success"
  if (PAID.includes(c.status)) return "already_settled";
  const received = payment.amount ?? c.amountPesewas;
  const [{ alreadyPaid }] = await db
    .select({ alreadyPaid: count() })
    .from(contributions)
    .where(and(eq(contributions.roundId, c.roundId), eq(contributions.userId, c.userId), eq(contributions.status, "succeeded")));

  const status: ContributionStatus = received !== c.amountPesewas ? "mismatch" : alreadyPaid > 0 ? "duplicate" : "succeeded";
  const clearing = `clearing:${providerName}`;

  await db
    .update(contributions)
    .set({ status, receivedPesewas: received, settledAt: new Date(), failureReason: null })
    .where(eq(contributions.id, c.id));

  if (status === "succeeded") {
    await postTransaction(db, {
      kind: "contribution",
      sourceId: c.id,
      memo: `Round ${round.number} contribution`,
      entries: [
        { account: clearing, amountPesewas: received, memberUserId: c.userId },
        { account: `round:${round.id}`, amountPesewas: -received, memberUserId: c.userId },
      ],
    });
    await markRoundFullIfComplete(db, round.id, cycle.id);
  } else {
    // The money arrived, so the books must show it, as something owed back
    await postTransaction(db, {
      kind: "refund_due",
      sourceId: c.id,
      memo:
        status === "duplicate"
          ? `Round ${round.number}: paid twice, ${formatCedis(received)} to refund`
          : `Round ${round.number}: received ${formatCedis(received)} instead of ${formatCedis(c.amountPesewas)}, to refund`,
      entries: [
        { account: clearing, amountPesewas: received, memberUserId: c.userId },
        { account: "refunds_due", amountPesewas: -received, memberUserId: c.userId },
      ],
    });
  }
  await audit(`contribution.${status}`, { receivedPesewas: received });
  return status;
}

async function markRoundFullIfComplete(db: TenantDb, roundId: string, cycleId: string) {
  const [{ paid }] = await db
    .select({ paid: count() })
    .from(contributions)
    .where(and(eq(contributions.roundId, roundId), eq(contributions.status, "succeeded")));
  const [{ members }] = await db.select({ members: count() }).from(cycleMembers).where(eq(cycleMembers.cycleId, cycleId));
  if (paid === members) {
    await db.update(rounds).set({ status: "full" }).where(and(eq(rounds.id, roundId), eq(rounds.status, "open")));
  }
}

// ---- Cash ------------------------------------------------------------------

/** Records a contribution a member paid in cash. Collectors and treasurers only. */
export async function recordCashContribution(ctx: OrgContext, input: { roundId: string; userId: string }, today = todayIso()) {
  assertCan(ctx.role, "contributions:record_cash");
  const roundId = parseId(input.roundId);
  const userId = parseId(input.userId);

  try {
    return await withTenant(ctx.org.schemaName, async (db) => {
      const { round, cycle } = await assertCanPayInto(db, roundId, userId, today);
      const [row] = await db
        .insert(contributions)
        .values({
          roundId,
          userId,
          amountPesewas: cycle.amountPesewas,
          method: "cash",
          provider: null,
          reference: randomUUID(),
          status: "succeeded",
          receivedPesewas: cycle.amountPesewas,
          recordedBy: ctx.userId,
          settledAt: new Date(),
        })
        .returning();
      await postTransaction(db, {
        kind: "contribution",
        sourceId: row.id,
        memo: `Round ${round.number} contribution (cash)`,
        entries: [
          { account: "cash", amountPesewas: cycle.amountPesewas, memberUserId: userId },
          { account: `round:${round.id}`, amountPesewas: -cycle.amountPesewas, memberUserId: userId },
        ],
      });
      await markRoundFullIfComplete(db, round.id, cycle.id);
      await recordAudit(db, {
        organizationId: ctx.org.id,
        actorId: ctx.userId,
        action: "contribution.cash_recorded",
        target: `Round ${round.number}`,
        metadata: { userId, amountPesewas: cycle.amountPesewas },
      });
      return row;
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new AppError("conflict", "That member has already paid this round.");
    throw error;
  }
}
