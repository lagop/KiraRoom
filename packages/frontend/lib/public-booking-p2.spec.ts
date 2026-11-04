/**
 * Audit 5, phase 2 on the booking screens: "Cualquier profesional" on the
 * salon page, the hidden field for bots, the pending text, and the
 * "Cancelar mi cita" page.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/public-booking-p2.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import { ANY_PROFESSIONAL, choiceAtLocation, professionalToSend } from "./public-booking-locations";
import { professionalAfterServiceChange } from "./booking-professional";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, { actual, expected });
  }
}

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("\n=== Cualquier profesional ===");
check("sent as no professional", professionalToSend(ANY_PROFESSIONAL), "");
check("a real id goes as it is", professionalToSend("p1"), "p1");
check("kept when the service changes", professionalAfterServiceChange(ANY_PROFESSIONAL, "cut", []), ANY_PROFESSIONAL);
check(
  "kept at another location while the service is offered there",
  choiceAtLocation({ serviceId: "", professionalId: ANY_PROFESSIONAL }, [], [], [], "loc-1").professionalId,
  ANY_PROFESSIONAL,
);
const page = read("app/sites/[salonName]/salon-booking-page.tsx");
check("the salon page offers it", page.includes('data-test="booking-any-professional"'), true);
check("the salon page sends it as no professional", page.includes("professionalId: professionalToSend(bookingData.professionalId)"), true);
check("and asks the slots of anyone", page.includes("professionalToSend(bookingData.professionalId),"), true);

console.log("\n=== the hidden field ===");
for (const rel of ["app/sites/[salonName]/salon-booking-page.tsx", "app/embed/[token]/page.tsx"]) {
  const src = read(rel);
  check(`${rel} has it`, src.includes("<HoneypotField value={website} onChange={setWebsite} />"), true);
  check(`${rel} sends it only when filled in`, src.includes("...(website ? { website } : {})"), true);
}
const field = read("components/booking/honeypot-field.tsx");
check("out of reach for people", ["aria-hidden=\"true\"", "tabIndex={-1}", 'autoComplete="off"', 'name="website"'].every((s) => field.includes(s)), true);

console.log("\n=== the pending text ===");
const es = JSON.parse(read("messages/es.json"));
const en = JSON.parse(read("messages/en.json"));
check("Spanish", es.bookingPublic.status_pending, "Hemos recibido tu solicitud. {salon} te confirmará la cita.");
check("never 'confirmada' before it is", /confirmada/i.test(es.bookingPublic.status_pending), false);
for (const key of ["status_pending", "any_professional", "any_professional_hint"]) {
  check(`en has ${key}`, typeof en.bookingPublic[key], "string");
}

console.log("\n=== the cancel page ===");
const cancel = read("app/public/cita/[token]/page.tsx");
check("opening it only reads (GET)", /fetch\(`\$\{API\}\/public\/appointments\/\$\{encodeURIComponent\(token\)\}`\)/.test(cancel), true);
check("the button POSTs", cancel.includes("/cancel`, { method: \"POST\" }"), true);
check("inside the window: call the salon", cancel.includes("Ya no se puede cancelar online, llama al salón"), true);
check("no rescheduling", /reprogramar|cambiar de hora/i.test(cancel), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
