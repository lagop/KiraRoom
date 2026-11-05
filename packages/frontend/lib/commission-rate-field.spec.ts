/**
 * The professionals list's modal: a commission rate of 0 is saved as 0, an
 * emptied field clears the rate, and a save that did not touch it leaves it.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/commission-rate-field.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  commissionRateFieldValue,
  commissionRateForCreate,
  commissionRateForUpdate,
} from "./commission-rate-field";

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
  check(name, Object.is(actual, expected), { actual, expected });
}

console.log("the field as the modal opens");
same("no rate: empty", commissionRateFieldValue(null), "");
same("undefined: empty", commissionRateFieldValue(undefined), "");
same("0 is shown as 0, not as empty", commissionRateFieldValue(0), "0");
same("Prisma's Decimal arrives as a string", commissionRateFieldValue("12.50"), "12.5");
same("a number", commissionRateFieldValue(40), "40");

console.log("an update");
same("untouched: left out", commissionRateForUpdate("40", "40"), undefined);
same("untouched empty: left out", commissionRateForUpdate("", ""), undefined);
same("set to 0: sends 0", commissionRateForUpdate("0", "40"), 0);
same("0 from none: sends 0", commissionRateForUpdate("0", ""), 0);
same("emptied: sends null (clears it)", commissionRateForUpdate("", "40"), null);
same("only spaces count as empty", commissionRateForUpdate("  ", "40"), null);
same("emptied a 0: sends null", commissionRateForUpdate("", "0"), null);
same("a new rate", commissionRateForUpdate("12.5", "40"), 12.5);
same("a decimal comma", commissionRateForUpdate("12,5", "40"), 12.5);
same("same number written differently: left out", commissionRateForUpdate("40.0", "40"), undefined);
same("not a number: left out, never a wipe", commissionRateForUpdate("abc", "40"), undefined);

console.log("a create");
same("0 is sent as 0", commissionRateForCreate("0"), 0);
same("empty: not sent", commissionRateForCreate(""), undefined);
same("a rate", commissionRateForCreate("15"), 15);
same("not a number: not sent", commissionRateForCreate("abc"), undefined);

console.log("the modal");
const page = fs.readFileSync(
  path.join(__dirname, "..", "app", "dashboard", "professionals", "page.tsx"),
  "utf8",
);
check("uses the update rule", page.includes("commissionRateForUpdate("));
check("uses the create rule", page.includes("commissionRateForCreate("));
check("no longer drops a falsy rate", !/if \(formData\.commissionRate\)/.test(page));
check("no longer turns the field into an integer", !page.includes("commissionRate: parseInt("));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
