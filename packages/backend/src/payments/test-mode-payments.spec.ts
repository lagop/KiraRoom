import { ConflictException } from "@nestjs/common";
import { SubscriptionsService } from "./services/subscriptions.service";
import { AddOnsService } from "./services/addons.service";
import { EmailPacksService } from "../email-campaigns/email-packs.service";
import { paymentsTestMode, TEST_MODE_PAYMENTS_REFUSED, testModeRefusesPayment } from "../platform/stripe-settings";

/**
 * Audit 8 D8: with the platform's Stripe test keys in force nothing is
 * charged, so real salons cannot contract a plan, change it, or buy add-ons
 * or packs. KiraRoom's own salons (isInternal) can; live keys change nothing.
 */
const k = (...parts: string[]) => parts.join("_");
const skTest = k("sk", "test", "fictitious0123456789");
const skLive = k("sk", "live", "fictitious0123456789");

function service(tenant: any, secretKey: string) {
  const sessions = { create: jest.fn(async () => ({ url: "https://checkout", id: "cs_1" })), list: jest.fn(async () => ({ data: [] })) };
  const customers = { create: jest.fn(async () => ({ id: "cus_1" })), update: jest.fn(async () => ({})) };
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => tenant), update: jest.fn(async () => ({})) },
    location: { count: jest.fn(async () => 1) },
    professional: { count: jest.fn(async () => 1) },
  };
  const config: any = { get: (_k: string, d?: string) => d };
  const platformStripe: any = {
    client: () => ({ checkout: { sessions }, customers }),
    current: () => ({ secretKey, taxEnabled: false }),
  };
  return { subs: new SubscriptionsService(prisma, config, platformStripe), prisma, platformStripe, sessions };
}

const realSalon = {
  id: "t1",
  email: "a@b.test",
  name: "Salón",
  plan: "esencial",
  subscriptionStatus: "trialing",
  trialEnd: null,
  stripeCustomerId: null,
  stripeCustomerLivemode: null,
  isInternal: false,
};
const paying = {
  ...realSalon,
  plan: "empresa",
  subscriptionStatus: "active",
  stripeSubscriptionId: "sub_1",
  stripeSubscriptionLivemode: false,
};

describe("test-mode payments (D8)", () => {
  it("the rule: test keys refuse real salons only", () => {
    expect(paymentsTestMode(false)).toBe(true);
    expect(paymentsTestMode(true)).toBe(false);
    expect(paymentsTestMode(null)).toBe(false);
    expect(testModeRefusesPayment(false, { isInternal: false })).toBe(true);
    expect(testModeRefusesPayment(false, {})).toBe(true);
    expect(testModeRefusesPayment(false, { isInternal: true })).toBe(false);
    expect(testModeRefusesPayment(true, { isInternal: false })).toBe(false);
    expect(testModeRefusesPayment(null, { isInternal: false })).toBe(false);
  });

  it("refuses checkout, plan change and locations for a real salon with test keys", async () => {
    const a = service(realSalon, skTest);
    await expect(a.subs.createCheckoutSession("t1", "pro")).rejects.toThrow(TEST_MODE_PAYMENTS_REFUSED);
    expect(a.sessions.create).not.toHaveBeenCalled();

    const b = service(paying, skTest);
    await expect(b.subs.changePlan("t1", "pro")).rejects.toThrow(TEST_MODE_PAYMENTS_REFUSED);
    await expect(b.subs.updateLocationCount("t1", 2)).rejects.toThrow(TEST_MODE_PAYMENTS_REFUSED);
  });

  it("lets an internal salon check out with test keys", async () => {
    const { subs, sessions } = service({ ...realSalon, isInternal: true }, skTest);
    await subs.createCheckoutSession("t1", "pro");
    expect(sessions.create).toHaveBeenCalled();
  });

  it("changes nothing with live keys", async () => {
    const { subs, sessions } = service(realSalon, skLive);
    await subs.createCheckoutSession("t1", "pro");
    expect(sessions.create).toHaveBeenCalled();
  });

  it("tells the billing page that payments are in test mode", async () => {
    expect(await service(realSalon, skTest).subs.getSubscription("t1")).toMatchObject({
      paymentsTestMode: true,
      paymentsBlocked: true,
    });
    expect(await service({ ...realSalon, isInternal: true }, skTest).subs.getSubscription("t1")).toMatchObject({
      paymentsTestMode: true,
      paymentsBlocked: false,
    });
    expect(await service(realSalon, skLive).subs.getSubscription("t1")).toMatchObject({
      paymentsTestMode: false,
      paymentsBlocked: false,
    });
  });

  it("refuses an add-on for a real salon with test keys", async () => {
    const { subs } = service(paying, skTest);
    const prisma: any = {
      addOn: {
        findUnique: jest.fn(async () => ({
          id: "a1",
          key: "extra",
          name: "Extra",
          isActive: true,
          metered: false,
          purchasable: true,
          monthlyPriceCents: 900,
        })),
      },
      tenant: { findUnique: jest.fn(async () => paying) },
    };
    const addons = new AddOnsService(prisma, {} as any, subs, {} as any, {} as any);
    await expect(addons.purchase("t1", "extra")).rejects.toThrow(TEST_MODE_PAYMENTS_REFUSED);
  });

  it("refuses the email pack for a real salon with test keys, not for an internal one", async () => {
    const pack = { emails: 1000, priceCents: 900 };
    const sessions = { create: jest.fn(async () => ({ url: "https://checkout" })) };
    const make = (tenant: any) =>
      new EmailPacksService(
        { tenant: { findUnique: jest.fn(async () => tenant) } } as any,
        { marketingPack: () => pack } as any,
        { client: () => ({ checkout: { sessions } }), current: () => ({ secretKey: skTest, taxEnabled: false }) } as any,
        { get: () => undefined } as any,
      );
    await expect(make(realSalon).createCheckout("t1")).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.create).not.toHaveBeenCalled();
    await make({ ...realSalon, isInternal: true }).createCheckout("t1");
    expect(sessions.create).toHaveBeenCalled();
  });
});
