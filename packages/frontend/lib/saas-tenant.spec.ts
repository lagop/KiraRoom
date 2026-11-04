/**
 * The SaaS console's salon helpers (audit 8): status names, the address
 * autofill, Spanish dates, the typed-name check, invite actions, and the
 * shared phone/NIF line.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/saas-tenant.spec.ts
 */
import {
  anonymizeNeedsForce,
  formatDateEs,
  inviteCanResend,
  inviteCanRevoke,
  isReadOnlyStatus,
  nextSlugField,
  sameSalonName,
  slugFromName,
  tenantStatusClass,
  tenantStatusKey,
  type SlugField,
} from "./saas-tenant";
import { sharedIdentityLine } from "./shared-identity";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

console.log("\n=== status names (T18) ===");
check("cancelled has one key everywhere", tenantStatusKey("cancelled"), "saas.console.status_cancelled");
check("past_due too", tenantStatusKey("past_due"), "saas.console.status_past_due");
check("unknown falls back", tenantStatusKey("weird"), null);
check("unknown class is grey", tenantStatusClass("weird"), "bg-gray-100 text-gray-800");
check("read-only statuses", ["cancelled", "suspended", "active", "past_due"].map(isReadOnlyStatus), [true, true, false, false]);

console.log("\n=== address autofill (T7) ===");
check("accents folded", slugFromName("Salón Lucía & Co."), "salon-lucia-co");
check("63 characters at most, no trailing hyphen", slugFromName("a".repeat(62) + " bbb").length <= 63 && !slugFromName("a".repeat(62) + " bbb").endsWith("-"), true);
// The old form filled it only "while empty", read before the keystroke: it stopped at "s".
let field: SlugField = { slug: "", touched: false };
for (const name of ["S", "Sa", "Sal", "Salón", "Salón Ana"]) field = nextSlugField(field, "name", name);
check("typing the name keeps filling the address", field, { slug: "salon-ana", touched: false });
field = nextSlugField(field, "slug", "ana-centro");
field = nextSlugField(field, "name", "Salón Ana Centro");
check("once typed, the name no longer overwrites it", field, { slug: "ana-centro", touched: true });
field = nextSlugField(field, "slug", "");
field = nextSlugField(field, "name", "Salón Bea");
check("clearing the address lets the name fill it again", field, { slug: "salon-bea", touched: false });

console.log("\n=== Spanish dates ===");
check("empty is a dash", [formatDateEs(null), formatDateEs("not a date")], ["—", "—"]);
check("Spain's day, not UTC's", formatDateEs("2026-11-04T23:30:00Z").includes("5"), true);

console.log("\n=== GDPR erasure confirmation (T5) ===");
check("same name, other case and accents", sameSalonName("  salon   lucia ", "Salón Lucía"), true);
check("a different name", sameSalonName("Salón Luci", "Salón Lucía"), false);
check("empty never matches", sameSalonName("", ""), false);
check("an active salon needs force", anonymizeNeedsForce({ subscriptionStatus: "active" }), true);
check("a trial too", anonymizeNeedsForce({ subscriptionStatus: "trialing" }), true);
check("a cancelled one does not", anonymizeNeedsForce({ subscriptionStatus: "cancelled" }), false);
check("a deleted one does not", anonymizeNeedsForce({ subscriptionStatus: "active", deletedAt: "2026-11-01" }), false);

console.log("\n=== invite actions (T15) ===");
check("resend: pending and expired", ["pending", "expired", "accepted", "revoked"].map(inviteCanResend), [true, true, false, false]);
check("revoke: pending only", ["pending", "expired", "accepted", "revoked"].map(inviteCanRevoke), [true, false, false, false]);

console.log("\n=== shared phone/NIF line (T23) ===");
check(
  "a deleted salon is marked",
  sharedIdentityLine({
    kind: "taxId",
    value: "B12345678",
    others: [
      { id: "1", name: "Pelu Ana", slug: "pelu-ana" },
      { id: "2", name: "Pelu Ana 2", slug: "pelu-ana-2", deleted: true },
    ],
  }),
  "Comparte el NIF B12345678 con: Pelu Ana, Pelu Ana 2 (eliminado).",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
