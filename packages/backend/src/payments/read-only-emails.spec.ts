import { BillingScheduler } from "./billing.scheduler";
import { ReadOnlyNoticeService } from "./read-only-notice.service";
import { SubscriptionsService } from "./services/subscriptions.service";
import { PaymentsController } from "./payments.controller";

/**
 * The owner is emailed the day the account becomes read-only: when the
 * trial ends without a plan and when the subscription is cancelled. Before,
 * only a failed payment sent anything; a trial that ran out locked the
 * panel without a word. Each email goes once, to whoever made the change.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function trialPrisma(tenants: any[]) {
  const rows = new Map(tenants.map((t) => [t.id, { ...t }]));
  return {
    rows,
    tenant: {
      findMany: jest.fn(async (args: any) =>
        [...rows.values()].filter(
          (t) =>
            t.subscriptionStatus === args.where.subscriptionStatus &&
            t.trialEnd < args.where.trialEnd.lt &&
            !t.deletedAt,
        ),
      ),
      updateMany: jest.fn(async (args: any) => {
        const t = rows.get(args.where.id);
        if (!t || t.subscriptionStatus !== args.where.subscriptionStatus || t.deletedAt) return { count: 0 };
        Object.assign(t, args.data);
        return { count: 1 };
      }),
    },
  };
}

describe("trial ended: BillingScheduler.expireTrials", () => {
  const expired = { id: "t1", name: "Salón Lucía", plan: "esencial", subscriptionStatus: "trialing", trialEnd: new Date(Date.now() - DAY_MS) };

  function scheduler(prisma: any) {
    const notices = { notify: jest.fn(async () => undefined) };
    const events = { record: jest.fn() };
    return { s: new BillingScheduler(prisma, events as any, notices as any), notices, events };
  }

  it("puts the account in read-only for 30 days and emails the owner", async () => {
    const prisma = trialPrisma([expired, { ...expired, id: "t2", trialEnd: new Date(Date.now() + DAY_MS) }]);
    const { s, notices } = scheduler(prisma);
    await s.expireTrials();

    const t = prisma.rows.get("t1");
    expect(t.subscriptionStatus).toBe("cancelled");
    expect(Math.abs(t.readOnlyUntil.getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(2000);
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith("t1", "trial_ended", t.readOnlyUntil);
    expect(prisma.rows.get("t2").subscriptionStatus).toBe("trialing");
  });

  it("a second run the same day sends nothing", async () => {
    const prisma = trialPrisma([expired]);
    const { s, notices } = scheduler(prisma);
    await s.expireTrials();
    await s.expireTrials();
    expect(notices.notify).toHaveBeenCalledTimes(1);
  });

  it("a salon that bought a plan between the read and the update is neither locked nor emailed", async () => {
    const prisma = trialPrisma([expired]);
    prisma.tenant.updateMany.mockImplementationOnce(async () => {
      prisma.rows.get("t1").subscriptionStatus = "active";
      return { count: 0 };
    });
    const { s, notices, events } = scheduler(prisma);
    await s.expireTrials();
    expect(prisma.rows.get("t1").subscriptionStatus).toBe("active");
    expect(notices.notify).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });
});

describe("ReadOnlyNoticeService.notify", () => {
  const until = new Date("2026-11-22T10:00:00Z");

  function service(opts: { tenant?: any; owner?: any; send?: jest.Mock } = {}) {
    const prisma = {
      tenant: { findUnique: jest.fn(async () => ("tenant" in opts ? opts.tenant : { name: "Salón Lucía", deletedAt: null })) },
      user: { findFirst: jest.fn(async () => ("owner" in opts ? opts.owner : { email: "duena@salon.test" })) },
    };
    const email = { sendAccountReadOnly: opts.send ?? jest.fn(async () => ({ success: true, id: "e1" })) };
    const config = { get: (k: string) => (k === "APP_BASE_URL" ? "https://app.test/" : undefined) };
    return { svc: new ReadOnlyNoticeService(prisma as any, email as any, config as any), prisma, email };
  }

  it("emails the owner with the salon name, the reason, the date and the Billing link", async () => {
    const { svc, prisma, email } = service();
    await svc.notify("t1", "trial_ended", until);
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", role: "owner" } }));
    expect(email.sendAccountReadOnly).toHaveBeenCalledWith({
      to: "duena@salon.test",
      tenantName: "Salón Lucía",
      reason: "trial_ended",
      readOnlyUntil: until,
      billingUrl: "https://app.test/dashboard/billing",
    });
  });

  it("sends nothing for a deleted salon or one without an owner", async () => {
    for (const opts of [{ tenant: { name: "X", deletedAt: new Date() } }, { tenant: null }, { owner: null }]) {
      const { svc, email } = service(opts);
      await svc.notify("t1", "cancelled", until);
      expect(email.sendAccountReadOnly).not.toHaveBeenCalled();
    }
  });

  it("never throws: a failed email must not undo the change", async () => {
    const { svc } = service({ send: jest.fn(async () => { throw new Error("Resend down"); }) });
    (svc as any).logger = { error: jest.fn(), warn: jest.fn() };
    await expect(svc.notify("t1", "cancelled", until)).resolves.toBeUndefined();
    expect((svc as any).logger.error).toHaveBeenCalled();
  });
});

describe("cancelled from the dashboard", () => {
  function subs(status: string) {
    const prisma = {
      tenant: {
        findUnique: jest.fn(async () => ({ id: "t1", subscriptionStatus: status, stripeSubscriptionId: null })),
        updateMany: jest.fn(async () => ({ count: status === "cancelled" ? 0 : 1 })),
        update: jest.fn(async () => ({})),
      },
    };
    return { svc: new SubscriptionsService(prisma as any, { get: () => undefined } as any), prisma };
  }

  it("cancelSubscription says whether this call made the change", async () => {
    const active = subs("active");
    const r = await active.svc.cancelSubscription("t1");
    expect(r.newlyCancelled).toBe(true);
    expect(active.prisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", subscriptionStatus: { not: "cancelled" } } }),
    );
    expect(active.prisma.tenant.update).not.toHaveBeenCalled();

    const again = subs("cancelled");
    const r2 = await again.svc.cancelSubscription("t1");
    expect(r2.newlyCancelled).toBe(false);
    // Cancelling again still restarts the read-only window, as before.
    expect(again.prisma.tenant.update).toHaveBeenCalled();
  });

  function controller(newlyCancelled: boolean) {
    const readOnlyUntil = new Date(Date.now() + 30 * DAY_MS);
    const subscriptionsService = {
      cancelSubscription: jest.fn(async () => ({ subscriptionId: null, status: "cancelled", cancelledAt: new Date(), readOnlyUntil, newlyCancelled })),
    };
    const notices = { notify: jest.fn(async () => undefined) };
    const c = new PaymentsController({} as any, subscriptionsService as any, {} as any, {} as any, {} as any, notices as any);
    return { c, notices, readOnlyUntil };
  }

  it("emails the owner a confirmation, once", async () => {
    const { c, notices, readOnlyUntil } = controller(true);
    const res = await c.cancelSubscription({ user: { tenantId: "t1" } }, {});
    expect(notices.notify).toHaveBeenCalledWith("t1", "cancelled", readOnlyUntil);
    expect(res).not.toHaveProperty("newlyCancelled");

    const already = controller(false);
    await already.c.cancelSubscription({ user: { tenantId: "t1" } }, {});
    expect(already.notices.notify).not.toHaveBeenCalled();
  });
});
