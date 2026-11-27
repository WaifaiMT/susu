import {
  checkContributionAction,
  recordCashAction,
  simulatePaymentAction,
  startContributionAction,
  submitOtpAction,
} from "@/app/actions/cycles";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Badge, Card } from "@/components/ui";
import { formatCedis } from "@/lib/money";
import { PROVIDER_LABELS, configuredProviderName } from "@/lib/payments";
import { FAKE_OTP } from "@/lib/payments/fake";
import { can } from "@/lib/permissions";
import { formatDay } from "@/lib/schedule";
import { listCycleContributions, payableRoundIds } from "@/lib/services/contributions";
import type { CycleView } from "@/lib/services/cycles";
import type { OrgContext } from "@/lib/services/orgs";

type View = NonNullable<CycleView>;
type Contribution = Awaited<ReturnType<typeof listCycleContributions>>[number];

const NETWORKS = [
  { value: "", label: "Detect from number" },
  { value: "mtn", label: "MTN" },
  { value: "telecel", label: "Telecel" },
  { value: "at", label: "AT" },
];
const NETWORK_LABEL: Record<string, string> = { mtn: "MTN", telecel: "Telecel", at: "AT" };

export async function loadPayments(ctx: OrgContext, view: View, today: string) {
  const all = await listCycleContributions(ctx, view.cycle.id);
  return { all, payable: payableRoundIds(view.rounds, today) };
}

/** Paid / waiting / not paid, per member, for one round. */
function roundStatus(all: Contribution[], roundId: string, userId: string) {
  const mine = all.filter((c) => c.roundId === roundId && c.userId === userId);
  const paid = mine.find((c) => c.status === "succeeded");
  const latest = mine.at(-1);
  return { paid, latest, waiting: latest && (latest.status === "pending" || latest.status === "otp_required") ? latest : undefined };
}

// ---- The signed-in member's own contribution -------------------------------

