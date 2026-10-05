/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/salon-seo.spec.ts
 *
 * Salon pages were invisible to search engines: /sites/[salonName] was a
 * client component, so the HTML a crawler got was a spinner under the
 * generic "KiraRoom - Beauty Salon Management" title. The page is now
 * rendered on the server, and lib/salon-seo.ts builds its title,
 * description, canonical URL and schema.org data. This spec guards those,
 * plus the decisions that serve a salon's page on its own domain
 * (lib/custom-domain-host.ts).
 */

import {
  canonicalUrl,
  formatAddress,
  metaDescription,
  metaTitle,
  openingHoursRows,
  salonJsonLd,
  serializeJsonLd,
  shareImage,
  type PublicSalonPage,
} from "./salon-seo";
import {
  bareHost,
  isPlatformHost,
  platformHostsFrom,
  rewritePathFor,
  salonSlugForSubdomain,
  subdomainRedirectFor,
} from "./custom-domain-host";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

const PAGE: PublicSalonPage = {
  id: "t1",
  name: "Salón Luna",
  slug: "salon-luna",
  description: null,
  logo: "data:image/png;base64,AAAA",
  coverImage: null,
  website: "https://salonluna.example",
  email: "hola@salonluna.example",
  phone: "+34 600 000 000",
  address: { street: "Calle Mayor 1", city: "Madrid", state: "Madrid", postalCode: "28013", country: "ES" },
  currency: "EUR",
  timezone: "Europe/Madrid",
  language: "es",
  updatedAt: "2026-10-01T10:00:00.000Z",
  services: [
    { id: "s1", name: "Corte", description: null, duration: 30, price: 18.5, currency: "EUR", category: "hair" },
    { id: "s2", name: "Tinte", description: "Color completo", duration: 90, price: 45, currency: "EUR", category: "hair" },
  ],
  professionals: [
    {
      id: "p1", firstName: "Ana", lastName: "García", profileImage: null, bio: null, position: "Estilista",
      specialties: [], portfolioImages: [], yearsExperience: null, languages: [], certifications: [], services: [],
    },
  ],
  openingHours: {
    monday: { openTime: "09:00", closeTime: "18:00" },
    saturday: { openTime: "10:00", closeTime: "14:00" },
  },
  customDomain: null,
};

console.log("\n=== title, description, canonical ===");

check("title names the salon and its city", metaTitle(PAGE), "Salón Luna en Madrid · Reserva cita online");
check(
  "without a description, one is built from facts",
  metaDescription(PAGE),
  "Reserva tu cita online en Salón Luna, Madrid. Servicios: Corte, Tinte.",
);
const long = "Peluquería de barrio con más de veinte años cuidando el pelo de Malasaña. ".repeat(5);
const d = metaDescription({ ...PAGE, description: long });
check("a long description is cut to 160 characters", d.length <= 160, true);
check("and ends with an ellipsis, not mid-word", d.endsWith("…"), true);
check("canonical is the slug URL", canonicalUrl(PAGE, "https://app.kiraroom.net"), "https://app.kiraroom.net/sites/salon-luna");
check(
  "canonical is the salon's domain once live",
  canonicalUrl({ ...PAGE, customDomain: "reservas.salonluna.es" }, "https://app.kiraroom.net"),
  "https://reservas.salonluna.es/",
);
check("address keeps the parts that exist", formatAddress(PAGE.address), "Calle Mayor 1, 28013 Madrid");

console.log("\n=== images ===");
check("data: logos are not offered to crawlers", shareImage(PAGE), null);
check("a web cover image wins", shareImage({ ...PAGE, coverImage: "https://cdn.example/c.jpg" }), "https://cdn.example/c.jpg");

console.log("\n=== opening hours ===");
const rows = openingHoursRows(PAGE.openingHours);
check("seven rows, Monday first", rows.map((r) => r.day)[0], "Lunes");
check("Monday's hours", rows[0].hours, "09:00 – 18:00");
check("a day nobody works is closed", rows[6], { day: "Domingo", hours: null });
check("no schedule at all says nothing", openingHoursRows({}), []);

