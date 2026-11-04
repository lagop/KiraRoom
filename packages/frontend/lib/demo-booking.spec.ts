/**
 * Run via:
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/demo-booking.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import { demoSlots } from "./demo-booking";

let fail = 0;
function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) fail += 1;
}

console.log("the booking demo's example times (R20)");
check("a weekday has morning and afternoon times", demoSlots("2026-11-10").some((t) => t < "14:00") && demoSlots("2026-11-10").some((t) => t > "15:00"));
check("some are taken, as in a real day", demoSlots("2026-11-10").length < 16 && demoSlots("2026-11-10").length > 8);
check("the same day gives the same times", JSON.stringify(demoSlots("2026-11-10")) === JSON.stringify(demoSlots("2026-11-10")));
check("Saturday: mornings only", demoSlots("2026-11-14").every((t) => t < "14:00") && demoSlots("2026-11-14").length > 0);
check("Sunday: closed", demoSlots("2026-11-15").length === 0);
check("not a day: nothing", demoSlots("2026-02-30").length === 0 && demoSlots("").length === 0);

const widget = fs.readFileSync(path.join(__dirname, "..", "src", "components", "booking", "BookingWidget.tsx"), "utf8");
check("the demo never asks the API for times", !widget.includes("apiClient"));
check("the demo says nothing is booked", widget.includes("no se ha reservado ninguna cita"));
const page = fs.readFileSync(path.join(__dirname, "..", "app", "example-booking", "page.tsx"), "utf8");
check("the demo page does not claim live availability", !/tiempo real/i.test(page));
check("the demo page uses the demo widget", page.includes("<BookingWidget"));

if (fail > 0) {
  console.log(`\n${fail} failed`);
  process.exit(1);
}
console.log("✓ All demo-booking tests passed.");

export {};
