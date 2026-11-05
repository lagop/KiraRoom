/**
 * The salon's privacy page and aviso legal, and the links to them.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/salon-legal.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  SUB_PROCESSORS,
  subProcessorText,
  closedDayRanges,
  closedRangeText,
  controllerName,
  directionsUrl,
  legalAddressLine,
  missingLegalIdentity,
  salonLegalNoticePath,
  salonPrivacyHref,
  salonPrivacyPath,
  sitePathSlug,
  movedSitePath,
  GONE_SALON_HTML,
  whatsappHref,
} from "./salon-legal";

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

const ROOT = path.join(__dirname, "..");

console.log("\n=== links ===");
check("the privacy path the chat uses", salonPrivacyPath("salon-luna"), "/sites/salon-luna/privacidad");
check("the aviso legal path", salonLegalNoticePath("salon-luna"), "/sites/salon-luna/aviso-legal");
check("generated page without an own policy", salonPrivacyHref({ slug: "salon-luna", privacyPolicyUrl: null }), "/sites/salon-luna/privacidad");
check(
  "absolute for the widget",
  salonPrivacyHref({ slug: "salon-luna" }, "https://app.kiraroom.net/"),
  "https://app.kiraroom.net/sites/salon-luna/privacidad",
);
check(
  "the salon's own policy wins",
  salonPrivacyHref({ slug: "salon-luna", privacyPolicyUrl: "https://salonluna.es/privacidad" }, "https://app.kiraroom.net"),
  "https://salonluna.es/privacidad",
);
check("never a non-https own URL", salonPrivacyHref({ slug: "x", privacyPolicyUrl: "http://salon.es/p" }), "/sites/x/privacidad");
check(
  "Cómo llegar: a Maps search",
  directionsUrl("Calle Mayor 1, 28013 Madrid"),
  "https://www.google.com/maps/search/?api=1&query=Calle%20Mayor%201%2C%2028013%20Madrid",
);
check("no address, no link", directionsUrl("  "), null);
check("WhatsApp: wa.me", whatsappHref("34600112233"), "https://wa.me/34600112233");
check("no number, no button", [whatsappHref(null), whatsappHref("123")], [null, null]);

console.log("\n=== legal identity ===");
check("both missing", missingLegalIdentity({ legalName: " ", taxId: null }), ["legalName", "taxId"]);
check("complete", missingLegalIdentity({ legalName: "Luna SL", taxId: "B12345678" }), []);
check("the trade name meanwhile", controllerName({ name: "Salón Luna", legalName: null }), "Salón Luna");
check("the business name when set", controllerName({ name: "Salón Luna", legalName: "Luna Estética SL" }), "Luna Estética SL");
check(
  "address line",
  legalAddressLine({ street: "Calle Mayor 1", postalCode: "28013", city: "Madrid", state: "Madrid" }),
  "Calle Mayor 1, 28013 Madrid",
);

console.log("\n=== sub-processors (D13: the AI is Anthropic's) ===");
const names = SUB_PROCESSORS.map((s) => s.name.toLowerCase()).join(" | ");
check("Anthropic is listed", names.includes("anthropic"), true);
check("no MiniMax nor OpenAI", /minimax|openai/.test(names), false);
for (const rel of [
  "app/sites/[salonName]/privacidad/page.tsx",
  "app/legal/privacy/page.tsx",
]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  check(`${rel}: no MiniMax`, /minimax/i.test(src), false);
}
const platform = fs.readFileSync(path.join(ROOT, "app/legal/privacy/page.tsx"), "utf8");
check("/legal/privacy: kiraroom.net, not .com", /kiraroom\.com/.test(platform), false);
check("/legal/privacy: no API endpoints to exercise rights", /\/api\/v1\//.test(platform), false);
check("/legal/privacy: no 'no transfers' claim", /No se realizan transferencias/i.test(platform), false);
const terms = fs.readFileSync(path.join(ROOT, "app/legal/terms/page.tsx"), "utf8");
check("terms: processor clause (art. 28)", /art(ículo|\.) 28/i.test(terms), true);

console.log("\n=== audit 9 (L8, L16, L21): the legal texts say only what the code does ===");
for (const n of ["telegram", "meta", "stripe", "holded", "cloudflare", "twilio", "anthropic"]) {
  check(`sub-processor listed: ${n}`, names.includes(n), true);
}
check(
  "a sub-processor without a confirmed place prints no 'undefined'",
  subProcessorText(SUB_PROCESSORS.find((x) => x.name === "Telegram")!).includes("undefined"),
  false,
);
check("the salon page leaves out the sign-up check", SUB_PROCESSORS.filter((x) => x.platformOnly).map((x) => x.name), [
  "Cloudflare (Turnstile)",
]);
for (const [label, src] of [
  ["privacy", platform],
  ["terms", terms],
] as const) {
  check(`${label}: no Sage / A3 / NCS`, /\bSage\b|\bA3\b|\bNCS\b/.test(src), false);
  check(`${label}: no WAF, WAL, HS256 nor 'inmutables'`, /\bWAF\b|WAL archiving|HS256|inmutables/.test(src), false);
  check(`${label}: no European online-dispute platform`, /ec\.europa\.eu\/consumers\/odr|524\/2013/.test(src), false);
  check(`${label}: says 5 de noviembre de 2026`, src.includes("Última actualización: 5 de noviembre de 2026"), true);
}
check("privacy: the rate limit is the real one (300)", /300 por minuto/.test(platform) && !/100 req/.test(platform), true);
check("privacy: backups say 35 days and 400 days", /35 días/.test(platform) && /400 días/.test(platform), true);
check("terms: the public price list is linked", terms.includes("https://kiraroom.com/#precios"), true);

console.log("\n=== closed days ahead ===");
const ranges = closedDayRanges(
  ["2026-12-26", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01", "2026-11-01", "2027-03-01", "bad"],
  "2026-11-04",
);
check("joined into runs, past and far days left out", ranges, [
  { from: "2026-12-24", to: "2026-12-26" },
  { from: "2026-12-31", to: "2027-01-01" },
]);
check("one run in Spanish", closedRangeText(ranges[0], "es"), "Cerrado del 24 al 26 de diciembre");
check("across months", closedRangeText(ranges[1], "es"), "Cerrado del 31 de diciembre al 1 de enero");
check("a single day", closedRangeText({ from: "2026-12-08", to: "2026-12-08" }, "es"), "Cerrado el 8 de diciembre");
check("English", closedRangeText(ranges[0], "en"), "Closed 24 to 26 December");
check("no today yet: nothing", closedDayRanges(["2026-12-24"], ""), []);
check("today itself counts", closedDayRanges(["2026-11-04"], "2026-11-04"), [{ from: "2026-11-04", to: "2026-11-04" }]);

console.log("\n=== a gone salon ===");
check("slug of the page", sitePathSlug("/sites/salon-luna"), "salon-luna");
check("slug of a sub-page", sitePathSlug("/sites/salon-luna/privacidad"), "salon-luna");
check("decoded", sitePathSlug("/sites/sal%C3%B3n"), "salón");
check("not other paths", [sitePathSlug("/dashboard"), sitePathSlug("/sites/"), sitePathSlug("/sites/%E0%A4%A")], [null, null, null]);
check("D4: old address to the new one, same sub-page", movedSitePath("/sites/salon-ana/privacidad", "ana-madrid"), "/sites/ana-madrid/privacidad");
check("D4: the page itself", movedSitePath("/sites/salon-ana", "ana-madrid"), "/sites/ana-madrid");
check("D4: already current, or not a salon path", [movedSitePath("/sites/ana-madrid", "ana-madrid"), movedSitePath("/dashboard", "x")], [null, null]);
check("the gone page says noindex", GONE_SALON_HTML.includes('name="robots" content="noindex"'), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
