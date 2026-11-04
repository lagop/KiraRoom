/**
 * Audit 7 phase 2, billing: D6 (KiraRoom's prices are final, no "+ IVA"),
 * D8 (deactivating a professional has its own route, allowed in read-only)
 * and D9 (the console's shared phone / NIF warning).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/billing-p2.spec.ts
 */

// A module, so its names do not clash with the other script-style specs.
export {};

import * as fs from "fs";
import * as path from "path";
import { sharedIdentityBadge, sharedIdentityLine } from "./shared-identity";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, detail ?? "");
  }
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

console.log("D6: final prices");
{
  const es = JSON.parse(read("messages/es.json"));
  const en = JSON.parse(read("messages/en.json"));
  check("no IVA in billing (es)", !/IVA/.test(JSON.stringify(es.billing)));
  check("no VAT in billing (en)", !/VAT/.test(JSON.stringify(en.billing)));
  check("plusVat gone, finalPrice there", es.billing.plusVat === undefined && !!es.billing.finalPrice && !!en.billing.finalPrice);
  const page = read("app/dashboard/billing/page.tsx");
  check("billing page shows the final-price note", page.includes('t("billing.finalPrice")') && !page.includes("plusVat"));
  const cta = read("src/components/billing/UpgradeCTA.tsx");
  check("upgrade card: 79 €/mes", cta.includes("{price} €/mes") && !cta.includes("€{price}"));
  check("bono text without + IVA", !read("lib/email-campaigns.ts").includes("+ IVA"));
  const terms = read("app/legal/terms/page.tsx").replace(/\s+/g, " ");
  check("terms: precio final, sin impuestos añadidos", terms.includes("el precio final, sin impuestos añadidos"));
}

console.log("D8: deactivating while read-only");
{
  check("api has deactivateProfessional", read("lib/api.ts").includes("/deactivate`, { method: \"POST\" }"));
  check("the team page uses it to deactivate", read("app/dashboard/professionals/page.tsx").includes("apiClient.deactivateProfessional(professional.id)"));
}

console.log("D9: shared phone / NIF");
{
  const w = { kind: "phone" as const, value: "600 11 22 33", others: [{ id: "b", name: "Pelu Ana 2", slug: "ana2" }] };
  check("line", sharedIdentityLine(w) === "Comparte el teléfono 600 11 22 33 con: Pelu Ana 2.", sharedIdentityLine(w));
  check("badge phone", sharedIdentityBadge([w]) === "Teléfono compartido");
  check("badge both", sharedIdentityBadge([w, { ...w, kind: "taxId" }]) === "Teléfono y NIF compartidos");
  check("no badge", sharedIdentityBadge([]) === null && sharedIdentityBadge(undefined) === null);
  check("list page shows the badge", read("app/saas/tenants/page.tsx").includes("<SharedIdentityBadge warnings={tenant.sharedIdentity} />"));
  check("detail page shows the notice", read("app/saas/tenants/[id]/page.tsx").includes("<SharedIdentityNotice warnings={tenant.sharedIdentity} />"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
