/**
 * Tests for GracePeriodScheduler.
 *
 * Sprint 2 / Workstream 2.2 deliverable. After 7 days of failed
 * Stripe retries, tenants should flip from `past_due` to
 * `suspended` and the owner should receive a final
 * `sendAccountSuspended` email. The cron is idempotent (a
 * second run on the same day is a no-op) and must skip soft-deleted
 * tenants + tenants already past the suspended state.
 */

import { GracePeriodScheduler } from "./grace-period.scheduler";

const DAY_MS = 24 * 60 * 60 * 1000;

function makePrismaMock() {
  const tenants = new Map<string, any>();
  const users = new Map<string, any>();
  let updateManyCount = 0;

  const prisma: any = {
    tenant: {
      findMany: async (args: any) => {
        const out: any[] = [];
        for (const t of tenants.values()) {
          if (args.where?.subscriptionStatus && t.subscriptionStatus !== args.where.subscriptionStatus)
            continue;
          if (args.where?.deletedAt !== undefined && (t.deletedAt ?? null) !== args.where.deletedAt)
            continue;
          if (args.where?.gracePeriodEndsAt?.lt) {
            const cmp = args.where.gracePeriodEndsAt.lt.getTime();
            if (t.gracePeriodEndsAt.getTime() >= cmp) continue;
          }
          if (args.select) {
            const sel: any = {};
            for (const k of Object.keys(args.select)) sel[k] = t[k];
            out.push(sel);
          } else {
            out.push(t);
          }
        }
        return out;
      },
      updateMany: async (args: any) => {
        updateManyCount += 1;
        let count = 0;
        for (const t of tenants.values()) {
          let ok = true;
          if (args.where?.id?.in) {
            if (!args.where.id.in.includes(t.id)) ok = false;
          }
          if (args.where?.deletedAt !== undefined && (t.deletedAt ?? null) !== args.where.deletedAt)
            ok = false;
          if (ok) {
            Object.assign(t, args.data);
            count += 1;
          }
        }
        return { count };
      },
    },
    user: {
      findFirst: async (args: any) => {
        for (const u of users.values()) {
          if (args.where?.tenantId && u.tenantId !== args.where.tenantId) continue;
          if (args.where?.role && u.role !== args.where.role) continue;
          if (args.select) {
            const sel: any = {};
            for (const k of Object.keys(args.select)) sel[k] = u[k];
            return sel;
          }
          return u;
        }
        return null;
      },
    },
  };
  return { prisma, tenants, users, getUpdateManyCount: () => updateManyCount };
}

function makeEmailMock() {
  const calls: any[] = [];
  return {
    calls,
    sendAccountSuspended: async (data: any) => {
      calls.push(data);
      return { success: true, id: `resend-${calls.length}` };
    },
  } as any;
}

function makeConfigMock() {
  return {
    get: (key: string) => {
      if (key === "APP_BASE_URL") return "https://app.test";
      return undefined;
    },
  } as any;
}

function seedPastDueTenant(
  m: ReturnType<typeof makePrismaMock>,
  opts: {
    id?: string;
    name?: string;
    graceExpiredInDays?: number;
    ownerEmail?: string;
    deletedAt?: Date | null;
  },
) {
  const id = opts.id ?? "tenant-1";
  m.tenants.set(id, {
    id,
    name: opts.name ?? "Salon Demo",
    subscriptionStatus: "past_due",
    gracePeriodEndsAt: new Date(
      Date.now() - (opts.graceExpiredInDays ?? 0) * DAY_MS,
    ),
    readOnlyUntil: null,
    deletedAt: opts.deletedAt ?? null,
  });
  if (opts.ownerEmail) {
    m.users.set(`${id}:owner`, {
      id: `${id}-owner`,
      tenantId: id,
      role: "owner",
      email: opts.ownerEmail,
    });
  }
}

