import { PosService } from "./pos.service";
import { StripeService } from "../payments/services/stripe.service";

/**
 * A card sale at the till created a Stripe PaymentIntent for 100 times the
 * amount (cents passed to a method that multiplied by 100), with the
 * platform's account when the salon had none. Nobody confirmed it, so the
 * sale stayed "pending". Card at the till is the salon's own terminal.
 */
function pos() {
  const prisma: any = {
    payment: { create: jest.fn(async ({ data }: any) => ({ id: "p1", ...data })) },
    service: { findUnique: jest.fn(async () => ({ id: "s1", name: "Corte", price: 25, currency: "EUR" })) },
    client: { findFirst: jest.fn(), create: jest.fn() },
  };
  const wallet: any = { deductFunds: jest.fn() };
  return { service: new PosService(prisma, wallet), prisma };
}

describe("POS card sales", () => {
  it("records a card sale as paid, in cents, without creating a Stripe charge", async () => {
    const { service, prisma } = pos();
    await service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [{ name: "Corte", price: 2500, quantity: 1 }] as any,
      payments: [{ method: "card", amount: 2500 }] as any,
    } as any);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 2500, method: "card", status: "paid" }),
    });
    expect(prisma.payment.create.mock.calls[0][0].data.stripePaymentId).toBeUndefined();
  });

  it("does the same for a quick sale", async () => {
    const { service, prisma } = pos();
    const out = await service.quickSale("t1", "s1", "card");
    expect(out.amount).toBe(2500);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 2500, status: "paid" }),
    });
  });
});

describe("StripeService for a salon", () => {
  it("never falls back to the platform's account", async () => {
    const prisma: any = { tenant: { findUnique: jest.fn(async () => ({ stripeMode: "live" })) } };
    const config: any = { get: (k: string) => (k === "STRIPE_SECRET_KEY" ? "sk_test_platform" : undefined) };
    const stripe = new StripeService(config, prisma);
    await stripe.onModuleInit();
    const { isEnabled } = await stripe.getStripeForTenant("t1");
    expect(isEnabled).toBe(false);
    await expect(stripe.createPaymentIntent("t1", 2500)).rejects.toThrow(/not configured/);
  });

  it("charges the amount it is given, in cents", async () => {
    const create = jest.fn(async (args: any) => args);
    const stripe = new StripeService({ get: (_k: string, d?: string) => d } as any, {} as any);
    (stripe as any).getStripeForTenant = async () => ({ stripe: { paymentIntents: { create } }, isEnabled: true });
    await stripe.createPaymentIntent("t1", 2500);
    expect((create.mock.calls[0] as any[])[0].amount).toBe(2500);
  });
});
