import Link from "next/link";
import { Suspense } from "react";
import { acceptInviteAction } from "@/app/actions/orgs";
import { ActionForm } from "@/components/action-form";
import { TopBar } from "@/components/top-bar";
import { Card, Skeleton } from "@/components/ui";
import { getOptionalUser } from "@/lib/auth/session";
import { getInvite } from "@/lib/services/invites";

export const metadata = { title: "Invitation" };

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-md px-4 py-16">
        <Suspense fallback={<Skeleton />}>
          <Invite params={params} />
        </Suspense>
      </main>
    </>
  );
}

async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInvite(token);
  if (!invite) {
    return (
      <Card title="Invite not found">
        <p className="text-sm text-slate-600">This invite link is invalid, has expired, or was already used. Ask for a new one.</p>
      </Card>
    );
  }

  const user = await getOptionalUser();
  const next = encodeURIComponent(`/invite/${token}`);

  return (
    <Card title={`Join ${invite.orgName}`} description={`You’ve been invited as ${invite.role === "treasurer" ? "a treasurer" : "a member"}.`}>
      {!user ? (
        <p className="text-sm text-slate-600">
          This invite is for <strong>{invite.email}</strong>.{" "}
          <Link href={`/sign-in?next=${next}`} className="font-medium text-indigo-600 hover:underline">
            Sign in
          </Link>{" "}
          or{" "}
          <Link href={`/sign-up?next=${next}`} className="font-medium text-indigo-600 hover:underline">
            create an account
          </Link>{" "}
          with that email to accept it.
        </p>
      ) : user.email.toLowerCase() !== invite.email ? (
        <p className="text-sm text-slate-600">
          This invite is for <strong>{invite.email}</strong>, but you’re signed in as {user.email}. Sign in with the invited
          email to accept it.
        </p>
      ) : (
        <ActionForm action={acceptInviteAction.bind(null, token)} submitLabel="Accept invitation" pendingLabel="Joining…">
          <p className="text-sm text-slate-600">Signed in as {user.email}.</p>
        </ActionForm>
      )}
    </Card>
  );
}
