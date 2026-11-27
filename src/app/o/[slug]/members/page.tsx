import { Suspense } from "react";
import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInviteAction } from "@/app/actions/orgs";
import { ActionForm, Field } from "@/components/action-form";
import { Badge, Card, Skeleton, formatDate } from "@/components/ui";
import { requireOrg } from "@/lib/auth/session";
import { can, canAssignRole, ROLE_LABELS } from "@/lib/permissions";
import { listPendingInvites } from "@/lib/services/invites";
import { listMembers } from "@/lib/services/members";
import type { Role } from "@/db/schema";

export const metadata = { title: "Members" };

const ROLES: Role[] = ["collector", "treasurer", "member"];

export default function MembersPage({ params }: PageProps<"/o/[slug]/members">) {
  return (
    <Suspense fallback={<Skeleton lines={5} />}>
      <Members params={params} />
    </Suspense>
  );
}

async function Members({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireOrg(slug);
  const members = await listMembers(ctx);
  const canManage = can(ctx.role, "members:manage");
  const canInvite = can(ctx.role, "members:invite");
  const invites = canInvite ? await listPendingInvites(ctx) : [];

  return (
    <div className="space-y-6">
      <Card title="Members">
        <ul className="divide-y divide-slate-100">
          {members.map((m) => {
            const isMe = m.userId === ctx.userId;
            const editable = canManage && !isMe && canAssignRole(ctx.role, m.role);
            return (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-slate-900">
                    {m.name} {isMe && <span className="text-sm font-normal text-slate-400">(you)</span>}
                  </p>
                  <p className="text-sm text-slate-500">{m.email}</p>
                </div>
                <div className="flex items-center gap-3">
                  {editable ? (
                    <ActionForm
                      key={`${m.userId}-${m.role}`}
                      action={changeRoleAction.bind(null, slug)}
                      submitLabel="Update"
                      variant="secondary"
                      className="flex items-center gap-2"
                    >
                      <input type="hidden" name="userId" value={m.userId} />
                      <select
                        name="role"
                        defaultValue={m.role}
                        aria-label={`Role for ${m.name}`}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                      >
                        {ROLES.filter((r) => canAssignRole(ctx.role, r)).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </ActionForm>
                  ) : (
                    <Badge>{ROLE_LABELS[m.role]}</Badge>
                  )}
                  {(editable || isMe) && (
                    <ActionForm
                      action={removeMemberAction.bind(null, slug)}
                      submitLabel={isMe ? "Leave" : "Remove"}
                      variant="secondary"
                      confirm={isMe ? `Leave ${ctx.org.name}?` : `Remove ${m.name}?`}
                    >
                      <input type="hidden" name="userId" value={m.userId} />
                    </ActionForm>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {canInvite && (
        <>
          <Card title="Invite someone" description="They’ll get a single-use link that expires in 7 days and only works for this email.">
            <ActionForm action={inviteMemberAction.bind(null, slug)} submitLabel="Create invite" pendingLabel="Creating…" className="space-y-3 break-all">
              <Field label="Email" name="email" type="email" />
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Role</span>
                <select name="role" defaultValue="member" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                  <option value="member">Member</option>
                  <option value="treasurer">Treasurer</option>
                </select>
              </label>
            </ActionForm>
          </Card>

          {invites.length > 0 && (
            <Card title="Pending invites">
              <ul className="divide-y divide-slate-100">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{invite.email}</p>
                      <p className="text-xs text-slate-500">
                        {ROLE_LABELS[invite.role]} · expires {formatDate(invite.expiresAt)}
                      </p>
                    </div>
                    <ActionForm action={revokeInviteAction.bind(null, slug)} submitLabel="Revoke" variant="secondary">
                      <input type="hidden" name="inviteId" value={invite.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
