/**
 * The consolidated report summed payments "where appointment.locationId = X",
 * but nothing in the booking flow writes that column, so every location read
 * 0 €. Appointments are now attributed to the location they carry or, when
 * they carry none, to their professional's home location; whatever cannot be
 * attributed is shown apart, so the rows add up to the salon's total.
 */
import { AnalyticsAppointment } from "../analytics/analytics-metrics";
import { buildConsolidatedReport, homeLocations, locationOf } from "./consolidated-report";

const period = { start: "2026-09-28", end: "2026-10-02" }; // Monday to Friday

const apt = (over: Partial<AnalyticsAppointment>): AnalyticsAppointment => ({
  status: "completed",
  paymentStatus: "paid",
  totalAmount: 2000,
  scheduledDate: "2026-09-28",
  duration: 60,
  ...over,
});

describe("location attribution", () => {
  const active = new Set(["centro", "playa"]);

  it("uses the only active location, else the primary one, else none", () => {
    const homes = homeLocations(
      [
        { professionalId: "ana", locationId: "centro", isPrimary: false },
        { professionalId: "eva", locationId: "centro", isPrimary: false },
        { professionalId: "eva", locationId: "playa", isPrimary: true },
        { professionalId: "luz", locationId: "centro", isPrimary: false },
        { professionalId: "luz", locationId: "playa", isPrimary: false },
        { professionalId: "sol", locationId: "cerrado", isPrimary: true }, // inactive
      ],
      active,
    );
    expect(Object.fromEntries(homes)).toEqual({ ana: "centro", eva: "playa" });
  });

  it("prefers the appointment's own location", () => {
    const homes = new Map([["ana", "centro"]]);
    expect(locationOf({ locationId: "playa", professionalId: "ana" }, homes)).toBe("playa");
    expect(locationOf({ locationId: null, professionalId: "ana" }, homes)).toBe("centro");
    expect(locationOf({ locationId: null, professionalId: "luz" }, homes)).toBeNull();
  });
});

describe("buildConsolidatedReport", () => {
  const report = buildConsolidatedReport({
    period,
    locations: [
      { id: "centro", name: "Centro" },
      { id: "playa", name: "Playa" },
    ],
    professionals: [
      { id: "ana", workingHours: [{ day: "monday", openTime: "09:00", closeTime: "13:00" }] }, // 240 min
      { id: "eva", workingHours: [{ day: "friday", openTime: "10:00", closeTime: "18:00" }] }, // 480 min
      { id: "luz", workingHours: [] },
    ],
    links: [
      { professionalId: "ana", locationId: "centro", isPrimary: true },
      { professionalId: "eva", locationId: "playa", isPrimary: true },
    ],
    appointments: [
      apt({ professionalId: "ana", clientId: "c1", serviceId: "s1", service: { name: "Corte" } }),
      apt({ professionalId: "ana", clientId: "c1", serviceId: "s2", service: { name: "Color" }, totalAmount: 6000, duration: 120 }),
      apt({ professionalId: "ana", clientId: "c2", status: "cancelled", totalAmount: 9999 }),
      apt({ professionalId: "eva", clientId: "c3", serviceId: "s1", service: { name: "Corte" }, scheduledDate: "2026-10-02", status: "confirmed", paymentStatus: "pending", duration: 120 }),
      apt({ professionalId: "ana", locationId: "playa", clientId: "c4", serviceId: "s1", service: { name: "Corte" }, scheduledDate: "2026-10-02" }),
      apt({ professionalId: "luz", clientId: "c5", totalAmount: 1500 }), // no location
    ],
  });

  it("computes each location from its own appointments", () => {
    const [centro, playa] = report.perLocation;
    expect(centro).toMatchObject({
      name: "Centro",
      revenue: 8000,
      appointments: 2,
      paidAppointments: 2,
      avgTicket: 4000,
      professionals: 1,
      clients: 1,
      topServices: [
        { name: "Color", count: 1, revenue: 6000 },
        { name: "Corte", count: 1, revenue: 2000 },
      ],
    });
    // Ana works 240 min on Monday and has 180 booked at Centro.
    expect(centro.occupancy).toMatchObject({ bookedMinutes: 180, availableMinutes: 240, rate: 75 });

    expect(playa).toMatchObject({ revenue: 2000, appointments: 2, paidAppointments: 1, clients: 2 });
    // Eva's 120 booked minutes over her 480; Ana's visit to Playa is not
    // counted against Playa's capacity, since her hours belong to Centro.
    expect(playa.occupancy).toMatchObject({ bookedMinutes: 120, availableMinutes: 480, rate: 25 });
  });

  it("keeps unattributed appointments apart so the rows add up", () => {
    expect(report.unassigned).toEqual({ revenue: 1500, appointments: 1 });
    const sum = report.perLocation.reduce((s, r) => s + r.revenue, 0) + report.unassigned.revenue;
    expect(sum).toBe(report.totals.revenue);
    expect(report.totals).toMatchObject({ revenue: 11500, appointments: 5 });
    expect(report.activeLocations).toBe(2);
    expect(report.currencyUnit).toBe("cents");
  });
});
