/**
 * The till's discounts as the panel shows them (lib/pos-discounts.ts): the
 * same integer-cent arithmetic as the server, so the total on screen and
 * the amount tendered are what the server charges, and the same staff rule,
 * so the cashier hears "no" before charging.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/pos-discounts.spec.ts
 */
import {
  allocateCents,
  applyDiscounts,
  describeDiscount,
  discountCents,
  discountProblem,
  specFromInput,
  staffLimitProblem,
} from "./pos-discounts";

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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nbsp = (s: string) => s.replace(/ /g, " ");

console.log("pos-discounts");

check("10 % of 19,99 € is 2,00 € (half up)", discountCents({ type: "percentage", value: 10 }, 1999) === 200);
check("12,5 % of 10,01 € is 1,25 €", discountCents({ type: "percentage", value: 12.5 }, 1001) === 125);
check("33,33 % of 3,00 € is 1,00 €", discountCents({ type: "percentage", value: 33.33 }, 300) === 100);
check("a fixed amount is its cents", discountCents({ type: "fixed", value: 500 }, 4000) === 500);
check("a fixed amount is shown capped at the line", discountCents({ type: "fixed", value: 5000 }, 4000) === 4000);
check("no discount is 0", discountCents(undefined, 4000) === 0 && discountCents({ type: "fixed", value: 0 }, 4000) === 0);

check("shares add up exactly", same(allocateCents(100, [1, 1, 1]), [34, 33, 33]));

const ticket = applyDiscounts(
  [
    { price: 4000, quantity: 1, discount: { type: "percentage", value: 10 } },
    { price: 1250, quantity: 2 },
  ],
  { type: "fixed", value: 600 },
);
check(
  "line first, then the ticket, shared in proportion (same as the server)",
  ticket.subtotalCents === 6500 &&
    ticket.lineDiscountsCents === 400 &&
    ticket.orderDiscountCents === 600 &&
    ticket.totalCents === 5500 &&
    same(
      ticket.lines.map((l) => [l.lineDiscountCents, l.orderDiscountCents, l.netCents]),
      [
        [400, 354, 3246],
        [0, 246, 2254],
      ],
    ),
  ticket,
);

check("percent typed with a comma", same(specFromInput("percentage", "12,5", " Habitual "), { type: "percentage", value: 12.5, reason: "Habitual" }));
check("euros typed become cents", same(specFromInput("fixed", "5,50"), { type: "fixed", value: 550 }));
check("nothing typed is no discount", specFromInput("fixed", "") === null && specFromInput("percentage", "abc") === null);
check("the reason is cut at 120 characters", specFromInput("fixed", "1", "x".repeat(200))!.reason!.length === 120);

check("shown as 10 % or 5,00 €", describeDiscount({ type: "percentage", value: 10 }) === "10 %" && nbsp(describeDiscount({ type: "fixed", value: 500 })) === "5,00 €");

check(
  "a fixed amount above the line is refused, in the server's words",
  nbsp(discountProblem({ type: "fixed", value: 2501 }, 2500, "la línea") ?? "") === "El descuento (25,01 €) supera el importe de la línea (25,00 €).",
);
check("above the ticket too", nbsp(discountProblem({ type: "fixed", value: 501 }, 500, "el ticket") ?? "").includes("supera el importe del ticket"));
check("a fitting discount has no problem", discountProblem({ type: "percentage", value: 100 }, 2500, "la línea") === null);

const line = (discount?: any) => [{ price: 1999, quantity: 1, discount }, { price: 1000, quantity: 1 }];
check(
  "staff cannot discount while the limit is 0",
  staffLimitProblem(line({ type: "percentage", value: 5 }), null, 0) === "Solo la propietaria o un encargado pueden aplicar descuentos en caja.",
);
check("staff within the limit, on the rate asked for", staffLimitProblem(line({ type: "percentage", value: 10 }), null, 10) === null);
check(
  "staff past the limit",
  staffLimitProblem(line({ type: "fixed", value: 200 }), null, 10) ===
    "Tu límite de descuento es del 10 % por línea. Para descontar más, pide a un encargado que lo aplique.",
);
check(
  "staff cannot stack a line and a ticket discount past the limit",
  staffLimitProblem(line({ type: "percentage", value: 10 }), { type: "percentage", value: 10 }, 10) !== null &&
    staffLimitProblem(line({ type: "percentage", value: 5 }), { type: "percentage", value: 5 }, 10) === null,
);
check("no discount needs no permission", staffLimitProblem(line(), null, 0) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
