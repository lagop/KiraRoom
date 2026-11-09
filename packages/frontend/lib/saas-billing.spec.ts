/**
 * The console's billing view: amounts in cents shown as euros, the status
 * labels, which links may be opened, and that its texts exist in both languages.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/saas-billing.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  INVOICE_STATUSES,
  formatCents,
  invoiceAmountCents,
  invoiceStatusClass,
  invoiceStatusKey,
  conceptLabel,
  monthLabel,
  monthTitle,
  parseInvoiceConcept,
  safeStripeUrl,
} from "./saas-billing";

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
const plain = (s: string) => s.replace(/ /g, " ");

console.log("\n[amounts]");
check("4900 cents is 49,00 €", plain(formatCents(4900)) === "49,00 €", formatCents(4900));
check("nothing reads as 0,00 €", plain(formatCents(null)) === "0,00 €");
check("a paid invoice shows what was paid", invoiceAmountCents({ status: "paid", amountDueCents: 4900, amountPaidCents: 4900 }) === 4900);
check("a failed one shows what is owed", invoiceAmountCents({ status: "failed", amountDueCents: 4900, amountPaidCents: 0 }) === 4900);

console.log("\n[status]");
check("every status has a label key", INVOICE_STATUSES.every((s) => invoiceStatusKey(s) === `saas.billing.status_${s}`));
check("an unknown status has none and a neutral colour", invoiceStatusKey("weird") === null && invoiceStatusClass("weird").includes("gray"));
check("failed is red", invoiceStatusClass("failed").includes("red"));

console.log("\n[months]");
check("2026-11 reads as noviembre de 2026", monthTitle("2026-11") === "noviembre de 2026", monthTitle("2026-11"));

check("the month starts with a capital and only that one", monthLabel("2026-11") === "Noviembre de 2026", monthLabel("2026-11"));

console.log("\n[invoice lines]");
const tr = (key: string, p: Record<string, any> = {}) =>
  `${key}|${Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(",")}`;
check(
  "a trial line is recognised",
  JSON.stringify(parseInvoiceConcept("Trial period for KiraRoom - Esencial Plan")) ===
    JSON.stringify({ kind: "trial", plan: "KiraRoom - Esencial Plan" }),
);
const charge = parseInvoiceConcept("1 × KiraRoom - Esencial Plan (at €49.00 / month)");
check(
  "a monthly charge line is recognised",
  charge?.kind === "charge" &&
    charge.qty === "1" &&
    charge.plan === "KiraRoom - Esencial Plan" &&
    charge.interval === "month" &&
    plain(charge.price) === "49,00 €",
  charge,
);
check("a yearly line is recognised", (parseInvoiceConcept("1 × Pro (at €490.00 / year)") as any)?.interval === "year");
check("the trial line is said through the translator", conceptLabel("Trial period for Pro", tr) === "saas.billing.concept_trial|plan=Pro");
check(
  "a charge line is said through the translator",
  (conceptLabel("2 × Pro (at €49.00 / month)", tr) ?? "").startsWith("saas.billing.concept_month|qty=2,plan=Pro"),
);
check(
  "a line it does not know stays as Stripe wrote it",
  conceptLabel("Unused time on Pro after 03 Nov 2026", tr) === "Unused time on Pro after 03 Nov 2026",
);
check("no line is nothing", conceptLabel(null, tr) === null && parseInvoiceConcept("") === null);

console.log("\n[links]");
check("Stripe's invoice page opens", safeStripeUrl("https://invoice.stripe.com/i/acct_1/test_x") !== null);
check("Stripe's pdf opens", safeStripeUrl("https://pay.stripe.com/invoice/x/pdf") !== null);
check("another site never opens", safeStripeUrl("https://evil.example.com/i/x") === null);
check("a lookalike host never opens", safeStripeUrl("https://stripe.com.evil.example/i/x") === null);
check("http never opens", safeStripeUrl("http://invoice.stripe.com/i/x") === null);
check("javascript: never opens", safeStripeUrl("javascript:alert(1)") === null);
check("nothing is nothing", safeStripeUrl(null) === null);

console.log("\n[texts]");
const keysOf = (file: string) => {
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "messages", file), "utf8"));
  return Object.keys(json.saas.billing).sort();
};
const es = keysOf("es.json");
const en = keysOf("en.json");
check("both languages have the same billing texts", JSON.stringify(es) === JSON.stringify(en), { es: es.length, en: en.length });
check("the menu entry exists in both", ["es.json", "en.json"].every((f) => !!JSON.parse(fs.readFileSync(path.join(__dirname, "..", "messages", f), "utf8")).saas.nav.billing));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
