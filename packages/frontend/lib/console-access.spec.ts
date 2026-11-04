/**
 * Audit 8 (console access): the support-session entry, the per-tab session
 * storage and the audit-log page's helpers.
 * Run with: ts-node --project tsconfig.test.json --transpile-only lib/console-access.spec.ts
 */
import { supportEntryUrl, supportReasonProblem } from "./support-session";
import { auditActionKey, auditPersonLabel } from "./audit-log-view";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = new MemoryStorage();
(globalThis as any).sessionStorage = new MemoryStorage();

const storage = require("./auth-storage") as typeof import("./auth-storage");

// C17
check("a reason is required", supportReasonProblem("  ab ") !== null, true);
check("a long reason is refused", supportReasonProblem("x".repeat(201)) !== null, true);
check("a normal reason passes", supportReasonProblem("La dueña pidió ayuda con la agenda"), null);

// C10: the token travels in the fragment, never the query
const url = supportEntryUrl({ token: "a.b.c", tenantId: "t-1", tenantName: "Salón Lucía", ownerName: "Lucía" });
check("entry url has no query", url.startsWith("/login#") && !url.includes("?"), true);
const hash = new URLSearchParams(url.split("#")[1]);
check("token in the fragment", hash.get("support"), "a.b.c");
check("salon name in the fragment", hash.get("name"), "Salón Lucía");

// C10: a support tab keeps its session apart from the console's
(globalThis as any).localStorage.setItem("kira_auth_token", "console-token");
check("a normal tab reads the console's session", storage.authStorage().getItem("kira_auth_token"), "console-token");
storage.startSupportTab({ tenantId: "t-1", tenantName: "Salón Lucía" });
storage.authStorage().setItem("kira_auth_token", "support-token");
check("the support tab has its own token", storage.authStorage().getItem("kira_auth_token"), "support-token");
check("the console's token is untouched", (globalThis as any).localStorage.getItem("kira_auth_token"), "console-token");
storage.updateSupportTab({ endsAt: "2026-11-04T12:00:00.000Z" });
check("the tab knows when it ends", storage.supportTab()?.endsAt, "2026-11-04T12:00:00.000Z");
storage.endSupportTab();
check("leaving support: back to the console's session", storage.authStorage().getItem("kira_auth_token"), "console-token");
check("leaving support: nothing left in the tab", (globalThis as any).sessionStorage.getItem("kira_auth_token"), null);

// C9 page helpers
check("action key", auditActionKey("tenant.taxId.change"), "saas.audit.actions.tenant_taxId_change");
check("person with name", auditPersonLabel({ email: "a@b.es", firstName: "Ana", lastName: "López" }), "Ana López (a@b.es)");
check("person without name", auditPersonLabel({ email: "a@b.es", firstName: null, lastName: "" }), "a@b.es");
check("nobody", auditPersonLabel(null), "—");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
