import { bigint, date, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Drizzle table definitions for querying. The SQL in ./migrations is the
// source of truth for the database structure.

// ---- Public schema: shared across all organisations ----

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  schemaName: text("schema_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    organizationId: uuid("organization_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] })],
);

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role").$type<Exclude<Role, "collector">>().notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: uuid("invited_by"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: uuid("organization_id").notNull(),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---- Tenant schema: one copy per group ----
// Unqualified on purpose: they resolve through the search_path that
// withTenant() sets, so a query can only ever reach the current group.

export type Frequency = "daily" | "weekly" | "monthly";
export type OrderMethod = "join_order" | "random" | "manual";
export type CycleStatus = "draft" | "active" | "closed";
export type RoundStatus = "open" | "full" | "paid_out";

export const cycles = pgTable("cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number").notNull(),
  amountPesewas: bigint("amount_pesewas", { mode: "number" }).notNull(),
  frequency: text("frequency").$type<Frequency>().notNull(),
  startsOn: date("starts_on").notNull(),
  orderMethod: text("order_method").$type<OrderMethod>().notNull(),
  status: text("status").$type<CycleStatus>().notNull().default("draft"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const cycleMembers = pgTable(
  "cycle_members",
  {
    cycleId: uuid("cycle_id").notNull(),
    userId: uuid("user_id").notNull(),
    payoutPosition: integer("payout_position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.cycleId, t.userId] })],
);

export const rounds = pgTable("rounds", {
  id: uuid("id").primaryKey().defaultRandom(),
  cycleId: uuid("cycle_id").notNull(),
  number: integer("number").notNull(),
  dueOn: date("due_on").notNull(),
  recipientUserId: uuid("recipient_user_id").notNull(),
  status: text("status").$type<RoundStatus>().notNull().default("open"),
});

export type Role = "collector" | "treasurer" | "member";
