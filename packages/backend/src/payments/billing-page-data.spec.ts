import { SubscriptionsService, invoiceAmount, isUnlimited } from "./services/subscriptions.service";

/**
 * What the Facturación page reads. The usage meters printed "120 /  clientes"
 * on unlimited plans (the catalog says null, the check was === -1); an open
 * subscription invoice showed 0,00 € (amount_paid); and in trial the page
 * said "Esencial" while the salon has Pro, and offered add-ons the backend
 * refuses until there is a paid subscription.
 */

function service(tenant: Record<string, unknown>) {
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ id: "t1", plan: "esencial", ...tenant })) },
    client: { count: jest.fn(async () => 120) },
    professional: { count: jest.fn(async () => 3) },
    appointment: { count: jest.fn(async () => 40) },
  };
  return new SubscriptionsService(
    prisma,
    { get: () => undefined } as any,
    { client: () => null, current: () => ({ taxEnabled: false }) } as any,
  );
}

const inAWeek = new Date(Date.now() + 7 * 86_400_000);

describe("usage meters", () => {
  it("null and -1 are unlimited; a number is a limit", () => {
    expect(isUnlimited(null)).toBe(true);
    expect(isUnlimited(-1)).toBe(true);
    expect(isUnlimited(undefined)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(4)).toBe(false);
  });

  it("Esencial: clients and appointments unlimited, professionals capped", async () => {
    const usage = (await service({ subscriptionStatus: "active" }).getUsageStats("t1")).usage;
    expect(usage.clients).toEqual({ current: 120, limit: null, unlimited: true });
    expect(usage.appointments).toEqual({ current: 40, limit: null, unlimited: true });
    expect(usage.professionals).toEqual({ current: 3, limit: 4, unlimited: false });
  });
});

describe("subscription invoices", () => {
  it("an open or unpaid invoice shows what it asks for; a paid one what was paid", () => {
    expect(invoiceAmount({ status: "open", amount_due: 4900, amount_paid: 0 })).toBe(4900);
    expect(invoiceAmount({ status: "uncollectible", amount_due: 4900, amount_paid: 0 })).toBe(4900);
    expect(invoiceAmount({ status: "paid", amount_due: 4900, amount_paid: 4900 })).toBe(4900);
    expect(invoiceAmount({ status: "void", amount_due: 4900, amount_paid: 0 })).toBe(0);
  });
});

describe("GET subscription: the plan the salon has", () => {
  it("in trial: Pro, and no add-ons yet", async () => {
    const sub = await service({ subscriptionStatus: "trialing", trialEnd: inAWeek }).getSubscription("t1");
    expect(sub).toMatchObject({ plan: "esencial", inTrial: true, effectivePlan: "pro", canBuyAddOns: false });
  });

  it("a trial that has ended is not Pro", async () => {
    const sub = await service({ subscriptionStatus: "trialing", trialEnd: new Date(Date.now() - 1000) }).getSubscription("t1");
    expect(sub).toMatchObject({ inTrial: false, effectivePlan: "esencial" });
  });

  it("paying: its plan, and add-ons can be bought", async () => {
    const sub = await service({ plan: "pro", subscriptionStatus: "active", stripeSubscriptionId: "sub_1" }).getSubscription("t1");
    expect(sub).toMatchObject({ inTrial: false, effectivePlan: "pro", canBuyAddOns: true });
  });

  it("past due or without a subscription id: no add-ons, as AddOnsService.purchase refuses them", async () => {
    expect((await service({ subscriptionStatus: "past_due", stripeSubscriptionId: "sub_1" }).getSubscription("t1")).canBuyAddOns).toBe(false);
    expect((await service({ subscriptionStatus: "active", stripeSubscriptionId: null }).getSubscription("t1")).canBuyAddOns).toBe(false);
  });
});
