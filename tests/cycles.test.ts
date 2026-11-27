import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/db/tenant";
import { listAudit } from "@/lib/services/audit";
import {
  createDraftCycle,
  discardDraft,
  getOpenCycle,
  moveMember,
  shuffleOrder,
  startCycle,
} from "@/lib/services/cycles";
import { removeMember } from "@/lib/services/members";
import type { OrgContext } from "@/lib/services/orgs";
import { addMember, makeGroup } from "./helpers";

const TODAY = "2027-01-04";
const draft = (overrides: Partial<Record<"amount" | "frequency" | "startsOn" | "orderMethod", string>> = {}) => ({
  amount: "100",
  frequency: "weekly",
  startsOn: "2027-01-11",
  orderMethod: "join_order",
  ...overrides,
});

/** Runs raw SQL in the group's schema, the way a bug or a hand-written query would. */
function rawSql(ctx: OrgContext, query: ReturnType<typeof sql>) {
  return withTenant(ctx.org.schemaName, (db) => db.execute(query));
}

/** Postgres error code, unwrapped from Drizzle's error. */
async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

async function startedGroup(size = 3) {
  const group = await makeGroup(size);
  const cycle = await createDraftCycle(group.collector, draft(), TODAY);
  await startCycle(group.collector, cycle.id, TODAY);
  return { ...group, cycle };
}

