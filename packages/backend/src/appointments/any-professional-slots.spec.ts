import { AppointmentsService } from "./appointments.service";

/**
 * "Any professional" availability. Found in an end-to-end chat: with five
 * stylists and one of them busy at 11:00, a 60-minute cut at 10:30 was
 * reported taken -- the check asked "is anyone on shift" and then "does ANY
 * appointment overlap", so one stylist's booking blocked the four free ones.
 */

const TENANT = "tenant-1";
const DAY = new Date("2026-10-01T00:00:00.000Z"); // a Thursday

function build(professionals: Array<{ id: string; workingHours?: unknown }>, appointments: any[]) {
  const prisma: any = {
    tenant: { findUnique: async () => ({ id: TENANT, openingHours: {}, timezone: "Europe/Madrid" }) },
    professional: {
      findMany: async () => professionals.map((p) => ({ tenantId: TENANT, isActive: true, workingHours: null, ...p })),
    },
    service: { findFirst: async () => ({ id: "svc", duration: 60, isActive: true }) },
    appointment: {
      findMany: async () => appointments.map((a) => ({ status: "confirmed", duration: 45, ...a })),
    },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

const times = async (svc: AppointmentsService) =>
  (await svc.getAvailableSlots(TENANT, DAY, undefined, "svc")).map((s: { time: string }) => s.time);

describe("getAvailableSlots without a professional", () => {
  it("offers a slot while another professional is free", async () => {
    const svc = build([{ id: "ana" }, { id: "bea" }], [{ professionalId: "ana", scheduledTime: "11:00" }]);
    expect(await times(svc)).toContain("10:30");
  });

  it("does not offer it when every professional is busy", async () => {
    const svc = build(
      [{ id: "ana" }, { id: "bea" }],
      [
        { professionalId: "ana", scheduledTime: "11:00" },
        { professionalId: "bea", scheduledTime: "10:45" },
      ],
    );
    expect(await times(svc)).not.toContain("10:30");
  });

  it("does not count a free professional who is off shift", async () => {
    const offOnThursday = [{ day: "monday", openTime: "09:00", closeTime: "18:00" }];
    const svc = build(
      [{ id: "ana" }, { id: "bea", workingHours: offOnThursday }],
      [{ professionalId: "ana", scheduledTime: "11:00" }],
    );
    expect(await times(svc)).not.toContain("10:30");
  });
});
