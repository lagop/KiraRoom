import { RESERVED_SUBDOMAINS } from "@kira/shared";
import { containsPlatformWord, slugify } from "../saas/saas.helpers";

/**
 * D4 (owner's decision, 2026-11-04): the salon's web address
 * (kiraroom.net/<address>, or <address>.kiraroom.net) can be chosen at
 * signup and changed once from Ajustes > Web. The old one redirects (301)
 * to the new one for 12 months, then is free for another salon.
 */
export const WEB_ADDRESS_MIN = 3;
export const WEB_ADDRESS_MAX = 63;
export const WEB_ADDRESS_REDIRECT_MONTHS = 12;

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WebAddressProblem = "format" | "too_short" | "too_long" | "reserved" | "platform_word" | "taken";

export const WEB_ADDRESS_MESSAGES: Record<WebAddressProblem, string> = {
  format: "Usa solo letras sin acentos, números y guiones, sin espacios. Por ejemplo: peluqueria-lucia.",
  too_short: `La dirección necesita al menos ${WEB_ADDRESS_MIN} caracteres.`,
  too_long: `La dirección puede tener como mucho ${WEB_ADDRESS_MAX} caracteres.`,
  reserved: "Esa dirección no se puede usar. Añade algo más, por ejemplo la ciudad.",
  platform_word: "La dirección no puede incluir «kiraroom» ni «soporte»: parecería una página de KiraRoom.",
  taken: "Esa dirección ya la usa otro salón. Prueba con otra, por ejemplo añadiendo la ciudad.",
};

/** What the owner typed, as the address would be: trimmed, lower-case. */
export function normalizeWebAddress(input: string): string {
  return (input ?? "").trim().toLowerCase();
}

/**
 * Why an address cannot be used, before looking at who has it; null when its
 * shape is fine. Same rules as the addresses signup makes up
 * (availableTenantSlug): no reserved names, nothing shaped like an id, no
 * platform words.
 */
export function webAddressShapeProblem(slug: string): WebAddressProblem | null {
  if (slug.length < WEB_ADDRESS_MIN) return "too_short";
  if (slug.length > WEB_ADDRESS_MAX) return "too_long";
  if (slugify(slug) !== slug) return "format";
  if (RESERVED_SUBDOMAINS.has(slug) || UUID_SHAPED.test(slug)) return "reserved";
  if (containsPlatformWord(slug)) return "platform_word";
  return null;
}

/** 12 months after `from`: when an old address stops redirecting and is free. */
export function redirectExpiry(from: Date): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + WEB_ADDRESS_REDIRECT_MONTHS);
  return d;
}
