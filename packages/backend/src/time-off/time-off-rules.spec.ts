import {
  TimeOffBlock,
  availableWindows,
  dayBlocks,
  daysOf,
  salonClosedOn,
  timeOffInputProblem,
  timeOffProblem,
} from "./time-off-rules";
import { minutesOf } from "../appointments/working-hours";

/**
 * The rules every booking path reads time off and closures by: which blocks
 * apply to whom on a day, what is left of a shift, and why a slot is refused,
 * in the words the salon reads.
 */

const ANA = "pro-ana";
const BEA = "pro-bea";
const DAY = "2026-12-14";
const w = (a: string, b: string) => ({ startMinutes: minutesOf(a)!, endMinutes: minutesOf(b)! });

const block = (b: Partial<TimeOffBlock>): TimeOffBlock => ({
  professionalId: ANA,
  kind: "vacation",
  startDate: DAY,
  endDate: DAY,
  startTime: null,
  endTime: null,
  note: null,
  ...b,
});

describe("dayBlocks", () => {
  it("applies a professional's own blocks and the salon's, not a colleague's", () => {
    const blocks = [
      block({ professionalId: BEA }),
      block({ professionalId: null, kind: "closure", startTime: "14:00", endTime: "20:00" }),
      block({ startTime: "10:00", endTime: "11:00" }),
    ];
    const ana = dayBlocks(blocks, DAY, ANA);
    expect(ana.allDay).toBeNull();
    expect(ana.windows).toEqual([w("14:00", "20:00"), w("10:00", "11:00")]);
    // The salon's first: its reason is the one a booking is refused with.
    expect(ana.blocks[0].professionalId).toBeNull();
  });

  it("reads a range of days inclusively, Date or string", () => {
    const vacation = block({ startDate: new Date("2026-12-10T00:00:00.000Z"), endDate: new Date("2026-12-14T00:00:00.000Z") });
    expect(dayBlocks([vacation], "2026-12-10", ANA).allDay).toBe(vacation);
    expect(dayBlocks([vacation], "2026-12-14", ANA).allDay).toBe(vacation);
    expect(dayBlocks([vacation], "2026-12-15", ANA).allDay).toBeNull();
    expect(dayBlocks([vacation], "2026-12-09", ANA).allDay).toBeNull();
  });

  it("for the salon (null) only counts closures", () => {
    expect(dayBlocks([block({})], DAY, null).blocks).toEqual([]);
    const closure = block({ professionalId: null, kind: "closure" });
    expect(salonClosedOn([closure], DAY)).toBe(closure);
    expect(salonClosedOn([block({ professionalId: null, kind: "closure", startTime: "09:00", endTime: "12:00" })], DAY)).toBeNull();
  });
});

describe("availableWindows", () => {
  const shifts = [w("10:00", "14:00"), w("17:00", "20:00")];

  it("no blocks: the shifts, or no limit when none are recorded", () => {
    expect(availableWindows(shifts, dayBlocks([], DAY, ANA))).toEqual(shifts);
    expect(availableWindows(undefined, dayBlocks([], DAY, ANA))).toBeUndefined();
  });

  it("an all-day block leaves nothing, schedule or not", () => {
    const away = dayBlocks([block({ kind: "sick_leave" })], DAY, ANA);
    expect(availableWindows(shifts, away)).toEqual([]);
    expect(availableWindows(undefined, away)).toEqual([]);
  });

  it("a partial block is cut out of the shifts", () => {
    const doctor = dayBlocks([block({ kind: "other", startTime: "12:00", endTime: "13:00" })], DAY, ANA);
    expect(availableWindows(shifts, doctor)).toEqual([w("10:00", "12:00"), w("13:00", "14:00"), w("17:00", "20:00")]);
  });

  it("with no schedule recorded, a partial block still blocks its minutes", () => {
    const doctor = dayBlocks([block({ kind: "other", startTime: "12:00", endTime: "13:00" })], DAY, ANA);
    expect(availableWindows(undefined, doctor)).toEqual([w("00:00", "12:00"), { startMinutes: 13 * 60, endMinutes: 24 * 60 }]);
  });
});

