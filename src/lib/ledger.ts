import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ledgerAccounts, ledgerEntries, ledgerTransactions, type LedgerKind } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";

// The only code that writes money movements. Every posting is a balanced
// transaction (entries sum to zero), and the database checks that at commit,
// so a bug here fails loudly instead of silently losing a pesewa.
//
// Sign convention: debits are positive, credits negative. An asset account
// (clearing, cash) has a positive balance; an account for money owed to
// someone (a round's pot, refunds due) has a negative one.

export type Entry = {
  /** Account code, e.g. "clearing:paystack" or "round:<id>". Created on first use. */
  account: string;
  amountPesewas: number;
  /** Who the money came from or belongs to, when it's one person. */
  memberUserId?: string;
};

export const ACCOUNT_NAMES: Record<string, string> = {
  "clearing:fake": "Held at the test provider",
  "clearing:paystack": "Held at Paystack",
  "clearing:mtn_momo": "Held at MTN MoMo",
  cash: "Cash held by the collector",
  refunds_due: "Refunds owed to members",
};

export function accountName(code: string, roundLabel?: (roundId: string) => string): string {
  if (code.startsWith("round:")) return roundLabel ? roundLabel(code.slice(6)) : "Round pot";
  return ACCOUNT_NAMES[code] ?? code;
}

async function accountIds(db: TenantDb, codes: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  await db
    .insert(ledgerAccounts)
    .values(unique.map((code) => ({ code, name: accountName(code) })))
    .onConflictDoNothing({ target: ledgerAccounts.code });
  const rows = await db.select({ id: ledgerAccounts.id, code: ledgerAccounts.code }).from(ledgerAccounts).where(inArray(ledgerAccounts.code, unique));
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * Posts a balanced transaction, once per (kind, sourceId). Processing the same
 * event twice posts nothing the second time and returns false.
 */
export async function postTransaction(
  db: TenantDb,
  input: { kind: LedgerKind; sourceId: string; memo: string; entries: Entry[] },
): Promise<boolean> {
  for (const e of input.entries) {
    if (!Number.isSafeInteger(e.amountPesewas) || e.amountPesewas === 0) {
      throw new Error(`Ledger amounts are non-zero whole pesewas, got ${e.amountPesewas}`);
    }
  }
  const total = input.entries.reduce((sum, e) => sum + e.amountPesewas, 0);
  if (input.entries.length < 2 || total !== 0) {
    // The database would refuse at commit; failing here gives a clearer error
    throw new Error(`Unbalanced ledger transaction (${input.entries.length} entries summing to ${total})`);
  }

  const [tx] = await db
    .insert(ledgerTransactions)
    .values({ kind: input.kind, sourceId: input.sourceId, memo: input.memo })
    .onConflictDoNothing({ target: [ledgerTransactions.kind, ledgerTransactions.sourceId] })
    .returning({ id: ledgerTransactions.id });
  if (!tx) return false; // already posted

  const ids = await accountIds(db, input.entries.map((e) => e.account));
  await db.insert(ledgerEntries).values(
    input.entries.map((e) => ({
      transactionId: tx.id,
      accountId: ids.get(e.account)!,
      amountPesewas: e.amountPesewas,
      memberUserId: e.memberUserId ?? null,
    })),
  );
  return true;
}

/** Balance of every account that has entries, in pesewas. */
export async function accountBalances(db: TenantDb): Promise<{ code: string; balance: number }[]> {
  const rows = await db
    .select({ code: ledgerAccounts.code, balance: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerAccounts)
    .leftJoin(ledgerEntries, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .groupBy(ledgerAccounts.code)
    .orderBy(asc(ledgerAccounts.code));
  // bigint sums come back as strings; the totals here stay far below 2^53
  return rows.map((r) => ({ code: r.code, balance: Number(r.balance) }));
}

export async function accountBalance(db: TenantDb, code: string): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerEntries.amountPesewas}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(eq(ledgerAccounts.code, code));
  return Number(row?.balance ?? 0);
}

/** Recent transactions with their entries, newest first. */
export async function recentTransactions(db: TenantDb, limit = 50) {
  const txs = await db.select().from(ledgerTransactions).orderBy(desc(ledgerTransactions.createdAt), desc(ledgerTransactions.id)).limit(limit);
  if (txs.length === 0) return [];
  const entries = await db
    .select({
      transactionId: ledgerEntries.transactionId,
      account: ledgerAccounts.code,
      amountPesewas: ledgerEntries.amountPesewas,
      memberUserId: ledgerEntries.memberUserId,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(inArray(ledgerEntries.transactionId, txs.map((t) => t.id)))
    .orderBy(asc(ledgerEntries.id));
  return txs.map((t) => ({ ...t, entries: entries.filter((e) => e.transactionId === t.id) }));
}
