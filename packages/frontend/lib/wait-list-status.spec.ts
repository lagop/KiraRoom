/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/wait-list-status.spec.ts
 *
 * Wait-list entries now expire (dates passed, or 90 days untouched) and
 * clients can leave from the link in a notice; the panel says which. The
 * panel's texts live in messages/es.json with matching en.json keys.
 */

import * as fs from "fs";
import * as path from "path";
import { WAIT_LIST_FILTERS, WAIT_LIST_STATUS_KEY, closedNote, isOpenStatus } from "./wait-list-status";

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

const ROOT = path.join(__dirname, "..");
const es = JSON.parse(fs.readFileSync(path.join(ROOT, "messages/es.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "messages/en.json"), "utf8"));
const text = (messages: any, key: string | null): unknown =>
  key === null ? null : key.split(".").reduce((v: any, k) => (v == null ? undefined : v[k]), messages);

console.log("\n=== statuses ===");
check("expired is shown as Caducado", text(es, WAIT_LIST_STATUS_KEY.expired), "Caducado");
check(
  "there is a Caducados tab",
  WAIT_LIST_FILTERS.some(([k, key]) => k === "expired" && text(es, key) === "Caducados"),
  true,
);
check("an expired entry is not open", isOpenStatus("expired"), false);
check("waiting and notified are open", [isOpenStatus("waiting"), isOpenStatus("notified")], [true, true]);

console.log("\n=== why it closed ===");
check(
  "dates passed",
  text(es, closedNote({ status: "expired", closedReason: "window_passed" })),
  "Caducado: las fechas que pidió ya han pasado.",
);
check(
  "untouched too long",
  text(es, closedNote({ status: "expired", closedReason: "too_old" })),
  "Caducado: llevaba 90 días sin avisos ni cambios.",
);
check(
  "the client left from the link",
  text(es, closedNote({ status: "cancelled", closedReason: "client_left" })),
  "Se quitó de la lista desde el enlace «Ya no me interesa» del aviso.",
);
check("discarded by the salon: nothing to add", closedNote({ status: "cancelled", closedReason: null }), null);
check("an open entry: nothing", closedNote({ status: "waiting" }), null);

console.log("\n=== panel texts: es.json first, en.json to match ===");
function leaves(obj: any, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}
check("es.json and en.json have the same waitList keys", leaves(es.waitList).sort(), leaves(en.waitList).sort());
const page = fs.readFileSync(path.join(ROOT, "app/dashboard/wait-list/page.tsx"), "utf8");
const used = Array.from(page.matchAll(/\bt\("(waitList\.[\w.]+)"/g), (m) => m[1]);
const libKeys = [
  ...Object.values(WAIT_LIST_STATUS_KEY),
  ...WAIT_LIST_FILTERS.map(([, key]) => key),
  ...["window_passed", "too_old", "client_left", null].map((r) => closedNote({ status: "expired", closedReason: r })!),
];
const missing = [...used, ...libKeys].filter(
  (key) => typeof text(es, key) !== "string" || typeof text(en, key) !== "string",
);
check("the page reads its texts from the messages", used.length > 30, true);
check("every key the page and the lib use exists in both languages", missing, []);
check(
  "no hardcoded Spanish left in the page",
  /Lista de espera<|Añadir a la lista|No hay nadie en la lista|Enviar aviso|Cualquier profesional|Avisar a \{/.test(page),
  false,
);

console.log("\n=== the public page ===");
const publicPage = fs.readFileSync(path.join(ROOT, "app/public/lista-espera/[token]/page.tsx"), "utf8");
check(
  "opening the link only reads (GET), the button leaves (POST)",
  /method: "POST"/.test(publicPage) && /onClick=\{leave\}/.test(publicPage),
  true,
);
check("it calls the public wait-list route", publicPage.includes("/public/wait-list/"), true);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All wait-list-status tests passed.");
}
