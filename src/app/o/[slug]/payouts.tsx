import {
  checkPayoutAction,
  closeCycleAction,
  setPayoutAccountAction,
  simulatePayoutAction,
  startPayoutAction,
} from "@/app/actions/cycles";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Badge, Card } from "@/components/ui";
import { formatCedis } from "@/lib/money";
import { configuredProviderName, getPayoutProvider } from "@/lib/payments";
import { can } from "@/lib/permissions";
import { formatDay } from "@/lib/schedule";
import type { CycleView } from "@/lib/services/cycles";
import type { OrgContext } from "@/lib/services/orgs";
import { getPayoutAccount, listCyclePayouts, listPayoutAccountHints } from "@/lib/services/payouts";

type View = NonNullable<CycleView>;
type PayoutRow = Awaited<ReturnType<typeof listCyclePayouts>>[number];

const NETWORKS = [
  { value: "", label: "Detect from number" },
  { value: "mtn", label: "MTN" },
  { value: "telecel", label: "Telecel" },
  { value: "at", label: "AT" },
];
const NETWORK_LABEL: Record<string, string> = { mtn: "MTN", telecel: "Telecel", at: "AT" };

export async function loadPayouts(ctx: OrgContext, view: View) {
  const [all, myAccount, hints] = await Promise.all([
    listCyclePayouts(ctx, view.cycle.id),
    getPayoutAccount(ctx),
    can(ctx.role, "payouts:send") ? listPayoutAccountHints(ctx) : Promise.resolve([]),
  ]);
  return { all, myAccount, hints };
}

function latestFor(all: PayoutRow[], roundId: string) {
  return all.filter((p) => p.roundId === roundId).at(-1);
}

// ---- The signed-in member's payout --------------------------------------------

export function MyPayout({
  slug,
  ctx,
  view,
  all,
  myAccount,
}: {
  slug: string;
  ctx: OrgContext;
  view: View;
  all: PayoutRow[];
  myAccount: Awaited<ReturnType<typeof getPayoutAccount>>;
}) {
  const myRound = view.rounds.find((r) => r.recipientUserId === ctx.userId);
  if (!myRound) return null;
  const payout = latestFor(all, myRound.id);
  const inFlight = payout?.status === "pending";

  return (
    <Card
      title="Your payout"
      description={`You receive ${formatCedis(view.potPesewas)} in round ${myRound.number}, due ${formatDay(myRound.dueOn)}.`}
    >
      {myRound.status === "paid_out" ? (
        <p className="text-sm text-emerald-700">
          Paid {payout?.method === "cash" ? "in cash" : `to ${payout?.phone ?? "your number"}`}
          {payout?.settledAt ? ` on ${formatDay(payout.settledAt.toISOString().slice(0, 10))}` : ""}.
        </p>
      ) : (
        <div className="space-y-3">
          {inFlight && <p className="text-sm text-indigo-800">Your payout is on its way to {payout?.phone}.</p>}
          {myAccount ? (
            <p className="text-sm text-slate-700">
              Payouts go to <span className="font-medium text-slate-900">{myAccount.phone}</span> ({NETWORK_LABEL[myAccount.network]}).
            </p>
          ) : (
            <p className="text-sm text-amber-800">Add the Mobile Money number your payout should go to.</p>
          )}
          {!inFlight && (
            <ActionForm
              action={setPayoutAccountAction.bind(null, slug)}
              submitLabel={myAccount ? "Change number" : "Save number"}
              pendingLabel="Saving…"
              variant={myAccount ? "secondary" : "primary"}
              className="grid gap-3 sm:grid-cols-[1fr_12rem]"
            >
              <Field label="Payout number" name="phone" inputMode="numeric" autoComplete="tel" defaultValue={myAccount?.phone} placeholder="024 123 4567" />
              <SelectField label="Network" name="network" options={NETWORKS} defaultValue={myAccount?.network ?? ""} />
            </ActionForm>
          )}
          <p className="text-xs text-slate-500">Only you can set this. Your collector can see that it’s set, not change it.</p>
        </div>
      )}
    </Card>
  );
}

// ---- The collector paying out a full round ---------------------------------------

