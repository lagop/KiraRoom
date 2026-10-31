import { ValidateBy, ValidationOptions } from "class-validator";

/**
 * A salon's Instagram and Facebook, as the settings page takes them and as
 * they are stored: one canonical https URL each, so the public page can link
 * to it as it is.
 *
 * The owner types whatever they have to hand -- "@salonana", "salonana",
 * "instagram.com/salonana", a link copied from the app with "?igsh=..." on it.
 * Each becomes https://www.instagram.com/salonana/. Anything that does not
 * name a profile (another site, a post, a share link) is left as typed and
 * refused by the DTO, rather than stored as a link to somewhere else.
 */

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const FACEBOOK_HOSTS = new Set(["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.com"]);

/** Paths on these sites that are not a profile: a post, a share, a search. */
const INSTAGRAM_NOT_PROFILES = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct"]);
const FACEBOOK_NOT_PROFILES = new Set([
  "share",
  "sharer",
  "sharer.php",
  "profile.php",
  "watch",
  "events",
  "groups",
  "login",
  "login.php",
  "home.php",
  "photo.php",
  "permalink.php",
  "story.php",
  "search",
]);

const INSTAGRAM_USER = /^[A-Za-z0-9._]{1,30}$/;
const FACEBOOK_PAGE = /^[A-Za-z0-9.-]{1,100}$/;

/** The URL in `input` when it is on one of `hosts`, scheme optional; else null. */
function urlOn(input: string, hosts: Set<string>): URL | null {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return hosts.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

/** The canonical profile URL `input` names, or null when it names none. */
export function instagramProfileUrl(input: string): string | null {
  const raw = input.trim();
  const url = urlOn(raw, INSTAGRAM_HOSTS);
  // A handle when it is not a link ("salon.ana", dots allowed).
  const user = url ? url.pathname.split("/").filter(Boolean)[0] : raw.replace(/^@/, "");
  if (!user || !INSTAGRAM_USER.test(user) || INSTAGRAM_NOT_PROFILES.has(user.toLowerCase())) return null;
  return `https://www.instagram.com/${user}/`;
}

/** The canonical page URL `input` names, or null when it names none. */
export function facebookProfileUrl(input: string): string | null {
  const raw = input.trim();
  const url = urlOn(raw, FACEBOOK_HOSTS);
  if (!url) {
    const handle = raw.replace(/^@/, "");
    return FACEBOOK_PAGE.test(handle) && !FACEBOOK_NOT_PROFILES.has(handle.toLowerCase())
      ? `https://www.facebook.com/${handle}`
      : null;
  }
  const page = url.pathname.split("/").filter(Boolean)[0];
  // A page without a name of its own: profile.php?id=<number>.
  const id = url.searchParams.get("id");
  if (page === "profile.php" && id && /^\d{1,20}$/.test(id)) {
    return `https://www.facebook.com/profile.php?id=${id}`;
  }
  if (!page || !FACEBOOK_PAGE.test(page) || FACEBOOK_NOT_PROFILES.has(page.toLowerCase())) return null;
  return `https://www.facebook.com/${page}`;
}

/**
 * For a DTO's @Transform: blank clears the field (null), a profile becomes
 * its canonical URL, anything else is left as sent for the validator to
 * refuse.
 */
export function socialLinkInput(profileUrl: (s: string) => string | null) {
  return (value: unknown): unknown => {
    if (value === null) return null;
    if (typeof value !== "string") return value;
    if (value.trim() === "") return null;
    return profileUrl(value) ?? value;
  };
}

/** Valid when the value is already the canonical URL of a profile. */
function isCanonical(profileUrl: (s: string) => string | null) {
  return (value: unknown) => typeof value === "string" && profileUrl(value) === value;
}

export function IsInstagramProfile(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: "isInstagramProfile", validator: { validate: isCanonical(instagramProfileUrl) } }, options);
}

export function IsFacebookProfile(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: "isFacebookProfile", validator: { validate: isCanonical(facebookProfileUrl) } }, options);
}
