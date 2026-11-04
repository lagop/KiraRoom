/**
 * Run via:
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/embed-snippet.spec.ts
 *
 * The widget's embed code: an iframe named for the salon, sized by a small
 * script to the height the widget reports (a bare number, from the widget's
 * own origin and iframe only).
 */
import { buildEmbedSnippet, embedOrigin, postEmbedHeight, MAX_EMBED_HEIGHT } from "./embed-snippet";

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

const token = "a".repeat(16) + "B".repeat(16); // a fake widget token, built at runtime
const snippet = buildEmbedSnippet(token, "https://app.kiraroom.net/", 'Salón "Luna" & Co');

console.log("\n=== snippet ===");
check("the iframe points at the widget", snippet.includes(`src="https://app.kiraroom.net/embed/${token}"`), true);
check("it is named for the salon, escaped", snippet.includes('title="Reservar cita en Salón &quot;Luna&quot; &amp; Co"'), true);
check("without a name, a generic title", buildEmbedSnippet(token, "https://app.kiraroom.net").includes('title="Reservar cita"'), true);
check("the script only listens to the widget's origin", snippet.includes('e.origin!=="https://app.kiraroom.net"'), true);
check("and to that iframe", snippet.includes("e.source!==f.contentWindow"), true);
check("and only to a number", snippet.includes('typeof h==="number"'), true);
check("the script finds the iframe by its id", snippet.includes(`getElementById("kiraroom-widget-${token}")`), true);
check("origin of a base with a path", embedOrigin("https://app.kiraroom.net/x/"), "https://app.kiraroom.net");

console.log("\n=== the height the widget reports ===");
const sent: unknown[] = [];
const parent = { postMessage: (m: unknown, origin: string) => sent.push([m, origin]) };
check("sends a whole number", postEmbedHeight(parent, 812.4), true);
check("the same height again is not sent", postEmbedHeight(parent, 813), false);
check("nonsense is not sent", [postEmbedHeight(parent, 0), postEmbedHeight(parent, NaN), postEmbedHeight(parent, MAX_EMBED_HEIGHT + 1)], [false, false, false]);
postEmbedHeight(parent, 900);
check("only numbers go out", sent, [[813, "*"], [900, "*"]]);

console.log(`\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
