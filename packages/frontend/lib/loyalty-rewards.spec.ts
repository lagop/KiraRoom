/**
 * The loyalty page's reward form and points adjustment (lib/loyalty-rewards.ts):
 * a discount is a percent or an amount above zero, never both nor neither;
 * the limit and the expiry are optional and editable; an adjustment is an
 * amount, a sign and a reason (no more window.prompt).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/loyalty-rewards.spec.ts
 */
import { EMPTY_REWARD_FORM, adjustmentOf, centsOf, dayOf, rewardFormOf, rewardPayload } from "./loyalty-rewards";

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

const form = (over: Partial<typeof EMPTY_REWARD_FORM> = {}) => ({ ...EMPTY_REWARD_FORM, name: "10 %", ...over });

console.log("discount value");
{
  const pct = rewardPayload(form({ discountKind: "percent", percent: "10", euros: "5" }));
  check("a percent sends the percent and clears the amount", pct.ok && pct.body.discountPercent === 10 && pct.body.discountAmount === 0, pct);
  const amt = rewardPayload(form({ discountKind: "amount", percent: "10", euros: "5,50" }));
  check("an amount sends cents and clears the percent", amt.ok && amt.body.discountAmount === 550 && amt.body.discountPercent === 0, amt);
  const zeroPct = rewardPayload(form({ discountKind: "percent", percent: "0" }));
  check("0 % is refused", !zeroPct.ok && /entre 1 y 100/.test(zeroPct.error), zeroPct);
  const zeroAmt = rewardPayload(form({ discountKind: "amount", euros: "0" }));
  check("0,00 EUR is refused", !zeroAmt.ok && /mayor que 0/.test(zeroAmt.error), zeroAmt);
  const emptyAmt = rewardPayload(form({ discountKind: "amount", euros: "" }));
  check("an empty amount is refused", !emptyAmt.ok, emptyAmt);
  const gift = rewardPayload(form({ type: "product", productId: "p1", percent: "10", euros: "5" }));
  check("other types send no discount", gift.ok && gift.body.discountPercent === 0 && gift.body.discountAmount === 0, gift);
  check("euros parse with a comma or a dot", centsOf("5,5") === 550 && centsOf("5.25") === 525 && Number.isNaN(centsOf("5,555")));
}

console.log("limit and expiry");
{
  const none = rewardPayload(form());
  check("empty limit and expiry are null", none.ok && none.body.maxRedemptions === null && none.body.expiresAt === null, none);
  const set = rewardPayload(form({ maxRedemptions: "50", expiresOn: "2026-12-31" }));
  check("the limit is sent", set.ok && set.body.maxRedemptions === 50, set);
  const end = set.ok ? new Date(set.body.expiresAt as string) : null;
  check(
    "the expiry is the end of that day, local time",
    !!end && end.getFullYear() === 2026 && end.getMonth() === 11 && end.getDate() === 31 && end.getHours() === 23 && end.getMinutes() === 59,
    end,
  );
  const below = rewardPayload(form({ maxRedemptions: "3" }), 5);
  check("an edit cannot set the limit below what was redeemed", !below.ok && /5 veces/.test(below.error), below);
  check("a limit of 0 is refused", !rewardPayload(form({ maxRedemptions: "0" })).ok);
  check("free service needs its service", !rewardPayload(form({ type: "free_service", freeServiceId: "" })).ok);
}

console.log("editing an existing reward");
{
  const r = {
    id: "r1",
    name: "5 € menos",
    type: "discount" as const,
    pointsCost: 200,
    discountPercent: null,
    discountAmount: 500,
    freeServiceId: null,
    isActive: false,
    currentRedemptions: 2,
    maxRedemptions: 10,
    expiresAt: new Date(2026, 11, 31, 23, 59, 59).toISOString(),
  };
  const f = rewardFormOf(r);
  check("the form starts from the reward", f.discountKind === "amount" && f.euros === "5,00" && f.pointsCost === "200" && !f.isActive && f.maxRedemptions === "10" && f.expiresOn === "2026-12-31", f);
  const back = rewardPayload(f, r.currentRedemptions);
  check("unchanged, it saves the same values", back.ok && back.body.discountAmount === 500 && back.body.pointsCost === 200 && back.body.isActive === false && back.body.maxRedemptions === 10, back);
  check("dayOf of nothing is empty", dayOf(null) === "" && dayOf("not a date") === "");
}

console.log("manual adjustment");
{
  check("add is positive", JSON.stringify(adjustmentOf("50", "add", " Visita en papel ", 0)) === JSON.stringify({ ok: true, points: 50, reason: "Visita en papel" }));
  const take = adjustmentOf("20", "take", "Error", 30);
  check("take is negative", take.ok && take.points === -20, take);
  check("taking more than the balance is refused", !adjustmentOf("40", "take", "Error", 30).ok);
  check("a reason is required", !adjustmentOf("10", "add", "  ", 0).ok);
  check("the amount is a whole number above 0", !adjustmentOf("0", "add", "x", 0).ok && !adjustmentOf("1.5", "add", "x", 0).ok && !adjustmentOf("-5", "add", "x", 0).ok);
  check("nothing can be taken from a negative balance", !adjustmentOf("1", "take", "x", -10).ok);
  check("points can be added to a negative balance", adjustmentOf("15", "add", "Compensación", -10).ok);
}

console.log("product and «otro regalo» rewards");
{
  const noProduct = rewardPayload(form({ type: "product" }));
  check("a product reward needs its product", !noProduct.ok && /Elige el producto/.test(noProduct.error), noProduct);
  const product = rewardPayload(form({ type: "product", productId: "p1" }));
  check("a product reward sends its product", product.ok && product.body.productId === "p1", product);
  const other = rewardPayload(form({ type: "voucher", productId: "p1", description: "  Neceser de viaje  " }));
  check(
    "«otro regalo» sends no product, and its description trimmed",
    other.ok && other.body.productId === null && other.body.description === "Neceser de viaje",
    other,
  );
  const discount = rewardPayload(form({ productId: "p1" }));
  check("a discount sends no product", discount.ok && discount.body.productId === null, discount);
  const edited = rewardFormOf({ id: "r1", name: "Champú", type: "product", pointsCost: 100, productId: "p1", description: "Champú 250 ml", isActive: true, currentRedemptions: 0 } as any);
  check("an existing product reward loads its product and description", edited.productId === "p1" && edited.description === "Champú 250 ml", edited);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
