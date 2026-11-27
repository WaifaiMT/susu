import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { cycleMembers, cycles, memberships, rounds, users, type Frequency, type OrderMethod } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AppError } from "../errors";
import { parseId } from "../ids";
import { parseCedis } from "../money";
import { assertCan } from "../permissions";
import { parseIsoDate, roundDueDates, todayIso, toIsoDate } from "../schedule";
import { recordAudit } from "./audit";
import type { OrgContext } from "./orgs";

// A cycle is one full rotation of the group: N members, N rounds, everyone
// pays every round and receives exactly once. The collector drafts it (rules
// and payout order), then starts it, which fixes the schedule for good. The
// database enforces that lock too (see migrations/tenant/0001_cycles.sql), so
// the checks here are for friendly messages, not the last line of defence.

export const MAX_MEMBERS = 100;
const MAX_START_DAYS_AHEAD = 366;

const DraftInput = z.object({
  amount: z.string(),
  frequency: z.enum(["daily", "weekly", "monthly"], "Pick how often members pay."),
  startsOn: z.string(),
  orderMethod: z.enum(["join_order", "random"], "Pick how to set the payout order."),
});

export type CycleView = Awaited<ReturnType<typeof getOpenCycle>>;

function pgCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors; the Postgres error code is on the cause
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

function assertStartDate(startsOn: string, today: string): void {
  const start = parseIsoDate(startsOn);
  if (!start) throw new AppError("validation", "Enter a valid start date.");
  if (startsOn < today) throw new AppError("validation", "The start date can't be in the past.");
  const latest = parseIsoDate(today)!;
  latest.setUTCDate(latest.getUTCDate() + MAX_START_DAYS_AHEAD);
  if (startsOn > toIsoDate(latest)) throw new AppError("validation", "Start the cycle within the next year.");
}

/** Fisher–Yates with a cryptographic RNG, so nobody can predict or game the draw. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function groupMemberIds(db: TenantDb, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(asc(memberships.createdAt), asc(memberships.userId));
  return rows.map((r) => r.userId);
}

/** Locks the cycle row for this transaction and checks it's still a draft. */
async function lockDraft(db: TenantDb, cycleId: string) {
  const [cycle] = await db.select().from(cycles).where(eq(cycles.id, cycleId)).for("update");
  if (!cycle) throw new AppError("not_found", "That cycle doesn't exist.");
  if (cycle.status !== "draft") throw new AppError("conflict", "This cycle has started, so its rules and order are locked.");
  return cycle;
}

/** The cycle being drafted or running, with its members and rounds. Null if there isn't one. */
export async function getOpenCycle(ctx: OrgContext) {
  assertCan(ctx.role, "cycles:read");
  return withTenant(ctx.org.schemaName, async (db) => {
    const [cycle] = await db
      .select()
      .from(cycles)
      .where(inArray(cycles.status, ["draft", "active"]));
    if (!cycle) return null;

    const members = await db
      .select({ userId: cycleMembers.userId, position: cycleMembers.payoutPosition, name: users.name })
      .from(cycleMembers)
      .innerJoin(users, eq(users.id, cycleMembers.userId))
      .where(eq(cycleMembers.cycleId, cycle.id))
      .orderBy(asc(cycleMembers.payoutPosition));

    const schedule = await db
      .select({
        id: rounds.id,
        number: rounds.number,
        dueOn: rounds.dueOn,
        status: rounds.status,
        recipientUserId: rounds.recipientUserId,
        recipientName: users.name,
      })
      .from(rounds)
      .innerJoin(users, eq(users.id, rounds.recipientUserId))
      .where(eq(rounds.cycleId, cycle.id))
      .orderBy(asc(rounds.number));

    const groupIds = await groupMemberIds(db, ctx.org.id);
    const inCycle = new Set(members.map((m) => m.userId));

    return {
      cycle,
      members,
      rounds: schedule,
      potPesewas: cycle.amountPesewas * members.length,
      /** The first round that hasn't been paid out yet. */
      currentRound: schedule.find((r) => r.status !== "paid_out") ?? null,
      /** Group members who joined after this draft was made, so aren't in it. */
      notInCycle: groupIds.filter((id) => !inCycle.has(id)).length,
      /** Members in the draft who have since left the group. */
      leftGroup: members.filter((m) => !groupIds.includes(m.userId)).map((m) => m.name),
    };
  });
}

