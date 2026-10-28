/**
 * The platform console's Email page: the status line and what "Guardar" sends.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/platform-email.spec.ts
 */
import type { PlatformEmailConfig } from "./api";
import { emailStatus, emailUpdate, sourceText } from "./platform-email";

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

const none: PlatformEmailConfig = {
  apiKey: { source: "none", lastFour: null },
  from: { source: "none", value: null },
  webhookSecret: { source: "none", lastFour: null },
  updatedAt: null,
  updatedBy: null,
};
const sending: PlatformEmailConfig = {
  ...none,
  apiKey: { source: "console", lastFour: "1234" },
  from: { source: "server", value: "noreply@kiraroom.com" },
};

check("nothing set: says no email goes out", !emailStatus(none).ok && /clave de Resend/.test(emailStatus(none).text));
check(
  "a key without a sender is not enough",
  !emailStatus({ ...none, apiKey: sending.apiKey }).ok,
);
check("key and sender: emails go out, tracking missing", emailStatus(sending).ok && /webhook/.test(emailStatus(sending).text));
check(
  "everything set",
  /entregas/.test(emailStatus({ ...sending, webhookSecret: { source: "console", lastFour: "abcd" } }).text),
);

check("where each setting comes from", sourceText("console") === "Configurada aquí" && /servidor/.test(sourceText("server")));

check("nothing typed: nothing to save", emailUpdate({ apiKey: "", from: "noreply@kiraroom.com", webhookSecret: "" }, sending) === null);
// Built at runtime: a fictitious value that only looks like a Resend key.
const typedKey = ["re", "abc12345678"].join("_");
check(
  "a typed key is sent, blank secret kept",
  JSON.stringify(emailUpdate({ apiKey: ` ${typedKey} `, from: "noreply@kiraroom.com", webhookSecret: "" }, sending)) ===
    JSON.stringify({ apiKey: typedKey }),
);
check(
  "a changed sender is sent",
  emailUpdate({ apiKey: "", from: "KiraRoom <notificaciones@kiraroom.com>", webhookSecret: "" }, sending)?.from ===
    "KiraRoom <notificaciones@kiraroom.com>",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
