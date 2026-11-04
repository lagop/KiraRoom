import { HttpException } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { SubscriptionsService } from "./services/subscriptions.service";

/**
 * Ajustes > Facturación audit (2026-11-02):
 * - B1: "Reactivar plan" set the salon active before any payment;
 * - B5: the webhook activated on any active subscription event, old,
 *   replayed or a second subscription, and never deduplicated events;
 * - B4: a failed Stripe cancellation still marked the salon cancelled while
 *   Stripe kept charging it.
 * No real Stripe calls: the Stripe client is a mock.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function stripeError(code: string) {
  return Object.assign(new Error(code), { code });
}

// ---------------------------------------------------------------- B1

describe("reactivating a cancelled plan (B1)", () => {
  function service(tenant: any, stripe: any = null) {
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => tenant),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      // Reactivating checks the plan's limits (D8): a salon that fits.
      professional: { count: jest.fn(async () => 1) },
      location: { count: jest.fn(async () => 1) },
    };
    const config: any = { get: (_k: string, d?: string) => d };
    const platformStripe: any = { client: () => stripe, current: () => ({ taxEnabled: false }) };
    return { subs: new SubscriptionsService(prisma, config, platformStripe), prisma };
  }
  const cancelled = {
    id: "t1",
    email: "a@b.test",
    name: "Salón",
    plan: "pro",
    subscriptionStatus: "cancelled",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_old",
    trialEnd: new Date(Date.now() - 30 * DAY_MS),
    cancelledAt: new Date(),
    readOnlyUntil: new Date(Date.now() + 20 * DAY_MS),
  };

  it("only opens the checkout: the salon stays cancelled and read-only until it pays", async () => {
    const create = jest.fn(async () => ({ url: "https://checkout.test/x", id: "cs_1" }));
    const stripe = { checkout: { sessions: { create, list: jest.fn(async () => ({ data: [] })), expire: jest.fn() } } };
    const { subs, prisma } = service(cancelled, stripe);

    const res = await subs.reactivateSubscription("t1");

    expect(res.checkoutUrl).toBe("https://checkout.test/x");
    expect(res.status).toBe("cancelled");
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    const args: any = (create.mock.calls[0] as any[])[0];
    expect(args.subscription_data.metadata).toEqual(expect.objectContaining({ tenantId: "t1", plan: "pro" }));
    // Out of trial: charged at once.
    expect(args.subscription_data.trial_end).toBeUndefined();
  });

  it("without Stripe it refuses, in Spanish, instead of activating for free", async () => {
    const { subs, prisma } = service(cancelled, null);
    await expect(subs.reactivateSubscription("t1")).rejects.toThrow(/pago no está disponible/);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("a Stripe failure opening the checkout is an error, not a free reactivation", async () => {
    const stripe = {
      checkout: {
        sessions: {
          create: jest.fn(async () => {
            throw new Error("Stripe down");
          }),
          list: jest.fn(async () => ({ data: [] })),
          expire: jest.fn(),
        },
      },
    };
    const { subs, prisma } = service(cancelled, stripe);
    const err = await subs.reactivateSubscription("t1").catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toMatch(/página de pago/);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("still in the free trial, it returns to the trial (nothing to pay yet)", async () => {
    const { subs, prisma } = service({ ...cancelled, trialEnd: new Date(Date.now() + 5 * DAY_MS) }, null);
    const res = await subs.reactivateSubscription("t1");
    expect(res).toEqual({ tenantId: "t1", status: "trialing", checkoutUrl: null });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: expect.objectContaining({ subscriptionStatus: "trialing", readOnlyUntil: null, stripeSubscriptionId: null }),
    });
  });

  it("a salon that is not cancelled is left alone", async () => {
    const { subs, prisma } = service({ ...cancelled, subscriptionStatus: "active" }, null);
    const res = await subs.reactivateSubscription("t1");
    expect(res.status).toBe("active");
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("a new plan checkout expires the salon's plan checkouts still open", async () => {
    const expire = jest.fn(async () => ({}));
    const list = jest.fn(async () => ({
      data: [
        { id: "cs_old_plan", mode: "subscription", metadata: { tenantId: "t1", plan: "pro" } },
        { id: "cs_pack", mode: "payment", metadata: { tenantId: "t1", kind: "email_pack" } },
        { id: "cs_other", mode: "subscription", metadata: { tenantId: "t2", plan: "pro" } },
      ],
    }));
    const create = jest.fn(async () => ({ url: "https://checkout.test/y", id: "cs_new" }));
    const { subs } = service(cancelled, { checkout: { sessions: { create, list, expire } } });
    await subs.createCheckoutSession("t1", "pro");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1", status: "open" }));
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith("cs_old_plan");
    expect(create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- B4

describe("cancelling when Stripe fails (B4)", () => {
  function service(tenant: any, stripe: any) {
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => tenant),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: tenant.subscriptionStatus === "cancelled" ? 0 : 1 })),
      },
    };
    const platformStripe: any = { client: () => stripe, current: () => ({ taxEnabled: false }) };
    return { subs: new SubscriptionsService(prisma, { get: () => undefined } as any, platformStripe), prisma };
  }
  const paying = { id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_1" };
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("keeps the salon as it was and says so, so the owner can retry", async () => {
    // A paid subscription is set to end with its period (B3): that call fails.
    const update = jest.fn(async () => {
      throw new Error("Stripe unreachable");
    });
    const { subs, prisma } = service(paying, { subscriptions: { update } });
    const err = await subs.cancelSubscription("t1").catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(503);
    expect(err.message).toMatch(/No se ha cambiado nada/);
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("a salon that is not paying (past_due) is cancelled in Stripe first, then here", async () => {
    const order: string[] = [];
    const cancel = jest.fn(async () => {
      order.push("stripe");
      return {};
    });
    const { subs, prisma } = service({ ...paying, subscriptionStatus: "past_due" }, { subscriptions: { cancel } });
    prisma.tenant.updateMany.mockImplementation(async () => {
      order.push("local");
      return { count: 1 };
    });
    const res = await subs.cancelSubscription("t1");
    expect(cancel).toHaveBeenCalledWith("sub_1");
    expect(order).toEqual(["stripe", "local"]);
    expect(res.newlyCancelled).toBe(true);
  });

  it("a subscription Stripe no longer has counts as cancelled", async () => {
    const update = jest.fn(async () => {
      throw stripeError("resource_missing");
    });
    const { subs, prisma } = service(paying, { subscriptions: { update } });
    await subs.cancelSubscription("t1");
    expect(prisma.tenant.updateMany).toHaveBeenCalled();
  });

  it("with a subscription but no Stripe client, it refuses rather than cancel only here", async () => {
    const { subs, prisma } = service(paying, null);
    await expect(subs.cancelSubscription("t1")).rejects.toThrow(/sistema de pagos no está disponible/);
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("cancelling again an already cancelled salon is not blocked by Stripe", async () => {
    const cancel = jest.fn(async () => {
      throw new Error("already canceled");
    });
    const { subs, prisma } = service({ ...paying, subscriptionStatus: "cancelled" }, { subscriptions: { cancel } });
    const res = await subs.cancelSubscription("t1");
    expect(res.newlyCancelled).toBe(false);
    expect(prisma.tenant.update).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- B5

describe("plan activation from the webhook (B5)", () => {
  const sub = (over: any = {}) => ({
    id: "sub_new",
    status: "active",
    customer: "cus_1",
    metadata: { kind: "plan", tenantId: "t1", plan: "pro", locationCount: "1" },
    items: { data: [{ id: "si_1", quantity: 1 }] },
    ...over,
  });

  /** `live` maps a subscription id to what Stripe returns for it now. */
  function controller(tenant: any, live: Record<string, any> | null) {
    const c = Object.create(WebhooksController.prototype) as any;
    c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const handled = new Set<string>();
    c.prisma = {
      tenant: {
        findUnique: jest.fn(async () => tenant),
        findFirst: jest.fn(async () => tenant),
        update: jest.fn(async ({ data }: any) => Object.assign(tenant, data)),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      stripeWebhookEvent: {
        create: jest.fn(async ({ data }: any) => {
          if (handled.has(data.id)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
          handled.add(data.id);
          return data;
        }),
        delete: jest.fn(async ({ where }: any) => handled.delete(where.id)),
      },
    };
    c.readOnlyNotices = { notify: jest.fn(async () => undefined) };
    c.addonsService = { provisionFromStripe: jest.fn(), cancelFromStripe: jest.fn(), syncFromSubscription: jest.fn() };
    const stripe = live
      ? {
          subscriptions: {
            retrieve: jest.fn(async (id: string) => {
              if (!(id in live)) throw stripeError("resource_missing");
              return live[id];
            }),
            cancel: jest.fn(async () => ({})),
          },
        }
      : null;
    c.platformStripe = { client: () => stripe, current: () => ({ webhookSecret: "" }) };
    return { c, stripe, handled };
  }
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  const created = (object: any, id = "evt_1") => ({ id, type: "customer.subscription.created", data: { object } });
  const updated = (object: any, id = "evt_2") => ({ id, type: "customer.subscription.updated", data: { object } });

  it("a replayed old 'active' event after the salon cancelled does not reactivate it", async () => {
    const tenant = { id: "t1", subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_old" };
    const { c } = controller(tenant, { sub_old: sub({ id: "sub_old", status: "canceled" }) });
    await c.processStripeEvent(updated(sub({ id: "sub_old" }), "evt_old"));
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
    expect(tenant.subscriptionStatus).toBe("cancelled");
  });

  it("the same replay without a Stripe client (snapshot only) does not reactivate it either", async () => {
    const tenant = { id: "t1", subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_old" };
    const { c } = controller(tenant, null);
    await c.processStripeEvent(updated(sub({ id: "sub_old" }), "evt_old"));
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("an older subscription that Stripe has since cancelled is ignored", async () => {
    const tenant = { id: "t1", subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_mid" };
    const { c } = controller(tenant, { sub_ancient: sub({ id: "sub_ancient", status: "canceled" }) });
    await c.processStripeEvent(created(sub({ id: "sub_ancient" })));
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("the new checkout of a cancelled salon activates it once paid", async () => {
    const tenant = { id: "t1", subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_old" };
    const { c } = controller(tenant, { sub_new: sub() });
    await c.processStripeEvent({
      id: "evt_cs",
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          payment_status: "paid",
          client_reference_id: "t1",
          metadata: { tenantId: "t1", plan: "pro", locationCount: "1" },
          customer: "cus_1",
          subscription: "sub_new",
        },
      },
    });
    expect(c.prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: expect.objectContaining({
        subscriptionStatus: "active",
        stripeSubscriptionId: "sub_new",
        readOnlyUntil: null,
        cancelledAt: null,
      }),
    });
  });

  it("reads plan and locations from the subscription as Stripe has it now", async () => {
    const tenant = { id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_new" };
    const now = sub({
      metadata: { kind: "plan", tenantId: "t1", plan: "empresa", locationCount: "3" },
      items: { data: [{ id: "si_1", quantity: 3 }] },
    });
    const { c } = controller(tenant, { sub_new: now });
    // An old snapshot (still Pro) delivered late.
    await c.processStripeEvent(updated(sub()));
    expect(c.prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ plan: "empresa", maxLocations: 3 }) }),
    );
  });

  it("an event for another tenant's subscription is ignored", async () => {
    const tenant = { id: "t1", subscriptionStatus: "trialing", stripeSubscriptionId: null };
    const { c } = controller(tenant, {
      sub_x: sub({ id: "sub_x", metadata: { kind: "plan", tenantId: "t2", plan: "pro" } }),
    });
    await c.processStripeEvent(created(sub({ id: "sub_x" })));
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("a second live subscription is cancelled in Stripe and not applied", async () => {
    const tenant = { id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_first", plan: "pro" };
    const { c, stripe } = controller(tenant, {
      sub_first: sub({ id: "sub_first" }),
      sub_second: sub({ id: "sub_second", metadata: { kind: "plan", tenantId: "t1", plan: "esencial" } }),
    });
    await c.processStripeEvent(created(sub({ id: "sub_second" })));
    expect(stripe!.subscriptions.cancel).toHaveBeenCalledWith("sub_second");
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
    expect(tenant.stripeSubscriptionId).toBe("sub_first");
    expect(c.logger.error).toHaveBeenCalledWith(expect.stringMatching(/refund its first invoice by hand/));
  });

  it("a new subscription replaces a stored one that Stripe already ended", async () => {
    const tenant = { id: "t1", subscriptionStatus: "past_due", stripeSubscriptionId: "sub_first" };
    const { c, stripe } = controller(tenant, {
      sub_first: sub({ id: "sub_first", status: "canceled" }),
      sub_second: sub({ id: "sub_second" }),
    });
    await c.processStripeEvent(created(sub({ id: "sub_second" })));
    expect(stripe!.subscriptions.cancel).not.toHaveBeenCalled();
    expect(tenant.stripeSubscriptionId).toBe("sub_second");
    expect(tenant.subscriptionStatus).toBe("active");
  });

  it("handles each Stripe event id once", async () => {
    const tenant = { id: "t1", subscriptionStatus: "trialing", stripeSubscriptionId: null };
    const { c } = controller(tenant, { sub_new: sub() });
    const first = await c.processStripeEvent(created(sub(), "evt_same"));
    const again = await c.processStripeEvent(created(sub(), "evt_same"));
    expect(first).toEqual({ received: true });
    expect(again).toEqual({ received: true, duplicate: true });
    expect(c.prisma.tenant.update).toHaveBeenCalledTimes(1);
  });

  it("an event that fails is released, so Stripe's retry is handled", async () => {
    const tenant = { id: "t1", subscriptionStatus: "trialing", stripeSubscriptionId: null };
    const { c, stripe, handled } = controller(tenant, { sub_new: sub() });
    stripe!.subscriptions.retrieve.mockRejectedValueOnce(new Error("Stripe unreachable"));
    await expect(c.processStripeEvent(created(sub(), "evt_retry"))).rejects.toThrow(/unreachable/);
    expect(handled.has("evt_retry")).toBe(false);
    await c.processStripeEvent(created(sub(), "evt_retry"));
    expect(tenant.subscriptionStatus).toBe("active");
  });
});
