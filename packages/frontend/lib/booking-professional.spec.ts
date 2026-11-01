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

// "toner" is linked to nobody: everyone does it (as the professional list says).
const services = [{ id: "cut" }, { id: "color" }, { id: "nails" }, { id: "toner" }];
const ana = { id: "ana", services: [{ service: { id: "cut" } }, { serviceId: "color" }] };
const eva = { id: "eva", services: [{ service: { id: "nails" } }] };
const newcomer = { id: "new", services: [] as Array<{ serviceId?: string }> };
const pros = [ana, eva, newcomer];
const ids = (list: Array<{ id: string }>) => list.map((s) => s.id).join();

check("no pinned professional: every service", servicesForPinned(services, undefined, pros).length === 4);
check(
  "pinned: the services she does, plus those nobody is linked to",
  ids(servicesForPinned(services, ana, pros)) === "cut,color,toner",
  ids(servicesForPinned(services, ana, pros)),
);
check(
  "pinned with no services linked: those nobody is linked to",
  ids(servicesForPinned(services, newcomer, pros)) === "toner",
);
check(
  "pinned but none of the offered services is hers: every service rather than none",
  servicesForPinned([{ id: "nails" }], ana, pros).length === 1,
);

check("she does it", performsService(ana, "cut", pros) && !performsService(ana, "nails", pros));
check("a service nobody is linked to: everyone does it", performsService(newcomer, "toner", pros));
check("unknown professional does nothing", !performsService(undefined, "cut", pros));

check("choosing a service she does keeps her", professionalAfterServiceChange("ana", "color", pros) === "ana");
check("choosing one she does not clears her", professionalAfterServiceChange("ana", "nails", pros) === "");
check("nobody chosen stays nobody", professionalAfterServiceChange("", "cut", pros) === "");
check("clearing the service keeps her", professionalAfterServiceChange("ana", "", pros) === "ana");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
