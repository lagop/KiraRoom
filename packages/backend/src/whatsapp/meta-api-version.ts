/**
 * The Graph API version of every call KiraRoom makes to Meta (WhatsApp,
 * Messenger, Instagram, and the Copilot's WhatsApp tools).
 *
 * Meta retires each version about two years after the next ones ship; a call
 * to a retired version is still answered, but by newer behaviour nobody
 * tested. v20.0, the old default, expired on 24 September 2026. v25.0 was
 * released on 18 February 2026 and is available until 29 July 2028
 * (developers.facebook.com/docs/graph-api/changelog/versions).
 *
 * META_API_VERSION in the server's environment overrides it, so moving to a
 * newer version needs no code change; anything that is not a version such as
 * "v25.0" is ignored.
 */
export const DEFAULT_META_API_VERSION = "v25.0";

const VERSION_RE = /^v\d{2,3}\.0$/;

export function metaApiVersion(configured?: string | null): string {
  const v = configured?.trim();
  return v && VERSION_RE.test(v) ? v : DEFAULT_META_API_VERSION;
}

export function metaGraphBaseUrl(configured?: string | null): string {
  return `https://graph.facebook.com/${metaApiVersion(configured)}`;
}
