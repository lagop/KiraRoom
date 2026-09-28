import { ConflictException, NotFoundException } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";

/**
 * Who decides an appointment's salon, and whether its slot is real.
 *
 * `create` took `tenantId` from the body, and every caller sent something
 * different: 'default', '1', a hardcoded salon UUID from the calendar. It
 * looked the client up by email across every salon, so a client of salon A
 * booking on salon B's site was matched to their A record, the tenant
 * switched to A, and B's professional was then "not found". And the public
 * route checked nothing about the slot: a direct POST could book 03:00 or a
 * slot already taken.
 */

const PRO = { id: "pro-b", tenantId: "tenant-b" };

function build({
  existingClients = [] as Array<{ id: string; email: string; tenantId: string }>,
  availableTimes = ["10:00"],
} = {}) {
  const clientLookups: any[] = [];
  const created: any[] = [];
  const prisma: any = {
    tenant: { findUnique: async () => ({ timezone: "Europe/Madrid" }) },
    professional: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === PRO.id && (!where.tenantId || where.tenantId === PRO.tenantId) ? PRO : null,
      ),
    },
    service: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === "tenant-b" ? { id: "svc", duration: 30, price: 20, currency: "EUR" } : null,
      ),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) => {
        clientLookups.push(where);
        return (
          existingClients.find(
            (c) =>
              (where.email === undefined || c.email === where.email) &&
              (where.id === undefined || c.id === where.id) &&
              c.tenantId === where.tenantId,
          ) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: "client-new", ...data };
        existingClients.push(row);
        return row;
      }),
    },
    appointment: {
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: "apt-1", ...data };
      }),
    },
  };
  const stub = {} as any;
  const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  // Side effects after the insert are not what this spec is about.
  (service as any).sendAppointmentCreatedNotifications = jest.fn();
  (service as any).events = { recordOnce: jest.fn() };
  jest
    .spyOn(service, "getAvailableSlots")
    .mockImplementation(async () =>
      availableTimes.map((time) => ({ time, isAvailable: true })) as any,
    );
  return { service, created, clientLookups, prisma };
}

const BOOKING = {
  professionalId: PRO.id,
  serviceId: "svc",
  scheduledDate: "2026-09-29",
  scheduledTime: "10:00",
  clientInfo: { firstName: "Ana", lastName: "López", email: "ana@mail.test" },
};

describe("online booking", () => {
  it("books into the professional's salon, whatever tenantId the body claims", async () => {
    const { service, created } = build();

    await service.createOnline({ ...BOOKING, tenantId: "f6d06ea0-9bd8-490a-a704-e3bf95aad3ce" });

    expect(created[0].tenantId).toBe("tenant-b");
  });

  it("writes the real start instant the reminder jobs select on", async () => {
    // 10:00 in Madrid on 2026-09-29 (UTC+2) is 08:00 UTC. startTime was
    // never written, so no appointment ever got a reminder.
    const { service, created } = build();

    await service.createOnline(BOOKING);

    expect(created[0].startTime.toISOString()).toBe("2026-09-29T08:00:00.000Z");
  });

  it("finds a returning client within this salon only", async () => {
    // Ana is a client of salon A too. That used to derail the booking.
    const { service, created, clientLookups } = build({
      existingClients: [
        { id: "ana-at-a", email: "ana@mail.test", tenantId: "tenant-a" },
        { id: "ana-at-b", email: "ana@mail.test", tenantId: "tenant-b" },
      ],
    });

    await service.createOnline(BOOKING);

    expect(clientLookups[0]).toEqual({ email: "ana@mail.test", tenantId: "tenant-b" });
    expect(created[0].clientId).toBe("ana-at-b");
  });

  it("creates the client in this salon when they are only known elsewhere", async () => {
    const { service, created, prisma } = build({
      existingClients: [{ id: "ana-at-a", email: "ana@mail.test", tenantId: "tenant-a" }],
    });

    await service.createOnline(BOOKING);

    expect(prisma.client.create.mock.calls[0][0].data.tenantId).toBe("tenant-b");
    expect(created[0]).toMatchObject({ tenantId: "tenant-b", clientId: "client-new" });
  });

  it("refuses a slot getAvailableSlots does not offer", async () => {
    // Taken, off shift, or at 03:00: all of them are simply not offered.
    const { service, created } = build({ availableTimes: ["11:00"] });

    await expect(service.createOnline(BOOKING)).rejects.toThrow(ConflictException);
    expect(created).toHaveLength(0);
  });

  it("refuses a client id from another salon", async () => {
    const { service, created } = build({
      existingClients: [{ id: "ana-at-a", email: "ana@mail.test", tenantId: "tenant-a" }],
    });

    await expect(
      service.createOnline({ ...BOOKING, clientInfo: undefined, clientId: "ana-at-a" }),
    ).rejects.toThrow(NotFoundException);
    expect(created).toHaveLength(0);
  });
});

describe("staff booking", () => {
  it("books into the staff member's own salon", async () => {
    const { service, created } = build({
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await service.createByStaff(
      { ...BOOKING, clientInfo: undefined, clientId: "c1", tenantId: "default" },
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );

    expect(created[0].tenantId).toBe("tenant-b");
  });

  it("does not require the slot to be free: staff may book over the grid", async () => {
    // A deliberate difference: the salon can squeeze someone in by hand.
    const { service, created } = build({
      availableTimes: [],
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await service.createByStaff(
      { ...BOOKING, clientInfo: undefined, clientId: "c1" },
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );

    expect(created).toHaveLength(1);
  });
});
