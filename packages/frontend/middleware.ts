import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  bareHost,
  isPlatformHost,
  platformHostsFrom,
  rewritePathFor,
  salonSlugForSubdomain,
  subdomainRedirectFor,
} from "./lib/custom-domain-host";
import { retiredClientAreaRedirect } from "./lib/client-area-redirect";
import { embedToken, frameAncestorsHeader } from "./lib/embed-frame";

// All authentication for `/saas/*` is enforced server-side by the NestJS
// `SaasOwnerGuard` on the corresponding API endpoints. This middleware is
// intentionally permissive for SaaS routes because we cannot read JWT or
// localStorage here; the UX-level redirect happens in `app/saas/layout.tsx`'s
// `useEffect` after first paint. The backend guard remains the source of truth.
// `/register` was listed here and in the matcher below for a long time. That
// route does not exist -- it answers 404. The sign-up page is `/signup`, and
// it was not listed at all.
//
// The middleware now also serves salons' own domains and their free
// subdomains (see lib/custom-domain-host.ts), which is why the matcher covers
// every page.

const PLATFORM_HOSTS = platformHostsFrom(
  process.env.NEXT_PUBLIC_PLATFORM_HOSTS,
  process.env.NEXT_PUBLIC_APP_URL,
);

/** Salons' free subdomains: <slug>.<base>; read at runtime (compose env). */
const SUBDOMAIN_BASE = process.env.SALON_SUBDOMAIN_BASE;
const SUBDOMAINS_READY = ["1", "true"].includes((process.env.SALON_SUBDOMAINS_READY ?? "").trim().toLowerCase());

const API_URL = (
  process.env.INTERNAL_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:3001/api/v1"
).replace(/\/+$/, "");

/**
 * Host -> salon slug (or null for "no salon"), per server process. Every
 * request on a salon's domain goes through here, so the API is asked at
 * most once per host every few minutes. Unknown hosts are remembered for
 * less time, so a domain verified a minute ago starts working soon; the map
 * is capped so a flood of made-up Host headers cannot grow it without bound.
 */
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;
const hostCache = new Map<string, { slug: string | null; expires: number }>();

async function slugForHost(host: string): Promise<string | null> {
  const now = Date.now();
  const cached = hostCache.get(host);
  if (cached && cached.expires > now) return cached.slug;

  let slug: string | null = null;
  let ttl = MISS_TTL_MS;
  try {
    const res = await fetch(`${API_URL}/public-site/domain/${encodeURIComponent(host)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { slug?: unknown };
      if (typeof body.slug === "string" && body.slug) {
        slug = body.slug;
        ttl = HIT_TTL_MS;
      }
    } else if (res.status !== 404) {
      // API trouble is not an answer: do not remember it.
      return cached?.slug ?? null;
    }
  } catch {
    return cached?.slug ?? null;
  }

  if (hostCache.size >= MAX_ENTRIES) hostCache.clear();
  hostCache.set(host, { slug, expires: now + ttl });
  return slug;
}

/**
 * The booking widget page's frame-ancestors header, per widget token,
 * from its allowed origins (lib/embed-frame.ts). Cached a minute, so a
 * change in the panel shows soon; API trouble is not cached and sends no
 * header (the page then frames anywhere, as with an empty list).
 */
const EMBED_TTL_MS = 60_000;
const embedCache = new Map<string, { header: string | null; expires: number }>();

async function embedFrameHeader(token: string): Promise<string | null> {
  const now = Date.now();
  const cached = embedCache.get(token);
  if (cached && cached.expires > now) return cached.header;
  try {
    const res = await fetch(`${API_URL}/embed/${encodeURIComponent(token)}/frame-ancestors`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return cached?.header ?? null;
    const header = frameAncestorsHeader(await res.json());
    if (embedCache.size >= MAX_ENTRIES) embedCache.clear();
    embedCache.set(token, { header, expires: now + EMBED_TTL_MS });
    return header;
  } catch {
    return cached?.header ?? null;
  }
}

/**
 * The clients' old sign-in area (lib/client-area-redirect.ts) sends them to
 * the booking page; null when the path is not part of it.
 */
function clientAreaRedirect(request: NextRequest, onSalonHost: boolean): NextResponse | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const target = retiredClientAreaRedirect(request.nextUrl.pathname, request.nextUrl.search, onSalonHost);
  if (!target) return null;
  const url = request.nextUrl.clone();
  url.pathname = target.pathname;
  url.search = target.search;
  // 307, not permanent: client accounts could come back one day.
  return NextResponse.redirect(url, 307);
}

export async function middleware(request: NextRequest) {
  const host = bareHost(request.headers.get("host"));

  // /embed/<token>: the salon's booking widget, framed on its own site.
  // Only the sites it allowed may frame it.
  const widgetToken = embedToken(request.nextUrl.pathname);
  if (widgetToken) {
    const response = NextResponse.next();
    const header = await embedFrameHeader(widgetToken);
    if (header) response.headers.set("Content-Security-Policy", header);
    return response;
  }

  // salon-lucia.kiraroom.net: the host names the salon.
  const subdomainSlug = salonSlugForSubdomain(host, SUBDOMAIN_BASE);
  if (subdomainSlug) {
    const retired = clientAreaRedirect(request, true);
    if (retired) return retired;
    const target = rewritePathFor(request.nextUrl.pathname, encodeURIComponent(subdomainSlug));
    if (!target) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = target;
    return NextResponse.rewrite(url);
  }

  if (isPlatformHost(host, PLATFORM_HOSTS)) {
    const retired = clientAreaRedirect(request, false);
    if (retired) return retired;
  }

  // app.kiraroom.net/sites/salon-lucia -> the salon's subdomain, once live.
  if (request.method === "GET" || request.method === "HEAD") {
    const moved = subdomainRedirectFor(host, request.nextUrl.pathname, PLATFORM_HOSTS, SUBDOMAIN_BASE, SUBDOMAINS_READY);
    if (moved) {
      const url = new URL(moved);
      url.search = request.nextUrl.search;
      return NextResponse.redirect(url, 308);
    }
  }

  if (!isPlatformHost(host, PLATFORM_HOSTS)) {
    const slug = await slugForHost(host);
    if (slug) {
      const retired = clientAreaRedirect(request, true);
      if (retired) return retired;
      const target = rewritePathFor(request.nextUrl.pathname, encodeURIComponent(slug));
      if (target) {
        const url = request.nextUrl.clone();
        url.pathname = target;
        return NextResponse.rewrite(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Every page; not Next's own assets nor files (anything with an
  // extension: favicon.ico, robots.txt, sitemap.xml, images in public/),
  // which are the same on every host.
  matcher: ["/((?!_next/|.*\\.).*)"],
};
