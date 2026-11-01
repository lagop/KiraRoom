/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/client-area-redirect.spec.ts
 *
 * Clients no longer have accounts on the salon's site. The old sign-in,
 * "Mi cuenta" pages and every link to them are gone; their addresses lead
 * to the booking page instead of a 404.
 */

import * as fs from "fs";
import * as path from "path";
import { carriedQuery, retiredClientAreaRedirect } from "./client-area-redirect";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

console.log("\n=== old client-area addresses go to the booking page ===");

check(
  "the area on the app host goes to the salon's page",
  retiredClientAreaRedirect("/sites/salon-luna/account", "", false),
  { pathname: "/sites/salon-luna", search: "" },
);
check(
  "its sub-pages too",
  retiredClientAreaRedirect("/sites/salon-luna/account/settings", "", false),
  { pathname: "/sites/salon-luna", search: "" },
);
check(
  "a rebooking link keeps its service, as ?serviceId=",
  retiredClientAreaRedirect("/sites/salon-luna/account/new-appointment", "?service=abc", false),
  { pathname: "/sites/salon-luna", search: "?serviceId=abc" },
);
check(
  "professional and day are kept, anything else is dropped",
  retiredClientAreaRedirect(
    "/sites/salon-luna/account/new-appointment",
    "?serviceId=s1&professionalId=p1&date=2026-11-03&token=x",
    false,
  ),
  { pathname: "/sites/salon-luna", search: "?serviceId=s1&professionalId=p1&date=2026-11-03" },
);
check(
  "on the salon's own domain /account goes to /",
  retiredClientAreaRedirect("/account", "", true),
  { pathname: "/", search: "" },
);
check("and /account/settings", retiredClientAreaRedirect("/account/settings", "", true), { pathname: "/", search: "" });
check(
  "the /sites/ form on the salon's domain goes to / too",
  retiredClientAreaRedirect("/sites/salon-luna/account", "", true),
  { pathname: "/", search: "" },
);

console.log("\n=== everything else is left alone ===");

check("the booking page", retiredClientAreaRedirect("/sites/salon-luna", "", false), null);
check("/account on the app host is not a salon page", retiredClientAreaRedirect("/account", "", false), null);
check("a path that only starts the same", retiredClientAreaRedirect("/sites/salon-luna/accounting", "", false), null);
check("the panel's accounting settings", retiredClientAreaRedirect("/dashboard/settings/accounting", "", false), null);
check("/accounts on a salon domain", retiredClientAreaRedirect("/accounts", "", true), null);
check("the unsubscribe page", retiredClientAreaRedirect("/public/baja/tok", "", false), null);
check("no parameters, no query", carriedQuery("?utm_source=x"), "");

console.log("\n=== no page links to a client account ===");

const ROOT = path.join(__dirname, "..");
const booking = fs.readFileSync(path.join(ROOT, "app/sites/[salonName]/salon-booking-page.tsx"), "utf8");
check("the booking page has no sign-in", /LoginModal|apiClient\.login|\/account/.test(booking), false);
check("the login modal is gone", fs.existsSync(path.join(ROOT, "app/sites/[salonName]/components/login-modal.tsx")), false);
check(
  "only the redirect is left of the client area",
  fs.readdirSync(path.join(ROOT, "app/sites/[salonName]/account")),
  ["[[...rest]]"],
);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All client-area-redirect tests passed.");
}
