/**
 * The billing page reads the salon's message credits from the salon's own
 * route, /payments/message-bundles/tenants/current/balance (owner and admin).
 *
 * It used to call /message-bundles/tenants/current/balance, which is the SaaS
 * admin's `tenants/:tenantId/balance` with "current" as the id: every salon,
 * a new owner in trial included, got 403 "Forbidden resource" and the console
 * showed "Billing: bundles failed to load".
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/billing-bundles.spec.ts
 */

// A module, so its names do not clash with the other script-style specs.
export {};

const store = new Map<string, string>();
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const apiClient = require("./api").default;

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

async function run() {
  store.set("kira_auth_token", "access");
  const urls: string[] = [];
  const balance = { creditsRemaining: 40, creditsPurchasedTotal: 50, creditsUsedTotal: 10, lastTopupAt: null };
  (globalThis as any).fetch = async (url: string) => {
    urls.push(url);
    return { status: 200, ok: true, json: async () => balance };
  };

  const out = await apiClient.getMessageBundlesBalance();

  check("one request", urls.length === 1, urls);
  check(
    "to the salon's route",
    urls[0]?.endsWith("/api/v1/payments/message-bundles/tenants/current/balance"),
    urls[0],
  );
  check("not the SaaS admin's", !/\/api\/v1\/message-bundles\//.test(urls[0] ?? ""), urls[0]);
  check("returns the balance", out?.creditsRemaining === 40, out);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
