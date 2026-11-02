/**
 * The "Últimos recordatorios enviados" card shows dates in the salon's
 * timezone and the channel and status in Spanish.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/rebooking-log.spec.ts
 */
import { formatSalonDateTime, rebookingChannelKey, rebookingStatusKey } from "./rebooking-log";

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

// 23:30 UTC on 31 October is already 1 November in Madrid (UTC+1), and still
// 31 October, 23:30, in the Canaries (UTC+0).
const late = "2026-10-31T23:30:00.000Z";
check("Madrid: the next day, 00:30", /1 nov 2026.*00:30/.test(formatSalonDateTime(late, "Europe/Madrid")), true);
check("Canarias: the same day, 23:30", /31 oct 2026.*23:30/.test(formatSalonDateTime(late, "Atlantic/Canary")), true);
check("no date: a dash", formatSalonDateTime(null, "Europe/Madrid"), "—");
check("an unknown timezone falls back to Madrid", /1 nov 2026/.test(formatSalonDateTime(late, "Not/AZone")), true);
check("channels", ["email", "whatsapp", "both"].map(rebookingChannelKey), [
  "rebooking.settings.channelEmail",
  "rebooking.settings.channelWhatsapp",
  "rebooking.settings.channelBoth",
]);
check("statuses", ["sent", "failed", "weird"].map(rebookingStatusKey), [
  "rebooking.status.sent",
  "rebooking.status.failed",
  "rebooking.status.unknown",
]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
