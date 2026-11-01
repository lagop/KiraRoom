/**
 * A professional's QR code keeps her on the booking page.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/booking-professional.spec.ts
 */
import { performsService, professionalAfterServiceChange, servicesForPinned } from "./booking-professional";

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

const services = [{ id: "cut" }, { id: "color" }, { id: "nails" }];
const ana = { id: "ana", firstName: "Ana", services: [{ service: { id: "cut" } }, { serviceId: "color" }] };
const eva = { id: "eva", firstName: "Eva", services: [{ service: { id: "nails" } }] };
const newcomer = { id: "new", firstName: "Nueva", services: [] };
const pros = [ana, eva, newcomer];

check("no pinned professional: every service", servicesForPinned(services, undefined).length === 3);
check(
  "pinned: only the services she does",
  JSON.stringify(servicesForPinned(services, ana).map((s) => s.id)) === JSON.stringify(["cut", "color"]),
  servicesForPinned(services, ana),
);
check("pinned with no services linked: every service rather than none", servicesForPinned(services, newcomer).length === 3);
check(
  "pinned with only services no longer offered online: every service",
  servicesForPinned([{ id: "other" }], ana).length === 1,
);

check("she does it", performsService(ana, "cut") && !performsService(ana, "nails"));
check("nobody linked: counts as doing it", performsService(newcomer, "nails"));
check("unknown professional does nothing", !performsService(undefined, "cut"));

check("choosing a service she does keeps her", professionalAfterServiceChange("ana", "color", pros) === "ana");
check("choosing one she does not clears her", professionalAfterServiceChange("ana", "nails", pros) === "");
check("nobody chosen stays nobody", professionalAfterServiceChange("", "cut", pros) === "");
check("clearing the service keeps her", professionalAfterServiceChange("ana", "", pros) === "ana");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
