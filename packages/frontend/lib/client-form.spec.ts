/**
 * The clients panel's add / edit drawers: client row → fields → API body.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/client-form.spec.ts
 *
 * The drawers' inputs had an id and no name while the change handler read
 * `e.target.name`, so nothing typed reached the form. The edit drawer also
 * showed no date of birth (an ISO string in a date input), could not empty
 * a field, and the add drawer sent "" for the email, date and gender.
 */
import * as fs from "fs";
import * as path from "path";
import {
  EMPTY_CLIENT_FORM,
  clientToForm,
  createClientPayload,
  formatClientDate,
  formatClientDay,
  isoToDateInput,
  updateClientPayload,
  type ClientFormValues,
} from "./client-form";

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

const manager = { canManage: true };
const staff = { canManage: false };

// ----- Row → form ------------------------------------------------------------

const ROW = {
  firstName: "Lucía",
  lastName: "García",
  email: "lucia@example.com",
  phone: null,
  dateOfBirth: "1990-05-17T00:00:00.000Z",
  gender: "female",
  status: "inactive",
  notes: null,
  taxId: "12345678Z",
  taxIdType: "nif",
};

const form = clientToForm(ROW);
check("the date of birth shows in the date input (ISO → YYYY-MM-DD)", form.dateOfBirth, "1990-05-17");
check("nulls become empty fields", [form.phone, form.notes], ["", ""]);
check("gender, status and NIF carried over", [form.gender, form.status, form.taxId, form.taxIdType], ["female", "inactive", "12345678Z", "nif"]);
check("an unknown gender / tax type falls back", [clientToForm({ ...ROW, gender: "x", taxIdType: null }).gender, clientToForm({ ...ROW, taxIdType: null }).taxIdType], ["", "nif"]);
check("isoToDateInput of nothing is empty", [isoToDateInput(null), isoToDateInput(""), isoToDateInput("garbage")], ["", "", ""]);

// ----- Add drawer ------------------------------------------------------------

const added: ClientFormValues = { ...EMPTY_CLIENT_FORM, firstName: " Ana ", lastName: "Ruiz", notes: "Tinte 6.1" };
check(
  "add: empty email / date / gender / NIF are left out, notes and status kept",
  createClientPayload(added, manager),
  { firstName: "Ana", lastName: "Ruiz", notes: "Tinte 6.1", status: "active" },
);
check(
  "add: a NIF is sent uppercase without spaces, with its type",
  createClientPayload({ ...added, taxId: "12345678 z", taxIdType: "nif" }, manager),
  { firstName: "Ana", lastName: "Ruiz", notes: "Tinte 6.1", status: "active", taxId: "12345678Z", taxIdType: "nif" },
);
check(
  "add: staff do not choose the status",
  "status" in createClientPayload(added, staff),
  false,
);
check(
  "add: filled fields are sent",
  createClientPayload({ ...added, email: "ana@example.com", dateOfBirth: "1991-01-02", gender: "female", phone: "600" }, manager),
  { firstName: "Ana", lastName: "Ruiz", email: "ana@example.com", phone: "600", dateOfBirth: "1991-01-02", gender: "female", notes: "Tinte 6.1", status: "active" },
);

// ----- Edit drawer -----------------------------------------------------------

const emptied: ClientFormValues = { ...form, email: "", dateOfBirth: "", gender: "", notes: " ", taxId: "" };
check(
  "edit: emptied fields are sent as null so the server empties them",
  updateClientPayload(emptied, manager),
  {
    firstName: "Lucía",
    lastName: "García",
    phone: null,
    dateOfBirth: null,
    gender: null,
    notes: null,
    taxId: null,
    taxIdType: null,
    email: null,
    status: "inactive",
  },
);
check(
  "edit: the NIF and its type are sent",
  updateClientPayload({ ...form, taxId: "ab 123", taxIdType: "passport" }, manager),
  {
    firstName: "Lucía",
    lastName: "García",
    phone: null,
    dateOfBirth: "1990-05-17",
    gender: "female",
    notes: null,
    taxId: "AB123",
    taxIdType: "passport",
    email: "lucia@example.com",
    status: "inactive",
  },
);
const staffEdit = updateClientPayload(form, staff);
check("edit: staff never send the email or the status", ["email" in staffEdit, "status" in staffEdit], [false, false]);

