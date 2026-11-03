/**
 * Inicio's figures and the agenda lists its "Ver todas" links open.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/home-dashboard.spec.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  AGENDA_FOCUS_HREF,
  agendaFocusFromQuery,
  countKey,
  donutColor,
  donutLabelKey,
  hourOf,
  matchesAgendaFocus,
  personName,
  remainingToday,
  statusLabelKey,
  todayPaymentsFigures,
} from "./home-dashboard";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const query = (q: string) => new URLSearchParams(q);

console.log("\n[todayPaymentsFigures] only money kept counts, like Pagos");
check(
  "a declined card then cash is 60 €, not 120 €",
  todayPaymentsFigures([
    { amount: 6000, status: "failed" },
    { amount: 6000, status: "paid" },
  ]),
  { totalCents: 6000, count: 1 },
);
check(
  "a partial refund comes off; a full one and a pending one do not count",
  todayPaymentsFigures([
    { amount: 5000, status: "paid", refundedAmount: 3000 },
    { amount: 4000, status: "refunded", refundedAmount: 4000 },
    { amount: 2500, status: "pending" },
  ]),
  { totalCents: 2000, count: 1 },
);
check("nothing is 0", todayPaymentsFigures([]), { totalCents: 0, count: 0 });

console.log("\n[remainingToday] by the salon's clock");
{
  const rows = [
    { id: "a", scheduledTime: "09:00", status: "confirmed" },
    { id: "b", scheduledTime: "10:30", status: "in_progress" },
    { id: "c", scheduledTime: "12:00", status: "pending" },
    { id: "d", scheduledTime: "9:45", status: "pending" },
  ];
  check("past ones go, in progress stays", remainingToday(rows, "11:00").map((r) => r.id), ["b", "c"]);
  check("the minute it starts it is still left", remainingToday(rows, "12:00").map((r) => r.id), ["b", "c"]);
  check("an hour without a leading zero", remainingToday(rows, "09:30").map((r) => r.id), ["b", "c", "d"]);
  check("no clock: all of them", remainingToday(rows, "").length, 4);
}
check("hourOf", [hourOf("09:30"), hourOf("23:05"), hourOf("")], [9, 23, null]);

console.log("\n[texts]");
check("count keys", [countKey("dashboard.x", 1), countKey("dashboard.x", 0), countKey("dashboard.x", 7)], [
  "dashboard.x_one",
  "dashboard.x_other",
  "dashboard.x_other",
]);
check("status pills use the agenda's keys", statusLabelKey("in_progress"), "appointments.status_in_progress");
check("names", [personName({ firstName: "Ana", lastName: " López " }), personName(null)], ["Ana López", ""]);

console.log("\n[status donut] its own colours: the API's are Tailwind classes");
check("by status", [donutColor("completed"), donutColor("no_show")], ["#10b981", "#6b7280"]);
check("unknown or missing is grey", [donutColor("bg-green-500"), donutColor(undefined)], ["#9ca3af", "#9ca3af"]);
check("a hex colour, never a class", donutColor("pending").startsWith("#"), true);
check("names are Analítica's", [donutLabelKey("completed"), donutLabelKey("x")], ["analytics.completed", null]);

console.log("\n[agenda focus] Inicio's \"Ver todas\" open a filtered list");
check("to confirm", agendaFocusFromQuery(query("status=pending")), "pending");
check("to charge", agendaFocusFromQuery(query("paymentStatus=pending")), "unpaid");
check("anything else: none", [agendaFocusFromQuery(query("status=confirmed")), agendaFocusFromQuery(null)], [null, null]);
check(
  "the links are the ones the agenda reads",
  [
    agendaFocusFromQuery(new URLSearchParams(AGENDA_FOCUS_HREF.pending.split("?")[1])),
    agendaFocusFromQuery(new URLSearchParams(AGENDA_FOCUS_HREF.unpaid.split("?")[1])),
  ],
  ["pending", "unpaid"],
);
{
  const today = "2026-11-03";
  const apt = (o: Record<string, unknown>) => ({
    scheduledDate: "2026-11-03T00:00:00.000Z",
    status: "pending",
    paymentStatus: "pending",
    amountDue: 2000,
    ...o,
  });
  check(
    "to confirm: pending from today on, not old ones never closed",
    [
      matchesAgendaFocus(apt({}), "pending", today),
      matchesAgendaFocus(apt({ scheduledDate: "2026-12-01" }), "pending", today),
      matchesAgendaFocus(apt({ scheduledDate: "2026-01-10" }), "pending", today),
      matchesAgendaFocus(apt({ status: "confirmed" }), "pending", today),
    ],
    [true, true, false, false],
  );
  check(
    "to charge: owed visits up to today, like GET /appointments/pending-payment",
    [
      matchesAgendaFocus(apt({ status: "completed" }), "unpaid", today),
      matchesAgendaFocus(apt({ status: "completed", paymentStatus: "failed", scheduledDate: "2026-10-01" }), "unpaid", today),
      matchesAgendaFocus(apt({ scheduledDate: "2026-11-04" }), "unpaid", today),
      matchesAgendaFocus(apt({ status: "cancelled" }), "unpaid", today),
      matchesAgendaFocus(apt({ paymentStatus: "paid" }), "unpaid", today),
      matchesAgendaFocus(apt({ amountDue: 0 }), "unpaid", today),
    ],
    [true, true, false, false, false, false],
  );
}

console.log("\n[translations] every Inicio key exists in es.json and en.json");
{
  const messages = ["es", "en"].map((lang) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "../messages", `${lang}.json`), "utf8")),
  );
  const lookup = (m: any, key: string) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), m);
  const files = [
    "app/dashboard/page.tsx",
    "app/dashboard/components/header.tsx",
    ...fs
      .readdirSync(path.join(__dirname, "../app/dashboard/components/dashboard"))
      .map((f) => `app/dashboard/components/dashboard/${f}`),
  ];
  const keys = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z_]+\.[a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/countKey\(\s*"([a-zA-Z_]+\.[a-zA-Z0-9_]+)"/g)) {
      keys.add(`${m[1]}_one`);
      keys.add(`${m[1]}_other`);
    }
  }
  for (const s of ["pending", "confirmed", "in_progress"]) keys.add(statusLabelKey(s));
  for (const s of ["completed", "confirmed", "pending", "in_progress", "cancelled", "no_show"]) keys.add(donutLabelKey(s)!);
  keys.add("appointments.focus_pending");
  keys.add("appointments.focus_unpaid");
  const missing = [...keys].flatMap((key) =>
    messages.flatMap((m, i) => (typeof lookup(m, key) === "string" ? [] : [`${["es", "en"][i]}:${key}`])),
  );
  check(`${keys.size} keys, none missing`, missing, []);

  // No English left in the page's own markup (the panel is Spanish first).
  // Its code, comments aside.
  const page = fs
    .readFileSync(path.join(__dirname, "../app/dashboard/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const english = ["Refresh", "You have", "Revenue this month", "Today's schedule", "Unknown client", "with {"].filter(
    (s) => page.includes(s),
  );
  check("no hard-coded English in Inicio", english, []);
  check("no browser-locale money formatting", /Intl\.NumberFormat\(undefined/.test(page), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
