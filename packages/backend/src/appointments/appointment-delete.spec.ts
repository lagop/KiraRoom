import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppointmentsService } from "./appointments.service";

/**
 * DELETE /appointments/:id hard-deleted anything, completed, paid and
 * invoiced appointments included. Those are history and accounting now:
 * refused with a 409 that says to cancel instead.
 */

type Apt = Record<string, any>;

function build(overrides: Apt = {}, counts: { payments?: number; invoices?: number } = {}) {
  const appointment: Apt = {
    id: "apt-1",
    tenantId: "t1",
    clientId: "c1",
    status: "confirmed",
    paymentStatus: "pending",
    amountPaid: new Prisma.Decimal(0),
    depositPaid: false,
    ...overrides,
  };
  const ops: string[] = [];
  const track = (name: string) => jest.fn((args: any) => { ops.push(name); return { name, args }; });
  const prisma: any = {
    appointment: {
      findUnique: jest.fn(async () => appointment),
      updateMany: track("appointment.updateMany"),
      delete: track("appointment.delete"),
    },
    payment: { count: jest.fn(async () => counts.payments ?? 0) },
    invoice: { count: jest.fn(async () => counts.invoices ?? 0) },
    consent: { updateMany: track("consent.updateMany") },
    review: { updateMany: track("review.updateMany") },
    promotionUsage: { updateMany: track("promotionUsage.updateMany") },
    loyaltyRedemption: { updateMany: track("loyaltyRedemption.updateMany") },
    inventoryTransaction: { updateMany: track("inventoryTransaction.updateMany") },
    rebookingReminder: { updateMany: track("rebookingReminder.updateMany") },
    $transaction: jest.fn(async (steps: any[]) => steps),
  };
  const stub = {} as any;
  const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  return { service, prisma, ops };
}

const OWNER = { id: "u1", role: "owner", tenantId: "t1" };

describe("deleting an appointment", () => {
  it.each(["pending", "confirmed", "cancelled", "no_show"])("deletes a %s one with no money on it", async (status) => {
    const { service, prisma } = build({ status });
    await service.remove(OWNER, "apt-1");
    expect(prisma.appointment.delete).toHaveBeenCalledWith({ where: { id: "apt-1" } });
  });

  it("refuses a completed one", async () => {
    const { service, prisma } = build({ status: "completed" });
    const err = await service.remove(OWNER, "apt-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/completada/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses one with a payment row, and says to cancel it", async () => {
    const { service, prisma } = build({}, { payments: 1 });
    const err = await service.remove(OWNER, "apt-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/pagos.*Cancélala/);
    expect(prisma.payment.count).toHaveBeenCalledWith({ where: { tenantId: "t1", appointmentId: "apt-1" } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["marked paid", { paymentStatus: "paid" }],
    ["refunded", { paymentStatus: "refunded" }],
    ["partly paid", { amountPaid: new Prisma.Decimal("15.50") }],
    ["with its deposit paid", { depositPaid: true }],
  ])("refuses one %s on the appointment itself", async (_label, overrides) => {
    const { service, prisma } = build(overrides);
    await expect(service.remove(OWNER, "apt-1")).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an invoiced one, whether the invoice is for it or only has a line for it", async () => {
    const { service, prisma } = build({}, { invoices: 1 });
    const err = await service.remove(OWNER, "apt-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/facturada.*Cancélala/);
    expect(prisma.invoice.count).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        OR: [
          { sourceType: "appointment", sourceId: "apt-1" },
          { lines: { some: { appointmentId: "apt-1" } } },
        ],
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("unlinks the rows that point at it without a foreign key, in the same transaction as the delete", async () => {
    const { service, prisma, ops } = build();
    await service.remove(OWNER, "apt-1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ops[ops.length - 1]).toBe("appointment.delete");
    for (const model of ["consent", "review", "promotionUsage", "loyaltyRedemption", "inventoryTransaction"]) {
      expect(prisma[model].updateMany).toHaveBeenCalledWith({
        where: { appointmentId: "apt-1" },
        data: { appointmentId: null },
      });
    }
    expect(prisma.rebookingReminder.updateMany).toHaveBeenCalledWith({
      where: { resultAppointmentId: "apt-1" },
      data: { resultAppointmentId: null },
    });
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { parentAppointmentId: "apt-1" },
      data: { parentAppointmentId: null },
    });
  });

  it("is a 409, not a 500, when a payment lands between the check and the delete", async () => {
    const { service, prisma } = build();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "5.22.0" }),
    );
    await expect(service.remove(OWNER, "apt-1")).rejects.toThrow(ConflictException);
  });

  it("is still a 404 for an appointment that is not there", async () => {
    const { service, prisma } = build();
    prisma.appointment.findUnique.mockResolvedValueOnce(null);
    await expect(service.remove(OWNER, "apt-1")).rejects.toThrow(NotFoundException);
  });
});
