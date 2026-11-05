import {
  appointmentBusyBlocks,
  clashesWithBlock,
  lastServiceIndex,
  minutesUntilFree,
  overlapsBlock,
  plannedCleanup,
  clockOf,
  endClock,
  layoutVisit,
  normalizeAddons,
  visitLines,
  visitTotals,
  VisitRow,
} from "./visit-totals";
import { visitColumns } from "./visit-sync";

/**
 * A multi-service visit kept only its first service's duration and price:
 * online availability left the rest of it free, and the POS and the invoice
 * charged one service. These pin what a visit adds up to.
 */

const TZ = "Europe/Madrid";
// 10:00 in Madrid on Monday 2 November 2026 (UTC+1).
const START = new Date("2026-11-02T09:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-11-02T${String(Number(hhmm.slice(0, 2)) - 1).padStart(2, "0")}:${hhmm.slice(3)}:00.000Z`);

const row = (over: Partial<VisitRow> & { id: string }): VisitRow => ({
  professionalId: null,
  scheduledStart: null,
  scheduledEnd: null,
  isParallel: false,
  type: "active",
  status: "pending",
  service: { duration: 30, price: "20.00" },
  ...over,
});

describe("visitTotals", () => {
  it("serial services: their lengths and prices add up", () => {
    const t = visitTotals({
      start: START,
      professionalId: "ana",
      mainService: { duration: 60, price: "45.00" },
      rows: [
        row({ id: "colour", service: { duration: 60, price: "45.00" } }),
        row({ id: "cut", service: { duration: 30, price: "20.50" } }),
      ],
    });
    expect(t.durationMinutes).toBe(90);
    expect(t.totalCents).toBe(6550);
    expect(t.price).toBe(65.5);
  });

  it("a parallel service runs alongside: the visit lasts the longest stretch, and both are charged", () => {
    const t = visitTotals({
      start: START,
      professionalId: "ana",
      mainService: null,
      rows: [
        row({ id: "colour", service: { duration: 60, price: "45" } }),
        row({ id: "manicure", isParallel: true, professionalId: "bea", service: { duration: 45, price: "15" } }),
        row({ id: "cut", service: { duration: 30, price: "20" } }),
      ],
    });
    // colour 10:00-11:00, manicure 10:00-10:45 alongside, cut 11:00-11:30.
    expect(t.durationMinutes).toBe(90);
    expect(t.totalCents).toBe(8000);
  });

  it("stored times win (visit-move.ts's model): a wait agreed with the client lengthens the visit", () => {
    const t = visitTotals({
      start: START,
      professionalId: "ana",
      mainService: null,
      rows: [
        row({ id: "colour", scheduledStart: at("10:00"), scheduledEnd: at("11:00") }),
        row({ id: "rinse", professionalId: "bea", scheduledStart: at("11:30"), scheduledEnd: at("11:45") }),
      ],
    });
    expect(t.durationMinutes).toBe(105);
  });

  it("a processing row is time, not a second charge; a cancelled row is nothing", () => {
    const t = visitTotals({
      start: START,
      professionalId: "ana",
      mainService: null,
      rows: [
        row({ id: "colour", service: { duration: 30, price: "45" } }),
        row({ id: "setting", type: "processing", service: { duration: 30, price: "45" } }),
        row({ id: "cut", status: "cancelled", service: { duration: 30, price: "20" } }),
      ],
    });
    expect(t.durationMinutes).toBe(60);
    expect(t.totalCents).toBe(4500);
  });

  it("without rows: the appointment's own service", () => {
    const t = visitTotals({ start: START, professionalId: "ana", mainService: { duration: 45, price: "30" }, rows: [] });
    expect(t).toMatchObject({ durationMinutes: 45, totalCents: 3000, price: 30 });
  });

  it("add-ons: their price times their quantity, and their minutes", () => {
    const t = visitTotals({
      start: START,
      professionalId: "ana",
      mainService: { duration: 45, price: "30" },
      rows: [],
      addons: [
        { quantity: 2, service: { duration: 10, price: "4.25" } },
        { quantity: 1, service: null }, // no longer in the catalog
      ],
    });
    expect(t).toMatchObject({ durationMinutes: 65, servicesCents: 3000, addonsCents: 850, totalCents: 3850 });
  });

  it("visitLines: one line per service and per add-on, adding up to the total", () => {
    const rows = [
      row({ id: "colour", serviceId: "s-colour", service: { name: "Color", duration: 60, price: "45" } as any }),
      row({ id: "cut", serviceId: "s-cut", service: { name: "Corte", duration: 30, price: "20" } as any }),
    ];
    const addons = [{ quantity: 2, service: { id: "s-mask", name: "Mascarilla", duration: 10, price: "5" } }];
    const lines = visitLines({ mainService: { id: "s-colour", name: "Color", price: "45" }, rows, addons });
    expect(lines).toEqual([
      { description: "Color", quantity: 1, unitPriceCents: 4500, serviceId: "s-colour" },
      { description: "Corte", quantity: 1, unitPriceCents: 2000, serviceId: "s-cut" },
      { description: "Mascarilla", quantity: 2, unitPriceCents: 500, serviceId: "s-mask" },
    ]);
    const sum = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
    expect(sum).toBe(visitTotals({ start: START, professionalId: "ana", mainService: null, rows, addons }).totalCents);
  });
});

describe("the appointment's columns (visit-sync.ts)", () => {
  const apt = {
    scheduledDate: new Date("2026-11-02T00:00:00.000Z"),
    scheduledTime: "10:00",
    startTime: START,
    duration: 60,
    endTime: "11:00",
    price: "45.00",
    totalAmount: 4500,
    status: "confirmed",
    paymentStatus: "pending",
  };
  const totals = visitTotals({
    start: START,
    professionalId: "ana",
    mainService: null,
    rows: [row({ id: "colour", service: { duration: 60, price: "45" } }), row({ id: "cut", service: { duration: 30, price: "20" } })],
  });

  it("a visit saved with its first service only gets its whole length and price", () => {
    expect(visitColumns(apt, totals, TZ)).toEqual({ duration: 90, endTime: "11:30", price: 65, totalAmount: 6500 });
  });

  it("one already paid or completed keeps the price it was charged", () => {
    expect(visitColumns({ ...apt, paymentStatus: "paid" }, totals, TZ)).toEqual({ duration: 90, endTime: "11:30" });
    expect(visitColumns({ ...apt, status: "completed" }, totals, TZ)).not.toHaveProperty("price");
  });

  it("an ISO instant left in scheduledTime is put back on the salon's clock", () => {
    const data = visitColumns({ ...apt, scheduledTime: "2026-11-02T09:00:00.000Z" }, totals, TZ);
    expect(data.scheduledTime).toBe("10:00");
  });
});

describe("add-ons as stored", () => {
  it("a plain list stays a list", () => {
    expect(normalizeAddons([{ addonId: "a", quantity: 2 }])).toEqual([{ addonId: "a", quantity: 2 }]);
  });

  it('the old {"set": [...]} shape is read as its list', () => {
    expect(normalizeAddons({ set: [{ addonId: "a", quantity: 3 }, { addonId: "b", quantity: 1 }] })).toEqual([
      { addonId: "a", quantity: 3 },
      { addonId: "b", quantity: 1 },
    ]);
  });

  it("an { id: quantity } map, empty values and junk", () => {
    expect(normalizeAddons({ a: 2 })).toEqual([{ addonId: "a", quantity: 2 }]);
    expect(normalizeAddons({})).toEqual([]);
    expect(normalizeAddons(null)).toEqual([]);
    expect(normalizeAddons([null, 3, { quantity: 1 }, { addonId: "x", quantity: "zero" }])).toEqual([{ addonId: "x", quantity: 1 }]);
  });
});

describe("end time and clock", () => {
  it("23:30 + 60 min saturates at 23:59 instead of wrapping to 00:30", () => {
    expect(endClock("23:30", 60)).toBe("23:59");
    expect(endClock("10:15", 50)).toBe("11:05");
    expect(endClock("09:00", 0)).toBe("09:00");
  });

  it("clockOf reads HH:MM, HH:MM:SS and an ISO instant on the salon's clock", () => {
    expect(clockOf("09:30", TZ)).toBe("09:30");
    expect(clockOf("09:30:00", TZ)).toBe("09:30");
    expect(clockOf("2026-11-02T09:00:00.000Z", TZ)).toBe("10:00");
    expect(clockOf("nonsense", TZ)).toBeNull();
  });
});

describe("layoutVisit", () => {
  it("serial services one after another, parallel ones from the start, each keeping its length", () => {
    const laid = layoutVisit(START, [
      { id: "cut", professionalId: "ana", start: at("12:00"), end: at("12:30"), isParallel: false },
      { id: "colour", professionalId: "ana", start: at("10:00"), end: at("11:00"), isParallel: false },
      { id: "nails", professionalId: "bea", start: at("10:00"), end: at("10:45"), isParallel: true },
    ]);
    expect(laid.map((s) => [s.id, s.start.toISOString().slice(11, 16), s.end.toISOString().slice(11, 16)])).toEqual([
      ["cut", "09:00", "09:30"],
      ["colour", "09:30", "10:30"],
      ["nails", "09:00", "09:45"],
    ]);
  });
});

describe("who is busy when", () => {
  const visit = {
    professionalId: "ana",
    scheduledDate: new Date("2026-11-02T00:00:00.000Z"),
    scheduledTime: "10:00",
    duration: 105,
    services: [
      row({ id: "colour", professionalId: "ana", service: { duration: 60 } }),
      row({ id: "setting", professionalId: null, type: "processing", service: { duration: 30 } }),
      row({ id: "rinse", professionalId: "bea", service: { duration: 15 } }),
    ],
  };

  it("each service's professional during it; nobody while the colour sets", () => {
    expect(appointmentBusyBlocks(visit, TZ)).toEqual([
      { professionalId: "ana", startMinutes: 600, endMinutes: 660 },
      { professionalId: "bea", startMinutes: 690, endMinutes: 705 },
    ]);
  });

  it("what the appointment holds past its services (add-ons) is its professional's", () => {
    expect(appointmentBusyBlocks({ ...visit, duration: 120 }, TZ)).toContainEqual({
      professionalId: "ana",
      startMinutes: 705,
      endMinutes: 720,
    });
  });

  it("without rows: its professional, from its time for its duration", () => {
    expect(appointmentBusyBlocks({ professionalId: "ana", scheduledTime: "09:30", duration: 45 }, TZ)).toEqual([
      { professionalId: "ana", startMinutes: 570, endMinutes: 615 },
    ]);
  });
});

describe("cleanup time after a visit (Service.bufferTime)", () => {
  const visit = {
    professionalId: "ana",
    scheduledDate: new Date("2026-11-02T00:00:00.000Z"),
    scheduledTime: "10:00",
    duration: 105,
    services: [
      row({ id: "colour", professionalId: "ana", service: { duration: 60, bufferTime: 20 } }),
      row({ id: "setting", professionalId: null, type: "processing", service: { duration: 30, bufferTime: 20 } }),
      row({ id: "rinse", professionalId: "bea", service: { duration: 15, bufferTime: 10 } }),
    ],
  };

  it("0, or no bufferTime read at all, adds nothing: the blocks are what they always were", () => {
    expect(
      appointmentBusyBlocks({ professionalId: "ana", scheduledTime: "09:30", duration: 45, service: { bufferTime: 0 } }, TZ),
    ).toEqual([{ professionalId: "ana", startMinutes: 570, endMinutes: 615 }]);
    expect(appointmentBusyBlocks({ professionalId: "ana", scheduledTime: "09:30", duration: 45 }, TZ)).toEqual([
      { professionalId: "ana", startMinutes: 570, endMinutes: 615 },
    ]);
  });

  it("one service: its cleanup runs from its end, for its professional", () => {
    expect(
      appointmentBusyBlocks({ professionalId: "ana", scheduledTime: "09:30", duration: 45, service: { bufferTime: 15 } }, TZ),
    ).toEqual([
      { professionalId: "ana", startMinutes: 570, endMinutes: 615 },
      { professionalId: "ana", startMinutes: 615, endMinutes: 630, cleanup: true },
    ]);
  });

  it("several services: once, after the visit, with the cleanup of the service it ends with, for whoever does it", () => {
    expect(appointmentBusyBlocks(visit, TZ)).toEqual([
      { professionalId: "ana", startMinutes: 600, endMinutes: 660 },
      { professionalId: "bea", startMinutes: 690, endMinutes: 705 },
      { professionalId: "bea", startMinutes: 705, endMinutes: 715, cleanup: true },
    ]);
  });

  it("add-ons past the services: the cleanup follows them, for the appointment's professional", () => {
    expect(appointmentBusyBlocks({ ...visit, duration: 120 }, TZ)).toContainEqual({
      professionalId: "ana",
      startMinutes: 720,
      endMinutes: 730,
      cleanup: true,
    });
  });

  it("a visit's processing row does not carry the cleanup", () => {
    const schedule = [
      { id: "a", professionalId: "ana", start: at("10:00"), end: at("11:00"), isParallel: false },
      { id: "b", professionalId: "ana", start: at("11:00"), end: at("11:30"), isParallel: false },
    ];
    expect(lastServiceIndex(schedule, [{ type: "active" }, { type: "processing" }])).toBe(0);
    expect(
      plannedCleanup(schedule, [
        { type: "active", service: { bufferTime: 15 } },
        { type: "processing", service: { bufferTime: 40 } },
      ]),
    ).toEqual({ index: 0, minutes: 15 });
    expect(plannedCleanup([], [], { bufferTime: 25 })).toEqual({ index: -1, minutes: 25 });
  });

  it("clashesWithBlock: nothing starts inside the cleanup, and a booking's own cleanup may not reach the next visit", () => {
    const visit = { professionalId: "ana", startMinutes: 600, endMinutes: 660 };
    const cleanup = { professionalId: "ana", startMinutes: 660, endMinutes: 675, cleanup: true };
    // 11:00 is inside the 15-minute cleanup after the 10:00-11:00 visit.
    expect(clashesWithBlock(cleanup, 660, 30)).toBe(true);
    expect(clashesWithBlock(cleanup, 675, 30)).toBe(false);
    // 09:00-09:45 with 15 min of cleanup runs into the 10:00 visit; with 0, it fits.
    expect(clashesWithBlock(visit, 540, 45, 15)).toBe(false);
    expect(clashesWithBlock(visit, 540, 50, 15)).toBe(true);
    expect(clashesWithBlock(visit, 540, 60, 0)).toBe(false);
    // Without cleanup it is overlapsBlock: back to back is fine.
    expect(clashesWithBlock(visit, 660, 30)).toBe(overlapsBlock(visit, 660, 30));
  });

  it("minutesUntilFree: the appointment's length plus the cleanup of its last live service", () => {
    expect(minutesUntilFree({ duration: 60, service: { bufferTime: 10 } }, 30)).toBe(70);
    expect(
      minutesUntilFree(
        {
          duration: 90,
          services: [
            { type: "active", status: "pending", service: { bufferTime: 5 } },
            { type: "active", status: "cancelled", service: { bufferTime: 40 } },
          ],
        },
        30,
      ),
    ).toBe(95);
    expect(minutesUntilFree({}, 30)).toBe(30);
  });
});
