import Link from "next/link";
import { Suspense } from "react";
import { signIn } from "@/app/actions/auth";
import { ActionForm, Field } from "@/components/action-form";
import { AuthCard, NextField } from "../auth-card";

export const metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthCard
      title="Sign in"
      footer={
        <>
          New here?{" "}
          <Link href="/sign-up" className="font-medium text-indigo-600 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <ActionForm action={signIn} submitLabel="Sign in" pendingLabel="Signing in…">
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        {/* ?next= is request data, so it streams in behind a boundary */}
        <Suspense>
          <NextField searchParams={searchParams} />
        </Suspense>
      </ActionForm>
    </AuthCard>
  );
}
