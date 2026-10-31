/**
 * Hand-rolled Node test runner. Run via:
 *
 *   cd packages/frontend && npx ts-node \
 *     app/dashboard/appointments/components/appointment-drawer.utils.spec.ts
 *
 * Asserts behavior of the pure helpers extracted from the
 * 4000-line `appointment-drawer.tsx` monolith.
 */

import * as fs from "fs";
import * as path from "path";
import {
  addMinutesToTime,
  appointmentEditHref,
  asksFirst,
  canChangeStatus,
  statusLabelKey,
  NEXT_STATUSES,
  sendStatusChange,
  serverMessage,
  statusActions,
  buildStaffBookingPayload,
  staffOwnCatalog,
  drawerTargetFromQuery,
  calculateTotalDuration,
  formatDateString,
  formatDateTimeString,
  formatShortDay,
  formatEuros,
  formatCents,
  eurosToCents,
  centsToEuros,
  appointmentTotalCents,
  parseRate,
  effectiveCommission,
  formatRate,
  salonTermsForm,
  salonTermsInvalid,
  salonTermsUpdate,
  toDrawerAppointment,
  mergeActivity,
  activityLabelKey,
  CREATED_ACTIVITY,
  getStatusBadgeStyle,
  getTotalDuration,
  getTotalPrice,
  transformAddons,
} from "./appointment-drawer.utils";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

