/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/signup-session.spec.ts
 *
 * Signing up did not log anyone in.
 *
 * `apiClient.register` was typed `Promise<LoginResponse>` — so
 * `{ accessToken, refreshToken, user }` — and returned the backend's actual
 * shape, `{ user, tokens: { accessToken, refreshToken } }`. The generic on
 * `this.request` made TypeScript believe the declared type, so nothing caught
 * it. Unlike `login`, it also stored no token at all.
 *
 * The signup page then did:
 *
 *     if (res?.accessToken) { …store it… }
 *     router.push("/dashboard");
 *
 * `res.accessToken` was always undefined, so the branch never ran and the
 * navigation happened regardless.
 *
 * In a clean browser the new salon landed on a dashboard with no session, got
 * a 401 and was bounced back to the login form seconds after creating an
 * account. In a browser that already held a session it was worse: the old
 * token stayed and every tenant endpoint answered 403 "Forbidden resource",
 * because the roles on it did not match the new tenant. That is how this was
 * found — the owner console's `saas_owner` token survived a signup and the
 * whole dashboard 403'd.
 */

// The module reads `window` and `localStorage` at call time, so both have to
// exist before it is imported.
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

/** The shape POST /auth/register actually answers with. */
const BACKEND_RESPONSE = {
  user: {
    id: "u-1",
    email: "salon@example.test",
    role: "owner",
    tenantId: "t-1",
  },
  tokens: {
    accessToken: "access-token-for-the-new-salon",
    refreshToken: "refresh-token-for-the-new-salon",
  },
};

async function run(): Promise<void> {
  // A session already in the browser, as the owner console leaves behind.
  store.set("kira_auth_token", "stale-saas-owner-token");
  store.set("kira_refresh_token", "stale-saas-owner-refresh");

  (globalThis as any).fetch = async () => ({
    status: 201,
    ok: true,
    json: async () => BACKEND_RESPONSE,
  });

  const res = await apiClient.register({
    email: "salon@example.test",
    password: "a-password-12",
    salonName: "Salón de prueba",
    phone: "+34600000000",
    ownerName: "Prueba",
    acceptTerms: true,
  });

  console.log("\n=== register returns a usable LoginResponse ===");

  // The bug: this was undefined, which is why the signup page's `if` never ran.
  check("accessToken is present", res.accessToken, BACKEND_RESPONSE.tokens.accessToken);
  check("refreshToken is present", res.refreshToken, BACKEND_RESPONSE.tokens.refreshToken);
  check("the user comes through", res.user.email, BACKEND_RESPONSE.user.email);
  check("with the tenant's owner role", res.user.role, "owner");

  console.log("\n=== and it replaces the session, like login does ===");

  check(
    "the new access token is stored",
    store.get("kira_auth_token"),
    BACKEND_RESPONSE.tokens.accessToken,
  );
  check(
    "the new refresh token is stored",
    store.get("kira_refresh_token"),
    BACKEND_RESPONSE.tokens.refreshToken,
  );
  // The heart of the 403: a surviving token from another role.
  check(
    "no stale token survives the signup",
    store.get("kira_auth_token") === "stale-saas-owner-token",
    false,
  );

  console.log("\n=== a signup into a clean browser also ends up logged in ===");

  store.clear();
  const clean = await apiClient.register({
    email: "otro@example.test",
    password: "a-password-12",
    salonName: "Otro salón",
    phone: "+34600000001",
    ownerName: "Otro",
    acceptTerms: true,
  });

  check("a token exists afterwards", typeof store.get("kira_auth_token"), "string");
  check("and it is the one returned", store.get("kira_auth_token"), clean.accessToken);

  console.log("\n=== Summary ===");
  console.log(`Pass: ${pass}, Fail: ${fail}`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(f);
    process.exit(1);
  } else {
    console.log("✓ All signup-session tests passed.");
  }
}

run().catch((err) => {
  console.error("spec crashed:", err);
  process.exit(1);
});

// Makes this file a module, so `pass` and `fail` stay scoped to it instead of
// colliding with the same names in the other hand-rolled specs.
export {};