console.log("\n=== schema.org ===");
const ld = salonJsonLd(PAGE, "https://app.kiraroom.net/sites/salon-luna") as any;
check("type", ld["@type"], "BeautySalon");
check("address", ld.address.addressLocality, "Madrid");
check("hours", ld.openingHoursSpecification.map((s: any) => s.dayOfWeek), [
  "https://schema.org/Monday",
  "https://schema.org/Saturday",
]);
check("offers with prices", ld.hasOfferCatalog.itemListElement.map((o: any) => [o.itemOffered.name, o.price]), [
  ["Corte", "18.50"],
  ["Tinte", "45.00"],
]);
check("team", ld.employee, [{ "@type": "Person", name: "Ana García", jobTitle: "Estilista" }]);
check("no data: image", "image" in ld, false);

const evil = serializeJsonLd({ description: "</script><script>alert(1)</script> & co" });
check("salon text cannot close the script tag", /<\/script/i.test(evil), false);
check("and still parses back to the same text", JSON.parse(evil).description, "</script><script>alert(1)</script> & co");

console.log("\n=== custom domains ===");
const platform = platformHostsFrom("staging.example.org", "https://app.kiraroom.net");
check("host header loses its port", bareHost("Reservas.SalonLuna.es:443"), "reservas.salonluna.es");
check("the app is the platform", isPlatformHost("app.kiraroom.net", platform), true);
check("any kiraroom.net name is the platform", isPlatformHost("otra.kiraroom.net", platform), true);
check("localhost is the platform", isPlatformHost("localhost", platform), true);
check("an IP is never a salon domain", isPlatformHost("203.0.113.7", platform), true);
check("a listed extra host is the platform", isPlatformHost("staging.example.org", platform), true);
check("a salon's domain is not", isPlatformHost("reservas.salonluna.es", platform), false);
check("/ serves the salon page", rewritePathFor("/", "salon-luna"), "/sites/salon-luna");
check("/account is the salon's client area", rewritePathFor("/account", "salon-luna"), "/sites/salon-luna/account");
check("the page's own links pass through", rewritePathFor("/sites/salon-luna/account", "salon-luna"), null);
check(
  "another salon's page is not served on this domain",
  rewritePathFor("/sites/otro-salon", "salon-luna"),
  "/sites/salon-luna/sites/otro-salon",
);

console.log("\n=== salon subdomains ===");
check(
  "canonical: own domain, then subdomain, then slug URL",
  [
    canonicalUrl({ ...PAGE, customDomain: "reservas.salonluna.es", subdomainHost: "salon-luna.kiraroom.net" }, "https://app.kiraroom.net"),
    canonicalUrl({ ...PAGE, subdomainHost: "salon-luna.kiraroom.net" }, "https://app.kiraroom.net"),
    canonicalUrl({ ...PAGE, subdomainHost: null }, "https://app.kiraroom.net"),
  ].join(" | "),
  "https://reservas.salonluna.es/ | https://salon-luna.kiraroom.net/ | https://app.kiraroom.net/sites/salon-luna",
);
check("salon-luna.kiraroom.net names the salon", salonSlugForSubdomain("salon-luna.kiraroom.net", "kiraroom.net"), "salon-luna");
check("app.kiraroom.net is not a salon", salonSlugForSubdomain("app.kiraroom.net", "kiraroom.net"), null);
check("no base, no subdomains", salonSlugForSubdomain("salon-luna.kiraroom.net", undefined), null);
check(
  "once ready, the public page moves to the subdomain",
  subdomainRedirectFor("app.kiraroom.net", "/sites/salon-luna", platform, "kiraroom.net", true),
  "https://salon-luna.kiraroom.net/",
);
check("not before the certificate is in place", subdomainRedirectFor("app.kiraroom.net", "/sites/salon-luna", platform, "kiraroom.net", false), null);
check(
  "the client area keeps its URL (its session lives on this host)",
  subdomainRedirectFor("app.kiraroom.net", "/sites/salon-luna/account", platform, "kiraroom.net", true),
  null,
);
check(
  "an id URL stays",
  subdomainRedirectFor("app.kiraroom.net", "/sites/3f2a9c1e-77b1-4c2d-9e10-aa55cc66dd77", platform, "kiraroom.net", true),
  null,
);
check("a reserved slug stays", subdomainRedirectFor("app.kiraroom.net", "/sites/admin", platform, "kiraroom.net", true), null);
check("only from the app host", subdomainRedirectFor("reservas.salonluna.es", "/sites/salon-luna", platform, "kiraroom.net", true), null);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All salon-seo tests passed.");
}
