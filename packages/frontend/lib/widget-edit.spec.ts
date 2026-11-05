/**
 * Editing an existing widget's allowed sites, services and professionals.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/widget-edit.spec.ts
 */
import { draftFrom, parseOrigins, suggestedOrigins, toggleId, widgetUpdateFrom } from "./widget-edit";

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
  primaryColor: "",
});
check("with its colour", draftFrom({ ...widget, theme: { primaryColor: "#0EA5E9" } }).primaryColor, "#0ea5e9");
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
check(
  "the colour goes in the theme, blank for the default",
  [
    widgetUpdateFrom({ allowedOriginsText: "", services: [], professionals: [], primaryColor: "#0ea5e9" }, known).theme,
    widgetUpdateFrom({ allowedOriginsText: "", services: [], professionals: [], primaryColor: "" }, known).theme,
  ],
  [{ primaryColor: "#0ea5e9" }, { primaryColor: null }],
);
check(
  "a new widget is offered the salon's website and live domains",
  suggestedOrigins("http://www.MiSalon.com/reservas", {
    domain: { name: "reservas.misalon.com", active: true } as any,
    subdomain: { host: "misalon.kiraroom.net", active: true },
  }),
  ["https://www.misalon.com", "https://reservas.misalon.com", "https://misalon.kiraroom.net"],
);
check(
  "nothing that is not live or not a URL",
  suggestedOrigins("misalon", { domain: { name: "x.com", active: false } as any, subdomain: { host: "a.kiraroom.net", active: false } }),
  [],
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
