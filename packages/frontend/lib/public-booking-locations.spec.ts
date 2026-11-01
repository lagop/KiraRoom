/**
 * The public booking page's location step (multi-local): which locations,
 * the deep link, who and what can be booked at each, the location that
 * follows from a professional, and what the page sends.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/public-booking-locations.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  bookingLocations,
  chosenLocation,
  confirmedPlace,
  locationForProfessional,
  locationFromQuery,
  locationReady,
  professionalsAtLocation,
  professionalsForService,
  servicesAtLocation,
} from "./public-booking-locations";

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

const CENTRO = { id: "l-centro", name: "Centro", slug: "centro", address: "Calle Mayor 1, 28013 Madrid", phone: null };
const NORTE = { id: "l-norte", name: "Norte", slug: "norte", address: "", phone: null };
const LOCATIONS = [CENTRO, NORTE];

// Ana cuts at Centro; Bea colours at both, Norte her main one; Carla (nails)
// works at Norte; Dani has no location.
const ANA = { id: "ana", locationIds: ["l-centro"], primaryLocationId: "l-centro", services: [{ serviceId: "cut" }] };
const BEA = { id: "bea", locationIds: ["l-centro", "l-norte"], primaryLocationId: "l-norte", services: [{ serviceId: "colour" }] };
const CARLA = { id: "carla", locationIds: ["l-norte"], primaryLocationId: "l-norte", services: [{ service: { id: "nails" } }] };
const DANI = { id: "dani", services: [] as Array<{ serviceId: string }> };
const TEAM = [ANA, BEA, CARLA, DANI];
const SERVICES = [{ id: "cut" }, { id: "colour" }, { id: "nails" }, { id: "brow" }];
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

console.log("which locations");
same("one location: no step", bookingLocations({ locations: [CENTRO] }), []);
same("none, or an older server: no step", bookingLocations({}), []);
same("two: both", ids(bookingLocations({ locations: LOCATIONS })), ["l-centro", "l-norte"]);

console.log("the deep link");
same("?locationId=<id>", locationFromQuery(new URLSearchParams("locationId=l-norte"), LOCATIONS), "l-norte");
same("?location=<slug>", locationFromQuery(new URLSearchParams("location=Centro"), LOCATIONS), "l-centro");
same("?location=<id> works too", locationFromQuery(new URLSearchParams("location=l-norte"), LOCATIONS), "l-norte");
same("an unknown one is ignored", locationFromQuery(new URLSearchParams("location=sur"), LOCATIONS), "");
same("a single-location salon ignores it", locationFromQuery(new URLSearchParams("location=centro"), []), "");

console.log("who does the service");
same("the linked ones", ids(professionalsForService(TEAM, "colour")), ["bea"]);
same("linked through service.id too", ids(professionalsForService(TEAM, "nails")), ["carla"]);
same("nobody linked: everyone", ids(professionalsForService(TEAM, "brow")), ["ana", "bea", "carla", "dani"]);
same("no service yet: nobody", professionalsForService(TEAM, ""), []);

console.log("who can be booked where");
same("no location step: everyone", ids(professionalsAtLocation(TEAM, [], "")), ["ana", "bea", "carla", "dani"]);
same("step, none chosen: who works at any", ids(professionalsAtLocation(TEAM, LOCATIONS, "")), ["ana", "bea", "carla"]);
same("at Centro", ids(professionalsAtLocation(TEAM, LOCATIONS, "l-centro")), ["ana", "bea"]);
same("at Norte", ids(professionalsAtLocation(TEAM, LOCATIONS, "l-norte")), ["bea", "carla"]);

console.log("what can be booked where");
same("no step: every service", ids(servicesAtLocation(SERVICES, TEAM, [], "l-centro")), ["cut", "colour", "nails", "brow"]);
same("none chosen: every service", ids(servicesAtLocation(SERVICES, TEAM, LOCATIONS, "")), ["cut", "colour", "nails", "brow"]);
same(
  "at Centro: not the nails (only Carla, at Norte); a service nobody is linked to is anyone's",
  ids(servicesAtLocation(SERVICES, TEAM, LOCATIONS, "l-centro")),
  ["cut", "colour", "brow"],
);
same("at Norte: no cut (only Ana, at Centro)", ids(servicesAtLocation(SERVICES, TEAM, LOCATIONS, "l-norte")), ["colour", "nails", "brow"]);

console.log("the location from the professional");
same("only one: it", locationForProfessional(ANA, LOCATIONS, ""), "l-centro");
same("several, none chosen: her main one", locationForProfessional(BEA, LOCATIONS, ""), "l-norte");
same("several, one of hers chosen: it stays", locationForProfessional(BEA, LOCATIONS, "l-centro"), "l-centro");
same("no location step: none", locationForProfessional(ANA, [], ""), "");
same("no professional: none", locationForProfessional(undefined, LOCATIONS, ""), "");

console.log("ready for times");
check("no step: always", locationReady([], ""));
check("step: not without a location", !locationReady(LOCATIONS, ""));
check("step: with one", locationReady(LOCATIONS, "l-norte"));
same("the chosen one, for the confirmation", chosenLocation(LOCATIONS, "l-centro"), CENTRO);
same("none chosen", chosenLocation(LOCATIONS, ""), null);
same(
  "the confirmation names where the server booked it",
  confirmedPlace(LOCATIONS, "l-centro", { location: { id: "l-norte", name: "Norte", address: "Av. Norte 5, 28035 Madrid" } }),
  { name: "Norte", address: "Av. Norte 5, 28035 Madrid" },
);
same("an answer without one: the location picked", confirmedPlace(LOCATIONS, "l-centro", { location: null }), {
  name: CENTRO.name,
  address: CENTRO.address ?? "",
});
same("no location step: nothing, whatever the answer", confirmedPlace([], "", { location: { name: "Centro", address: "x" } }), null);

console.log("the page");
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const page = read("app/sites/[salonName]/salon-booking-page.tsx");
check("shows the location step only with locations", page.includes("locations.length > 0 && ("));
check("asks for slots at the location", /bookingData\.locationId \|\| undefined,\s*\);/.test(page));
check("books at the location", page.includes("locationId: bookingData.locationId"));
check("the confirmation names the location", page.includes("bookingPublic.booked_at_address"));
const api = read("lib/api.ts");
check("the slots request carries locationId", api.includes("&locationId=${encodeURIComponent(locationId)}"));
const es = JSON.parse(read("messages/es.json"));
const en = JSON.parse(read("messages/en.json"));
for (const key of ["step_location", "select_location", "booked_at", "booked_at_address"]) {
  check(`es.json and en.json have bookingPublic.${key}`, !!es.bookingPublic[key] && !!en.bookingPublic[key]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