export async function listClosedCycles(ctx: OrgContext) {
  assertCan(ctx.role, "cycles:read");
  return withTenant(ctx.org.schemaName, (db) =>
    db.select().from(cycles).where(eq(cycles.status, "closed")).orderBy(desc(cycles.number)),
  );
}

/** Drafts the next cycle with everyone currently in the group, in join order or a random draw. */
export async function createDraftCycle(
  ctx: OrgContext,
  input: { amount: string; frequency: string; startsOn: string; orderMethod: string },
  today = todayIso(),
) {
  assertCan(ctx.role, "cycles:manage");
  const parsed = DraftInput.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const amountPesewas = parseCedis(parsed.data.amount);
  if (amountPesewas < 100) throw new AppError("validation", "The contribution must be at least GH₵ 1.00.");
  if (amountPesewas > 100_000_000) throw new AppError("validation", "The contribution can be at most GH₵ 1,000,000.00.");
  assertStartDate(parsed.data.startsOn, today);
  const frequency: Frequency = parsed.data.frequency;
  const orderMethod: OrderMethod = parsed.data.orderMethod;

  try {
    return await withTenant(ctx.org.schemaName, async (db) => {
      const memberIds = await groupMemberIds(db, ctx.org.id);
      if (memberIds.length < 2) {
        throw new AppError("validation", "A susu needs at least 2 members. Invite someone from the Members tab first.");
      }
      if (memberIds.length > MAX_MEMBERS) throw new AppError("validation", `A cycle can have at most ${MAX_MEMBERS} members.`);

      const [{ next }] = await db.select({ next: sql<number>`coalesce(max(${cycles.number}), 0) + 1` }).from(cycles);
      const [cycle] = await db
        .insert(cycles)
        .values({ number: next, amountPesewas, frequency, startsOn: parsed.data.startsOn, orderMethod, createdBy: ctx.userId })
        .returning();

      const order = orderMethod === "random" ? shuffled(memberIds) : memberIds;
      await db.insert(cycleMembers).values(order.map((userId, i) => ({ cycleId: cycle.id, userId, payoutPosition: i + 1 })));

      await recordAudit(db, {
        organizationId: ctx.org.id,
        actorId: ctx.userId,
        action: "cycle.drafted",
        target: `Cycle ${cycle.number}`,
        metadata: { amountPesewas, frequency, startsOn: cycle.startsOn, orderMethod, members: order.length },
      });
      return cycle;
    });
  } catch (error) {
    if (pgCode(error) === "23505") {
      throw new AppError("conflict", "This group already has a cycle being set up or running.");
    }
    throw error;
  }
}

/** Swaps a member with the one above or below them in the payout order. */
export async function moveMember(ctx: OrgContext, cycleIdInput: string, userIdInput: string, direction: "up" | "down") {
  assertCan(ctx.role, "cycles:manage");
  const cycleId = parseId(cycleIdInput);
  const userId = parseId(userIdInput);

  await withTenant(ctx.org.schemaName, async (db) => {
    const cycle = await lockDraft(db, cycleId);
    const members = await db
      .select()
      .from(cycleMembers)
      .where(eq(cycleMembers.cycleId, cycleId))
      .orderBy(asc(cycleMembers.payoutPosition));
    const index = members.findIndex((m) => m.userId === userId);
    if (index === -1) throw new AppError("not_found", "That person isn't in this cycle.");
    const other = members[direction === "up" ? index - 1 : index + 1];
    if (!other) return; // already first or last

    const me = members[index];
    // The position constraint is deferred, so the swap only has to be valid at commit
    await db
      .update(cycleMembers)
      .set({ payoutPosition: other.payoutPosition })
      .where(and(eq(cycleMembers.cycleId, cycleId), eq(cycleMembers.userId, me.userId)));
    await db
      .update(cycleMembers)
      .set({ payoutPosition: me.payoutPosition })
      .where(and(eq(cycleMembers.cycleId, cycleId), eq(cycleMembers.userId, other.userId)));
    await db.update(cycles).set({ orderMethod: "manual" }).where(eq(cycles.id, cycleId));

    await recordAudit(db, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "cycle.order_changed",
      target: `Cycle ${cycle.number}`,
      metadata: { userId, direction },
    });
  });
}

