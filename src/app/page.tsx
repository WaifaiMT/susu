import Link from "next/link";
import { TopBar } from "@/components/top-bar";

const FEATURES = [
  {
    title: "Rules that can’t change halfway",
    body: "Once a cycle starts, its amount, dates and payout order are locked by the database itself, not just the app. Not even the collector can change them.",
  },
  {
    title: "A fair payout order",
    body: "Draw the order at random with a cryptographic shuffle, or arrange it by hand while drafting. Every change is written to the audit log.",
  },
  {
    title: "Each group kept apart",
    body: "Every group’s data lives in its own PostgreSQL schema. A query can only ever reach the group it was made for.",
  },
  {
    title: "Collectors, treasurers, members",
    body: "Roles checked on the server in every action through one permission map. Invites are single-use links tied to an email.",
  },
  {
    title: "Money in pesewas, never floats",
    body: "Every amount is a whole number of pesewas, so a ledger can never be a fraction of a cedi out.",
  },
  {
    title: "Coming next: Mobile Money",
    body: "Contributions and payouts through MTN MoMo and Paystack (test mode), a double-entry ledger, and daily reconciliation.",
  },
];

export default function Home() {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 py-16">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900">Run your susu group without the notebook.</h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Everyone pays the same amount each round, one person takes the pot, and the order rotates until everyone has been
          paid. Susu keeps the schedule, the order and the records straight, so nobody has to argue about whose turn it is.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/sign-up" className="rounded-md bg-indigo-600 px-4 py-2.5 font-medium text-white shadow-sm hover:bg-indigo-500">
            Start a group
          </Link>
          <a
            href="https://github.com/WaifaiMT/susu"
            className="rounded-md border border-slate-300 bg-white px-4 py-2.5 font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            View on GitHub
          </a>
        </div>
        <p className="mt-4 max-w-2xl text-sm text-slate-500">
          An open-source demo. It runs on test and sandbox keys only and doesn’t hold real money.
        </p>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="font-semibold text-slate-900">{f.title}</h2>
              <p className="mt-2 text-sm text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
