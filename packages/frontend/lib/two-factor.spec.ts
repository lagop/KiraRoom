/**
 * Two-step verification in the browser: login answering a challenge instead
 * of a session, the code step, and the recovery-codes file.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/two-factor.spec.ts
 */
export {};

const store = new Map<string, string>();
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const api = require("./api");
const apiClient = api.default;
const { recoveryCodesFile } = require("./two-factor");

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

type Call = { url: string; init: any };
function mockFetch(respond: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = respond({ url, init });
    return { status: r.status, ok: r.status < 400, statusText: "", json: async () => r.body ?? {} };
  };
  return calls;
}

async function run() {
  console.log("\n=== login with two-step verification ===");
  store.clear();
  mockFetch(() => ({ status: 200, body: { twoFactorRequired: true, challenge: "ch-1" } }));
  const first = await apiClient.login("duena@salon.test", "contraseña-larga");
  check("login answers the challenge", api.isTwoFactorRequired(first) && first.challenge === "ch-1", first);
  check("and starts no session yet", !store.has("kira_auth_token"));

  let calls = mockFetch(() => ({
    status: 200,
    body: { user: { id: "u1", role: "owner", tenantId: "t1" }, tokens: { accessToken: "acc", expiresIn: 900 } },
  }));
  const second = await apiClient.verifyTwoFactor("ch-1", " 123456 ");
  const body = JSON.parse(calls[0].init.body);
  check("the code goes to /auth/2fa/verify with the challenge", calls[0].url.endsWith("/auth/2fa/verify") && body.challenge === "ch-1", calls[0]);
  check("trimmed", body.code === "123456", body);
  check("with credentials, so the refresh cookie is set", calls[0].init.credentials === "include");
  check("the session starts", store.get("kira_auth_token") === "acc" && second.user.id === "u1");

  console.log("\n=== a wrong code is an answer, not an expired session ===");
  check("/auth/2fa/verify is a credential endpoint", api.isCredentialEndpoint("/auth/2fa/verify"));
  store.clear();
  calls = mockFetch(() => ({ status: 401, body: { message: "El código no es correcto." } }));
  let message = "";
  try {
    await apiClient.verifyTwoFactor("ch-1", "000000");
  } catch (e: any) {
    message = e.message;
  }
  check("the server's message reaches the form", message === "El código no es correcto.", message);
  check("and nothing tried to refresh a session", calls.length === 1, calls.map((c) => c.url));

  console.log("\n=== an account without it signs in as before ===");
  store.clear();
  mockFetch(() => ({ status: 200, body: { user: { id: "u2", role: "owner" }, tokens: { accessToken: "acc2" } } }));
  const plain = await apiClient.login("otra@salon.test", "contraseña-larga");
  check("a session straight away", !api.isTwoFactorRequired(plain) && store.get("kira_auth_token") === "acc2");

  console.log("\n=== recovery codes file ===");
  const file = recoveryCodesFile(["abcd-efgh", "jkmn-pqrs"], new Date("2026-10-24T10:00:00Z"));
  check("lists every code", file.includes("abcd-efgh\njkmn-pqrs"));
  check("says when and how to use them", /24 de octubre de 2026/.test(file) && /una sola vez/.test(file), file);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
