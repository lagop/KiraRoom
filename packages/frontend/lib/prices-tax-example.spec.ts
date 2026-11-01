/**
 * The example under "Mis precios ya incluyen el impuesto" (Ajustes fiscales):
 * a 30,00 € service at the selected rate, tax inside the price or on top,
 * with the same arithmetic as the backend's invoice calculator, named after
 * the salon's regime (IVA, IGIC, IPSI).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/prices-tax-example.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  clientPriceCents,
  clientPriceHint,
  formatEuros,
  pricesTaxExample,
  pricesTaxExampleMessage,
} from "./prices-tax-example";

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

// Render a message the way lib/use-translation.ts does: {param} replaced.
const raw = fs.readFileSync(path.join(__dirname, "..", "messages", "es.json"), "utf8").replace(/^﻿/, "");
const es = JSON.parse(raw);
function render(lang: any, key: string, params: Record<string, string>): string {
  const template = key.split(".").reduce((v, k) => v?.[k], lang);
  return String(template).replace(/\{(\w+)\}/g, (_, p) => params[p] ?? `{${p}}`);
}
const sentence = (rate: number, included: boolean, label: string) => {
  const m = pricesTaxExampleMessage(rate, included, label);
  return render(es, m.key, m.params);
};

console.log("formatEuros");
check("30,00 €", formatEuros(3000) === "30,00 €", formatEuros(3000));
check("5,21 €", formatEuros(521) === "5,21 €", formatEuros(521));
check("0,05 €", formatEuros(5) === "0,05 €", formatEuros(5));

console.log("amounts");
const in21 = pricesTaxExample(21, true);
check("IVA 21 % included: 24,79 + 5,21 = 30,00", in21.base === "24,79 €" && in21.tax === "5,21 €" && in21.total === "30,00 €", in21);
const top21 = pricesTaxExample(21, false);
check("IVA 21 % on top: 30,00 + 6,30 = 36,30", top21.base === "30,00 €" && top21.tax === "6,30 €" && top21.total === "36,30 €", top21);
const in7 = pricesTaxExample(7, true);
check("IGIC 7 % included: 28,04 + 1,96", in7.base === "28,04 €" && in7.tax === "1,96 €", in7);
const top7 = pricesTaxExample(7, false);
check("IGIC 7 % on top: 30,00 + 2,10 = 32,10", top7.tax === "2,10 €" && top7.total === "32,10 €", top7);
const in95 = pricesTaxExample(9.5, true);
check("IGIC 9,5 % included: 27,40 + 2,60", in95.base === "27,40 €" && in95.tax === "2,60 €", in95);
const zero = pricesTaxExample(0, true);
check("0 %: no tax either way", zero.base === "30,00 €" && zero.tax === "0,00 €", zero);
check("a rate the input left empty (NaN) reads as 0", pricesTaxExample(NaN, false).tax === "0,00 €");

console.log("sentences (messages/es.json)");
const s1 = sentence(21, true, "IVA");
check("included", s1 === "Un servicio de 30,00 € se factura como 24,79 € + 5,21 € de IVA", s1);
const s2 = sentence(21, false, "IVA");
check("on top", s2 === "Un servicio de 30,00 € se factura como 30,00 € + 6,30 € de IVA = 36,30 €", s2);
const s3 = sentence(7, true, "IGIC");
check("IGIC, the regime's label", s3 === "Un servicio de 30,00 € se factura como 28,04 € + 1,96 € de IGIC", s3);
const s4 = sentence(10, false, "IPSI");
check("IPSI on top", s4 === "Un servicio de 30,00 € se factura como 30,00 € + 3,00 € de IPSI = 33,00 €", s4);
check("no 'IVA incluido' wording", !/incluido/i.test(s1 + s2));

console.log("what clients see (the hint in the service drawer)");
check("net 30,00 at 21 % -> 36,30", clientPriceCents(3000, 21, false) === 3630, clientPriceCents(3000, 21, false));
check("prices with the tax inside: as typed", clientPriceCents(3000, 21, true) === 3000);
check("IGIC 7 %: 32,10", clientPriceCents(3000, 7, false) === 3210);
check("0 %: as typed", clientPriceCents(3000, 0, false) === 3000);
check("rounds like the invoice: 19,99 -> 24,19", clientPriceCents(1999, 21, false) === 2419, clientPriceCents(1999, 21, false));
const hint = clientPriceHint(30, 21, false, "IVA");
const hintText = hint ? render(es, hint.key, hint.params) : null;
check("hint sentence", hintText === "Las clientas verán 36,30 € (IVA incluido)", hintText);
const hintIgic = clientPriceHint(25.5, 7, false, "IGIC");
const hintIgicText = hintIgic ? render(es, hintIgic.key, hintIgic.params) : null;
check("hint in IGIC", hintIgicText === "Las clientas verán 27,29 € (IGIC incluido)", hintIgicText);
check("no hint when prices include the tax", clientPriceHint(30, 21, true, "IVA") === null);
check("no hint while the settings load", clientPriceHint(30, 21, undefined, "IVA") === null);
check("no hint for a price that is not one", clientPriceHint(null, 21, false, "IVA") === null);

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All prices-tax-example tests passed.");
