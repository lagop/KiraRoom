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
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
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

/**
 * R11: the widget's "Cualquiera" asked for the whole team's times, so a time
 * only a colleague outside the widget had free was offered, and the booking
 * (findFreeProfessional, limited to the widget) then refused it.
 */
describe("getAvailableSlots for the widget's 'any professional'", () => {
  const WIDGET = "44444444-4444-4444-8444-444444444444";
  function withWidget(widgetProfessionals: string[], services?: Record<string, string[]>) {
    const svc = build(
      [
        { id: "ana", ...(services ? { services: (services.ana ?? []).map((serviceId) => ({ serviceId })) } : {}) },
        { id: "bea", ...(services ? { services: (services.bea ?? []).map((serviceId) => ({ serviceId })) } : {}) },
      ],
      [{ professionalId: "ana", scheduledTime: "10:30", duration: 60 }],
    );
    const findFirst = jest.fn(async ({ where }: any) =>
      where.id === WIDGET && where.tenantId === TENANT ? { professionals: widgetProfessionals } : null,
    );
    (svc as any).prisma.widgetInstance = { findFirst };
    const at = (widgetInstanceId = WIDGET) =>
      svc
        .getAvailableSlots(TENANT, DAY, undefined, "svc", 60, undefined, { widgetInstanceId })
        .then((slots) => slots.map((s: { time: string }) => s.time));
    return { at, findFirst };
  }

  it("only counts the widget's professionals", async () => {
    // Ana is busy at 10:30; Bea is free but not on this widget.
    expect(await withWidget(["ana"]).at()).not.toContain("10:30");
    expect(await withWidget(["ana", "bea"]).at()).toContain("10:30");
  });

  it("a widget that lists nobody offers the whole team", async () => {
    expect(await withWidget([]).at()).toContain("10:30");
  });

  it("offers nothing when none of the widget's professionals does the service", async () => {
    // Only Bea (not on the widget) is linked to it.
    expect(await withWidget(["ana"], { bea: ["svc"] }).at()).toEqual([]);
  });

  it("never reads another salon's widget", async () => {
    await expect(withWidget(["ana"]).at("55555555-5555-4555-8555-555555555555")).rejects.toThrow("Widget no encontrado");
  });
});
