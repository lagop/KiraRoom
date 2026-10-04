/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/analytics-format.spec.ts
 *
 * The analytics page printed cents as euros (a 45 € haircut read "€4,500"),
 * and its "appointments trend" compared the last 7 days with half of the last
 * 14, a window that contains them. These pin the formatting and the trend.
 * It also checks that the "mín. 2 locales" leftover is gone: the Empresa plan
 * works from one location.
 */

import * as fs from "fs";
import * as path from "path";
import { formatCents, formatPeriod, formatRate, weekOverWeekChange } from "./analytics-format";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

// Intl separates the amount and the symbol with a no-break space.
const plain = (s: string) => s.replace(/ | /g, " ");

console.log("\n[formatCents]");
check("cents become euros", plain(formatCents(4500)), "45 €");
check("keeps cents when there are any", plain(formatCents(123456)), "1234,56 €");
check("thousands", plain(formatCents(1250000)), "12.500 €");
check("nothing is zero", plain(formatCents(undefined)), "0 €");

console.log("\n[formatRate]");
check("one decimal", plain(formatRate(37.5)), "37,5 %");
check("unmeasured is a dash, not 0 %", formatRate(null), "—");

console.log("\n[weekOverWeekChange]");
check("10 this week vs 8 the week before", weekOverWeekChange(10, 18), 25);
check("fewer than the week before", weekOverWeekChange(4, 12), -50);
check("no earlier week to compare", weekOverWeekChange(5, 5), null);

console.log("\n[formatPeriod]");
check("same year", plain(formatPeriod({ start: "2026-10-01", end: "2026-10-31" })), "1 oct – 31 oct 2026");
check("across years", plain(formatPeriod({ start: "2025-12-01", end: "2026-01-15" })), "1 dic 2025 – 15 ene 2026");

console.log("\n[no 'minimum 2 locations' leftovers]");
const root = path.join(__dirname, "..");
const upgrade = fs.readFileSync(path.join(root, "src/components/billing/UpgradeCTA.tsx"), "utf8");
check("upgrade notice", /mín\. ?2 locales/.test(upgrade), false);
for (const lang of ["es", "en"]) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, `messages/${lang}.json`), "utf8"));
  check(
    `${lang}: empty Multi-local page`,
    /al menos 2|at least 2/.test(messages.multiLocation.empty.desc),
    false,
  );
}

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All analytics-format tests passed.");
}
