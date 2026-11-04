/**
 * The widget in the salon's main colour.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/embed-theme.spec.ts
 */
import { embedTheme, onColor, validHexColor } from "./embed-theme";

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

check("a hex colour, lower-cased", validHexColor(" #1A2B3C "), "#1a2b3c");
check("nothing else", ["red", "#fff", "#12345g", "url(x)", "#123456;}", 3, null].map(validHexColor), [
  null,
  null,
  null,
  null,
  null,
  null,
  null,
]);
check("white text on a dark colour", onColor("#7c3aed"), "#ffffff");
check("dark text on a light colour", onColor("#fde047"), "#111827");
check("no colour: the default purple", embedTheme(undefined), null);
check("an invalid one too", embedTheme("javascript:alert(1)"), null);
const theme = embedTheme("#0EA5E9");
check("the variables", theme?.vars, { "--kr-primary": "#0ea5e9", "--kr-on-primary": "#111827" });
check("the stylesheet is scoped", theme?.css.split("\n").every((l) => l.startsWith("[data-kr-theme]")), true);
check("and has no colour of its own in it", theme?.css.includes("#0ea5e9"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
