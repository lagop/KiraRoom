/**
 * "Fusionar con otra clienta": the side-by-side preview and the merges the
 * server refuses, shown before confirming.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/client-merge.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import { mergePreviewRows, mergeRefusal, type MergeSide } from "./client-merge";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const KEPT: MergeSide = {
  id: "a",
  firstName: "Ana",
  lastName: "López",
  email: null,
  phone: "+34600111222",
  taxId: null,
  status: "active",
  createdAt: "2025-03-01T10:00:00.000Z",
  appointments: [{}, {}],
};
const OTHER: MergeSide = {
  id: "b",
  firstName: "Ana",
  lastName: "Lopez",
  email: "Ana@Mail.es",
  phone: "+34611222333",
  taxId: "12345678Z",
  status: "active",
  createdAt: "2024-06-01T10:00:00.000Z",
  _count: { appointments: 3 },
};

const rows = mergePreviewRows(KEPT, OTHER);
const row = (label: string) => rows.find((r) => r.label === label)!;

check("the kept record's name stays", row("Nombre").result, "Ana López");
check("an empty email is taken from the other record, in lower case", [row("Email").result, row("Email").filled], ["ana@mail.es", true]);
check("a phone on file is not replaced", [row("Teléfono").result, row("Teléfono").filled], ["+34600111222", false]);
check("an empty tax id is taken from the other record", row("NIF / documento").result, "12345678Z");
check("appointments add up", [row("Citas").kept, row("Citas").other, row("Citas").result], ["2", "3", "5"]);
check("client since: the earlier of the two", row("Clienta desde").result, new Date("2024-06-01T10:00:00.000Z").toLocaleDateString("es-ES", { year: "numeric", month: "short", day: "numeric" }));

check("two active records can be merged", mergeRefusal(KEPT, OTHER), null);
check("not a record with itself", mergeRefusal(KEPT, KEPT), "Es la misma ficha.");
check("not into a deactivated record", /desactivada/.test(mergeRefusal({ ...KEPT, status: "inactive" }, OTHER) ?? ""), true);
check("not a blocked record into one that is not", /bloqueada/.test(mergeRefusal(KEPT, { ...OTHER, status: "blocked" }) ?? ""), true);
check("a blocked record may take another", mergeRefusal({ ...KEPT, status: "blocked" }, OTHER), null);

const detail = fs.readFileSync(path.join(__dirname, "../app/dashboard/clients/[id]/page.tsx"), "utf8");
check("the client file offers the merge to managers only", /manager && \(\s*<ClientMergeDialog/.test(detail), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
