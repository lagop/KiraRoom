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
  REQUESTABLE_KINDS,
  approvedToast,
  blocksAgenda,
  canWithdraw,
  myAbsences,
  pendingBadge,
  changesPendingRequests,
  closureWhere,
  freeForAll,
  requestBody,
  statusOf,
  agendaLink,
  isPastRequest,
  managerRowActions,
  othersAway,
  type TimeOff,
} from "./time-off";
import * as fs from "fs";
import * as path from "path";

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
eq("the same hours over several days", hoursLabel({ startDate: "2026-12-14", endDate: "2026-12-18", startTime: "09:00", endTime: "14:00" }), "09:00–14:00 cada día");
eq("all day over several days", hoursLabel({ startDate: "2026-12-14", endDate: "2026-12-18", startTime: null, endTime: null }), "Todo el día");
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
eq("the same hours over several days are fine", timeOffFormProblem({ ...form, allDay: false, startTime: "10:00", endTime: "12:00" }), null);
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

console.log("requests");
eq("a professional asks for vacation, a day off or another absence: not sick leave nor a closure", REQUESTABLE_KINDS, ["vacation", "day_off", "other"]);
eq("a block from before requests is approved", statusOf({}), "approved");
check("only approved blocks the agenda", blocksAgenda({}) && blocksAgenda({ status: "approved" }) && !blocksAgenda({ status: "pending" }) && !blocksAgenda({ status: "rejected" }));
check(
  "a request may be withdrawn only while pending",
  canWithdraw({ status: "pending", requested: true }) && !canWithdraw({ status: "approved", requested: true }) && !canWithdraw({ status: "rejected", requested: true }),
);
eq(
  "a request never carries a professional",
  requestBody({ professionalId: "someone-else", kind: "vacation", startDate: "2026-12-01", endDate: "2026-12-02" }),
  { kind: "vacation", startDate: "2026-12-01", endDate: "2026-12-02", startTime: null, endTime: null, note: null },
);
eq(
  "my absences: current and ahead, soonest first",
  myAbsences(
    [
      { id: "b", startDate: "2026-12-20", endDate: "2026-12-21", startTime: null, status: "pending" },
      { id: "past", startDate: "2026-11-01", endDate: "2026-11-02", startTime: null, status: "rejected" },
      { id: "a", startDate: "2026-12-01", endDate: "2026-12-14", startTime: null, status: "approved" },
    ],
    "2026-12-10",
  ).map((r) => r.id),
  ["a", "b"],
);
eq("no badge for none", pendingBadge(0), null);
eq("the badge counts", pendingBadge(3), "3");
eq("and stops at 9+", pendingBadge(12), "9+");
eq("a closure of one location says which", closureWhere({ locationId: "n", locationName: "Norte" }, true), "Solo Norte");
eq("one of every location, with several", closureWhere({ locationId: null }, true), "Todos los locales");
eq("nothing to say with one location", closureWhere({ locationId: null }, false), null);
const bea = { id: "bea", name: "Bea" };
const eva = { id: "eva", name: "Eva" };
eq("one appointment: whoever is free for it", freeForAll([{ reassignable: true, professionals: [bea, eva] }]), [bea, eva]);
eq("several: who is free for all of them", freeForAll([{ reassignable: true, professionals: [bea, eva] }, { reassignable: true, professionals: [eva] }]), [eva]);
eq("one moved from the agenda only: nobody for the selection", freeForAll([{ reassignable: true, professionals: [eva] }, { reassignable: false, professionals: [] }]), []);
eq("nothing selected: nobody", freeForAll([]), []);
check("a new request recounts the badge", changesPendingRequests({ data: { event: "time_off_requested" } }));
check("other notifications do not", !changesPendingRequests({ data: { event: "time_off_approved" } }) && !changesPendingRequests({ data: {} }) && !changesPendingRequests(null));
eq("approved with nothing to move", approvedToast("Ana Gil", 0), {
  title: "Ausencia de Ana Gil aprobada",
  description: "Ya no se ofrecerán citas en ese tiempo.",
});
eq("approved with clashes", approvedToast(null, 2).description, "Recuerda mover o avisar a las 2 citas que coinciden.");

console.log("\nfollow-ups of the time off audit");
check(
  "a request whose last day is gone is refused before sending; today is not",
  isPastRequest("2026-11-01", "2026-11-02") && !isPastRequest("2026-11-02", "2026-11-02") && !isPastRequest("", "2026-11-02"),
);
const away = (b: Partial<TimeOff>): TimeOff => ({
  id: Math.random().toString(36).slice(2),
  professionalId: "bea",
  professionalName: "Bea Ruiz",
  kind: "vacation",
  startDate: "2026-12-14",
  endDate: "2026-12-14",
  startTime: null,
  endTime: null,
  status: "approved",
  ...b,
});
const request = away({ id: "req", professionalId: "ana", professionalName: "Ana Gil", startDate: "2026-12-14", endDate: "2026-12-16", status: "pending" });
eq(
  "who else is away: other professionals' approved time off touching those days, soonest first",
  othersAway(
    [
      request,
      away({ professionalName: "Carla", startDate: "2026-12-16", endDate: "2026-12-20" }),
      away({ startDate: "2026-12-10", endDate: "2026-12-14", kind: "day_off" }),
      away({ professionalId: "ana", professionalName: "Ana Gil" }),
      away({ professionalId: null, kind: "closure", professionalName: null }),
      away({ status: "pending", professionalName: "Dani" }),
      away({ startDate: "2026-12-17", endDate: "2026-12-18", professionalName: "Eva" }),
    ],
    request,
  ).map((b) => b.professionalName),
  ["Bea Ruiz", "Carla"],
);
eq("the agenda link opens the day", agendaLink("2026-12-14"), "/dashboard/appointments?date=2026-12-14");
eq(
  "and the appointment when given",
  agendaLink("2026-12-14", "apt-1"),
  "/dashboard/appointments?date=2026-12-14&appointment=apt-1",
);
check(
  "a pending request in a professional's file is answered, not edited or deleted",
  managerRowActions({ status: "pending" }) === "answer" &&
    managerRowActions({ status: "approved" }) === "edit" &&
    managerRowActions({}) === "edit",
);

console.log("the clash actions in the panel");
const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const page = read("app/dashboard/solicitudes-ausencia/page.tsx");
check("the card and the approval dialog both offer the actions", (page.match(/<ConflictActions/g) ?? []).length === 2);
const actions = read("components/time-off/ConflictActions.tsx");
check("passing is the usual move, with the professional picked", actions.includes("apiClient.updateAppointment(id, { professionalId: open.pick })"));
check("cancelling goes through the time off route (no wait list, a link to book again)", actions.includes("apiClient.cancelAppointmentForTimeOff(id, reason)"));
const es = JSON.parse(read("messages/es.json")).timeOff.actions;
const en = JSON.parse(read("messages/en.json")).timeOff.actions;
check("es.json and en.json have the same timeOff.actions keys", JSON.stringify(Object.keys(es).sort()) === JSON.stringify(Object.keys(en).sort()));
for (const key of actions.match(/timeOff\.actions\.[a-zA-Z]+/g) ?? []) {
  check(`${key} is in es.json`, !!es[key.split(".")[2]]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
