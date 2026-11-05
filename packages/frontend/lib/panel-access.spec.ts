/**
 * A professional's panel login as the team screen shows it.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/panel-access.spec.ts
 */
import { MIN_PASSWORD, accessInstructions, panelAccessText, passwordProblem } from "./panel-access";

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

check("no login yet: says what they cannot do", /no puede ver ni gestionar sus citas/.test(panelAccessText({ status: "none" })));
check("no data at all reads the same", panelAccessText(undefined) === panelAccessText({ status: "none" }));
check("active, never signed in", /Entra con ana@salon\.test\. Aún no ha entrado/.test(panelAccessText({ status: "active", email: "ana@salon.test", lastLoginAt: null })));
check(
  "active, with the last sign-in",
  /Último acceso: \d+ \w+/.test(panelAccessText({ status: "active", email: "a@b.test", lastLoginAt: "2026-10-20T10:00:00Z" })),
  panelAccessText({ status: "active", email: "a@b.test", lastLoginAt: "2026-10-20T10:00:00Z" }),
);
check("removed", /Acceso quitado/.test(panelAccessText({ status: "revoked", email: "a@b.test" })));
check("the owner's own record", /cuenta principal/.test(panelAccessText({ status: "owner", email: "o@b.test" })));

check("same minimum as signing in", MIN_PASSWORD === 8);
check("too short", passwordProblem("corta", "corta") !== null);
check("mismatch", /no coinciden/.test(passwordProblem("una-clave-larga", "otra-clave-larga") ?? ""));
check("good", passwordProblem("una-clave-larga", "una-clave-larga") === null);

const text = accessInstructions("ana@salon.test", "https://app.kiraroom.net/login");
check("instructions name the address and the email", text.includes("https://app.kiraroom.net/login") && text.includes("ana@salon.test"));
check("and never contain the password", !/clave-larga/.test(text));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
