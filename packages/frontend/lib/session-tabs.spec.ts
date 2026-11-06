/**
 * A tab notices when another tab signed out or in as someone else (another
 * salon), so it does not go on showing the old salon's data.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/session-tabs.spec.ts
 */
import { sessionChangedAcrossTabs } from "./session-tabs";

let fail = 0;
function check(name: string, ok: boolean) {
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
}

const user = (id: string, tenantId: string) => JSON.stringify({ id, tenantId, role: "owner" });

check("another tab signed out", sessionChangedAcrossTabs(user("u1", "A"), null));
check("another person signed in", sessionChangedAcrossTabs(user("u1", "A"), user("u2", "B")));
check("same person, another salon", sessionChangedAcrossTabs(user("u1", "A"), user("u1", "B")));
check("same person and salon: nothing to do", !sessionChangedAcrossTabs(user("u1", "A"), user("u1", "A")));
check("a tab that showed no session is left alone", !sessionChangedAcrossTabs(null, user("u1", "A")));

if (fail > 0) process.exit(1);