describe("GracePeriodScheduler.suspendExpiredGraces", () => {
  it("flips past_due → suspended when gracePeriodEndsAt is in the past", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    seedPastDueTenant(m, {
      id: "t1",
      graceExpiredInDays: 1,
      ownerEmail: "owner@salon.test",
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    const t = m.tenants.get("t1");
    expect(t.subscriptionStatus).toBe("suspended");
    expect(t.readOnlyUntil).toBeInstanceOf(Date);
    // Read-only window is exactly +30 days from now.
    const expectedRo = Date.now() + 30 * DAY_MS;
    expect(Math.abs(t.readOnlyUntil.getTime() - expectedRo)).toBeLessThan(2000);

    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].to).toBe("owner@salon.test");
    expect(email.calls[0].tenantName).toBe("Salon Demo");
  });

  it("does NOT flip tenants whose gracePeriodEndsAt is still in the future", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    seedPastDueTenant(m, {
      id: "t-future",
      graceExpiredInDays: -3, // grace ends in 3 days
      ownerEmail: "x@y.test",
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    expect(m.tenants.get("t-future").subscriptionStatus).toBe("past_due");
    expect(email.calls).toHaveLength(0);
  });

  it("does NOT touch tenants that are already suspended (idempotent re-run)", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    m.tenants.set("t-already", {
      id: "t-already",
      name: "Already",
      subscriptionStatus: "suspended",
      gracePeriodEndsAt: new Date(Date.now() - 10 * DAY_MS),
      readOnlyUntil: new Date(Date.now() + 20 * DAY_MS),
      deletedAt: null,
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    // updateMany is called only with the where filter; it should
    // match zero tenants in this case.
    expect(m.getUpdateManyCount()).toBeLessThanOrEqual(1);
    // The already-suspended tenant's readOnlyUntil is unchanged.
    expect(m.tenants.get("t-already").readOnlyUntil.getTime()).toBeCloseTo(
      Date.now() + 20 * DAY_MS,
      -3,
    );
  });

  it("does NOT touch active or trialing tenants", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    m.tenants.set("t-active", {
      id: "t-active",
      name: "Active",
      subscriptionStatus: "active",
      gracePeriodEndsAt: new Date(Date.now() - 5 * DAY_MS),
      readOnlyUntil: null,
      deletedAt: null,
    });
    m.tenants.set("t-trialing", {
      id: "t-trialing",
      name: "Trialing",
      subscriptionStatus: "trialing",
      gracePeriodEndsAt: new Date(Date.now() - 5 * DAY_MS),
      readOnlyUntil: null,
      deletedAt: null,
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    expect(m.tenants.get("t-active").subscriptionStatus).toBe("active");
    expect(m.tenants.get("t-trialing").subscriptionStatus).toBe("trialing");
    expect(email.calls).toHaveLength(0);
  });

  it("does NOT touch soft-deleted tenants", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    seedPastDueTenant(m, {
      id: "t-deleted",
      graceExpiredInDays: 5,
      ownerEmail: "x@y.test",
      deletedAt: new Date(Date.now() - 1000),
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    expect(m.tenants.get("t-deleted").subscriptionStatus).toBe("past_due");
    expect(email.calls).toHaveLength(0);
  });

  it("processes multiple expired tenants in a single cron tick", async () => {
    const m = makePrismaMock();
    const email = makeEmailMock();
    for (let i = 1; i <= 5; i++) {
      seedPastDueTenant(m, {
        id: `t${i}`,
        name: `Salon ${i}`,
        graceExpiredInDays: 1,
        ownerEmail: `owner${i}@salon.test`,
      });
    }
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    for (let i = 1; i <= 5; i++) {
      expect(m.tenants.get(`t${i}`).subscriptionStatus).toBe("suspended");
    }
    expect(email.calls).toHaveLength(5);
  });

  it("skips the email send when the tenant has no owner user (still flips status)", async () => {
    // Edge case: a tenant past grace with no owner row yet (e.g.
    // the SaaS admin deleted the owner user but the Stripe sub
    // still pings). We must still flip the status to suspended so
    // reads are still blocked, but the email can't be sent.
    const m = makePrismaMock();
    const email = makeEmailMock();
    m.tenants.set("t-orphan", {
      id: "t-orphan",
      name: "Orphan",
      subscriptionStatus: "past_due",
      gracePeriodEndsAt: new Date(Date.now() - 1 * DAY_MS),
      readOnlyUntil: null,
      deletedAt: null,
    });
    const svc = new GracePeriodScheduler(m.prisma as any, email, makeConfigMock());

    await svc.suspendExpiredGraces();

    expect(m.tenants.get("t-orphan").subscriptionStatus).toBe("suspended");
    expect(email.calls).toHaveLength(0);
  });
});