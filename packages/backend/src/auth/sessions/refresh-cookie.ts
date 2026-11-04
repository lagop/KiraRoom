import type { Request, Response } from "express";

/**
 * The refresh token travels in an httpOnly cookie, out of reach of the
 * page's JavaScript: before, it sat in localStorage, where any script that
 * ran on the page (an XSS, a compromised dependency) could read it and keep
 * the account for 7 days.
 *
 * Two names, because one browser can hold both sessions: the panel at
 * app.kiraroom.net and a client account on a salon's site. Both talk to the
 * same API host, so one cookie name would let either sign-in replace the
 * other.
 *
 * SameSite=Lax: the panel and the salons' subdomains are the same site as
 * api.kiraroom.net, so the cookie goes with their requests, and a cross-site
 * POST does not carry it. Path limits it to the auth routes. A salon on its
 * own domain is cross-site: its clients' sessions will need the API behind
 * that domain before custom domains are switched on.
 */
export const STAFF_REFRESH_COOKIE = "kr_session";
export const CLIENT_REFRESH_COOKIE = "kr_client_session";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * A support session (the platform owner inside a salon, audit 8 C10) has its
 * own cookie per salon, kr_support_<tenantId>. It used to take kr_session, so
 * entering a salon replaced the console's session in that browser and leaving
 * meant signing in again. Per salon, so two salons open in two tabs do not
 * swap sessions on their next refresh.
 */
export const SUPPORT_REFRESH_COOKIE_PREFIX = "kr_support_";

export type CookieKind = "staff" | "client" | `support:${string}`;

export function cookieKindForRole(role: string): CookieKind {
  return role === "client" ? "client" : "staff";
}

/** The cookie of the support session in this salon. */
export function supportCookieKind(tenantId: string): CookieKind {
  return `support:${tenantId}`;
}

function cookieName(kind: CookieKind): string {
  if (kind.startsWith("support:")) {
    // Cookie names allow letters, digits and dashes: a uuid is fine; anything
    // else is dropped rather than trusted.
    return SUPPORT_REFRESH_COOKIE_PREFIX + kind.slice("support:".length).replace(/[^A-Za-z0-9-]/g, "");
  }
  return kind === "client" ? CLIENT_REFRESH_COOKIE : STAFF_REFRESH_COOKIE;
}

function baseOptions() {
  return {
    httpOnly: true,
    // Local development runs on http://localhost, where a Secure cookie is dropped.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, kind: CookieKind, token: string, maxAgeSeconds: number): void {
  res.cookie(cookieName(kind), token, { ...baseOptions(), maxAge: maxAgeSeconds * 1000 });
}

export function clearRefreshCookie(res: Response, kind: CookieKind): void {
  res.clearCookie(cookieName(kind), baseOptions());
}

/** The cookie's value, without a cookie-parsing middleware. */
export function readRefreshCookie(req: Pick<Request, "headers">, kind: CookieKind): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  const name = cookieName(kind);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Moves the refresh token from the response body into its httpOnly cookie. */
export function deliverTokens<T extends { refreshToken?: string; refreshExpiresIn?: number }>(
  res: Response,
  kind: CookieKind,
  tokens: T,
): Omit<T, "refreshToken" | "refreshExpiresIn"> {
  if (tokens.refreshToken && tokens.refreshExpiresIn) {
    setRefreshCookie(res, kind, tokens.refreshToken, tokens.refreshExpiresIn);
  }
  const { refreshToken: _token, refreshExpiresIn: _ttl, ...rest } = tokens;
  return rest;
}
