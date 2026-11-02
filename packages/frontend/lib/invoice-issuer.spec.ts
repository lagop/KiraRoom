/**
 * The warning about the salon's issuer data (NIF, razón social, fiscal
 * address): when it shows, in which tone, and where its links go.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/invoice-issuer.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import { issuerBannerState, issuerBlockDate, issuerLinks, joinList, type InvoiceIssuerStatus } from "./invoice-issuer";

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

const status = (over: Partial<InvoiceIssuerStatus>): InvoiceIssuerStatus => ({
  complete: false,
  missing: ["taxId", "legalName", "address"],
  blockFrom: null,
  blocking: false,
  message: "x",
  ...over,
});

console.log("when it shows");
check("nothing before the status is read", issuerBannerState(undefined) === "none");
check("nothing when complete", issuerBannerState(status({ complete: true, missing: [] })) === "none");
check("warn only when no date is set", issuerBannerState(status({})) === "warn");
check("the date ahead when one is set", issuerBannerState(status({ blockFrom: "2027-01-01" })) === "scheduled");
check("refused already", issuerBannerState(status({ blockFrom: "2026-01-01", blocking: true })) === "blocking");

console.log("links");
const both = issuerLinks(["taxId", "address"]);
check("NIF and razón social: Ajustes fiscales; address: Datos del salón", both.map((l) => l.href).join() === "/dashboard/settings/fiscal,/dashboard/settings/salon", both);
check("only the address: one link", issuerLinks(["address"]).map((l) => l.href).join() === "/dashboard/settings/salon");
check("only the razón social: one link", issuerLinks(["legalName"]).map((l) => l.label).join() === "linkFiscal");
for (const l of both) {
  check(`${l.href} is a page`, fs.existsSync(path.join(__dirname, "../app", l.href, "page.tsx")));
}

console.log("text");
check("joins with y", joinList(["el NIF", "la razón social", "la dirección"], "y") === "el NIF, la razón social y la dirección");
check("one field alone", joinList(["el NIF"], "y") === "el NIF");
check("date as dd/mm/yyyy", issuerBlockDate("2027-01-01") === "01/01/2027");

console.log("messages");
for (const lang of ["es", "en"]) {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, `../messages/${lang}.json`), "utf8"));
  const b = m.invoices?.issuerBanner ?? {};
  const keys = ["title", "missing", "warn", "scheduled", "blocking", "linkFiscal", "linkSalon", "and"];
  check(`${lang}: banner texts`, keys.every((k) => typeof b[k] === "string") && ["taxId", "legalName", "address"].every((k) => typeof b.fields?.[k] === "string"));
  check(`${lang}: the till's "sold without an invoice" title`, typeof m.pos?.invoice_skipped_title === "string");
}

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All invoice-issuer tests passed.");
