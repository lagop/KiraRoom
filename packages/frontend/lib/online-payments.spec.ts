/**
 * The "Cobros online" page: what each state says and does, how Stripe's list
 * of missing details is put in the salon's words, which addresses may be
 * opened, and that its texts exist in both languages.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/online-payments.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  connectAction,
  connectActionKey,
  connectReturnKind,
  connectStateClass,
  connectStateKey,
  requirementGroups,
  safeConnectUrl,
} from "./online-payments";

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

console.log("\n[states and actions]");
check("every state has its badge key and colour", ["none", "pending", "restricted", "active"].every((s) => connectStateKey(s as any) === `onlinePayments.state_${s}` && connectStateClass(s as any).length > 0));
check("nothing started: the button starts the connection", connectAction({ state: "none", platformReady: true }) === "start");
check("pending: continue in Stripe", connectAction({ state: "pending", platformReady: true }) === "continue");
check("restricted: complete what Stripe asks", connectAction({ state: "restricted", platformReady: true }) === "fix");
check("active: no button", connectAction({ state: "active", platformReady: true }) === "none" && connectActionKey("none") === null);
check("KiraRoom's own Stripe not set: no button at all", connectAction({ state: "none", platformReady: false }) === "none");
check("the button keys exist", connectActionKey("start") === "onlinePayments.action_start" && connectActionKey("fix") === "onlinePayments.action_fix");

console.log("\n[what Stripe still needs]");
check(
  "field paths become a few plain groups, each once, in a stable order",
  JSON.stringify(requirementGroups(["individual.id_number", "external_account", "individual.dob.day", "tos_acceptance.date"])) ===
    JSON.stringify(["onlinePayments.req_bank", "onlinePayments.req_identity", "onlinePayments.req_terms"]),
);
check("company and business details", JSON.stringify(requirementGroups(["company.tax_id", "business_profile.url"])) === JSON.stringify(["onlinePayments.req_company", "onlinePayments.req_business"]));
check("something unknown is 'other details', last", JSON.stringify(requirementGroups(["foo.bar", "external_account"])) === JSON.stringify(["onlinePayments.req_bank", "onlinePayments.req_other"]));
check("nothing due is nothing", requirementGroups([]).length === 0);

console.log("\n[coming back from Stripe]");
check("?connect=return", connectReturnKind("?connect=return") === "return");
check("?connect=refresh", connectReturnKind("connect=refresh") === "refresh");
check("anything else is a normal visit", connectReturnKind("") === null && connectReturnKind("?connect=x") === null);

console.log("\n[links]");
check("Stripe's sign-up form opens", safeConnectUrl("https://connect.stripe.com/setup/e/acct_1/abc") !== null);
check("another site never opens", safeConnectUrl("https://evil.example.com/setup") === null);
check("a lookalike host never opens", safeConnectUrl("https://stripe.com.evil.example/x") === null);
check("http and javascript: never open", safeConnectUrl("http://connect.stripe.com/x") === null && safeConnectUrl("javascript:alert(1)") === null);
check("nothing is nothing", safeConnectUrl(null) === null);

console.log("\n[texts]");
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "messages", file), "utf8"));
const es = load("es.json");
const en = load("en.json");
check("both languages have the same texts", JSON.stringify(Object.keys(es.onlinePayments).sort()) === JSON.stringify(Object.keys(en.onlinePayments).sort()));
const usedKeys = [
  ...["none", "pending", "restricted", "active"].map((s) => connectStateKey(s as any)),
  ...["start", "continue", "fix"].map((a) => connectActionKey(a as any)!),
  ...["bank", "identity", "company", "business", "terms", "other"].map((k) => `onlinePayments.req_${k}`),
  "onlinePayments.none_text",
  "onlinePayments.pending_text",
  "onlinePayments.restricted_text",
  "onlinePayments.active_text",
];
const has = (json: any, key: string) => key.split(".").reduce((o: any, k) => (o ? o[k] : undefined), json) !== undefined;
check("every key the page uses exists in both languages", usedKeys.every((k) => has(es, k) && has(en, k)), usedKeys.filter((k) => !has(es, k) || !has(en, k)));
check("the menu entry exists in both", !!es.nav.online_payments && !!en.nav.online_payments);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
