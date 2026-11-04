import { GdprRequestStatus } from "@prisma/client";
import {
  ANONYMIZE_WARNING_DAYS,
  DAY_MS,
  anonymizationDate,
  retentionEnabled,
  retentionStep,
  RetentionCandidate,
} from "./salon-retention";
import { RETENTION_ACTOR, SalonRetentionScheduler } from "./salon-retention.scheduler";

/**
 * Audit 7 D7: a salon that left is read-only 30 days, its owner is warned 7
 * days before the end of the next 30, and its personal data is anonymised
 * 60 days after it ended. Destructive, so: a dry run unless
 * RETENTION_ANONYMIZE_ENABLED=true, never twice, never without the 7 days'
 * notice, and a failure leaves the salon as it was.
 */

const READ_ONLY_UNTIL = new Date("2026-12-01T04:00:00.000Z");
const ANONYMIZE_ON = new Date("2026-12-31T04:00:00.000Z");
const at = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

function candidate(over: Partial<RetentionCandidate> = {}): RetentionCandidate & { name: string } {
  return {
    id: "t1",
    name: "Salón Luna",
    subscriptionStatus: "cancelled",
    readOnlyUntil: READ_ONLY_UNTIL,
    anonymizationWarnedAt: null,
    anonymizationWarnedFor: null,
    ...over,
  };
}

describe("retentionStep (what the job does for one salon)", () => {
  it("anonymises 30 days after the read-only period", () => {
    expect(anonymizationDate(READ_ONLY_UNTIL)).toEqual(ANONYMIZE_ON);
  });

  it("nothing before the warning window, nor for a salon that is not read-only", () => {
    expect(retentionStep(candidate(), at(ANONYMIZE_ON, -8))).toBeNull();
    expect(retentionStep(candidate({ subscriptionStatus: "active" }), at(ANONYMIZE_ON, 10))).toBeNull();
    expect(retentionStep(candidate({ subscriptionStatus: "trialing" }), at(ANONYMIZE_ON, 10))).toBeNull();
    expect(retentionStep(candidate({ readOnlyUntil: null }), at(ANONYMIZE_ON, 10))).toBeNull();
  });

  it("warns 7 days before, once per read-only period", () => {
    const now = at(ANONYMIZE_ON, -ANONYMIZE_WARNING_DAYS);
    expect(retentionStep(candidate(), now)).toEqual({ kind: "warn", tenantId: "t1", anonymizeOn: ANONYMIZE_ON });
    const warned = candidate({ anonymizationWarnedAt: now, anonymizationWarnedFor: READ_ONLY_UNTIL });
    expect(retentionStep(warned, at(now, 1))).toBeNull();
  });

  it("a warning for an earlier read-only period does not count: warned again", () => {
    const old = candidate({ anonymizationWarnedAt: at(ANONYMIZE_ON, -60), anonymizationWarnedFor: at(READ_ONLY_UNTIL, -90) });
    expect(retentionStep(old, ANONYMIZE_ON)?.kind).toBe("warn");
  });

  it("anonymises once the date has passed and the warning is 7 days old", () => {
    const warned = candidate({ anonymizationWarnedAt: at(ANONYMIZE_ON, -7), anonymizationWarnedFor: READ_ONLY_UNTIL });
    expect(retentionStep(warned, at(ANONYMIZE_ON, -1))).toBeNull();
    expect(retentionStep(warned, ANONYMIZE_ON)?.kind).toBe("anonymize");
  });

  it("never without the 7 days' notice: a salon warned late waits a week from the warning", () => {
    const late = at(ANONYMIZE_ON, 20);
    const step = retentionStep(candidate(), late);
    expect(step).toEqual({ kind: "warn", tenantId: "t1", anonymizeOn: at(late, 7) });
    const warned = candidate({ anonymizationWarnedAt: late, anonymizationWarnedFor: READ_ONLY_UNTIL });
    expect(retentionStep(warned, at(late, 6))).toBeNull();
    expect(retentionStep(warned, at(late, 7))?.kind).toBe("anonymize");
  });

  it("the flag is on only when it says true", () => {
    expect(retentionEnabled(undefined)).toBe(false);
    expect(retentionEnabled("")).toBe(false);
    expect(retentionEnabled("1")).toBe(false);
    expect(retentionEnabled("false")).toBe(false);
    expect(retentionEnabled(" TRUE ")).toBe(true);
  });
});

/** An in-memory tenants table with the where clauses the job uses. */
function harness(rows: any[], opts: { flag?: string; emailOk?: boolean; anonymizeFails?: boolean } = {}) {
  const same = (a: any, b: any) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([k, cond]: [string, any]) => {
      if (k === "OR") return cond.some((c: any) => matches(row, c));
      const v = row[k];
      if (cond === null) return v === null || v === undefined;
      if (cond instanceof Date) return same(v, cond);
      if (cond && typeof cond === "object") {
        if ("in" in cond) return cond.in.includes(v);
        if ("not" in cond) return cond.not === null ? v !== null && v !== undefined : !same(v, cond.not);
      }
      return v === cond;
    });
  const requests: any[] = [];
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
    gdprRequest: {
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `req-${requests.length + 1}`, ...data };
        requests.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(requests.find((r) => r.id === where.id), data)),
    },
  };
  const gdpr = {
    anonymize: jest.fn(async (tenantId: string, requestId: string) => {
      if (opts.anonymizeFails) throw new Error("database went away");
      const row = rows.find((r) => r.id === tenantId);
      row.deletedAt = new Date();
      Object.assign(requests.find((r) => r.id === requestId), { status: GdprRequestStatus.completed });
      return requests.find((r) => r.id === requestId);
    }),
  };
  const email = {
    sendAnonymizationWarning: jest.fn(async () => (opts.emailOk === false ? { success: false, error: "provider down" } : { success: true })),
  };
  const config = { get: (k: string) => (k === "RETENTION_ANONYMIZE_ENABLED" ? opts.flag : undefined) };
  const job = new SalonRetentionScheduler(prisma, gdpr as any, email as any, config as any);
  return { job, prisma, gdpr, email, requests };
}

