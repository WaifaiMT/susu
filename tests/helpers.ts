import { randomBytes } from "node:crypto";
import type { Role } from "@/db/schema";
import { acceptInvite, createInvite } from "@/lib/services/invites";
import { createOrganization, getOrgContext, type OrgContext } from "@/lib/services/orgs";
import { createUser, type PublicUser } from "@/lib/services/users";

export async function makeUser(name = "Test User"): Promise<PublicUser> {
  const email = `user-${randomBytes(6).toString("hex")}@example.com`;
  return createUser({ name, email, password: "correct horse battery" });
}

export async function makeOrg(owner: PublicUser, name = `Org ${randomBytes(3).toString("hex")}`): Promise<OrgContext> {
  const org = await createOrganization(owner.id, name);
  return (await ctxFor(owner.id, org.slug))!;
}

export async function ctxFor(userId: string, slug: string): Promise<OrgContext | null> {
  return getOrgContext(userId, slug);
}

/** Adds a new user to the group through a real invite, and returns their context. */
export async function addMember(ctx: OrgContext, name = "Member", role: Exclude<Role, "collector"> = "member"): Promise<OrgContext> {
  const user = await makeUser(name);
  const { token } = await createInvite(ctx, { email: user.email, role });
  await acceptInvite(token, user);
  return (await ctxFor(user.id, ctx.org.slug))!;
}

/** A group with a collector and `size - 1` more members. */
export async function makeGroup(size = 3): Promise<{ collector: OrgContext; members: OrgContext[] }> {
  const collector = await makeOrg(await makeUser("Collector"));
  const members: OrgContext[] = [];
  for (let i = 1; i < size; i++) members.push(await addMember(collector, `Member ${i}`));
  return { collector, members };
}
