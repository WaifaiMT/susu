import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/actions/auth";
import { getOptionalUser } from "@/lib/auth/session";

export function TopBar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-indigo-600 text-xs font-bold text-white">S</span>
          Susu
        </Link>
        {/* Reads the session cookie, so it streams in after the static shell */}
        <Suspense fallback={<span className="h-5 w-24 animate-pulse rounded bg-slate-100" />}>
          <UserMenu />
        </Suspense>
      </div>
    </header>
  );
}

async function UserMenu() {
  const user = await getOptionalUser();
  if (!user) {
    return (
      <nav className="flex items-center gap-4 text-sm">
        <Link href="/sign-in" className="text-slate-600 hover:text-slate-900">
          Sign in
        </Link>
        <Link href="/sign-up" className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">
          Sign up
        </Link>
      </nav>
    );
  }
  return (
    <nav className="flex items-center gap-4 text-sm">
      <Link href="/orgs" className="text-slate-600 hover:text-slate-900">
        My groups
      </Link>
      <span className="hidden text-slate-400 sm:inline">{user.email}</span>
      <form action={signOut}>
        <button className="text-slate-600 hover:text-slate-900">Sign out</button>
      </form>
    </nav>
  );
}
