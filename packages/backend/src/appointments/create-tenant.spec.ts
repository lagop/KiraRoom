import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppointmentsService } from "./appointments.service";
import { OnlineBookingDto, StaffBookingDto } from "./dto/book-appointment.dto";
import { phoneKey } from "../common/phone";

/**
 * Who decides an appointment's salon, and whether its slot is real.
 *
 * `create` took `tenantId` from the body, and every caller sent something
 * different: 'default', '1', a hardcoded salon UUID from the calendar. It
 * looked the client up by email across every salon, so a client of salon A
 * booking on salon B's site was matched to their A record, the tenant
 * switched to A, and B's professional was then "not found". And the public
 * route checked nothing about the slot: a direct POST could book 03:00, a
 * past day, or a slot already taken.
 */

const PRO = { id: "11111111-1111-4111-8111-111111111111", tenantId: "tenant-b", firstName: "Ana" };
const PRO_2 = { id: "22222222-2222-4222-8222-222222222222", tenantId: "tenant-b", firstName: "Bea" };
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";
const WIDGET_ID = "44444444-4444-4444-8444-444444444444";

/** A YYYY-MM-DD this many days from today. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function build({
  existingClients = [] as Array<{ id: string; email?: string | null; phone?: string | null; tenantId: string }>,
  freeTimes = { [PRO.id]: ["10:00"], [PRO_2.id]: ["10:00"] } as Record<string, string[]>,
  offering = [PRO.id, PRO_2.id],
  widgetProfessionals = [] as string[],
  minAdvanceBooking = 2,
  maxAdvanceBooking = 30,
  locationLinks = [] as Array<{ professionalId: string; locationId: string; isPrimary: boolean }>,
} = {}) {
  const clientLookups: any[] = [];
  const created: any[] = [];
  const locks: string[] = [];
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) =>
      fn({ $executeRaw: async (_s: TemplateStringsArray, key: string) => { locks.push(key); return 0; } }),
    ),
    tenant: { findUnique: async () => ({ timezone: "Europe/Madrid", country: "ES" }) },
    // findOrCreateClient's phone lookup: tenant and last nine digits.
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, tenantId: string, key: string) =>
      existingClients
        .filter((c) => c.tenantId === tenantId && phoneKey(c.phone) === key)
        .slice(0, 1)
        .map((c) => ({ id: c.id })),
    ),
    widgetInstance: {
      findUnique: async ({ where }: any) =>
        where.id === WIDGET_ID ? { tenantId: "tenant-b", professionals: widgetProfessionals } : null,
    },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => {
        const all = [PRO, PRO_2];
        return all.find((p) => p.id === where.id && (!where.tenantId || where.tenantId === p.tenantId)) ?? null;
      }),
      findMany: async ({ where }: any) =>
        [PRO, PRO_2]
          .filter((p) => !where.id?.in || where.id.in.includes(p.id))
          .map((p) => ({ id: p.id, services: offering.includes(p.id) ? [{ serviceId: SERVICE_ID }] : [] })),
    },
    // Where each professional works (active locations of the salon only).
    professionalLocation: {
      findMany: jest.fn(async ({ where }: any) =>
        where.location?.tenantId === "tenant-b"
          ? locationLinks.filter((l) => l.professionalId === where.professionalId)
          : [],
      ),
    },
    service: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === "tenant-b"
          ? { id: SERVICE_ID, duration: 30, price: 20, currency: "EUR", minAdvanceBooking, maxAdvanceBooking }
          : null,
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
      update: jest.fn(async ({ where, data }: any) => {
        const row = existingClients.find((c) => c.id === where.id)!;
        Object.assign(row, data);
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
  jest.spyOn(service, "getAvailableSlots").mockImplementation(async (_t, _d, professionalId?: string) =>
    (freeTimes[professionalId ?? ""] ?? []).map((time) => ({ time, isAvailable: true })) as any,
  );
  return { service, created, clientLookups, prisma, locks };
}

const BOOKING = {
  professionalId: PRO.id,
  serviceId: SERVICE_ID,
  scheduledDate: day(3),
  scheduledTime: "10:00",
  clientInfo: { firstName: "Ana", lastName: "López", email: "ana@mail.test", phone: "600 111 222" },
};

describe("online booking: who and where", () => {
  it("books into the professional's salon, whatever tenantId the body claims", async () => {
    const { service, created } = build();

    await service.createOnline({ ...BOOKING, tenantId: "f6d06ea0-9bd8-490a-a704-e3bf95aad3ce" } as any);

    expect(created[0].tenantId).toBe("tenant-b");
  });

  it("writes the real start instant the reminder jobs select on", async () => {
    // Through the staff path, which has no booking window, so the date can be
    // fixed: 10:00 in Madrid on 2026-12-01 (UTC+1) is 09:00 UTC.
    const { service, created } = build({
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await service.createByStaff(
      { ...BOOKING, scheduledDate: "2026-12-01", clientInfo: undefined, clientId: "c1" } as any,
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );

    expect(created[0].startTime.toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });

  it("finds a returning client within this salon only", async () => {
    const { service, created, clientLookups } = build({
      existingClients: [
        { id: "ana-at-a", email: "ana@mail.test", tenantId: "tenant-a" },
        { id: "ana-at-b", email: "ana@mail.test", tenantId: "tenant-b" },
      ],
    });

    await service.createOnline(BOOKING as any);

    expect(clientLookups[0]).toEqual({ email: "ana@mail.test", tenantId: "tenant-b" });
    expect(created[0].clientId).toBe("ana-at-b");
  });

  it("creates the client in this salon when they are only known elsewhere", async () => {
    const { service, created, prisma } = build({
      existingClients: [{ id: "ana-at-a", email: "ana@mail.test", tenantId: "tenant-a" }],
    });

    await service.createOnline(BOOKING as any);

    expect(prisma.client.create.mock.calls[0][0].data.tenantId).toBe("tenant-b");
    expect(created[0]).toMatchObject({ tenantId: "tenant-b", clientId: "client-new" });
  });

  it("finds a returning client by phone when they give no email", async () => {
    // The phone is required online and the email optional; the same number
    // typed another way is the same client.
    const { service, created, prisma } = build({
      existingClients: [{ id: "ana-at-b", email: null, phone: "+34 600-111-222", tenantId: "tenant-b" }],
    });

    await service.createOnline({ ...BOOKING, clientInfo: { firstName: "Ana", lastName: "López", phone: "600111222" } } as any);

    expect(created[0].clientId).toBe("ana-at-b");
    expect(prisma.client.create).not.toHaveBeenCalled();
  });

  it("fills in the email of a client found by phone, and never overwrites one", async () => {
    const { service, prisma } = build({
      existingClients: [
        { id: "no-email", email: null, phone: "600111222", tenantId: "tenant-b" },
        { id: "has-email", email: "old@mail.test", phone: "611222333", tenantId: "tenant-b" },
      ],
    });

    await service.createOnline(BOOKING as any);
    await service.createOnline({ ...BOOKING, clientInfo: { firstName: "B", lastName: "C", email: "new@mail.test", phone: "611 222 333" } } as any);

    expect(prisma.client.update.mock.calls).toEqual([[{ where: { id: "no-email" }, data: { email: "ana@mail.test" } }]]);
  });

  it("stores a new client's phone in international form", async () => {
    const { service, prisma } = build();

    await service.createOnline({ ...BOOKING, clientInfo: { firstName: "Ana", lastName: "López", phone: "600 111 222" } } as any);

    expect(prisma.client.create.mock.calls[0][0].data).toMatchObject({ phone: "+34600111222", email: null });
  });

  it("never matches a client on neither email nor phone", async () => {
    // Prisma drops an undefined filter: this matched the salon's first client.
    const { service, created } = build({
      existingClients: [{ id: "someone", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await expect(
      service.createOnline({ ...BOOKING, clientInfo: { firstName: "Ana", lastName: "" } } as any),
    ).rejects.toThrow(BadRequestException);
    expect(created).toHaveLength(0);
  });

  it("does not create a client when the booking fails on the service", async () => {
    const { service, prisma } = build();
    prisma.service.findFirst.mockResolvedValue(null);

    await expect(service.createOnline(BOOKING as any)).rejects.toThrow(NotFoundException);
    expect(prisma.client.create).not.toHaveBeenCalled();
  });
});

describe("online booking: the slot", () => {
  it("refuses a slot getAvailableSlots does not offer", async () => {
    const { service, created } = build({ freeTimes: { [PRO.id]: ["11:00"] } });

    await expect(service.createOnline(BOOKING as any)).rejects.toThrow(ConflictException);
    expect(created).toHaveLength(0);
  });

  it("refuses the past and the service's minimum notice", async () => {
    const { service, created } = build();

    await expect(service.createOnline({ ...BOOKING, scheduledDate: day(-1) } as any)).rejects.toThrow(
      ConflictException,
    );
    expect(created).toHaveLength(0);
  });

  it("refuses beyond the service's maximum advance", async () => {
    const { service } = build({ maxAdvanceBooking: 30 });

    await expect(service.createOnline({ ...BOOKING, scheduledDate: day(60) } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("checks and inserts under a per-salon, per-day lock", async () => {
    const { service, locks, prisma } = build();

    await service.createOnline(BOOKING as any);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(locks).toEqual([`booking:tenant-b:${BOOKING.scheduledDate}`]);
  });
});

describe("the widget's 'any professional'", () => {
  it("assigns the first professional who offers the service and is free", async () => {
    const { service, created } = build({ freeTimes: { [PRO.id]: [], [PRO_2.id]: ["10:00"] } });

    await service.createOnline({ ...BOOKING, professionalId: "", widgetInstanceId: WIDGET_ID } as any);

    expect(created[0]).toMatchObject({ tenantId: "tenant-b", professionalId: PRO_2.id });
  });

  it("only considers the widget's own professionals when it lists some", async () => {
    const { service } = build({ widgetProfessionals: [PRO.id], freeTimes: { [PRO.id]: [], [PRO_2.id]: ["10:00"] } });

    await expect(
      service.createOnline({ ...BOOKING, professionalId: "", widgetInstanceId: WIDGET_ID } as any),
    ).rejects.toThrow(ConflictException);
  });

  it("needs the widget to know which salon", async () => {
    const { service } = build();
    await expect(service.createOnline({ ...BOOKING, professionalId: "" } as any)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("staff booking", () => {
  it("books into the staff member's own salon", async () => {
    const { service, created } = build({
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await service.createByStaff(
      { ...BOOKING, clientInfo: undefined, clientId: "c1", tenantId: "default" } as any,
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );

    expect(created[0].tenantId).toBe("tenant-b");
  });

  it("does not require the slot to be free: staff may book over the grid", async () => {
    // A deliberate difference: the salon can squeeze someone in by hand.
    const { service, created } = build({
      freeTimes: {},
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
    });

    await service.createByStaff(
      { ...BOOKING, clientInfo: undefined, clientId: "c1" } as any,
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );

    expect(created).toHaveLength(1);
  });
});

describe("request validation", () => {
  const errors = (cls: any, body: object) =>
    validateSync(plainToInstance(cls, body) as object, { whitelist: true }).map((e) => e.property).sort();

  it("accepts what the public site and widget send", () => {
    expect(errors(OnlineBookingDto, BOOKING)).toEqual([]);
    expect(errors(OnlineBookingDto, { ...BOOKING, professionalId: "", widgetInstanceId: WIDGET_ID, source: "widget" })).toEqual([]);
  });

  it("accepts a public booking without an email: the phone is what is required", () => {
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: { firstName: "A", lastName: "B", phone: "600111222" } })).toEqual([]);
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: { firstName: "A", lastName: "B", phone: "600111222", email: "" } })).toEqual([]);
  });

  it("rejects a public booking without a phone, a real date or a real time", () => {
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: { firstName: "A", lastName: "B", email: "a@mail.test" } })).toEqual(["clientInfo"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: { firstName: "A", lastName: "B", phone: "12345" } })).toEqual(["clientInfo"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: { firstName: "A", lastName: "B", phone: "600111222", email: "a@" } })).toEqual(["clientInfo"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, clientInfo: undefined })).toEqual(["clientInfo"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, scheduledDate: "tomorrow" })).toEqual(["scheduledDate"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, scheduledTime: "25:00" })).toEqual(["scheduledTime"]);
    expect(errors(OnlineBookingDto, { ...BOOKING, serviceId: undefined })).toEqual(["serviceId"]);
  });

  it("takes an email or a phone from staff", () => {
    const staff = (clientInfo: object) => errors(StaffBookingDto, { ...BOOKING, clientInfo });
    expect(staff({ firstName: "A", lastName: "B", email: "a@mail.test" })).toEqual([]);
    expect(staff({ firstName: "A", lastName: "B", phone: "600111222" })).toEqual([]);
    expect(staff({ firstName: "A", lastName: "B" })).toEqual(["clientInfo"]);
  });

  it("requires a client id or client details from staff", () => {
    expect(errors(StaffBookingDto, { ...BOOKING, clientInfo: undefined })).toEqual(["clientId"]);
    expect(errors(StaffBookingDto, { ...BOOKING, clientInfo: undefined, clientId: PRO.id })).toEqual([]);
  });
});

/**
 * appointments.locationId was never written by any booking, so the
 * multi-location report attributed every appointment by where its
 * professional works today. Every booking path (online, staff, receptionist)
 * goes through insertAppointment, which now stores it.
 */
