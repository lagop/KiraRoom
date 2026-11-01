/**
 * "Pagar comisión" in the commissions summary pays everything pending up to
 * today, the figure its dialog shows. The page used to send the payroll
 * tab's date range, so the dialog said one amount and another was paid.
 * Now it sends no dates, and the figure shown as `expectedAmount` (cents):
 * the server pays nothing if that is no longer what is pending.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/commissions-pay.spec.ts
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
  const calls: Array<{ url: string; body: any }> = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { status: 200, ok: true, json: async () => ({ count: 4, totalAmount: 850 }) };
  };

  const out = await apiClient.payCommission("p1", { expectedAmount: 850 });

  check("one request", calls.length === 1, calls);
  check("to the professional's pay route", calls[0]?.url.endsWith("/api/v1/commissions/pay/p1"), calls[0]?.url);
  check("sends the figure the dialog showed", calls[0]?.body?.expectedAmount === 850, calls[0]?.body);
  check(
    "no dates: everything pending up to today",
    calls[0]?.body?.startDate === undefined && calls[0]?.body?.endDate === undefined,
    calls[0]?.body,
  );
  check("returns what was paid", out?.totalAmount === 850, out);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
