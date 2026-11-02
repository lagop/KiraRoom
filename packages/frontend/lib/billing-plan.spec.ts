/**
 * The billing page's plan cards: a salon in its free trial can pay for its
 * plan, and a salon that already pays changes plan instead of opening a
 * second subscription.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/billing-plan.spec.ts
 */

import { addOnDisplayName, formatSubscriptionAmount, paysSubscription, planAction } from "./billing-plan";

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

const trial = { plan: "pro", status: "trialing", stripeSubscriptionId: null };
const paying = { plan: "pro", status: "active", stripeSubscriptionId: "sub_1" };

check("in trial, its own plan can be paid for (it used to be a disabled «Tu plan actual»)", planAction(trial, "pro") === "subscribe");
check("in trial, another plan goes through checkout", planAction(trial, "empresa") === "checkout");
check("paying, its plan is just the current one", planAction(paying, "pro") === "current");
check("paying, another plan is a plan change, not a second checkout", planAction(paying, "esencial") === "change");
check("past due still pays: change, not checkout", planAction({ ...paying, status: "past_due" }, "empresa") === "change");
check("cancelled: no live subscription, so a checkout", planAction({ ...paying, status: "cancelled" }, "empresa") === "checkout" && !paysSubscription({ ...paying, status: "cancelled" }));
check("cancelled: its own plan can be contracted again, not a disabled «Tu plan actual»", planAction({ ...paying, status: "cancelled" }, "pro") === "subscribe");
check("cancelled with no Stripe subscription left: its own plan too", planAction({ plan: "pro", status: "cancelled", stripeSubscriptionId: null }, "pro") === "subscribe");
check("active with no Stripe subscription (set by the platform): its plan stays current", planAction({ plan: "pro", status: "active" }, "pro") === "current");
check("no plan read yet counts as Esencial", planAction({ status: "trialing" }, "esencial") === "subscribe");

// Add-ons by name, money in Spanish (B16, B17).
const catalog = [{ key: "ai_messages_1000", name: "Pack de 1.000 mensajes de IA" }];
check("an add-on is named as the catalogue names it", addOnDisplayName("ai_messages_1000", catalog) === "Pack de 1.000 mensajes de IA");
check(
  "or as the installed row does",
  addOnDisplayName("multichannel", catalog, [{ addOn: { key: "multichannel", name: "Multicanal" } }]) === "Multicanal",
);
check("the key only when nothing else is known", addOnDisplayName("x_key", null, null) === "x_key");
const nbsp = (s: string) => s.replace(/ /g, " ");
check("49,00 € in Spanish", nbsp(formatSubscriptionAmount(4900, "eur")) === "49,00 €", formatSubscriptionAmount(4900, "eur"));
check("no currency reads as euros", nbsp(formatSubscriptionAmount(1900, null)) === "19,00 €");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
