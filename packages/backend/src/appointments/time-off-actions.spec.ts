import { NotFoundException } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";

/**
 * The actions on an appointment that approved time off or a closure caught
 * (Solicitudes de ausencia): who else is free to take it as it stands, so the
 * salon can pass it on. The move itself is the usual PATCH, checked again.
 *
 * Free means: active, does the appointment's services (a service nobody is
 * linked to is everyone's), works at its location (multi-local), and passes
 * the check a move does -- shifts, time off, the agenda.
 */

const TENANT = "t1";
const DAY = "2027-03-01"; // a Monday, ahead
const MONDAY_10_TO_18 = [{ day: "monday", openTime: "10:00", closeTime: "18:00" }];

interface Pro {
  id: string;
  firstName: string;
  services?: string[];
  workingHours?: unknown;
  locations?: string[];
}

function build(opts: {
  appointment?: Record<string, unknown> | null;
  team: Pro[];
  busy?: Array<{ professionalId: string; time: string; duration: number }>;
  timeOff?: Array<Record<string, unknown>>;
}) {
  const appointment =
    opts.appointment === null
      ? null
      : {
          id: "apt-1",
          tenantId: TENANT,
          professionalId: "ana",
          serviceId: "corte",
          status: "confirmed",
          scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
          scheduledTime: "11:00",
          duration: 60,
          locationId: null,
          tenant: { timezone: "UTC" },
          service: { bufferTime: 0 },
          services: [],
          ...opts.appointment,
        };
  const byId = new Map(opts.team.map((p) => [p.id, p]));
  const prisma: any = {
    appointment: {
      findFirst: jest.fn(async ({ where }: any) =>
        appointment && where.id === appointment.id && where.tenantId === TENANT ? appointment : null,
      ),
      // Another appointment of whoever is asked about, that day.
      findMany: jest.fn(async ({ where }: any) => {
        const who = where.OR[0].professionalId;
        return (opts.busy ?? [])
          .filter((b) => b.professionalId === who)
          .map((b) => ({
            professionalId: b.professionalId,
            scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
            scheduledTime: b.time,
            duration: b.duration,
            client: { firstName: "Otra", lastName: "Clienta" },
            service: { bufferTime: 0 },
            services: [],
          }));
      }),
    },
    professional: {
      findMany: jest.fn(async () =>
        opts.team.map((p) => ({
          id: p.id,
          firstName: p.firstName,
          lastName: "",
          services: (p.services ?? []).map((serviceId) => ({ serviceId })),
        })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const p = byId.get(where.id);
        return p ? { firstName: p.firstName, lastName: "", workingHours: p.workingHours ?? MONDAY_10_TO_18 } : null;
      }),
    },
    tenant: { findUnique: jest.fn(async () => ({ openingHours: {}, timezone: "UTC" })) },
    timeOff: {
      findMany: jest.fn(async () =>
        (opts.timeOff ?? []).map((t) => ({
          status: "approved",
          startDate: new Date(`${DAY}T00:00:00.000Z`),
          endDate: new Date(`${DAY}T00:00:00.000Z`),
          startTime: null,
          endTime: null,
          locationId: null,
          ...t,
        })),
      ),
    },
    location: { findFirst: jest.fn(async ({ where }: any) => ({ id: where.id })) },
    professionalLocation: {
      findMany: jest.fn(async ({ where }: any) =>
        opts.team.flatMap((p) =>
          (p.locations ?? []).filter((l) => l === where.locationId).map((l) => ({ professionalId: p.id, locationId: l })),
        ),
      ),
    },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub);
}

const OWNER = { id: "u1", role: "owner", tenantId: TENANT };
const names = async (svc: AppointmentsService) =>
  (await svc.freeProfessionalsFor(OWNER, "apt-1")).professionals.map((p) => p.name);

describe("who is free to take an appointment time off caught", () => {
  it("colleagues who do the service and are free then; not the one away, nor one busy", async () => {
    const svc = build({
      team: [
        { id: "ana", firstName: "Ana", services: ["corte"] },
        { id: "bea", firstName: "Bea", services: ["corte"] },
        { id: "carla", firstName: "Carla", services: ["corte"] },
        { id: "dani", firstName: "Dani", services: ["tinte"] },
      ],
      busy: [{ professionalId: "carla", time: "11:30", duration: 30 }],
    });
    expect(await names(svc)).toEqual(["Bea"]);
  });

  it("not a colleague away too, nor one whose shift does not cover it", async () => {
    const svc = build({
      team: [
        { id: "ana", firstName: "Ana" },
        { id: "bea", firstName: "Bea" },
        { id: "carla", firstName: "Carla", workingHours: [{ day: "monday", openTime: "15:00", closeTime: "20:00" }] },
        { id: "eva", firstName: "Eva" },
      ],
      timeOff: [{ professionalId: "bea", kind: "vacation" }],
    });
    // No service linked to anybody: everyone does it.
    expect(await names(svc)).toEqual(["Eva"]);
  });

  it("at a location (multi-local): only who works there", async () => {
    const svc = build({
      appointment: { locationId: "norte" },
      team: [
        { id: "ana", firstName: "Ana", locations: ["norte"] },
        { id: "bea", firstName: "Bea", locations: ["centro"] },
        { id: "eva", firstName: "Eva", locations: ["norte", "centro"] },
      ],
    });
    expect(await names(svc)).toEqual(["Eva"]);
  });

  it("a visit whose services each have their professional is moved from the agenda", async () => {
    const svc = build({
      appointment: { services: [{ professionalId: "bea", serviceId: "tinte", status: "active" }] },
      team: [{ id: "ana", firstName: "Ana" }, { id: "eva", firstName: "Eva" }],
    });
    expect(await svc.freeProfessionalsFor(OWNER, "apt-1")).toMatchObject({ reassignable: false, professionals: [] });
  });

  it("nothing for an appointment no longer booked, and a 404 for another salon's", async () => {
    const done = build({ appointment: { status: "cancelled" }, team: [{ id: "eva", firstName: "Eva" }] });
    expect(await done.freeProfessionalsFor(OWNER, "apt-1")).toMatchObject({ reassignable: false });
    const none = build({ appointment: null, team: [] });
    await expect(none.freeProfessionalsFor(OWNER, "apt-1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