const row = (over: any = {}) => ({ ...candidate(), deletedAt: null, anonymizedAt: null, ...over });

describe("SalonRetentionScheduler", () => {
  it("dry run (flag off): logs what it would do, writes nothing, sends nothing", async () => {
    const due = row({ id: "due", anonymizationWarnedAt: at(ANONYMIZE_ON, -7), anonymizationWarnedFor: READ_ONLY_UNTIL });
    const toWarn = row({ id: "warn" });
    const t = harness([due, toWarn]);
    const out = await t.job.run(ANONYMIZE_ON);
    expect(out).toMatchObject({ enabled: false, wouldAnonymize: ["due"], wouldWarn: ["warn"], anonymized: [], warned: [] });
    expect(t.prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(t.email.sendAnonymizationWarning).not.toHaveBeenCalled();
    expect(t.gdpr.anonymize).not.toHaveBeenCalled();
    expect(t.prisma.gdprRequest.create).not.toHaveBeenCalled();
  });

  it("on: warns the owner once, then anonymises a week later with the invoices kept, and never again", async () => {
    const r = row();
    const t = harness([r], { flag: "true" });
    const warnDay = at(ANONYMIZE_ON, -7);

    expect((await t.job.run(warnDay)).warned).toEqual(["t1"]);
    expect(t.email.sendAnonymizationWarning).toHaveBeenCalledWith(
      expect.objectContaining({ to: "duena@salon.test", anonymizeOn: ANONYMIZE_ON }),
    );
    // A second run the same day (or a second instance): no second email.
    expect((await t.job.run(at(warnDay, 0.01))).warned).toEqual([]);
    expect(t.email.sendAnonymizationWarning).toHaveBeenCalledTimes(1);

    const out = await t.job.run(ANONYMIZE_ON);
    expect(out.anonymized).toEqual(["t1"]);
    expect(t.gdpr.anonymize).toHaveBeenCalledWith("t1", "req-1", { keepFiscalData: true });
    expect(t.requests[0]).toMatchObject({ tenantId: "t1", action: "anonymize", actorId: RETENTION_ACTOR, status: "completed" });

    // Anonymised (deletedAt, anonymizedAt): never picked up again.
    expect((await t.job.run(at(ANONYMIZE_ON, 1))).anonymized).toEqual([]);
    expect(t.gdpr.anonymize).toHaveBeenCalledTimes(1);
  });

  it("D3: a salon deleted from the console is warned (no links) and anonymised like any other", async () => {
    const r = row({ deletedAt: at(READ_ONLY_UNTIL, -30) });
    const t = harness([r], { flag: "true" });
    expect((await t.job.run(at(ANONYMIZE_ON, -7))).warned).toEqual(["t1"]);
    expect(t.email.sendAnonymizationWarning).toHaveBeenCalledWith(expect.objectContaining({ deleted: true }));
    expect((await t.job.run(ANONYMIZE_ON)).anonymized).toEqual(["t1"]);
    expect(t.gdpr.anonymize).toHaveBeenCalledWith("t1", "req-1", { keepFiscalData: true });
  });

  it("a salon that came back (active again) is left alone", async () => {
    const t = harness([row({ subscriptionStatus: "active", anonymizationWarnedAt: at(ANONYMIZE_ON, -7), anonymizationWarnedFor: READ_ONLY_UNTIL })], { flag: "true" });
    expect(await t.job.run(at(ANONYMIZE_ON, 3))).toMatchObject({ anonymized: [], warned: [] });
    expect(t.gdpr.anonymize).not.toHaveBeenCalled();
  });

  it("a warning that was not delivered is given back, so nothing is anonymised without it", async () => {
    const r = row();
    const t = harness([r], { flag: "true", emailOk: false });
    const out = await t.job.run(at(ANONYMIZE_ON, -7));
    expect(out.failed).toEqual(["t1"]);
    expect(r.anonymizationWarnedAt).toBeNull();
    expect((await t.job.run(ANONYMIZE_ON)).anonymized).toEqual([]);
  });

  it("a failed anonymisation marks the request failed and leaves the salon to be tried again", async () => {
    const r = row({ anonymizationWarnedAt: at(ANONYMIZE_ON, -7), anonymizationWarnedFor: READ_ONLY_UNTIL });
    const t = harness([r], { flag: "true", anonymizeFails: true });
    const out = await t.job.run(ANONYMIZE_ON);
    expect(out.failed).toEqual(["t1"]);
    expect(t.requests[0]).toMatchObject({ status: GdprRequestStatus.failed });
    expect(r.anonymizedAt).toBeNull();
    expect(r.deletedAt).toBeNull();
  });
});
