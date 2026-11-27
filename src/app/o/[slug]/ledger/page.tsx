import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Skeleton, formatDate } from "@/components/ui";
import { requireOrg } from "@/lib/auth/session";
import { formatCedis } from "@/lib/money";
import { can } from "@/lib/permissions";
import { listRefundsDue } from "@/lib/services/contributions";
import { getLedgerOverview } from "@/lib/services/ledger";

export const metadata = { title: "Ledger" };

export default function LedgerPage({ params }: PageProps<"/o/[slug]/ledger">) {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Ledger params={params} />
    </Suspense>
  );
}

async function Ledger({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  if (!can(ctx.role, "ledger:read")) notFound();
  const [{ balances, total, transactions }, refunds] = await Promise.all([getLedgerOverview(ctx), listRefundsDue(ctx)]);

  return (
    <div className="space-y-6">
      <Card
        title="Balances"
        description="Double-entry: money in at a provider or in cash, and who it’s owed to. Debits are positive, credits negative."
      >
        {balances.length === 0 ? (
          <p className="text-sm text-slate-500">No money has moved yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {balances.map((b) => (
                <tr key={b.code}>
                  <td className="py-2 text-slate-700">{b.name}</td>
                  <td className="py-2 text-right tabular-nums font-medium text-slate-900">{formatCedis(b.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200">
                <td className="py-2 font-medium text-slate-700">Sum of every account</td>
                <td className="py-2 text-right">
                  {total === 0 ? <Badge tone="emerald">Balances: {formatCedis(0)}</Badge> : <Badge tone="amber">Out by {formatCedis(total)}</Badge>}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      {refunds.length > 0 && (
        <Card title="Refunds owed" description="Money that arrived but can’t count towards a round. Refunds go out with payouts.">
          <ul className="divide-y divide-slate-100 text-sm">
            {refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-slate-700">
                  <span className="font-medium text-slate-900">{r.userName}</span>, round {r.roundNumber}:{" "}
                  {r.status === "duplicate" ? "paid twice" : `sent ${formatCedis(r.receivedPesewas ?? 0)} instead of ${formatCedis(r.amountPesewas)}`}
                </span>
                <span className="tabular-nums font-medium text-slate-900">{formatCedis(r.receivedPesewas ?? 0)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Transactions" description="Newest first. The ledger is append-only: nothing here is ever edited or deleted.">
        {transactions.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {transactions.map((t) => (
              <li key={t.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-slate-900">{t.memo}</p>
                  <p className="text-xs text-slate-400">{formatDate(t.createdAt)}</p>
                </div>
                <table className="mt-1 w-full text-sm">
                  <tbody>
                    {t.entries.map((e, i) => (
                      <tr key={i}>
                        <td className="py-0.5 text-slate-600">
                          {e.name}
                          {e.member && <span className="text-slate-400"> · {e.member}</span>}
                        </td>
                        <td className={`py-0.5 text-right tabular-nums ${e.amountPesewas > 0 ? "text-slate-900" : "text-slate-500"}`}>
                          {formatCedis(e.amountPesewas)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
