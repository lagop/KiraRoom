import { BadRequestException } from "@nestjs/common";
import { PosService } from "./pos.service";

/**
 * The till is where points are spent (a reward comes off the ticket) and
 * where walk-in sales earn them. An appointment's ticket must earn through
 * the appointment only, never a second time as a sale, and a ticket that
 * fails after the points were spent must give them back.
 */
function pos(loyaltyOver: Record<string, any> = {}) {
  const prisma: any = {
    payment: { create: jest.fn(async ({ data }: any) => ({ id: `p${Math.random()}`, ...data })) },
    appointment: { count: jest.fn(async ({ where }: any) => where.id.in.length) },
    client: { findFirst: jest.fn(), create: jest.fn() },
  };
  const loyalty: any = {
    redeemAtSale: jest.fn(async () => ({ discountCents: 1000, pointsSpent: 100, rewardName: "10 EUR", redemptionId: "r1" })),
    cancelSaleRedemption: jest.fn(async () => undefined),
    earnForSale: jest.fn(async () => 30),
    settleAppointment: jest.fn(async () => ({ awarded: 0 })),
    ...loyaltyOver,
  };
  return { service: new PosService(prisma, { deductFunds: jest.fn() } as any, loyalty), prisma, loyalty };
}

const items = [{ serviceId: "svc1", name: "Corte", price: 4000, quantity: 1 }];

describe("POS and loyalty", () => {
  it("takes the reward off the total and earns on what was paid", async () => {
    const { service, prisma, loyalty } = pos();
    const out: any = await service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items,
      payments: [{ method: "cash", amount: 3000 }],
      loyaltyRewardId: "rw1",
    } as any);

    expect(out.total).toBe(3000);
    expect(out.loyalty).toMatchObject({ discount: 1000, pointsSpent: 100, pointsEarned: 30 });
    expect(loyalty.earnForSale).toHaveBeenCalledWith("t1", expect.objectContaining({ basisCents: 3000, isVisit: true }));
    const meta = prisma.payment.create.mock.calls[0][0].data.metadata;
    expect(meta).toMatchObject({ posSaleId: out.saleId, loyaltyDiscount: 1000 });
  });

  it("gives the points back when the payment does not cover the discounted total", async () => {
    const { service, loyalty } = pos();
    await expect(
      service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        items,
        payments: [{ method: "cash", amount: 2000 }],
        loyaltyRewardId: "rw1",
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loyalty.cancelSaleRedemption).toHaveBeenCalledTimes(1);
  });

  it("an appointment's ticket earns through the appointment, not as a sale", async () => {
    const { service, loyalty, prisma } = pos();
    await service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1", "a2"],
      items,
      payments: [{ method: "card", amount: 4000 }],
    } as any);
    expect(loyalty.earnForSale).not.toHaveBeenCalled();
    expect(loyalty.settleAppointment).toHaveBeenCalledTimes(2);
    expect(prisma.payment.create.mock.calls[0][0].data.metadata.appointmentIds).toEqual(["a1", "a2"]);
  });

  it("refuses appointments of another salon", async () => {
    const { service, prisma } = pos();
    prisma.appointment.count = jest.fn(async () => 0);
    await expect(
      service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a-other"],
        items,
        payments: [{ method: "card", amount: 4000 }],
      } as any),
    ).rejects.toThrow(/not found/);
  });

  it("a loyalty failure never fails the sale", async () => {
    const { service } = pos({ earnForSale: jest.fn(async () => { throw new Error("db down"); }) });
    const out: any = await service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items,
      payments: [{ method: "cash", amount: 4000 }],
    } as any);
    expect(out.status).toBe("completed");
    expect(out.loyalty.pointsEarned).toBe(0);
  });
});
