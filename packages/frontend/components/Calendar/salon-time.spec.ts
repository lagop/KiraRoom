/**
 * The calendar on the salon's clock, with the browser somewhere else.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only components/Calendar/salon-time.spec.ts
 *
 * Found on 2026-10-26: a browser in the Canaries against a salon on Madrid
 * time. Single-service blocks were read on the browser's clock and drawn an
 * hour off from where the server has them; multi-service blocks (real
 * instants) were right, so the two kinds disagreed. This spec runs with the
 * process on Atlantic/Canary and the salon on Europe/Madrid.
 */
process.env.TZ = "Atlantic/Canary";

import { dayQueryRange, pickedDay, salonClock, salonInstant, salonTime } from "./salon-time";
import { transformToCalendarFormat } from "./calendar.service";
import { planMove } from "./drag-move";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

const SALON = "Europe/Madrid";

// The premise: this process really is on Canary time (UTC+0 in winter), an
// hour behind the salon (UTC+1).
check(
  "the browser here is on Canary time",
  new Date("2026-10-28T09:00:00.000Z").getHours() === 9,
  new Date("2026-10-28T09:00:00.000Z").getHours(),
);

// --- salon-time.ts ---------------------------------------------------------
check("10:00 in Madrid in winter is 09:00 UTC", salonInstant("2026-10-28", "10:00", SALON).toISOString() === "2026-10-28T09:00:00.000Z");
check("10:00 in Madrid in summer is 08:00 UTC", salonInstant("2026-07-01", "10:00", SALON).toISOString() === "2026-07-01T08:00:00.000Z");
check("10:00 in the Canaries in winter is 10:00 UTC", salonInstant("2026-10-28", "10:00", "Atlantic/Canary").toISOString() === "2026-10-28T10:00:00.000Z");
check(
  "on the days the clocks change, too",
  salonInstant("2026-10-25", "10:00", SALON).toISOString() === "2026-10-25T09:00:00.000Z" &&
    salonInstant("2026-03-29", "10:00", SALON).toISOString() === "2026-03-29T08:00:00.000Z",
);
check("a full ISO scheduledDate reads as its day", salonInstant("2026-10-28T00:00:00.000Z", "10:00", SALON).toISOString() === "2026-10-28T09:00:00.000Z");

const nine = salonClock("2026-10-28T09:00:00.000Z", SALON);
check("09:00 UTC is 10:00 on the salon's clock", nine.time === "10:00" && nine.minutes === 600 && nine.day === "2026-10-28", nine);
check("past the salon's midnight is the next salon day", salonClock("2026-10-28T23:30:00.000Z", SALON).day === "2026-10-29");
check("salonTime is HH:MM", salonTime(new Date("2026-10-28T13:05:00.000Z"), SALON) === "14:05");

check("a picked date is its local calendar day", pickedDay(new Date(2026, 9, 28)) === "2026-10-28");
const range = dayQueryRange("2026-10-28");
check(
  "the day is asked for as the date column holds it (UTC midnight)",
  range.startDate === "2026-10-28T00:00:00.000Z" && range.endDate === "2026-10-28T23:59:59.999Z",
  range,
);

// --- calendar.service.ts: both kinds of block on one clock ------------------
const single: any = {
  id: "11111111-2222-3333-4444-555555555555",
  professionalId: "p1",
  scheduledDate: "2026-10-28T00:00:00.000Z",
  scheduledTime: "10:00",
  duration: 60,
  status: "confirmed",
  client: { firstName: "Clienta", lastName: "Ficticia" },
  service: { name: "Corte", duration: 60 },
};
// A visit at 10:00 whose services the server stored as instants (09:00Z),
// and one service with no stored times (built from the visit's start).
const visit: any = {
  id: "66666666-7777-8888-9999-000000000000",
  professionalId: "p1",
  scheduledDate: "2026-10-28T00:00:00.000Z",
  scheduledTime: "10:00",
  duration: 90,
  status: "confirmed",
  services: [
    { id: "s1", professionalId: "p1", isParallel: false, service: { name: "Corte", duration: 30 }, scheduledStart: "2026-10-28T09:00:00.000Z", scheduledEnd: "2026-10-28T09:30:00.000Z" },
    { id: "s2", professionalId: "p2", isParallel: false, service: { name: "Color", duration: 60 } },
  ],
};
const { appointments: blocks } = transformToCalendarFormat([single, visit], [], SALON);
const one = blocks.find((b) => b.id === single.id);
const cut = blocks.find((b) => b.appointmentServiceId === "s1");
const colour = blocks.find((b) => b.appointmentServiceId === "s2");

check("a single-service 10:00 is 09:00 UTC, as the server has it", one?.start === "2026-10-28T09:00:00.000Z", one?.start);
check("and is drawn at 10:00, not the browser's 09:00", salonTime(one.start, SALON) === "10:00");
check(
  "a stored per-service time and a single-service time agree",
  salonTime(cut.start, SALON) === salonTime(one.start, SALON),
  [cut?.start, one?.start],
);
check(
  "a service without stored times follows the one before it, on the salon's clock",
  salonTime(colour.start, SALON) === "10:30" && colour.start === cut.end,
  colour?.start,
);
check("blocks keep the appointment id (not cut from the block id)", one.appointmentId === single.id && cut.appointmentId === visit.id);

// --- a drop: one row-hour down -----------------------------------------------
const plan = planMove({ start: one.start, end: one.end, professionalId: "p1", newProfessionalId: "p1", minutesDelta: 60, isStaff: false });
const at = plan.kind === "move" ? salonClock(plan.start, SALON) : null;
check("dragging 10:00 an hour down saves 11:00 on the salon's day", at?.day === "2026-10-28" && at?.time === "11:00", at);
check(
  "(the browser's clock would have saved 10:00: an hour off)",
  plan.kind === "move" && plan.start.getHours() === 10,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
