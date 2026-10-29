/**
 * The platform console's Stripe page: the status line and what "Guardar" sends.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/platform-stripe.spec.ts
 */
import type { PlatformStripeConfig } from "./api";
import { STRIPE_WEBHOOK_EVENTS, stripeStatus, stripeUpdate } from "./platform-stripe";

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

const off: PlatformStripeConfig = {
  mode: "none",
  secretKey: { source: "none", lastFour: null },
  publishableKey: { source: "none", value: null },
  webhookSecret: { source: "none", lastFour: null },
  taxEnabled: { source: "none", value: false },
  updatedAt: null,
  updatedBy: null,
};
const testMode: PlatformStripeConfig = {
  ...off,
  mode: "test",
  secretKey: { source: "console", lastFour: "6789" },
  publishableKey: { source: "console", value: ["pk", "test", "abc"].join("_") },
  webhookSecret: { source: "console", lastFour: "wxyz" },
};

check("no key: cannot charge", stripeStatus(off).tone === "off");
check(
  "a key without the webhook secret is flagged",
  stripeStatus({ ...testMode, webhookSecret: { source: "none", lastFour: null } }).tone === "off",
);
check("test mode says so, with the test card", stripeStatus(testMode).tone === "test" && /4242/.test(stripeStatus(testMode).text));
check(
  "live mode, with tax",
  /Modo real/.test(stripeStatus({ ...testMode, mode: "live", taxEnabled: { source: "console", value: true } }).text) &&
    /IVA con Stripe Tax activado/.test(stripeStatus({ ...testMode, mode: "live", taxEnabled: { source: "console", value: true } }).text),
);

const form = { secretKey: "", publishableKey: testMode.publishableKey.value!, webhookSecret: "", taxEnabled: false };
check("nothing changed: nothing to save", stripeUpdate(form, testMode) === null);
check("turning tax on is sent alone", JSON.stringify(stripeUpdate({ ...form, taxEnabled: true }, testMode)) === JSON.stringify({ taxEnabled: true }));
const typed = ["sk", "live", "fictitious0123"].join("_");
check("a typed secret key is sent", stripeUpdate({ ...form, secretKey: ` ${typed} ` }, testMode)?.secretKey === typed);
check("the six webhook events", STRIPE_WEBHOOK_EVENTS.length === 6 && STRIPE_WEBHOOK_EVENTS.includes("invoice.payment_failed"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
