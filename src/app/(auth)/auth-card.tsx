import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-8 flex items-center gap-2 font-semibold text-slate-900">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-xs font-bold text-white">S</span>
        Susu
      </Link>
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-5 text-xl font-semibold text-slate-900">{title}</h1>
        {children}
      </div>
      <p className="mt-4 text-center text-sm text-slate-500">{footer}</p>
    </main>
  );
}

/** Carries ?next= through the form so users land back where they were headed. */
export async function NextField({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const next = (await searchParams).next;
  return typeof next === "string" ? <input type="hidden" name="next" value={next} /> : null;
}
