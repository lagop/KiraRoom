import { AppointmentsService } from "../appointments/appointments.service";
import { bookingPlace, clientLocations, formatLocationAddress, professionalLocationsOf } from "./client-locations";

/**
 * The salon's locations as clients see them (multi-local): which count as a
 * choice, where each professional works, and the place an appointment's
 * emails name.
 */

const CENTRO = { id: "l-centro", name: "Centro", slug: "centro", street: "Calle Mayor 1", city: "Madrid", state: "Madrid", postalCode: "28013", phone: "910000001" };
const NORTE = { id: "l-norte", name: "Norte", slug: "norte", street: "Av. Norte 5", city: "Madrid", state: "Madrid", postalCode: "28035", phone: null };
const SUR = { id: "l-sur", name: "Sur", slug: "sur", street: null, city: "Getafe", state: "Madrid", postalCode: null, phone: null };

function db(locations: any[], links: any[]) {
  return {
    location: { findMany: jest.fn(async () => locations) },
    professionalLocation: { findMany: jest.fn(async () => links) },
  };
}

describe("clientLocations", () => {
  it("two or more open locations with someone to book: all of them, with who works there", async () => {
    const out = await clientLocations(
      db([CENTRO, NORTE], [
        { professionalId: "ana", locationId: "l-centro", isPrimary: true },
        { professionalId: "ana", locationId: "l-norte", isPrimary: false },
        { professionalId: "bea", locationId: "l-norte", isPrimary: true },
      ]),
      "t1",
    );
    expect(out.locations.map((l) => [l.id, l.professionalIds])).toEqual([
      ["l-centro", ["ana"]],
      ["l-norte", ["ana", "bea"]],
    ]);
  });

  it("one location, or a second one nobody works at: no choice", async () => {
    expect((await clientLocations(db([CENTRO], [{ professionalId: "ana", locationId: "l-centro", isPrimary: true }]), "t1")).locations).toEqual([]);
    const lonely = await clientLocations(
      db([CENTRO, NORTE, SUR], [{ professionalId: "ana", locationId: "l-centro", isPrimary: true }]),
      "t1",
    );
    expect(lonely).toEqual({ locations: [], links: [] });
  });

  it("a location with nobody is left out of a real choice", async () => {
    const out = await clientLocations(
      db([CENTRO, NORTE, SUR], [
        { professionalId: "ana", locationId: "l-centro", isPrimary: true },
        { professionalId: "bea", locationId: "l-norte", isPrimary: true },
      ]),
      "t1",
    );
    expect(out.locations.map((l) => l.id)).toEqual(["l-centro", "l-norte"]);
  });

  it("reads only the salon's open locations and its active professionals' links", async () => {
    const d = db([], []);
    await clientLocations(d, "t1");
    expect((d.location.findMany.mock.calls[0] as any[])[0].where).toEqual({ tenantId: "t1", isActive: true });
    expect((d.professionalLocation.findMany.mock.calls[0] as any[])[0].where).toEqual({
      location: { tenantId: "t1", isActive: true },
      professional: { tenantId: "t1", isActive: true },
    });
  });
});

describe("professionalLocationsOf", () => {
  const locations = [CENTRO, NORTE];
  const links = [
    { professionalId: "ana", locationId: "l-norte", isPrimary: true },
    { professionalId: "ana", locationId: "l-centro", isPrimary: false },
    { professionalId: "bea", locationId: "l-sur", isPrimary: true },
  ];
  it("their locations in the order shown, and their main one", () => {
    expect(professionalLocationsOf("ana", locations, links)).toEqual({ locationIds: ["l-centro", "l-norte"], primaryLocationId: "l-norte" });
  });
  it("a professional whose locations are not offered: none", () => {
    expect(professionalLocationsOf("bea", locations, links)).toEqual({ locationIds: [], primaryLocationId: null });
  });
});

describe("formatLocationAddress", () => {
  it("the parts that exist, the state only when it is not the city", () => {
    expect(formatLocationAddress(CENTRO)).toBe("Calle Mayor 1, 28013 Madrid");
    expect(formatLocationAddress(SUR)).toBe("Getafe, Madrid");
    expect(formatLocationAddress({ street: null, city: null, state: null, postalCode: null })).toBe("");
  });
});

