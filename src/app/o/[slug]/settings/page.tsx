import { notFound } from "next/navigation";
import { Suspense } from "react";
import { deleteOrgAction, renameOrgAction } from "@/app/actions/orgs";
import { ActionForm, Field } from "@/components/action-form";
import { Card, Skeleton } from "@/components/ui";
import { requireOrg } from "@/lib/auth/session";
import { can } from "@/lib/permissions";

export const metadata = { title: "Settings" };

export default function SettingsPage({ params }: PageProps<"/o/[slug]/settings">) {
  return (
    <Suspense fallback={<Skeleton lines={4} />}>
      <Settings params={params} />
    </Suspense>
  );
}

async function Settings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  if (!can(ctx.role, "org:update")) notFound();

  return (
    <div className="space-y-6">
      <Card title="Group name">
        <ActionForm action={renameOrgAction.bind(null, slug)} submitLabel="Save">
          <Field label="Name" name="name" defaultValue={ctx.org.name} />
        </ActionForm>
      </Card>

      {can(ctx.role, "org:delete") && (
        <Card title="Delete group" description="Deletes the group’s schema and every cycle in it. This can’t be undone.">
          <ActionForm action={deleteOrgAction.bind(null, slug)} submitLabel="Delete group" pendingLabel="Deleting…" variant="danger">
            <Field label={`Type "${ctx.org.slug}" to confirm`} name="confirmSlug" />
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