function checkTrue(label: string, actual: boolean): void {
  if (actual) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label} (expected true)`;
    console.log(msg);
    failures.push(msg);
  }
}

// ----- addMinutesToTime -----

console.log("\n[addMinutesToTime]");
check("forward 30 min", addMinutesToTime("10:00", 30), "10:30");
check("across hour boundary", addMinutesToTime("10:45", 30), "11:15");
check("across midnight", addMinutesToTime("23:30", 60), "00:30");
check("zero minutes", addMinutesToTime("09:00", 0), "09:00");
check("wrap multiple days", addMinutesToTime("00:00", 1440), "00:00");
check("negative time wraps forward", addMinutesToTime("00:30", -60), "23:30");

// ----- formatDateString / formatShortDay / formatDateTimeString -----

console.log("\n[formatDateString]");
check("Spanish, the day as written", formatDateString("2026-03-17"), "martes, 17 de marzo de 2026");
check("an ISO date-time keeps its calendar day", formatDateString("2026-03-01T00:00:00.000Z"), "domingo, 1 de marzo de 2026");
check("nothing for nothing", formatDateString(""), "");

console.log("\n[formatShortDay]");
check("dd/mm/yyyy", formatShortDay("2026-03-07"), "07/03/2026");
check("from the API's date-time", formatShortDay("2026-12-31T00:00:00.000Z"), "31/12/2026");

console.log("\n[formatDateTimeString]");
const formattedDt = formatDateTimeString("2026-03-17T14:30:00Z");
checkTrue("Spanish month", /mar/.test(formattedDt) && formattedDt.includes("2026"));
checkTrue("24-hour clock, no AM/PM", /\d{2}:\d{2}/.test(formattedDt) && !/AM|PM/i.test(formattedDt));
check("an invalid date shows nothing", formatDateTimeString("not a date"), "");

// ----- Money: euros and cents -----

console.log("\n[money]");
// Intl puts a no-break space before the euro sign.
const plain = (text: string) => text.replace(/\s/g, " ");
check("euros", plain(formatEuros(35)), "35,00 €");
check("euros from a Decimal string", plain(formatEuros("12.5")), "12,50 €");
check("thousands", plain(formatEuros(1234.5)), "1234,50 €");
check("cents", plain(formatCents(3550)), "35,50 €");
check("cents from a string", plain(formatCents("2000")), "20,00 €");
check("nothing is 0", plain(formatCents(null)), "0,00 €");
check("euros to cents, rounded", [eurosToCents(12.5), eurosToCents("0.1"), eurosToCents("12,34"), eurosToCents(19.99)], [1250, 10, 1234, 1999]);
check("not a number is 0 cents", eurosToCents("abc"), 0);
check("cents to euros", [centsToEuros(1250), centsToEuros("99"), centsToEuros(undefined)], [12.5, 0.99, 0]);
check("the server's total wins (cents)", appointmentTotalCents({ totalAmount: 4500, price: 30 }), 4500);
check(
  "else the services' prices (euros)",
  appointmentTotalCents({ totalAmount: 0, price: 30, services: [{ service: { price: 20 } }, { service: { price: "15.5" } }] }),
  3550,
);
check("else the price (euros)", appointmentTotalCents({ price: "30.00" }), 3000);

// ----- Commission and deposit -----

console.log("\n[commission]");
check("0 is a rate, not unset", parseRate(0), 0);
check("a Decimal string", parseRate("12.50"), 12.5);
check("a comma", parseRate("7,5"), 7.5);
check("empty and null are unset", [parseRate(""), parseRate("  "), parseRate(null), parseRate(undefined)], [null, null, null, null]);
check("out of range is not a rate", [parseRate(101), parseRate(-1), parseRate("x")], [null, null, null]);
check("the appointment's own rate, 0 included", effectiveCommission(0, 30), { rate: 0, source: "appointment" });
check("else the professional's", effectiveCommission(null, "25"), { rate: 25, source: "professional" });
check("a professional at 0 % keeps 0", effectiveCommission(undefined, 0), { rate: 0, source: "professional" });
check("else the salon's default", effectiveCommission(null, null), { rate: 10, source: "default" });
check("shown in Spanish", plain(formatRate(12.5)), "12,5 %");

console.log("\n[salon terms]");
const termsBefore = { commissionRate: null, depositRequired: false, depositAmount: null };
check(
  "the form from the appointment: deposit in euros, no override as empty",
  salonTermsForm({ commissionRate: null, depositRequired: true, depositAmount: 1250 }),
  { commission: "", depositRequired: true, deposit: "12.5" },
);
check("a 0 % override shows as 0", salonTermsForm({ commissionRate: 0 }).commission, "0");
check(
  "nothing changed, nothing sent",
  salonTermsUpdate({ role: "owner", before: termsBefore, form: salonTermsForm(termsBefore) }),
  {},
);
check(
  "a 0 % override is sent as 0",
  salonTermsUpdate({ role: "owner", before: termsBefore, form: { commission: "0", depositRequired: false, deposit: "" } }),
  { commissionRate: 0 },
);
check(
  "clearing the override sends null (the professional's rate again)",
  salonTermsUpdate({ role: "admin", before: { commissionRate: "15" }, form: { commission: "", depositRequired: false, deposit: "" } }),
  { commissionRate: null },
);
check(
  "the deposit goes in cents",
  salonTermsUpdate({ role: "owner", before: termsBefore, form: { commission: "", depositRequired: true, deposit: "20" } }),
  { depositRequired: true, depositAmount: 2000 },
);
check(
  "an unchanged deposit is not resent (it used to be sent as typed euros)",
  salonTermsUpdate({
    role: "owner",
    before: { depositRequired: true, depositAmount: 2000 },
    form: salonTermsForm({ depositRequired: true, depositAmount: 2000 }),
  }),
  {},
);
check(
  "turning the deposit off",
  salonTermsUpdate({ role: "owner", before: { depositRequired: true, depositAmount: 2000 }, form: { commission: "", depositRequired: false, deposit: "20" } }),
  { depositRequired: false },
);
check(
  "a professional's edit sends no terms (the server ignores them)",
  salonTermsUpdate({ role: "staff", before: termsBefore, form: { commission: "50", depositRequired: true, deposit: "5" } }),
  {},
);
checkTrue("a rate over 100 is refused", salonTermsInvalid({ commission: "150", depositRequired: false, deposit: "" }));
checkTrue("a negative deposit is refused", salonTermsInvalid({ commission: "", depositRequired: true, deposit: "-5" }));
checkTrue("0 % and an empty deposit are fine", !salonTermsInvalid({ commission: "0", depositRequired: true, deposit: "" }));

// ----- The appointment as the drawer shows it -----

console.log("\n[toDrawerAppointment]");
const apiAppointment = {
  id: "apt-1",
  client: { id: "c1", firstName: "Lucía", lastName: "Pérez", email: null, phone: "600000000" },
  professional: { id: "p1", firstName: "Ana", lastName: "Gil", email: "ana@salon.es", commissionRate: "20" },
  service: { id: "s1", name: "Corte", duration: 30, price: "25.00" },
  services: [],
  addons: [{ addonId: "s2", quantity: 2 }],
  scheduledDate: "2026-03-17T00:00:00.000Z",
  scheduledTime: "10:30",
  status: "confirmed",
  price: "25.00",
  notes: null,
  commissionRate: "0",
  depositRequired: true,
  depositAmount: "1000",
  depositPaid: false,
  totalAmount: 3500,
  amountPaid: "0",
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T09:00:00.000Z",
};
const drawerAppointment = toDrawerAppointment(apiAppointment, [{ id: "s2", name: "Mascarilla", price: 5, duration: 10 }]);
check("the calendar day", drawerAppointment.date, "2026-03-17");
check("a 0 % override stays 0, not unset", drawerAppointment.commissionRate, 0);
check("the professional's rate for the fallback", drawerAppointment.professionalCommissionRate, 20);
check("the deposit, in cents as stored", [drawerAppointment.depositRequired, drawerAppointment.depositAmount], [true, 1000]);
check("the server's total, in cents", drawerAppointment.totalAmount, 3500);
check("prices as numbers (euros)", [drawerAppointment.price, drawerAppointment.service.price], [25, 25]);
check("empty notes are empty, not null", drawerAppointment.notes, "");
check("add-ons resolved when the catalog is there", drawerAppointment.addons.map((a) => [a.name, a.quantity]), [["Mascarilla", 2]]);
check("no English fallback for a missing specialty", drawerAppointment.professional.specialty, "");
check(
  "no override is null",
  toDrawerAppointment({ ...apiAppointment, commissionRate: null }).commissionRate,
  null,
);

console.log("\n[activity]");
const merged = mergeActivity("2026-03-01T09:00:00.000Z", [
  { createdAt: "2026-03-02T09:00:00.000Z", action: "appointment_updated", details: { notes: "" } },
  { createdAt: "2026-03-01T09:00:00.000Z", action: CREATED_ACTIVITY },
]);
check("newest first, the creation once", merged.map((a) => a.action), ["appointment_updated", CREATED_ACTIVITY]);
check("known actions have a label", activityLabelKey("appointment_cancelled"), "appointments.activityActions.cancelled");
check("unknown ones do not", activityLabelKey("something_else"), null);

// ----- getTotalPrice -----

console.log("\n[getTotalPrice]");
const services = [
  { id: "s1", price: 30 },
  { id: "s2", price: 50 },
  { id: "s3", price: 25 },
  { id: "s4" }, // no price → contributes 0
];
check("empty selection with fallback", getTotalPrice([], services, "s1"), 30);
check("empty selection without fallback", getTotalPrice([], services), 0);
check("multi-service sum", getTotalPrice(
  [{ serviceId: "s1" }, { serviceId: "s2" }, { serviceId: "s4" }],
  services,
), 80);
check("unknown service id", getTotalPrice([{ serviceId: "x" }], services), 0);
check("string price coerces to number", getTotalPrice(
  [{ serviceId: "s1" }],
  [{ id: "s1", price: "30" as unknown as number }],
), 30);

// ----- getTotalDuration -----

console.log("\n[getTotalDuration]");
const durationServices = [
  { id: "s1", duration: 30 },
  { id: "s2", duration: 45 },
  { id: "s3", duration: 60 },
];
check("empty selection with fallback", getTotalDuration([], durationServices, "s2"), 45);
check("empty without fallback", getTotalDuration([], durationServices), 0);
check("all serial sums", getTotalDuration(
  [
    { serviceId: "s1", isParallel: false },
    { serviceId: "s2", isParallel: false },
    { serviceId: "s3", isParallel: false },
  ],
  durationServices,
), 135);
check("parallel takes max", getTotalDuration(
  [
    { serviceId: "s1", isParallel: true },
    { serviceId: "s2", isParallel: true },
    { serviceId: "s3", isParallel: true },
  ],
  durationServices,
), 60);
check("mixed parallel + serial", getTotalDuration(
  [
    { serviceId: "s1", isParallel: true },
    { serviceId: "s2", isParallel: false },
    { serviceId: "s3", isParallel: true },
  ],
  durationServices,
), Math.max(30, 60) + 45);
check("missing duration falls back to 0", getTotalDuration(
  [{ serviceId: "missing" }],
  durationServices,
), 0);

// ----- calculateTotalDuration (appointment shape) -----

console.log("\n[calculateTotalDuration]");
check("no multi-services → service + addons",
  calculateTotalDuration({
    service: { duration: 60 },
    addons: [{ duration: 10 }, { duration: 15 }],
  }),
  85);
check("all serial services",
  calculateTotalDuration({
    service: { duration: 30 },
    services: [
      { service: { duration: 30 }, isParallel: false },
      { service: { duration: 60 }, isParallel: false },
    ],
  }),
  90);
check("parallel takes max + addons",
  calculateTotalDuration({
    service: { duration: 30 },
    services: [
      { service: { duration: 60 }, isParallel: true },
      { service: { duration: 90 }, isParallel: true },
      { service: { duration: 30 }, isParallel: false },
    ],
    addons: [{ duration: 5 }],
  }),
  90 + 30 + 5);
check("handles null addons", calculateTotalDuration({ service: { duration: 30 } }), 30);
check("handles undefined services", calculateTotalDuration({ service: { duration: 30 }, services: undefined }), 30);

// ----- transformAddons -----

console.log("\n[transformAddons]");
check("null returns empty", transformAddons(null, []), []);
check("undefined returns empty", transformAddons(undefined, []), []);
check("empty array", transformAddons([], []), []);
const catalog = [
  { id: "a1", name: "Shampoo", price: 8, duration: 5 },
  { id: "a2", name: "Mask", price: 15, duration: 10 },
];
check("array of {addonId, quantity}", transformAddons(
  [{ addonId: "a1", quantity: 2 }, { addonId: "a2", quantity: 1 }],
  catalog,
), [
  { id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 },
  { id: "a2", name: "Mask", quantity: 1, price: 15, duration: 10 },
]);
check("object with .set", transformAddons(
  { set: [{ addonId: "a1", quantity: 3 }] },
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 3, price: 8, duration: 5 }]);
check("legacy object {id: quantity}", transformAddons(
  { a1: 2, a2: 1 },
  catalog,
), [
  { id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 },
  { id: "a2", name: "Mask", quantity: 1, price: 15, duration: 10 },
]);
check("filters unresolvable addonIds", transformAddons(
  [{ addonId: "ghost", quantity: 1 }, { addonId: "a1", quantity: 2 }],
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 }]);
check("supports serviceId alias", transformAddons(
  [{ serviceId: "a1", quantity: 1 }],
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 1, price: 8, duration: 5 }]);
check("string id coerces", transformAddons(
  [{ addonId: "1" }],
  [{ id: 1, name: "Foo", price: 5, duration: 1 }] as any,
), [{ id: "1", name: "Foo", quantity: undefined, price: 5, duration: 1 }]);

// ----- getStatusBadgeStyle -----

console.log("\n[getStatusBadgeStyle]");
check("confirmed style", getStatusBadgeStyle("confirmed").label, "Confirmada");
check("pending style", getStatusBadgeStyle("pending").bg, "bg-yellow-50");
check("cancelled style", getStatusBadgeStyle("cancelled").border, "border-red-200");
check("in_progress style", getStatusBadgeStyle("in_progress").label, "En curso");
check("completed style", getStatusBadgeStyle("completed").text, "text-blue-700");
check("unknown status falls back to gray", getStatusBadgeStyle("future_status").label, "future_status");
check("unknown status uses gray bg", getStatusBadgeStyle("future_status").bg, "bg-gray-50");

// ----- appointmentEditHref / drawerTargetFromQuery -----
// "Editar" on the appointment page pushed /dashboard/appointments/:id/edit,
// which does not exist. It now opens the agenda's drawer in edit mode.

console.log("\n[appointmentEditHref]");
const editHref = appointmentEditHref("apt-1");
check("points at the agenda, not a /edit page", editHref, "/dashboard/appointments?appointment=apt-1&edit=1");
const editParams = new URLSearchParams(editHref.split("?")[1]);
check("the agenda reads it back as 'edit this appointment'", drawerTargetFromQuery(editParams), {
  mode: "existing",
  appointmentId: "apt-1",
  edit: true,
});
check("?appointment= alone opens it in view mode", drawerTargetFromQuery(new URLSearchParams("appointment=apt-2")), {
  mode: "existing",
  appointmentId: "apt-2",
  edit: false,
});
check("?new=true still opens a new appointment", drawerTargetFromQuery(new URLSearchParams("new=true")), { mode: "new" });
check("no params, nothing to open", drawerTargetFromQuery(new URLSearchParams("")), null);
checkTrue(
  "no link to the non-existent /edit page is left in the detail page",
  !fs.readFileSync(path.join(__dirname, "..", "[id]", "page.tsx"), "utf8").includes("/edit`"),
);

