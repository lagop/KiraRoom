import * as ics from "ics";
import { IcsController, ICS_FUTURE_DAYS, ICS_PAST_DAYS, ICS_STATUSES, buildIcsEvents, icsWindow } from "./ics.controller";

/**
 * Calendar feeds (A1, A2, A12).
 *
 * - Every appointment went out at the wrong hour: the time was read in the
 *   server's zone (UTC in the container) and sent as UTC, so 10:00 in Madrid
 *   showed at 11:00 in winter and 12:00 in summer. The instant now comes from
 *   the salon's timezone and goes out in UTC.
 * - The feeds took the first 500/1000 rows from 30 days ago, oldest first:
 *   a busy salon's upcoming appointments fell off. They now take a date
 *   window, include pending online bookings as tentative and leave out
 *   cancelled ones.
 * - Deactivated professionals are no longer listed, and the feed is not
 *   cacheable by shared caches.
 */

const tenant = { id: "t1", slug: "salon-ana", name: "Salón Ana", timezone: "Europe/Madrid", street: "Calle Mayor 1", city: "Madrid", country: "ES" };

function appt(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    scheduledDate: new Date("2026-11-10T00:00:00.000Z"), // a @db.Date as Prisma returns it
    scheduledTime: "10:00",
    duration: 45,
    status: "confirmed",
    notes: null,
    client: { firstName: "Lucía" },
    service: { name: "Corte" },
    ...over,
  };
}

function ical(appointments: any[], t: any = tenant): string {
  const { error, value } = ics.createEvents(buildIcsEvents(appointments, t));
  expect(error).toBeFalsy();
  return value as string;
}

describe("ICS feed times are the salon's wall clock, sent in UTC (A1)", () => {
  it("10:00 in Madrid in winter (UTC+1) is 09:00Z", () => {
    const out = ical([appt()]);
    expect(out).toContain("DTSTART:20261110T090000Z");
    expect(out).toContain("DTEND:20261110T094500Z");
  });

  it("10:00 in Madrid in summer (UTC+2) is 08:00Z", () => {
    const out = ical([appt({ scheduledDate: new Date("2026-07-15T00:00:00.000Z") })]);
    expect(out).toContain("DTSTART:20260715T080000Z");
  });

  it("a Canary salon: 10:00 in summer (UTC+1) is 09:00Z", () => {
    const out = ical([appt({ scheduledDate: new Date("2026-07-15T00:00:00.000Z") })], { ...tenant, timezone: "Atlantic/Canary" });
    expect(out).toContain("DTSTART:20260715T090000Z");
  });

  it("a salon without a timezone is read as Madrid; a missing time as 09:00", () => {
    const out = ical([appt({ scheduledTime: null })], { ...tenant, timezone: null });
    expect(out).toContain("DTSTART:20261110T080000Z");
  });

  it("does not depend on the server's own zone", () => {
    const events = buildIcsEvents([appt()], tenant);
    expect(events[0]).toMatchObject({
      start: Date.UTC(2026, 10, 10, 9, 0),
      startInputType: "utc",
      startOutputType: "utc",
      endInputType: "utc",
      endOutputType: "utc",
    });
  });
});

describe("ICS feed contents (A2)", () => {
  it("a pending online booking is tentative and says so; a confirmed one is confirmed", () => {
    const [pending, confirmed] = buildIcsEvents([appt({ status: "pending" }), appt({ id: "a2" })], tenant);
    expect(pending).toMatchObject({ status: "TENTATIVE", title: "Por confirmar · Corte - Lucía" });
    expect(confirmed).toMatchObject({ status: "CONFIRMED", title: "Corte - Lucía" });
    expect(ical([appt({ status: "pending" })])).toContain("STATUS:TENTATIVE");
  });

  it("takes pending, confirmed, in progress and completed; never cancelled or no-shows", () => {
    expect([...ICS_STATUSES].sort()).toEqual(["completed", "confirmed", "in_progress", "pending"]);
    expect(ICS_STATUSES).not.toContain("cancelled" as any);
    expect(ICS_STATUSES).not.toContain("no_show" as any);
  });

  it("the window runs from 30 days before the salon's today to 180 after", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Madrid.
    const w = icsWindow("Europe/Madrid", new Date("2026-12-31T23:30:00Z"));
    expect(ICS_PAST_DAYS).toBe(30);
    expect(ICS_FUTURE_DAYS).toBe(180);
    expect(w.gte.toISOString()).toBe("2026-12-02T00:00:00.000Z");
    expect(w.lte.toISOString()).toBe("2027-06-30T00:00:00.000Z");
  });
});

