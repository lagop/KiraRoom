import { WebhooksController } from "./webhooks.controller";
import { SubscriptionsService } from "./services/subscriptions.service";
import { activationFromCheckout, activationFromSubscription, checkoutTrialEnd } from "./plan-activation";
import { monthlyPlanRevenue } from "../saas/saas.service";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";

/**
 * Nothing in the subscription flow worked end to end:
 * - the webhook required a session, so Stripe got a 401 for every event;
 * - the checkout sent price_data.product as an object, which Stripe rejects;
 * - the subscription carried no tenantId, so its events were ignored;
 * - customer.subscription.created only logged: a paying account stayed in
 *   trial and was cancelled when the trial ended;
 * - the platform console showed MRR divided by 100.
 */

function controller(tenant: any = { id: "t1", subscriptionStatus: "trialing" }) {
  const c = Object.create(WebhooksController.prototype) as any;
  c.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  c.prisma = {
    tenant: {
      findUnique: jest.fn(async () => tenant),
      findFirst: jest.fn(async () => tenant),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  c.readOnlyNotices = { notify: jest.fn(async () => undefined) };
  c.addonsService = {
    provisionFromStripe: jest.fn(),
    cancelFromStripe: jest.fn(),
    syncFromSubscription: jest.fn(),
  };
  return c;
}

const session = (over: any = {}) => ({
  mode: "subscription",
  payment_status: "paid",
  client_reference_id: "t1",
  metadata: { tenantId: "t1", plan: "empresa", locationCount: "3" },
  customer: "cus_1",
  subscription: "sub_1",
  ...over,
});

const subscription = (over: any = {}) => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  metadata: { kind: "plan", tenantId: "t1", plan: "pro", locationCount: "1" },
  items: { data: [{ id: "si_1", quantity: 1 }] },
  ...over,
});

describe("Stripe webhook", () => {
  it("is public: Stripe never has a session; the signature authenticates it", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WebhooksController.prototype.handleStripeWebhook)).toBe(true);
  });

  it("activates the plan a completed checkout paid for", async () => {
    const c = controller();
    await c.processStripeEvent({ type: "checkout.session.completed", data: { object: session() } });
    expect(c.prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: expect.objectContaining({
        subscriptionStatus: "active",
        plan: "empresa",
        maxLocations: 3,
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      }),
    });
  });

  it("activates on customer.subscription.created, which used to only log", async () => {
    const c = controller();
    await c.processStripeEvent({ type: "customer.subscription.created", data: { object: subscription() } });
    expect(c.prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "active", plan: "pro" }) }),
    );
  });

  it("leaves add-on subscriptions to the add-on path", async () => {
    const c = controller();
    await c.processStripeEvent({
      type: "customer.subscription.created",
      data: { object: subscription({ metadata: { kind: "addon", tenantId: "t1", addOnKey: "x" } }) },
    });
    expect(c.prisma.tenant.update).not.toHaveBeenCalled();
    expect(c.addonsService.provisionFromStripe).toHaveBeenCalled();
  });

  it("still cancels a tenant whose subscription Stripe cancelled", async () => {
    const c = controller({ id: "t1", subscriptionStatus: "active" });
    await c.processStripeEvent({
      type: "customer.subscription.deleted",
      data: { object: subscription({ status: "canceled" }) },
    });
    expect(c.prisma.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1", subscriptionStatus: { not: "cancelled" } },
        data: expect.objectContaining({ subscriptionStatus: "cancelled" }),
      }),
    );
    expect(c.readOnlyNotices.notify).toHaveBeenCalledWith("t1", "cancelled", expect.any(Date));
  });

  it("does not email again when the dashboard already cancelled it", async () => {
    const c = controller({ id: "t1", subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_1" });
    c.prisma.tenant.updateMany.mockResolvedValue({ count: 0 });
    await c.processStripeEvent({
      type: "customer.subscription.deleted",
      data: { object: subscription({ status: "canceled" }) },
    });
    expect(c.readOnlyNotices.notify).not.toHaveBeenCalled();
  });

  it("ignores an older subscription ending when the salon pays another one", async () => {
    const c = controller({ id: "t1", subscriptionStatus: "active", stripeSubscriptionId: "sub_new" });
    await c.processStripeEvent({
      type: "customer.subscription.deleted",
      data: { object: subscription({ id: "sub_old", status: "canceled" }) },
    });
    expect(c.prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(c.readOnlyNotices.notify).not.toHaveBeenCalled();
  });
});

describe("plan activation", () => {
  it("needs a paid subscription checkout with a tenant", () => {
    expect(activationFromCheckout(session({ mode: "payment" }) as any)).toBeNull();
    expect(activationFromCheckout(session({ payment_status: "unpaid" }) as any)).toBeNull();
    expect(activationFromCheckout(session({ metadata: {}, client_reference_id: null }) as any)).toBeNull();
    expect(activationFromCheckout(session({ metadata: {}, client_reference_id: "t9" }) as any)?.tenantId).toBe("t9");
  });

  it("ignores unpaid subscriptions and unknown plan names", () => {
    expect(activationFromSubscription(subscription({ status: "incomplete" }) as any)).toBeNull();
    const a = activationFromSubscription(subscription({ metadata: { tenantId: "t1", plan: "gold" } }) as any);
    expect(a?.plan).toBeUndefined();
  });

  it("takes the location count from what Stripe bills, not stale metadata", () => {
    const a = activationFromSubscription(
      subscription({
        metadata: { tenantId: "t1", plan: "empresa", locationCount: "2" },
        items: { data: [{ id: "si", quantity: 5 }] },
      }) as any,
    );
    expect(a?.locations).toBe(5);
  });
});

describe("checkout session", () => {
  it("sends product_data and puts the tenant on the subscription", async () => {
    const create = jest.fn(async () => ({ url: "https://checkout", id: "cs_1" }));
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => ({ id: "t1", email: "a@b.test", name: "Salón", stripeCustomerId: "cus_1" })),
        update: jest.fn(),
      },
    };
    const config: any = { get: (_k: string, d?: string) => d };
    const platformStripe: any = { client: () => ({ checkout: { sessions: { create } } }), current: () => ({ taxEnabled: false }) };
    const subs = new SubscriptionsService(prisma, config, platformStripe);

    await subs.createCheckoutSession("t1", "empresa", 2);

    const args: any = (create.mock.calls[0] as any[])[0];
    const price = args.line_items[0].price_data;
    expect(price.product).toBeUndefined();
    expect(price.product_data.name).toContain("Empresa");
    expect(args.line_items[0].quantity).toBe(2);
    expect(args.client_reference_id).toBe("t1");
    expect(args.subscription_data.metadata).toEqual({
      kind: "plan",
      tenantId: "t1",
      plan: "empresa",
      locationCount: "2",
    });
  });
});

