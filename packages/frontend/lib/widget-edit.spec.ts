/**
 * Editing an existing widget's allowed sites, services and professionals.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/widget-edit.spec.ts
 */
import { draftFrom, parseOrigins, toggleId, widgetUpdateFrom } from "./widget-edit";

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

check("one site per line, blanks dropped", parseOrigins(" https://misalon.com \n\n https://misalon.es\n"), [
  "https://misalon.com",
  "https://misalon.es",
]);

const widget = { allowedOrigins: ["https://misalon.com"], services: ["s1"], professionals: [] as string[] };
const draft = draftFrom(widget);
check("the editor starts from what the widget has", draft, {
  allowedOriginsText: "https://misalon.com",
  services: ["s1"],
  professionals: [],
});
check("editing the draft leaves the widget alone", (draft.services.push("s2"), widget.services), ["s1"]);

check("toggling adds and removes", [toggleId(["a"], "b"), toggleId(["a", "b"], "a")], [["a", "b"], ["b"]]);

const known = { services: [{ id: "s1" }, { id: "s2" }], professionals: [{ id: "p1" }] };
check(
  "the PATCH body, with ids the salon no longer has dropped",
  widgetUpdateFrom(
    { allowedOriginsText: "https://misalon.com\nhttps://www.misalon.com", services: ["s1", "gone"], professionals: ["p1"] },
    known,
  ),
  { allowedOrigins: ["https://misalon.com", "https://www.misalon.com"], services: ["s1"], professionals: ["p1"] },
);
check(
  "an emptied list means any site / every service / every professional",
  widgetUpdateFrom({ allowedOriginsText: "  ", services: [], professionals: [] }, known),
  { allowedOrigins: [], services: [], professionals: [] },
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