// ----- Status changes -----

console.log("\nStatus changes");

checkTrue("completed and cancelled offer nothing", statusActions("completed").length === 0 && statusActions("cancelled").length === 0);
check("pending: confirm, no-show, cancel", statusActions("pending"), ["confirmed", "no_show", "cancelled"]);
check("confirmed: start, no-show, cancel", statusActions("confirmed"), ["in_progress", "no_show", "cancelled"]);
check("in progress: complete or cancel, not a no-show", statusActions("in_progress"), ["completed", "cancelled"]);
check("a no-show can be confirmed again (arrived late)", statusActions("no_show"), ["confirmed"]);
checkTrue("every button is one the table allows", (["pending", "confirmed", "in_progress", "no_show"] as const).every((from) => statusActions(from).every((to) => canChangeStatus(from, to))));
checkTrue("an unknown status offers nothing", statusActions("archived").length === 0);

{
  const calls: string[] = [];
  const api = {
    cancelAppointment: (id: string, reason?: string) => (calls.push(`cancel ${id} ${reason ?? "-"}`), Promise.resolve()),
    completeAppointment: (id: string) => (calls.push(`complete ${id}`), Promise.resolve()),
    markAppointmentNoShow: (id: string) => (calls.push(`no-show ${id}`), Promise.resolve()),
    updateAppointment: (id: string, data: { status: string }) => (calls.push(`patch ${id} ${data.status}`), Promise.resolve()),
  };
  void sendStatusChange(api, "a1", "cancelled", "  Enferma ");
  void sendStatusChange(api, "a1", "cancelled", "   ");
  void sendStatusChange(api, "a1", "completed");
  void sendStatusChange(api, "a1", "no_show");
  void sendStatusChange(api, "a1", "confirmed");
  void sendStatusChange(api, "a1", "in_progress");
  check("each change goes to the route that owns it", calls, [
    "cancel a1 Enferma",
    "cancel a1 -",
    "complete a1",
    "no-show a1",
    "patch a1 confirmed",
    "patch a1 in_progress",
  ]);
}