export function MyContribution({
  ctx,
  slug,
  view,
  all,
  payable,
}: {
  ctx: OrgContext;
  slug: string;
  view: View;
  all: Contribution[];
  payable: string[];
}) {
  if (!view.members.some((m) => m.userId === ctx.userId)) return null;
  const provider = configuredProviderName();
  const owed = view.rounds.filter((r) => payable.includes(r.id) && !roundStatus(all, r.id, ctx.userId).paid);
  const lastPhone = [...all].reverse().find((c) => c.userId === ctx.userId && c.phone)?.phone ?? undefined;

  return (
    <Card
      title="Your contribution"
      description={`${PROVIDER_LABELS[provider]}${provider === "fake" ? ": nothing real is charged." : ". Test keys only: no real money moves."}`}
    >
      {owed.length === 0 ? (
        <p className="text-sm text-emerald-700">You’re up to date. Nothing to pay right now.</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {owed.map((round) => {
            const { latest, waiting } = roundStatus(all, round.id, ctx.userId);
            const contributionId = <input type="hidden" name="contributionId" value={waiting?.id ?? ""} />;
            return (
              <div key={round.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
                <p className="text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">Round {round.number}</span> · {formatCedis(view.cycle.amountPesewas)} · due{" "}
                  {formatDay(round.dueOn)} · {round.recipientName} receives
                </p>

                {waiting?.status === "pending" && (
                  <div className="space-y-3 rounded-md border border-indigo-100 bg-indigo-50/60 p-3">
                    <p className="text-sm text-indigo-900">
                      Waiting for you to approve {formatCedis(waiting.amountPesewas)} on {waiting.phone}
                      {waiting.network ? ` (${NETWORK_LABEL[waiting.network]})` : ""}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={checkContributionAction.bind(null, slug)} submitLabel="Check status" pendingLabel="Checking…" variant="secondary">
                        {contributionId}
                      </ActionForm>
                      {provider === "fake" && (
                        <>
                          <ActionForm action={simulatePaymentAction.bind(null, slug)} submitLabel="Simulate: approve on phone" pendingLabel="…">
                            {contributionId}
                            <input type="hidden" name="outcome" value="approve" />
                          </ActionForm>
                          <ActionForm action={simulatePaymentAction.bind(null, slug)} submitLabel="Simulate: decline" pendingLabel="…" variant="secondary">
                            {contributionId}
                            <input type="hidden" name="outcome" value="decline" />
                          </ActionForm>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {waiting?.status === "otp_required" && (
                  <ActionForm action={submitOtpAction.bind(null, slug)} submitLabel="Confirm" pendingLabel="Confirming…">
                    {contributionId}
                    <Field
                      label={`Code sent to ${waiting.phone}`}
                      name="otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      hint={provider === "fake" ? `Test provider: the code is ${FAKE_OTP}.` : undefined}
                    />
                  </ActionForm>
                )}

                {!waiting && (
                  <>
                    {latest?.status === "failed" && (
                      <p className="text-sm text-rose-700">Your last attempt didn’t go through{latest.failureReason ? `: ${latest.failureReason}` : ""}.</p>
                    )}
                    <ActionForm
                      action={startContributionAction.bind(null, slug)}
                      submitLabel={`Pay ${formatCedis(view.cycle.amountPesewas)} with MoMo`}
                      pendingLabel="Sending prompt…"
                      className="grid gap-3 sm:grid-cols-[1fr_12rem]"
                    >
                      <input type="hidden" name="roundId" value={round.id} />
                      <Field
                        label="Mobile Money number"
                        name="phone"
                        inputMode="numeric"
                        autoComplete="tel"
                        defaultValue={lastPhone}
                        placeholder="024 123 4567"
                        hint={provider === "fake" ? "Test numbers: ending 0000 is declined, ending 1111 asks for an OTP." : undefined}
                      />
                      <SelectField label="Network" name="network" options={NETWORKS} />
                    </ActionForm>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---- Who has paid --------------------------------------------------------------

export function RoundPayments({
  ctx,
  slug,
  view,
  all,
  payable,
}: {
  ctx: OrgContext;
  slug: string;
  view: View;
  all: Contribution[];
  payable: string[];
}) {
  const canRecordCash = can(ctx.role, "contributions:record_cash");
  const shown = view.rounds.filter((r) => payable.includes(r.id) || r.status === "full");
  if (shown.length === 0) return null;

  return (
    <>
      {shown.map((round) => {
        const paidCount = view.members.filter((m) => roundStatus(all, round.id, m.userId).paid).length;
        const percent = Math.round((paidCount / view.members.length) * 100);
        return (
          <Card
            key={round.id}
            title={`Round ${round.number}: ${paidCount} of ${view.members.length} paid`}
            description={`${formatCedis(paidCount * view.cycle.amountPesewas)} of ${formatCedis(view.potPesewas)} collected for ${round.recipientName}. Due ${formatDay(round.dueOn)}.`}
          >
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
            </div>
            <ul className="divide-y divide-slate-100">
              {view.members.map((m) => {
                const { paid, waiting } = roundStatus(all, round.id, m.userId);
                return (
                  <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span className="font-medium text-slate-900">
                      {m.name} {m.userId === ctx.userId && <span className="font-normal text-slate-400">(you)</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {paid ? (
                        <Badge tone="emerald">
                          Paid · {paid.method === "cash" ? `cash${paid.recordedByName ? `, recorded by ${paid.recordedByName}` : ""}` : "MoMo"}
                        </Badge>
                      ) : waiting ? (
                        <Badge tone="indigo">Waiting for approval</Badge>
                      ) : (
                        <Badge>Not paid</Badge>
                      )}
                      {!paid && canRecordCash && round.status === "open" && (
                        <ActionForm
                          action={recordCashAction.bind(null, slug)}
                          submitLabel="Record cash"
                          pendingLabel="Recording…"
                          variant="secondary"
                          confirm={`Record ${formatCedis(view.cycle.amountPesewas)} cash from ${m.name} for round ${round.number}?`}
                        >
                          <input type="hidden" name="roundId" value={round.id} />
                          <input type="hidden" name="userId" value={m.userId} />
                        </ActionForm>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </>
  );
}

export function RefundsAlert({ all, slug, ctx }: { all: Contribution[]; slug: string; ctx: OrgContext }) {
  if (!can(ctx.role, "ledger:read")) return null;
  const owed = all.filter((c) => c.status === "duplicate" || c.status === "mismatch");
  if (owed.length === 0) return null;
  const total = owed.reduce((sum, c) => sum + (c.receivedPesewas ?? 0), 0);
  return (
    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      {owed.length} {owed.length === 1 ? "payment needs" : "payments need"} refunding ({formatCedis(total)}): paid twice, or the wrong amount.{" "}
      <a href={`/o/${slug}/ledger`} className="font-medium underline">
        See the ledger
      </a>
      .
    </div>
  );
}

export function paidCountFor(all: Contribution[], roundId: string): number {
  return all.filter((c) => c.roundId === roundId && c.status === "succeeded").length;
}
