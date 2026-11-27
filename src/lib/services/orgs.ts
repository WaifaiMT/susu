import { randomUUID } from "node:crypto";
import { and, asc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { getDb, getPool } from "@/db/client";
import { migrateTenant } from "@/db/migrate";
import { memberships, organizations, type Role } from "@/db/schema";
import { quoteIdent, tenantSchemaName } from "@/db/tenant-schema";
import { AppError } from "../errors";
import { assertCan } from "../permissions";
import { RESERVED_SLUGS, slugify } from "../slug";
import { recordAudit } from "./audit";

export type Organization = typeof organizations.$inferSelect;

/** Who is acting, in which organisation, with which role. Every org-scoped service takes one. */
export type OrgContext = { userId: string; org: Organization; role: Role };

const OrgName = z.string().trim().min(2, "Use at least 2 characters.").max(60, "Use at most 60 characters.");

function parseName(name: string): string {
  const parsed = OrgName.safeParse(name);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  return parsed.data;
}

async function uniqueSlug(name: string): Promise<string> {
  let base = slugify(name) || "org";
  if (RESERVED_SLUGS.has(base)) base = `${base}-org`;
  const taken = new Set(
    (await getDb().select({ slug: organizations.slug }).from(organizations).where(like(organizations.slug, `${base}%`))).map(
      (r) => r.slug,
    ),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * Creates an organisation with its own schema and makes the user its collector.
 * The schema is created and migrated first; if saving the organisation then
 * fails, the schema is dropped so nothing is left half-created.
 */
export async function createOrganization(userId: string, name: string): Promise<Organization> {
  const cleanName = parseName(name);
  const id = randomUUID();
  const schemaName = tenantSchemaName(id);
  const pool = getPool();

  await migrateTenant(pool, schemaName);
  try {
    return await getDb().transaction(async (tx) => {
      const slug = await uniqueSlug(cleanName);
      const [org] = await tx.insert(organizations).values({ id, slug, name: cleanName, schemaName }).returning();
      await tx.insert(memberships).values({ organizationId: id, userId, role: "collector" });
      await recordAudit(tx, { organizationId: id, actorId: userId, action: "org.created", target: cleanName });
      return org;
    });
  } catch (error) {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
    throw error;
  }
}

export async function listUserOrganizations(userId: string) {
  return getDb()
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(organizations.name));
}

/** Resolves the user's membership in an organisation, or null if they aren't a member. */
export async function getOrgContext(userId: string, slug: string): Promise<OrgContext | null> {
  const [row] = await getDb()
    .select({ org: organizations, role: memberships.role })
    .from(organizations)
    .innerJoin(memberships, and(eq(memberships.organizationId, organizations.id), eq(memberships.userId, userId)))
    .where(eq(organizations.slug, slug));
  return row ? { userId, org: row.org, role: row.role } : null;
}

export async function renameOrganization(ctx: OrgContext, name: string): Promise<void> {
  assertCan(ctx.role, "org:update");
  const cleanName = parseName(name);
  await getDb().transaction(async (tx) => {
    await tx.update(organizations).set({ name: cleanName }).where(eq(organizations.id, ctx.org.id));
    await recordAudit(tx, {
      organizationId: ctx.org.id,
      actorId: ctx.userId,
      action: "org.renamed",
      metadata: { from: ctx.org.name, to: cleanName },
    });
  });
}

/** Deletes the organisation, its schema and all its data. Owners only. */
export async function deleteOrganization(ctx: OrgContext): Promise<void> {
  assertCan(ctx.role, "org:delete");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM organizations WHERE id = $1", [ctx.org.id]);
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(tenantSchemaName(ctx.org.id))} CASCADE`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
