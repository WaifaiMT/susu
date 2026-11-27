import Link from "next/link";
import { Suspense } from "react";
import { createOrgAction } from "@/app/actions/orgs";
import { ActionForm, Field } from "@/components/action-form";
import { TopBar } from "@/components/top-bar";
import { Badge, Card, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/permissions";
import { listUserOrganizations } from "@/lib/services/orgs";

export const metadata = { title: "My groups" };

export default function OrgsPage() {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">Your susu groups</h1>
        <Suspense fallback={<Skeleton />}>
          <OrgList />
        </Suspense>
        <Card title="Start a group" description="You’ll be its collector. Each group’s data lives in its own database schema.">
          <ActionForm action={createOrgAction} submitLabel="Create" pendingLabel="Creating…">
            <Field label="Name" name="name" placeholder="Berekum Market Women" />
          </ActionForm>
        </Card>
      </main>
    </>
  );
}

async function OrgList() {
  const user = await requireUser();
  const orgs = await listUserOrganizations(user.id);
  if (orgs.length === 0) {
    return <p className="text-sm text-slate-500">You’re not in any groups yet. Start one below, or ask your collector for an invite.</p>;
  }
  return (
    <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {orgs.map((org) => (
        <li key={org.id}>
          <Link href={`/o/${org.slug}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50">
            <span className="font-medium text-slate-900">{org.name}</span>
            <span className="flex items-center gap-2">
              <Badge>{ROLE_LABELS[org.role]}</Badge>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
