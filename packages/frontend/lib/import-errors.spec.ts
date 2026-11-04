/**
 * The CSV of rows an import left out.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/import-errors.spec.ts
 */
import { csvCell, errorReasons, errorRowsCsv } from "./import-errors";

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

console.log("csvCell");
check("plain text as is", csvCell("María"), "María");
check("commas quoted", csvCell("García, López"), '"García, López"');
check("quotes doubled", csvCell('Dice "hola"'), '"Dice ""hola"""');
check("formula start neutralised", csvCell("=1+1"), "'=1+1");
check("plus start neutralised", csvCell("+34 600"), "'+34 600");
check("at start neutralised", csvCell("@x"), "'@x");
check("empty for undefined", csvCell(undefined), "");

console.log("errorRowsCsv");
const csv = errorRowsCsv([
  { row: 5, fields: [{ col: "Email", msg: "no es válido" }], data: { Nombre: "Pedro", Email: "pedro@" } },
  {
    row: 3,
    fields: [
      { col: "Teléfono", msg: "falta" },
      { col: "Email", msg: "falta" },
    ],
    data: { Nombre: "Ana", Notas: "VIP" },
  },
]);
const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
check("starts with a BOM", csv.charCodeAt(0), 0xfeff);
check("header: file columns, then Fila and Errores", lines[0], "Nombre,Email,Notas,Fila,Errores");
check("sorted by row, empty for a missing column", lines[1], 'Ana,,VIP,3,"Teléfono: falta; Email: falta"');
check("second row", lines[2], "Pedro,pedro@,,5,Email: no es válido");
check("reasons joined", errorReasons({ row: 1, fields: [{ col: "A", msg: "b" }] }), "A: b");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
