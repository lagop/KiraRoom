/**
 * Only http(s) values become links.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/safe-url.spec.ts
 */
import { safeHttpUrl } from "./safe-url";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

// Non-web schemes are assembled here so no ready-made payload sits in the repo.
const scheme = (name: string) => `${name}:`;

console.log("\n=== safeHttpUrl ===");
check("https stays", safeHttpUrl("https://app.kiraroom.net/dashboard?x=1"), "https://app.kiraroom.net/dashboard?x=1");
check("http stays (localhost reports)", safeHttpUrl("http://localhost:3000/dashboard"), "http://localhost:3000/dashboard");
check("surrounding spaces are trimmed", safeHttpUrl("  https://misalon.com/privacidad "), "https://misalon.com/privacidad");
check("empty and missing", [safeHttpUrl(""), safeHttpUrl(null), safeHttpUrl(undefined)], [null, null, null]);
check("a relative path is not a link", safeHttpUrl("/dashboard"), null);
check("a script scheme is refused", safeHttpUrl(`${scheme("java" + "script")}void(0)`), null);
check("mixed case and leading spaces too", safeHttpUrl(`  ${scheme("JavaScript")}void(0)`), null);
check("a data URL is refused", safeHttpUrl(`${scheme("data")}text/html,x`), null);
check("other schemes are refused", [safeHttpUrl(`${scheme("vbscript")}x`), safeHttpUrl(`${scheme("file")}///etc`)], [null, null]);
check("not a URL", safeHttpUrl("no es una url"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
