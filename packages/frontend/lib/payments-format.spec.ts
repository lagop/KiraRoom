/**
 * The Pagos page's labels and amounts (lib/payments-format.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/payments-format.spec.ts
 */
import {
  PAYMENT_STATUS_LABELS,
  formatEuros,
  methodLabel,
  parseEurosToCents,
  paymentConcept,
  pickedLines,
  refundableCents,
  unitsValueCents,
  statusLabel,
} from "./payments-format";

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

check(
  "the status filter lists the server's four statuses, 'Pagado' included",
  JSON.stringify(Object.keys(PAYMENT_STATUS_LABELS)) === JSON.stringify(["paid", "pending", "refunded", "failed"]),
);
check("statuses and methods in Spanish", statusLabel("paid") === "Pagado" && methodLabel("bank_transfer") === "Transferencia");
check("an unknown value shows as it is", statusLabel("weird") === "weird");
check("euros the Spanish way", nbsp(formatEuros(5000)) === "50,00 €", formatEuros(5000));
check("thousands too", nbsp(formatEuros(123456)) === "1234,56 €" || nbsp(formatEuros(123456)) === "1.234,56 €", formatEuros(123456));
check("no amount is 0,00 €", nbsp(formatEuros(undefined)) === "0,00 €");

check("12,50 is 1250 cents", parseEurosToCents("12,50") === 1250);
check("12.5 is 1250 cents", parseEurosToCents("12.5") === 1250);
check("12 € is 1200 cents", parseEurosToCents("12 €") === 1200);
check("three decimals, words, 0 and negatives are refused", [
  parseEurosToCents("1,234"),
  parseEurosToCents("diez"),
  parseEurosToCents("0"),
  parseEurosToCents("-5"),
].every((v) => v === null));

check("an appointment's payment is its service", paymentConcept({ amount: 1, status: "paid", appointment: { service: { name: "Corte" } } }) === "Corte");
check(
  "a till sale says so",
  paymentConcept({ amount: 1, status: "paid", description: "POS Sale: Champú, Tinte", metadata: { posSaleId: "s" } }) ===
    "Venta en caja: Champú, Tinte",
);
check("refundable: paid less refunded", refundableCents({ amount: 4000, status: "paid", refundedAmount: 1500 }) === 2500);
check("nothing to refund on a refunded or pending payment", refundableCents({ amount: 4000, status: "refunded" }) === 0 && refundableCents({ amount: 4000, status: "pending" }) === 0);

const champu = {
  id: "l1",
  kind: "product",
  description: "Champú",
  quantity: 3,
  refundedQuantity: 0,
  refundableQuantity: 3,
  totalCents: 1000,
  refundedCents: 0,
  refundableCents: 1000,
};
check("one unit of three for 10,00 is 3,33", unitsValueCents(champu, 1) === 333);
check(
  "the last units take what is left of the line",
  unitsValueCents({ ...champu, refundedQuantity: 2, refundableQuantity: 1, refundedCents: 666, refundableCents: 334 }, 1) === 334,
);
check("all the units: all that is left", unitsValueCents(champu, 3) === 1000);
const corte = { ...champu, id: "l2", kind: "service", description: "Corte", quantity: 1, refundableQuantity: 1, totalCents: 3000, refundableCents: 3000 };
const picked = pickedLines([champu, corte], { l1: 2, l2: 0 });
check("picked lines: only those with units, and their value", picked.lines.length === 1 && picked.lines[0].quantity === 2 && picked.valueCents === 667);
check("never more units than are left", pickedLines([champu], { l1: 9 }).lines[0].quantity === 3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
