import { ConflictException, ForbiddenException } from "@nestjs/common";
import {
  changedServices,
  clientDoubleBooked,
  currentVisitSchedule,
  planRetime,
  planVisitMove,
  visitSpan,
  VisitService,
} from "./visit-move";
import { AppointmentsService } from "./appointments.service";

/**
 * A client's visit with several services and professionals. Moving one
 * service used to move only that one: she could be left waiting, or put in
 * two chairs at once, and the appointment's own time stayed the old one.
 */

const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00.000Z`); // UTC; Madrid is +1 in November

// Cut with Ana 09:00-09:30 UTC, then colour with Bea 09:30-10:30 UTC.
const visit: VisitService[] = [
  { id: "cut", professionalId: "ana", start: at("09:00"), end: at("09:30"), isParallel: false },
  { id: "colour", professionalId: "bea", start: at("09:30"), end: at("10:30"), isParallel: false },
];

describe("planning a move", () => {
  it("the whole visit shifts together, keeping its order and gaps", () => {
    const after = planVisitMove(visit, "cut", at("10:00"), "visit");
    expect(after.map((s) => [s.id, s.start.toISOString().slice(11, 16), s.end.toISOString().slice(11, 16)])).toEqual([
      ["cut", "10:00", "10:30"],
      ["colour", "10:30", "11:30"],
    ]);
  });

  it("only this service: the rest stays", () => {
    const after = planVisitMove(visit, "cut", at("08:00"), "service");
    expect(after[0].start).toEqual(at("08:00"));
    expect(after[1].start).toEqual(at("09:30"));
  });

  it("dropped on another column: only the dragged service changes professional", () => {
    const after = planVisitMove(visit, "cut", at("10:00"), "visit", "carla");
    expect(after.map((s) => s.professionalId)).toEqual(["carla", "bea"]);
  });

  it("the client in two services at once is detected; parallel ones may overlap", () => {
    expect(clientDoubleBooked(planVisitMove(visit, "cut", at("09:15"), "service"))?.map((s) => s.id)).toEqual(["cut", "colour"]);
    expect(clientDoubleBooked(visit)).toBeNull();
    const withParallel = visit.map((s) => (s.id === "colour" ? { ...s, isParallel: true } : s));
    expect(clientDoubleBooked(planVisitMove(withParallel, "cut", at("09:15"), "service"))).toBeNull();
  });

  it("the timing editor: later serial services follow on", () => {
    const after = planRetime(visit, "cut", at("09:00"), at("09:45"));
    expect(after[1].start).toEqual(at("09:45"));
    expect(after[1].end).toEqual(at("10:45"));
  });

  it("where services sit before any was moved: as the calendar draws them", () => {
    const now = currentVisitSchedule({
      appointmentStart: at("09:00"),
      appointmentProfessionalId: "ana",
      services: [
        { id: "cut", professionalId: null, scheduledStart: null, scheduledEnd: null, isParallel: false, durationMinutes: 30 },
        { id: "colour", professionalId: "bea", scheduledStart: null, scheduledEnd: null, isParallel: false, durationMinutes: 60 },
      ],
    });
    expect(now).toEqual(visit);
  });

  it("what changed, and the visit's span", () => {
    const after = planVisitMove(visit, "cut", at("08:00"), "service");
    expect(changedServices(visit, after).map((s) => s.id)).toEqual(["cut"]);
    expect(visitSpan(after)).toEqual({ start: at("08:00"), end: at("10:30") });
  });
});

/** A salon where Ana and Bea work Mondays 09:00-17:00 (Madrid), with one visit. */
function salon(opts: { busy?: Record<string, Array<{ scheduledTime: string; duration: number }>>; ownProfessional?: string } = {}) {
  const rows = [
    { id: "cut", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, service: { name: "Corte", duration: 30 } },
    { id: "colour", professionalId: "bea", scheduledStart: null, scheduledEnd: null, isParallel: false, service: { name: "Color", duration: 60 } },
  ];
  const appointment = {
    id: "a1",
    tenantId: "t1",
    professionalId: "ana",
    scheduledDate: new Date("2026-11-02T00:00:00.000Z"),
    scheduledTime: "10:00",
    duration: 90,
    startTime: at("09:00"),
    tenant: { timezone: "Europe/Madrid" },
    services: rows,
  };
  const updates: any[] = [];
  const tx = {
    appointmentService: { update: jest.fn(async (a: any) => updates.push(["service", a])) },
    appointment: { update: jest.fn(async (a: any) => (updates.push(["appointment", a]), { ...appointment, ...a.data })) },
  };
  const prisma: any = {
    appointmentService: { findUnique: jest.fn(async () => ({ appointmentId: "a1" })) },
    appointment: {
      findFirst: jest.fn(async () => appointment),
      // Whoever the reschedule check asks about: their appointments, or the
      // services they do in someone else's (where.OR).
      findMany: jest.fn(async (args: any) => {
        const pro = args.where.OR?.[0]?.professionalId ?? args.where.professionalId;
        return (opts.busy?.[pro] ?? []).map((b) => ({ professionalId: pro, ...b, client: null }));
      }),
    },
    tenant: { findUnique: jest.fn(async () => ({ openingHours: {}, timezone: "Europe/Madrid" })) },
    professional: {
      findFirst: jest.fn(async (args: any) =>
        args.where.userId
          ? opts.ownProfessional
            ? { id: opts.ownProfessional }
            : null
          : { firstName: args.where.id === "ana" ? "Ana" : "Bea", lastName: "", workingHours: [{ day: "monday", openTime: "09:00", closeTime: "17:00" }] },
      ),
    },
    $transaction: async (fn: any) => fn(tx),
  };
  const stub = {} as any;
  const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  const notify = jest.spyOn(svc as any, "sendAppointmentRescheduledNotifications").mockResolvedValue(undefined);
  return { svc, updates, notify };
}

const owner = { id: "u0", role: "owner", tenantId: "t1" };

describe("moving one service of a visit (PUT /appointment-services/:id/move)", () => {
  it("whole visit: both services move, the appointment's time follows and the client is told", async () => {
    const { svc, updates, notify } = salon();
    await svc.moveVisitService(owner, "cut", { scope: "visit", minutesDelta: 120 });
    const services = updates.filter(([k]) => k === "service").map(([, a]) => [a.where.id, a.data.scheduledStart.toISOString().slice(11, 16)]);
    expect(services).toEqual([
      ["cut", "11:00"],
      ["colour", "11:30"],
    ]);
    const [, appt] = updates.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ scheduledTime: "12:00", duration: 90, reminder24hSent: false, reminder1hSent: false });
    expect(notify).toHaveBeenCalled();
  });

  it("whole visit onto a busy colleague: refused, naming her", async () => {
    const { svc, updates } = salon({ busy: { bea: [{ scheduledTime: "13:00", duration: 60 }] } });
    const err = await svc.moveVisitService(owner, "cut", { scope: "visit", minutesDelta: 120 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/^Bea ya tiene una cita/);
    expect(updates).toHaveLength(0);
  });

  it("only this service, earlier: allowed for the owner (a wait agreed with the client)", async () => {
    const { svc, updates } = salon();
    await svc.moveVisitService(owner, "cut", { scope: "service", minutesDelta: -45 });
    expect(updates.filter(([k]) => k === "service").map(([, a]) => a.where.id)).toEqual(["cut"]);
    const [, appt] = updates.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ scheduledTime: "09:15", duration: 135 });
  });

  it("only this service, onto her other service: refused, she cannot be in two places", async () => {
    const { svc } = salon();
    const err = await svc.moveVisitService(owner, "cut", { scope: "service", minutesDelta: 15 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("La clienta estaría a la vez en Corte y Color.");
  });

  it("a professional cannot move a visit shared with a colleague", async () => {
    const { svc } = salon({ ownProfessional: "ana" });
    const err = await svc
      .moveVisitService({ id: "u1", role: "staff", tenantId: "t1" }, "cut", { scope: "visit", minutesDelta: 120 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toMatch(/varios profesionales/);
  });

  it("the timing editor keeps the appointment on the salon's clock (it used to save an ISO date)", async () => {
    const { svc, updates } = salon();
    await svc.retimeVisitService(owner, "cut", at("10:00"), at("10:30"));
    const [, appt] = updates.find(([k]) => k === "appointment");
    expect(appt.data.scheduledTime).toBe("11:00");
    expect(updates.filter(([k]) => k === "service").map(([, a]) => [a.where.id, a.data.scheduledStart.toISOString().slice(11, 16)])).toEqual([
      ["cut", "10:00"],
      ["colour", "10:30"],
    ]);
  });
});
