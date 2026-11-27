import { connection } from "next/server";
import { Suspense } from "react";
import {
  createDraftCycleAction,
  discardDraftAction,
  moveMemberAction,
  shuffleOrderAction,
  startCycleAction,
} from "@/app/actions/cycles";
import { ActionForm, Field, SelectField } from "@/components/action-form";
import { Badge, Card, Skeleton, Stat } from "@/components/ui";
import type { RoundStatus } from "@/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { formatCedis } from "@/lib/money";
import { can } from "@/lib/permissions";
import { FREQUENCY_LABELS, formatDay, todayIso } from "@/lib/schedule";
import { getOpenCycle, type CycleView } from "@/lib/services/cycles";
import { listMembers } from "@/lib/services/members";
import type { OrgContext } from "@/lib/services/orgs";

export const metadata = { title: "Cycle" };

export default function CyclePage({ params }: PageProps<"/o/[slug]">) {
  return (
    <Suspense fallback={<Skeleton lines={5} />}>
      <Cycle params={params} />
    </Suspense>
  );
}

async function Cycle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  // "Today" decides what's overdue, so this page always renders per request
  await connection();
  const view = await getOpenCycle(ctx);

  if (!view) return <NoCycle ctx={ctx} slug={slug} />;
  if (view.cycle.status === "draft") return <DraftCycle ctx={ctx} slug={slug} view={view} />;
  return <ActiveCycle ctx={ctx} view={view} />;
}

// ---- No cycle yet ----------------------------------------------------------

async function NoCycle({ ctx, slug }: { ctx: OrgContext; slug: string }) {
  if (!can(ctx.role, "cycles:manage")) {
    return (
      <Card title="No cycle yet">
        <p className="text-sm text-slate-600">Your collector hasn’t set up a cycle yet. You’ll see the payout order and dates here once they do.</p>
      </Card>
    );
  }

  const members = await listMembers(ctx);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Card
        title="Set up a cycle"
        description={`Everyone in the group (${members.length} ${members.length === 1 ? "person" : "people"}) pays the same amount each round, and one person receives the whole pot. You can change the order before you start.`}
      >
        <ActionForm action={createDraftCycleAction.bind(null, slug)} submitLabel="Draft cycle" pendingLabel="Drafting…">
          <Field label="Contribution per round (GH₵)" name="amount" inputMode="decimal" placeholder="100.00" />
          <SelectField
            label="How often"
            name="frequency"
            defaultValue="weekly"
            options={Object.entries(FREQUENCY_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Field label="First round due" name="startsOn" type="date" defaultValue={todayIso()} min={todayIso()} />
          <SelectField
            label="Payout order"
            name="orderMethod"
            defaultValue="random"
            options={[
              { value: "random", label: "Random draw (fairest)" },
              { value: "join_order", label: "Order people joined the group" },
            ]}
          />
        </ActionForm>
        {members.length < 2 && (
          <p className="mt-4 text-sm text-amber-800">You’re the only member so far. Invite people from the Members tab first.</p>
        )}
      </Card>
      <HowItWorks />
    </div>
  );
}

function HowItWorks() {
  return (
    <Card title="How a susu works">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
        <li>Every member pays the same amount each round.</li>
        <li>Each round, one member receives the whole pot.</li>
        <li>The order rotates until everyone has received once. That’s one cycle.</li>
        <li>Once a cycle starts, its amount, dates and order are locked, so nobody can change the rules halfway.</li>
      </ol>
    </Card>
  );
}

// ---- Draft -----------------------------------------------------------------

function CycleSummary({ view }: { view: NonNullable<CycleView> }) {
  const { cycle, members, potPesewas } = view;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Each member pays" value={formatCedis(cycle.amountPesewas)} detail={FREQUENCY_LABELS[cycle.frequency].toLowerCase()} />
      <Stat label="Pot per round" value={formatCedis(potPesewas)} detail={`${members.length} members`} />
      <Stat label="First round" value={formatDay(cycle.startsOn)} />
      <Stat label="Rounds" value={members.length} detail="one payout each" />
    </div>
  );
}