describe("timeOffProblem", () => {
  const ask = (blocks: TimeOffBlock[], time: string, minutes = 60) =>
    timeOffProblem({ blocks, day: DAY, professionalId: ANA, professionalName: "Ana", startMinutes: minutesOf(time)!, durationMinutes: minutes });

  it("names the reason of an all-day absence, never its note", () => {
    expect(ask([block({ note: "Viaje a Roma" })], "10:00")).toBe("Ana está de vacaciones ese día.");
    expect(ask([block({ kind: "day_off" })], "10:00")).toBe("Ana libra ese día.");
    expect(ask([block({ kind: "sick_leave", note: "Operación" })], "10:00")).toBe("Ana no está disponible ese día.");
    expect(ask([block({ kind: "other" })], "10:00")).toBe("Ana no está disponible ese día.");
  });

  it("names a closure and its note", () => {
    const navidad = block({ professionalId: null, kind: "closure", note: "Navidad" });
    expect(ask([navidad], "10:00")).toBe("El salón está cerrado ese día (Navidad).");
    expect(ask([block({ professionalId: null, kind: "closure" })], "10:00")).toBe("El salón está cerrado ese día.");
  });

  it("a partial block refuses only what overlaps it", () => {
    const doctor = [block({ kind: "other", startTime: "12:00", endTime: "13:00" })];
    expect(ask(doctor, "11:30")).toBe("Ana no está disponible de 12:00 a 13:00 ese día.");
    expect(ask(doctor, "12:30", 15)).toBe("Ana no está disponible de 12:00 a 13:00 ese día.");
    // Back to back is fine.
    expect(ask(doctor, "11:00")).toBeNull();
    expect(ask(doctor, "13:00")).toBeNull();
  });

  it("a partial closure says the hours", () => {
    const eve = [block({ professionalId: null, kind: "closure", startTime: "14:00", endTime: "20:00", note: "Nochebuena" })];
    expect(ask(eve, "15:00")).toBe("El salón está cerrado de 14:00 a 20:00 ese día (Nochebuena).");
    expect(ask(eve, "12:00")).toBeNull();
  });

  it("a colleague's absence does not block Ana", () => {
    expect(ask([block({ professionalId: BEA })], "10:00")).toBeNull();
  });
});

describe("timeOffInputProblem", () => {
  const ok = { professionalId: ANA, kind: "vacation", startDate: "2026-12-01", endDate: "2026-12-05" };

  it("accepts all day over several days, or hours on one day", () => {
    expect(timeOffInputProblem(ok)).toBeNull();
    expect(timeOffInputProblem({ ...ok, endDate: ok.startDate, startTime: "10:00", endTime: "12:00" })).toBeNull();
    expect(timeOffInputProblem({ kind: "closure", startDate: "2026-12-25", endDate: "2026-12-25" })).toBeNull();
  });

  it("refuses an end before the start", () => {
    expect(timeOffInputProblem({ ...ok, endDate: "2026-11-30" })).toMatch(/anterior a la de inicio/);
  });

  it("refuses hours over several days, one time without the other, or an end before the start", () => {
    expect(timeOffInputProblem({ ...ok, startTime: "10:00", endTime: "12:00" })).toMatch(/un único día/);
    expect(timeOffInputProblem({ ...ok, endDate: ok.startDate, startTime: "10:00" })).toMatch(/todo el día/);
    expect(timeOffInputProblem({ ...ok, endDate: ok.startDate, startTime: "12:00", endTime: "10:00" })).toMatch(/posterior/);
    expect(timeOffInputProblem({ ...ok, endDate: ok.startDate, startTime: "10:00", endTime: "10:00" })).toMatch(/posterior/);
  });

  it("refuses more than 366 days", () => {
    expect(timeOffInputProblem({ ...ok, startDate: "2026-01-01", endDate: "2027-01-01" })).toBeNull(); // 366
    expect(timeOffInputProblem({ ...ok, startDate: "2026-01-01", endDate: "2027-01-02" })).toMatch(/366/);
  });

  it("refuses a day that does not exist", () => {
    expect(timeOffInputProblem({ ...ok, startDate: "2026-02-30" })).toMatch(/días válidos/);
  });

  it("a closure is the salon's, and only a closure is", () => {
    expect(timeOffInputProblem({ ...ok, kind: "closure" })).toMatch(/no lleva profesional/);
    expect(timeOffInputProblem({ ...ok, professionalId: null })).toMatch(/Elige un profesional/);
  });
});

describe("daysOf", () => {
  it("lists every day of a block, across a month end", () => {
    expect(daysOf(block({ startDate: "2026-12-30", endDate: "2027-01-02" }))).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});