checkTrue("cancel, no-show and complete are asked first", asksFirst("cancelled") && asksFirst("no_show") && asksFirst("completed"));
checkTrue("confirm and start are not", !asksFirst("confirmed") && !asksFirst("in_progress"));
{
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "messages", "es.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "messages", "en.json"), "utf8"));
  const has = (json: any, key: string) => typeof key.split(".").reduce((o, k) => o?.[k], json) === "string";
  checkTrue("every status badge label exists in es and en", Object.keys(NEXT_STATUSES).every((s) => has(es, statusLabelKey(s)!) && has(en, statusLabelKey(s)!)));
  check("an unknown status has no label key", statusLabelKey("archived"), null);
  checkTrue("the completion dialog's copy exists in es and en", ["complete_confirm", "complete_notice", "mark_completed", "not_yet"].every((k) => has(es, `appointments.${k}`) && has(en, `appointments.${k}`)));
  checkTrue("and it warns about the invoice", /factura/.test(es.appointments.complete_notice));
}
check("the server's reason reaches the toast", serverMessage(new Error("Una cita cancelada no puede pasar a completada.")), "Una cita cancelada no puede pasar a completada.");
check("no reason, no description", serverMessage(new Error("  ")), undefined);
check("not an error, no description", serverMessage("boom"), undefined);