describe("bookingPlace", () => {
  it("the appointment's location when the salon has two or more open ones", async () => {
    expect(await bookingPlace(db([CENTRO, NORTE], []), "t1", "l-centro")).toEqual({
      name: "Centro",
      address: "Calle Mayor 1, 28013 Madrid",
      phone: "910000001",
    });
  });
  it("nothing for a salon with one, an appointment without one, or a closed one", async () => {
    expect(await bookingPlace(db([CENTRO], []), "t1", "l-centro")).toBeNull();
    expect(await bookingPlace(db([CENTRO, NORTE], []), "t1", null)).toBeNull();
    expect(await bookingPlace(db([CENTRO, NORTE], []), "t1", "l-sur")).toBeNull();
  });
});

describe("GET /appointments/booking-locations (the panel's picker)", () => {
  const svc = (locations: any[], links: any[]) =>
    new AppointmentsService(db(locations, links) as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

  it("the locations with their address, and where each professional works", async () => {
    const out = await svc([CENTRO, NORTE], [
      { professionalId: "ana", locationId: "l-centro", isPrimary: true },
      { professionalId: "ana", locationId: "l-norte", isPrimary: false },
      { professionalId: "bea", locationId: "l-norte", isPrimary: true },
    ]).bookingLocations("t1");
    expect(out.locations).toEqual([
      { id: "l-centro", name: "Centro", slug: "centro", address: "Calle Mayor 1, 28013 Madrid", phone: "910000001" },
      { id: "l-norte", name: "Norte", slug: "norte", address: "Av. Norte 5, 28035 Madrid", phone: null },
    ]);
    expect(out.professionals).toEqual([
      { id: "ana", locationIds: ["l-centro", "l-norte"], primaryLocationId: "l-centro" },
      { id: "bea", locationIds: ["l-norte"], primaryLocationId: "l-norte" },
    ]);
  });

  it("a salon with one location gets nothing: the panel books as before", async () => {
    const out = await svc([CENTRO], [{ professionalId: "ana", locationId: "l-centro", isPrimary: true }]).bookingLocations("t1");
    expect(out).toEqual({ locations: [], professionals: [] });
  });
});

describe("the booking confirmation email", () => {
  function send(locations: any[], appointmentLocation: string | null) {
    const prisma: any = { location: { findMany: jest.fn(async () => locations) } };
    const email = { sendAppointmentConfirmation: jest.fn(async () => ({ success: true })) };
    const sms = { sendAppointmentConfirmation: jest.fn(async () => ({ success: true })) };
    const notifications = { shouldSendNotification: jest.fn(async (_c: string, _t: string, ch: string) => ch === "email") };
    const stub = {} as any;
    const svc = new AppointmentsService(prisma, stub, notifications as any, email as any, sms as any, stub, stub, stub);
    const appointment = {
      id: "apt-1",
      tenantId: "t1",
      clientId: "c1",
      locationId: appointmentLocation,
      scheduledDate: new Date("2026-11-09T00:00:00.000Z"),
      scheduledTime: "10:00",
      client: { firstName: "Lucía", lastName: "Pérez", email: "lucia@mail.test", phone: null },
      professional: { firstName: "Ana", lastName: "Martínez" },
      service: { name: "Corte" },
      tenant: { name: "Salón Luna", language: "es" },
    };
    return (svc as any).sendAppointmentCreatedNotifications(appointment).then(() => email.sendAppointmentConfirmation.mock.calls[0]);
  }

  it("at one of several locations: names it and gives its address", async () => {
    const [data] = (await send([CENTRO, NORTE], "l-norte")) as any[];
    expect(data).toMatchObject({ locationName: "Norte", salonAddress: "Av. Norte 5, 28035 Madrid", salonName: "Salón Luna" });
  });

  it("a salon with one location: as before, no location", async () => {
    const [data] = (await send([CENTRO], "l-centro")) as any[];
    expect(data).not.toHaveProperty("locationName");
    expect(data).not.toHaveProperty("salonAddress");
  });
});
