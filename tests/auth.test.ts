import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { sessions } from "@/db/schema";
import { hashToken } from "@/lib/tokens";
import { authenticate, createSession, createUser, deleteSession, getUserBySessionToken } from "@/lib/services/users";
import { makeUser } from "./helpers";

describe("accounts", () => {
  it("validates sign-up input", async () => {
    await expect(createUser({ name: "A", email: "not-an-email", password: "long enough pw" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(createUser({ name: "A", email: "a@example.com", password: "short" })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("treats emails as case-insensitive", async () => {
    const user = await makeUser();
    await expect(
      createUser({ name: "Copy", email: user.email.toUpperCase(), password: "another long password" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(authenticate(user.email.toUpperCase(), "correct horse battery")).resolves.toMatchObject({ id: user.id });
  });

  it("rejects a wrong password and an unknown email with the same message", async () => {
    const user = await makeUser();
    const wrongPassword = await authenticate(user.email, "wrong password!!").catch((e) => e);
    const unknownEmail = await authenticate("nobody@example.com", "whatever pw!!").catch((e) => e);
    expect(wrongPassword.code).toBe("unauthenticated");
    expect(wrongPassword.message).toBe(unknownEmail.message);
  });
});

describe("sessions", () => {
  it("stores only a hash of the session token", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);

    const stored = await getDb().select().from(sessions).where(eq(sessions.userId, user.id));
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(hashToken(token));
    expect(stored[0].tokenHash).not.toBe(token);
    expect(await getUserBySessionToken(token)).toMatchObject({ id: user.id });
  });

  it("rejects expired and deleted sessions", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(await getUserBySessionToken(token)).toBeNull();

    const second = await createSession(user.id);
    await deleteSession(second.token);
    expect(await getUserBySessionToken(second.token)).toBeNull();
  });
});