// The panel's copy of the transition table must match the server's.
{
  const backendTable = path.join(__dirname, "..", "..", "..", "..", "..", "backend", "src", "appointments", "appointment-status.ts");
  if (fs.existsSync(backendTable)) {
    const src = fs.readFileSync(backendTable, "utf8");
    const server: Record<string, string[]> = {};
    for (const m of src.matchAll(/\[AppointmentStatus\.(\w+)\]:\s*\[([^\]]*)\]/g)) {
      server[m[1]] = [...m[2].matchAll(/AppointmentStatus\.(\w+)/g)].map((x) => x[1]);
    }
    check("same transition table as the server", server, NEXT_STATUSES);
  } else {
    console.log("  - server table not found; skipped the comparison");
  }
}
// ----- staffOwnCatalog: what a professional books with -----

console.log("\n=== staffOwnCatalog ===");
{
  const pros = [
    { id: "p-ana", userId: "u-ana", firstName: "Ana", services: [{ serviceId: "cut" }] },
    { id: "p-bea", userId: "u-bea", firstName: "Bea", services: [{ serviceId: "colour" }] },
    { id: "p-eva", userId: null, firstName: "Eva", services: [] },
  ];
  const svcs = [{ id: "cut" }, { id: "colour" }, { id: "nails" }];
  const own = staffOwnCatalog("u-ana", pros, svcs);
  check("finds the caller's professional by their login", own?.me.id, "p-ana");
  check("only themself to book on", own?.professionals.map((p) => p.id), ["p-ana"]);
  check("only the services they perform", own?.services.map((s) => s.id), ["cut"]);
  check(
    "every service when none is linked to them",
    staffOwnCatalog("u-eva", [{ ...pros[2], userId: "u-eva" }], svcs)?.services.length,
    3,
  );
  check("null for an account with no professional", staffOwnCatalog("u-nobody", pros, svcs), null);
  check("null without a user id", staffOwnCatalog(undefined, pros, svcs), null);
}