/** Re-draws the whole payout order at random. */
export async function shuffleOrder(ctx: OrgContext, cycleIdInput: string) {
  assertCan(ctx.role, "cycles:manage");
  const cycleId = parseId(cycleIdInput);

  await withTenant(ctx.org.schemaName, async (db) => {
    const cycle = await lockDraft(db, cycleId);
    const members = await db.select().from(cycleMembers).where(eq(cycleMembers.cycleId, cycleId));
    const order = shuffled(members.map((m) => m.userId));
    for (const [i, userId] of order.entries()) {
      await db
        .update(cycleMembers)
        .set({ payoutPosition: i + 1 })
        .where(and(eq(cycleMembers.cycleId, cycleId), eq(cycleMembers.userId, userId)));
    }
    await db.update(cycles).set({ orderMethod: "random" }).where(eq(cycles.id, cycleId));
    await recordAudit(db, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "cycle.order_shuffled",
      target: `Cycle ${cycle.number}`,
      metadata: { order },
    });
  });
}

/**
 * Starts the cycle: generates one round per member from the payout order and
 * the start date, then marks the cycle active. From here on the rules, the
 * order, and the schedule can't change.
 */
export async function startCycle(ctx: OrgContext, cycleIdInput: string, today = todayIso()) {
  assertCan(ctx.role, "cycles:manage");
  const cycleId = parseId(cycleIdInput);

  return withTenant(ctx.org.schemaName, async (db) => {
    const cycle = await lockDraft(db, cycleId);
    if (cycle.startsOn < today) {
      throw new AppError("validation", "The start date has passed. Discard this draft and set a new date.");
    }

    const members = await db
      .select({ userId: cycleMembers.userId, position: cycleMembers.payoutPosition, name: users.name })
      .from(cycleMembers)
      .innerJoin(users, eq(users.id, cycleMembers.userId))
      .where(eq(cycleMembers.cycleId, cycleId))
      .orderBy(asc(cycleMembers.payoutPosition));
    const groupIds = new Set(await groupMemberIds(db, ctx.org.id));
    const left = members.filter((m) => !groupIds.has(m.userId));
    if (left.length > 0) {
      throw new AppError(
        "conflict",
        `${left.map((m) => m.name).join(", ")} left the group after this draft was made. Discard it and draft again.`,
      );
    }
    if (members.length < 2) throw new AppError("validation", "A susu needs at least 2 members.");

    const dueDates = roundDueDates(cycle.startsOn, cycle.frequency, members.length);
    await db.insert(rounds).values(
      members.map((m, i) => ({ cycleId, number: i + 1, dueOn: dueDates[i], recipientUserId: m.userId })),
    );
    const [started] = await db
      .update(cycles)
      .set({ status: "active", startedAt: new Date() })
      .where(eq(cycles.id, cycleId))
      .returning();

    await recordAudit(db, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "cycle.started",
      target: `Cycle ${cycle.number}`,
      metadata: { order: members.map((m) => m.userId), firstDue: dueDates[0], lastDue: dueDates.at(-1) },
    });
    return started;
  });
}

/** Deletes a draft. Started cycles can't be deleted (the database refuses too). */
export async function discardDraft(ctx: OrgContext, cycleIdInput: string) {
  assertCan(ctx.role, "cycles:manage");
  const cycleId = parseId(cycleIdInput);
  await withTenant(ctx.org.schemaName, async (db) => {
    const cycle = await lockDraft(db, cycleId);
    await db.delete(cycles).where(eq(cycles.id, cycleId));
    await recordAudit(db, { organizationId: ctx.org.id, actorId: ctx.userId, action: "cycle.discarded", target: `Cycle ${cycle.number}` });
  });
}
