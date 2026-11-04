/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/console-metrics.spec.ts
 *
 * The platform console divided the salons' takings by 100 (they are euros,
 * not cents), so 12.345 € read "123,45 €", on the home, Analytics, a salon's
 * page and its analytics (audit 8 D3, T8). Analytics was in English, and the
 * home page read "New This Month" from a repeated es.json key (D11).
 */

import * as fs from "fs";
import * as path from "path";
import { countryName, formatChange, formatEuros, formatMonthShort, formatPercent } from "./console-metrics";

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
const root = path.resolve(__dirname, "..");

console.log("\n[formatEuros]");
check("euros stay euros", plain(formatEuros(45)), "45,00 €");
check("thousands", plain(formatEuros(12345)), "12.345,00 €");
check("nothing is zero", plain(formatEuros(undefined)), "0,00 €");

console.log("\n[formatPercent / formatChange]");
check("one decimal", plain(formatPercent(12.345)), "12,3 %");
check("no base reads as a dash", formatPercent(null), "—");
check("positive change has a sign", plain(formatChange(5)), "+5,0 %");
check("negative change", plain(formatChange(-4)), "-4,0 %");
check("no change base", formatChange(null), "—");

console.log("\n[formatMonthShort / countryName]");
check("Spanish month", formatMonthShort("2026-11"), "nov");
check("January", formatMonthShort("2027-01"), "ene");
check("country name", countryName("ES"), "España");

console.log("\n[pages]");
const pages = [
  "app/saas/page.tsx",
  "app/saas/analytics/page.tsx",
  "app/saas/tenants/[id]/page.tsx",
  "app/saas/tenants/[id]/analytics/page.tsx",
];
for (const p of pages) {
  const src = fs.readFileSync(path.join(root, p), "utf8");
  check(`${p}: no amount divided by 100`, /\/\s*100\b/.test(src), false);
}
const analytics = fs.readFileSync(path.join(root, "app/saas/analytics/page.tsx"), "utf8");
check("Analytics has no hard-coded English titles", /"(Total Salons|Churn Rate|Revenue Overview|Platform Analytics)"/.test(analytics), false);

console.log("\n[messages]");
const es = JSON.parse(fs.readFileSync(path.join(root, "messages/es.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "messages/en.json"), "utf8"));
check("no dashboard.new_this_month shadowing the Spanish text", es.dashboard.new_this_month, undefined);
check("same console metric keys in es and en", Object.keys(es.saas.metrics).sort(), Object.keys(en.saas.metrics).sort());
check("Spanish overview label", es.saas.nav.overview, "Inicio");

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All console-metrics tests passed.");
}
