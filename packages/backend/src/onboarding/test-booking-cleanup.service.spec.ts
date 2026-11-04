import { TestBookingCleanupService } from "./test-booking-cleanup.service";
import { OnboardingDetectorService } from "./onboarding-detector.service";

/**
 * D27: the wizard's test booking goes the salon day after it was made, with
 * its test client if she has nothing else. A test booking the salon charged
 * or invoiced is kept (accounting) and counts from then on; a real client
 * the wizard reused is never touched.
 */

const NOW = new Date("2026-11-04T09:00:00.000Z"); // 10:00 in Madrid, 4 Nov

function row(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    tenantId: "t1",
    clientId: "c1",
    status: "confirmed",
    paymentStatus: "pending",
    amountPaid: 0,
    depositPaid: false,
    createdAt: new Date("2026-11-03T15:00:00.000Z"), // 3 Nov, Madrid
    tenant: { timezone: "Europe/Madrid" },
    ...over,
  };
}

function setup(
  rows: any[],
  opts: {
    client?: any;
    payments?: number;
    invoices?: number;
    clientAppointments?: number;
    testLeft?: number;
  } = {},
) {
  const prisma: any = {
    appointment: {
      findMany: jest.fn(async () => rows),
      updateMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(async () => ({})),
      count: jest.fn(async ({ where }: any) =>
        where.isTest === true ? (opts.testLeft ?? 0) : (opts.clientAppointments ?? 0),
      ),
    },
    // On the booking itself (the delete blocker) vs on the client (her history).
    payment: { count: jest.fn(async ({ where }: any) => (where.appointmentId ? 0 : (opts.payments ?? 0))) },
    invoice: { count: jest.fn(async () => opts.invoices ?? 0) },
    order: { count: jest.fn(async () => 0) },
    clientWallet: { count: jest.fn(async () => 0) },
    loyaltyMember: { count: jest.fn(async () => 0) },
    client: {
      findFirst: jest.fn(async ({ where }: any) =>
        opts.client === undefined ? { id: where.id } : opts.client,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      delete: jest.fn(async () => ({})),
    },
    consent: { updateMany: jest.fn() },
    review: { updateMany: jest.fn() },
    promotionUsage: { updateMany: jest.fn() },
    loyaltyRedemption: { updateMany: jest.fn() },
    inventoryTransaction: { updateMany: jest.fn() },
    rebookingReminder: { updateMany: jest.fn() },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  return { prisma, svc: new TestBookingCleanupService(prisma) };
}

describe("TestBookingCleanupService", () => {
  it("only looks at test bookings", async () => {
    const { prisma, svc } = setup([]);
    await svc.cleanup(NOW);
    expect(prisma.appointment.findMany.mock.calls[0][0].where).toEqual({ isTest: true });
  });

  it("deletes a test booking made on an earlier salon day, and its test client with nothing else", async () => {
    const { prisma, svc } = setup([row()]);
    const r = await svc.cleanup(NOW);
    expect(prisma.appointment.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
    expect(prisma.client.findFirst.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1", isTest: true });
    expect(prisma.client.delete).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" } });
    expect(r).toEqual({ deletedAppointments: 1, deletedClients: 1, keptAsReal: 0 });
  });

  it("keeps one made today, in the salon's time zone", async () => {
    // 4 Nov 00:30 in Madrid is still 3 Nov in UTC: it is today's.
    const { prisma, svc } = setup([row({ createdAt: new Date("2026-11-03T23:30:00.000Z") })]);
    const r = await svc.cleanup(NOW);
    expect(prisma.appointment.delete).not.toHaveBeenCalled();
    expect(r.deletedAppointments).toBe(0);
  });

  it("keeps a charged test booking and counts it from now on", async () => {
    const { prisma, svc } = setup([row({ paymentStatus: "paid", amountPaid: 1800 })], { clientAppointments: 1 });
    const r = await svc.cleanup(NOW);
    expect(prisma.appointment.delete).not.toHaveBeenCalled();
    expect(prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "a1", tenantId: "t1" },
      data: { isTest: false },
    });
    // Her appointment is still there: she is a real client now.
    expect(prisma.client.delete).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: { isTest: false },
    });
    expect(r).toEqual({ deletedAppointments: 0, deletedClients: 0, keptAsReal: 1 });
  });

  it("keeps an invoiced test booking", async () => {
    const { prisma, svc } = setup([row()], { invoices: 1, clientAppointments: 1 });
    await svc.cleanup(NOW);
    expect(prisma.appointment.delete).not.toHaveBeenCalled();
  });

  it("keeps the test client when the salon has used her since", async () => {
    const { prisma, svc } = setup([row()], { payments: 1 });
    const r = await svc.cleanup(NOW);
    expect(prisma.appointment.delete).toHaveBeenCalled();
    expect(prisma.client.delete).not.toHaveBeenCalled();
    expect(r.deletedClients).toBe(0);
  });

  it("leaves the test client while another test booking of hers is left", async () => {
    const { prisma, svc } = setup([row()], { testLeft: 1 });
    await svc.cleanup(NOW);
    expect(prisma.client.delete).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).not.toHaveBeenCalled();
  });

  it("never touches a real client the wizard reused", async () => {
    const { prisma, svc } = setup([row()], { client: null });
    await svc.cleanup(NOW);
    expect(prisma.appointment.delete).toHaveBeenCalled();
    expect(prisma.client.delete).not.toHaveBeenCalled();
    expect(prisma.client.updateMany).not.toHaveBeenCalled();
  });

  it("one failure does not stop the others", async () => {
    const { prisma, svc } = setup([row({ id: "bad" }), row({ id: "a2", clientId: null })]);
    prisma.$transaction.mockRejectedValueOnce(new Error("boom"));
    const r = await svc.cleanup(NOW);
    expect(r.deletedAppointments).toBe(1);
  });
});

describe("onboarding checklist and the test booking (D27)", () => {
  it("the first booking and the clients steps do not count the wizard's test rows", async () => {
    const prisma: any = {
      appointment: { count: jest.fn(async () => 0) },
      client: { count: jest.fn(async () => 0) },
    };
    const svc = new OnboardingDetectorService(prisma, { record: jest.fn(), recordOnce: jest.fn() } as any);
    await (svc as any).hasFirstBooking("t1");
    await (svc as any).hasClients("t1");
    expect(prisma.appointment.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isTest: false } });
    expect(prisma.client.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isTest: false } });
  });
});
