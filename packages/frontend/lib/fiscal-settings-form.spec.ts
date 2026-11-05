/**
 * Ajustes > Fiscal: the issuer fields load from what is stored, and a save
 * sends only what the user changed.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/fiscal-settings-form.spec.ts
 *
 * The page used to load the razón social and the ID type empty and send the
 * whole form on every save, so it erased the stored razón social.
 */
import { changedFiscalFields, fiscalChangeSummary, issuerFieldsFromSettings } from "./fiscal-settings-form";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

check(
  "the razón social, the type and the NIF load from the response",
  issuerFieldsFromSettings({
    fiscalSettings: { tenantNif: "B12345674" },
    taxId: "B12345674",
    taxIdType: "cif",
    legalName: "Peluquería Ejemplo S.L.",
  }),
  { tenantNif: "B12345674", taxIdType: "cif", legalName: "Peluquería Ejemplo S.L." },
);
check(
  "the NIF column wins over the settings mirror",
  issuerFieldsFromSettings({ fiscalSettings: { tenantNif: "OLD" }, taxId: "B12345674" }).tenantNif,
  "B12345674",
);
check(
  "the mirror fills an empty column",
  issuerFieldsFromSettings({ fiscalSettings: { tenantNif: "12345678Z" }, taxId: null }).tenantNif,
  "12345678Z",
);
check(
  "nothing stored: empty fields and NIF as the type",
  issuerFieldsFromSettings({ fiscalSettings: {}, taxId: null, taxIdType: null, legalName: null }),
  { tenantNif: "", taxIdType: "nif", legalName: "" },
);

const loaded = {
  fiscalMode: "none",
  defaultSeries: "A",
  defaultTaxRate: 21,
  pricesIncludeTax: false,
  diputacion: null as string | null,
  tenantNif: "B12345674",
  taxIdType: "cif",
  legalName: "Peluquería Ejemplo S.L.",
};
check("nothing changed: nothing is sent", changedFiscalFields({ ...loaded }, loaded), {});
check(
  "changing the series sends only the series, never the razón social",
  changedFiscalFields({ ...loaded, defaultSeries: "B" }, loaded),
  { defaultSeries: "B" },
);
check(
  "clearing the razón social is sent, so the server can refuse it",
  changedFiscalFields({ ...loaded, legalName: "" }, loaded),
  { legalName: "" },
);
check(
  "a salon without a razón social that does not type one sends nothing",
  changedFiscalFields({ ...loaded, legalName: "", pricesIncludeTax: true }, { ...loaded, legalName: "" }),
  { pricesIncludeTax: true },
);

// The confirmation before risky fiscal changes (C12).
const risk = { tenantNif: "B12345674", defaultSeries: "A", defaultTaxRate: 21, taxRegime: "iva" as const, pricesIncludeTax: true };
check("no risky change: no dialog", fiscalChangeSummary({ ...risk }, risk), []);
check("the rate alone does not ask", fiscalChangeSummary({ ...risk, defaultTaxRate: 10 }, risk), []);
check(
  "a new NIF and series say what the new invoices carry",
  fiscalChangeSummary({ ...risk, tenantNif: "12345678z", defaultSeries: "b" }, risk).map((l) => [l.key, l.params]),
  [
    ["invoices.fiscalSettings.confirmTaxId", { taxId: "12345678Z" }],
    ["invoices.fiscalSettings.confirmSeries", { series: "B" }],
  ],
);
check(
  "switching to tax on top: 30,00 € now costs 36,30 €",
  fiscalChangeSummary({ ...risk, pricesIncludeTax: false }, risk),
  [
    {
      key: "invoices.fiscalSettings.confirmPrices",
      params: { price: "30,00 €", before: "30,00 €", after: "36,30 €", tax: "IVA" },
    },
  ],
);
check(
  "to IGIC at 9,5 % with tax on top: regime and price lines",
  fiscalChangeSummary(
    { ...risk, taxRegime: "igic", defaultTaxRate: 9.5, pricesIncludeTax: false },
    { ...risk, pricesIncludeTax: false },
  ).map((l) => l.params),
  [
    { tax: "IGIC", previous: "IVA", rate: "9,5" },
    { price: "30,00 €", before: "36,30 €", after: "32,85 €", tax: "IGIC" },
  ],
);

console.log(`\n${pass} passed, ${fail} failed`);
{
  const base = { tenantNif: "B1", defaultSeries: "A", defaultTaxRate: 21, taxRegime: "iva" as const, pricesIncludeTax: true };
  const on = fiscalChangeSummary({ ...base, fiscalMode: "verifactu" }, { ...base, fiscalMode: "none" }).map((l) => l.key);
  const same = fiscalChangeSummary({ ...base, fiscalMode: "verifactu" }, { ...base, fiscalMode: "verifactu" });
  if (on.includes("invoices.fiscalSettings.confirmVerifactu") && same.length === 0) pass++;
  else {
    fail++;
    console.error("switching VERI*FACTU on must ask for confirmation, once");
  }
}

if (fail > 0) process.exit(1);
