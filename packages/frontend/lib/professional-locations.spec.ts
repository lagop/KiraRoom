/**
 * The team form's locations: ticking, the main one, and what is sent.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/professional-locations.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  NO_LOCATIONS,
  assignableLocations,
  locationsOf,
  locationsPayload,
  makePrimary,
  toggleLocation,
} from "./professional-locations";

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
function same(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

console.log("ticking locations");
const one = toggleLocation(NO_LOCATIONS, "centro");
same("the first one ticked is the main one", one, { ids: ["centro"], primary: "centro" });
const two = toggleLocation(one, "playa");
same("a second one keeps the main one", two, { ids: ["centro", "playa"], primary: "centro" });
same("unticking the main one passes it on", toggleLocation(two, "centro"), { ids: ["playa"], primary: "playa" });
same("unticking the last one leaves none", toggleLocation(one, "centro"), { ids: [], primary: null });
same("making another the main one", makePrimary(two, "playa"), { ids: ["centro", "playa"], primary: "playa" });
same("making an unticked one the main one ticks it", makePrimary(one, "playa"), {
  ids: ["centro", "playa"],
  primary: "playa",
});

console.log("what the professional has");
same(
  "read from the API, main one first or flagged",
  locationsOf({ locations: [{ locationId: "centro" }, { locationId: "playa", isPrimary: true }] }),
  { ids: ["centro", "playa"], primary: "playa" },
);
same("none", locationsOf({}), { ids: [], primary: null });

console.log("what is sent");
same("untouched: nothing (a salon without multi-local sends nothing)", locationsPayload(two, false), {});
same("touched: the list and the main one", locationsPayload(two, true), {
  locationIds: ["centro", "playa"],
  primaryLocationId: "centro",
});
same("touched and emptied: none", locationsPayload(NO_LOCATIONS, true), { locationIds: [], primaryLocationId: null });
same(
  "only open locations are offered",
  assignableLocations([{ id: "a", isActive: true }, { id: "b", isActive: false }, { id: "c" }]).map((l: any) => l.id),
  ["a", "c"],
);

console.log("the forms");
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
check("the new professional form has the picker", read("app/dashboard/professionals/new/components/professional-form.tsx").includes("<LocationsPicker"));
check("the edit form has the picker", read("app/dashboard/professionals/[id]/edit/page.tsx").includes("<LocationsPicker"));
const es = JSON.parse(read("messages/es.json"));
const en = JSON.parse(read("messages/en.json"));
for (const key of ["locations", "locationsHint", "mainLocation", "makeMain"]) {
  check(`es.json and en.json have professionals.fields.${key}`, !!es.professionals.fields[key] && !!en.professionals.fields[key]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
