/**
 * The widget page's frame-ancestors header, from the widget's allowed origins.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/embed-frame.spec.ts
 */
import { embedToken, frameAncestorsHeader } from "./embed-frame";

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

const token = "a".repeat(16) + "B".repeat(16); // a fake widget token, built at runtime
check("reads the token from /embed/<token>", embedToken(`/embed/${token}`) === token);
check("and with a trailing slash", embedToken(`/embed/${token}/`) === token);
check("not other paths", embedToken("/embed/") === null && embedToken(`/sites/x/embed/${token}`) === null);
check("not a short or odd token", embedToken("/embed/abc") === null && embedToken("/embed/a;b%20cdefghijklmnopq") === null);

const two = frameAncestorsHeader({ allowedOrigins: ["https://misalon.com", "https://*.misalon.es"], restricted: true });
check("lists the allowed origins after the app itself", two === "frame-ancestors 'self' https://misalon.com https://*.misalon.es", two);
check("an empty list allows any site: no header", frameAncestorsHeader({ allowedOrigins: [], restricted: false }) === null);
check("no answer from the API: no header", frameAncestorsHeader(null) === null && frameAncestorsHeader("x") === null);

const injected = frameAncestorsHeader({
  allowedOrigins: [
    "https://misalon.com; script-src *",
    "https://a.com https://other.test",
    "https://a.com\r\nX-Injected: 1",
    "'unsafe-inline'",
    "*",
    "http://misalon.com",
    "https://misalon.com/path",
  ],
  restricted: true,
});
check(
  "nothing that could add a directive reaches the header; only bad entries allows only the app",
  injected === "frame-ancestors 'self'",
  injected,
);
const header = frameAncestorsHeader({ allowedOrigins: ["https://ok.test", "https://ok.test;x"], restricted: true }) ?? "";
check("no ';' ever", !header.includes(";") && header === "frame-ancestors 'self' https://ok.test", header);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
