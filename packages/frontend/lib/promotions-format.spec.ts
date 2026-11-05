/**
 * Promociones page: Spanish money and dates, the types the form can create,
 * and a code that is not sent again on an edit.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/promotions-format.spec.ts
 */
import {
  CREATABLE_PROMOTION_TYPES,
  discountLabel,
  formatEuros,
  formatPromotionDate,
  promotionPayload,
  promotionTypeLabel,
  usesLabel,
} from "./promotions-format";

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

console.log("money");
check("5 is 5,00 €", nbsp(formatEuros(5)) === "5,00 €", formatEuros(5));
check("a Decimal string", nbsp(formatEuros("12.5")) === "12,50 €");
check("nothing is 0,00 €", nbsp(formatEuros(null)) === "0,00 €");
check("percentage", discountLabel("PERCENTAGE", 10) === "10 %");
check("fixed", nbsp(discountLabel("FIXED", "5")) === "5,00 €");

console.log("dates");
check("es-ES, the stored day", formatPromotionDate("2026-11-02T00:00:00.000Z") === "2 nov 2026", formatPromotionDate("2026-11-02T00:00:00.000Z"));
check("empty", formatPromotionDate(null) === "" && formatPromotionDate("nope") === "");

console.log("types");
check("only what the form can create", CREATABLE_PROMOTION_TYPES.map((t) => t.value).join() === "PERCENTAGE,FIXED");
check("no Compra X lleva Y label", promotionTypeLabel("BUY_X_GET_Y") === "Otro" && promotionTypeLabel("FIXED") === "Importe fijo");

console.log("payload");
const form = {
  name: " Otoño ",
  description: "",
  code: "otono10",
  type: "PERCENTAGE",
  value: "10",
  minOrderValue: "",
  maxUses: "",
  maxUsesPerClient: "1",
  startDate: "2026-11-01",
  endDate: "",
};
const created = promotionPayload(form, false) as any;
check("create sends the code in capitals", created.code === "OTONO10");
check("empty numbers are null", created.maxUses === null && created.maxUsesPerClient === 1 && created.minOrderValue === 0);
check("empty end date is null, empty description null", created.endDate === null && created.description === null);
const edited = promotionPayload(form, true) as any;
check("edit leaves the code out", !("code" in edited) && edited.name === "Otoño");
check("no services: the field is left out", !("applicableServiceIds" in created));
const limited = promotionPayload({ ...form, applicableServiceIds: ["s1", "s2", "s1"] }, false) as any;
check("the services ticked, once each", JSON.stringify(limited.applicableServiceIds) === JSON.stringify(["s1", "s2"]));
const cleared = promotionPayload({ ...form, applicableServiceIds: [] }, true) as any;
check("none ticked on an edit: the whole ticket again", Array.isArray(cleared.applicableServiceIds) && cleared.applicableServiceIds.length === 0);

console.log("uses");
check("without a limit", usesLabel(3, null) === "3");
check("with a limit", usesLabel(3, 10) === "3 / 10");
check("with what they took off", nbsp(usesLabel(3, 10, 12)) === "3 / 10 · 12,00 €", usesLabel(3, 10, 12));

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All promotions-format tests passed.");
