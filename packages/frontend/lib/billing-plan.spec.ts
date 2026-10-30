/**
 * The billing page's plan cards: a salon in its free trial can pay for its
 * plan, and a salon that already pays changes plan instead of opening a
 * second subscription.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/billing-plan.spec.ts
 */

import { paysSubscription, planAction } from "./billing-plan";

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
check("active with no Stripe subscription (set by the platform): its plan stays current", planAction({ plan: "pro", status: "active" }, "pro") === "current");
check("no plan read yet counts as Esencial", planAction({ status: "trialing" }, "esencial") === "subscribe");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
