import { NotFoundException } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";

/**
 * Availability at one of the salon's locations (multi-local).
 *
 * Ana works at the centre and at the beach, Bea at the beach only. Their
 * hours are theirs wherever they are (schedules are per professional), and
 * the overlap check is per professional over every location: Ana booked at
 * the centre at 10:00 is not free at the beach at 10:00.
 */

const TENANT = "t1";
const CENTRE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEACH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLOSED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MONDAY = "2030-11-04";
const HOURS = [{ day: "monday", openTime: "10:00", closeTime: "12:00" }];
const LINKS = [
  { professionalId: "ana", locationId: CENTRE, isPrimary: true },
  { professionalId: "ana", locationId: BEACH, isPrimary: false },
  { professionalId: "bea", locationId: BEACH, isPrimary: true },
];

function build(appointments: Array<{ professionalId: string; scheduledTime: string; duration: number; locationId?: string }> = []) {
  const pros = ["ana", "bea"].map((id) => ({ id, tenantId: TENANT, isActive: true, workingHours: HOURS, services: [] }));
  const prisma: any = {
    timeOff: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: jest.fn(async () => ({ id: TENANT, openingHours: {}, timezone: "Europe/Madrid" })) },
    professional: {
      findMany: jest.fn(async ({ where }: any) => pros.filter((p) => !where.id?.in || where.id.in.includes(p.id))),
    },
    service: { findFirst: jest.fn(async () => ({ id: "s1", tenantId: TENANT, duration: 60, bufferTime: 0 })) },
    location: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.tenantId === TENANT && [CENTRE, BEACH].includes(where.id) && where.isActive ? { id: where.id } : null,
      ),
    },
    professionalLocation: {
      findMany: jest.fn(async ({ where }: any) => LINKS.filter((l) => l.locationId === where.locationId)),
    },
    appointment: {
      // Every appointment of the day, wherever it is: the check is per professional.
      findMany: jest.fn(async ({ where }: any) => {
        const wanted: string[] | undefined = where.OR?.[0]?.professionalId?.in;
        return appointments
          .filter((a) => !wanted || wanted.includes(a.professionalId))
          .map((a, i) => ({ id: `apt-${i}`, status: "confirmed", services: [], service: { bufferTime: 0 }, ...a }));
      }),
    },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

const slots = async (svc: AppointmentsService, professionalId: string | undefined, locationId?: string) =>
  (await svc.getAvailableSlots(TENANT, new Date(`${MONDAY}T00:00:00.000Z`), professionalId, "s1", 60, undefined, { locationId })).map(
    (s: any) => s.time,
  );

describe("availability at a location", () => {
  it("any professional: only who works there", async () => {
    // Ana is busy all morning (at the centre); Bea is free but works at the beach only.
    const svc = build([{ professionalId: "ana", scheduledTime: "10:00", duration: 120, locationId: CENTRE }]);
    expect(await slots(svc, undefined, CENTRE)).toEqual([]);
    expect(await slots(svc, undefined, BEACH)).toEqual(["10:00", "10:30", "11:00"]);
    // Without a location, as before: anybody in the salon.
    expect(await slots(svc, undefined)).toEqual(["10:00", "10:30", "11:00"]);
  });

  it("a named professional has no slots at a location they do not work at", async () => {
    const svc = build();
    expect(await slots(svc, "bea", CENTRE)).toEqual([]);
    expect(await slots(svc, "bea", BEACH)).toEqual(["10:00", "10:30", "11:00"]);
  });

  it("never twice at once: Ana booked at the centre is busy at the beach too", async () => {
    const svc = build([{ professionalId: "ana", scheduledTime: "10:00", duration: 60, locationId: CENTRE }]);
    expect(await slots(svc, "ana", BEACH)).toEqual(["11:00"]);
  });

  it("a location that is closed or not the salon's has nothing (404)", async () => {
    await expect(slots(build(), undefined, CLOSED)).rejects.toThrow(NotFoundException);
  });
});
