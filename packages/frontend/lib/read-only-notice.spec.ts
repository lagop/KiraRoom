/**
 * The read-only notice: shown for a cancelled or suspended salon, never for
 * one in trial or with a plan, and never before the server has confirmed
 * the status (the token's fallback is "cancelled").
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/read-only-notice.spec.ts
 */
import { readOnlyNotice } from "./read-only-notice";

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

const base = { confirmed: true, readOnlyUntil: null as string | null };

const cancelled = readOnlyNotice({ ...base, subscriptionStatus: "cancelled", readOnlyUntil: "2026-11-11T00:00:00.000Z" });
check("a cancelled salon is told it is read-only", cancelled?.title === "Tu cuenta está en modo solo lectura.", cancelled);
check("and until when its data is kept", !!cancelled?.body.includes("se conservan hasta el 11 de noviembre de 2026"), cancelled?.body);
check("and offered a plan", cancelled?.cta === "Elegir un plan", cancelled?.cta);

const suspended = readOnlyNotice({ ...base, subscriptionStatus: "suspended" });
check("a suspended salon is asked to fix the payment", suspended?.cta === "Actualizar el pago", suspended);
check("with no date when there is none", !!suspended && !suspended.body.includes("conservan"), suspended?.body);

for (const status of ["trialing", "active", "past_due"]) {
  check(`nothing for ${status}`, readOnlyNotice({ ...base, subscriptionStatus: status }) === null);
}
check(
  "nothing before the server confirms the status",
  readOnlyNotice({ confirmed: false, subscriptionStatus: "cancelled", readOnlyUntil: null }) === null,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