function DraftCycle({ ctx, slug, view }: { ctx: OrgContext; slug: string; view: NonNullable<CycleView> }) {
  const { cycle, members, notInCycle, leftGroup } = view;
  const canManage = can(ctx.role, "cycles:manage");
  const hidden = <input type="hidden" name="cycleId" value={cycle.id} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Cycle {cycle.number}</h2>
        <Badge tone="amber">Draft</Badge>
      </div>
      <CycleSummary view={view} />

      {(notInCycle > 0 || leftGroup.length > 0) && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {notInCycle > 0 && (
            <p>
              {notInCycle} {notInCycle === 1 ? "person has" : "people have"} joined the group since this draft was made and{" "}
              {notInCycle === 1 ? "isn’t" : "aren’t"} in it.
            </p>
          )}
          {leftGroup.length > 0 && <p>{leftGroup.join(", ")} left the group.</p>}
          {canManage && <p className="mt-1">Discard the draft and draft again to include everyone.</p>}
        </div>
      )}

      <Card
        title="Payout order"
        description={canManage ? "Round 1 is paid to the first person, round 2 to the second, and so on." : "Your collector is still setting this up. It may change before the cycle starts."}
      >
        <ol className="divide-y divide-slate-100">
          {members.map((m, i) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex items-center gap-3">
                <span className="w-6 text-right text-sm tabular-nums text-slate-400">{m.position}</span>
                <span className="font-medium text-slate-900">
                  {m.name} {m.userId === ctx.userId && <span className="text-sm font-normal text-slate-400">(you)</span>}
                </span>
              </span>
              {canManage && (
                <span className="flex gap-2">
                  {(["up", "down"] as const).map((direction) => {
                    const disabled = direction === "up" ? i === 0 : i === members.length - 1;
                    return disabled ? (
                      <span key={direction} className="w-[4.25rem]" />
                    ) : (
                      <ActionForm
                        key={direction}
                        action={moveMemberAction.bind(null, slug)}
                        submitLabel={direction === "up" ? "↑ Up" : "↓ Down"}
                        pendingLabel="…"
                        variant="secondary"
                      >
                        {hidden}
                        <input type="hidden" name="userId" value={m.userId} />
                        <input type="hidden" name="direction" value={direction} />
                      </ActionForm>
                    );
                  })}
                </span>
              )}
            </li>
          ))}
        </ol>
      </Card>

      {canManage && (
        <div className="flex flex-wrap gap-3">
          <ActionForm
            action={startCycleAction.bind(null, slug)}
            submitLabel="Start cycle"
            pendingLabel="Starting…"
            confirm="Start this cycle? Once it starts, the amount, dates and payout order can't be changed."
          >
            {hidden}
          </ActionForm>
          <ActionForm action={shuffleOrderAction.bind(null, slug)} submitLabel="Shuffle order" pendingLabel="Shuffling…" variant="secondary">
            {hidden}
          </ActionForm>
          <ActionForm
            action={discardDraftAction.bind(null, slug)}
            submitLabel="Discard draft"
            pendingLabel="Discarding…"
            variant="secondary"
            confirm="Discard this draft?"
          >
            {hidden}
          </ActionForm>
        </div>
      )}
    </div>
  );
}

// ---- Active ----------------------------------------------------------------

const STATUS_BADGE: Record<RoundStatus, { label: string; tone: "slate" | "indigo" | "emerald" }> = {
  open: { label: "Collecting", tone: "slate" },
  full: { label: "Ready to pay out", tone: "indigo" },
  paid_out: { label: "Paid out", tone: "emerald" },
};

function ActiveCycle({ ctx, view }: { ctx: OrgContext; view: NonNullable<CycleView> }) {
  const { cycle, rounds, currentRound, potPesewas } = view;
  const today = todayIso();
  const myRound = rounds.find((r) => r.recipientUserId === ctx.userId);
  const overdue = currentRound && currentRound.dueOn < today;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Cycle {cycle.number}</h2>
        <Badge tone="emerald">Running</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Each member pays" value={formatCedis(cycle.amountPesewas)} detail={FREQUENCY_LABELS[cycle.frequency].toLowerCase()} />
        <Stat label="Pot per round" value={formatCedis(potPesewas)} />
        <Stat
          label="Current round"
          value={currentRound ? `${currentRound.number} of ${rounds.length}` : "Done"}
          detail={currentRound ? `due ${formatDay(currentRound.dueOn)}` : undefined}
        />
        <Stat
          label="Your payout"
          value={myRound ? `Round ${myRound.number}` : "Not in this cycle"}
          detail={myRound ? formatDay(myRound.dueOn) : undefined}
        />
      </div>

      {currentRound && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-slate-700">
              <span className="font-semibold text-slate-900">{currentRound.recipientName}</span> receives{" "}
              <span className="font-semibold text-slate-900">{formatCedis(potPesewas)}</span> in round {currentRound.number}.
            </p>
            {overdue ? <Badge tone="amber">Overdue since {formatDay(currentRound.dueOn)}</Badge> : <Badge>Due {formatDay(currentRound.dueOn)}</Badge>}
          </div>
        </Card>
      )}

      <Card title="Schedule" description="Fixed when the cycle started. Nobody can change it, including the collector.">
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="px-5 py-2 font-medium">Round</th>
                <th className="px-5 py-2 font-medium">Due</th>
                <th className="px-5 py-2 font-medium">Receives</th>
                <th className="px-5 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rounds.map((r) => (
                <tr key={r.id} className={r.id === currentRound?.id ? "bg-indigo-50/50" : undefined}>
                  <td className="px-5 py-2.5 tabular-nums text-slate-500">{r.number}</td>
                  <td className="px-5 py-2.5 text-slate-700">{formatDay(r.dueOn)}</td>
                  <td className="px-5 py-2.5 font-medium text-slate-900">
                    {r.recipientName} {r.recipientUserId === ctx.userId && <span className="font-normal text-slate-400">(you)</span>}
                  </td>
                  <td className="px-5 py-2.5">
                    <Badge tone={STATUS_BADGE[r.status].tone}>{STATUS_BADGE[r.status].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
