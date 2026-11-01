/**
 * What search engines and link previews get from a salon's public page.
 *
 * The page at /sites/[salonName] was a client component that fetched the
 * salon after load, so the HTML a crawler received was a spinner: no name,
 * no services, no address, the root layout's generic "KiraRoom - Beauty
 * Salon Management" title on every salon. The page is now rendered on the
 * server from GET /public-site/page/:slug, and these pure helpers build the
 * title, description, canonical URL and schema.org data from that answer.
 *
 * No React and no Next imports, so lib/salon-seo.spec.ts can run them.
 */

export interface PublicSalonService {
  id: string;
  name: string;
  description: string | null;
  duration: number;
  price: number;
  currency: string;
  category: string;
  /** False: on the price list, but booked by phone (the server refuses it online). */
  isOnlineBookable?: boolean;
}

export interface PublicSalonProfessional {
  id: string;
  firstName: string;
  lastName: string;
  profileImage: string | null;
  bio: string | null;
  position: string | null;
  specialties: string[];
  portfolioImages: string[];
  yearsExperience: number | null;
  languages: string[];
  certifications: string[];
  services: Array<{ serviceId: string }>;
}

export interface PublicSalonPage {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  coverImage: string | null;
  website: string | null;
  /**
   * The salon's Instagram and Facebook as profile URLs, set in its general
   * settings. Absent from servers older than that setting.
   */
  instagram?: string | null;
  facebook?: string | null;
  email: string | null;
  phone: string | null;
  address: {
    street: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  currency: string;
  timezone: string;
  language: string;
  updatedAt: string;
  services: PublicSalonService[];
  professionals: PublicSalonProfessional[];
  /**
   * Weekday name (lower-case English) -> window, earliest open to latest
   * close. Absent day = closed.
   */
  openingHours: Record<string, { openTime: string; closeTime: string }>;
  /**
   * The same week with its gaps: every open stretch of each day, several when
   * the salon closes for lunch. Absent from servers older than split shifts.
   */
  openingShifts?: Record<string, Array<{ openTime: string; closeTime: string }>>;
  /** "YYYY-MM-DD" days ahead the salon is closed all day. Absent from older servers. */
  closedDays?: string[];
  /** Set only once the salon's own domain serves the page over HTTPS. */
  customDomain: string | null;
  /** salon-lucia.kiraroom.net, set only once subdomains serve over HTTPS. */
  subdomainHost?: string | null;
  /**
   * The salon has its WhatsApp number connected: the booking form offers
   * "Recibir los avisos de mi cita por WhatsApp". Absent from older servers.
   */
  whatsappNotices?: boolean;
}

/** Public base URL of the app (where /sites/<slug> lives). */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * The one URL search engines should index for this salon. Its own domain
 * when that is live; then its free subdomain when those are live; otherwise
 * the slug URL, also when the visitor came in through the salon's id
 * (/sites/<uuid>), so the two are not indexed twice.
 */
export function canonicalUrl(
  page: Pick<PublicSalonPage, "slug" | "customDomain" | "subdomainHost">,
  base = appBaseUrl(),
): string {
  if (page.customDomain) return `https://${page.customDomain}/`;
  if (page.subdomainHost) return `https://${page.subdomainHost}/`;
  return `${base}/sites/${encodeURIComponent(page.slug)}`;
}

/** "Calle Mayor 1, 28013 Madrid, Madrid" -- the parts that exist. */
export function formatAddress(address: PublicSalonPage["address"]): string {
  const cityLine = [address.postalCode, address.city].filter(Boolean).join(" ");
  const parts = [address.street, cityLine, address.state !== address.city ? address.state : null];
  return parts.filter((p) => p && String(p).trim()).join(", ");
}

export function metaTitle(page: Pick<PublicSalonPage, "name" | "address">): string {
  const city = page.address.city?.trim();
  return city ? `${page.name} en ${city} · Reserva cita online` : `${page.name} · Reserva cita online`;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Cut at a word boundary so the snippet does not end mid-word. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/**
 * The salon's own description when it wrote one; otherwise a sentence built
 * from facts we have (name, city, first services), never invented copy.
 */
export function metaDescription(page: Pick<PublicSalonPage, "name" | "description" | "address" | "services">): string {
  const own = page.description ? collapse(page.description) : "";
  if (own.length >= 50) return truncate(own, 160);
  const city = page.address.city?.trim();
  let text = own || `Reserva tu cita online en ${page.name}${city ? `, ${city}` : ""}.`;
  const names = page.services.slice(0, 4).map((s) => s.name.trim()).filter(Boolean);
  if (names.length > 0) text += ` Servicios: ${names.join(", ")}.`;
  return truncate(collapse(text), 160);
}

const isWebUrl = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/**
 * Image for link previews and schema.org. Logos are often stored as data:
 * URLs, which no crawler or chat app will fetch, so only http(s) qualify.
 */
export function shareImage(page: Pick<PublicSalonPage, "coverImage" | "logo">): string | null {
  if (isWebUrl(page.coverImage)) return page.coverImage;
  if (isWebUrl(page.logo)) return page.logo;
  return null;
}

const WEEK: Array<{ key: string; label: string; schema: string }> = [
  { key: "monday", label: "Lunes", schema: "Monday" },
  { key: "tuesday", label: "Martes", schema: "Tuesday" },
  { key: "wednesday", label: "Miércoles", schema: "Wednesday" },
  { key: "thursday", label: "Jueves", schema: "Thursday" },
  { key: "friday", label: "Viernes", schema: "Friday" },
  { key: "saturday", label: "Sábado", schema: "Saturday" },
  { key: "sunday", label: "Domingo", schema: "Sunday" },
];

type Stretch = { openTime: string; closeTime: string };

/**
 * Each day's open stretches: `openingShifts` when the server sent it (a salon
 * that closes for lunch has two), else the single `openingHours` window. One
 * window per day used to be all there was, so a salon shut from 14:00 to 17:00
 * told Google, and its own page, that it was open straight through.
 */
function stretchesOf(
  hours: PublicSalonPage["openingHours"] | null | undefined,
  shifts: PublicSalonPage["openingShifts"],
  key: string,
): Stretch[] {
  if (shifts && Object.keys(shifts).length > 0) return shifts[key] ?? [];
  const w = hours?.[key];
  return w ? [w] : [];
}

/**
 * Monday-first rows for display. Empty when no schedule is recorded at all,
 * so the page says nothing rather than "closed every day".
 */
export function openingHoursRows(
  hours: PublicSalonPage["openingHours"],
  shifts?: PublicSalonPage["openingShifts"],
): Array<{ day: string; hours: string | null }> {
  const known = (o: object | null | undefined) => !!o && Object.keys(o).length > 0;
  if (!known(hours) && !known(shifts)) return [];
  return WEEK.map(({ key, label }) => {
    const stretches = stretchesOf(hours, shifts, key);
    return {
      day: label,
      hours:
        stretches.length > 0
          ? stretches.map((w) => `${w.openTime} – ${w.closeTime}`).join(" y ")
          : null,
    };
  });
}

const SOCIAL_HOSTS: Record<SocialLink["network"], string> = {
  instagram: "www.instagram.com",
  facebook: "www.facebook.com",
};

export interface SocialLink {
  network: "instagram" | "facebook";
  url: string;
  /** "@salonluna" for Instagram, "Facebook" for a page (its URL may be an id). */
  label: string;
}

/**
 * The salon's social profiles for its page, only those it set and only on
 * the network's own https host (the server stores canonical profile URLs;
 * checked again here because the URL goes into an href).
 */
export function socialLinks(page: Pick<PublicSalonPage, "instagram" | "facebook">): SocialLink[] {
  const links: SocialLink[] = [];
  for (const network of ["instagram", "facebook"] as const) {
    const raw = page[network];
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== SOCIAL_HOSTS[network]) continue;
    const handle = url.pathname.split("/").filter(Boolean)[0];
    links.push({
      network,
      url: url.toString(),
      label: network === "instagram" && handle ? `@${handle}` : "Facebook",
    });
  }
  return links;
}

/** schema.org BeautySalon for the page's JSON-LD block. */
export function salonJsonLd(page: PublicSalonPage, url: string): Record<string, unknown> {
  const image = shareImage(page);
  const a = page.address;
  const hasAddress = [a.street, a.city, a.postalCode, a.state].some(Boolean);
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BeautySalon",
    "@id": `${url}#salon`,
    name: page.name,
    url,
  };
  if (page.description) data.description = collapse(page.description);
  if (image) data.image = image;
  if (isWebUrl(page.logo)) data.logo = page.logo;
  if (page.phone) data.telephone = page.phone;
  if (page.email) data.email = page.email;
  // The salon's own site and its social profiles: the same business elsewhere.
  const sameAs = [...(isWebUrl(page.website) ? [page.website] : []), ...socialLinks(page).map((l) => l.url)];
  if (sameAs.length > 0) data.sameAs = sameAs;
  if (hasAddress) {
    data.address = {
      "@type": "PostalAddress",
      ...(a.street ? { streetAddress: a.street } : {}),
      ...(a.city ? { addressLocality: a.city } : {}),
      ...(a.state ? { addressRegion: a.state } : {}),
      ...(a.postalCode ? { postalCode: a.postalCode } : {}),
      ...(a.country ? { addressCountry: a.country } : {}),
    };
  }
  // One specification per open stretch: schema.org allows several for the
  // same day, which is how a lunch closure is said.
  const spec = WEEK.flatMap(({ key, schema }) =>
    stretchesOf(page.openingHours, page.openingShifts, key).map((w) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: `https://schema.org/${schema}`,
      opens: w.openTime,
      closes: w.closeTime,
    })),
  );
  if (spec.length > 0) data.openingHoursSpecification = spec;
  if (page.services.length > 0) {
    data.hasOfferCatalog = {
      "@type": "OfferCatalog",
      name: "Servicios",
      itemListElement: page.services.map((s) => ({
        "@type": "Offer",
        price: Number(s.price).toFixed(2),
        priceCurrency: s.currency || page.currency,
        itemOffered: {
          "@type": "Service",
          name: s.name,
          ...(s.description ? { description: collapse(s.description) } : {}),
        },
      })),
    };
  }
  if (page.professionals.length > 0) {
    data.employee = page.professionals.map((p) => ({
      "@type": "Person",
      name: `${p.firstName} ${p.lastName}`.trim(),
      ...(p.position ? { jobTitle: p.position } : {}),
    }));
  }
  return data;
}

/**
 * JSON for a <script type="application/ld+json"> body. Salon-written text
 * goes in here, so "</script>" in a description must not close the tag:
 * escape <, > and & (and the two line separators JS treats as newlines).
 */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}

/** "35,00 €" -- prices as the salon's clients read them. */
export function formatPrice(amount: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
