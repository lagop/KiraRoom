/**
 * The Comisiones page's amounts and dates (lib/commissions-format.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/commissions-format.spec.ts
 */
import {
  commissionShare,
  defaultPayrollRange,
  formatCommissionCents,
  formatCommissionDay,
} from "./commissions-format";

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
const plain = (s: string) => s.replace(/[  ]/g, " ");

// The API returns cents: 3000 is 30 euros, not 3.000.
check("cents are shown as euros", plain(formatCommissionCents(3000)) === "30,00 €", formatCommissionCents(3000));
check("thousands the Spanish way", plain(formatCommissionCents(123456)) === "1.234,56 €", formatCommissionCents(123456));
check("big amounts too", plain(formatCommissionCents(1234567)) === "12.345,67 €", formatCommissionCents(1234567));
check("a refund adjustment is negative", plain(formatCommissionCents(-100)) === "-1,00 €", formatCommissionCents(-100));
check("a half cent from a rate is rounded", plain(formatCommissionCents(1234.5)) === "12,35 €", formatCommissionCents(1234.5));
check("nothing is 0,00 €", plain(formatCommissionCents(undefined)) === "0,00 €" && plain(formatCommissionCents(NaN)) === "0,00 €");

check("share of sales is unit-free", plain(commissionShare(300, 3000)) === "10,0 %", commissionShare(300, 3000));
check("no sales, 0,0 %", plain(commissionShare(-100, 0)) === "0,0 %", commissionShare(-100, 0));

check("a calendar day is not shifted", formatCommissionDay("2026-11-30").includes("30") && formatCommissionDay("2026-11-30").includes("2026"), formatCommissionDay("2026-11-30"));
check("no day, a dash", formatCommissionDay(undefined) === "—" && formatCommissionDay("nope") === "—");

const range = defaultPayrollRange(new Date(2026, 10, 1, 0, 30));
check("default period: 1st of the month to today, local calendar", range.startDate === "2026-11-01" && range.endDate === "2026-11-01", range);
const later = defaultPayrollRange(new Date(2026, 1, 28, 23, 50));
check("late in the day it is still today", later.startDate === "2026-02-01" && later.endDate === "2026-02-28", later);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
