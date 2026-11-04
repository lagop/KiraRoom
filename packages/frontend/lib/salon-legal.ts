/**
 * A salon's own privacy page and aviso legal (/sites/<slug>/privacidad and
 * /sites/<slug>/aviso-legal, also on its domain and subdomain), and the
 * links its page, widget and chat use to reach them. Pure: tested in
 * salon-legal.spec.ts.
 *
 * Who is who (RGPD): the salon is the controller of its clients' data (it
 * decides why and how they are used); KiraRoom processes them on its behalf
 * (art. 28), with the sub-processors below. The texts are a model: a legal
 * advisor must review them before relying on them.
 */

/** KiraRoom's product domain and the mailbox its privacy texts give. */
export const KIRAROOM_DOMAIN = "kiraroom.net";
export const KIRAROOM_PRIVACY_EMAIL = `privacidad@${KIRAROOM_DOMAIN}`;

/** How long the receptionist's conversations are kept (backend retention job). */
export const CONVERSATION_RETENTION_MONTHS = 12;

export interface SubProcessor {
  name: string;
  /** What it does for the salon, in Spanish. */
  purpose: string;
  /** Where, and on what basis when outside the EEA. */
  location: string;
  /** Only when the salon uses it (SMS, WhatsApp). */
  onlyIf?: string;
}

/**
 * Who KiraRoom relies on to run the salon's booking page, widget and chat.
 * The AI is Anthropic's (the receptionist runs on Claude); nothing else.
 */
export const SUB_PROCESSORS: SubProcessor[] = [
  {
    name: "Hostinger",
    purpose: "Alojamiento de los servidores y de la base de datos",
    location: "Unión Europea",
  },
  {
    name: "Anthropic",
    purpose: "Inteligencia artificial de la recepcionista virtual (chat y mensajes)",
    location: "Estados Unidos, con el Marco de Privacidad de Datos UE-EE. UU.",
  },
  {
    name: "Resend",
    purpose: "Envío de los emails de confirmación, recordatorios y promociones",
    location: "Estados Unidos, con cláusulas contractuales tipo de la Comisión Europea",
  },
  {
    name: "Stripe",
    purpose: "Cobro de señales y pagos online",
    location: "Irlanda (Unión Europea)",
    onlyIf: "si el salón cobra online",
  },
  {
    name: "Twilio",
    purpose: "Envío de SMS",
    location: "Estados Unidos, con el Marco de Privacidad de Datos UE-EE. UU.",
    onlyIf: "si el salón envía avisos por SMS",
  },
  {
    name: "Meta (WhatsApp Business)",
    purpose: "Mensajes por WhatsApp desde el número del salón",
    location: "Irlanda (Unión Europea)",
    onlyIf: "si el salón tiene WhatsApp conectado y el cliente lo elige",
  },
];

/** The salon's own page paths, exactly as the chat and the widget link them. */
export function salonPrivacyPath(slug: string): string {
  return `/sites/${encodeURIComponent(slug)}/privacidad`;
}

export function salonLegalNoticePath(slug: string): string {
  return `/sites/${encodeURIComponent(slug)}/aviso-legal`;
}

/**
 * Where "Privacidad" goes: the salon's own policy when it set one (the API
 * only sends https URLs), else the page KiraRoom generates for it. `base`
 * makes it absolute (the widget is framed on another site).
 */
