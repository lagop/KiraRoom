/**
 * The income card for the Modelo 130: one row per quarter, amounts without
 * the tax, rectificativas shown apart, cumulative from 1 January.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/modelo-130.spec.ts
 */
import { modelo130Deadline, modelo130Rows } from "./modelo-130";

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
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const rows = modelo130Rows({
  quarters: [
    { quarter: 1, invoicedCents: 150000, rectifiedCents: 0, incomeCents: 150000, cumulativeCents: 150000 },
    { quarter: 2, invoicedCents: 200000, rectifiedCents: -2000, incomeCents: 198000, cumulativeCents: 348000 },
    { quarter: 3, invoicedCents: 0, rectifiedCents: 0, incomeCents: 0, cumulativeCents: 348000 },
    { quarter: 4, invoicedCents: 1000, rectifiedCents: 0, incomeCents: 1000, cumulativeCents: 349000 },
  ],
});

console.log("rows");
check("four quarters, 1T to 4T", rows.map((r) => r.quarter).join() === "1T,2T,3T,4T", rows);
check("income in euros, without the tax", nbsp(rows[0].income) === "1500,00 €", rows[0]);
check("rectificativas subtracted and shown", nbsp(rows[1].rectified) === "-20,00 €" && nbsp(rows[1].income) === "1980,00 €", rows[1]);
check("no rectificativas: a dash", rows[0].rectified === "—");
check("cumulative from 1 January", nbsp(rows[3].cumulative) === "3490,00 €", rows[3]);

console.log("deadline");
check("Q1 due 1-20 April", modelo130Deadline(2026, 1) === "del 1 al 20 de abril de 2026");
check("Q4 due 1-30 January", modelo130Deadline(2026, 4) === "del 1 al 30 de enero de 2027");

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All modelo-130 tests passed.");
