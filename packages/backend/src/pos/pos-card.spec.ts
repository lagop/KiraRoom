import { PosService } from "./pos.service";
import { StripeService } from "../payments/services/stripe.service";

/**
 * A card sale at the till created a Stripe PaymentIntent for 100 times the
 * amount (cents passed to a method that multiplied by 100), with the
 * platform's account when the salon had none. Nobody confirmed it, so the
 * sale stayed "pending". Card at the till is the salon's own terminal.
 */
function pos({ serviceActive = true } = {}) {
  const prisma: any = {
    payment: { create: jest.fn(async ({ data }: any) => ({ id: "p1", ...data })) },
    service: {
      findUnique: jest.fn(async () => ({ id: "s1", name: "Corte", price: 25, currency: "EUR" })),
      // The quick sale reads it within the salon.
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === "t1" && where.id === "s1"
          ? { id: "s1", name: "Corte", price: 25, currency: "EUR", isActive: serviceActive }
          : null,
      ),
      findMany: jest.fn(async () => [{ id: "s1", name: "Corte", price: 25 }]),
    },
    client: { findFirst: jest.fn(async ({ where }: any) => (where.id ? { id: where.id } : null)), create: jest.fn() },
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
      items: [{ serviceId: "s1", quantity: 1 }] as any,
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

  it("refuses a quick sale of a deactivated service, or of another salon's", async () => {
    const off = pos({ serviceActive: false });
    await expect(off.service.quickSale("t1", "s1", "cash")).rejects.toThrow(/desactivado/);
    expect(off.prisma.payment.create).not.toHaveBeenCalled();

    const other = pos();
    await expect(other.service.quickSale("t2", "s1", "cash")).rejects.toThrow(/not found/);
    expect(other.prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe("StripeService for a salon", () => {
  it("never falls back to the platform's account", async () => {
    const prisma: any = { tenant: { findUnique: jest.fn(async () => ({ stripeMode: "live" })) } };
    // KiraRoom's own account is set; a salon must still never use it.
    const platformStripe: any = { client: () => ({}), current: () => ({ secretKey: "sk_test_platform", publishableKey: null }) };
    const stripe = new StripeService({ get: () => undefined } as any, prisma, platformStripe);
    const { isEnabled } = await stripe.getStripeForTenant("t1");
    expect(isEnabled).toBe(false);
  });
  // createPaymentIntent (and its 'charges in cents' test) is gone: nothing
  // called it. Online client payments come with Stripe Connect.
});
