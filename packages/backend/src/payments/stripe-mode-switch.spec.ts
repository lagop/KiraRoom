import { SubscriptionsService, OTHER_MODE_SUBSCRIPTION } from "./services/subscriptions.service";

/**
 * Audit 8 P2: a customer or subscription created with the test keys does not
 * exist for the live keys (and the other way round). After a switch, a new
 * customer is created and its mode stored; the old subscription neither
 * blocks a new checkout nor is changed.
 */
const k = (...parts: string[]) => parts.join("_");
const skLive = k("sk", "live", "fictitious0123456789");

function service(tenant: any) {
  const sessions = { create: jest.fn(async () => ({ url: "https://checkout", id: "cs_1" })), list: jest.fn(async () => ({ data: [] })) };
  const customers = { create: jest.fn(async () => ({ id: "cus_live" })), update: jest.fn(async () => ({})) };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => tenant), update: jest.fn(async () => ({})) },
    location: { count: jest.fn(async () => 1) },
    professional: { count: jest.fn(async () => 1) },
  };
  const config: any = { get: (_k: string, d?: string) => d };
  const platformStripe: any = {
    client: () => ({ checkout: { sessions }, customers }),
    current: () => ({ secretKey: skLive, taxEnabled: false }),
  };
  return { subs: new SubscriptionsService(prisma, config, platformStripe), prisma, sessions, customers };
}

const base = {
  id: "t1",
  email: "a@b.test",
  name: "Salón",
  plan: "esencial",
  subscriptionStatus: "cancelled",
  trialEnd: null,
  stripeCustomerId: "cus_test",
  stripeCustomerLivemode: false,
};

describe("switching Stripe from test to live", () => {
  it("creates a new customer instead of reusing the test one, and stores its mode", async () => {
    const { subs, prisma, sessions, customers } = service(base);
    await subs.createCheckoutSession("t1", "esencial");
    expect(customers.create).toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { stripeCustomerId: "cus_live", stripeCustomerLivemode: true } }),
    );
    expect((sessions.create.mock.calls[0] as any[])[0].customer).toBe("cus_live");
  });

  it("reuses a customer of the same mode", async () => {
    const { subs, customers, sessions } = service({ ...base, stripeCustomerLivemode: true });
    await subs.createCheckoutSession("t1", "esencial");
    expect(customers.create).not.toHaveBeenCalled();
    expect((sessions.create.mock.calls[0] as any[])[0].customer).toBe("cus_test");
  });

  it("a plan paid in test mode does not block contracting it for real", async () => {
    const tenant = { ...base, subscriptionStatus: "active", stripeSubscriptionId: "sub_test", stripeSubscriptionLivemode: false };
    const { subs, sessions } = service(tenant);
    await subs.createCheckoutSession("t1", "esencial");
    expect(sessions.create).toHaveBeenCalled();
  });

  it("a subscription of the other mode cannot be changed here", async () => {
    const tenant = { ...base, subscriptionStatus: "active", stripeSubscriptionId: "sub_test", stripeSubscriptionLivemode: false };
    const { subs } = service(tenant);
    await expect(subs.changePlan("t1", "pro")).rejects.toThrow(OTHER_MODE_SUBSCRIPTION);
    await expect(subs.createBillingPortalSession("t1", "https://app")).rejects.toThrow(OTHER_MODE_SUBSCRIPTION);
    expect(await subs.getInvoices("t1")).toEqual([]);
  });
});
