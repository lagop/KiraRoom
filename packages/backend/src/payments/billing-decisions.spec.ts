import { HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../auth/guards/roles.guard";
import { WebhooksController } from "./webhooks.controller";
import { SubscriptionsService } from "./services/subscriptions.service";
import { BillingScheduler } from "./billing.scheduler";
import { TenantAddOnsController } from "./controllers/tenant-addons.controller";
import { PaymentsController } from "./payments.controller";
import { MessageBundlesService } from "../message-bundles/message-bundles.service";
import { cancelAtOf, liveStatusFor } from "./plan-activation";

/**
 * Ajustes > Facturación, decisions taken by the owner (audit part B):
 * - B3: cancelling ends the subscription at the end of the paid period;
 * - B6: subscribing during the trial keeps the trial (Pro) until it ends;
 * - B7: billing is the owner's only (add-ons too);
 * - B8: Empresa pays one per location open, and can add locations;
 * - B9: no move down to a plan the salon does not fit in;
 * - B18: reading the message credits creates nothing.
 * No real Stripe calls: the Stripe client is a mock.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function stripeError(code: string) {
  return Object.assign(new Error(code), { code });
}

function service(tenant: any, stripe: any, counts: { professionals?: number; locations?: number } = {}) {
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => tenant),
      update: jest.fn(async ({ data }: any) => Object.assign(tenant, data)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    professional: { count: jest.fn(async () => counts.professionals ?? 2) },
    location: { count: jest.fn(async () => counts.locations ?? 1) },
    addOn: { findMany: jest.fn(async () => []) },
    tenantAddOn: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
  const config: any = { get: (_k: string, d?: string) => d };
  const platformStripe: any = { client: () => stripe, current: () => ({ taxEnabled: false }) };
  return { subs: new SubscriptionsService(prisma, config, platformStripe), prisma };
}

const paying = () => ({
  id: "t1",
  email: "a@b.test",
  name: "Salón",
  plan: "pro",
  subscriptionStatus: "active",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  trialEnd: new Date(Date.now() - 60 * DAY_MS),
  currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
  subscriptionCancelAt: null as Date | null,
});

// ---------------------------------------------------------------- B3

describe("cancelling at the end of the paid period (B3)", () => {
  const periodEnd = new Date(Date.now() + 12 * DAY_MS);

  it("sets cancel_at_period_end in Stripe and keeps full access until then", async () => {
    const update = jest.fn(async () => ({
      id: "sub_1",
      status: "active",
      cancel_at_period_end: true,
      cancel_at: unix(periodEnd),
      current_period_end: unix(periodEnd),
    }));
    const cancel = jest.fn();
    const tenant = paying();
    const { subs, prisma } = service(tenant, { subscriptions: { update, cancel } });

    const res = await subs.cancelSubscription("t1");

    expect(update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(tenant.subscriptionStatus).toBe("active");
    expect(tenant.subscriptionCancelAt?.getTime()).toBe(unix(periodEnd) * 1000);
    expect(res).toEqual(
      expect.objectContaining({ status: "active", readOnlyUntil: null, newlyCancelled: false }),
    );
    expect(res.cancelAt?.getTime()).toBe(unix(periodEnd) * 1000);
  });

  it("the page reads when it ends", async () => {
    const tenant = { ...paying(), subscriptionCancelAt: periodEnd };
    const { subs } = service(tenant, null);
    const sub = await subs.getSubscription("t1");
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.cancelAt).toBe(periodEnd);
  });

  it("a Stripe failure is a Spanish 503 and nothing changes (B4 kept)", async () => {
    const update = jest.fn(async () => {
      throw new Error("Stripe unreachable");
    });
    const { subs, prisma } = service(paying(), { subscriptions: { update } });
    const err = await subs.cancelSubscription("t1").catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toMatch(/No se ha cambiado nada/);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("a subscription Stripe no longer has is cancelled at once", async () => {
    const update = jest.fn(async () => {
      throw stripeError("resource_missing");
    });
    const { subs, prisma } = service(paying(), { subscriptions: { update } });
    const res = await subs.cancelSubscription("t1");
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "cancelled" }) }),
    );
    expect(res.newlyCancelled).toBe(true);
    expect(res.readOnlyUntil).toBeInstanceOf(Date);
  });

  it("a salon behind on payments (past_due) has no paid period to keep: cancelled at once", async () => {
    const update = jest.fn();
    const cancel = jest.fn(async () => ({}));
    const { subs } = service({ ...paying(), subscriptionStatus: "past_due" }, { subscriptions: { update, cancel } });
    const res = await subs.cancelSubscription("t1");
    expect(update).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("sub_1");
    expect(res.status).toBe("cancelled");
  });

  it("the SaaS console deleting a salon cancels at once", async () => {
    const update = jest.fn();
    const cancel = jest.fn(async () => ({}));
    const { subs } = service(paying(), { subscriptions: { update, cancel } });
    await subs.cancelSubscription("t1", true);
    expect(update).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("sub_1");
  });

  it("the controller emails the read-only notice only for an immediate cancellation", async () => {
    const notify = jest.fn();
    const ctrl = Object.create(PaymentsController.prototype) as any;
    ctrl.readOnlyNotices = { notify };
    ctrl.subscriptionsService = {
      cancelSubscription: jest.fn(async () => ({ status: "active", cancelAt: periodEnd, readOnlyUntil: null, newlyCancelled: false })),
    };
    const res = await ctrl.cancelSubscription({ user: { tenantId: "t1" } });
    expect(notify).not.toHaveBeenCalled();
    expect(res.cancelAt).toBe(periodEnd);
  });

  it("«Anular cancelación» sets cancel_at_period_end back to false", async () => {
    const update = jest.fn(async () => ({ id: "sub_1", status: "active", cancel_at_period_end: false }));
    const tenant = { ...paying(), subscriptionCancelAt: periodEnd };
    const { subs } = service(tenant, { subscriptions: { update } });
    const res = await subs.undoCancellation("t1");
    expect(update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
    expect(tenant.subscriptionCancelAt).toBeNull();
    expect(res.cancelAt).toBeNull();
  });

  it("undoing fails in Spanish without changing anything when Stripe fails", async () => {
    const update = jest.fn(async () => {
      throw new Error("down");
    });
    const tenant = { ...paying(), subscriptionCancelAt: periodEnd };
    const { subs, prisma } = service(tenant, { subscriptions: { update } });
    const err = await subs.undoCancellation("t1").catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toMatch(/No se ha cambiado nada/);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("once ended it cannot be undone: the salon reactivates instead", async () => {
    const { subs } = service({ ...paying(), subscriptionStatus: "cancelled" }, { subscriptions: { update: jest.fn() } });
    const err = await subs.undoCancellation("t1").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toMatch(/reactiva el plan/);
  });

  it("no plan change while the cancellation is set", async () => {
    const retrieve = jest.fn();
    const { subs } = service({ ...paying(), subscriptionCancelAt: periodEnd }, { subscriptions: { retrieve } });
    const err = await subs.changePlan("t1", "empresa").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("cancelAtOf reads Stripe's cancel_at, else the end of the period", () => {
    expect(cancelAtOf({ cancel_at_period_end: false, cancel_at: null, current_period_end: unix(periodEnd) } as any)).toBeNull();
    expect(cancelAtOf({ cancel_at_period_end: true, cancel_at: null, current_period_end: unix(periodEnd) } as any)?.getTime()).toBe(
      unix(periodEnd) * 1000,
    );
  });
});

// ------------------------------------------------- B3 + B6: the webhook

describe("plan subscription webhooks (B3, B6)", () => {
  function controller(tenant: any, live: Record<string, any>) {
    const c = Object.create(WebhooksController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const handled = new Set<string>();
    c.prisma = {
      tenant: {
        findUnique: jest.fn(async () => tenant),
        update: jest.fn(async ({ data }: any) => Object.assign(tenant, data)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (where.subscriptionStatus?.not && tenant.subscriptionStatus === where.subscriptionStatus.not) return { count: 0 };
          Object.assign(tenant, data);
          return { count: 1 };
        }),
      },
      stripeWebhookEvent: {
        create: jest.fn(async ({ data }: any) => {
          if (handled.has(data.id)) throw Object.assign(new Error("dup"), { code: "P2002" });
          handled.add(data.id);
        }),
        delete: jest.fn(),
      },
    };
    c.readOnlyNotices = { notify: jest.fn(async () => undefined) };
    c.addonsService = { provisionFromStripe: jest.fn(), cancelFromStripe: jest.fn(), syncFromSubscription: jest.fn() };
    const stripe = {
      subscriptions: {
        retrieve: jest.fn(async (id: string) => {
          if (!(id in live)) throw stripeError("resource_missing");
          return live[id];
        }),
        cancel: jest.fn(),
      },
    };
    c.platformStripe = { client: () => stripe, current: () => ({ webhookSecret: "" }) };
    return c;
  }
  const sub = (over: any = {}) => ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    cancel_at_period_end: false,
    cancel_at: null,
    current_period_start: unix(new Date(Date.now() - 5 * DAY_MS)),
    current_period_end: unix(new Date(Date.now() + 25 * DAY_MS)),
    metadata: { kind: "plan", tenantId: "t1", plan: "esencial", locationCount: "1" },
    items: { data: [{ id: "si_1", quantity: 1 }] },
    ...over,
  });

  it("a subscription that ends after a cancellation at period end starts the 30 days of read-only and emails once", async () => {
    const tenant: any = { id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_1", subscriptionCancelAt: new Date() };
    const c = controller(tenant, {});
    await c.processStripeEvent({ id: "evt_del", type: "customer.subscription.deleted", data: { object: sub({ status: "canceled" }) } });
    expect(tenant.subscriptionStatus).toBe("cancelled");
    expect(tenant.subscriptionCancelAt).toBeNull();
    expect(Math.abs(tenant.readOnlyUntil.getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(5000);
    expect(c.readOnlyNotices.notify).toHaveBeenCalledTimes(1);
  });

  it("an update with cancel_at_period_end stores when it ends; undoing it clears it", async () => {
    const tenant: any = { id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_1" };
    const end = new Date(Date.now() + 25 * DAY_MS);
    const scheduled = sub({ cancel_at_period_end: true, cancel_at: unix(end) });
    const c = controller(tenant, { sub_1: scheduled });
    await c.processStripeEvent({ id: "evt_u1", type: "customer.subscription.updated", data: { object: scheduled } });
    expect(tenant.subscriptionCancelAt.getTime()).toBe(unix(end) * 1000);
    expect(tenant.subscriptionStatus).toBe("active");

    const renews = sub();
    const c2 = controller(tenant, { sub_1: renews });
    await c2.processStripeEvent({ id: "evt_u2", type: "customer.subscription.updated", data: { object: renews } });
    expect(tenant.subscriptionCancelAt).toBeNull();
  });

  it("subscribing during the trial keeps the trial (Pro) until it ends (B6)", async () => {
    const trialEnd = new Date(Date.now() + 9 * DAY_MS);
    const tenant: any = { id: "t1", plan: "esencial", subscriptionStatus: "trialing", trialEnd, stripeSubscriptionId: null };
    const trialing = sub({ status: "trialing", trial_end: unix(trialEnd) });
    const c = controller(tenant, { sub_1: trialing });
    await c.processStripeEvent({ id: "evt_c", type: "customer.subscription.created", data: { object: trialing } });
    expect(tenant.subscriptionStatus).toBe("trialing");
    expect(tenant.stripeSubscriptionId).toBe("sub_1");
    expect(tenant.plan).toBe("esencial");
    expect(tenant.trialEnd.getTime()).toBe(unix(trialEnd) * 1000);
    // The effective plan is still the trial's Pro.
    const { subs } = service(tenant, null);
    expect((await subs.getSubscription("t1")).effectivePlan).toBe("pro");
  });

  it("when Stripe ends its trial and charges, the salon becomes active on its plan", async () => {
    const tenant: any = {
      id: "t1",
      plan: "esencial",
      subscriptionStatus: "trialing",
      trialEnd: new Date(Date.now() - 60 * 1000),
      stripeSubscriptionId: "sub_1",
    };
    const active = sub();
    const c = controller(tenant, { sub_1: active });
    await c.processStripeEvent({ id: "evt_a", type: "customer.subscription.updated", data: { object: active } });
    expect(tenant.subscriptionStatus).toBe("active");
    const { subs } = service(tenant, null);
    expect((await subs.getSubscription("t1")).effectivePlan).toBe("esencial");
  });

  it("charged at once in the trial's last two days, it still keeps Pro until the trial ends", () => {
    const now = new Date();
    const tenant = { subscriptionStatus: "trialing", trialEnd: new Date(now.getTime() + DAY_MS) };
    expect(liveStatusFor(tenant, { status: "active" }, now)).toBe("trialing");
    expect(liveStatusFor({ ...tenant, trialEnd: new Date(now.getTime() - 1) }, { status: "active" }, now)).toBe("active");
    expect(liveStatusFor({ subscriptionStatus: "cancelled", trialEnd: null }, { status: "active" }, now)).toBe("active");
  });
});

describe("the end of a trial with a subscription (B6)", () => {
  it("becomes active instead of read-only, and no 'trial ended' email", async () => {
    const rows = new Map<string, any>([
      ["t1", { id: "t1", name: "Con plan", plan: "esencial", subscriptionStatus: "trialing", trialEnd: new Date(Date.now() - DAY_MS), stripeSubscriptionId: "sub_1" }],
      ["t2", { id: "t2", name: "Sin plan", plan: "esencial", subscriptionStatus: "trialing", trialEnd: new Date(Date.now() - DAY_MS), stripeSubscriptionId: null }],
    ]);
    const prisma: any = {
      tenant: {
        findMany: jest.fn(async () => [...rows.values()].filter((t) => t.subscriptionStatus === "trialing")),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const t = rows.get(where.id);
          if (t.subscriptionStatus !== where.subscriptionStatus) return { count: 0 };
          Object.assign(t, data);
          return { count: 1 };
        }),
      },
    };
    const notices = { notify: jest.fn(async () => undefined) };
    const s = new BillingScheduler(prisma, { record: jest.fn() } as any, notices as any);
    await s.expireTrials();
    expect(rows.get("t1").subscriptionStatus).toBe("active");
    expect(rows.get("t1").readOnlyUntil).toBeUndefined();
    expect(rows.get("t2").subscriptionStatus).toBe("cancelled");
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith("t2", "trial_ended", expect.any(Date));
  });
});

// ---------------------------------------------------------------- B7

describe("billing is the owner's (B7)", () => {
  const guard = new RolesGuard(new Reflector());
  function allowed(cls: any, method: string, role: string): boolean {
    const ctx: any = {
      getType: () => "http",
      getHandler: () => cls.prototype[method],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ method: "POST", url: `/${method}`, user: { id: "u1", role, tenantId: "t1" } }) }),
    };
    return guard.canActivate(ctx);
  }

  it("only the owner buys or cancels an add-on (a charge on her card)", () => {
    expect(allowed(TenantAddOnsController, "purchase", "owner")).toBe(true);
    expect(allowed(TenantAddOnsController, "purchase", "admin")).toBe(false);
    expect(allowed(TenantAddOnsController, "cancel", "owner")).toBe(true);
    expect(allowed(TenantAddOnsController, "cancel", "admin")).toBe(false);
  });

  it("admins still read what is installed (other pages show it)", () => {
    expect(allowed(TenantAddOnsController, "installed", "admin")).toBe(true);
  });

  it("undoing a cancellation and the plan check are owner-only too", () => {
    for (const m of ["undoCancellation", "planCheck", "updateLocationCount", "cancelSubscription"]) {
      expect(allowed(PaymentsController, m, "owner")).toBe(true);
      expect(allowed(PaymentsController, m, "admin")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- B8

describe("Empresa pays one per location open (B8)", () => {
  it("the checkout bills the locations open now", async () => {
    const create = jest.fn(async () => ({ url: "https://checkout.test", id: "cs_1" }));
    const stripe = { checkout: { sessions: { create, list: jest.fn(async () => ({ data: [] })), expire: jest.fn() } } };
    const { subs } = service({ ...paying(), subscriptionStatus: "trialing", stripeSubscriptionId: null }, stripe, { locations: 3 });
    await subs.createCheckoutSession("t1", "empresa");
    const args: any = (create.mock.calls[0] as any[])[0];
    expect(args.line_items[0].quantity).toBe(3);
    expect(args.subscription_data.metadata.locationCount).toBe("3");
  });

  it("at least one, even with no location rows yet", async () => {
    const create = jest.fn(async () => ({ url: "https://checkout.test", id: "cs_1" }));
    const stripe = { checkout: { sessions: { create, list: jest.fn(async () => ({ data: [] })), expire: jest.fn() } } };
    const { subs } = service({ ...paying(), subscriptionStatus: "trialing", stripeSubscriptionId: null }, stripe, { locations: 0 });
    await subs.createCheckoutSession("t1", "empresa");
    expect((create.mock.calls[0] as any[])[0].line_items[0].quantity).toBe(1);
  });

  it("moving to Empresa bills the locations open", async () => {
    const update = jest.fn(async () => ({ id: "sub_1", status: "active" }));
    const stripe = {
      subscriptions: { retrieve: jest.fn(async () => ({ id: "sub_1", items: { data: [{ id: "si_plan" }] } })), update },
      products: { create: jest.fn(async () => ({ id: "prod_1" })) },
    };
    const tenant = paying();
    const { subs } = service(tenant, stripe, { locations: 2 });
    const res = await subs.changePlan("t1", "empresa");
    const params: any = (update.mock.calls[0] as any[])[1];
    expect(params.items.find((i: any) => i.id === "si_plan").quantity).toBe(2);
    expect(res.locationCount).toBe(2);
    expect((tenant as any).maxLocations).toBe(2);
  });

  it("adding a location raises the Stripe quantity and the paid locations", async () => {
    const update = jest.fn(async () => ({ id: "sub_1" }));
    const stripe = {
      subscriptions: {
        retrieve: jest.fn(async () => ({ id: "sub_1", metadata: { kind: "plan" }, items: { data: [{ id: "si_plan", quantity: 2 }] } })),
        update,
      },
    };
    const tenant = { ...paying(), plan: "empresa", maxLocations: 2 };
    const { subs } = service(tenant, stripe, { locations: 2 });
    await subs.updateLocationCount("t1", 3);
    expect((update.mock.calls[0] as any[])[1].items).toEqual([{ id: "si_plan", quantity: 3 }]);
    expect(tenant.maxLocations).toBe(3);
  });

  it("paying for fewer locations than are open is refused in Spanish", async () => {
    const update = jest.fn();
    const stripe = { subscriptions: { retrieve: jest.fn(), update } };
    const { subs } = service({ ...paying(), plan: "empresa", maxLocations: 3 }, stripe, { locations: 3 });
    const err = await subs.updateLocationCount("t1", 2).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toMatch(/Tienes 3 locales activos/);
    expect(update).not.toHaveBeenCalled();
  });

  it("outside Empresa there are no locations to buy (Spanish 400, not a 500)", async () => {
    const { subs } = service(paying(), { subscriptions: {} });
    const err = await subs.updateLocationCount("t1", 2).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.message).toMatch(/Solo el plan Empresa/);
  });

  it("the page reads the locations open on Empresa", async () => {
    const { subs } = service({ ...paying(), plan: "empresa", maxLocations: 2 }, null, { locations: 2 });
    const sub = await subs.getSubscription("t1");
    expect(sub.activeLocations).toBe(2);
    expect(sub.maxLocations).toBe(2);
  });
});

// ---------------------------------------------------------------- B9

describe("moving down only within the new plan's limits (B9)", () => {
  it("Pro to Esencial with 6 professionals is refused with what to deactivate, before Stripe", async () => {
    const retrieve = jest.fn();
    const { subs } = service(paying(), { subscriptions: { retrieve, update: jest.fn() } }, { professionals: 6 });
    const err = await subs.changePlan("t1", "esencial").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toMatch(/Antes de pasar al plan Esencial/);
    expect(err.message).toMatch(/Tienes 6 profesionales activos y el plan Esencial permite 4: desactiva 2/);
    const body = err.getResponse();
    expect(body.code).toBe("PLAN_LIMITS_EXCEEDED");
    expect(body.blockers).toEqual([
      expect.objectContaining({ kind: "professionals", current: 6, limit: 4, href: "/dashboard/professionals" }),
    ]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("Empresa to Pro with 3 locations open lists the locations to close", async () => {
    const { subs } = service({ ...paying(), plan: "empresa" }, { subscriptions: { retrieve: jest.fn() } }, { professionals: 12, locations: 3 });
    const blockers = await subs.planLimitBlockers("t1", "pro");
    expect(blockers.map((b) => b.kind)).toEqual(["professionals", "locations"]);
    expect(blockers[1].message).toMatch(/Tienes 3 locales activos y el plan Pro incluye 1: desactiva 2/);
  });

  it("a salon within the limits changes plan", async () => {
    const update = jest.fn(async () => ({ id: "sub_1", status: "active" }));
    const stripe = {
      subscriptions: { retrieve: jest.fn(async () => ({ id: "sub_1", items: { data: [{ id: "si_plan" }] } })), update },
      products: { create: jest.fn(async () => ({ id: "prod_1" })) },
    };
    const { subs } = service(paying(), stripe, { professionals: 4, locations: 1 });
    await subs.changePlan("t1", "esencial");
    expect(update).toHaveBeenCalled();
    expect(await subs.planLimitBlockers("t1", "esencial")).toEqual([]);
  });

  it("Empresa has no professionals or locations limit", async () => {
    const { subs } = service(paying(), null, { professionals: 40, locations: 5 });
    expect(await subs.planLimitBlockers("t1", "empresa")).toEqual([]);
  });

  it("a trial salon contracting Esencial with too many professionals is told before Stripe", async () => {
    const create = jest.fn();
    const stripe = { checkout: { sessions: { create, list: jest.fn(async () => ({ data: [] })), expire: jest.fn() } } };
    const { subs } = service({ ...paying(), subscriptionStatus: "trialing", stripeSubscriptionId: null }, stripe, { professionals: 5 });
    const err = await subs.createCheckoutSession("t1", "esencial").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it("a cancelled (read-only) salon is blocked too (D8): it can deactivate professionals while read-only", async () => {
    const create = jest.fn(async () => ({ url: "https://checkout.test", id: "cs_1" }));
    const stripe = { checkout: { sessions: { create, list: jest.fn(async () => ({ data: [] })), expire: jest.fn() } } };
    const { subs } = service({ ...paying(), subscriptionStatus: "cancelled" }, stripe, { professionals: 6 });
    await expect(subs.createCheckoutSession("t1", "esencial")).rejects.toThrow("desactiva 2");
    expect(create).not.toHaveBeenCalled();
  });

  it("GET plan-check answers the list for the page", async () => {
    const ctrl = Object.create(PaymentsController.prototype) as any;
    ctrl.subscriptionsService = { planLimitBlockers: jest.fn(async () => [{ kind: "professionals" }]) };
    expect(await ctrl.planCheck({ user: { tenantId: "t1" } }, { plan: "esencial" })).toEqual({
      plan: "esencial",
      blockers: [{ kind: "professionals" }],
    });
  });
});

// ---------------------------------------------------------------- B18

describe("message credits (B18)", () => {
  it("reading the balance of a salon without a wallet creates nothing", async () => {
    const prisma: any = { messageCreditWallet: { findUnique: jest.fn(async () => null), create: jest.fn() } };
    const svc = new MessageBundlesService(prisma, {} as any, {} as any, { client: () => null } as any);
    expect(await svc.getBalance("t1")).toEqual({
      creditsRemaining: 0,
      creditsPurchasedTotal: 0,
      creditsUsedTotal: 0,
      lastTopupAt: null,
    });
    expect(prisma.messageCreditWallet.create).not.toHaveBeenCalled();
  });
});
