/**
 * Audit 7 part B: the plan context the whole team reads (B2), the upgrade
 * card's wording in the trial (B13), the plan picked on the website (B12)
 * and the message back from a plan checkout (B15).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/plan-context.spec.ts
 */

// A module, so its names do not clash with the other script-style specs.
export {};

import * as fs from "fs";
import * as path from "path";
import { featureEnabled, isReadOnlyStatus, planContextFromServer, upgradeHeadline } from "./plan-context";
import { desiredPlanFromSearch, readDesiredPlan, rememberDesiredPlan, forgetDesiredPlan } from "./desired-plan";
import { checkoutReturnMessage, shouldKeepPolling } from "./checkout-return";

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

console.log("B2: plan context from the team endpoint");
{
  const ctx = planContextFromServer({
    plan: "esencial",
    effectivePlan: "pro",
    status: "trialing",
    inTrial: true,
    trialEnd: "2026-11-10T10:00:00.000Z",
    readOnlyUntil: null,
    cancelledAt: null,
    cancelAt: null,
    subscribed: false,
    addOns: [],
    addOnFeatures: [],
  });
  check("trial reads as Pro", ctx.effectivePlan === "pro" && ctx.inTrial, ctx);
  check("gift cards on in the trial", featureEnabled(ctx, "gift_cards"));
  check("multi-location (Empresa) off in the trial", !featureEnabled(ctx, "multi_location"));

  const pro = planContextFromServer({
    plan: "pro", effectivePlan: "pro", status: "active", inTrial: false, trialEnd: null,
    readOnlyUntil: null, cancelledAt: null, cancelAt: null, subscribed: true, addOns: [], addOnFeatures: [],
  });
  check("a Pro salon's admin sees gift cards", featureEnabled(pro, "gift_cards"));
  check("subscribed comes from the server", pro.subscribed);

  const addOn = planContextFromServer({
    plan: "esencial", effectivePlan: "esencial", status: "active", inTrial: false, trialEnd: null,
    readOnlyUntil: null, cancelledAt: null, cancelAt: null, subscribed: true,
    addOns: ["multichannel"], addOnFeatures: ["multichannel", "web_domain"],
  });
  check("an add-on unlocks its feature on Esencial", featureEnabled(addOn, "multichannel"));
  check("web_domain only from an add-on", featureEnabled(addOn, "web_domain") && !featureEnabled(pro, "web_domain"));

  const cancelled = { ...pro, subscriptionStatus: "cancelled" };
  check("cancelled: nothing on", !featureEnabled(cancelled, "gift_cards"));
  check("cancelled and suspended are read-only", isReadOnlyStatus("cancelled") && isReadOnlyStatus("suspended"));
  check("past_due is not read-only", !isReadOnlyStatus("past_due"));
}

console.log("B2: the hook reads the team endpoint, not the owner's billing route");
{
  const hook = fs.readFileSync(path.join(__dirname, "../src/hooks/useFeatureAccess.ts"), "utf8");
  check("getSubscriptionContext", hook.includes("getSubscriptionContext()"));
  check("not getCurrentSubscription", !hook.includes("getCurrentSubscription"));
}

console.log("B13: the upgrade card in the trial");
{
  check("Empresa feature in the trial", upgradeHeadline("Empresa", true, "empresa") === "Disponible en el plan Empresa");
  check("Pro feature outside the trial", upgradeHeadline("Pro", false, "pro") === "Disponible en el plan Pro");
  const cta = fs.readFileSync(path.join(__dirname, "../src/components/billing/UpgradeCTA.tsx"), "utf8");
  check("a read-only salon gets the read-only notice", cta.includes("ReadOnlyFeatureNotice") && cta.includes("readOnlyNotice("));
}

console.log("B12: the plan picked on the website");
{
  check("?plan=pro", desiredPlanFromSearch("?plan=pro") === "pro");
  check("?plan=EMPRESA", desiredPlanFromSearch("?plan=EMPRESA") === "empresa");
  check("unknown plan ignored", desiredPlanFromSearch("?plan=gold") === null);
  check("no plan", desiredPlanFromSearch("?pain=x") === null && desiredPlanFromSearch("") === null);

  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  rememberDesiredPlan("?plan=empresa", store);
  check("kept", readDesiredPlan(store) === "empresa");
  rememberDesiredPlan("?pain=x", store);
  check("a link without a plan keeps the earlier one", readDesiredPlan(store) === "empresa");
  forgetDesiredPlan(store);
  check("forgotten", readDesiredPlan(store) === null);
  check("no storage: no crash", readDesiredPlan(null) === null);

  const signup = fs.readFileSync(path.join(__dirname, "../app/signup/page.tsx"), "utf8");
  check("the signup page keeps it", signup.includes("rememberDesiredPlan(window.location.search)"));
}

console.log("B15: back from the checkout");
{
  const trial = {
    status: "complete" as const, paymentStatus: "no_payment_required" as const, plan: "pro",
    firstChargeAt: "2026-11-15T10:00:00.000Z", applied: false,
  };
  const m = checkoutReturnMessage(trial);
  check("trial: card saved with the first charge date", m.kind === "cardSaved" && m.firstChargeAt === trial.firstChargeAt, m);
  check("paid", checkoutReturnMessage({ ...trial, paymentStatus: "paid", firstChargeAt: null }).kind === "paid");
  check("open or unknown: pending", checkoutReturnMessage({ ...trial, status: "open" }).kind === "pending" && checkoutReturnMessage(null).kind === "pending");
  check("keeps polling until applied", shouldKeepPolling(trial, 1, 10) && !shouldKeepPolling({ ...trial, applied: true }, 1, 10));
  check("stops at the limit or when expired", !shouldKeepPolling(trial, 10, 10) && !shouldKeepPolling({ ...trial, status: "expired" }, 1, 10));

  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/es.json"), "utf8"));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/en.json"), "utf8"));
  const keys = ["cardSavedTitle", "cardSavedBody", "pendingTitle", "pendingBody", "slowBody"];
  check("es and en texts", keys.every((k) => es.billing.checkoutReturn[k] && en.billing.checkoutReturn[k]));
  check("es: 'Tarjeta guardada: el primer cobro será el {date}'", es.billing.checkoutReturn.cardSavedTitle === "Tarjeta guardada: el primer cobro será el {date}");
}

console.log("B8 / B16: terms and signup wording");
{
  const terms = fs.readFileSync(path.join(__dirname, "../app/legal/terms/page.tsx"), "utf8");
  const flat = terms.replace(/\s+/g, " ");
  check("Pro with 500 AI messages", flat.includes("las funciones del plan Pro, con 500 mensajes de la recepcionista IA"));
  check("no 'todas las funciones'", !flat.includes("todas las funciones"));
  check("7 days after the first failed charge", flat.includes("7 días después del primer cobro fallido") && !flat.includes("segundo aviso"));
  const es = JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/es.json"), "utf8"));
  check("signup subtitle", es.signup.subtitle.includes("funciones del plan Pro, con 500 mensajes de la recepcionista IA"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
