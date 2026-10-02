/**
 * Modelo 420 in the panel: only the rows the quarter used, the ATC's box
 * numbers, euros from cents, 9,5 % written the Spanish way, and the right
 * filing window.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/modelo-420.spec.ts
 */
import { lastClosedQuarter, modelo420Deadline, modelo420Rows } from "./modelo-420";

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
const nbsp = (s: string) => s.replace(/ /g, " ");

const boxes: Record<string, number> = {
  "01": 150000, "02": 7, "03": 10500,
  "04": 20000, "05": 9.5, "06": 1900,
  "07": 0, "08": 0, "09": 0,
  "25": 12400, "40": 0, "41": 12400, "45": 12400,
};
const { rates, totals } = modelo420Rows(boxes);

console.log("modelo420Rows");
check("only rows with amounts", rates.length === 2, rates);
check("box numbers of the row", rates[0].boxes === "01 · 02 · 03");
check("euros from cents (no thousands dot for four digits, as es-ES writes it)", nbsp(rates[0].base) === "1500,00 €", rates[0].base);
check("9,5 %", rates[1].rate === "9,5 %", rates[1].rate);
check("totals 25, 40, 41, 45", totals.map((t) => t.box).join(",") === "25,40,41,45");
check("result value", nbsp(totals[3].value) === "124,00 €", totals[3].value);

console.log("dates");
check("in February the closed quarter is last year's Q4", JSON.stringify(lastClosedQuarter(new Date(2027, 1, 10))) === '{"year":2026,"quarter":4}');
check("in October it is Q3", JSON.stringify(lastClosedQuarter(new Date(2026, 9, 2))) === '{"year":2026,"quarter":3}');
check("Q3 due 1-20 October", modelo420Deadline(2026, 3) === "del 1 al 20 de octubre de 2026");
check("Q4 due in January", modelo420Deadline(2026, 4) === "durante el mes de enero de 2027");

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All modelo-420 tests passed.");
