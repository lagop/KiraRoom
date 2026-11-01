/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/wait-list-status.spec.ts
 *
 * Wait-list entries now expire (dates passed, or 90 days untouched) and
 * clients can leave from the link in a notice; the panel says which.
 */

import * as fs from "fs";
import * as path from "path";
import { WAIT_LIST_FILTERS, WAIT_LIST_STATUS_LABEL, closedNote, isOpenStatus } from "./wait-list-status";

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

console.log("\n=== statuses ===");
check("expired is shown as Caducado", WAIT_LIST_STATUS_LABEL.expired, "Caducado");
check("there is a Caducados tab", WAIT_LIST_FILTERS.some(([k, l]) => k === "expired" && l === "Caducados"), true);
check("an expired entry is not open", isOpenStatus("expired"), false);
check("waiting and notified are open", [isOpenStatus("waiting"), isOpenStatus("notified")], [true, true]);

console.log("\n=== why it closed ===");
check("dates passed", closedNote({ status: "expired", closedReason: "window_passed" }), "Caducado: las fechas que pidió ya han pasado.");
check("untouched too long", closedNote({ status: "expired", closedReason: "too_old" }), "Caducado: llevaba 90 días sin avisos ni cambios.");
check(
  "the client left from the link",
  closedNote({ status: "cancelled", closedReason: "client_left" }),
  "Se quitó de la lista desde el enlace «Ya no me interesa» del aviso.",
);
check("discarded by the salon: nothing to add", closedNote({ status: "cancelled", closedReason: null }), null);
check("an open entry: nothing", closedNote({ status: "waiting" }), null);

console.log("\n=== the public page ===");
const ROOT = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(ROOT, "app/public/lista-espera/[token]/page.tsx"), "utf8");
check("opening the link only reads (GET), the button leaves (POST)", /method: "POST"/.test(page) && /onClick=\{leave\}/.test(page), true);
check("it calls the public wait-list route", page.includes("/public/wait-list/"), true);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All wait-list-status tests passed.");
}
