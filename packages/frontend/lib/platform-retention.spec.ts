/**
 * The platform console's retention switch: which state the page shows, when
 * it asks for confirmation, and that its texts exist in both languages.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/platform-retention.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import type { PlatformRetentionConfig } from "./api";
import { needsConfirmation, retentionView } from "./platform-retention";

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

const base: PlatformRetentionConfig = { enabled: false, envOverride: false, effective: false, updatedAt: null, updatedBy: null };

check("off by default: dry run", retentionView(base) === "dry_run");
check("turned on from the console", retentionView({ ...base, enabled: true, effective: true }) === "on");
check("forced on by the server's env var", retentionView({ ...base, envOverride: true, effective: true }) === "on_env");
check("env var and switch both on shows as on", retentionView({ ...base, enabled: true, envOverride: true, effective: true }) === "on");
check("turning ON asks for confirmation", needsConfirmation(base));
check("env override with the switch off: turning it on still asks", needsConfirmation({ ...base, envOverride: true, effective: true }));
check("turning OFF does not ask", !needsConfirmation({ ...base, enabled: true, effective: true }));

// Spanish first, English with the same keys; the dry-run notice no longer names the env var.
const es = JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/es.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/en.json"), "utf8"));
const keys = Object.keys(es.saas.retention_setting);
check("retention_setting texts exist", keys.length > 10, keys.length);
check(
  "en.json has the same retention_setting keys",
  JSON.stringify(keys.sort()) === JSON.stringify(Object.keys(en.saas.retention_setting).sort()),
);
check("the confirmation says it is irreversible and that invoices are kept", /irreversible/i.test(es.saas.retention_setting.confirm_body) && /factura/i.test(es.saas.retention_setting.confirm_body));
check("the dry-run notice points to the console, not the env var", !/RETENTION_ANONYMIZE_ENABLED/.test(es.saas.weekly.retention_dry_run) && !/RETENTION_ANONYMIZE_ENABLED/.test(en.saas.weekly.retention_dry_run));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
