import bcrypt from "bcryptjs";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { sessions, users } from "@/db/schema";
import { AppError } from "../errors";
import { generateToken, hashToken } from "../tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SignUpInput = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});

export type PublicUser = { id: string; email: string; name: string };

export async function createUser(input: { name: string; email: string; password: string }): Promise<PublicUser> {
  const parsed = SignUpInput.safeParse(input);
  if (!parsed.success) throw new AppError("validation", parsed.error.issues[0].message);
  const { name, email, password } = parsed.data;

  const db = getDb();
  const existing = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (existing.length > 0) throw new AppError("conflict", "An account with that email already exists.");

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db
    .insert(users)
    .values({ name, email, passwordHash })
    .returning({ id: users.id, email: users.email, name: users.name });
  return user;
}

// A real hash of a throwaway password, so an unknown email takes as long to
// reject as a wrong password and doesn't reveal which emails have accounts
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

export async function authenticate(email: string, password: string): Promise<PublicUser> {
  const [user] = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new AppError("unauthenticated", "Incorrect email or password.");
  return { id: user.id, email: user.email, name: user.name };
}

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function getUserBySessionToken(token: string): Promise<PublicUser | null> {
  const [row] = await getDb()
    .select({ id: users.id, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)));
  return row ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
