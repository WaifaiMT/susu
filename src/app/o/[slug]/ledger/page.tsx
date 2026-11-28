import { notFound } from "next/navigation";
import { Suspense } from "react";
import { reconcileAction, recordCashDepositAction, startRefundAction, checkPayoutAction } from "@/app/actions/cycles";
import { ActionForm, Field } from "@/components/action-form";
import { Badge, Card, Skeleton, formatDate } from "@/components/ui";
import { requireOrg } from "@/lib/auth/session";
import { formatCedis } from "@/lib/money";
import { PROVIDER_LABELS, configuredProviderName, getPayoutProvider } from "@/lib/payments";
import { can } from "@/lib/permissions";
import { getLedgerOverview } from "@/lib/services/ledger";
import { listRefunds } from "@/lib/services/payouts";
import { listReconciliationRuns } from "@/lib/services/reconciliation";

export const metadata = { title: "Ledger" };

export default function LedgerPage({ params }: PageProps<"/o/[slug]/ledger">) {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Ledger params={params} />
    </Suspense>
  );
}

const RESULT_TONE = { matched: "emerald", fixed: "indigo", problem: "amber" } as const;

async function Ledger({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  if (!can(ctx.role, "ledger:read")) notFound();
  const [{ balances, total, transactions }, refunds, runs] = await Promise.all([
    getLedgerOverview(ctx),
    listRefunds(ctx),
    can(ctx.role, "reconcile:run") ? listReconciliationRuns(ctx) : Promise.resolve([]),
  ]);
  const provider = configuredProviderName();
  const canSend = can(ctx.role, "payouts:send");
  const refundsReady = getPayoutProvider() !== null;
  const cash = balances.find((b) => b.code === "cash")?.balance ?? 0;

  return (
    <div className="space-y-6">
      <Card
        title="Balances"
        description="Double-entry: money held at the provider or in cash, and who it’s owed to. Debits are positive, credits negative."
      >
        {balances.length === 0 ? (
          <p className="text-sm text-slate-500">No money has moved yet.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {balances.map((b) => (
                <tr key={b.code}>
                  <td className="py-2 text-slate-700">{b.name}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-slate-900">{formatCedis(b.balance)}</td>
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

      {can(ctx.role, "reconcile:run") && (
        <Card
          title="Reconciliation"
          description={`Checks every payment and payout from the last 7 days with ${PROVIDER_LABELS[provider]}, catches up anything we missed, and checks the ledger against the records.`}
        >
          <ActionForm action={reconcileAction.bind(null, slug)} submitLabel="Reconcile now" pendingLabel="Checking with the provider…">
            {null}
          </ActionForm>
          {runs.length > 0 && (
            <ul className="mt-4 divide-y divide-slate-100">
              {runs.map((run) => (
                <li key={run.id} className="py-3">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="text-slate-700">{formatDate(run.ranAt)}</span>
                      <span className="flex gap-2">
                        <Badge tone="emerald">{run.matched} matched</Badge>
                        {run.fixed > 0 && <Badge tone="indigo">{run.fixed} fixed</Badge>}
                        {run.problems > 0 && <Badge tone="amber">{run.problems} problems</Badge>}
                      </span>
                    </summary>
                    <table className="mt-2 w-full text-xs">
                      <tbody className="divide-y divide-slate-50">
                        {run.report.map((item, i) => (
                          <tr key={i}>
                            <td className="py-1 pr-2 text-slate-500">{item.kind}</td>
                            <td className="py-1 pr-2 font-mono text-slate-500">{item.reference.slice(0, 18)}</td>
                            <td className="py-1 pr-2 text-slate-700">ours: {item.ours}</td>
                            <td className="py-1 pr-2 text-slate-700">theirs: {item.theirs}</td>
                            <td className="py-1 text-right">
                              <Badge tone={RESULT_TONE[item.result]}>{item.result}</Badge>
                              {item.note && <span className="ml-2 text-slate-500">{item.note}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {refunds.length > 0 && (
        <Card title="Refunds owed" description="Money that arrived but can’t count towards a round. It goes back to the number that paid it.">
          <ul className="divide-y divide-slate-100 text-sm">
            {refunds.map((r) => (
              <li key={r.contributionId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-slate-700">
                  <span className="font-medium text-slate-900">{r.userName}</span>, round {r.roundNumber}:{" "}
                  {r.status === "duplicate" ? "paid twice" : `sent ${formatCedis(r.receivedPesewas ?? 0)} instead of ${formatCedis(r.amountPesewas)}`}
                  {" · "}
                  <span className="tabular-nums font-medium text-slate-900">{formatCedis(r.receivedPesewas ?? 0)}</span>
                </span>
                <span className="flex items-center gap-2">
                  {r.refund?.status === "succeeded" ? (
                    <Badge tone="emerald">Refunded</Badge>
                  ) : r.refund?.status === "pending" ? (
                    <>
                      <Badge tone="indigo">Refund on its way</Badge>
                      {canSend && (
                        <ActionForm action={checkPayoutAction.bind(null, slug)} submitLabel="Check status" pendingLabel="…" variant="secondary">
                          <input type="hidden" name="payoutId" value={r.refund.id} />
                        </ActionForm>
                      )}
                    </>
                  ) : canSend && refundsReady ? (
                    <ActionForm
                      action={startRefundAction.bind(null, slug)}
                      submitLabel={`Refund to ${r.phone}`}
                      pendingLabel="Sending…"
                      variant="secondary"
                      confirm={`Send ${formatCedis(r.receivedPesewas ?? 0)} back to ${r.userName} (${r.phone})?`}
                    >
                      <input type="hidden" name="contributionId" value={r.contributionId} />
                    </ActionForm>
                  ) : (
                    <Badge tone="amber">Owed</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {can(ctx.role, "cash:deposit") && cash > 0 && (
        <Card
          title="Deposit cash to the provider"
          description={`${formatCedis(cash)} is held in cash. Record it here after you top up the ${PROVIDER_LABELS[provider]} balance, so pots paid partly in cash can go out by MoMo.`}
        >
          <ActionForm action={recordCashDepositAction.bind(null, slug)} submitLabel="Record deposit" pendingLabel="Recording…" className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <Field label="Amount (GH₵)" name="amount" inputMode="decimal" placeholder="50.00" />
            <Field label="Note" name="note" required={false} placeholder="Deposited at the MoMo agent, Berekum station" />
          </ActionForm>
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