export function RoundPayoutPanel({
  slug,
  ctx,
  view,
  roundId,
  all,
  hints,
}: {
  slug: string;
  ctx: OrgContext;
  view: View;
  roundId: string;
  all: PayoutRow[];
  hints: Awaited<ReturnType<typeof listPayoutAccountHints>>;
}) {
  const round = view.rounds.find((r) => r.id === roundId)!;
  const payout = latestFor(all, roundId);
  const canSend = can(ctx.role, "payouts:send");
  const momoReady = getPayoutProvider() !== null;
  const hint = hints.find((h) => h.userId === round.recipientUserId);
  const hidden = payout ? <input type="hidden" name="payoutId" value={payout.id} /> : null;

  if (round.status === "paid_out") {
    return <Badge tone="emerald">Paid out to {round.recipientName}{payout?.method === "cash" ? " in cash" : ""}</Badge>;
  }
  if (round.status !== "full") return null;

  return (
    <div className="mt-4 space-y-3 rounded-md border border-emerald-200 bg-emerald-50/60 p-4">
      <p className="text-sm font-medium text-emerald-900">
        Round {round.number} is full: {formatCedis(view.potPesewas)} for {round.recipientName}.
      </p>

      {payout?.status === "pending" && (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">Sending to {payout.phone ?? "their number"}. Waiting for the provider to confirm.</p>
          {canSend && (
            <div className="flex flex-wrap gap-2">
              <ActionForm action={checkPayoutAction.bind(null, slug)} submitLabel="Check status" pendingLabel="Checking…" variant="secondary">
                {hidden}
              </ActionForm>
              {configuredProviderName() === "fake" && (
                <>
                  <ActionForm action={simulatePayoutAction.bind(null, slug)} submitLabel="Simulate: provider confirms" pendingLabel="…">
                    {hidden}
                    <input type="hidden" name="outcome" value="success" />
                  </ActionForm>
                  <ActionForm action={simulatePayoutAction.bind(null, slug)} submitLabel="Simulate: wallet rejects" pendingLabel="…" variant="secondary">
                    {hidden}
                    <input type="hidden" name="outcome" value="failed" />
                  </ActionForm>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {payout?.status !== "pending" && (
        <>
          {(payout?.status === "failed" || payout?.status === "reversed") && (
            <p className="text-sm text-rose-700">
              The last payout {payout.status === "reversed" ? "was reversed" : "didn’t go through"}
              {payout.failureReason ? `: ${payout.failureReason}` : ""}. It’s safe to try again.
            </p>
          )}
          {canSend ? (
            <div className="flex flex-wrap items-start gap-2">
              {momoReady &&
                (hint ? (
                  <ActionForm
                    action={startPayoutAction.bind(null, slug)}
                    submitLabel={`Send ${formatCedis(view.potPesewas)} to ${hint.hint} (${NETWORK_LABEL[hint.network]})`}
                    pendingLabel="Sending…"
                    confirm={`Send ${formatCedis(view.potPesewas)} to ${round.recipientName} by MoMo?`}
                  >
                    <input type="hidden" name="roundId" value={round.id} />
                    <input type="hidden" name="method" value="momo" />
                  </ActionForm>
                ) : (
                  <p className="text-sm text-amber-800">{round.recipientName} hasn’t added a payout number yet.</p>
                ))}
              <ActionForm
                action={startPayoutAction.bind(null, slug)}
                submitLabel="Paid in cash"
                pendingLabel="Recording…"
                variant="secondary"
                confirm={`Record that you handed ${formatCedis(view.potPesewas)} in cash to ${round.recipientName}?`}
              >
                <input type="hidden" name="roundId" value={round.id} />
                <input type="hidden" name="method" value="cash" />
              </ActionForm>
            </div>
          ) : (
            <p className="text-sm text-slate-600">Waiting for the collector to pay it out.</p>
          )}
        </>
      )}
    </div>
  );
}

export function CloseCycle({ slug, ctx, view }: { slug: string; ctx: OrgContext; view: View }) {
  if (!can(ctx.role, "cycles:manage") || view.rounds.some((r) => r.status !== "paid_out")) return null;
  return (
    <Card title="Every round is paid out" description="Close this cycle to start the next one. Its records stay in the ledger.">
      <ActionForm action={closeCycleAction.bind(null, slug)} submitLabel={`Close cycle ${view.cycle.number}`} pendingLabel="Closing…">
        <input type="hidden" name="cycleId" value={view.cycle.id} />
      </ActionForm>
    </Card>
  );
}
