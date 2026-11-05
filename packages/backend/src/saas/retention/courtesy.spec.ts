/**
 * Audit 8 D6: the console's "Cortesía" ends on its own. 3 days before, the
 * owner is emailed; at the end the salon is read-only like any salon that
 * left. In-memory tenants table, no third-party calls.
 */
import { COURTESY_MESSAGES, courtesyStep, courtesyUntilProblem } from "./courtesy";
import { CourtesyScheduler } from "./courtesy.scheduler";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-04T04:20:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const candidate = (over: any = {}) => ({
  id: "t1",
  name: "Salón Lucía",
  subscriptionStatus: "active",
  stripeSubscriptionId: null,
  courtesyUntil: at(10),
  courtesyWarnedAt: null,
  ...over,
});

describe("courtesyStep", () => {
  it("nothing while far from the end", () => {
    expect(courtesyStep(candidate(), NOW)).toBeNull();
  });

  it("warns within 3 days of the end, once", () => {
    expect(courtesyStep(candidate({ courtesyUntil: at(3) }), NOW)).toBe("warn");
    expect(courtesyStep(candidate({ courtesyUntil: at(2), courtesyWarnedAt: at(-1) }), NOW)).toBeNull();
  });

  it("ends it once the date has passed", () => {
    expect(courtesyStep(candidate({ courtesyUntil: at(-0.01) }), NOW)).toBe("expire");
  });

  it("a salon that subscribed in Stripe is no longer a courtesy", () => {
    expect(courtesyStep(candidate({ courtesyUntil: at(-1), stripeSubscriptionId: "sub_1" }), NOW)).toBe("converted");
  });

  it("a salon no longer active (suspended meanwhile) is left to the other jobs", () => {
    expect(courtesyStep(candidate({ courtesyUntil: at(-1), subscriptionStatus: "cancelled" }), NOW)).toBeNull();
  });
});

describe("courtesyUntilProblem", () => {
  it("needs a date after now, at most a year away", () => {
    expect(courtesyUntilProblem(at(-1), NOW)).toBe(COURTESY_MESSAGES.untilPast);
    expect(courtesyUntilProblem(new Date("nope"), NOW)).toBe(COURTESY_MESSAGES.untilPast);
    expect(courtesyUntilProblem(at(400), NOW)).toBe(COURTESY_MESSAGES.untilTooFar);
    expect(courtesyUntilProblem(at(30), NOW)).toBeNull();
  });
});

function harness(rows: any[], opts: { emailOk?: boolean } = {}) {
  const same = (a: any, b: any) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([k, cond]: [string, any]) => {
      const v = row[k];
      if (cond === null) return v === null || v === undefined;
      if (cond instanceof Date) return same(v, cond);
      if (cond && typeof cond === "object" && "not" in cond) return cond.not === null ? v !== null && v !== undefined : !same(v, cond.not);
      return v === cond;
    });
  const prisma: any = {
    tenant: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    user: { findFirst: jest.fn(async () => ({ email: "duena@salon.test" })) },
  };
  const email = {
    sendCourtesyEnding: jest.fn(async () => (opts.emailOk === false ? { success: false, error: "provider down" } : { success: true })),
    sendAccountReadOnly: jest.fn(async () => ({ success: true })),
  };
  const config = { get: () => undefined };
  return { job: new CourtesyScheduler(prisma, email as any, config as any), email, prisma };
}

const row = (over: any = {}) => ({ ...candidate(), deletedAt: null, anonymizedAt: null, courtesyPlan: "pro", readOnlyUntil: null, cancelledAt: null, ...over });

describe("CourtesyScheduler", () => {
  it("warns the owner 3 days before, once", async () => {
    const r = row({ courtesyUntil: at(3) });
    const t = harness([r]);
    expect((await t.job.run(NOW)).warned).toEqual(["t1"]);
    expect(t.email.sendCourtesyEnding).toHaveBeenCalledWith(expect.objectContaining({ to: "duena@salon.test", endsOn: r.courtesyUntil }));
    expect((await t.job.run(new Date(NOW.getTime() + 60_000))).warned).toEqual([]);
    expect(t.email.sendCourtesyEnding).toHaveBeenCalledTimes(1);
  });

  it("a warning that was not delivered is given back for the next day", async () => {
    const r = row({ courtesyUntil: at(2) });
    const t = harness([r], { emailOk: false });
    expect((await t.job.run(NOW)).failed).toEqual(["t1"]);
    expect(r.courtesyWarnedAt).toBeNull();
  });

  it("at the end: read-only for 30 days, cancelledAt set, courtesy cleared, owner emailed", async () => {
    const r = row({ courtesyUntil: at(-0.1), courtesyWarnedAt: at(-3) });
    const t = harness([r]);
    expect((await t.job.run(NOW)).expired).toEqual(["t1"]);
    expect(r).toMatchObject({ subscriptionStatus: "cancelled", cancelledAt: NOW, courtesyUntil: null, courtesyPlan: null, courtesyWarnedAt: null });
    expect(r.readOnlyUntil.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(t.email.sendAccountReadOnly).toHaveBeenCalledWith(expect.objectContaining({ reason: "courtesy_ended", readOnlyUntil: r.readOnlyUntil }));
    // Never twice.
    expect((await t.job.run(at(1))).expired).toEqual([]);
  });

  it("a salon that subscribed meanwhile keeps its plan; only the courtesy fields go", async () => {
    const r = row({ courtesyUntil: at(-1), stripeSubscriptionId: "sub_1" });
    const t = harness([r]);
    expect((await t.job.run(NOW)).converted).toEqual(["t1"]);
    expect(r).toMatchObject({ subscriptionStatus: "active", courtesyUntil: null, courtesyPlan: null });
    expect(t.email.sendAccountReadOnly).not.toHaveBeenCalled();
  });

});