// ----- buildStaffBookingPayload: one request for the whole visit -----

console.log("\n=== buildStaffBookingPayload ===");
{
  const form = {
    clientId: "c1",
    serviceId: "",
    professionalId: "",
    date: "2026-12-07",
    time: "10:00",
    notes: "",
    selectedServices: [] as Array<{ serviceId: string; professionalId?: string; isParallel?: boolean }>,
    depositRequired: false,
    depositAmount: 0,
  };

  check(
    "a professional's single service: their own professional, no commission",
    buildStaffBookingPayload({
      ...form,
      role: "staff",
      ownProfessionalId: "p-ana",
      selectedServices: [{ serviceId: "cut", professionalId: "p-ana" }],
      commissionRate: 100,
    }),
    { clientId: "c1", serviceId: "cut", professionalId: "p-ana", scheduledDate: "2026-12-07", scheduledTime: "10:00" },
  );

  const visit = buildStaffBookingPayload({
    ...form,
    role: "owner",
    selectedServices: [
      { serviceId: "colour", professionalId: "p-bea" },
      { serviceId: "cut" },
      { serviceId: "nails", isParallel: true },
    ],
    autoAssign: { cut: "p-ana" },
  });
  check("several services go in the same request, in order", visit?.services, [
    { serviceId: "colour", professionalId: "p-bea", isParallel: false },
    { serviceId: "cut", professionalId: "p-ana", isParallel: false },
    { serviceId: "nails", professionalId: "p-bea", isParallel: true },
  ]);
  check("the appointment is the first service's", [visit?.serviceId, visit?.professionalId], ["colour", "p-bea"]);
  checkTrue("no timing sent: the server times the rows", !JSON.stringify(visit).includes("scheduledStart"));

  check(
    "the commission is sent only when an owner typed one",
    [
      buildStaffBookingPayload({ ...form, role: "owner", serviceId: "cut", professionalId: "p-ana" })?.commissionRate,
      buildStaffBookingPayload({ ...form, role: "owner", serviceId: "cut", professionalId: "p-ana", commissionRate: 0 })?.commissionRate,
      buildStaffBookingPayload({ ...form, role: "admin", serviceId: "cut", professionalId: "p-ana", commissionRate: 35 })?.commissionRate,
    ],
    [undefined, 0, 35],
  );
  check(
    "the deposit in cents, only when asked for",
    buildStaffBookingPayload({ ...form, role: "owner", serviceId: "cut", professionalId: "p-ana", depositRequired: true, depositAmount: 12.5 })?.depositAmount,
    1250,
  );
  check(
    "a confirmed booking outside hours says so",
    buildStaffBookingPayload({ ...form, role: "owner", serviceId: "cut", professionalId: "p-ana", allowOutsideHours: true })?.allowOutsideHours,
    true,
  );
  check(
    "an owner has to choose a professional",
    buildStaffBookingPayload({ ...form, role: "owner", serviceId: "cut" }),
    null,
  );
  check("a client, a service, a day and a time are needed", [
    buildStaffBookingPayload({ ...form, role: "staff", clientId: "", serviceId: "cut" }),
    buildStaffBookingPayload({ ...form, role: "staff" }),
    buildStaffBookingPayload({ ...form, role: "staff", serviceId: "cut", time: "" }),
  ], [null, null, null]);
}
checkTrue(
  "the drawer no longer adds the services in a second request",
  !fs.readFileSync(path.join(__dirname, "appointment-drawer", "appointment-drawer.tsx"), "utf8").includes("bulkCreateAppointmentServices"),
);
checkTrue(
  "the drawer no longer reads /admin/professionals for a professional's services",
  !fs.readFileSync(path.join(__dirname, "appointment-drawer", "hooks", "useAppointmentCatalog.ts"), "utf8").includes("getProfessional("),
);

