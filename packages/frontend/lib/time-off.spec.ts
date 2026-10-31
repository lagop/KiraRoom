/**
 * Time off in the panel: how a block reads, the form's checks (the server's
 * rules, so the salon reads why before sending) and the clash message.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/time-off.spec.ts
 */
import {
  addDays,
  calendarLabel,
  conflictLine,
  conflictTitle,
  dateRangeLabel,
  hoursLabel,
  isCurrentOrUpcoming,
  timeOffFormProblem,
} from "./time-off";

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
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

console.log("how a block reads");
eq("one day", dateRangeLabel("2026-12-25", "2026-12-25"), "25 dic 2026");
eq("days of one month", dateRangeLabel("2026-12-24", "2026-12-26"), "24–26 dic 2026");
eq("across months", dateRangeLabel("2026-11-30", "2026-12-02"), "30 nov – 2 dic 2026");
eq("across years", dateRangeLabel("2026-12-30", "2027-01-02"), "30 dic 2026 – 2 ene 2027");
eq("all day", hoursLabel({ startTime: null, endTime: null }), "Todo el día");
eq("hours", hoursLabel({ startTime: "10:00", endTime: "12:30" }), "10:00–12:30");
eq("a personal block by kind", calendarLabel({ professionalId: "p", kind: "sick_leave", note: "x" }), "Baja");
eq("a closure with its note", calendarLabel({ professionalId: null, kind: "closure", note: " Navidad " }), "Salón cerrado — Navidad");
eq("a closure without one", calendarLabel({ professionalId: null, kind: "closure", note: undefined }), "Salón cerrado");
check("a block ending today is still current", isCurrentOrUpcoming({ endDate: "2026-12-14" }, "2026-12-14"));
check("one that ended yesterday is not", !isCurrentOrUpcoming({ endDate: "2026-12-13" }, "2026-12-14"));
eq("days move across a year end", addDays("2026-12-31", 1), "2027-01-01");

console.log("the form");
const form = { startDate: "2026-12-01", endDate: "2026-12-05", allDay: true, startTime: "", endTime: "", note: "" };
eq("all day over several days is fine", timeOffFormProblem(form), null);
eq("hours on one day are fine", timeOffFormProblem({ ...form, endDate: form.startDate, allDay: false, startTime: "10:00", endTime: "12:00" }), null);
check("no dates", /fechas/.test(timeOffFormProblem({ ...form, startDate: "" }) ?? ""));
check("end before start", /anterior/.test(timeOffFormProblem({ ...form, endDate: "2026-11-30" }) ?? ""));
check("more than 366 days", /366/.test(timeOffFormProblem({ ...form, startDate: "2026-01-01", endDate: "2027-01-02" }) ?? ""));
eq("exactly 366 days is fine", timeOffFormProblem({ ...form, startDate: "2026-01-01", endDate: "2027-01-01" }), null);
check("hours over several days", /único día/.test(timeOffFormProblem({ ...form, allDay: false, startTime: "10:00", endTime: "12:00" }) ?? ""));
check("hours missing", /hora de inicio/.test(timeOffFormProblem({ ...form, endDate: form.startDate, allDay: false, startTime: "10:00" }) ?? ""));
check("end hour before start hour", /posterior/.test(timeOffFormProblem({ ...form, endDate: form.startDate, allDay: false, startTime: "12:00", endTime: "12:00" }) ?? ""));
check("a long note", /200/.test(timeOffFormProblem({ ...form, note: "x".repeat(201) }) ?? ""));

console.log("clashes");
eq("one", conflictTitle(1, "ausencia"), "Esta cita coincide con la ausencia");
eq("several, a closure", conflictTitle(3, "cierre"), "Estas 3 citas coinciden con el cierre");
eq(
  "a line names the day, time, client, services and who",
  conflictLine({
    id: "a",
    date: "2026-12-14",
    time: "10:00",
    clientName: "Lucía Pérez",
    serviceNames: ["Color", "Aclarado"],
    professionalName: "Ana Gil",
    status: "confirmed",
  }),
  "14 dic 2026 · 10:00 · Lucía Pérez · Color, Aclarado (Ana Gil)",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
