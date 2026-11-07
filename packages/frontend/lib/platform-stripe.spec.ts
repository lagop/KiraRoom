/**
 * The platform console's Stripe page: the status line, what "Guardar" and
 * "Volver a lo del servidor" send, and the warning before a mode change.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/platform-stripe.spec.ts
 */
import type { PlatformStripeConfig } from "./api";
import { BACK_TO_SERVER, STRIPE_WEBHOOK_EVENTS, hasConsoleKeys, previewWarning, stripeStatus, stripeUpdate } from "./platform-stripe";

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
  otherWebhookSecret: { source: "none", lastFour: null, mode: "none" },
  server: { mode: "none", hasWebhookSecret: false },
  problem: null,
  taxIgnored: false,
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
check("live mode", /Modo real/.test(stripeStatus({ ...testMode, mode: "live" }).text));
check(
  "a problem in force (e.g. a key that cannot be decrypted) is shown in red",
  stripeStatus({ ...testMode, problem: "No se puede descifrar" }).tone === "off",
);

const form = { secretKey: "", publishableKey: testMode.publishableKey.value!, webhookSecret: "", otherWebhookSecret: "" };
check("nothing changed: nothing to save", stripeUpdate(form, testMode) === null);
const typed = ["sk", "live", "fictitious0123"].join("_");
check("a typed secret key is sent", stripeUpdate({ ...form, secretKey: ` ${typed} ` }, testMode)?.secretKey === typed);
check("no tax switch is ever sent", !("taxEnabled" in (stripeUpdate({ ...form, secretKey: typed }, testMode) ?? {})));
check(
  "«Volver a lo del servidor» clears the three at once",
  JSON.stringify(BACK_TO_SERVER) === JSON.stringify({ secretKey: null, publishableKey: null, webhookSecret: null }),
);
check("…offered only with something in the console", hasConsoleKeys(testMode) && !hasConsoleKeys(off));

const toLive = previewWarning({
  modeBefore: "test",
  modeAfter: "live",
  problem: null,
  impact: {
    otherModeSalons: 2,
    activePlansTotal: 1,
    activePlans: [{ id: "t1", name: "Salón Lucía", slug: "lucia", plan: "pro", subscriptionStatus: "active" }],
  },
});
check("going live says it plainly", !!toLive && /modo REAL/.test(toLive.lines[0]) && toLive.destructive);
check("…with the salons of the other mode", !!toLive && /2 salón/.test(toLive.lines[1]) && /Salón Lucía \(pro\)/.test(toLive.lines[2]));
check("same mode: no warning", previewWarning({ modeBefore: "test", modeAfter: "test", problem: null, impact: null }) === null);
check("the seven webhook events", STRIPE_WEBHOOK_EVENTS.length === 7 && STRIPE_WEBHOOK_EVENTS.includes("invoice.payment_failed") && STRIPE_WEBHOOK_EVENTS.includes("charge.refunded"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
