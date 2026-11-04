import { createHash } from "crypto";

/**
 * The salon's logo and cover photo on its public page and widget.
 *
 * The panel uploads them as data: URLs (up to 1 MB for the cover), stored
 * as-is on Tenant. They used to travel inside the page data and the widget
 * JSON, so a phone downloaded several MB of base64 on every visit, and link
 * previews never had an image (no crawler fetches a data: URL). Now the
 * page and the widget get a URL: GET /public-site/image/:tenantId/:kind
 * serves the bytes, cached for a long time, and the URL carries a version
 * (a hash of the stored value), so a new upload is a new URL.
 *
 * A logo or cover stored as an http(s) URL (the SaaS console can set one)
 * is passed through untouched.
 */

export type PublicImageKind = "logo" | "cover";

export const PUBLIC_IMAGE_KINDS: readonly PublicImageKind[] = ["logo", "cover"];

/**
 * What the panel accepts (PNG, JPEG, WebP, and SVG for the logo) and a
 * little more. An SVG can carry script: the endpoint sends every image with
 * a Content-Security-Policy that forbids it (IMAGE_RESPONSE_CSP), so opening
 * one directly runs nothing, and an <img> never runs it anyway.
 */
const SERVED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
]);

/** Sent with every image: nothing in it may run or load anything. */
export const IMAGE_RESPONSE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** The image inside a data: URL, or null when it is not one we serve. */
export function parseImageDataUrl(value: string | null | undefined): { contentType: string; body: Buffer } | null {
  if (!value || !value.startsWith("data:")) return null;
  const match = DATA_URL.exec(value);
  if (!match) return null;
  const type = match[1].toLowerCase();
  if (!SERVED_TYPES.has(type)) return null;
  const body = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (body.length === 0) return null;
  return { contentType: type === "image/jpg" ? "image/jpeg" : type, body };
}

/** A short, stable version of the stored value: changes with every upload. */
export function imageVersion(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

const isWebUrl = (u: string) => /^https?:\/\//i.test(u);

/**
 * What the page and the widget get for a stored logo or cover: the stored
 * http(s) URL, or the API path that serves a data: URL
 * ("/public-site/image/<tenant>/<kind>?v=<version>", relative to the API
 * base), or null when there is nothing we can show.
 */
export function publicImageUrl(tenantId: string, kind: PublicImageKind, value: string | null | undefined): string | null {
  const stored = value?.trim();
  if (!stored) return null;
  if (isWebUrl(stored)) return stored;
  if (!parseImageDataUrl(stored)) return null;
  return `/public-site/image/${encodeURIComponent(tenantId)}/${kind}?v=${imageVersion(stored)}`;
}
