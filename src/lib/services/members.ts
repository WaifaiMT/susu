import { and, asc, count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { memberships, users, type Role } from "@/db/schema";
import { AppError } from "../errors";
import { parseId } from "../ids";
import { assertCan, canAssignRole } from "../permissions";
import { recordAudit } from "./audit";
import type { OrgContext } from "./orgs";

export async function listMembers(ctx: OrgContext) {
  assertCan(ctx.role, "members:read");
  return getDb()
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, ctx.org.id))
    .orderBy(asc(memberships.createdAt));
}

async function countOwners(organizationId: string): Promise<number> {
  const [{ value }] = await getDb()
    .select({ value: count() })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.role, "collector")));
  return value;
}

async function getRole(organizationId: string, userId: string): Promise<Role> {
  const [row] = await getDb()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)));
  if (!row) throw new AppError("not_found", "That person isn't a member of this group.");
  return row.role;
}

export async function changeRole(ctx: OrgContext, targetId: string, newRole: Role): Promise<void> {
  assertCan(ctx.role, "members:manage");
  const targetUserId = parseId(targetId);
  if (!["collector", "treasurer", "member"].includes(newRole)) throw new AppError("validation", "Pick a valid role.");
  const currentRole = await getRole(ctx.org.id, targetUserId);
  if (!canAssignRole(ctx.role, currentRole) || !canAssignRole(ctx.role, newRole)) {
    throw new AppError("forbidden", "Only collectors can change a collector's role or make someone a collector.");
  }
  if (currentRole === "collector" && newRole !== "collector" && (await countOwners(ctx.org.id)) <= 1) {
    throw new AppError("conflict", "A group needs at least one collector. Make someone else a collector first.");
  }

  await getDb().transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ role: newRole })
      .where(and(eq(memberships.organizationId, ctx.org.id), eq(memberships.userId, targetUserId)));
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "member.role_changed",
      target: targetUserId,
      metadata: { from: currentRole, to: newRole },
    });
  });
}

/** Removes a member. Anyone can remove themselves (leave); managing others needs members:manage. */
export async function removeMember(ctx: OrgContext, targetId: string): Promise<void> {
  const targetUserId = parseId(targetId);
  const leaving = targetUserId === ctx.userId;
  if (!leaving) assertCan(ctx.role, "members:manage");

  const targetRole = await getRole(ctx.org.id, targetUserId);
  if (!leaving && !canAssignRole(ctx.role, targetRole)) {
    throw new AppError("forbidden", "Only collectors can remove a collector.");
  }
  if (targetRole === "collector" && (await countOwners(ctx.org.id)) <= 1) {
    throw new AppError("conflict", "The last collector can't leave. Make someone else a collector, or delete the group.");
  }

  await getDb().transaction(async (tx) => {
    await tx
      .delete(memberships)
      .where(and(eq(memberships.organizationId, ctx.org.id), eq(memberships.userId, targetUserId)));
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: leaving ? "member.left" : "member.removed",
      target: targetUserId,
    });
  });
}
