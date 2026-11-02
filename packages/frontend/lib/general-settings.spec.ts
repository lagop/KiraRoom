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
  country: "ES",
  language: "es",
  street: "Calle Mayor 1",
  phone: "600000000",
  email: "hola@salonluna.example",
  minCancelHours: 24,
  cancellationPolicy: "Avísanos si no puedes venir.",
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
check("the notice as the select's option, the policy text as written", [saved.minCancelHours, saved.cancellationPolicyText], ["24", "Avísanos si no puedes venir."]);
check("no currency, date format or time format fields", ["currency", "dateFormat", "timeFormat"].filter((k) => k in saved), []);
check("'Sin política' (0) stays 0", settingsFromTenant({ ...TENANT, minCancelHours: 0 }).minCancelHours, "0");

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
  tenantUpdateFrom({ ...saved, minCancelHours: "0", cancellationPolicyText: "  Sin cargos, avisa cuando puedas. " }, saved),
  { minCancelHours: 0, cancellationPolicy: "Sin cargos, avisa cuando puedas." },
);
check("emptying the policy text clears it (null)", tenantUpdateFrom({ ...saved, cancellationPolicyText: " " }, saved), {
  cancellationPolicy: null,
});

// Emptying the contact email or phone used to answer "email must be an email" in English.
check(
  "emptying the contact email or phone clears them (null)",
  tenantUpdateFrom({ ...saved, contactEmail: "  ", contactPhone: "" }, saved),
  { phone: null, email: null },
);
check(
  "a contact email or phone is sent trimmed",
  tenantUpdateFrom({ ...saved, contactEmail: " hola@salon.test ", contactPhone: " 600 111 222 " }, saved),
  { phone: "600 111 222", email: "hola@salon.test" },
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