// ----- Spanish dates -----------------------------------------------------------

check("a date of birth is the calendar day, in Spanish", formatClientDay("1990-05-17T00:00:00.000Z"), "17 may 1990");
check("nothing to format is empty", [formatClientDate(null), formatClientDate("nope")], ["", ""]);

// ----- The page wires every field ------------------------------------------------

const page = fs.readFileSync(path.join(__dirname, "../app/dashboard/clients/page.tsx"), "utf8");
const inputs = page.match(/<(input|select|textarea)\b[^>]*>/g) ?? [];
// Both drawers render ClientFormFields, whose inputs call its onChange prop.
const formInputs = inputs.filter((tag) => /onChange=\{onChange\}/.test(tag));
check("the drawers have form fields", formInputs.length, 10);
check("both drawers use the shared fields", (page.match(/<ClientFormFields\b/g) ?? []).length, 2);
check(
  "the drawers' handlers read the input's name",
  (page.match(/const \{ name, value \} = e\.target;/g) ?? []).length,
  2,
);
check(
  "every drawer field has a name (the change handler reads it)",
  formInputs.filter((tag) => !/\bname="\w+"/.test(tag)),
  [],
);
const formKeys = Object.keys(EMPTY_CLIENT_FORM).sort();
const names = Array.from(new Set(formInputs.map((tag) => /\bname="(\w+)"/.exec(tag)?.[1]))).sort();
check("the names are the form's fields", names, formKeys);
check("the page no longer casts the API client to any", /apiClient as any/.test(page), false);

const detail = fs.readFileSync(path.join(__dirname, "../app/dashboard/clients/[id]/page.tsx"), "utf8");
check("the client file does not use React's use(params) (Next 15 only)", /\buse\(params\)/.test(detail), false);

// ----- Phase 3: list, delete, labels ------------------------------------------

check("the list is paged and searched by the server", /apiClient\s*\.getClientsPage\(/.test(page), true);
check("the list no longer loads every client to filter in the browser", /apiClient\.getClients\(\)/.test(page), false);
check("the list has a status filter", /setStatusFilter\(/.test(page), true);
check("deleting is confirmed in the panel's dialog, not a toast", /<ConfirmDialog/.test(page) && !/toastId/.test(page), true);
check("the delete dialog's buttons are off while it runs", /loading=\{deleting\}/.test(page), true);
check("sortable headers are buttons (reachable with the keyboard)", /aria-sort=/.test(page) && !/<th[^>]*onClick/.test(page), true);
check("the drawers scroll on a phone", (page.match(/className=\{`\$\{DRAWER_CONTENT\}/g) ?? []).length, 2);

const messages: Record<string, any> = {
  es: JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/es.json"), "utf8")),
  en: JSON.parse(fs.readFileSync(path.join(__dirname, "../messages/en.json"), "utf8")),
};
for (const lang of ["es", "en"]) {
  for (const status of ["scheduled", "sent", "cancelled", "failed", "booked"]) {
    check(`${lang}: rebooking status "${status}" has a label`, typeof messages[lang].rebooking.status[status], "string");
  }
  for (const key of ["deleting", "page_summary", "previous_page", "next_page", "pagination", "sort_by_column"]) {
    check(`${lang}: clients.${key}`, typeof messages[lang].clients[key], "string");
  }
}
check("the reminder history shows the status label, not the raw value", />\{r\.status\}</.test(detail), false);
check(
  "the delete warning says she is only deactivated when she has history",
  /inactiva/.test(messages.es.clients.delete_warning_message),
  true,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
