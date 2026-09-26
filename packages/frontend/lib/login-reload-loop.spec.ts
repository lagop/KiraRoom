/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/login-reload-loop.spec.ts
 *
 * Covers the infinite reload loop on https://app.kiraroom.net/login, where
 * the page refreshed continuously and you could not type into the form.
 *
 * The chain, confirmed against production:
 *
 *   1. /login renders and calls useTranslations()
 *   2. no `kira_language` in localStorage, so it called GET /auth/tenant
 *   3. unauthenticated -> 401 (verified: 401, and /auth/refresh also 401)
 *   4. api.ts's 401 handler assigns window.location.href = "/login"
 *   5. assigning the current URL reloads the page -> back to 1
 *
 * It had been masked. While the backend rejected the browser's origin, that
 * same request failed CORS as a *network* error and never reached the status
 * check, so step 4 could not run: the visible symptom was "Failed to fetch".
 * Fixing CORS turned that into the loop.
 *
 * Two independent guards, so neither alone has to be perfect:
 *   - loginRedirectTarget: never navigate to the page already showing.
 *   - resolveLanguageSource: never call a protected endpoint with no token.
 */

import { loginRedirectTarget } from "./api";
import {
  resolveLanguageSource,
  DEFAULT_LANGUAGE,
} from "./use-translation";

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

console.log("\n=== loginRedirectTarget: the loop guard ===");

// The bug itself: a 401 while already on /login must not navigate.
check("null on /login for a tenant user", loginRedirectTarget("/login", false), null);
check("null on /saas/login for a saas_owner", loginRedirectTarget("/saas/login", true), null);
check("null on /login/ with a trailing slash", loginRedirectTarget("/login/", false), null);

// It must still redirect from everywhere else, or a 401 would leave the user
// stranded on a page that cannot load.
check("redirects from the dashboard", loginRedirectTarget("/dashboard", false), "/login");
check("redirects from a nested route", loginRedirectTarget("/dashboard/settings/accounting", false), "/login");
check("redirects from the site root", loginRedirectTarget("/", false), "/login");
check("saas_owner goes to the saas login", loginRedirectTarget("/saas/tenants", true), "/saas/login");

// Cross-role: the two login pages are different pages, so a mismatch still
// navigates rather than stalling.
check("saas_owner on /login goes to /saas/login", loginRedirectTarget("/login", true), "/saas/login");
check("tenant user on /saas/login goes to /login", loginRedirectTarget("/saas/login", false), "/login");

// Not a prefix match: /loginhelp is a different page.
check("a path merely starting with /login still redirects", loginRedirectTarget("/loginhelp", false), "/login");

console.log("\n=== resolveLanguageSource: no protected call without a session ===");

// Step 2 of the chain. With no token there must be no request at all.
check(
  "logged out with no saved language -> default, no fetch",
  resolveLanguageSource(null, false),
  { kind: "default" },
);
check(
  "logged out with an unsupported saved value -> default, no fetch",
  resolveLanguageSource("fr", false),
  { kind: "default" },
);
check(
  "logged in with no saved language -> fetch",
  resolveLanguageSource(null, true),
  { kind: "fetch" },
);
check(
  "a saved language wins even when logged in",
  resolveLanguageSource("en", true),
  { kind: "saved", language: "en" },
);
check(
  "a saved language is honoured while logged out",
  resolveLanguageSource("es", false),
  { kind: "saved", language: "es" },
);
check(
  "an empty saved value is not treated as a preference",
  resolveLanguageSource("", false),
  { kind: "default" },
);
check("the default language is Spanish", DEFAULT_LANGUAGE, "es");

console.log("\n=== The loop cannot re-form ===");

// Belt and braces: even if some other component calls a protected endpoint
// from the login page, the redirect guard stops the reload.
const fetchedWhileLoggedOut = resolveLanguageSource(null, false).kind === "fetch";
check("nothing is fetched from a public page", fetchedWhileLoggedOut, false);
check(
  "and a stray 401 there still cannot reload the page",
  loginRedirectTarget("/login", false),
  null,
);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All login-reload-loop tests passed.");
}
