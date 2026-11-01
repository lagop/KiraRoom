import { bookedService, snapshotAddons, snapshotOf, withBookedService } from "./appointment-snapshot";
import { appointmentBusyBlocks, normalizeAddons, visitLines, visitTotals } from "./visit-totals";
import { addonServices, syncVisitTotals } from "./visit-sync";
import { appointmentInvoiceLines } from "../invoices/appointment-invoice-pricing";
import { appointmentTotalCents } from "../payments/appointment-payment";

/**
 * Editing a service in the catalog used to change appointments already made:
 * the visit totals, the till, the invoice, the agenda and the notices all read
 * the live service. Each appointment, visit row and add-on now keeps what it
 * was booked at, and these readers prefer it (appointment-snapshot.ts). The
 * booking paths that write it are pinned in create-tenant.spec.ts and
 * staff-create.spec.ts, the edits in multi-service-visits.spec.ts.
 */

const DAY = "2030-11-04"; // a Monday, Madrid on UTC+1
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2030, 10, 4, h - 1, m));
};

/** The cut was 20 EUR / 30 min when booked; the catalog now says 26 / 45. */
const LIVE_CUT = { id: "s-cut", name: "Corte y peinado", price: "26", duration: 45, bufferTime: 10 };
const BOOKED_CUT = { serviceName: "Corte", servicePrice: "20", serviceDuration: 30 };

describe("bookedService", () => {
  it("is the snapshot where there is one, the live service otherwise", () => {
    expect(bookedService({ serviceId: "s-cut", ...BOOKED_CUT, service: LIVE_CUT })).toEqual({
      id: "s-cut",
      name: "Corte",
      price: "20",
      duration: 30,
      // The cleanup is today's agenda rule, not part of what was booked.
      bufferTime: 10,
    });
    expect(bookedService({ serviceId: "s-cut", service: LIVE_CUT })).toMatchObject({ name: "Corte y peinado", price: "26", duration: 45 });
    expect(bookedService({ serviceId: "s-cut", service: null })).toBeNull();
    expect(bookedService({ serviceId: "s-cut", ...BOOKED_CUT, service: null })).toMatchObject({ name: "Corte", price: "20", duration: 30 });
  });

  it("keeps a snapshot of 0 (a free service) instead of falling back", () => {
    expect(bookedService({ servicePrice: 0, serviceDuration: 0, service: LIVE_CUT })).toMatchObject({ price: 0, duration: 0 });
  });

  it("snapshotOf takes name, price and duration", () => {
    expect(snapshotOf(LIVE_CUT)).toEqual({ serviceName: "Corte y peinado", servicePrice: "26", serviceDuration: 45 });
  });

  it("withBookedService overlays the appointment's service for the notices", () => {
    const apt = withBookedService({ id: "a1", serviceId: "s-cut", ...BOOKED_CUT, service: LIVE_CUT });
    expect(apt.service).toMatchObject({ id: "s-cut", name: "Corte", price: "20", duration: 30 });
    expect(apt.id).toBe("a1");
  });
});

describe("add-ons keep what they were added at", () => {
  const catalog = [
    { id: "s-mask", name: "Mascarilla", price: "8", duration: 15 },
    { id: "s-gloss", name: "Brillo", price: "3.5", duration: 5 },
  ];

  it("an add-on already on the visit keeps its price; a new one takes today's", () => {
    const previous = [{ addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 }];
    expect(
      snapshotAddons(
        [
          { addonId: "s-mask", quantity: 2 },
          { addonId: "s-gloss", quantity: 1 },
        ],
        previous,
        catalog,
      ),
    ).toEqual([
      { addonId: "s-mask", quantity: 2, name: "Mascarilla", price: 5, duration: 10 },
      { addonId: "s-gloss", quantity: 1, name: "Brillo", price: 3.5, duration: 5 },
    ]);
  });

  it("the stored list is read back with its snapshot, old lines without one stay as they were", () => {
    expect(
      normalizeAddons([
        { addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 },
        { addonId: "s-gloss", quantity: 1 },
      ]),
    ).toEqual([
      { addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 },
      { addonId: "s-gloss", quantity: 1 },
    ]);
  });

  it("are priced at their snapshot, else at the catalog's", async () => {
    const db = { service: { findMany: jest.fn(async () => catalog) } };
    const priced = await addonServices(db, "t1", [
      { addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 },
      { addonId: "s-gloss", quantity: 2 },
    ]);
    expect(priced.map((a) => [a.quantity, a.service?.price, a.service?.duration])).toEqual([
      [1, 5, 10],
      [2, "3.5", 5],
    ]);
  });
});