describe("the appointment's location", () => {
  const LOC_A = "55555555-5555-4555-8555-555555555555";
  const LOC_B = "66666666-6666-4666-8666-666666666666";

  it("is the professional's only location", async () => {
    const { service, created } = build({ locationLinks: [{ professionalId: PRO.id, locationId: LOC_A, isPrimary: false }] });
    await service.createOnline(BOOKING as any);
    expect(created[0].locationId).toBe(LOC_A);
  });

  it("is the primary one when the professional works at several, also for staff bookings", async () => {
    const { service, created } = build({
      existingClients: [{ id: "c1", email: "x@mail.test", tenantId: "tenant-b" }],
      locationLinks: [
        { professionalId: PRO.id, locationId: LOC_A, isPrimary: false },
        { professionalId: PRO.id, locationId: LOC_B, isPrimary: true },
      ],
    });
    await service.createByStaff(
      { ...BOOKING, clientInfo: undefined, clientId: "c1" } as any,
      { id: "u1", role: "owner", tenantId: "tenant-b" },
    );
    expect(created[0].locationId).toBe(LOC_B);
  });

  it("stays empty when it is ambiguous or the salon has no locations", async () => {
    const several = build({
      locationLinks: [
        { professionalId: PRO.id, locationId: LOC_A, isPrimary: false },
        { professionalId: PRO.id, locationId: LOC_B, isPrimary: false },
      ],
    });
    await several.service.createOnline(BOOKING as any);
    expect(several.created[0].locationId).toBeNull();

    const none = build();
    await none.service.createOnline(BOOKING as any);
    expect(none.created[0].locationId).toBeNull();
  });
});
