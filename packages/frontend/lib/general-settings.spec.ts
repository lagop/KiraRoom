/**
 * The salon's general settings page: tenant row -> fields, fields -> save.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/general-settings.spec.ts
 *
 * Fields the page showed under "Próximamente" are now saved (Instagram,
 * Facebook, the booking step, auto-confirming online bookings) or gone.
 */
import { settingsFromTenant, tenantUpdateFrom, type TenantSettingsRow } from "./general-settings";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const TENANT: TenantSettingsRow = {
  id: "t1",
  name: "Salón Luna",
  slug: "salon-luna",
  timezone: "Europe/Madrid",
  currency: "EUR",
  country: "ES",
  language: "es",
  street: "Calle Mayor 1",
  phone: "600000000",
  email: "hola@salonluna.example",
  dateFormat: "DD/MM/YYYY",
  timeFormat: "24h",
  minCancelHours: 24,
  openingHours: [{ day: "monday", openTime: "10:00", closeTime: "14:00" }],
  instagram: "https://www.instagram.com/salonluna/",
  facebook: null,
  bookingSlotMinutes: 15,
  autoConfirmOnlineBookings: true,
};

console.log("\n=== tenant -> fields ===");
const saved = settingsFromTenant(TENANT);
check("Instagram shows the stored profile URL", saved.instagram, "https://www.instagram.com/salonluna/");
check("an unset Facebook is an empty field", saved.facebook, "");
check("the booking step, as the select's option", saved.bookingSlotMinutes, "15");
check("auto-confirm, as the switch's value", saved.autoConfirmOnlineBookings, "true");
const older = settingsFromTenant({ ...TENANT, instagram: undefined, bookingSlotMinutes: undefined, autoConfirmOnlineBookings: undefined });
check("a server without these fields: empty, half hours, off", [older.instagram, older.bookingSlotMinutes, older.autoConfirmOnlineBookings], [
  "",
  "30",
  "false",
]);
check("the formats keep their option ids", [saved.dateFormat, saved.timeFormat, saved.cancellationPolicy], ["dd/mm/yyyy", "24", "24"]);

console.log("\n=== fields -> save ===");
check("nothing changed, nothing sent", tenantUpdateFrom(saved, saved), {});
check(
  "the new fields, in the server's types",
  tenantUpdateFrom(
    { ...saved, facebook: "  salonluna ", bookingSlotMinutes: "60", autoConfirmOnlineBookings: "false" },
    saved,
  ),
  { facebook: "salonluna", bookingSlotMinutes: 60, autoConfirmOnlineBookings: false },
);
check("emptying Instagram clears it", tenantUpdateFrom({ ...saved, instagram: "" }, saved), { instagram: "" });
check(
  "the existing fields as before",
  tenantUpdateFrom({ ...saved, dateFormat: "yyyy/mm/dd", timeFormat: "12", cancellationPolicy: "48" }, saved),
  { dateFormat: "YYYY/MM/DD", timeFormat: "12h", minCancelHours: 48 },
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
