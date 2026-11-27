import { eq, inArray } from "drizzle-orm";
import { cycles, rounds, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { accountBalances, accountName, recentTransactions } from "../ledger";
import { assertCan } from "../permissions";
import type { OrgContext } from "./orgs";

/** Balances and recent transactions, with names a person can read. Collectors and treasurers only. */
export async function getLedgerOverview(ctx: OrgContext) {
  assertCan(ctx.role, "ledger:read");
  return withTenant(ctx.org.schemaName, async (db) => {
    const balances = await accountBalances(db);
    const transactions = await recentTransactions(db, 100);

    const roundIds = balances.filter((b) => b.code.startsWith("round:")).map((b) => b.code.slice(6));
    const roundRows = roundIds.length
      ? await db
          .select({ id: rounds.id, number: rounds.number, cycleNumber: cycles.number })
          .from(rounds)
          .innerJoin(cycles, eq(cycles.id, rounds.cycleId))
          .where(inArray(rounds.id, roundIds))
      : [];
    const roundLabel = (id: string) => {
      const r = roundRows.find((x) => x.id === id);
      return r ? `Cycle ${r.cycleNumber}, round ${r.number} pot` : "Round pot";
    };

    const memberIds = [...new Set(transactions.flatMap((t) => t.entries.map((e) => e.memberUserId)).filter((id): id is string => !!id))];
    const names = memberIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, memberIds)) : [];
    const nameOf = (id: string | null) => (id ? (names.find((n) => n.id === id)?.name ?? "Unknown") : null);

    return {
      balances: balances.map((b) => ({ ...b, name: accountName(b.code, roundLabel) })),
      /** Must be zero: every transaction balances, so the whole ledger does. */
      total: balances.reduce((sum, b) => sum + b.balance, 0),
      transactions: transactions.map((t) => ({
        ...t,
        entries: t.entries.map((e) => ({ ...e, name: accountName(e.account, roundLabel), member: nameOf(e.memberUserId) })),
      })),
    };
  });
}
