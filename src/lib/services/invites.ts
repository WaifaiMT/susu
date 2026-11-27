import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { invites, memberships, organizations, users } from "@/db/schema";
import { AppError } from "../errors";
import { parseId } from "../ids";
import { assertCan, canAssignRole } from "../permissions";
import { generateToken, hashToken } from "../tokens";
import { recordAudit } from "./audit";
import type { OrgContext } from "./orgs";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const InviteInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  role: z.enum(["treasurer", "member"]),
});

/** Creates an invite and returns the raw token for the link. Only its hash is stored. */
export async function createInvite(ctx: OrgContext, input: { email: string; role: string }): Promise<{ token: string }> {
  assertCan(ctx.role, "members:invite");
  const parsed = InviteInput.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const { email, role } = parsed.data;
  if (!canAssignRole(ctx.role, role)) throw new AppError("forbidden", "You can't invite someone with that role.");

  const db = getDb();
  const [alreadyMember] = await db
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, ctx.org.id), sql`lower(${users.email}) = ${email}`));
  if (alreadyMember) throw new AppError("conflict", `${email} is already a member.`);

  const token = generateToken();
  await db.transaction(async (tx) => {
    // A new invite to the same email replaces any earlier pending one
    await tx
      .delete(invites)
      .where(and(eq(invites.organizationId, ctx.org.id), eq(invites.email, email), isNull(invites.acceptedAt)));
    await tx.insert(invites).values({
      organizationId: ctx.org.id,
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: ctx.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    await recordAudit(tx, { organizationId: ctx.org.id, actorId: ctx.userId, action: "invite.created", target: email, metadata: { role } });
  });
  return { token };
}

export async function listPendingInvites(ctx: OrgContext) {
  assertCan(ctx.role, "members:invite");
  return getDb()
    .select({ id: invites.id, email: invites.email, role: invites.role, expiresAt: invites.expiresAt, createdAt: invites.createdAt })
    .from(invites)
    .where(and(eq(invites.organizationId, ctx.org.id), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`now()`)))
    .orderBy(desc(invites.createdAt));
}

export async function revokeInvite(ctx: OrgContext, id: string): Promise<void> {
  assertCan(ctx.role, "members:invite");
  const inviteId = parseId(id);
  await getDb().transaction(async (tx) => {
    const [deleted] = await tx
      .delete(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.organizationId, ctx.org.id), isNull(invites.acceptedAt)))
      .returning({ email: invites.email });
    if (!deleted) throw new AppError("not_found", "That invite no longer exists.");
    await recordAudit(tx, { organizationId: ctx.org.id, actorId: ctx.userId, action: "invite.revoked", target: deleted.email });
  });
}

/** What the accept page shows before the user confirms. Null if the link is invalid, used, or expired. */
export async function getInvite(token: string) {
  const [row] = await getDb()
    .select({ email: invites.email, role: invites.role, orgName: organizations.name, orgSlug: organizations.slug })
    .from(invites)
    .innerJoin(organizations, eq(organizations.id, invites.organizationId))
    .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`now()`)));
  return row ?? null;
}

/**
 * Accepts an invite for the signed-in user. The user's email must match the
 * invited email, so a forwarded link can't be used by someone else.
 */
export async function acceptInvite(token: string, user: { id: string; email: string }): Promise<{ orgSlug: string }> {
  return getDb().transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`now()`)))
      .for("update");
    if (!invite) throw new AppError("not_found", "This invite link is invalid, expired, or already used.");
    if (invite.email !== user.email.toLowerCase()) {
      throw new AppError("forbidden", `This invite was sent to ${invite.email}. Sign in with that email to accept it.`);
    }

    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));
    await tx
      .insert(memberships)
      .values({ organizationId: invite.organizationId, userId: user.id, role: invite.role })
      .onConflictDoNothing();
    await recordAudit(tx, { organizationId: invite.organizationId, actorId: user.id, action: "invite.accepted", target: invite.email });

    const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, invite.organizationId));
    return { orgSlug: org.slug };
  });
}