describe("a visit adds up what it was booked at", () => {
  const rows = [
    {
      id: "r1",
      serviceId: "s-colour",
      professionalId: "ana",
      scheduledStart: null,
      scheduledEnd: null,
      isParallel: false,
      type: "active",
      status: "pending",
      serviceName: "Color",
      servicePrice: "45",
      serviceDuration: 60,
      service: { name: "Color premium", price: "55", duration: 75 },
    },
    {
      id: "r2",
      serviceId: "s-cut",
      professionalId: "ana",
      scheduledStart: null,
      scheduledEnd: null,
      isParallel: false,
      type: "active",
      status: "pending",
      ...BOOKED_CUT,
      service: LIVE_CUT,
    },
  ];

  it("totals: its rows' booked prices and lengths", () => {
    const totals = visitTotals({ start: at("10:00"), professionalId: "ana", mainService: null, rows });
    expect(totals).toMatchObject({ durationMinutes: 90, totalCents: 6500, price: 65 });
  });

  it("totals without rows: the appointment's own booked service", () => {
    const totals = visitTotals({
      start: at("10:00"),
      professionalId: "ana",
      mainService: bookedService({ serviceId: "s-cut", ...BOOKED_CUT, service: LIVE_CUT }),
      rows: [],
    });
    expect(totals).toMatchObject({ durationMinutes: 30, totalCents: 2000 });
  });

  it("the invoice and till lines: booked names and prices", () => {
    expect(visitLines({ mainService: null, rows })).toEqual([
      { description: "Color", quantity: 1, unitPriceCents: 4500, serviceId: "s-colour" },
      { description: "Corte", quantity: 1, unitPriceCents: 2000, serviceId: "s-cut" },
    ]);
  });

  it("the agenda: an untimed row is busy for its booked length", () => {
    const blocks = appointmentBusyBlocks(
      { professionalId: "ana", scheduledDate: DAY, scheduledTime: "10:00", duration: 90, service: null, services: rows },
      "Europe/Madrid",
    );
    // 10:00-11:00 colour, 11:00-11:30 cut (not 11:15-12:00), then the cut's cleanup.
    expect(blocks).toEqual([
      { professionalId: "ana", startMinutes: 600, endMinutes: 660 },
      { professionalId: "ana", startMinutes: 660, endMinutes: 690 },
      { professionalId: "ana", startMinutes: 690, endMinutes: 700, cleanup: true },
    ]);
  });
});

describe("re-adding up a visit after an edit", () => {
  it("syncVisitTotals keeps the booked price when the catalog changed", async () => {
    const apt = {
      id: "a1",
      tenantId: "t1",
      professionalId: "ana",
      serviceId: "s-cut",
      scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
      scheduledTime: "10:00",
      startTime: at("10:00"),
      duration: 30,
      endTime: "10:30",
      price: "20",
      totalAmount: 2000,
      status: "confirmed",
      paymentStatus: "pending",
      addons: [],
      ...BOOKED_CUT,
      service: LIVE_CUT,
      tenant: { timezone: "Europe/Madrid" },
      services: [],
    };
    const db = { appointment: { findUnique: jest.fn(async () => apt), update: jest.fn() }, service: { findMany: jest.fn(async () => []) } };
    await syncVisitTotals(db, "a1");
    // Nothing to change: it used to write 26 EUR and 45 minutes.
    expect(db.appointment.update).not.toHaveBeenCalled();
  });
});

describe("what is charged and invoiced", () => {
  const fiscal = { defaultTaxRate: 21, pricesIncludeTax: true };

  it("the invoice line names the service as booked", () => {
    const [line] = appointmentInvoiceLines(
      { price: "20", serviceId: "s-cut", ...BOOKED_CUT, service: LIVE_CUT as any, services: [], addons: [] },
      fiscal,
    );
    expect(line).toMatchObject({ description: "Corte", unitPriceCents: 2000, quantity: 1 });
  });

  it("a multi-service visit gets one line per service at its booked price", () => {
    const lines = appointmentInvoiceLines(
      {
        price: "65",
        serviceId: "s-colour",
        serviceName: "Color",
        servicePrice: "45",
        service: { name: "Color premium", price: "55" } as any,
        services: [
          { id: "r1", serviceId: "s-colour", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, status: "pending", serviceName: "Color", servicePrice: "45", serviceDuration: 60, service: { name: "Color premium", price: "55" } },
          { id: "r2", serviceId: "s-cut", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, status: "pending", ...BOOKED_CUT, service: LIVE_CUT },
        ],
        addons: [],
      },
      fiscal,
    );
    expect(lines.map((l) => [l.description, l.unitPriceCents])).toEqual([
      ["Color", 4500],
      ["Corte", 2000],
    ]);
  });

  it("a loyalty reward used at the till is a discount on the booked lines (#213)", () => {
    const lines = appointmentInvoiceLines(
      {
        price: "65",
        serviceId: "s-colour",
        serviceName: "Color",
        servicePrice: "45",
        service: { name: "Color premium", price: "55" } as any,
        services: [
          { id: "r1", serviceId: "s-colour", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, status: "pending", serviceName: "Color", servicePrice: "45", serviceDuration: 60, service: { name: "Color premium", price: "55" } },
          { id: "r2", serviceId: "s-cut", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, status: "pending", ...BOOKED_CUT, service: LIVE_CUT },
        ],
        addons: [],
        discount: { loyalty: { catalogueCents: 1300 } },
      },
      fiscal,
    );
    expect(lines.map((l) => [l.description, l.unitPriceCents])).toEqual([
      ["Color", 4500],
      ["Corte", 2000],
    ]);
    const loyalty = lines.reduce((s, l) => s + ((l as any).loyaltyDiscountCents ?? 0), 0);
    const discounts = lines.reduce((s, l) => s + (l.discountCents ?? 0), 0);
    expect(loyalty).toBe(1300);
    expect(discounts).toBe(1300);
  });

  it("the till's fallback without a stored total is the booked price", () => {
    expect(appointmentTotalCents({ totalAmount: 0, servicePrice: "20", service: { price: "26" } })).toBe(2000);
    expect(appointmentTotalCents({ totalAmount: 0, service: { price: "26" } })).toBe(2600);
  });
});
