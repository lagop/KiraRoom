/**
 * What the panel says when the API refuses a request (api-error-message.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/api-error-message.spec.ts
 */

import { FORBIDDEN_MESSAGE, apiErrorMessage } from "./api-error-message";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, { actual, expected });
  }
}

console.log("role refusals in Spanish");
check("NestJS's 403 default", apiErrorMessage(403, "Forbidden resource", "x"), FORBIDDEN_MESSAGE);
check("the roles guard's own", apiErrorMessage(403, "This route is not open to your account", "x"), FORBIDDEN_MESSAGE);
check("a 403 with no message", apiErrorMessage(403, undefined, "API Error: 403 Forbidden"), FORBIDDEN_MESSAGE);
check("the message is Spanish", FORBIDDEN_MESSAGE.startsWith("No tienes permiso"), true);

console.log("the server's own messages are kept");
check(
  "a 403 the server explained",
  apiErrorMessage(403, "Solo la dueña o un encargado pueden corregir el pago de una cita.", "x"),
  "Solo la dueña o un encargado pueden corregir el pago de una cita.",
);
check("a validation failure, one sentence per field", apiErrorMessage(400, ["a is wrong", "b is wrong"], "x"), "a is wrong. b is wrong");
check("a 404's message", apiErrorMessage(404, "Cita no encontrada", "x"), "Cita no encontrada");
check("no message: the fallback", apiErrorMessage(500, undefined, "API Error: 500 Internal Server Error"), "API Error: 500 Internal Server Error");
check("'Forbidden resource' on another status is left alone", apiErrorMessage(400, "Forbidden resource", "x"), "Forbidden resource");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