describe("drafting a cycle", () => {
  it("includes everyone in the group, in join order, with the amount in pesewas", async () => {
    const { collector, members } = await makeGroup(3);
    await createDraftCycle(collector, draft({ amount: "50.50" }), TODAY);

    const view = (await getOpenCycle(collector))!;
    expect(view.cycle).toMatchObject({ number: 1, status: "draft", amountPesewas: 5050, frequency: "weekly" });
    expect(view.members.map((m) => m.userId)).toEqual([collector.userId, ...members.map((m) => m.userId)]);
    expect(view.members.map((m) => m.position)).toEqual([1, 2, 3]);
    expect(view.potPesewas).toBe(15150);
    expect(view.rounds).toEqual([]);
  });

  it("draws a random order that still includes everyone exactly once", async () => {
    const { collector, members } = await makeGroup(5);
    await createDraftCycle(collector, draft({ orderMethod: "random" }), TODAY);
    const view = (await getOpenCycle(collector))!;
    const everyone = [collector, ...members].map((m) => m.userId).sort();
    expect(view.members.map((m) => m.userId).sort()).toEqual(everyone);
    expect(view.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("validates the rules", async () => {
    const { collector } = await makeGroup(2);
    const cases: [ReturnType<typeof draft>, RegExp][] = [
      [draft({ amount: "abc" }), /Enter an amount/],
      [draft({ amount: "0.50" }), /at least GH₵ 1.00/],
      [draft({ frequency: "yearly" }), /how often/],
      [draft({ startsOn: "2027-01-03" }), /can't be in the past/],
      [draft({ startsOn: "2027-02-30" }), /valid start date/],
      [draft({ startsOn: "2029-01-01" }), /within the next year/],
    ];
    for (const [input, message] of cases) {
      await expect(createDraftCycle(collector, input, TODAY), JSON.stringify(input)).rejects.toThrow(message);
    }
  });

  it("needs at least two members", async () => {
    const { collector } = await makeGroup(1);
    await expect(createDraftCycle(collector, draft(), TODAY)).rejects.toThrow(/at least 2 members/);
  });

  it("is for collectors only, but everyone can see it", async () => {
    const { collector, members } = await makeGroup(2);
    const treasurer = await addMember(collector, "Treasurer", "treasurer");
    for (const ctx of [members[0], treasurer]) {
      await expect(createDraftCycle(ctx, draft(), TODAY)).rejects.toMatchObject({ code: "forbidden" });
    }
    await createDraftCycle(collector, draft(), TODAY);
    expect((await getOpenCycle(members[0]))?.cycle.status).toBe("draft");
  });

  it("allows only one open cycle per group, even when two requests race", async () => {
    const { collector } = await makeGroup(2);
    const results = await Promise.allSettled([
      createDraftCycle(collector, draft(), TODAY),
      createDraftCycle(collector, draft(), TODAY),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
  });

  it("lets the collector rearrange the order before starting", async () => {
    const { collector, members } = await makeGroup(3);
    const cycle = await createDraftCycle(collector, draft(), TODAY);
    const [a, b, c] = [collector.userId, members[0].userId, members[1].userId];

    await moveMember(collector, cycle.id, c, "up"); // a, c, b
    await moveMember(collector, cycle.id, a, "down"); // c, a, b
    await moveMember(collector, cycle.id, b, "up"); // c, b, a
    const view = (await getOpenCycle(collector))!;
    expect(view.members.map((m) => m.userId)).toEqual([c, b, a]);
    expect(view.cycle.orderMethod).toBe("manual");

    await shuffleOrder(collector, cycle.id);
    const shuffled = (await getOpenCycle(collector))!;
    expect(shuffled.members.map((m) => m.userId).sort()).toEqual([a, b, c].sort());
    expect(shuffled.cycle.orderMethod).toBe("random");
  });

  it("can be discarded and drafted again", async () => {
    const { collector } = await makeGroup(2);
    const first = await createDraftCycle(collector, draft(), TODAY);
    await discardDraft(collector, first.id);
    expect(await getOpenCycle(collector)).toBeNull();
    await createDraftCycle(collector, draft(), TODAY);
    expect((await getOpenCycle(collector))?.cycle.number).toBe(1);
  });

  it("notices people who joined or left after the draft was made", async () => {
    const { collector, members } = await makeGroup(3);
    const cycle = await createDraftCycle(collector, draft(), TODAY);
    await addMember(collector, "Latecomer");
    await removeMember(members[1], members[1].userId);

    const view = (await getOpenCycle(collector))!;
    expect(view.notInCycle).toBe(1);
    expect(view.leftGroup).toEqual(["Member 2"]);
    await expect(startCycle(collector, cycle.id, TODAY)).rejects.toThrow(/Member 2 left the group/);
  });
});

describe("starting a cycle", () => {
  it("generates one round per member, in payout order, on the schedule", async () => {
    const { collector, members } = await makeGroup(3);
    const cycle = await createDraftCycle(collector, draft({ frequency: "monthly", startsOn: "2027-01-31" }), TODAY);
    await startCycle(collector, cycle.id, TODAY);

    const view = (await getOpenCycle(collector))!;
    expect(view.cycle.status).toBe("active");
    expect(view.cycle.startedAt).toBeInstanceOf(Date);
    expect(view.rounds.map((r) => [r.number, r.dueOn, r.recipientUserId, r.status])).toEqual([
      [1, "2027-01-31", collector.userId, "open"],
      [2, "2027-02-28", members[0].userId, "open"],
      [3, "2027-03-31", members[1].userId, "open"],
    ]);
    expect(view.currentRound?.number).toBe(1);

    const actions = (await listAudit(collector)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["cycle.drafted", "cycle.started"]));
  });

  it("refuses a draft whose start date has passed", async () => {
    const { collector } = await makeGroup(2);
    const cycle = await createDraftCycle(collector, draft({ startsOn: "2027-01-11" }), TODAY);
    await expect(startCycle(collector, cycle.id, "2027-01-12")).rejects.toThrow(/start date has passed/);
  });

  it("starts once, even if the button is pressed twice at the same moment", async () => {
    const { collector } = await makeGroup(3);
    const cycle = await createDraftCycle(collector, draft(), TODAY);
    const results = await Promise.allSettled([startCycle(collector, cycle.id, TODAY), startCycle(collector, cycle.id, TODAY)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getOpenCycle(collector))?.rounds).toHaveLength(3);
  });

  it("locks the rules and the order in the app", async () => {
    const { collector, members, cycle } = await startedGroup();
    for (const attempt of [
      moveMember(collector, cycle.id, members[0].userId, "up"),
      shuffleOrder(collector, cycle.id),
      discardDraft(collector, cycle.id),
      startCycle(collector, cycle.id, TODAY),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: "conflict" });
    }
  });
});

describe("the database enforces the rules, whatever the app does", () => {
  // 23514 = check_violation, raised by the triggers in migrations/tenant/0001_cycles.sql

  it("won't change a started cycle's amount, dates or frequency", async () => {
    const { collector } = await startedGroup();
    expect(await pgError(rawSql(collector, sql`UPDATE cycles SET amount_pesewas = 1`))).toBe("23514");
    expect(await pgError(rawSql(collector, sql`UPDATE cycles SET starts_on = starts_on + 7`))).toBe("23514");
    expect(await pgError(rawSql(collector, sql`UPDATE cycles SET frequency = 'daily'`))).toBe("23514");
  });

  it("won't reorder, add or remove members of a started cycle", async () => {
    const { collector, members } = await startedGroup();
    expect(await pgError(rawSql(collector, sql`UPDATE cycle_members SET payout_position = payout_position`))).toBe("23514");
    expect(await pgError(rawSql(collector, sql`DELETE FROM cycle_members WHERE user_id = ${members[0].userId}`))).toBe("23514");
    const outsider = await addMember(collector, "Outsider");
    expect(
      await pgError(
        rawSql(collector, sql`INSERT INTO cycle_members (cycle_id, user_id, payout_position) SELECT id, ${outsider.userId}, 9 FROM cycles`),
      ),
    ).toBe("23514");
  });

  it("won't move, reassign, add or delete rounds of a started cycle", async () => {
    const { collector, members } = await startedGroup();
    expect(await pgError(rawSql(collector, sql`UPDATE rounds SET due_on = due_on + 1 WHERE number = 1`))).toBe("23514");
    expect(
      await pgError(rawSql(collector, sql`UPDATE rounds SET recipient_user_id = ${members[1].userId} WHERE number = 1`)),
    ).toBe("23514");
    expect(await pgError(rawSql(collector, sql`DELETE FROM rounds WHERE number = 3`))).toBe("23514");
    expect(
      await pgError(
        rawSql(collector, sql`INSERT INTO rounds (cycle_id, number, due_on, recipient_user_id) SELECT id, 4, '2027-12-01', created_by FROM cycles`),
      ),
    ).toBe("23514");
  });

  it("won't reopen a paid-out round or send a cycle back to draft", async () => {
    const { collector } = await startedGroup();
    await rawSql(collector, sql`UPDATE rounds SET status = 'paid_out' WHERE number = 1`);
    expect(await pgError(rawSql(collector, sql`UPDATE rounds SET status = 'open' WHERE number = 1`))).toBe("23514");
    expect(await pgError(rawSql(collector, sql`UPDATE cycles SET status = 'draft'`))).toBe("23514");
    expect(await pgError(rawSql(collector, sql`DELETE FROM cycles`))).toBe("23514");
  });

  it("won't start a cycle without a complete schedule", async () => {
    const { collector } = await makeGroup(3);
    await createDraftCycle(collector, draft(), TODAY);
    // Skipping the round generation that startCycle() does
    expect(await pgError(rawSql(collector, sql`UPDATE cycles SET status = 'active'`))).toBe("23514");
  });

  it("won't give anyone two payouts in one cycle", async () => {
    const { collector } = await makeGroup(2);
    await createDraftCycle(collector, draft(), TODAY);
    expect(
      await pgError(
        rawSql(
          collector,
          sql`INSERT INTO rounds (cycle_id, number, due_on, recipient_user_id)
              SELECT id, n, '2027-02-01', ${collector.userId} FROM cycles, generate_series(1, 2) AS n`,
        ),
      ),
    ).toBe("23505"); // unique_violation on (cycle_id, recipient_user_id)
  });
});
