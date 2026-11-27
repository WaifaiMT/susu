"use server";

import { refresh } from "next/cache";
import { runAction, type ActionState } from "@/lib/actions";
import { requireOrg } from "@/lib/auth/session";
import { createDraftCycle, discardDraft, moveMember, shuffleOrder, startCycle } from "@/lib/services/cycles";

// Every action re-reads the session and membership on the server; the slug
// is bound by the page, and the services check the role.

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function createDraftCycleAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await createDraftCycle(await requireOrg(slug), {
      amount: field(form, "amount"),
      frequency: field(form, "frequency"),
      startsOn: field(form, "startsOn"),
      orderMethod: field(form, "orderMethod"),
    });
    refresh();
  });
}

export async function moveMemberAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    const direction = field(form, "direction") === "up" ? "up" : "down";
    await moveMember(await requireOrg(slug), field(form, "cycleId"), field(form, "userId"), direction);
    refresh();
  });
}

export async function shuffleOrderAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await shuffleOrder(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

export async function startCycleAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await startCycle(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}

export async function discardDraftAction(slug: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction(async () => {
    await discardDraft(await requireOrg(slug), field(form, "cycleId"));
    refresh();
  });
}
