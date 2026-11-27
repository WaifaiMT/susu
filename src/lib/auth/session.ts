import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getOrgContext, type OrgContext } from "@/lib/services/orgs";
import { createSession, deleteSession, getUserBySessionToken, type PublicUser } from "@/lib/services/users";

// The data access layer for the web app: every page and action resolves the
// user and their organisation through these, never by trusting the client.

export const SESSION_COOKIE = "session";

/** The signed-in user, or null. Cached per request, so pages and layouts can all call it. */
export const getOptionalUser = cache(async (): Promise<PublicUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getUserBySessionToken(token) : null;
});

export async function requireUser(): Promise<PublicUser> {
  const user = await getOptionalUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** The user's membership in the organisation at /o/<slug>. Non-members get a 404, not a hint the org exists. */
export const requireOrg = cache(async (slug: string): Promise<OrgContext> => {
  const user = await requireUser();
  const ctx = await getOrgContext(user.id, slug);
  if (!ctx) notFound();
  return ctx;
});

export async function startSession(userId: string): Promise<void> {
  const { token, expiresAt } = await createSession(userId);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  store.delete(SESSION_COOKIE);
}

/** Only allow same-site relative redirects, so ?next= can't send users to another domain. */
export function safeNext(next: unknown, fallback = "/orgs"): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}
