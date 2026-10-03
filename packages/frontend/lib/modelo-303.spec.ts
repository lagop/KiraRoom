/**
 * Modelo 303 in the panel: only the rows the quarter used, the AEAT's 2026
 * box numbers (4 % in 01-03, 21 % in 07-09), rectifications in 14-15, the
 * 0 % base shown apart, and the right filing window.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/modelo-303.spec.ts
 */
import { ZERO_RATE_KEY, modelo303Deadline, modelo303Rows } from "./modelo-303";

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
const nbsp = (s: string) => s.replace(/[  ]/g, " ");

const boxes: Record<string, number> = {
  "01": 0, "02": 4, "03": 0,
  "04": 20000, "05": 10, "06": 2000,
  "07": 150000, "08": 21, "09": 31500,
  "14": -10000, "15": -2100,
  "27": 31400, "45": 0, "46": 31400, "71": 31400,
  [ZERO_RATE_KEY]: 0,
};
const { rates, totals, zeroRateBase } = modelo303Rows(boxes);

console.log("modelo303Rows");
check("only rows with amounts, plus rectifications", rates.length === 3, rates);
check("10 % is 04 · 05 · 06", rates[0].boxes === "04 · 05 · 06" && rates[0].rate === "10 %", rates[0]);
check("21 % is 07 · 08 · 09", rates[1].boxes === "07 · 08 · 09" && rates[1].rate === "21 %", rates[1]);
check("rectifications in 14 · 15, negative", rates[2].boxes === "14 · 15" && nbsp(rates[2].cuota) === "-21,00 €", rates[2]);
check("totals 27, 45, 46, 71", totals.map((t) => t.box).join(",") === "27,45,46,71");
check("result value", nbsp(totals[3].value) === "314,00 €", totals[3].value);
check("no 0 % note when there is no 0 % base", zeroRateBase === null);
check("0 % base shown apart", nbsp(modelo303Rows({ ...boxes, [ZERO_RATE_KEY]: 4500 }).zeroRateBase ?? "") === "45,00 €");

console.log("deadline");
check("Q3 due 1-20 October", modelo303Deadline(2026, 3) === "del 1 al 20 de octubre de 2026");
check("Q4 due 1-30 January", modelo303Deadline(2026, 4) === "del 1 al 30 de enero de 2027");

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All modelo-303 tests passed.");