describe("subscribing during the free trial", () => {
  const now = new Date("2026-11-01T10:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  function service(tenant: any) {
    const create = jest.fn(async () => ({ url: "https://checkout", id: "cs_1" }));
    const prisma: any = { tenant: { findUnique: jest.fn(async () => tenant), update: jest.fn() } };
    const config: any = { get: (_k: string, d?: string) => d };
    const platformStripe: any = { client: () => ({ checkout: { sessions: { create } } }), current: () => ({ taxEnabled: false }) };
    return { subs: new SubscriptionsService(prisma, config, platformStripe), create };
  }
  const base = { id: "t1", email: "a@b.test", name: "Salón", stripeCustomerId: "cus_1" };

  it("keeps the days left: the first charge waits for the trial to end", () => {
    expect(checkoutTrialEnd({ subscriptionStatus: "trialing", trialEnd: days(10) }, now)).toBe(
      Math.floor(days(10).getTime() / 1000),
    );
  });

  it("charges at once out of trial, and in the trial's last two days (Stripe wants 48 h)", () => {
    expect(checkoutTrialEnd({ subscriptionStatus: "active", trialEnd: days(10) }, now)).toBeUndefined();
    expect(checkoutTrialEnd({ subscriptionStatus: "trialing", trialEnd: days(1.9) }, now)).toBeUndefined();
    expect(checkoutTrialEnd({ subscriptionStatus: "trialing", trialEnd: null }, now)).toBeUndefined();
  });

  it("the checkout of a salon in trial carries the trial end", async () => {
    const trialEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const { subs, create } = service({ ...base, subscriptionStatus: "trialing", trialEnd });
    await subs.createCheckoutSession("t1", "pro");
    const args: any = (create.mock.calls[0] as any[])[0];
    expect(args.subscription_data.trial_end).toBe(Math.floor(trialEnd.getTime() / 1000));
    expect(args.subscription_data.metadata.plan).toBe("pro");
  });

  it("a salon that already pays changes plan instead of starting a second subscription", async () => {
    const { subs, create } = service({ ...base, subscriptionStatus: "active", stripeSubscriptionId: "sub_1" });
    await expect(subs.createCheckoutSession("t1", "empresa")).rejects.toThrow(/cambia de plan/);
    expect(create).not.toHaveBeenCalled();
  });

  it("a cancelled salon may subscribe again", async () => {
    const { subs, create } = service({ ...base, subscriptionStatus: "cancelled", stripeSubscriptionId: "sub_old" });
    await subs.createCheckoutSession("t1", "pro");
    expect(create).toHaveBeenCalled();
  });
});

describe("MRR", () => {
  it("is in euros, per location on Empresa, with legacy plan names mapped", () => {
    expect(monthlyPlanRevenue("esencial", 1)).toBe(49);
    expect(monthlyPlanRevenue("pro", 3)).toBe(79);
    expect(monthlyPlanRevenue("empresa", 3)).toBe(447);
    expect(monthlyPlanRevenue("basic", 1)).toBe(49);
    expect(monthlyPlanRevenue("gold", 1)).toBe(0);
  });
});