export function salonPrivacyHref(
  salon: { slug: string; privacyPolicyUrl?: string | null },
  base = "",
): string {
  const own = salon.privacyPolicyUrl?.trim();
  if (own && /^https:\/\//i.test(own)) return own;
  return `${base.replace(/\/+$/, "")}${salonPrivacyPath(salon.slug)}`;
}

/** The legal identity the API answers (GET /public-site/legal/:slug). */
export interface SalonLegal {
  name: string;
  slug: string;
  legalName: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: {
    street?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  };
  privacyPolicyUrl: string | null;
}

/**
 * What the aviso legal still lacks (LSSI art. 10: the business name and its
 * NIF): the panel warns about it, and the page shows the trade name and
 * address meanwhile. Publishing is never blocked.
 */
export function missingLegalIdentity(t: { legalName?: string | null; taxId?: string | null }): Array<"legalName" | "taxId"> {
  const missing: Array<"legalName" | "taxId"> = [];
  if (!t.legalName?.trim()) missing.push("legalName");
  if (!t.taxId?.trim()) missing.push("taxId");
  return missing;
}

/** "Calle Mayor 1, 28013 Madrid, Madrid": what the salon filled in. */
export function legalAddressLine(a: SalonLegal["address"]): string {
  const cityLine = [a.postalCode, a.city].filter((v) => v && String(v).trim()).join(" ");
  return [a.street, cityLine, a.state && a.state !== a.city ? a.state : null]
    .filter((v) => v && String(v).trim())
    .join(", ");
}

/** The controller's name as the pages give it: the business name, or the trade name meanwhile. */
export function controllerName(l: Pick<SalonLegal, "name" | "legalName">): string {
  return l.legalName?.trim() || l.name;
}

/** "Cómo llegar": a Google Maps search for the address; null without one. */
export function directionsUrl(address: string | null | undefined): string | null {
  const q = (address ?? "").trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** "Escríbenos por WhatsApp": wa.me with the digits the API sends; null without them. */
export function whatsappHref(digits: string | null | undefined): string | null {
  const d = (digits ?? "").replace(/[^0-9]/g, "");
  if (d.length < 9 || d.length > 15) return null;
  return `https://wa.me/${d}`;
}

/** Days ahead the closed-days notice covers. */
export const CLOSED_NOTICE_DAYS = 60;

const DAY_MS = 86_400_000;
const dayMs = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * The salon's whole closed days ("YYYY-MM-DD") from `today` to `days` ahead,
 * joined into runs of consecutive days.
 */
export function closedDayRanges(
  closedDays: string[] | undefined,
  today: string,
  days = CLOSED_NOTICE_DAYS,
): Array<{ from: string; to: string }> {
  if (!isDay(today)) return [];
  const start = dayMs(today);
  const end = start + days * DAY_MS;
  const sorted = [...new Set((closedDays ?? []).filter(isDay))]
    .filter((d) => dayMs(d) >= start && dayMs(d) <= end)
    .sort();
  const ranges: Array<{ from: string; to: string }> = [];
  for (const d of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && dayMs(d) - dayMs(last.to) === DAY_MS) last.to = d;
    else ranges.push({ from: d, to: d });
  }
  return ranges;
}

function monthName(d: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "es-ES", { month: "long", timeZone: "UTC" }).format(
    new Date(dayMs(d)),
  );
}

/**
 * "Cerrado el 24 de diciembre", "Cerrado del 24 al 26 de diciembre",
 * "Cerrado del 30 de diciembre al 2 de enero" (English: "Closed on 24
 * December", "Closed 24 to 26 December"...).
 */
export function closedRangeText(range: { from: string; to: string }, lang: string): string {
  const en = lang === "en";
  const dayOf = (d: string) => String(Number(d.slice(8, 10)));
  const date = (d: string) => (en ? `${dayOf(d)} ${monthName(d, lang)}` : `${dayOf(d)} de ${monthName(d, lang)}`);
  if (range.from === range.to) return en ? `Closed on ${date(range.from)}` : `Cerrado el ${date(range.from)}`;
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  if (en) {
    return sameMonth
      ? `Closed ${dayOf(range.from)} to ${date(range.to)}`
      : `Closed ${date(range.from)} to ${date(range.to)}`;
  }
  return sameMonth
    ? `Cerrado del ${dayOf(range.from)} al ${date(range.to)}`
    : `Cerrado del ${date(range.from)} al ${date(range.to)}`;
}

/**
 * The salon a /sites/<slug>/... path is about (after the middleware's
 * rewrite of a salon's own host), or null.
 */
export function sitePathSlug(pathname: string): string | null {
  const m = /^\/sites\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m) return null;
  try {
    const slug = decodeURIComponent(m[1]);
    return slug && !slug.includes("/") ? slug : null;
  } catch {
    return null;
  }
}

/**
 * D4: the same path on the salon's new address, after the owner changed it
 * (the old one answers a 301 for 12 months). "/sites/old/privacidad" with
 * "nuevo" is "/sites/nuevo/privacidad". Null when the path is not a salon's,
 * or it already is the current one.
 */
export function movedSitePath(pathname: string, currentSlug: string): string | null {
  const slug = sitePathSlug(pathname);
  if (!slug || !currentSlug || slug === currentSlug) return null;
  const rest = pathname.replace(/^\/sites\/[^/]+/, "");
  return `/sites/${encodeURIComponent(currentSlug)}${rest}`;
}

/**
 * What a salon's address answers once its page is gone (past its read-only
 * period): 410 with noindex, so search engines drop it for good. Plain
 * HTML: nothing of the salon is left to show.
 */
export const GONE_SALON_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Este salón ya no está disponible</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#faf5ff;font-family:system-ui,sans-serif;color:#1f2937;padding:16px;box-sizing:border-box}main{max-width:28rem;background:#fff;border-radius:1rem;padding:2rem;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.08)}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#4b5563;margin:0}</style>
</head><body><main><h1>Este salón ya no está disponible</h1><p>Su página de reservas ya no está activa. Si eres cliente, contacta con el salón directamente.</p></main></body></html>`;
