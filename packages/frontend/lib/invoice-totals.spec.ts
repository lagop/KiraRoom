/**
 * The manual invoice form's preview (Facturas > Nueva factura): the subtotal,
 * tax and total shown while the lines are typed are the ones the server
 * issues the invoice with (backend invoice-calculator.service.ts), with the
 * typed prices including the tax or not as the salon set in Ajustes fiscales.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/invoice-totals.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  computeInvoiceLine,
  computeInvoiceTotals,
  pricesTaxHintKey,
} from "./invoice-totals";

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, { actual: a, expected: e });
}

console.log("one line");
same(
  "30,00 € at 21 %, tax included: 24,79 + 5,21 = 30,00 (the Ajustes fiscales example)",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true }),
  { baseCents: 2479, taxCents: 521, totalCents: 3000 },
);
same(
  "30,00 € at 21 %, tax on top: 30,00 + 6,30 = 36,30",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: false }),
  { baseCents: 3000, taxCents: 630, totalCents: 3630 },
);
same(
  "no taxIncluded is tax on top, the server's default",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, taxRate: 21 }),
  { baseCents: 3000, taxCents: 630, totalCents: 3630 },
);
same(
  "10,00 € at 21 % included is 8,26 + 1,74: the tax is what is left, never 9,99 in all",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 1000, taxRate: 21, taxIncluded: true }),
  { baseCents: 826, taxCents: 174, totalCents: 1000 },
);
same(
  "IGIC 7 %, included: 30,00 = 28,04 + 1,96",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, taxRate: 7, taxIncluded: true }),
  { baseCents: 2804, taxCents: 196, totalCents: 3000 },
);
same(
  "0 % (exempt), included: all of it is base",
  computeInvoiceLine({ quantity: 2, unitPriceCents: 1500, taxRate: 0, taxIncluded: true }),
  { baseCents: 3000, taxCents: 0, totalCents: 3000 },
);
same(
  "quantity 3, 10 % off 19,99 € included: 3 x 17,99 = 53,97 = 44,60 + 9,37",
  computeInvoiceLine({ quantity: 3, unitPriceCents: 1999, discountPct: 10, taxRate: 21, taxIncluded: true }),
  { baseCents: 4460, taxCents: 937, totalCents: 5397 },
);
same(
  "the discount rounds per unit, then times the quantity, like the server: 3 x round(1,665) = 5,01",
  computeInvoiceLine({ quantity: 3, unitPriceCents: 333, discountPct: 50, taxRate: 0 }),
  { baseCents: 501, taxCents: 0, totalCents: 501 },
);
same(
  "a fractional quantity: 1,5 x 20,00 € on top = 30,00 + 6,30",
  computeInvoiceLine({ quantity: 1.5, unitPriceCents: 2000, taxRate: 21 }),
  { baseCents: 3000, taxCents: 630, totalCents: 3630 },
);
same(
  "a discount over 100 % counts as 100 %, like the server's clamp",
  computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, discountPct: 150, taxRate: 21, taxIncluded: true }),
  { baseCents: 0, taxCents: 0, totalCents: 0 },
);
same(
  "a negative or non-number discount counts as none",
  [
    computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, discountPct: -5, taxRate: 21 }),
    computeInvoiceLine({ quantity: 1, unitPriceCents: 3000, discountPct: NaN, taxRate: 21 }),
  ],
  [
    { baseCents: 3000, taxCents: 630, totalCents: 3630 },
    { baseCents: 3000, taxCents: 630, totalCents: 3630 },
  ],
);

console.log("the invoice");
same(
  "subtotal = sum of bases, tax = sum of line taxes, total = both (tax included)",
  computeInvoiceTotals([
    { quantity: 1, unitPriceCents: 3000, taxRate: 21, taxIncluded: true },
    { quantity: 2, unitPriceCents: 1000, taxRate: 21, taxIncluded: true },
    { quantity: 1, unitPriceCents: 1250, taxRate: 10, taxIncluded: true },
  ]),
  // 2479 + 521 | 1653 + 347 | 1136 + 114
  { subtotalCents: 5268, taxCents: 982, totalCents: 6250 },
);
same(
  "with the tax included the total is what the prices add up to",
  computeInvoiceTotals([
    { quantity: 1, unitPriceCents: 1999, taxRate: 21, taxIncluded: true },
    { quantity: 3, unitPriceCents: 755, taxRate: 21, taxIncluded: true },
  ]).totalCents,
  1999 + 3 * 755,
);
same(
  "tax on top: the tax is added to every line",
  computeInvoiceTotals([
    { quantity: 1, unitPriceCents: 3000, taxRate: 21 },
    { quantity: 2, unitPriceCents: 1000, taxRate: 21 },
  ]),
  { subtotalCents: 5000, taxCents: 1050, totalCents: 6050 },
);
same("no lines: all zero", computeInvoiceTotals([]), { subtotalCents: 0, taxCents: 0, totalCents: 0 });

console.log("the hint above the lines");
const messages = (lang: string) =>
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "messages", `${lang}.json`), "utf8").replace(/^﻿/, ""),
  );
const es = messages("es");
const en = messages("en");
function render(lang: any, key: string, params: Record<string, string> = {}): string {
  const template = key.split(".").reduce((v, k) => v?.[k], lang);
  return String(template).replace(/\{(\w+)\}/g, (_, p) => params[p] ?? `{${p}}`);
}
same(
  "included, named after the regime",
  render(es, pricesTaxHintKey(true), { tax: "IVA" }),
  "Precios con IVA incluido (según Ajustes fiscales)",
);
same(
  "on top, named after the regime (IGIC in the Canaries)",
  render(es, pricesTaxHintKey(false), { tax: "IGIC" }),
  "Precios sin IGIC: el IGIC se suma",
);
for (const key of [
  pricesTaxHintKey(true),
  pricesTaxHintKey(false),
  "invoices.form.pricesTaxSettingsLink",
  "invoices.form.pricesTaxLoading",
  "invoices.form.pricesTaxUnavailable",
]) {
  for (const [name, lang] of [["es", es], ["en", en]] as const) {
    const v = key.split(".").reduce((o: any, k) => o?.[k], lang);
    check(`${name}: ${key} exists`, typeof v === "string" && v.length > 0);
  }
}

console.log("the form");
const form = fs.readFileSync(
  path.join(__dirname, "..", "app", "dashboard", "billing", "invoices", "new", "components", "invoice-form.tsx"),
  "utf8",
);
check("previews with this calculator", form.includes("computeInvoiceTotals("));
check("sends taxIncluded on every line", /taxIncluded,\s*\n\s*};/.test(form));
check("links to Ajustes fiscales", form.includes('href="/dashboard/settings/fiscal"'));
check("cannot submit before the setting is known", form.includes("disabled={isSubmitting || !taxSettingKnown}"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
