import { WebhooksController } from "./webhooks.controller";
import { SubscriptionsService } from "./services/subscriptions.service";
import { activationFromCheckout, activationFromSubscription } from "./plan-activation";
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
    },
  };
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
    expect(c.prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionStatus: "cancelled" }) }),
    );
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
    const config: any = { get: (k: string, d?: string) => (k === "STRIPE_SECRET_KEY" ? "sk_test_x" : d) };
    const subs = new SubscriptionsService(prisma, config);
    (subs as any).stripe = { checkout: { sessions: { create } } };

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

describe("MRR", () => {
  it("is in euros, per location on Empresa, with legacy plan names mapped", () => {
    expect(monthlyPlanRevenue("esencial", 1)).toBe(49);
    expect(monthlyPlanRevenue("pro", 3)).toBe(79);
    expect(monthlyPlanRevenue("empresa", 3)).toBe(447);
    expect(monthlyPlanRevenue("basic", 1)).toBe(49);
    expect(monthlyPlanRevenue("gold", 1)).toBe(0);
  });
});
