"use server";

import { redirect } from "next/navigation";
import { runAction, type ActionState } from "@/lib/actions";
import { endSession, safeNext, startSession } from "@/lib/auth/session";
import { authenticate, createUser } from "@/lib/services/users";

export async function signUp(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction(async () => {
    const user = await createUser({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    await startSession(user.id);
  });
  if (state.error) return state;
  redirect(safeNext(form.get("next")));
}

export async function signIn(_prev: ActionState, form: FormData): Promise<ActionState> {
  const state = await runAction(async () => {
    const user = await authenticate(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
    await startSession(user.id);
  });
  if (state.error) return state;
  redirect(safeNext(form.get("next")));
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/");
}
