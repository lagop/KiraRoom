import { NotFoundException } from "@nestjs/common";
import { AppointmentsService, asSeenBy, staffAgendaWhere } from "./appointments.service";
import { VISIT_LINE_PROFESSIONAL } from "./appointment-response";

/**
 * A professional's agenda (role staff) in a visit shared with a colleague.
 *
 * - The salon books "corte con Ana + color con Marta": Ana is the
 *   appointment's professional, Marta is on the colour's row only. Marta's
 *   calendar (GET /appointments), her pending payments and the appointment
 *   itself left the colour out. They now show her the colleagues' visits
 *   where she does a service; she reads them, and acts only on her own.
 * - The services of a visit carried their professional whole: a calendar
 *   received the colleague's commission rate, personal email and phone,
 *   hire and termination dates. A service's professional is now its name
 *   and photo, and so is the appointment's professional when it is a
 *   colleague's.
 * - A professional moved one of their appointments to another client and
 *   that client became "theirs" (her whole file opened): staff can no
 *   longer change the client of an appointment.
 */

const TENANT = "t1";
const DAY = new Date("2030-11-04T00:00:00.000Z");
const ANA = { id: "u-ana", role: "staff", tenantId: TENANT };
const MARTA = { id: "u-marta", role: "staff", tenantId: TENANT };
const NOBODY = { id: "u-nobody", role: "staff", tenantId: TENANT };
const OWNER = { id: "u-owner", role: "owner", tenantId: TENANT };

const PROFESSIONALS = [
  { id: "ana", userId: "u-ana", tenantId: TENANT },
  { id: "marta", userId: "u-marta", tenantId: TENANT },
];

/** Ana's whole record, as `professional: true` reads it. */
const anaRecord = () => ({
  id: "ana",
  firstName: "Ana",
  lastName: "López",
  profileImage: "ana.jpg",
  email: "ana@personal.test",
  phone: "600000001",
  commissionRate: 40,
  hireDate: new Date("2024-01-01"),
  settings: { anything: true },
});

/** Ana's cut and Marta's colour, Ana's appointment; and one of Ana's alone. */
const APPOINTMENTS = () => [
  {
    id: "shared",
    tenantId: TENANT,
    clientId: "c-lucia",
    professionalId: "ana",
    scheduledDate: DAY,
    scheduledTime: "10:00",
    status: "confirmed",
    paymentStatus: "pending",
    professional: anaRecord(),
    tenant: { timezone: "Europe/Madrid" },
    services: [
      { id: "r-cut", professionalId: "ana", order: 0, service: { name: "Corte" } },
      { id: "r-colour", professionalId: "marta", order: 1, service: { name: "Color" } },
    ],
  },
  {
    id: "ana-only",
    tenantId: TENANT,
    clientId: "c-rosa",
    professionalId: "ana",
    scheduledDate: DAY,
    scheduledTime: "12:00",
    status: "confirmed",
    paymentStatus: "pending",
    professional: anaRecord(),
    tenant: { timezone: "Europe/Madrid" },
    services: [],
  },
];

/** Enough of Prisma's appointment where: tenant, professional, OR and services.some. */
function matches(apt: any, where: any): boolean {
  if (where.tenantId && apt.tenantId !== where.tenantId) return false;
  if (where.id && apt.id !== where.id) return false;
  if (typeof where.professionalId === "string" && apt.professionalId !== where.professionalId) return false;
  if (where.OR && !where.OR.some((w: any) => matches(apt, w))) return false;
  const some = where.services?.some;
  if (some && !(apt.services ?? []).some((s: any) => s.professionalId === some.professionalId)) return false;
  return true;
}

function harness() {
  const appointments = APPOINTMENTS();
  const writes: any[] = [];
  const prisma: any = {
    professional: {
      findFirst: jest.fn(async ({ where }: any) =>
        PROFESSIONALS.find((p) => p.userId === where.userId && p.tenantId === where.tenantId) ?? null,
      ),
      count: jest.fn(async ({ where }: any) => where.id.in.length),
    },
    client: { count: jest.fn(async ({ where }: any) => where.id.in.length) },
    service: { count: jest.fn(async ({ where }: any) => where.id.in.length) },
    tenant: { findUnique: jest.fn(async () => null) },
    appointment: {
      findMany: jest.fn(async ({ where }: any) => appointments.filter((a) => matches(a, where))),
      findUnique: jest.fn(async ({ where }: any) => appointments.find((a) => matches(a, where)) ?? null),
      update: jest.fn(async (args: any) => {
        writes.push(args);
        return { ...appointments.find((a) => a.id === args.where.id), ...args.data };
      }),
    },
  };
  const stub = {} as any;
  const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub);
  (svc as any).logAppointmentActivity = jest.fn();
  return { svc, prisma, writes };
}

