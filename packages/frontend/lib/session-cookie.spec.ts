/**
 * The refresh token moved from localStorage to an httpOnly cookie on the API
 * host, so the browser side now:
 * - sends credentials with every call (sign-in sets the cookie, logout clears it);
 * - refreshes with the cookie, passing a token still in localStorage once so
 *   the server can move it to the cookie, and `kind: "client"` on a salon's site;
 * - logs out on the server, not just locally: otherwise the next page load
 *   would renew the session from the cookie.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/session-cookie.spec.ts
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

type Call = { url: string; init: any };
function mockFetch(respond: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const call = { url, init };
    calls.push(call);
    const r = respond(call);
    return { status: r.status, ok: r.status < 400, json: async () => r.body ?? {} };
  };
  return calls;
}

async function run() {
  console.log("\n=== refresh uses the cookie ===");
  store.clear();
  store.set("kira_refresh_token", "legacy-refresh");
  let calls = mockFetch(() => ({ status: 200, body: { accessToken: "new-access", expiresIn: 900 } }));
  let ok = await apiClient.refreshAccessToken();
  const body = JSON.parse(calls[0].init.body);
  check("it succeeds", ok === true);
  check("with credentials, so the cookie goes along", calls[0].init.credentials === "include", calls[0].init);
  check("passing the token a pre-cookie sign-in left in localStorage", body.refreshToken === "legacy-refresh", body);
  check("the new access token is stored", store.get("kira_auth_token") === "new-access");
  check("and the old refresh token leaves localStorage", !store.has("kira_refresh_token"));

  calls = mockFetch(() => ({ status: 200, body: { accessToken: "a" } }));
  await apiClient.refreshAccessToken();
  check("without one, the body carries no token", !("refreshToken" in JSON.parse(calls[0].init.body)));

  console.log("\n=== a client on a salon's site asks for its own cookie ===");
  store.clear();
  store.set("user", JSON.stringify({ role: "client" }));
  calls = mockFetch(() => ({ status: 200, body: { accessToken: "a" } }));
  await apiClient.refreshAccessToken();
  check("kind: client", JSON.parse(calls[0].init.body).kind === "client", calls[0].init.body);

  console.log("\n=== a refused refresh ===");
  store.clear();
  store.set("kira_refresh_token", "stale");
  mockFetch(() => ({ status: 401 }));
  ok = await apiClient.refreshAccessToken();
  check("returns false", ok === false);
  check("and drops the stale token", !store.has("kira_refresh_token"));

  console.log("\n=== logout ends the session on the server ===");
  store.clear();
  store.set("kira_auth_token", "access");
  calls = mockFetch(() => ({ status: 200, body: { message: "ok" } }));
  await apiClient.logout();
  check("POST /auth/logout", calls.length === 1 && calls[0].url.endsWith("/auth/logout") && calls[0].init.method === "POST", calls);
  check("with credentials, so the cookie can be cleared", calls[0]?.init.credentials === "include");
  check("then the local token goes", !store.has("kira_auth_token"));

  store.clear();
  store.set("kira_auth_token", "access");
  (globalThis as any).fetch = async () => {
    throw new Error("offline");
  };
  await apiClient.logout();
  check("offline, the local token still goes", !store.has("kira_auth_token"));

  console.log("\n=== sign-in keeps no refresh token in the page ===");
  store.clear();
  store.set("kira_refresh_token", "from-before");
  calls = mockFetch(() => ({
    status: 200,
    body: { user: { id: "u", email: "e@x.test", role: "owner", tenantId: "t" }, tokens: { accessToken: "acc", expiresIn: 900 } },
  }));
  await apiClient.login("e@x.test", "contraseña-larga");
  check("login sends credentials", calls[0].init.credentials === "include");
  check("stores the access token", store.get("kira_auth_token") === "acc");
  check("and no refresh token", !store.has("kira_refresh_token"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
