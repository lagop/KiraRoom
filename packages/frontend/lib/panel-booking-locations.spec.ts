/**
 * The panel's locations (multi-local): booking, editing, and the agenda's
 * location filter. A salon with one location sees none of it.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/panel-booking-locations.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  NO_BOOKING_LOCATIONS,
  appointmentsAtLocation,
  columnsAtLocation,
  currentLocationOf,
  hasLocations,
  keepIfWorksAt,
  locationAfterProfessionalChange,
  locationForEdit,
  locationForNewBooking,
  mainLocationOf,
  professionalsAtLocation,
  worksAt,
  type BookingLocations,
} from "./panel-booking-locations";

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
function same(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** Centro and Norte. Ana works at both (Centro is her main one), Bea at Norte, Carla nowhere yet. */
const SALON: BookingLocations = {
  locations: [
    { id: "l-centro", name: "Centro", slug: "centro", address: "Calle Mayor 1, 28013 Madrid", phone: null },
    { id: "l-norte", name: "Norte", slug: "norte", address: "Av. Norte 5, 28035 Madrid", phone: null },
  ],
  professionals: [
    { id: "ana", locationIds: ["l-centro", "l-norte"], primaryLocationId: "l-centro" },
    { id: "bea", locationIds: ["l-norte"], primaryLocationId: null },
  ],
};
const TEAM = [{ id: "ana" }, { id: "bea" }, { id: "carla" }];

console.log("a salon with one location");
check("no choice", !hasLocations(NO_BOOKING_LOCATIONS));
same("everyone offered", professionalsAtLocation(TEAM, NO_BOOKING_LOCATIONS, "l-centro"), TEAM);
same("nothing sent for a new booking", locationForNewBooking(NO_BOOKING_LOCATIONS, "l-centro"), undefined);
same("nothing sent for an edit", locationForEdit(NO_BOOKING_LOCATIONS, "", "l-centro"), undefined);
same("no current location", currentLocationOf(NO_BOOKING_LOCATIONS, { locationId: "l-centro", professionalId: "ana" }), "");
const apts = [{ id: "1", professionalId: "ana", locationId: null }];
same("the agenda unfiltered", appointmentsAtLocation(apts, NO_BOOKING_LOCATIONS, "l-norte"), apts);
same("the columns unfiltered", columnsAtLocation(TEAM, NO_BOOKING_LOCATIONS, "l-norte", []), TEAM);

console.log("where professionals work");
check("multi-local", hasLocations(SALON));
same("Ana's main one is her primary", mainLocationOf(SALON, "ana"), "l-centro");
same("Bea's is her only one", mainLocationOf(SALON, "bea"), "l-norte");
same("Carla has none (the server decides)", mainLocationOf(SALON, "carla"), null);
check("Ana works at Norte", worksAt(SALON, "ana", "l-norte"));
check("Bea does not work at Centro", !worksAt(SALON, "bea", "l-centro"));

console.log("a new booking");
same("no location picked: everyone", professionalsAtLocation(TEAM, SALON, "").map((p) => p.id), ["ana", "bea", "carla"]);
same("Centro: only Ana", professionalsAtLocation(TEAM, SALON, "l-centro").map((p) => p.id), ["ana"]);
same("Norte: Ana and Bea", professionalsAtLocation(TEAM, SALON, "l-norte").map((p) => p.id), ["ana", "bea"]);
same("the one picked is sent", locationForNewBooking(SALON, "l-norte"), "l-norte");
same("none picked: nothing (the professional's main one)", locationForNewBooking(SALON, ""), undefined);
same("an unknown one is not sent", locationForNewBooking(SALON, "l-gone"), undefined);
same("moving to Centro clears Bea", keepIfWorksAt(SALON, "bea", "l-centro"), "");
same("and keeps Ana", keepIfWorksAt(SALON, "ana", "l-centro"), "ana");

console.log("editing");
same("its own location", currentLocationOf(SALON, { locationId: "l-norte", professionalId: "ana" }), "l-norte");
same("an older one without: its professional's main one", currentLocationOf(SALON, { locationId: null, professionalId: "ana" }), "l-centro");
same("to Bea from Centro: her main one", locationAfterProfessionalChange(SALON, "l-centro", "bea"), "l-norte");
same("to Ana at Norte: it stays", locationAfterProfessionalChange(SALON, "l-norte", "ana"), "l-norte");
same("unchanged: nothing sent", locationForEdit(SALON, "l-centro", "l-centro"), undefined);
same("moved: the new one sent", locationForEdit(SALON, "l-centro", "l-norte"), "l-norte");

console.log("the agenda's location filter");
const day = [
  { id: "a1", professionalId: "ana", locationId: "l-norte" },
  { id: "a2", professionalId: "ana", locationId: null }, // before locations: Ana's main one, Centro
  { id: "b1", professionalId: "bea", locationId: "l-norte" },
  { id: "c1", professionalId: "carla", locationId: "l-centro" }, // Carla, not assigned, booked at Centro
];
same("all of them with none picked", appointmentsAtLocation(day, SALON, "").map((a) => a.id), ["a1", "a2", "b1", "c1"]);
same("Centro: its own and the older one of Ana's", appointmentsAtLocation(day, SALON, "l-centro").map((a) => a.id), ["a2", "c1"]);
same("Norte", appointmentsAtLocation(day, SALON, "l-norte").map((a) => a.id), ["a1", "b1"]);
same(
  "Centro's columns: Ana, and Carla who has an appointment there",
  columnsAtLocation(TEAM, SALON, "l-centro", appointmentsAtLocation(day, SALON, "l-centro")).map((p) => p.id),
  ["ana", "carla"],
);
same("Norte's columns", columnsAtLocation(TEAM, SALON, "l-norte", appointmentsAtLocation(day, SALON, "l-norte")).map((p) => p.id), ["ana", "bea"]);

console.log("the panel");
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
check("the drawer has the picker", read("app/dashboard/appointments/components/appointment-drawer/appointment-drawer.tsx").includes("<LocationSelect"));
check("the new-appointment popover has it", read("components/Calendar/NewAppointmentPopover.tsx").includes("<LocationSelect"));
check("the edit popover has it", read("components/Calendar/EditAppointmentPopover.tsx").includes("<LocationSelect"));
check("the agenda has the filter", read("app/dashboard/appointments/page.tsx").includes('id="filter-location"'));
check("the calendar takes it", read("components/Calendar/Calendar.tsx").includes("appointmentsAtLocation("));
const es = JSON.parse(read("messages/es.json"));
const en = JSON.parse(read("messages/en.json"));
for (const key of ["label", "all", "professionalsMain", "bookedAt", "onlyHere"]) {
  check(`es.json and en.json have appointments.locations.${key}`, !!es.appointments.locations?.[key] && !!en.appointments.locations?.[key]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