describe("ICS feed privacy: the client's first name and the service, nothing else (A12)", () => {
  // What a full row would carry if the query ever asked for it again.
  const full = appt({
    notes: "Alérgica al amoniaco",
    internalNotes: "Debe 20 €",
    client: { firstName: "Lucía", lastName: "Gómez", phone: "+34600111222", email: "lucia@correo.test", notes: "Embarazada" },
  });

  it("no surname, phone, email or notes in the feed", () => {
    const out = ical([full]);
    expect(out).toContain("SUMMARY:Corte - Lucía");
    for (const secret of ["Gómez", "600111222", "lucia@correo.test", "amoniaco", "Debe 20", "Embarazada"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toMatch(/^DESCRIPTION:/m);
  });

  it("a client without a first name is 'Cliente'", () => {
    expect(buildIcsEvents([appt({ client: { firstName: " " } }), appt({ client: null })], tenant).map((e) => e.title)).toEqual([
      "Corte - Cliente",
      "Corte - Cliente",
    ]);
  });
});

describe("ICS feed endpoints", () => {
  const SECRET = "ics-secret";

  function build(appointments: any[] = []) {
    const findMany = jest.fn(async () => appointments);
    const professionals = jest.fn(async () => [{ id: "pro-1", firstName: "Ana", lastName: "López" }]);
    const prisma: any = {
      tenant: { findUnique: async () => ({ ...tenant, features: {} }) },
      professional: { findMany: professionals },
      appointment: { findMany },
    };
    const config: any = { get: (k: string) => (k === "ICS_TOKEN_SECRET" ? SECRET : undefined) };
    const c = new IcsController(prisma, config);
    const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, send: jest.fn(), status: jest.fn() };
    return { c, findMany, professionals, res };
  }

  it("the salon feed asks for the window and the statuses, not a row cap from the past", async () => {
    const { c, findMany, res } = build([appt()]);
    await c.salonFeed("salon-ana", IcsController.signToken("salon:salon-ana", SECRET), res);
    const args = (findMany.mock.calls[0] as any[])[0];
    expect(args.where).toMatchObject({
      tenantId: "t1",
      status: { in: ["pending", "confirmed", "in_progress", "completed"] },
      scheduledDate: { gte: expect.any(Date), lte: expect.any(Date) },
    });
    const days = (args.where.scheduledDate.lte - args.where.scheduledDate.gte) / 86_400_000;
    expect(days).toBe(ICS_PAST_DAYS + ICS_FUTURE_DAYS);
    // Only the first name and the service name are read from the database.
    expect(args.include).toEqual({ client: { select: { firstName: true } }, service: { select: { name: true } } });
    expect(res.send.mock.calls[0][0]).toContain("DTSTART:20261110T090000Z");
  });

  it("is sent as private, never stored by shared caches", async () => {
    const { c, res } = build([]);
    await c.salonFeed("salon-ana", IcsController.signToken("salon:salon-ana", SECRET), res);
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("the feed list offers only active professionals (A12)", async () => {
    const { c, professionals } = build();
    await c.tokens({ user: { tenantId: "t1" } });
    expect((professionals.mock.calls[0] as any[])[0].where).toEqual({ tenantId: "t1", isActive: true });
  });

  it("a professional's feed also has the services they do in a colleague's visit, as their part of it", async () => {
    // Ana's cut 10:00-10:30, then Marta's colour 10:30-11:30 (Madrid, UTC+1).
    const shared = appt({
      id: "shared",
      professionalId: "ana",
      duration: 90,
      services: [
        { professionalId: "marta", status: "pending", scheduledStart: new Date("2026-11-10T09:30:00.000Z"), scheduledEnd: new Date("2026-11-10T10:30:00.000Z"), service: { name: "Color" } },
      ],
    });
    const own = appt({ id: "own", professionalId: "marta", scheduledTime: "16:00" });
    const { c, findMany, res } = build([shared, own]);
    const prisma = (c as any).prisma;
    prisma.professional.findUnique = jest.fn(async () => ({
      id: "marta",
      tenantId: "t1",
      isActive: true,
      tenant: { ...tenant, features: {} },
    }));
    await c.professionalFeed("marta", IcsController.signToken("professional:marta", SECRET), res);

    const args = (findMany.mock.calls[0] as any[])[0];
    expect(args.where).toMatchObject({
      tenantId: "t1",
      OR: [
        { professionalId: "marta" },
        { services: { some: { professionalId: "marta", status: { not: "cancelled" } } } },
      ],
    });
    // Only her own rows are read, and still only the client's first name.
    expect(args.include.services.where).toEqual({ professionalId: "marta" });
    expect(args.include.client).toEqual({ select: { firstName: true } });

    const body: string = res.send.mock.calls[0][0];
    // The colour, at its own time, not Ana's cut at 10:00 for the whole visit.
    expect(body).toContain("SUMMARY:Color - Lucía");
    expect(body).toContain("DTSTART:20261110T093000Z");
    expect(body).toContain("DTEND:20261110T103000Z");
    expect(body).toContain("UID:shared-marta@salon-ana.kiraroom.app");
    // Her own appointment as before.
    expect(body).toContain("UID:own@salon-ana.kiraroom.app");
    expect(body).toContain("DTSTART:20261110T150000Z");
  });

  it("a colleague's visit whose rows carry no times shows as the whole visit", () => {
    const events = buildIcsEvents(
      [appt({ professionalId: "ana", services: [{ professionalId: "marta", status: "pending", scheduledStart: null, scheduledEnd: null }] })],
      tenant,
      "marta",
    );
    expect(events[0].title).toBe("Corte - Lucía");
    expect(events[0].end).toBe((events[0].start as number) + 45 * 60_000);
  });
});