describe("a professional's agenda includes the services they do in a colleague's visit", () => {
  it("the filter: their appointments, or a service of theirs in one", () => {
    expect(staffAgendaWhere("marta")).toEqual({
      OR: [{ professionalId: "marta" }, { services: { some: { professionalId: "marta" } } }],
    });
  });

  it("GET /appointments: Marta sees Ana's visit with her colour in it, not Ana's other appointments", async () => {
    const { svc, prisma } = harness();
    const out = await svc.findAll(MARTA, {} as any);
    expect(out.map((a: any) => a.id)).toEqual(["shared"]);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(staffAgendaWhere("marta").OR);
    expect(where.professionalId).toBeUndefined();
  });

  it("a professionalId in the query does not widen it", async () => {
    const { svc, prisma } = harness();
    await svc.findAll(MARTA, { professionalId: "ana" } as any);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.professionalId).toBeUndefined();
    expect(where.OR).toEqual(staffAgendaWhere("marta").OR);
  });

  it("Ana still sees both of hers; an unlinked account sees nothing; the owner, the salon", async () => {
    const { svc } = harness();
    expect((await svc.findAll(ANA, {} as any)).map((a: any) => a.id).sort()).toEqual(["ana-only", "shared"]);
    expect(await svc.findAll(NOBODY, {} as any)).toEqual([]);
    expect((await svc.findAll(OWNER, {} as any)).length).toBe(2);
  });

  it("pending payment follows the same agenda", async () => {
    const { svc, prisma } = harness();
    await svc.findPendingPayment(MARTA, {});
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(staffAgendaWhere("marta").OR);
    expect(where.professionalId).toBeUndefined();
    expect(await svc.findPendingPayment(NOBODY, {})).toEqual([]);
  });
});

describe("a colleague's visit is read only, and shows the colleague's name, not their record", () => {
  it("GET /appointments/:id: Marta reads Ana's visit where she does the colour", async () => {
    const { svc } = harness();
    const shown = await svc.findOne(MARTA, "shared", "read");
    expect(shown.id).toBe("shared");
    expect(shown.professional).toEqual({ id: "ana", firstName: "Ana", lastName: "López", profileImage: "ana.jpg" });
  });

  it("but not an appointment of Ana's she has no part in", async () => {
    const { svc } = harness();
    await expect(svc.findOne(MARTA, "ana-only", "read")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("every other use of findOne (edit, status, move, delete) is for her own appointments only", async () => {
    const { svc, prisma } = harness();
    await expect(svc.findOne(MARTA, "shared")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update(MARTA, "shared", { notes: "x" } as any)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel(MARTA, "shared")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("Ana and the owner get Ana's record whole", async () => {
    const { svc } = harness();
    expect((await svc.findOne(ANA, "shared", "read")).professional.commissionRate).toBe(40);
    expect((await svc.findOne(OWNER, "shared", "read")).professional.email).toBe("ana@personal.test");
  });

  it("asSeenBy leaves the managers' view and the professional's own appointments alone", () => {
    const apt = { professionalId: "ana", professional: anaRecord() };
    expect(asSeenBy(apt, null)).toBe(apt);
    expect(asSeenBy(apt, "ana")).toBe(apt);
    expect(asSeenBy(apt, "marta").professional).toEqual({
      id: "ana",
      firstName: "Ana",
      lastName: "López",
      profileImage: "ana.jpg",
    });
  });

  it("the services of a visit carry their professional's name and photo only, in the list, the detail and an edit", async () => {
    const { svc, prisma } = harness();
    await svc.findAll(OWNER, {} as any);
    await svc.findOne(OWNER, "shared");
    for (const call of [prisma.appointment.findMany.mock.calls[0][0], prisma.appointment.findUnique.mock.calls[0][0]]) {
      expect(call.include.services.include.professional).toEqual(VISIT_LINE_PROFESSIONAL);
    }
    expect(VISIT_LINE_PROFESSIONAL).toEqual({
      select: { id: true, firstName: true, lastName: true, profileImage: true },
    });
  });
});

describe("a professional cannot change the client of an appointment", () => {
  it("the client sent by staff is dropped, as the professional is", async () => {
    const { svc, writes } = harness();
    await svc.update(ANA, "ana-only", { notes: "Trae su tinte", clientId: "c-lucia", professionalId: "marta" } as any);
    const data = writes[writes.length - 1].data;
    expect(data.notes).toBe("Trae su tinte");
    expect(data).not.toHaveProperty("clientId");
    expect(data).not.toHaveProperty("professionalId");
  });

  it("the owner still can", async () => {
    const { svc, writes } = harness();
    await svc.update(OWNER, "ana-only", { notes: "x", clientId: "c-lucia" } as any);
    expect(writes[writes.length - 1].data.clientId).toBe("c-lucia");
  });
});
