import "dotenv/config";
import { closePool } from "../src/db/client";
import type { Role } from "../src/db/schema";
import { todayIso } from "../src/lib/schedule";
import { createDraftCycle, getOpenCycle, startCycle } from "../src/lib/services/cycles";
import { acceptInvite, createInvite } from "../src/lib/services/invites";
import { createOrganization, getOrgContext, listUserOrganizations, type OrgContext } from "../src/lib/services/orgs";
import { authenticate, createUser, type PublicUser } from "../src/lib/services/users";

// Demo data: two susu groups, one running and one being drafted, so every
// screen has something to show. Names are made up; emails are example.com.
// Safe to run more than once.
const PASSWORD = "password1234";

async function user(name: string, email: string): Promise<PublicUser> {
  try {
    return await createUser({ name, email, password: PASSWORD });
  } catch {
    return authenticate(email, PASSWORD); // already seeded
  }
}

async function group(collector: PublicUser, name: string): Promise<{ ctx: OrgContext; created: boolean }> {
  const existing = (await listUserOrganizations(collector.id)).find((o) => o.name === name);
  if (existing) return { ctx: (await getOrgContext(collector.id, existing.slug))!, created: false };
  const org = await createOrganization(collector.id, name);
  return { ctx: (await getOrgContext(collector.id, org.slug))!, created: true };
}

async function join(ctx: OrgContext, person: PublicUser, role: Exclude<Role, "collector"> = "member") {
  if (await getOrgContext(person.id, ctx.org.slug)) return;
  const { token } = await createInvite(ctx, { email: person.email, role });
  await acceptInvite(token, person);
}

function firstOfNextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

async function main() {
  const ama = await user("Ama Mensah", "ama@example.com");
  const kofi = await user("Kofi Boateng", "kofi@example.com");
  const akosua = await user("Akosua Owusu", "akosua@example.com");
  const yaw = await user("Yaw Asante", "yaw@example.com");
  const efua = await user("Efua Darko", "efua@example.com");

  // A weekly market susu that's already running
  const market = await group(ama, "Berekum Market Women");
  await join(market.ctx, kofi, "treasurer");
  for (const person of [akosua, yaw, efua]) await join(market.ctx, person);
  if (!(await getOpenCycle(market.ctx))) {
    const cycle = await createDraftCycle(market.ctx, { amount: "50", frequency: "weekly", startsOn: todayIso(), orderMethod: "random" });
    await startCycle(market.ctx, cycle.id);
  }

  // A monthly teachers' susu that's still being set up
  const teachers = await group(kofi, "Sunyani Teachers");
  for (const person of [ama, yaw]) await join(teachers.ctx, person);
  if (!(await getOpenCycle(teachers.ctx))) {
    await createDraftCycle(teachers.ctx, { amount: "200", frequency: "monthly", startsOn: firstOfNextMonth(), orderMethod: "join_order" });
  }

  console.log(`Running cycle: /o/${market.ctx.org.slug}  (collector: ama@example.com)`);
  console.log(`Draft cycle:   /o/${teachers.ctx.org.slug}  (collector: kofi@example.com)`);
  console.log(`\nEveryone's password: ${PASSWORD}  (also akosua@, yaw@, efua@example.com)`);
  await closePool();
}

main().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
