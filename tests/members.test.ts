import { describe, expect, it } from "vitest";
import { can, canAssignRole } from "@/lib/permissions";
import { acceptInvite, createInvite, getInvite, listPendingInvites, revokeInvite } from "@/lib/services/invites";
import { changeRole, listMembers, removeMember } from "@/lib/services/members";
import { listAudit } from "@/lib/services/audit";
import { ctxFor, makeOrg, makeUser } from "./helpers";

describe("permissions", () => {
  it("matches the role matrix", () => {
    expect(can("member", "cycles:read")).toBe(true);
    expect(can("member", "cycles:manage")).toBe(false);
    expect(can("treasurer", "members:invite")).toBe(true);
    expect(can("treasurer", "cycles:manage")).toBe(false);
    expect(can("collector", "org:delete")).toBe(true);
    expect(canAssignRole("treasurer", "collector")).toBe(false);
    expect(canAssignRole("collector", "collector")).toBe(true);
  });
});

describe("invites", () => {
  it("adds the invited user with the invited role, once", async () => {
    const collector = await makeUser();
    const ctx = await makeOrg(collector);
    const invitee = await makeUser("Invitee");

    const { token } = await createInvite(ctx, { email: invitee.email, role: "treasurer" });
    expect(await getInvite(token)).toMatchObject({ orgSlug: ctx.org.slug, role: "treasurer" });

    await acceptInvite(token, invitee);
    expect((await ctxFor(invitee.id, ctx.org.slug))?.role).toBe("treasurer");

    // Single use
    await expect(acceptInvite(token, invitee)).rejects.toMatchObject({ code: "not_found" });
    expect(await getInvite(token)).toBeNull();
  });

  it("can't be accepted by a different account", async () => {
    const ctx = await makeOrg(await makeUser());
    const invitee = await makeUser();
    const stranger = await makeUser();
    const { token } = await createInvite(ctx, { email: invitee.email, role: "member" });

    await expect(acceptInvite(token, stranger)).rejects.toMatchObject({ code: "forbidden" });
    expect(await ctxFor(stranger.id, ctx.org.slug)).toBeNull();
  });

  it("stops working once revoked", async () => {
    const ctx = await makeOrg(await makeUser());
    const invitee = await makeUser();
    const { token } = await createInvite(ctx, { email: invitee.email, role: "member" });
    const [pending] = await listPendingInvites(ctx);
    await revokeInvite(ctx, pending.id);
    await expect(acceptInvite(token, invitee)).rejects.toMatchObject({ code: "not_found" });
  });

  it("doesn't let members invite people", async () => {
    const ctx = await makeOrg(await makeUser());
    const member = await makeUser();
    const { token } = await createInvite(ctx, { email: member.email, role: "member" });
    await acceptInvite(token, member);
    const memberCtx = (await ctxFor(member.id, ctx.org.slug))!;
    await expect(createInvite(memberCtx, { email: "x@example.com", role: "member" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("member management", () => {
  async function orgWithTreasurer() {
    const collector = await makeUser("Collector");
    const ctx = await makeOrg(collector);
    const treasurer = await makeUser("Treasurer");
    const { token } = await createInvite(ctx, { email: treasurer.email, role: "treasurer" });
    await acceptInvite(token, treasurer);
    return { collectorCtx: ctx, treasurerCtx: (await ctxFor(treasurer.id, ctx.org.slug))!, collector, treasurer };
  }

  it("keeps at least one collector", async () => {
    const { collectorCtx, collector } = await orgWithTreasurer();
    await expect(changeRole(collectorCtx, collector.id, "treasurer")).rejects.toMatchObject({ code: "conflict" });
    await expect(removeMember(collectorCtx, collector.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("doesn't let treasurers touch collectors or promote to collector", async () => {
    const { treasurerCtx, collector, treasurer } = await orgWithTreasurer();
    await expect(removeMember(treasurerCtx, collector.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeRole(treasurerCtx, treasurer.id, "collector")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets a collector hand over the collector role, then step down", async () => {
    const { collectorCtx, collector, treasurer } = await orgWithTreasurer();
    await changeRole(collectorCtx, treasurer.id, "collector");
    await changeRole(collectorCtx, collector.id, "member");
    const roles = Object.fromEntries((await listMembers(collectorCtx)).map((m) => [m.userId, m.role]));
    expect(roles).toEqual({ [collector.id]: "member", [treasurer.id]: "collector" });
  });

  it("lets members leave and records it in the audit log", async () => {
    const { collectorCtx, treasurerCtx, treasurer } = await orgWithTreasurer();
    await removeMember(treasurerCtx, treasurer.id);
    expect(await ctxFor(treasurer.id, collectorCtx.org.slug)).toBeNull();
    const actions = (await listAudit(collectorCtx)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["org.created", "invite.created", "invite.accepted", "member.left"]));
  });
});