{
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "messages", "es.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "messages", "en.json"), "utf8"));
  const get = (o: any, key: string) => key.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const files = walk(path.join(__dirname, "..")).filter((f) => /\.tsx?$/.test(f) && !/\.spec\.ts$/.test(f));
  const keys = new Set<string>();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/\bt\(\s*["']([a-zA-Z0-9_.]+)["']/g)) keys.add(m[1]);
  }
  const missing = [...keys].filter((k) => typeof get(es, k) !== "string" || typeof get(en, k) !== "string");
  check("every string the appointment pages use exists in es and en", missing, []);
  checkTrue("the quantity label is a real key", keys.has("appointments.quantity") && !keys.has("appointments.common.quantity"));
  check(
    "no English left in the Spanish appointment strings",
    ["services", "professionals", "professionals_description"].filter((k) => /Services|Professionals|Description/.test(es.appointments[k])),
    [],
  );
  const source = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  checkTrue("no dollar prices in the appointment pages", !/>\s*\$\s*\{|\$\{\(|>\$\{|DollarSign/.test(source));
  checkTrue("no en-US dates in the appointment pages", !source.includes("en-US"));
  checkTrue("no console.log printing client data", !/console\.log\(/.test(source));
}

// ----- Summary -----

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All appointment-drawer.utils tests passed.");
}