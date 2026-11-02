/**
 * Datos del salón: blank optional fields clear what was stored.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/salon-identity.spec.ts
 */
import { salonIdentityUpdate } from "./salon-identity";

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

const fields = {
  name: " Salón Luna ",
  description: "Peluquería de barrio",
  street: "Calle Mayor 1",
  city: "Madrid",
  postalCode: "28013",
  state: "Madrid",
  phone: "600 111 222",
  logo: "",
};

check("filled fields are sent trimmed", salonIdentityUpdate(fields), {
  name: "Salón Luna",
  description: "Peluquería de barrio",
  street: "Calle Mayor 1",
  city: "Madrid",
  postalCode: "28013",
  state: "Madrid",
  phone: "600 111 222",
  logo: "",
});

const cleared = salonIdentityUpdate({ ...fields, description: "  ", postalCode: "", state: "", phone: " " });
check("emptied description, postal code, province and phone are sent as null (cleared)", [
  cleared.description,
  cleared.postalCode,
  cleared.state,
  cleared.phone,
], [null, null, null, null]);
check("null is in the body, so the server sees it", "description" in cleared && JSON.stringify(cleared).includes('"description":null'), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
