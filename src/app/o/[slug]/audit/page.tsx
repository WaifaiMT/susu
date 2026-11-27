import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton, formatDate } from "@/components/ui";
import { requireOrg } from "@/lib/auth/session";
import { can } from "@/lib/permissions";
import { listAudit } from "@/lib/services/audit";

export const metadata = { title: "Audit log" };

export default function AuditPage({ params }: PageProps<"/o/[slug]/audit">) {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Audit params={params} />
    </Suspense>
  );
}

async function Audit({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  if (!can(ctx.role, "audit:read")) notFound();
  const entries = await listAudit(ctx);

  return (
    <Card title="Audit log" description="The last 100 changes in this group, newest first.">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Who</th>
              <th className="py-2 pr-4 font-medium">Action</th>
              <th className="py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap py-2 pr-4 text-slate-500">{formatDate(e.createdAt)}</td>
                <td className="py-2 pr-4">{e.actorName ?? <span className="text-slate-400">System</span>}</td>
                <td className="py-2 pr-4 font-mono text-xs">{e.action}</td>
                <td className="py-2 text-slate-600">
                  {e.target}
                  {Object.keys(e.metadata).length > 0 && (
                    <span className="ml-1 font-mono text-xs text-slate-400">{JSON.stringify(e.metadata)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
