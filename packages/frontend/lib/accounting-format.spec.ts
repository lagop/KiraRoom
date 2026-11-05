/**
 * Contabilidad: export defaults in the salon's day; the Holded log in Spanish.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/accounting-format.spec.ts
 */
import { accountingActionKey, accountingStatusKey, quarterStartOf, salonDay } from "./accounting-format";

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

// 00:30 in Madrid on 1 October is still 30 September in UTC.
const justAfterMidnight = new Date("2026-09-30T22:30:00.000Z");
check("Madrid: today is 1 October", salonDay(justAfterMidnight, "Europe/Madrid"), "2026-10-01");
check("Madrid: the quarter is Q4", quarterStartOf(salonDay(justAfterMidnight, "Europe/Madrid")), "2026-10-01");
check("Canarias: still 30 September (Q3)", quarterStartOf(salonDay(justAfterMidnight, "Atlantic/Canary")), "2026-07-01");
check("an unknown timezone counts as Madrid", salonDay(justAfterMidnight, "Not/AZone"), "2026-10-01");
check("quarter starts", ["2026-01-31", "2026-03-31", "2026-04-01", "2026-12-31"].map(quarterStartOf), [
  "2026-01-01",
  "2026-01-01",
  "2026-04-01",
  "2026-10-01",
]);
check("actions", ["sync", "cancel", "connect", "unlink", "weird"].map(accountingActionKey), [
  "accounting.logActions.sync",
  "accounting.logActions.cancel",
  "accounting.logActions.connect",
  "accounting.logActions.unlink",
  "accounting.logActions.other",
]);
check("statuses", [accountingStatusKey("sync", "ok"), accountingStatusKey("sync", "error"), accountingStatusKey("cancel", "error")], [
  "accounting.logStatuses.ok",
  "accounting.logStatuses.error",
  "accounting.logStatuses.notReflected",
]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
