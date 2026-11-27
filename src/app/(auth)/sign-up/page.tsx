import Link from "next/link";
import { Suspense } from "react";
import { signUp } from "@/app/actions/auth";
import { ActionForm, Field } from "@/components/action-form";
import { AuthCard, NextField } from "../auth-card";

export const metadata = { title: "Create an account" };

export default function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  return (
    <AuthCard
      title="Create an account"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-indigo-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <ActionForm action={signUp} submitLabel="Create account" pendingLabel="Creating…">
        <Field label="Name" name="name" autoComplete="name" />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Password" name="password" type="password" autoComplete="new-password" placeholder="At least 10 characters" />
        <Suspense>
          <NextField searchParams={searchParams} />
        </Suspense>
      </ActionForm>
    </AuthCard>
  );
}
