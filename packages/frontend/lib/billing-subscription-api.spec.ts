/**
 * Facturación, the owner's decisions (audit B3, B6, B8, B9, IVA, B18):
 * - "Anular cancelación", the plan check and the Empresa locations reach
 *   their backend routes;
 * - a cancellation at the end of the period, a subscription taken during
 *   the trial and Empresa's paid locations read right from the subscription;
 * - the plan prices are final: KiraRoom adds no VAT or IGIC (D6), so no "+ IVA";
 * - the SMS "Bonos de mensajes" card and its request are gone.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/billing-subscription-api.spec.ts
 */

// A module, so its names do not clash with the other script-style specs.
export {};

import * as fs from "fs";
import * as path from "path";
import { empresaLocations, scheduledCancellation, subscribedInTrial } from "./billing-plan";

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
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    return { status: 200, ok: true, json: async () => ({ blockers: [] }) };
  };

  console.log("API client");
  await apiClient.undoCancelSubscription();
  check(
    "«Anular cancelación» posts to undo-cancel",
    calls[0]?.method === "POST" && calls[0]?.url.endsWith("/api/v1/payments/subscription/undo-cancel"),
    calls[0],
  );
  await apiClient.getPlanCheck("esencial");
  check("the plan check reads plan-check?plan=", calls[1]?.url.endsWith("/payments/subscription/plan-check?plan=esencial"), calls[1]);
  await apiClient.updateSubscriptionLocations(3);
  check(
    "the paid locations post to update-locations with the count",
    calls[2]?.method === "POST" &&
      calls[2]?.url.endsWith("/payments/subscription/update-locations") &&
      JSON.parse(calls[2]?.body ?? "{}").locationCount === 3,
    calls[2],
  );
  check("the message-credits request is gone", typeof apiClient.getMessageBundlesBalance === "undefined");

  console.log("subscription state");
  const paying = { plan: "pro", status: "active", stripeSubscriptionId: "sub_1" };
  const end = "2026-12-01T00:00:00.000Z";
  check("a renewing subscription is not set to end", scheduledCancellation(paying) === null);
  check("cancelled at the end of the period: ends on cancelAt", scheduledCancellation({ ...paying, cancelAtPeriodEnd: true, cancelAt: end }) === end);
  check("once ended it is not 'se cancelará' any more", scheduledCancellation({ ...paying, status: "cancelled", cancelAtPeriodEnd: true, cancelAt: end }) === null);
  check("subscribed in the trial", subscribedInTrial({ ...paying, status: "trialing" }));
  check("a trial without a subscription has not subscribed", !subscribedInTrial({ plan: "esencial", status: "trialing", stripeSubscriptionId: null }));
  const empresa = { ...paying, plan: "empresa", maxLocations: 3, activeLocations: 2 };
  const locs = empresaLocations(empresa);
  check("Empresa: paid locations and the fewest it can pay (those open)", locs?.paid === 3 && locs?.min === 2, locs);
  check("Empresa with no location open still pays one", empresaLocations({ ...empresa, maxLocations: 1, activeLocations: 0 })?.min === 1);
  check("outside Empresa there is no locations control", empresaLocations(paying) === null);
  check("Empresa without a paid subscription has none either", empresaLocations({ ...empresa, stripeSubscriptionId: null }) === null);

  console.log("texts");
  const messages = ["es", "en"].map((lang) => JSON.parse(fs.readFileSync(path.join(__dirname, "../messages", `${lang}.json`), "utf8")));
  const [es, en] = messages;
  const keys = [
    "finalPrice",
    "cancel.description",
    "cancel.scheduled",
    "cancel.undo",
    "cancel.undoing",
    "cancel.undone",
    "cancel.scheduledToast",
    "trialSubscribedNote",
    "limits.title",
    "limits.intro",
    "limits.go",
    "locations.title",
    "locations.desc",
    "locations.save",
    "locations.confirm",
    "locations.confirmDescription",
    "locations.done",
  ];
  const get = (m: any, k: string) => k.split(".").reduce((o, p) => (o == null ? undefined : o[p]), m.billing);
  for (const k of keys) {
    check(`billing.${k} in es and en`, typeof get(es, k) === "string" && typeof get(en, k) === "string", k);
  }
  check("no + IVA in any billing text", !/IVA/.test(JSON.stringify(es.billing)) && !/VAT/.test(JSON.stringify(en.billing)));
  check("the checkout copy says it is the final price", /precio final, sin impuestos añadidos/.test(get(es, "checkoutDescription")), get(es, "checkoutDescription"));
  check("the plan change copy says it is the final price", /precio final, sin impuestos añadidos/.test(get(es, "switchDescription")), get(es, "switchDescription"));
  check("the upgrade card says 79 €/mes, not €79/mes", (() => {
    const cta = fs.readFileSync(path.join(__dirname, "../src/components/billing/UpgradeCTA.tsx"), "utf8");
    return cta.includes("{price} €/mes") && !cta.includes("€{price}");
  })());
  check("the cancel dialog says it ends with the paid period", /hasta el final del período/.test(get(es, "cancel.description")), get(es, "cancel.description"));
  check("the SMS bundles texts are gone", get(es, "bundles") === undefined && get(en, "bundles") === undefined);

  console.log("billing page");
  const page = fs.readFileSync(path.join(__dirname, "../app/dashboard/billing/page.tsx"), "utf8");
  check("no Bonos de mensajes card", !/BundlesBalanceCard|getMessageBundlesBalance/.test(page));
  check("only the owner stays on the page", /isOwner\(role\)/.test(page) && /router\.replace\("\/dashboard"\)/.test(page));
  check("the plan change asks the plan check before Stripe", /getPlanCheck\(/.test(page));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
