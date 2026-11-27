import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb } from "@/db/client";
import { auditLog, users } from "@/db/schema";
import { assertCan } from "../permissions";
import type { OrgContext } from "./orgs";

export type AuditEntry = {
  organizationId: string;
  actorId: string | null;
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
};

/** Records an audit entry. Pass a transaction so the entry commits or rolls back with the change. */
export async function recordAudit(db: NodePgDatabase, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    organizationId: entry.organizationId,
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target,
    metadata: entry.metadata ?? {},
  });
}

export async function listAudit(ctx: OrgContext, limit = 100) {
  assertCan(ctx.role, "audit:read");
  return getDb()
    .select({
      id: auditLog.id,
      action: auditLog.action,
      target: auditLog.target,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(eq(auditLog.organizationId, ctx.org.id))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}
