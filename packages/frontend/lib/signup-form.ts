/**
 * Pure helpers for the signup, login and email-confirmation screens
 * (audit 7A). No React here, so lib/signup-form.spec.ts can run them.
 */

/**
 * The words a salon's address may not contain (they would make
 * <slug>.kiraroom.net look like KiraRoom's own). The server takes them out
 * the same way (backend saas.helpers.ts, withoutPlatformWords); this copy
 * only shows the owner the address she will get.
 */
export const PLATFORM_LOOKALIKE_WORDS = ["kiraroom", "kira-room", "soporte", "support"] as const;

/** The domain every salon's free web address hangs from. */
export const SALON_WEB_BASE = "kiraroom.net";

/** Same rules as the server's slugify: accents folded, a-z0-9 and hyphens, 63 at most. */
export function slugifySalonName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

export function withoutPlatformWords(slug: string): string {
  let out = slug;
  for (let guard = 0; guard < 10; guard++) {
    let next = out;
    for (const word of PLATFORM_LOOKALIKE_WORDS) next = next.split(word).join("-");
    next = next.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * "salon-lucia.kiraroom.net" for "Salón Lucía", or null while the name is
 * empty. Only a preview: the server picks the final one, adding "-2" if the
 * address is taken or reserved.
 */
export function salonWebPreview(salonName: string): string | null {
  if (!salonName.trim()) return null;
  const slug = withoutPlatformWords(slugifySalonName(salonName)) || "salon";
  return `${slug}.${SALON_WEB_BASE}`;
}

/** D4: the address the form starts from, made from the name ("" without one). */
export function suggestedWebAddress(salonName: string): string {
  if (!salonName.trim()) return "";
  return withoutPlatformWords(slugifySalonName(salonName)) || "salon";
}

/**
 * D4: what the owner types in the address field, as she types it: lower-case,
 * accents dropped, spaces and other characters as single hyphens. The
 * trailing hyphen stays while typing ("ana-" on the way to "ana-sol").
 */
export function typedWebAddress(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
}

/** The server's code for "that web address cannot be used" (400/409). */
export const WEB_ADDRESS_UNAVAILABLE_CODE = "WEB_ADDRESS_UNAVAILABLE";

/** The server's code for "this email already has an account" (409). */
export const EMAIL_ALREADY_REGISTERED_CODE = "EMAIL_ALREADY_REGISTERED";

/** The server's code for "pass the captcha to sign in" (401). */
export const CAPTCHA_REQUIRED_CODE = "CAPTCHA_REQUIRED";

/** The Cloudflare Turnstile site key the image was built with; empty = no captcha. */
export function turnstileSiteKey(value: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY): string {
  return (value ?? "").trim();
}

/** localStorage key: when the owner last hid the "Confirma tu email" notice. */
export const EMAIL_NOTICE_DISMISS_KEY = "kr.emailVerifyNotice.dismissedAt";

/** Hidden for this long after she closes it; then it comes back until she confirms. */
export const EMAIL_NOTICE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether the panel shows the "Confirma tu email" notice. Owners only, never for support. */
export function showEmailVerificationNotice(input: {
  role: string | null | undefined;
  verified: boolean | null;
  impersonated: boolean;
  dismissedAt: string | null;
  now: Date;
}): boolean {
  if (input.role !== "owner" || input.impersonated) return false;
  // Not known yet (still loading, or the request failed): say nothing.
  if (input.verified !== false) return false;
  const at = input.dismissedAt ? Date.parse(input.dismissedAt) : NaN;
  if (Number.isFinite(at) && input.now.getTime() - at < EMAIL_NOTICE_SNOOZE_MS) return false;
  return true;
}
